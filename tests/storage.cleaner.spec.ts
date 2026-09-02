import { describe, expect, it } from 'vitest';
import * as path from 'path';
import { hash32, type ArchiveInfo } from '../src/credits';
import { SAVES_BUCKET_KEY } from '../src/storage/classify';
import { computeOrphans, MANIFEST_FILENAME } from '../src/storage/orphan';
import {
  removeManifestEntry,
  SessionCleaner,
  type CleanerDeps,
  type CleanerRoots,
  type CleanupMode,
  type CleanupResult,
  type ConfirmPrompt,
  type SessionLineage,
} from '../src/storage/cleaner';
import { recordingCleanerFs, type FaultSpec, type MemTree } from './_helpers';

/**
 * 清理侧的**示例测试**（任务 12.11）。属性测试在 `tests/storage.cleaner.property.spec.ts`
 * 里覆盖输入空间（Property 14(b)、27–31）；本文件只写具体、确定的例子——交互形态、
 * 固定文案、逐字节保真与几条分支选择，这些用具体原文比随机生成更能表达意图
 * （见 design「用属性测试覆盖什么、不覆盖什么」）。
 *
 * 覆盖（design 的测试文件划分表逐条对应）：
 *
 * | 用例 | 需求 |
 * | --- | --- |
 * | 模态确认提示携带的事实、「取消」为默认按钮的可观测语义 | 14.5 |
 * | ReferencedArchive 二次确认（合计含引用冲突文件、取消即零删除） | 14.6 |
 * | 引用冲突两分支：默认排除 / 用户显式包含 | 11.12、14.4 |
 * | 清单读改写逐字节保真（4 空格缩进 + CRLF） | 11.13、14.11 |
 * | 清单解析失败 / 顶层非数组 / writeFile 失败三条降级 | 14.12 |
 * | 同 sessionId 清理互斥 | 14.18 |
 * | 审计两次写入的时序与文案 | 14.16、14.17 |
 * | FullCleanup 后残留存档在下一次统计中变孤儿 | 3.8 |
 * | 整体失败时通知文案「会话清理失败：…」 | 9.9 |
 *
 * 全程注入假依赖（`recordingCleanerFs` 的内存树 + spy 版 `confirm` / `audit` /
 * `invalidate`），**不碰真实磁盘**：本文件里没有任何临时目录夹具，删除全部发生在内存树上。
 *
 * 路径夹具在本文件内独立构造，而不是从 `storage.cleaner.property.spec.ts` 导入——
 * 导入一个 spec 文件会连带执行它的 `describe`，把整套属性测试重复注册进本文件。
 * 构造公式与那侧完全一致（`hash32(SAVES_BUCKET_KEY)` 作桶名、`hash32(工作区 fsPath)`
 * 作 workspaceId），因此两侧对「什么算合法存档位置」的口径仍然同源。
 */

/* ------------------------------------------------------------------ *
 * 路径夹具（纯字符串计算，不落盘）
 * ------------------------------------------------------------------ */

/** 用 `path.resolve(path.sep + …)` 取当前盘/根下的绝对路径，两个平台都不掺 cwd 前缀。 */
const FIXTURE_BASE = path.resolve(path.sep + 'kcs-cleaner-example');
const WORKSPACE_PATH = 'D:\\Projects\\Demo';

const STORE_ROOT = path.join(FIXTURE_BASE, 'User', 'globalStorage', 'kiro.kiroagent');
const SESSIONS_ROOT = path.join(STORE_ROOT, 'workspace-sessions');
const SAVES_BUCKET = hash32(SAVES_BUCKET_KEY);
const WORKSPACE_ID = hash32(WORKSPACE_PATH);
/** EncodedKey 的具体形态与删除校验无关，取一个固定的 base64url 串即可。 */
const SESSION_DIR = path.join(SESSIONS_ROOT, 'RDpcUHJvamVjdHNcRGVtbw__');
const SAVES_DIR = path.join(STORE_ROOT, WORKSPACE_ID, SAVES_BUCKET);
const MANIFEST_PATH = path.join(SESSION_DIR, MANIFEST_FILENAME);

const ROOTS: CleanerRoots = {
  storeRoot: STORE_ROOT,
  savesBucket: SAVES_BUCKET,
  workspaceId: WORKSPACE_ID,
  sessionDir: SESSION_DIR,
};

/** 当前工作区 ExecutionSavesBucket 下的存档路径。 */
function archivePath(name: string): string {
  return path.join(SAVES_DIR, name);
}

/** 当前工作区 WorkspaceSessionDir 下的 SessionFile 路径。 */
function sessionFilePath(sessionId: string): string {
  return path.join(SESSION_DIR, `${sessionId}.json`);
}

const TARGET = 's1';
const OTHER = 's2';
const TITLE = '会话一';

