import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  parseCreditsFromMessages,
  getCreditsFromMessages,
  getSessionCreditScopes,
  getCreditsForSessions,
  hash32,
  __clearCreditCacheForTest,
  __clearMessagesCreditCacheForTest,
  type CreditFsDeps,
  type MessagesCredits,
} from '../src/credits';
import { MESSAGES_FILENAME } from '../src/session/newFormat';
import { mkTempDir, rmTempDir, mkNewSessionTree, mkMessagesJsonl } from './_helpers';
import type { JsonlLineSpec, MessageEventSpec } from './_helpers';

/**
 * 1.x（新格式）用量读取的示例测试（任务 6.4，Req 4.5 / 4.7 / 4.8）。
 *
 * 与属性测试（任务 6.3）分工：这里钉住**具体的实测形状与具体数值**——研究笔记第 2 节
 * 「usage_summary 事件的实测形状」里那份真实事件，以及「0 与不可用」「双口径同值」
 * 「0.9x 回归不变」「缓存复用」这些人能对着真实数据核对的用例。
 *
 * 每个用例前清空两处进程内缓存（1.x 消息流用量 + 0.9x ArchiveIndex），避免用例间串扰。
 */

/* ------------------------------------------------------------------ *
 * 夹具：实测形状的 usage_summary 事件
 * ------------------------------------------------------------------ */

/** 本工作区的实测 WsHash16（研究笔记基线），夹具里只作目录名用。 */
const WS_HASH16 = 'cc5023603866cd91';

/** 研究笔记里记录的真实 credit 项数值（单事件单项）。 */
const REAL_USAGE = 147.15274264905472;

/**
 * 构造一个**实测形状**的 `usage_summary` 事件：用量数组字段名为
 * `promptTurnSummaries`，项里 `unit` / `unitPlural` / `usage` / `usedTools` 同处一项，
 * 事件另带 `elapsedTime` / `status` / `executionId` / `requestIds`。
 */
function usageSummaryEvent(
  items: unknown[],
  extra: Record<string, unknown> = {}
): MessageEventSpec {
  return {
    payload: {
      type: 'usage_summary',
      promptTurnSummaries: items,
      elapsedTime: 1056804,
      status: 'success',
      executionId: '25dcf9dc-3f0e-4b6a-9a1d-2f9c7d0e51ab',
      requestIds: ['b1f4c8d2-0000-4a11-9f3e-7c5a1d9e0002'],
      ...extra,
    },
  };
}

/** 实测形状的 credit 项：`usedTools` 与 credit 数值同处一项（1.x 的排布）。 */
function creditItem(usage: number, unit = 'credit'): Record<string, unknown> {
  return { unit, unitPlural: 'credits', usage, usedTools: ['read_file', 'grep_search'] };
}

/** 普通对话事件，用于把用量事件混在真实的事件流里。 */
function chatEvents(): JsonlLineSpec[] {
  return [
    { payload: { type: 'user', content: '看一下 credits 的实现' } },
    { payload: { type: 'tool_call', name: 'read_file', input: { path: 'src/credits.ts' } } },
    { payload: { type: 'assistant', content: '读到了' } },
    { payload: { type: 'turn_end', status: 'success' } },
  ];
}

/* ------------------------------------------------------------------ *
 * 夹具：注入型只读 fs（计数 + 可变 mtime + 可注入读失败）
 * ------------------------------------------------------------------ */

interface MemCreditFs {
  deps: CreditFsDeps;
  /** 各只读调用的次数，用于断言「缓存命中时不再 readFileSync」。 */
  counts: { stat: number; read: number };
  /** 改写文件内容并可指定新的 mtime（模拟 messages.jsonl 被追加）。 */
  setText(p: string, text: string, mtimeMs?: number): void;
  /** 只改 mtime，内容与字节数不变。 */
  touch(p: string, mtimeMs: number): void;
  /** 让该路径的 readFileSync 抛异常（stat 仍成功）——模拟文件不可读。 */
  failRead(p: string): void;
}

const MEM_MTIME = 1_700_000_000_000;

