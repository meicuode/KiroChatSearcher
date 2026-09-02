import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import * as fs from 'fs';
import * as path from 'path';
import {
  collectLiveSessions,
  computeOrphans,
  MANIFEST_FILENAME,
  ORPHAN_NOTE,
} from '../src/storage/orphan';
import type { ArchiveInfo } from '../src/credits';
import { mkTempDir, mkTree, rmTempDir, type TreeSpec } from './_helpers';

/* ------------------------------------------------------------------ *
 * 共享生成器与夹具工具
 * 供本文件内 Property 8 及后续追加的 Property 9 共用
 * ------------------------------------------------------------------ */

/** `sessions.json` 去掉扩展名后的名字：它恒不得作为一条会话记录出现 */
const MANIFEST_ID = path.basename(MANIFEST_FILENAME, '.json');

/**
 * sessionId 池刻意很小且被「文件名」与「清单条目」两侧共用，使随机夹具高概率
 * 出现三种关系：两侧都有、只在文件侧、只在清单侧——并集性质必须在三者上都成立。
 * 池里含 `sessions`：以该 id 命名的会话文件就是 `sessions.json` 本身，用来钉住
 * 「清单文件不被当作会话记录」这一条。
 */
const SESSION_ID_POOL = ['s1', 's2', 's3', 's4', 's5', MANIFEST_ID] as const;

/**
 * 清单条目生成器：混入四类无效条目（缺 `sessionId` / 空串 / 非字符串 / `null`），
 * 它们恒不贡献 sessionId，因此并集不会被脏数据撑大。
 */
const manifestEntryArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.record({
    sessionId: fc.constantFrom(...SESSION_ID_POOL),
    title: fc.string({ maxLength: 8 }),
  }),
  fc.constantFrom(...SESSION_ID_POOL).map((id) => ({ sessionId: id })),
  fc.constant({}),
  fc.constant({ sessionId: '' }),
  fc.constant({ sessionId: 42 }),
  fc.constant(null)
);

export interface WorkspaceFixture {
  /** 目录下的 SessionFile：`[sessionId, 字节数]`，sessionId 在目录内唯一 */
  files: Array<[string, number]>;
  /** 清单条目数组；`null` 表示该目录没有 `sessions.json` */
  manifest: unknown[] | null;
  /** 是否放一个子目录（其中的 `.json` 恒不算会话） */
  withSubdir: boolean;
}

export const workspaceFixtureArb: fc.Arbitrary<WorkspaceFixture> = fc.record({
  files: fc.uniqueArray(
    fc.tuple(fc.constantFrom(...SESSION_ID_POOL), fc.integer({ min: 0, max: 64 })),
    { selector: (t) => t[0], maxLength: 5 }
  ),
  manifest: fc.option(fc.array(manifestEntryArb, { maxLength: 5 }), { nil: null }),
  withSubdir: fc.boolean(),
});

/** 清单文件是否实际存在：显式给了清单，或有一个会话恰好叫 `sessions` */
function manifestPresent(ws: WorkspaceFixture): boolean {
  return ws.manifest !== null || ws.files.some(([id]) => id === MANIFEST_ID);
}

/** 工作区目录名按下标生成，保证唯一（EncodedKey 的具体形态与本属性无关） */
export function workspaceDirName(i: number): string {
  return `ws${i}`;
}

/**
 * 在真实临时目录里落地夹具。`strayRootFile` 在 sessionsRoot 下放一个非目录条目，
 * 它既不算会话也不算跳过。
 */
export function materialize(
  sessionsRoot: string,
  wss: WorkspaceFixture[],
  strayRootFile: boolean
): void {
  const spec: TreeSpec = {};
  if (strayRootFile) spec['stray.json'] = 7;
  wss.forEach((ws, i) => {
    const dir: TreeSpec = {};
    for (const [id, bytes] of ws.files) dir[`${id}.json`] = bytes;
    if (ws.withSubdir) dir['nested'] = { 'inner.json': 11 };
    // 清单最后写：若某会话恰好叫 `sessions`，这里覆盖成合法 JSON，
    // 使「文件名侧的 sessions」与「清单文件」是同一个文件这一真实情形被覆盖到
    if (manifestPresent(ws)) dir[MANIFEST_FILENAME] = JSON.stringify(ws.manifest ?? []);
    dir['notes.txt'] = 5; // 非 .json 文件恒不算会话
    spec[workspaceDirName(i)] = dir;
  });
  mkTree(sessionsRoot, spec);
}