/* ------------------------------------------------------------------ *
 * 存档夹具：名字恒为 hash32(executionId)，即小写 hex32（assertDeletable 的放行形态）
 * ------------------------------------------------------------------ */

function archive(executionId: string, size: number, chatSessionId: string | null): ArchiveInfo {
  const name = hash32(executionId);
  return { path: archivePath(name), name, size, chatSessionId };
}

/** 目标会话名下的两条普通存档。 */
const ARCHIVE_A = archive('exec-a', 1024, TARGET);
const ARCHIVE_B = archive('exec-b', 2048, TARGET);
/** 目标会话名下、被 `s2` 的 history 引用到的那条（`hash32('exec-ref')` 即其文件名）。 */
const ARCHIVE_REF = archive('exec-ref', 4096, TARGET);
/** 另一个会话名下的存档：恒不进目标会话的任何计划。 */
const ARCHIVE_OTHER = archive('exec-other', 8192, OTHER);

/**
 * 让 `s2` 的 credit lineage 引用到目标会话的存档：`historyExecutionIds` 里的
 * `exec-ref` 经 `hash32` 反查到 `ARCHIVE_REF`（其 `chatSessionId === 's1'`），
 * 于是「目标会话被其它现存会话引用」成立——按定义，目标名下的**全部**存档整批
 * 落入 `plan.referenced`（删掉其中任何一条都会让 `s2` 的历史 credit 用量无法回溯）。
 */
const LINEAGE_REFERENCING_TARGET: readonly SessionLineage[] = [
  { sessionId: OTHER, historyExecutionIds: ['exec-ref'] },
];

/* ------------------------------------------------------------------ *
 * 清单原文：4 空格缩进 + CRLF 行尾 + 以行尾结束
 *
 * 字段顺序刻意不按字母序（`title` 在 `sessionId` 之前），数组里刻意混入一条非对象
 * 条目——两者都用来验证「其余条目原样保留、不动不增」。
 * ------------------------------------------------------------------ */

const MANIFEST_RAW =
  '[\r\n' +
  '    {\r\n' +
  '        "sessionId": "s1",\r\n' +
  '        "title": "会话一",\r\n' +
  '        "updatedAt": 111\r\n' +
  '    },\r\n' +
  '    {\r\n' +
  '        "title": "会话二",\r\n' +
  '        "sessionId": "s2",\r\n' +
  '        "updatedAt": 222\r\n' +
  '    },\r\n' +
  '    "junk-entry"\r\n' +
  ']\r\n';

/** 移除 `s1` 条目后的期望全文：缩进 / 行尾 / 字段顺序 / 尾行一律与原文同风格。 */
const MANIFEST_AFTER_REMOVE_S1 =
  '[\r\n' +
  '    {\r\n' +
  '        "title": "会话二",\r\n' +
  '        "sessionId": "s2",\r\n' +
  '        "updatedAt": 222\r\n' +
  '    },\r\n' +
  '    "junk-entry"\r\n' +
  ']\r\n';

/* ------------------------------------------------------------------ *
 * 测试夹具装配
 * ------------------------------------------------------------------ */

type Decision = 'confirm' | 'confirmWithReferenced' | 'cancel';

interface Harness {
  rec: ReturnType<typeof recordingCleanerFs>;
  cleaner: SessionCleaner;
  /** 每次 `confirm` 收到的提示输入（顺序即弹出顺序） */
  prompts: ConfirmPrompt[];
  /** 每次审计写入的行 + 该时刻已发生的 `unlink` 次数（用于断言时序） */
  audits: Array<{ lines: string[]; unlinkCalls: number }>;
  /** 每次 `invalidate` 收到的被删路径 */
  invalidated: string[][];
  /** 交叉时序流水：`audit#1` / `confirm:primary` / `unlink` … */
  events: string[];
  /** 内存树里某个文件的当前内容 */
  content(p: string): Promise<string>;
  unlinked(): string[];
}

interface HarnessConfig {
  tree: MemTree;
  faults?: FaultSpec;
  archives?: readonly ArchiveInfo[];
  /** 抛异常的 ArchiveIndex（测段 1 生成失败上抛） */
  archivesThrow?: Error;
  lineages?: readonly SessionLineage[];
  /** 逐次确认的决定；用完后一律 `cancel`（缺省首次即 `confirm`） */
  decisions?: Decision[];
  /** 每次确认时的额外动作（用于在 in-flight 期间再次 `run`） */
  onConfirm?: (prompt: ConfirmPrompt, h: Harness) => Promise<void> | void;
  /** 审计写入抛异常（测段 2 写失败被吞掉并在段 10 注明） */
  auditThrow?: boolean;
}