/** 内存版只读 fs：只实现 statSync / readFileSync 两个调用，并记录调用次数。 */
function memCreditFs(initial: Record<string, string>): MemCreditFs {
  const files = new Map<string, { text: string; mtimeMs: number }>();
  for (const [p, text] of Object.entries(initial)) {
    files.set(path.resolve(p), { text, mtimeMs: MEM_MTIME });
  }
  const unreadable = new Set<string>();
  const counts = { stat: 0, read: 0 };

  const enoent = (op: string, p: string): Error => {
    const e = new Error(`ENOENT: ${op} '${p}'`);
    (e as Error & { code: string }).code = 'ENOENT';
    return e;
  };

  const deps: CreditFsDeps = {
    statSync: (p) => {
      counts.stat++;
      const f = files.get(path.resolve(p));
      if (!f) throw enoent('stat', p);
      return { size: Buffer.byteLength(f.text, 'utf8'), mtimeMs: f.mtimeMs };
    },
    readFileSync: (p) => {
      counts.read++;
      const key = path.resolve(p);
      if (unreadable.has(key)) {
        const e = new Error(`EACCES: read '${p}'`);
        (e as Error & { code: string }).code = 'EACCES';
        throw e;
      }
      const f = files.get(key);
      if (!f) throw enoent('read', p);
      return f.text;
    },
  };

  return {
    deps,
    counts,
    setText(p, text, mtimeMs) {
      const key = path.resolve(p);
      const prev = files.get(key);
      files.set(key, { text, mtimeMs: mtimeMs ?? (prev?.mtimeMs ?? MEM_MTIME) + 1000 });
    },
    touch(p, mtimeMs) {
      const key = path.resolve(p);
      const prev = files.get(key);
      if (prev) files.set(key, { text: prev.text, mtimeMs });
    },
    failRead(p) {
      unreadable.add(path.resolve(p));
    },
  };
}

/* ------------------------------------------------------------------ *
 * 夹具：0.9x 执行存档（回归用，形状与 credits.spec.ts 同源）
 * ------------------------------------------------------------------ */

let archiveCounter = 0;

/** 在 storeRoot 下按 workspaceId 目录写一个 0.9x 执行存档（hex32 文件名）。 */
function writeArchive(
  storeRoot: string,
  workspacePath: string,
  chatSessionId: string,
  usageSummary: unknown,
  opts: { omitUsageSummary?: boolean; executionId?: string; underSavesFolder?: boolean } = {}
): string {
  let dir = path.join(storeRoot, hash32(workspacePath));
  if (opts.underSavesFolder) dir = path.join(dir, hash32('KIRO::EXECUTION::SAVES'));
  fs.mkdirSync(dir, { recursive: true });
  const name = opts.executionId
    ? hash32(opts.executionId)
    : crypto
        .createHash('sha256')
        .update('newformat-exec-' + archiveCounter++)
        .digest('hex')
        .slice(0, 32);

  const parts = [
    '"executionId":"e' + archiveCounter + '"',
    '"chatSessionId":' + JSON.stringify(chatSessionId),
    '"status":"succeed"',
    '"operations":[{"type":"Say","output":{"message":"x"}}]',
  ];
  if (!opts.omitUsageSummary) parts.push('"usageSummary":' + JSON.stringify(usageSummary));

  const full = path.join(dir, name);
  fs.writeFileSync(full, '{' + parts.join(',') + '}', 'utf8');
  return full;
}

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */

const tmpDirs: string[] = [];

/** 建一个临时 sessions 根（`~/.kiro/sessions` 的替身），afterEach 统一清理。 */
function freshSessionsRoot(): string {
  const d = mkTempDir('kcs-credits-new-');
  tmpDirs.push(d);
  return d;
}

beforeEach(() => {
  // 两处缓存都清：1.x 消息流用量 + 0.9x ArchiveIndex/扫描节流
  __clearMessagesCreditCacheForTest();
  __clearCreditCacheForTest();
});

afterEach(() => {
  __clearMessagesCreditCacheForTest();
  __clearCreditCacheForTest();
  while (tmpDirs.length) rmTempDir(tmpDirs.pop()!);
});

