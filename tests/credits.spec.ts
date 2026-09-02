import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  hash32,
  workspaceIdCandidates,
  extractUsageSummaryArray,
  sumCreditsFromUsageSummary,
  getCreditsForSessions,
  storeRootFromSessionDir,
  listArchiveEntries,
  dropArchiveEntries,
  __clearCreditCacheForTest,
} from '../src/credits';
import {
  listRecentSessions,
  searchSessionsInDir,
  __clearIndexCacheForTest,
} from '../src/search';
import { mkTempDir, rmTempDir } from './_helpers';

const tmpDirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  __clearCreditCacheForTest();
  __clearIndexCacheForTest();
  while (tmpDirs.length) rmTempDir(tmpDirs.pop()!);
});

function freshDir(): string {
  const d = mkTempDir();
  tmpDirs.push(d);
  return d;
}

let counter = 0;
/** 在 storeRoot 下按 workspaceId 目录写一个执行存档（hex32 文件名）。 */
function writeArchive(
  storeRoot: string,
  workspacePath: string,
  chatSessionId: string,
  usageSummary: unknown,
  opts: {
    underSavesFolder?: boolean;
    omitUsageSummary?: boolean;
    /** 注入到 operations 里的文本（用于模拟正文中出现 "usageSummary" 等） */
    opsText?: string;
    /** operations 追加的字节数，制造超过头尾窗口的大文件 */
    bigBytes?: number;
    /** 指定该存档对应的 executionId（文件名按 hash32(executionId) 生成，便于 lineage 反查） */
    executionId?: string;
  } = {}
): string {
  const wsId = hash32(workspacePath);
  let dir = path.join(storeRoot, wsId);
  if (opts.underSavesFolder) dir = path.join(dir, hash32('KIRO::EXECUTION::SAVES'));
  fs.mkdirSync(dir, { recursive: true });
  const fileName = opts.executionId
    ? hash32(opts.executionId)
    : crypto
        .createHash('sha256')
        .update('exec-' + counter++)
        .digest('hex')
        .slice(0, 32);

  // 关键：键顺序贴合真实 Kiro —— operations 在前、usageSummary 在末尾，
  // 以验证"正文里出现的 usageSummary 文本不会被误取为真正字段"。
  let opsMessage = opts.opsText ?? 'x'.repeat(50);
  if (opts.bigBytes) opsMessage = opsMessage + 'x'.repeat(opts.bigBytes);
  const parts: string[] = [];
  parts.push('"executionId":"e' + counter + '"');
  parts.push('"chatSessionId":' + JSON.stringify(chatSessionId));
  parts.push('"status":"succeed"');
  parts.push(
    '"operations":[{"type":"Say","output":{"message":' + JSON.stringify(opsMessage) + '}}]'
  );
  if (!opts.omitUsageSummary) {
    parts.push('"usageSummary":' + JSON.stringify(usageSummary));
  }
  const full = path.join(dir, fileName);
  fs.writeFileSync(full, '{' + parts.join(',') + '}', 'utf8');
  return full;
}