function harness(cfg: HarnessConfig): Harness {
  const rec = recordingCleanerFs(cfg.tree, cfg.faults);
  const prompts: ConfirmPrompt[] = [];
  const audits: Harness['audits'] = [];
  const invalidated: string[][] = [];
  const events: string[] = [];
  const decisions = [...(cfg.decisions ?? ['confirm'])];

  const unlinkCount = (): number => rec.calls.filter((c) => c.op === 'unlink').length;

  const h: Harness = {
    rec,
    // 占位，构造 deps 时需要先有 h 的引用（onConfirm 拿得到 harness 自身）
    cleaner: undefined as unknown as SessionCleaner,
    prompts,
    audits,
    invalidated,
    events,
    async content(p: string) {
      return rec.deps.readFile(p, 'utf8');
    },
    unlinked() {
      return rec.calls.filter((c) => c.op === 'unlink').map((c) => String(c.args[0]));
    },
  };

  const deps: CleanerDeps = {
    fs: rec.deps,
    audit: (lines) => {
      if (cfg.auditThrow) {
        events.push('audit:throw');
        throw new Error('OutputChannel 已释放');
      }
      audits.push({ lines: [...lines], unlinkCalls: unlinkCount() });
      events.push(`audit#${audits.length}`);
    },
    confirm: async (p) => {
      prompts.push(p);
      events.push(`confirm:${p.stage}`);
      await cfg.onConfirm?.(p, h);
      return decisions.shift() ?? 'cancel';
    },
    archives: () => {
      if (cfg.archivesThrow) throw cfg.archivesThrow;
      return cfg.archives ?? [];
    },
    invalidate: (paths) => {
      invalidated.push([...paths]);
      events.push('invalidate');
    },
    roots: ROOTS,
    lineages: () => cfg.lineages ?? [],
  };

  h.cleaner = new SessionCleaner(deps);
  return h;
}

/** 目标会话与另一个会话的 SessionFile + 清单，外加给定存档。 */
function treeWith(archives: readonly ArchiveInfo[], manifest = MANIFEST_RAW): MemTree {
  const tree: MemTree = {
    [MANIFEST_PATH]: manifest,
    [sessionFilePath(TARGET)]: { size: 512 },
    [sessionFilePath(OTHER)]: { size: 256 },
  };
  for (const a of archives) tree[a.path] = { size: a.size };
  return tree;
}

/** 内存树里 WorkspaceSessionDir 下现存的 SessionFile 与清单条目的 sessionId 并集。 */
async function liveSessionIds(h: Harness): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const p of Object.keys(h.rec.snapshot())) {
    if (path.dirname(p) !== path.resolve(SESSION_DIR)) continue;
    const base = path.basename(p);
    if (base === MANIFEST_FILENAME || !base.endsWith('.json')) continue;
    ids.add(path.basename(base, '.json'));
  }
  if (h.rec.exists(MANIFEST_PATH)) {
    const entries = JSON.parse(await h.content(MANIFEST_PATH)) as unknown[];
    for (const e of entries) {
      const id = (e as { sessionId?: unknown } | null)?.sessionId;
      if (typeof id === 'string' && id.length > 0) ids.add(id);
    }
  }
  return ids;
}

/* ------------------------------------------------------------------ *
 * 1. 模态确认提示（Req 14.5）
 * ------------------------------------------------------------------ */

describe('模态确认提示的内容与默认按钮（Req 14.5）', () => {
  it('首次确认拿到模式名称、释放字节数、文件数与引用冲突的文件数/字节数', async () => {
    const archives = [ARCHIVE_A, ARCHIVE_B, ARCHIVE_OTHER];
    const h = harness({ tree: treeWith(archives), archives, decisions: ['confirm'] });

    await h.cleaner.run('attachment', TARGET, TITLE);

    // 宿主侧据这些事实组装模态文案（模式名称 + 释放字节数 + 文件数 + 保留的引用冲突
    // 文件数/字节数 + 「不可撤销、不进回收站」的明文说明）。逐字段全等断言：
    // 少一个事实，文案就少一句该说的话。
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]).toEqual({
      stage: 'primary',
      mode: 'attachment',
      sessionId: TARGET,
      title: TITLE,
      // 任务 14.4：确认提示新增会话格式与待移除目录数（Req 10.13）。
      // 本夹具是 0.9x 单文件会话，故恒为 'old' / 0。
      layout: 'old',
      dirCount: 0,
      totalFiles: 2,
      totalBytes: 1024 + 2048,
      referencedFiles: 0,
      referencedBytes: 0,
    });
    // 另一个会话名下的存档既不在待删也不在引用冲突里
    expect(h.unlinked().sort()).toEqual([ARCHIVE_A.path, ARCHIVE_B.path].sort());
    expect(h.rec.exists(ARCHIVE_OTHER.path)).toBe(true);
  });

  it('full 模式的提示带 full 模式名并把 SessionFile 计入合计', async () => {
    const archives = [ARCHIVE_A];
    const h = harness({ tree: treeWith(archives), archives, decisions: ['confirm'] });

    await h.cleaner.run('full', TARGET, TITLE);

    expect(h.prompts[0].mode).toBe('full');
    // 存档 1024 + SessionFile 512；清单条目移除是附加操作，清单自身恒不计入待删
    expect(h.prompts[0]).toMatchObject({ totalFiles: 2, totalBytes: 1024 + 512 });
    expect(h.unlinked()).not.toContain(MANIFEST_PATH);
  });

  it('「取消」为默认按钮：未显式确认时零删除、清单与文件原样', async () => {
    // 「取消是默认按钮」的可观测含义就是这一条：用户没有主动选确认（直接回车 / 关掉
    // 提示，两者都落到 'cancel'）时，一个文件都不能少。按钮顺序本身由宿主侧的
    // showWarningMessage 参数形态决定，随 vscode 装配一起验证。
    const archives = [ARCHIVE_A, ARCHIVE_B];
    const h = harness({ tree: treeWith(archives), archives, decisions: ['cancel'] });
    const before = h.rec.snapshot();

    const result = await h.cleaner.run('full', TARGET, TITLE);

    expect(result.state).toBe('cancelled');
    expect(result.deletedFiles).toBe(0);
    expect(result.deletedBytes).toBe(0);
    expect(result.manifestUpdated).toBe('skipped');
    expect(result.includedReferenced).toBe(false);
    expect(h.rec.snapshot()).toEqual(before);
    expect(h.unlinked()).toEqual([]);
    await expect(h.content(MANIFEST_PATH)).resolves.toBe(MANIFEST_RAW);
  });
});