/* ================================================================== *
 * 1. 实测形状：认得真实数据
 * ================================================================== */

describe('1.x 用量读取：实测形状', () => {
  it('研究笔记里的真实事件形状（promptTurnSummaries + unit/unitPlural/usage/usedTools）合计正确', () => {
    const root = freshSessionsRoot();
    const t = mkNewSessionTree(root, {
      wsHash16: WS_HASH16,
      sessionId: 'sess_1f0d2c3b-4a59-4c7e-8b21-6d0e9f5a3c11',
      session: { title: 'Spec: kiro-1x-storage-adaptation' },
      events: [...chatEvents(), usageSummaryEvent([creditItem(REAL_USAGE)])],
    });

    const res = getCreditsFromMessages(t.sessionDir);
    expect(res.found).toBe(true);
    expect(res.credits).toBe(REAL_USAGE);
    expect(res.usageSummaryCount).toBe(1);
    expect(res.creditItemCount).toBe(1);
  });

  it('纯函数层同样认得该形状（无需磁盘）', () => {
    const raw = mkMessagesJsonl([usageSummaryEvent([creditItem(REAL_USAGE)])]);
    expect(parseCreditsFromMessages(raw).credits).toBe(REAL_USAGE);
  });
});

/* ================================================================== *
 * 2. 按 credit 单位过滤（含大小写变体）
 * ================================================================== */

describe('1.x 用量读取：按 credit 单位过滤', () => {
  it('非 credit 单位项不进合计，credit / Credit / CREDIT 三种写法都计入', () => {
    const root = freshSessionsRoot();
    const t = mkNewSessionTree(root, {
      wsHash16: WS_HASH16,
      sessionId: 'sess_unit-filter',
      events: [
        usageSummaryEvent([
          creditItem(1.5, 'credit'),
          creditItem(2.25, 'Credit'),
          creditItem(0.25, 'CREDIT'),
          // 以下均不该进合计
          { unit: 'token', unitPlural: 'tokens', usage: 999 },
          { unit: 'tokens', usage: 12345 },
          { usedTools: ['execute_pwsh'] }, // 0.9x 风格的纯工具项：无 unit
          { unit: 'credit' }, // 缺 usage
          { unit: 'credit', usage: null }, // usage 非数值（NaN 序列化后即 null）
          { unit: 'credit', usage: '3' }, // usage 为字符串
        ]),
      ],
    });

    const res = getCreditsFromMessages(t.sessionDir);
    expect(res.found).toBe(true);
    expect(res.credits).toBeCloseTo(4.0, 10); // 1.5 + 2.25 + 0.25，其余一概排除
    expect(res.creditItemCount).toBe(3);
  });
});

/* ================================================================== *
 * 3. 多事件累加
 * ================================================================== */

describe('1.x 用量读取：多事件累加', () => {
  it('多个 usage_summary 事件的 credit 项合计正确（含混在中间的对话事件与空事件）', () => {
    const root = freshSessionsRoot();
    const t = mkNewSessionTree(root, {
      wsHash16: WS_HASH16,
      sessionId: 'sess_multi-event',
      events: [
        { payload: { type: 'user', content: 'go' } },
        usageSummaryEvent([creditItem(100.5)]),
        { payload: { type: 'assistant', content: 'ok' } },
        // status 为 failed 的空事件：贡献 0 项，不影响其余事件的合计
        usageSummaryEvent([], { status: 'failed' }),
        usageSummaryEvent([creditItem(20.25), { unit: 'token', usage: 7 }]),
        usageSummaryEvent([creditItem(0.75), creditItem(1.5)]),
      ],
    });

    const res = getCreditsFromMessages(t.sessionDir);
    expect(res.found).toBe(true);
    expect(res.credits).toBeCloseTo(123.0, 10);
    expect(res.usageSummaryCount).toBe(4);
    expect(res.creditItemCount).toBe(4);
  });
});

/* ================================================================== *
 * 4. 不可用的三种来源（Req 4.7）+ 不可用不影响其余会话（Req 4.8）
 * ================================================================== */