/** 测试侧独立计算的期望并集：文件名侧（去掉 `sessions`）∪ 清单侧的有效 sessionId */
export function expectedLiveIds(wss: WorkspaceFixture[]): Set<string> {
  const out = new Set<string>();
  for (const ws of wss) {
    for (const [id] of ws.files) {
      if (id !== MANIFEST_ID) out.add(id);
    }
    if (!manifestPresent(ws)) continue;
    for (const item of ws.manifest ?? []) {
      const sid = (item as { sessionId?: unknown } | null)?.sessionId;
      if (typeof sid === 'string' && sid.length > 0) out.add(sid);
    }
  }
  return out;
}

/** 目录下直接文件条目的字节数合计（含 `sessions.json`），用真实 fs 独立算出 */
export function directFileBytes(dir: string): number {
  let sum = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    sum += fs.lstatSync(path.join(dir, entry.name)).size;
  }
  return sum;
}

const sorted = (ids: Iterable<string>): string[] => [...ids].sort();

/* ------------------------------------------------------------------ *
 * Property 8
 * ------------------------------------------------------------------ */

// Feature: storage-usage-analytics, Property 8: LiveSessionIds 为两个来源的并集
// Validates: Requirements 3.1
describe('Property 8: LiveSessionIds 为两个来源的并集', () => {
  let base: string | null = null;
  let runSeq = 0;

  afterEach(() => {
    if (base) rmTempDir(base);
    base = null;
  });

  it('Property 8: ids 恒等于会话文件名集合与清单 sessionId 集合的并集，且 sessions.json 不算会话', async () => {
    base = mkTempDir('kcs-orphan-prop-');
    const fixtureBase = base;

    await fc.assert(
      fc.asyncProperty(
        fc.array(workspaceFixtureArb, { maxLength: 3 }),
        fc.boolean(),
        async (wss, strayRootFile) => {
          const sessionsRoot = path.join(fixtureBase, `r${runSeq++}`);
          materialize(sessionsRoot, wss, strayRootFile);

          const res = await collectLiveSessions(sessionsRoot);

          // 并集：两个来源都完整贡献，且没有额外 id 被凭空引入
          expect(sorted(res.ids)).toEqual(sorted(expectedLiveIds(wss)));

          // 夹具全部可读可解析，故枚举完整（孤儿判定才可能进入 ok/unknown）
          expect(res.skippedCount).toBe(0);
          expect(res.complete).toBe(true);
          expect(res.complete).toBe(res.skippedCount === 0);

          // 每个工作区目录都出现在明细里
          expect(res.byWorkspace.map((w) => w.dirName).sort()).toEqual(
            wss.map((_, i) => workspaceDirName(i)).sort()
          );

          for (const [i, ws] of wss.entries()) {
            const info = res.byWorkspace.find((w) => w.dirName === workspaceDirName(i));
            expect(info).toBeDefined();
            const seen = info!.sessions.map((s) => s.sessionId);

            // sessions.json 不被当作会话记录（即使某会话恰好叫 sessions）
            expect(seen).not.toContain(MANIFEST_ID);
            // 会话记录恒等于该目录的 SessionFile 集合（去掉清单文件）
            expect(seen.slice().sort()).toEqual(
              ws.files.map(([id]) => id).filter((id) => id !== MANIFEST_ID).sort()
            );
            // 但清单文件的字节数仍计入目录合计
            expect(info!.sessionBytes).toBe(directFileBytes(info!.dirPath));
            // 明细里的会话恒是 ids 的子集
            for (const id of seen) expect(res.ids.has(id)).toBe(true);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

/* ------------------------------------------------------------------ *
 * Property 9
 * ------------------------------------------------------------------ */

/**
 * 存档归因池：前三个 id 与 `LIVE_ID_POOL` 重叠，后两个恒不可能出现在任何
 * LiveSessionIds 里，使随机夹具同时覆盖「有主」与「主已消失」两类存档。
 */
const ARCHIVE_OWNER_POOL = ['s1', 's2', 's3', 'ghost1', 'ghost2'] as const;

/** LiveSessionIds 取自这个池：与存档池部分重叠，故孤儿集合不会恒空也不会恒满。 */
const LIVE_ID_POOL = ['s1', 's2', 's3', 's9'] as const;

/**
 * `chatSessionId` 生成器：覆盖正常值 / `null` / 空串 / 纯空白（空格、制表、换行）。
 * 后三类都属于「无归因」，必须落入孤儿集合——纯空白尤其容易被 `!id` 之类的判断漏掉。
 */
const chatSessionIdArb: fc.Arbitrary<string | null> = fc.oneof(
  { weight: 6, arbitrary: fc.constantFrom(...ARCHIVE_OWNER_POOL) },
  { weight: 1, arbitrary: fc.constant(null) },
  { weight: 1, arbitrary: fc.constant('') },
  { weight: 2, arbitrary: fc.constantFrom(' ', '\t', '   ', ' \n\t ') }
);

/** `size` 生成器：正常值 / 0 / NaN / 负数，后两类按 0 计但仍算一个孤儿文件。 */
const archiveSizeArb: fc.Arbitrary<number> = fc.oneof(
  { weight: 6, arbitrary: fc.integer({ min: 1, max: 1_000_000 }) },
  { weight: 1, arbitrary: fc.constant(0) },
  { weight: 1, arbitrary: fc.constant(Number.NaN) },
  { weight: 1, arbitrary: fc.integer({ min: -1_000_000, max: -1 }) }
);

/** 存档集合：`path` / `name` 按下标生成保证唯一，判定本身与其取值无关。 */
const archivesArb: fc.Arbitrary<ArchiveInfo[]> = fc
  .array(fc.record({ chatSessionId: chatSessionIdArb, size: archiveSizeArb }), {
    maxLength: 12,
  })
  .map((items) =>
    items.map((it, i) => ({
      path: path.join('C:', 'store', 'ws', 'saves', `a${i}`),
      name: `a${i}`,
      size: it.size,
      chatSessionId: it.chatSessionId,
    }))
  );

/** `ids` 覆盖空集与非空集（空集是 unknown 分支的唯一入口）。 */
const liveIdsArb: fc.Arbitrary<Set<string>> = fc
  .uniqueArray(fc.constantFrom(...LIVE_ID_POOL), { maxLength: LIVE_ID_POOL.length })
  .map((ids) => new Set(ids));

/**
 * 测试侧独立实现的孤儿集合：**不复用**实现的 `hasOwner`，而是按需求原文重写
 * 「`chatSessionId` 缺失或不属于 `ids`」这个判据，否则实现与断言会一起犯同一个错。
 */
function expectedOrphans(
  archives: readonly ArchiveInfo[],
  ids: ReadonlySet<string>
): { paths: string[]; bytes: number; files: number } {
  const paths: string[] = [];
  let bytes = 0;
  for (const a of archives) {
    const id = a.chatSessionId;
    const attributable = typeof id === 'string' && id.trim().length > 0 && ids.has(id);
    if (attributable) continue;
    paths.push(a.path);
    bytes += Number.isFinite(a.size) && a.size > 0 ? a.size : 0;
  }
  return { paths, bytes, files: paths.length };
}

// Feature: storage-usage-analytics, Property 9: 孤儿判定的状态与集合
// Validates: Requirements 3.2, 3.3, 3.4, 3.5
describe('Property 9: 孤儿判定的状态与集合', () => {
  it('Property 9: 三级短路的状态恒定，ok 态合计恒等于「无归因或归因不在 ids」的存档合计', () => {
    fc.assert(
      fc.property(archivesArb, liveIdsArb, fc.boolean(), (archives, ids, complete) => {
        const res = computeOrphans(archives, { ids, complete });

        // note 在三态下恒为同一段固定文案（内容由示例测试细查）
        expect(res.note).toBe(ORPHAN_NOTE);
        // 合计恒为有限非负数，且文件数恒不超过存档总数
        expect(Number.isFinite(res.bytes)).toBe(true);
        expect(res.bytes).toBeGreaterThanOrEqual(0);
        expect(res.files).toBeGreaterThanOrEqual(0);
        expect(res.files).toBeLessThanOrEqual(archives.length);

        if (!complete) {
          // Req 3.2：LiveSessionIds 不完整时不判定任何存档
          expect(res.state).toBe('pending');
          expect(res.bytes).toBe(0);
          expect(res.files).toBe(0);
          return;
        }

        if (ids.size === 0) {
          // Req 3.5：无可用现存会话集合时不把全部存档判为孤儿
          expect(res.state).toBe('unknown');
          expect(res.bytes).toBe(0);
          expect(res.files).toBe(0);
          return;
        }

        // Req 3.3、3.4：其余情形逐条判定并给出字节数与文件数合计
        const expected = expectedOrphans(archives, ids);
        expect(res.state).toBe('ok');
        expect(res.files).toBe(expected.files);
        expect(res.bytes).toBe(expected.bytes);
      }),
      { numRuns: 100 }
    );
  });
});