/* ------------------------------------------------------------------ *
 * 2. 引用冲突的两条分支与二次确认（Req 11.12、14.4、14.6）
 * ------------------------------------------------------------------ */

describe('ReferencedArchive 的两条分支与二次确认（Req 11.12、14.6）', () => {
  const archives = [ARCHIVE_A, ARCHIVE_REF, ARCHIVE_OTHER];

  function referencedHarness(decisions: Decision[]): Harness {
    return harness({
      tree: treeWith(archives),
      archives,
      lineages: LINEAGE_REFERENCING_TARGET,
      decisions,
    });
  }

  it('默认排除：引用冲突存档计入 referenced、不被删除，只删 SessionFile', async () => {
    const h = referencedHarness(['confirm']);

    const plan = await h.cleaner.plan('full', TARGET, TITLE);
    // 引用一旦成立即整批保留：目标名下两条存档都落进 referenced，files 只剩 SessionFile
    expect(plan.referenced.map((r) => r.path).sort()).toEqual(
      [ARCHIVE_A.path, ARCHIVE_REF.path].sort()
    );
    expect(plan.referencedFiles).toBe(2);
    expect(plan.referencedBytes).toBe(1024 + 4096);
    expect(plan.files.map((f) => f.path)).toEqual([sessionFilePath(TARGET)]);
    // 两个集合恒不相交
    const fileKeys = new Set(plan.files.map((f) => f.path));
    expect(plan.referenced.some((r) => fileKeys.has(r.path))).toBe(false);

    const result = await h.cleaner.run('full', TARGET, TITLE);

    expect(result.state).toBe('done');
    expect(result.includedReferenced).toBe(false);
    expect(result.deletedFiles).toBe(1);
    expect(result.deletedBytes).toBe(512);
    expect(h.unlinked()).toEqual([sessionFilePath(TARGET)]);
    expect(h.rec.exists(ARCHIVE_A.path)).toBe(true);
    expect(h.rec.exists(ARCHIVE_REF.path)).toBe(true);
    // 只弹一次确认：没有勾选包含，就没有二次确认
    expect(h.prompts.map((p) => p.stage)).toEqual(['primary']);
    expect(h.prompts[0]).toMatchObject({
      totalFiles: 1,
      totalBytes: 512,
      referencedFiles: 2,
      referencedBytes: 1024 + 4096,
    });
    // 计划审计明确写出被保留的原因
    const planAudit = h.audits[0].lines.join('\n');
    expect(planAudit).toContain('引用冲突（默认保留）：2 个 / 5120 字节');
    expect(planAudit).toContain(`- 保留 ${ARCHIVE_REF.path}（4096 字节，被其它会话引用）`);
  });

  it('显式选择包含：按并入后的合计做二次确认，引用冲突存档纳入删除', async () => {
    const h = referencedHarness(['confirmWithReferenced', 'confirm']);

    const result = await h.cleaner.run('full', TARGET, TITLE);

    expect(h.prompts.map((p) => p.stage)).toEqual(['primary', 'referenced']);
    // 二次确认的合计已并入 referenced（1 + 2 个文件、512 + 5120 字节），并仍带着
    // 引用冲突的文件数/字节数——宿主据此说明"其它会话的历史 credit 用量将无法回溯"
    expect(h.prompts[1]).toEqual({
      stage: 'referenced',
      mode: 'full',
      sessionId: TARGET,
      title: TITLE,
      layout: 'old',
      dirCount: 0,
      totalFiles: 3,
      totalBytes: 512 + 1024 + 4096,
      referencedFiles: 2,
      referencedBytes: 1024 + 4096,
    });
    expect(result.state).toBe('done');
    expect(result.includedReferenced).toBe(true);
    expect(result.deletedFiles).toBe(3);
    expect(result.deletedBytes).toBe(512 + 1024 + 4096);
    expect(h.rec.exists(ARCHIVE_A.path)).toBe(false);
    expect(h.rec.exists(ARCHIVE_REF.path)).toBe(false);
    // 别人家的存档一条没碰
    expect(h.rec.exists(ARCHIVE_OTHER.path)).toBe(true);
  });

  it('在二次确认处取消：连首次确认已同意的文件也一个不删', async () => {
    const h = referencedHarness(['confirmWithReferenced', 'cancel']);
    const before = h.rec.snapshot();

    const result = await h.cleaner.run('full', TARGET, TITLE);

    expect(h.prompts.map((p) => p.stage)).toEqual(['primary', 'referenced']);
    expect(result.state).toBe('cancelled');
    expect(result.includedReferenced).toBe(false);
    expect(h.unlinked()).toEqual([]);
    expect(h.rec.snapshot()).toEqual(before);
  });
});