describe('1.x 用量读取：不可用的三种来源（Req 4.7）', () => {
  /** 三种不可用来源各建一个会话，返回 sessionId → NewSessionDir。 */
  function buildUnavailableSessions(root: string): Record<string, string> {
    const noEvent = mkNewSessionTree(root, {
      wsHash16: WS_HASH16,
      sessionId: 'sess_no-usage-event',
      events: chatEvents(), // 完全没有 usage_summary 事件
    });
    const emptyEvent = mkNewSessionTree(root, {
      wsHash16: WS_HASH16,
      sessionId: 'sess_empty-summaries',
      // 实测存在的空事件：promptTurnSummaries 为 []
      events: [...chatEvents(), usageSummaryEvent([], { status: 'failed' })],
    });
    const nonCredit = mkNewSessionTree(root, {
      wsHash16: WS_HASH16,
      sessionId: 'sess_non-credit-units',
      events: [
        usageSummaryEvent([
          { unit: 'token', unitPlural: 'tokens', usage: 8000 },
          { usedTools: ['execute_pwsh'] },
        ]),
      ],
    });
    return {
      noEvent: noEvent.sessionDir,
      emptyEvent: emptyEvent.sessionDir,
      nonCredit: nonCredit.sessionDir,
    };
  }

  it('无 usage_summary / promptTurnSummaries 为空 / 全是非 credit 单位 → credits 为 null 且不抛异常', () => {
    const root = freshSessionsRoot();
    const dirs = buildUnavailableSessions(root);

    let results: Record<string, MessagesCredits> = {};
    expect(() => {
      results = {
        noEvent: getCreditsFromMessages(dirs.noEvent),
        emptyEvent: getCreditsFromMessages(dirs.emptyEvent),
        nonCredit: getCreditsFromMessages(dirs.nonCredit),
      };
    }).not.toThrow();

    for (const key of ['noEvent', 'emptyEvent', 'nonCredit'] as const) {
      expect(results[key].credits, key).toBeNull();
      expect(results[key].found, key).toBe(false);
      expect(results[key].creditItemCount, key).toBe(0);
    }
    // usageSummaryCount 把三种来源区分开：没有事件 / 有事件但项为空或无 credit 项
    expect(results.noEvent.usageSummaryCount).toBe(0);
    expect(results.emptyEvent.usageSummaryCount).toBe(1);
    expect(results.nonCredit.usageSummaryCount).toBe(1);

    // 双口径入口同样不抛、同样不可用
    for (const dir of Object.values(dirs)) {
      const scopes = getSessionCreditScopes({ format: 'new', sessionDir: dir });
      expect(scopes).toEqual({ self: null, lineage: null, found: false, format: 'new' });
    }
  });

  it('某会话不可用不影响同目录其余会话取数（Req 4.8 的数据侧前提）', () => {
    const root = freshSessionsRoot();
    const dirs = buildUnavailableSessions(root);
    const ok = mkNewSessionTree(root, {
      wsHash16: WS_HASH16,
      sessionId: 'sess_has-credit',
      events: [usageSummaryEvent([creditItem(REAL_USAGE)])],
    });

    // 不可用的排在前面：先取它们再取可用的，验证不可用不会污染后续取数
    const batch = [dirs.noEvent, dirs.emptyEvent, dirs.nonCredit, ok.sessionDir].map((d) =>
      getCreditsFromMessages(d)
    );
    expect(batch.map((r) => r.credits)).toEqual([null, null, null, REAL_USAGE]);
    // 角标省略与否由 credits 是否为 null 决定：这里恰好一条可展示
    expect(batch.filter((r) => r.credits !== null)).toHaveLength(1);
  });
});

/* ================================================================== *
 * 5. 0 与不可用的区别
 * ================================================================== */