describe('hash32', () => {
  it('与 Kiro 实测哈希一致（已知键）', () => {
    expect(hash32('KIRO::EXECUTION::METADATA')).toBe('f62de366d0006e17ea00a01f6624aabf');
    expect(hash32('KIRO::EXECUTION::SAVES')).toBe('414d1636299d2b9e4ce7e17fb11f63e9');
    // workspaceId = hash(工作区 fsPath)，实测核对过
    expect(hash32('d:\\Projects\\DotNet\\CsCodeMap')).toBe('16277c8d93232c28e753d255666b7b69');
  });

  it('输出恒为 32 位十六进制', () => {
    expect(hash32('anything')).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('workspaceIdCandidates', () => {
  it('包含原始路径的哈希，并覆盖盘符大小写/斜杠变体', () => {
    const ids = workspaceIdCandidates('d:\\Projects\\DotNet\\CsCodeMap');
    expect(ids).toContain('16277c8d93232c28e753d255666b7b69');
    expect(ids.length).toBeGreaterThan(1);
    ids.forEach((id) => expect(id).toMatch(/^[0-9a-f]{32}$/));
  });
});

describe('extractUsageSummaryArray', () => {
  it('从含大 operations 的对象中只切出 usageSummary 数组', () => {
    const raw = JSON.stringify({
      operations: [{ output: { message: ']'.repeat(1000) } }],
      usageSummary: [
        { usage: 0.12, unit: 'credit', unitPlural: 'credits' },
        { usedTools: ['execute_pwsh'] },
      ],
      tail: true,
    });
    const arr = extractUsageSummaryArray(raw);
    expect(arr).not.toBeNull();
    const parsed = JSON.parse(arr!);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].unit).toBe('credit');
  });

  it('字符串内的 ] 不会提前截断数组', () => {
    const raw = '{"usageSummary":[{"unit":"credit","usage":1,"note":"has ] bracket"}]}';
    const arr = extractUsageSummaryArray(raw);
    expect(JSON.parse(arr!)[0].note).toBe('has ] bracket');
  });

  it('无 usageSummary 时返回 null', () => {
    expect(extractUsageSummaryArray('{"foo":1}')).toBeNull();
  });

  it('忽略正文里出现的 usageSummary 词，取末尾真正的字段', () => {
    // operations 文本里有"假"的 usageSummary 提及，真正字段在最后
    const raw =
      '{"operations":[{"output":{"message":"我们在讨论 usageSummary 这个词，甚至 [写了括号]"}}],' +
      '"usageSummary":[{"usage":0.7,"unit":"credit"}]}';
    const arr = extractUsageSummaryArray(raw);
    expect(arr).not.toBeNull();
    expect(JSON.parse(arr!)[0].usage).toBe(0.7);
  });

  it('取最后一个 usageSummary 字段（operations 之后的真字段）', () => {
    const raw =
      '{"a":"usageSummary mentioned","usageSummary":[{"usage":1,"unit":"credit"}]}';
    expect(JSON.parse(extractUsageSummaryArray(raw)!)[0].usage).toBe(1);
  });
});

describe('sumCreditsFromUsageSummary', () => {
  it('只累加 unit==="credit" 的 usage', () => {
    const text = JSON.stringify([
      { usage: 0.1, unit: 'credit' },
      { usage: 99, unit: 'tokens' },
      { usedTools: ['x'] },
      { usage: 0.05, unit: 'CREDIT' },
    ]);
    expect(sumCreditsFromUsageSummary(text)).toBeCloseTo(0.15, 10);
  });

  it('非数组 / 损坏输入返回 0', () => {
    expect(sumCreditsFromUsageSummary('not json')).toBe(0);
    expect(sumCreditsFromUsageSummary('{"a":1}')).toBe(0);
  });
});

describe('storeRootFromSessionDir', () => {
  it('向上两级得到 kiroagent 根', () => {
    const root = path.join('/x', 'kiro.kiroagent');
    const sessionDir = path.join(root, 'workspace-sessions', 'ENCODEDKEY');
    expect(storeRootFromSessionDir(sessionDir)).toBe(path.resolve(root));
  });
});

describe('getCreditsForSessions', () => {
  const WS = 'd:\\test\\ws';

  it('按 chatSessionId 跨多个执行汇总（扁平 + SAVES 子目录布局都计入）', () => {
    const root = freshDir();
    writeArchive(root, WS, 'sess-A', [{ usage: 0.2, unit: 'credit' }]);
    writeArchive(root, WS, 'sess-A', [{ usage: 0.3, unit: 'credit' }, { usedTools: ['x'] }], {
      underSavesFolder: true,
    });
    writeArchive(root, WS, 'sess-OTHER', [{ usage: 9, unit: 'credit' }]); // 不同会话，不计入

    const res = getCreditsForSessions(root, ['sess-A'], { workspacePath: WS });
    expect(res.found).toBe(true);
    expect(res.credits).toBeCloseTo(0.5, 10);
  });

  it('没有任何匹配会话的执行时 found=false', () => {
    const root = freshDir();
    writeArchive(root, WS, 'sess-A', [{ usage: 1, unit: 'credit' }]);
    const res = getCreditsForSessions(root, ['missing'], { workspacePath: WS });
    expect(res.found).toBe(false);
    expect(res.credits).toBe(0);
  });

  it('匹配会话但执行存档无 usageSummary 时 found=false（区分"没记录"与"0 credit"）', () => {
    const root = freshDir();
    writeArchive(root, WS, 'sess-spec', null, { omitUsageSummary: true });
    const res = getCreditsForSessions(root, ['sess-spec'], { workspacePath: WS });
    expect(res.found).toBe(false);
    expect(res.credits).toBe(0);
  });

  it('含 usageSummary 但无 credit 项时 found=true、credits=0', () => {
    const root = freshDir();
    writeArchive(root, WS, 'sess-zero', [{ usedTools: ['execute_pwsh'] }]);
    const res = getCreditsForSessions(root, ['sess-zero'], { workspacePath: WS });
    expect(res.found).toBe(true);
    expect(res.credits).toBe(0);
  });

  it('指定 workspacePath 时只扫描该工作区目录（其它工作区的同名会话不计入）', () => {
    const root = freshDir();
    writeArchive(root, 'd:\\test\\ws', 'shared-sid', [{ usage: 1, unit: 'credit' }]);
    writeArchive(root, 'd:\\test\\other', 'shared-sid', [{ usage: 5, unit: 'credit' }]);
    const res = getCreditsForSessions(root, ['shared-sid'], { workspacePath: 'd:\\test\\ws' });
    expect(res.credits).toBeCloseTo(1, 10);
  });

  it('空 sessionId 列表安全返回', () => {
    const root = freshDir();
    expect(getCreditsForSessions(root, [], { workspacePath: WS })).toEqual({
      credits: 0,
      found: false,
    });
  });

  it('checkpoint lineage：顺 history executionId 把祖先会话的消耗一并合计', () => {
    const root = freshDir();
    const ANCESTOR = 'sess-ancestor';
    const CHECKPOINT = 'sess-checkpoint';
    // 祖先会话自己的带 credit 执行
    writeArchive(root, WS, ANCESTOR, [{ usage: 700, unit: 'credit' }]);
    // checkpoint 自己的新增带 credit 执行
    writeArchive(root, WS, CHECKPOINT, [{ usage: 50, unit: 'credit' }]);
    // checkpoint 的 history 引用的执行——属于祖先会话、无 usageSummary（迁移记录）
    writeArchive(root, WS, ANCESTOR, null, {
      omitUsageSummary: true,
      executionId: 'hist-ref-1',
    });

    // 默认 includeLineage：传入 history executionId → 应合计祖先 + 自身 = 750
    const withLineage = getCreditsForSessions(root, [CHECKPOINT], {
      workspacePath: WS,
      historyExecutionIds: ['hist-ref-1'],
    });
    expect(withLineage.found).toBe(true);
    expect(withLineage.credits).toBeCloseTo(750, 6);

    // 关闭 lineage：仅自身 = 50
    const selfOnly = getCreditsForSessions(root, [CHECKPOINT], {
      workspacePath: WS,
      historyExecutionIds: ['hist-ref-1'],
      includeLineage: false,
    });
    expect(selfOnly.credits).toBeCloseTo(50, 6);
  });

  it('正文里嵌入伪 usageSummary 不污染结果（取末尾真字段）', () => {
    const root = freshDir();
    writeArchive(root, WS, 'sess-fp', [{ usage: 0.5, unit: 'credit' }], {
      opsText: '伪造 "usageSummary":[{"usage":999,"unit":"credit"}] 出现在正文里',
    });
    const res = getCreditsForSessions(root, ['sess-fp'], { workspacePath: WS });
    expect(res.found).toBe(true);
    expect(res.credits).toBeCloseTo(0.5, 10); // 不是 999
  });

  it('大文件（超过头尾窗口）：chatSessionId 在头、usageSummary 在尾仍能正确汇总', () => {
    const root = freshDir();
    // operations 追加 ~700KB，文件超过 HEAD(512K)+TAIL(128K)=640K
    writeArchive(root, WS, 'sess-big', [{ usage: 3.14, unit: 'credit' }], {
      bigBytes: 700 * 1024,
    });
    const res = getCreditsForSessions(root, ['sess-big'], { workspacePath: WS });
    expect(res.found).toBe(true);
    expect(res.credits).toBeCloseTo(3.14, 10);
  });
});

describe('search 集成：credits / contextPercentage 流入结果', () => {
  const WS = 'd:\\test\\proj';

  function buildLayout() {
    const root = freshDir(); // kiro.kiroagent 根
    const sessionDir = path.join(root, 'workspace-sessions', 'ENCODEDKEY');
    fs.mkdirSync(sessionDir, { recursive: true });
    return { root, sessionDir };
  }

  it('listRecentSessions 按 chatSessionId 汇总 credit 并带上下文百分比', () => {
    const { root, sessionDir } = buildLayout();
    fs.writeFileSync(
      path.join(sessionDir, 's1.json'),
      JSON.stringify({
        title: 'Session One',
        sessionId: 's1',
        workspacePath: WS,
        contextUsagePercentage: 42.5,
        history: [{ message: { role: 'user', content: 'hello' } }],
      }),
      'utf8'
    );
    // 真正带 credit 的执行以 chatSessionId 关联（executionId 不在会话 history 里也能找到）
    writeArchive(root, WS, 's1', [{ usage: 0.4, unit: 'credit' }]);
    writeArchive(root, WS, 's1', [{ usage: 0.6, unit: 'credit' }]);

    const hits = listRecentSessions(sessionDir, 20);
    expect(hits).toHaveLength(1);
    expect(hits[0].credits).toBeCloseTo(1.0, 10);
    expect(hits[0].contextPercentage).toBeCloseTo(42.5, 10);
  });

  it('无带用量的执行时 credits 保持 undefined，仍带 contextPercentage 回退', () => {
    const { sessionDir } = buildLayout();
    fs.writeFileSync(
      path.join(sessionDir, 's2.json'),
      JSON.stringify({
        title: 'No Credit Data',
        sessionId: 's2',
        workspacePath: WS,
        contextUsagePercentage: 12.3,
        history: [{ message: { role: 'assistant', content: 'x' } }],
      }),
      'utf8'
    );
    const hits = searchSessionsInDir(sessionDir, 'No Credit', 10);
    expect(hits).toHaveLength(1);
    expect(hits[0].credits).toBeUndefined();
    expect(hits[0].contextPercentage).toBeCloseTo(12.3, 10);
  });

  it('回归：spec/checkpoint —— history 引用的执行无用量，credit 落在同 chatSessionId 的其它执行上', () => {
    // 复现真实 bug：会话 history 里的 executionId 指向"无 usageSummary 的迁移记录"，
    // 真正消耗 credit 的执行用的是另一批 id、仅靠 chatSessionId 关联。
    const { root, sessionDir } = buildLayout();
    const sid = 'spec-4x-checkpoint';
    fs.writeFileSync(
      path.join(sessionDir, sid + '.json'),
      JSON.stringify({
        title: 'Spec: field-reference-indexing (checkpoint)',
        sessionId: sid,
        workspacePath: WS,
        contextUsagePercentage: 73,
        history: [
          // history 引用的执行——无 usageSummary（模拟 checkpoint 迁移记录）
          { message: { role: 'assistant', content: 'step' }, executionId: 'hist-exec-1' },
          { message: { role: 'assistant', content: 'step' }, executionId: 'hist-exec-2' },
        ],
      }),
      'utf8'
    );
    // history 引用的执行存档：有该 chatSessionId 但**无 usageSummary**
    writeArchive(root, WS, sid, null, { omitUsageSummary: true });
    writeArchive(root, WS, sid, null, { omitUsageSummary: true });
    // 真正带 credit 的执行：同 chatSessionId、不同（未被 history 引用的）id
    writeArchive(root, WS, sid, [{ usage: 109.5, unit: 'credit' }]);
    writeArchive(root, WS, sid, [{ usage: 60.4, unit: 'credit' }, { usedTools: ['x'] }]);

    const hits = listRecentSessions(sessionDir, 20);
    const hit = hits.find((h) => h.sessionId === sid)!;
    expect(hit).toBeDefined();
    // 必须按 chatSessionId 汇总到 169.9，而不是因 history executionId 无用量而显示 0/undefined
    expect(hit.credits).toBeCloseTo(169.9, 6);
  });
});

/* ------------------------------------------------------------------ *
 * ArchiveIndex 只读快照与条目摘除
 * ------------------------------------------------------------------ */

/** 与 credits.ts 的 SCAN_TTL_MS 保持一致（目录扫描节流窗口）。 */
const SCAN_TTL = 4000;

/**
 * 用固定时间戳设置 mtime。写入内容后重设为同一时间戳，可保证 stat 读到的
 * mtimeMs 与首次扫描时完全一致（同一输入 → 同一取整结果），从而稳定地模拟
 * "内容变了但 (mtime,size) 没变" 的场景。
 */
const FIXED_MTIME = new Date(1_700_000_000_000);
function pinMtime(file: string): void {
  fs.utimesSync(file, FIXED_MTIME, FIXED_MTIME);
}

/** 固定 Date.now，用于精确控制 4 秒扫描节流窗口。 */
function fixedClock(start = 1_700_000_000_000): (t: number) => void {
  const spy = vi.spyOn(Date, 'now').mockReturnValue(start);
  return (t: number) => spy.mockReturnValue(start + t);
}

describe('listArchiveEntries', () => {
  const WS = 'd:\\test\\archive-ws';

  it('快照字段完整：path / name(hash32(executionId)) / size / chatSessionId', () => {
    const root = freshDir();
    const f1 = writeArchive(root, WS, 'sess-A', [{ usage: 1, unit: 'credit' }], {
      executionId: 'exec-a',
    });
    const f2 = writeArchive(root, WS, 'sess-B', null, {
      omitUsageSummary: true,
      underSavesFolder: true,
    });

    const entries = listArchiveEntries(root, { workspacePath: WS });
    expect(entries).toHaveLength(2);

    const a = entries.find((e) => e.path === f1)!;
    expect(a).toBeDefined();
    expect(a.name).toBe(path.basename(f1));
    expect(a.name).toBe(hash32('exec-a')); // 供 history executionId 反查
    expect(a.size).toBe(fs.statSync(f1).size);
    expect(a.chatSessionId).toBe('sess-A');

    const b = entries.find((e) => e.path === f2)!;
    expect(b).toBeDefined();
    expect(b.size).toBe(fs.statSync(f2).size);
    // 无 usageSummary 也照样有 chatSessionId 与字节数
    expect(b.chatSessionId).toBe('sess-B');
  });

  it('只覆盖 workspacePath 对应的 workspaceId 目录', () => {
    const root = freshDir();
    const mine = writeArchive(root, WS, 'sess-A', [{ usage: 1, unit: 'credit' }]);
    writeArchive(root, 'd:\\test\\other-ws', 'sess-X', [{ usage: 1, unit: 'credit' }]);

    const entries = listArchiveEntries(root, { workspacePath: WS });
    expect(entries.map((e) => e.path)).toEqual([mine]);
  });

  it('重扫时复用缓存条目，不重复读取存档内容（(mtime,size) 未变 → 快照保持原解析结果）', () => {
    const root = freshDir();
    const f = writeArchive(root, WS, 'sess-A', [{ usage: 1, unit: 'credit' }]);
    pinMtime(f);

    const advance = fixedClock();
    const first = listArchiveEntries(root, { workspacePath: WS });
    expect(first).toHaveLength(1);
    expect(first[0].chatSessionId).toBe('sess-A');
    const size0 = first[0].size;

    // 原地改写内容：字节数不变、mtime 重设为同一时间戳
    const raw = fs.readFileSync(f, 'utf8');
    const mutated = raw.replace('"sess-A"', '"sess-Z"');
    expect(Buffer.byteLength(mutated, 'utf8')).toBe(Buffer.byteLength(raw, 'utf8'));
    fs.writeFileSync(f, mutated, 'utf8');
    pinMtime(f);

    // 节流窗口过期 → 目录重扫，但条目 (mtime,size) 未变 → 不重读内容，快照沿用旧解析
    advance(SCAN_TTL + 1);
    const second = listArchiveEntries(root, { workspacePath: WS });
    expect(second).toEqual(first);
    expect(second[0].chatSessionId).toBe('sess-A');

    // 对照：字节数变化后才会重新解析内容
    fs.writeFileSync(f, mutated + ' ', 'utf8');
    pinMtime(f);
    advance(2 * (SCAN_TTL + 1));
    const third = listArchiveEntries(root, { workspacePath: WS });
    expect(third[0].size).toBe(size0 + 1);
    expect(third[0].chatSessionId).toBe('sess-Z');
  });

  it('连续调用在 4 秒窗口内不重扫目录，超时后才重扫', () => {
    const root = freshDir();
    const f1 = writeArchive(root, WS, 'sess-A', [{ usage: 1, unit: 'credit' }]);

    const advance = fixedClock();
    expect(listArchiveEntries(root, { workspacePath: WS }).map((e) => e.path)).toEqual([f1]);

    // 窗口内新增的磁盘文件不会被看到——证明没有重新枚举目录
    const added = writeArchive(root, WS, 'sess-B', [{ usage: 2, unit: 'credit' }]);
    advance(SCAN_TTL - 1);
    expect(listArchiveEntries(root, { workspacePath: WS }).map((e) => e.path)).toEqual([f1]);
    expect(listArchiveEntries(root, { workspacePath: WS }).map((e) => e.path)).toEqual([f1]);

    // 超过 4 秒 → 重扫，新条目出现
    advance(SCAN_TTL + 1);
    const after = listArchiveEntries(root, { workspacePath: WS });
    expect(after.map((e) => e.path).sort()).toEqual([f1, added].sort());
  });
});

describe('dropArchiveEntries', () => {
  const WS = 'd:\\test\\drop-ws';

  it('只摘除给定路径的键并返回摘除数，不触发扫描、不改节流状态', () => {
    const root = freshDir();
    const f1 = writeArchive(root, WS, 'sess-A', [{ usage: 1, unit: 'credit' }]);
    const f2 = writeArchive(root, WS, 'sess-B', [{ usage: 2, unit: 'credit' }]);
    const f3 = writeArchive(root, WS, 'sess-C', [{ usage: 3, unit: 'credit' }]);

    const advance = fixedClock();
    expect(listArchiveEntries(root, { workspacePath: WS })).toHaveLength(3);

    // 摘除一条：返回实际摘除数
    expect(dropArchiveEntries([f2])).toBe(1);

    // 摘除后磁盘新增文件——若 dropArchiveEntries 触发扫描或重置了节流状态，它会立刻出现
    const addedAfterDrop = writeArchive(root, WS, 'sess-D', [{ usage: 4, unit: 'credit' }]);

    // 节流窗口内的快照：少掉被摘除那条，其余条目不受影响，新文件也未被收录
    advance(1);
    expect(
      listArchiveEntries(root, { workspacePath: WS })
        .map((e) => e.path)
        .sort()
    ).toEqual([f1, f3].sort());

    // 已摘除 / 未登记的路径返回 0
    expect(dropArchiveEntries([f2])).toBe(0);
    expect(dropArchiveEntries([path.join(root, 'not-indexed')])).toBe(0);
    expect(dropArchiveEntries([])).toBe(0);
    // 混合输入只计实际摘除数
    expect(dropArchiveEntries([f1, f2, path.join(root, 'nope')])).toBe(1);
    expect(listArchiveEntries(root, { workspacePath: WS }).map((e) => e.path)).toEqual([f3]);

    // 节流窗口过期后才重扫 → 此时新文件才进入索引
    advance(SCAN_TTL + 1);
    expect(
      listArchiveEntries(root, { workspacePath: WS })
        .map((e) => e.path)
        .sort()
    ).toEqual([f1, f2, f3, addedAfterDrop].sort());
  });

  it('只动索引不动磁盘：节流窗口过期后重扫会重新收录仍在磁盘上的文件', () => {
    const root = freshDir();
    const f1 = writeArchive(root, WS, 'sess-A', [{ usage: 1, unit: 'credit' }]);
    const f2 = writeArchive(root, WS, 'sess-B', [{ usage: 2, unit: 'credit' }]);

    const advance = fixedClock();
    expect(listArchiveEntries(root, { workspacePath: WS })).toHaveLength(2);
    expect(dropArchiveEntries([f2])).toBe(1);
    expect(listArchiveEntries(root, { workspacePath: WS }).map((e) => e.path)).toEqual([f1]);

    advance(SCAN_TTL + 1);
    const rescanned = listArchiveEntries(root, { workspacePath: WS });
    expect(rescanned.map((e) => e.path).sort()).toEqual([f1, f2].sort());
    expect(fs.existsSync(f2)).toBe(true);
  });
});