/* ------------------------------------------------------------------ *
 * 3. 清单读改写的逐字节保真（Req 11.13、14.11）
 * ------------------------------------------------------------------ */

describe('removeManifestEntry 的原文风格保真（Req 11.13、14.11）', () => {
  it('4 空格缩进 + CRLF 的清单：目标条目被移除，其余条目/字段/顺序/缩进/行尾逐字节原样', () => {
    const out = removeManifestEntry(MANIFEST_RAW, TARGET);

    expect('error' in out).toBe(false);
    if ('error' in out) return; // 类型收窄
    expect(out.removed).toBe(1);
    // 逐字节比对：缩进（4 空格 / 嵌套 8 空格）、行尾（CRLF）、字段顺序
    // （`title` 仍在 `sessionId` 之前）、非对象条目 `"junk-entry"`、尾行都不动
    expect(out.text).toBe(MANIFEST_AFTER_REMOVE_S1);
    expect(out.text.includes('\r\n')).toBe(true);
    expect(out.text.includes('"sessionId": "s1"')).toBe(false);
    // 没有引入 LF 单独出现的行尾（每个 \n 前恒有 \r）
    expect(out.text.split('\n').length - 1).toBe(out.text.split('\r\n').length - 1);
  });

  it('目标不在清单里：removed 为 0 且返回原文逐字节不变（段 7 据此跳过写盘）', () => {
    const out = removeManifestEntry(MANIFEST_RAW, 'not-there');

    expect(out).toEqual({ text: MANIFEST_RAW, removed: 0 });
  });

  it('同一 sessionId 出现多次时全部移除，removed 即实际条数', () => {
    const raw = '[\r\n    {\r\n        "sessionId": "s1"\r\n    },\r\n' +
      '    {\r\n        "sessionId": "s1"\r\n    },\r\n' +
      '    {\r\n        "sessionId": "s2"\r\n    }\r\n]\r\n';

    const out = removeManifestEntry(raw, TARGET);

    expect(out).toEqual({
      text: '[\r\n    {\r\n        "sessionId": "s2"\r\n    }\r\n]\r\n',
      removed: 2,
    });
  });

  it('解析失败与顶层非数组只返回 error，没有 text 可写回', () => {
    const broken = removeManifestEntry('[{"sessionId": "s1"', TARGET);
    expect('error' in broken).toBe(true);
    expect('text' in broken).toBe(false);

    const notArray = removeManifestEntry('{"sessions": [{"sessionId": "s1"}]}', TARGET);
    expect(notArray).toEqual({ error: 'SessionManifest 顶层结构不是数组' });
  });
});

/* ------------------------------------------------------------------ *
 * 4. 清单更新的三条降级路径（Req 14.12）
 * ------------------------------------------------------------------ */