describe('1.x 用量读取：0 与不可用严格区分', () => {
  it('credit 项的 usage 全为 0 → credits 为 0 且 found 为 true（确实花了 0，不是不可用）', () => {
    const root = freshSessionsRoot();
    const t = mkNewSessionTree(root, {
      wsHash16: WS_HASH16,
      sessionId: 'sess_zero-usage',
      events: [usageSummaryEvent([creditItem(0)]), usageSummaryEvent([creditItem(0), creditItem(0)])],
    });

    const res = getCreditsFromMessages(t.sessionDir);
    expect(res.credits).toBe(0);
    expect(res.found).toBe(true);
    expect(res.creditItemCount).toBe(3);
    // 0 不是 null：上层据此展示 0 而不是省略角标
    expect(res.credits).not.toBeNull();

    const scopes = getSessionCreditScopes({ format: 'new', sessionDir: t.sessionDir });
    expect(scopes).toEqual({ self: 0, lineage: 0, found: true, format: 'new' });
  });
});

/* ================================================================== *
 * 6. 1.x 双口径同值（design D4、Req 4.3）
 * ================================================================== */

describe('1.x 双口径：self === lineage（D4）', () => {
  it('getSessionCreditScopes 对 1.x 会话两个口径取同一值，format 为 new', () => {
    const root = freshSessionsRoot();
    const t = mkNewSessionTree(root, {
      wsHash16: WS_HASH16,
      sessionId: '9f8fb2af-0d80-4521-852d-f1404757d60f', // 迁移来的裸 uuid 会话
      events: [usageSummaryEvent([creditItem(700.5)]), usageSummaryEvent([creditItem(37.02)])],
    });

    const scopes = getSessionCreditScopes({ format: 'new', sessionDir: t.sessionDir });
    expect(scopes.format).toBe('new');
    expect(scopes.found).toBe(true);
    expect(scopes.self).toBeCloseTo(737.52, 10);
    expect(scopes.self).toBe(scopes.lineage); // 同一值，不只是数值相等
    // 与直接取数一致
    expect(scopes.self).toBe(getCreditsFromMessages(t.sessionDir).credits);
  });
});

/* ================================================================== *
 * 7. 0.9x 回归不变（Req 4.5）
 * ================================================================== */

describe('0.9x 回归：存档查表与双口径语义不变（Req 4.5）', () => {
  const WS = 'd:\\test\\newformat-old-ws';

  it('getSessionCreditScopes(old) 与直接调 getCreditsForSessions 结果一致，且保留 self/lineage 差异', () => {
    const storeRoot = freshSessionsRoot();
    const ANCESTOR = 'sess-ancestor';
    const CHECKPOINT = 'sess-checkpoint';
    writeArchive(storeRoot, WS, ANCESTOR, [{ usage: 700, unit: 'credit' }]);
    writeArchive(storeRoot, WS, CHECKPOINT, [{ usage: 50, unit: 'credit' }], {
      underSavesFolder: true,
    });
    // checkpoint 的 history 引用的执行：属于祖先会话、无 usageSummary（迁移记录）
    writeArchive(storeRoot, WS, ANCESTOR, null, {
      omitUsageSummary: true,
      executionId: 'hist-ref-1',
    });

    // 既有 API 的基准值
    const baselineSelf = getCreditsForSessions(storeRoot, [CHECKPOINT], {
      workspacePath: WS,
      includeLineage: false,
    });
    const baselineLineage = getCreditsForSessions(storeRoot, [CHECKPOINT], {
      workspacePath: WS,
      historyExecutionIds: ['hist-ref-1'],
    });
    expect(baselineSelf.credits).toBeCloseTo(50, 6);
    expect(baselineLineage.credits).toBeCloseTo(750, 6);

    const scopes = getSessionCreditScopes({
      format: 'old',
      storeRoot,
      sessionId: CHECKPOINT,
      workspacePath: WS,
      historyExecutionIds: ['hist-ref-1'],
    });
    expect(scopes.format).toBe('old');
    expect(scopes.found).toBe(true);
    expect(scopes.self).toBe(baselineSelf.credits);
    expect(scopes.lineage).toBe(baselineLineage.credits);
    // 双口径语义保留：0.9x 下两者可以不同
    expect(scopes.self).not.toBe(scopes.lineage);
  });

  it('0.9x 查不到带用量的执行时 found=false 映射为 null（与 1.x 的不可用同义）', () => {
    const storeRoot = freshSessionsRoot();
    writeArchive(storeRoot, WS, 'sess-spec', null, { omitUsageSummary: true });

    const baseline = getCreditsForSessions(storeRoot, ['sess-spec'], { workspacePath: WS });
    expect(baseline).toEqual({ credits: 0, found: false });

    const scopes = getSessionCreditScopes({
      format: 'old',
      storeRoot,
      sessionId: 'sess-spec',
      workspacePath: WS,
    });
    // found=false 的 0 不冒充"花了 0"，统一映射为 null
    expect(scopes).toEqual({ self: null, lineage: null, found: false, format: 'old' });
  });
});

/* ================================================================== *
 * 8. 缓存按 (mtimeMs, size) 失效（Req 4.11）
 * ================================================================== */

describe('1.x 用量读取：缓存（Req 4.11）', () => {
  const SESSION_DIR = path.resolve('/virtual/kiro/sessions', WS_HASH16, 'sess_cache-probe');
  const MESSAGES = path.join(SESSION_DIR, MESSAGES_FILENAME);

  it('第二次取数不再 readFileSync；mtime 变化后重读；清缓存后重读', () => {
    const raw = mkMessagesJsonl([usageSummaryEvent([creditItem(10)])]);
    const mem = memCreditFs({ [MESSAGES]: raw });

    const first = getCreditsFromMessages(SESSION_DIR, mem.deps);
    expect(first.credits).toBe(10);
    expect(mem.counts.read).toBe(1);
    expect(mem.counts.stat).toBe(1);

    // 缓存命中：stat 照做（用于判定失效），readFileSync 不再发生
    const second = getCreditsFromMessages(SESSION_DIR, mem.deps);
    expect(second).toEqual(first);
    expect(mem.counts.read).toBe(1);
    expect(mem.counts.stat).toBe(2);

    // 双口径入口同样走缓存
    const scopes = getSessionCreditScopes({
      format: 'new',
      sessionDir: SESSION_DIR,
      deps: mem.deps,
    });
    expect(scopes.self).toBe(10);
    expect(mem.counts.read).toBe(1);

    // 内容改动 + mtime 前进 → 重读并给出新值
    mem.setText(MESSAGES, mkMessagesJsonl([usageSummaryEvent([creditItem(10), creditItem(5)])]));
    const third = getCreditsFromMessages(SESSION_DIR, mem.deps);
    expect(third.credits).toBe(15);
    expect(mem.counts.read).toBe(2);

    // 只改 mtime、内容与字节数不变 → 也算失效（判据是 (mtimeMs, size) 组合）
    mem.touch(MESSAGES, MEM_MTIME + 999_999);
    expect(getCreditsFromMessages(SESSION_DIR, mem.deps).credits).toBe(15);
    expect(mem.counts.read).toBe(3);

    // 缓存未失效时不重读（再确认一次）
    expect(getCreditsFromMessages(SESSION_DIR, mem.deps).credits).toBe(15);
    expect(mem.counts.read).toBe(3);

    // 显式清缓存 → 下一次必然重读
    __clearMessagesCreditCacheForTest();
    expect(getCreditsFromMessages(SESSION_DIR, mem.deps).credits).toBe(15);
    expect(mem.counts.read).toBe(4);
  });

  it('__clearCreditCacheForTest 也一并清掉 1.x 消息流缓存', () => {
    const mem = memCreditFs({ [MESSAGES]: mkMessagesJsonl([usageSummaryEvent([creditItem(2)])]) });
    expect(getCreditsFromMessages(SESSION_DIR, mem.deps).credits).toBe(2);
    expect(mem.counts.read).toBe(1);
    getCreditsFromMessages(SESSION_DIR, mem.deps);
    expect(mem.counts.read).toBe(1);

    __clearCreditCacheForTest();
    getCreditsFromMessages(SESSION_DIR, mem.deps);
    expect(mem.counts.read).toBe(2);
  });
});

/* ================================================================== *
 * 9. 文件缺失 / 不可读
 * ================================================================== */