describe('清单更新失败的三条降级路径（Req 14.12）', () => {
  /** 三条路径的共同断言：不抛异常、已完成的删除结果保留、清单文件内容原样。 */
  async function expectDegraded(h: Harness, rawBefore: string): Promise<CleanupResult> {
    const result = await h.cleaner.run('full', TARGET, TITLE);

    expect(result.state).toBe('done');
    expect(result.manifestUpdated).toBe('failed');
    // 删除已完成的部分照常计入，不因清单失败而回滚（删除不可逆，回滚是假承诺）
    expect(result.deletedFiles).toBe(2);
    expect(result.deletedBytes).toBe(1024 + 512);
    expect(result.failed).toEqual([]);
    expect(h.rec.exists(ARCHIVE_A.path)).toBe(false);
    expect(h.rec.exists(sessionFilePath(TARGET))).toBe(false);
    // 清单文件本身仍在，且内容一字未改
    await expect(h.content(MANIFEST_PATH)).resolves.toBe(rawBefore);
    // 明细审计如实记录清单结果
    expect(h.audits[1].lines[1]).toContain('清单=failed');
    return result;
  }

  it('清单 JSON 解析失败 → manifestUpdated: failed', async () => {
    const raw = '[{"sessionId": "s1"';
    const h = harness({
      tree: treeWith([ARCHIVE_A], raw),
      archives: [ARCHIVE_A],
      decisions: ['confirm'],
    });

    await expectDegraded(h, raw);
    // 解析失败时压根不该尝试写盘
    expect(h.rec.calls.some((c) => c.op === 'writeFile')).toBe(false);
  });

  it('清单顶层不是数组 → manifestUpdated: failed', async () => {
    const raw = '{\r\n    "sessions": [\r\n        {\r\n            "sessionId": "s1"\r\n        }\r\n    ]\r\n}\r\n';
    const h = harness({
      tree: treeWith([ARCHIVE_A], raw),
      archives: [ARCHIVE_A],
      decisions: ['confirm'],
    });

    await expectDegraded(h, raw);
    expect(h.rec.calls.some((c) => c.op === 'writeFile')).toBe(false);
  });

  it('writeFile 失败 → manifestUpdated: failed，且清单内容未被截断', async () => {
    const h = harness({
      tree: treeWith([ARCHIVE_A]),
      archives: [ARCHIVE_A],
      decisions: ['confirm'],
      faults: { fatal: { [MANIFEST_PATH]: { code: 'EACCES', op: 'writeFile' } } },
    });

    await expectDegraded(h, MANIFEST_RAW);
    // 确实尝试过写、且写的只有清单这一个路径
    const writes = h.rec.calls.filter((c) => c.op === 'writeFile');
    expect(writes).toHaveLength(1);
    expect(path.resolve(String(writes[0].args[0]))).toBe(path.resolve(MANIFEST_PATH));
  });

  it('对照：清单正常时写回一次并落 ok', async () => {
    const h = harness({
      tree: treeWith([ARCHIVE_A]),
      archives: [ARCHIVE_A],
      decisions: ['confirm'],
    });

    const result = await h.cleaner.run('full', TARGET, TITLE);

    expect(result.manifestUpdated).toBe('ok');
    await expect(h.content(MANIFEST_PATH)).resolves.toBe(MANIFEST_AFTER_REMOVE_S1);
  });

  it('attachment 模式不碰清单：manifestUpdated 恒为 skipped', async () => {
    const h = harness({
      tree: treeWith([ARCHIVE_A]),
      archives: [ARCHIVE_A],
      decisions: ['confirm'],
    });

    const result = await h.cleaner.run('attachment', TARGET, TITLE);

    expect(result.manifestUpdated).toBe('skipped');
    expect(h.rec.calls.some((c) => c.op === 'writeFile')).toBe(false);
    await expect(h.content(MANIFEST_PATH)).resolves.toBe(MANIFEST_RAW);
  });
});

/* ------------------------------------------------------------------ *
 * 5. 同 sessionId 的清理互斥（Req 14.18）
 * ------------------------------------------------------------------ */

describe('同 sessionId 的清理互斥（Req 14.18）', () => {
  it('第二次并发 run 返回 rejected，不写审计也不删任何文件', async () => {
    let nested: CleanupResult | undefined;
    let nestedOther: CleanupResult | undefined;
    let triggered = false;

    const h = harness({
      tree: treeWith([ARCHIVE_A]),
      archives: [ARCHIVE_A],
      decisions: ['confirm'],
      // 首次确认还没返回时，第一次 run 仍持有 s1 的互斥占位
      onConfirm: async (_p, self) => {
        if (triggered) return;
        triggered = true;
        nested = await self.cleaner.run('attachment', TARGET, '并发调用');
        // 互斥是按 sessionId 的：另一个会话不受影响（这里没有它的存档 → 空计划 noop）
        nestedOther = await self.cleaner.run('attachment', OTHER, '另一个会话');
      },
    });

    const first = await h.cleaner.run('attachment', TARGET, TITLE);

    expect(nested?.state).toBe('rejected');
    expect(nested?.deletedFiles).toBe(0);
    expect(nested?.manifestUpdated).toBe('skipped');
    expect(nested?.failed).toEqual([{ path: TARGET, reason: '该会话的清理正在进行' }]);
    expect(nestedOther?.state).toBe('noop');
    // 被拒的那次不写审计：全程只有第一次 run 的两次写入
    expect(h.audits).toHaveLength(2);
    expect(first.state).toBe('done');
    expect(first.deletedFiles).toBe(1);
  });

  it('占位在 finally 中摘除：上一次结束后同一 sessionId 可再次清理', async () => {
    const h = harness({
      tree: treeWith([ARCHIVE_A, ARCHIVE_B]),
      archives: [ARCHIVE_A, ARCHIVE_B],
      decisions: ['cancel', 'confirm'],
    });

    const cancelled = await h.cleaner.run('attachment', TARGET, TITLE);
    const second = await h.cleaner.run('attachment', TARGET, TITLE);

    expect(cancelled.state).toBe('cancelled');
    expect(second.state).toBe('done');
    expect(second.deletedFiles).toBe(2);
  });
});