describe('1.x 用量读取：文件缺失或不可读', () => {
  it('会话目录里没有 messages.jsonl → 不可用且不抛异常', () => {
    const root = freshSessionsRoot();
    const t = mkNewSessionTree(root, {
      wsHash16: WS_HASH16,
      sessionId: 'sess_no-messages-file',
      events: null, // 不生成 messages.jsonl
      snapshots: { 'h1/src/a.ts': 32 },
    });
    expect(t.messagesJsonl).toBeNull();
    expect(fs.existsSync(path.join(t.sessionDir, MESSAGES_FILENAME))).toBe(false);

    let res: MessagesCredits | undefined;
    expect(() => {
      res = getCreditsFromMessages(t.sessionDir);
    }).not.toThrow();
    expect(res).toEqual({
      credits: null,
      found: false,
      usageSummaryCount: 0,
      creditItemCount: 0,
    });

    // 会话目录本身都不存在时同样不抛
    expect(() =>
      getCreditsFromMessages(path.join(root, WS_HASH16, 'sess_does-not-exist'))
    ).not.toThrow();
    expect(
      getSessionCreditScopes({
        format: 'new',
        sessionDir: path.join(root, WS_HASH16, 'sess_does-not-exist'),
      })
    ).toEqual({ self: null, lineage: null, found: false, format: 'new' });
  });

  it('readFileSync 抛异常（文件不可读）→ 不可用且不抛异常，恢复后可重新取到值', () => {
    const sessionDir = path.resolve('/virtual/kiro/sessions', WS_HASH16, 'sess_unreadable');
    const messages = path.join(sessionDir, MESSAGES_FILENAME);
    const mem = memCreditFs({ [messages]: mkMessagesJsonl([usageSummaryEvent([creditItem(8)])]) });
    mem.failRead(messages);

    let res: MessagesCredits | undefined;
    expect(() => {
      res = getCreditsFromMessages(sessionDir, mem.deps);
    }).not.toThrow();
    expect(res?.credits).toBeNull();
    expect(res?.found).toBe(false);
    expect(mem.counts.read).toBe(1);

    // 失败结果不入缓存：换一个可读的 deps 立刻能取到值
    const healthy = memCreditFs({
      [messages]: mkMessagesJsonl([usageSummaryEvent([creditItem(8)])]),
    });
    expect(getCreditsFromMessages(sessionDir, healthy.deps).credits).toBe(8);
  });
});

/* ================================================================== *
 * 10. 坏行容错
 * ================================================================== */

describe('1.x 用量读取：坏行容错', () => {
  it('非法行被跳过，其余用量项照常合计', () => {
    const root = freshSessionsRoot();
    const t = mkNewSessionTree(root, {
      wsHash16: WS_HASH16,
      sessionId: 'sess_bad-lines',
      events: [
        usageSummaryEvent([creditItem(1.25)]),
        '{ not json at all',
        '', // 空行
        // 含 usage_summary 词但被截断的半行（追加写被中断的真实形态）
        '{"id":"evt-x","payload":{"type":"usage_summary","promptTurnSummaries":[{"unit":"cre',
        'usage_summary', // 裸 token 行
        usageSummaryEvent([creditItem(2.75)]),
        { payload: { type: 'assistant', content: '结束' } },
      ],
      // 与真实追加式写入一致：以换行结尾（末尾空行同样要被安全跳过）
      messagesOptions: { trailingNewline: true },
    });

    const res = getCreditsFromMessages(t.sessionDir);
    expect(res.found).toBe(true);
    expect(res.credits).toBeCloseTo(4.0, 10);
    expect(res.usageSummaryCount).toBe(2); // 坏行不计入事件数
    expect(res.creditItemCount).toBe(2);
  });

  it('文件整体不是 JSONL（全是坏行）→ 不可用而不是 0', () => {
    const root = freshSessionsRoot();
    const t = mkNewSessionTree(root, {
      wsHash16: WS_HASH16,
      sessionId: 'sess_all-bad-lines',
      messagesJsonlRaw: '{"payload":{"type":"usage_summary",\n<<<truncated\n',
    });

    const res = getCreditsFromMessages(t.sessionDir);
    expect(res.credits).toBeNull();
    expect(res.found).toBe(false);
  });
});