/* ------------------------------------------------------------------ *
 * 6. 审计两次写入的时序与文案（Req 14.16、14.17）
 * ------------------------------------------------------------------ */

describe('审计两次写入的时序与文案（Req 14.16、14.17）', () => {
  it('删除前写 CleanupPlan、删除后写明细，两次写入同一通道', async () => {
    const h = harness({
      tree: treeWith([ARCHIVE_A]),
      archives: [ARCHIVE_A],
      decisions: ['confirm'],
    });

    await h.cleaner.run('full', TARGET, TITLE);

    expect(h.audits).toHaveLength(2);

    // ---- 时序：计划审计早于任何 unlink，明细审计晚于全部 unlink ----
    expect(h.audits[0].unlinkCalls).toBe(0);
    expect(h.audits[1].unlinkCalls).toBe(2);
    // 计划审计也早于确认提示（崩在确认或删除中途都仍有清单可查）
    expect(h.events.slice(0, 2)).toEqual(['audit#1', 'confirm:primary']);
    expect(h.events.indexOf('invalidate')).toBeLessThan(h.events.indexOf('audit#2'));

    // ---- 计划审计文案 ----
    const plan = h.audits[0].lines;
    // 任务 14.4：审计首行新增「格式」字段（Req 10.18），使 1.x 目录型与 0.9x 单文件可区分
    expect(plan[0]).toMatch(
      /^\[清理计划\] \d{4}-\d{2}-\d{2}T[\d:.]+Z 模式=full 格式=0\.9x 单文件 会话=s1 标题=会话一$/
    );
    expect(plan[1]).toBe('  待删文件：2 个 / 1536 字节');
    expect(plan[2]).toBe('  引用冲突（默认保留）：0 个 / 0 字节');
    expect(plan).toContain(`  - 待删 ${ARCHIVE_A.path}（1024 字节）`);
    expect(plan).toContain(`  - 待删 ${sessionFilePath(TARGET)}（512 字节）`);
    expect(plan).toContain(`  清单条目移除：${MANIFEST_PATH}`);

    // ---- 明细审计文案 ----
    const detail = h.audits[1].lines;
    expect(detail[0]).toMatch(
      /^\[清理结果\] \d{4}-\d{2}-\d{2}T[\d:.]+Z 模式=full 格式=0\.9x 单文件 会话=s1$/
    );
    expect(detail[1]).toBe(
      '  已删除 2 个 / 1536 字节，失败 0 个，跳过 0 个，已移除空目录 0 个，清单=ok'
    );
  });

  it('明细审计逐条记录失败与跳过的路径与原因', async () => {
    const archives = [ARCHIVE_A, ARCHIVE_B, ARCHIVE_REF];
    const h = harness({
      tree: treeWith(archives),
      archives,
      decisions: ['confirm'],
      faults: {
        // 不可重试失败 → failed[]
        fatal: { [ARCHIVE_B.path]: { code: 'EIO', op: 'unlink' } },
        // 确认后消失 → skipped[]（reason: missing）
        afterConfirm: { [ARCHIVE_REF.path]: { missing: true } },
      },
      onConfirm: (_p, self) => {
        self.rec.applyAfterConfirm();
      },
    });

    const result = await h.cleaner.run('attachment', TARGET, TITLE);

    expect(result.deletedFiles).toBe(1);
    expect(result.failed).toHaveLength(1);
    expect(result.skipped).toEqual([{ path: ARCHIVE_REF.path, reason: 'missing' }]);

    const detail = h.audits[1].lines;
    expect(detail[1]).toBe(
      '  已删除 1 个 / 1024 字节，失败 1 个，跳过 1 个，已移除空目录 0 个，清单=skipped'
    );
    expect(detail).toContain(`  - 失败 ${ARCHIVE_B.path}：EIO: EIO: unlink '${ARCHIVE_B.path}'`);
    expect(detail).toContain(`  - 跳过 ${ARCHIVE_REF.path}：missing`);
  });

  it('审计写入失败不阻止删除，明细阶段也不再抛异常', async () => {
    const h = harness({
      tree: treeWith([ARCHIVE_A]),
      archives: [ARCHIVE_A],
      decisions: ['confirm'],
      auditThrow: true,
    });

    const result = await h.cleaner.run('attachment', TARGET, TITLE);

    expect(result.state).toBe('done');
    expect(result.deletedFiles).toBe(1);
    // 两次写入都抛了，都被吞掉
    expect(h.events.filter((e) => e === 'audit:throw')).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ *
 * 7. FullCleanup 后残留存档在下一次统计中变孤儿（Req 3.8）
 * ------------------------------------------------------------------ */

describe('FullCleanup 后的残留存档在下一次统计中变孤儿（Req 3.8）', () => {
  it('SessionFile 与清单条目被移除后，删不掉的那条存档落入孤儿集合', async () => {
    const archives = [ARCHIVE_A, ARCHIVE_B, ARCHIVE_OTHER];
    const h = harness({
      tree: treeWith(archives),
      archives,
      decisions: ['confirm'],
      // B 删不掉（锁死的不可重试错误）→ 清理后仍残留在盘上
      faults: { fatal: { [ARCHIVE_B.path]: { code: 'EIO', op: 'unlink' } } },
    });

    // ---- 清理前：s1 仍是现存会话，它名下的存档一条都不是孤儿 ----
    const idsBefore = await liveSessionIds(h);
    expect(idsBefore).toEqual(new Set([TARGET, OTHER]));
    expect(computeOrphans(archives, { ids: idsBefore, complete: true })).toMatchObject({
      state: 'ok',
      files: 0,
      bytes: 0,
    });

    const result = await h.cleaner.run('full', TARGET, TITLE);

    expect(result.manifestUpdated).toBe('ok');
    expect(result.failed.map((f) => f.path)).toEqual([ARCHIVE_B.path]);
    expect(h.rec.exists(sessionFilePath(TARGET))).toBe(false);
    expect(h.rec.exists(ARCHIVE_B.path)).toBe(true);

    // ---- 清理后：s1 已不在 LiveSessionIds 里，残留的 B 成为孤儿 ----
    const idsAfter = await liveSessionIds(h);
    expect(idsAfter).toEqual(new Set([OTHER]));

    const remaining = archives.filter((a) => h.rec.exists(a.path));
    expect(remaining.map((a) => a.path)).toEqual([ARCHIVE_B.path, ARCHIVE_OTHER.path]);
    expect(computeOrphans(remaining, { ids: idsAfter, complete: true })).toMatchObject({
      state: 'ok',
      files: 1,
      bytes: ARCHIVE_B.size,
    });
  });
});

/* ------------------------------------------------------------------ *
 * 8. 整体失败时的通知文案（Req 9.9）
 * ------------------------------------------------------------------ */

describe('整体失败时的通知文案（Req 9.9）', () => {
  /**
   * 宿主侧的调用契约（`RankingPanel.handleCleanup`）：`run()` 上抛即记一条
   * 「会话清理失败：<message>」并**照常刷新**列表，面板始终保持可用。
   * 这里用同形状的调用方复现该契约，验证 cleaner 侧真的把段 1 的失败上抛
   * （而不是吞掉后返回一个看起来成功的结果）。
   */
  async function hostHandleCleanup(
    cleaner: SessionCleaner,
    mode: CleanupMode,
    sessionId: string,
    title: string,
    logs: string[]
  ): Promise<{ refreshed: boolean }> {
    try {
      await cleaner.run(mode, sessionId, title);
    } catch (err) {
      logs.push('会话清理失败：' + (err instanceof Error ? err.message : String(err)));
    }
    return { refreshed: true };
  }

  it('计划生成失败上抛给调用方，通知文案为「会话清理失败：…」且列表照常刷新', async () => {
    const h = harness({
      tree: treeWith([ARCHIVE_A]),
      archives: [ARCHIVE_A],
      archivesThrow: new Error('ArchiveIndex 读取失败'),
    });
    const logs: string[] = [];

    const { refreshed } = await hostHandleCleanup(h.cleaner, 'full', TARGET, TITLE, logs);

    expect(logs).toEqual(['会话清理失败：ArchiveIndex 读取失败']);
    expect(refreshed).toBe(true);
    // 失败发生在段 1：没有确认、没有审计、没有任何删除
    expect(h.prompts).toEqual([]);
    expect(h.audits).toEqual([]);
    expect(h.unlinked()).toEqual([]);
  });

  it('上抛之后互斥占位已摘除：修好数据源后可立刻重试', async () => {
    let broken = true;
    const rec = recordingCleanerFs(treeWith([ARCHIVE_A]));
    const deps: CleanerDeps = {
      fs: rec.deps,
      audit: () => {},
      confirm: async () => 'confirm',
      archives: () => {
        if (broken) throw new Error('ArchiveIndex 读取失败');
        return [ARCHIVE_A];
      },
      invalidate: () => {},
      roots: ROOTS,
    };
    const cleaner = new SessionCleaner(deps);

    await expect(cleaner.run('attachment', TARGET, TITLE)).rejects.toThrow('ArchiveIndex 读取失败');

    broken = false;
    const retried = await cleaner.run('attachment', TARGET, TITLE);

    expect(retried.state).toBe('done');
    expect(retried.deletedFiles).toBe(1);
  });
});
