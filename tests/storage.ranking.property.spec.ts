import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { compareRankingRows, pageOf, RANKING_PAGE_SIZE } from '../src/storage/ranking';
import type { RankingRow, RankingSortOrder } from '../src/storage/types';

// ---------------------------------------------------------------------------
// 排行页属性测试的共享生成器（Property 24 / 25 / 26 共用，按需 export）
// ---------------------------------------------------------------------------

/**
 * 参与比较的三个字段刻意从**很小的池子**里取值：
 * 若用宽范围随机数，两行几乎不会撞上「totalBytes 相等」，
 * tiebreak 与完全性两条断言就会退化为空验证。
 */
export const TOTAL_BYTES_POOL = [0, 1024, 4096] as const;
export const MTIME_MS_POOL = [1_700_000_000_000, 1_700_000_060_000, 1_700_000_120_000] as const;
export const SESSION_ID_POOL = ['s-01', 's-02', 's-03', 's-04', 's-05'] as const;

/** 标题池：覆盖普通 / 空 / 纯空白 / 超长 / 含 HTML 元字符（供 Property 24 复用） */
export const rankingTitleArb: fc.Arbitrary<string> = fc.constantFrom(
  '重构存储模块',
  '',
  '   ',
  'A'.repeat(200),
  '<script>alert("x")</script>',
  'a & b > c < d "q" \'p\''
);

export const sortOrderArb: fc.Arbitrary<RankingSortOrder> = fc.constantFrom('desc', 'asc');

/** 在保持 `totalBytes = jsonBytes + archiveBytesSelf` 的前提下改写 totalBytes */
export function withTotalBytes(row: RankingRow, totalBytes: number): RankingRow {
  const jsonBytes = Math.min(row.jsonBytes, totalBytes);
  return { ...row, jsonBytes, archiveBytesSelf: totalBytes - jsonBytes, totalBytes };
}

/** 单行生成器：totalBytes 恒等于两个分量之和，比较字段取自小池子 */
export const rankingRowArb: fc.Arbitrary<RankingRow> = fc
  .tuple(
    rankingTitleArb,
    fc.constantFrom(...SESSION_ID_POOL),
    fc.constantFrom(...TOTAL_BYTES_POOL),
    fc.constantFrom(...MTIME_MS_POOL),
    fc.double({ min: 0, max: 1, noNaN: true })
  )
  .map(([title, sessionId, totalBytes, mtimeMs, split]) => {
    const jsonBytes = Math.floor(totalBytes * split);
    return {
      title,
      sessionId,
      jsonBytes,
      archiveBytesSelf: totalBytes - jsonBytes,
      totalBytes,
      mtimeMs,
    };
  });

export const rankingRowsArb = (maxLength = 20): fc.Arbitrary<RankingRow[]> =>
  fc.array(rankingRowArb, { maxLength });

/**
 * 成对生成器：显式混入「totalBytes 相等但 mtimeMs 可能不同」与「三字段全等」两类样本，
 * 不依赖池子碰撞的运气，保证 tiebreak / 完全性两条断言真正被触达。
 */
export const rankingRowPairArb: fc.Arbitrary<[RankingRow, RankingRow]> = fc.oneof(
  // 两行完全独立（小池子下仍有相当比例的字段碰撞）
  fc.tuple(rankingRowArb, rankingRowArb),
  // totalBytes 相等，其余字段独立
  fc.tuple(rankingRowArb, rankingRowArb).map(
    ([a, b]) => [a, withTotalBytes(b, a.totalBytes)] as [RankingRow, RankingRow]
  ),
  // totalBytes 相等且 mtimeMs 不同（tiebreak 第一级）
  fc
    .tuple(rankingRowArb, fc.constantFrom(...MTIME_MS_POOL))
    .map(([a, mtimeMs]) => [a, { ...a, mtimeMs }] as [RankingRow, RankingRow]),
  // totalBytes 与 mtimeMs 相等、sessionId 不同（tiebreak 第二级）
  fc
    .tuple(rankingRowArb, fc.constantFrom(...SESSION_ID_POOL))
    .map(([a, sessionId]) => [a, { ...a, sessionId }] as [RankingRow, RankingRow]),
  // 三字段全等（完全性：恒返回 0）
  rankingRowArb.map((a) => [a, { ...a, title: `${a.title}-clone` }] as [RankingRow, RankingRow])
);

const sign = (n: number): number => (n > 0 ? 1 : n < 0 ? -1 : 0);
const keyOf = (r: RankingRow): string => `${r.totalBytes}|${r.mtimeMs}|${r.sessionId}`;

describe('compareRankingRows properties', () => {
  // Feature: storage-usage-analytics, Property 26: 排序比较函数为全序且 tiebreak 不随方向反转
  it('Property 26(a): 反对称 —— sign(cmp(a,b)) === -sign(cmp(b,a))', () => {
    fc.assert(
      fc.property(rankingRowPairArb, sortOrderArb, ([a, b], order) => {
        // 取号后再取负会产出 -0，而 toBe 走 Object.is（-0 ≠ +0），
        // 故先取负再取号：sign(-0) 恒为 +0，比较不受零的符号位干扰。
        expect(sign(compareRankingRows(a, b, order))).toBe(
          sign(-compareRankingRows(b, a, order))
        );
      }),
      { numRuns: 100 }
    );
  });

  // Feature: storage-usage-analytics, Property 26: 排序比较函数为全序且 tiebreak 不随方向反转
  it('Property 26(b): 传递性 —— a≤b 且 b≤c ⇒ a≤c（严格关系同样传递）', () => {
    fc.assert(
      fc.property(rankingRowArb, rankingRowArb, rankingRowArb, sortOrderArb, (a, b, c, order) => {
        const ab = compareRankingRows(a, b, order);
        const bc = compareRankingRows(b, c, order);
        const ac = compareRankingRows(a, c, order);
        if (ab <= 0 && bc <= 0) {
          expect(ac).toBeLessThanOrEqual(0);
        }
        if (ab >= 0 && bc >= 0) {
          expect(ac).toBeGreaterThanOrEqual(0);
        }
        if (ab < 0 && bc < 0) {
          expect(ac).toBeLessThan(0);
        }
      }),
      { numRuns: 100 }
    );
  });

  // Feature: storage-usage-analytics, Property 26: 排序比较函数为全序且 tiebreak 不随方向反转
  it('Property 26(c): 完全性 —— cmp === 0 等价于三字段全等', () => {
    fc.assert(
      fc.property(rankingRowPairArb, sortOrderArb, ([a, b], order) => {
        const allEqual =
          a.totalBytes === b.totalBytes && a.mtimeMs === b.mtimeMs && a.sessionId === b.sessionId;
        expect(compareRankingRows(a, b, order) === 0).toBe(allEqual);
      }),
      { numRuns: 100 }
    );
  });

  // Feature: storage-usage-analytics, Property 26: 排序比较函数为全序且 tiebreak 不随方向反转
  it('Property 26(d): totalBytes 相等时 desc 与 asc 的比较结果恒同号（tiebreak 不反转）', () => {
    fc.assert(
      fc.property(
        fc.tuple(rankingRowArb, rankingRowArb).map(
          ([a, b]) => [a, withTotalBytes(b, a.totalBytes)] as [RankingRow, RankingRow]
        ),
        ([a, b]) => {
          expect(a.totalBytes).toBe(b.totalBytes);
          const desc = compareRankingRows(a, b, 'desc');
          const asc = compareRankingRows(a, b, 'asc');
          expect(sign(desc)).toBe(sign(asc));
          // tiebreak 语义：mtime 降序 → sessionId 字典序升序
          if (a.mtimeMs !== b.mtimeMs) {
            expect(sign(desc)).toBe(a.mtimeMs > b.mtimeMs ? -1 : 1);
          } else if (a.sessionId !== b.sessionId) {
            expect(sign(desc)).toBe(a.sessionId < b.sessionId ? -1 : 1);
          } else {
            expect(desc).toBe(0);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  // Feature: storage-usage-analytics, Property 26: 排序比较函数为全序且 tiebreak 不随方向反转
  it('Property 26(e): 全序 ⇒ 同一输入的排序结果唯一（打乱后重排序列相同）', () => {
    fc.assert(
      fc.property(rankingRowsArb(20), sortOrderArb, (rows, order) => {
        const cmp = (x: RankingRow, y: RankingRow) => compareRankingRows(x, y, order);
        const first = [...rows].sort(cmp).map(keyOf);
        // 先打乱（反转 + 轮转）再排，全序保证结果与初次一致
        const shuffled = [...rows].reverse();
        if (shuffled.length > 1) {
          shuffled.push(shuffled.shift()!);
        }
        const second = shuffled.sort(cmp).map(keyOf);
        expect(second).toEqual(first);
      }),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 25 专用生成器
// ---------------------------------------------------------------------------

/**
 * 行集合生成器：必须能**跨过 50 的分页边界**，否则「切片 / 各页并集 / 页内 ≤ 50」
 * 三条断言全部退化成「只有第 1 页」的空验证。
 * 因此显式混入 0 / 1 / 49 / 50 / 51 / 100 / 101 这几个边界长度，
 * 再加一段 51..120 的随机长度覆盖中间地带。
 */
const fixedLengthRowsArb = (n: number): fc.Arbitrary<RankingRow[]> =>
  fc.array(rankingRowArb, { minLength: n, maxLength: n });

const pagedRowsArb: fc.Arbitrary<RankingRow[]> = fc.oneof(
  fixedLengthRowsArb(0),
  fixedLengthRowsArb(1),
  fixedLengthRowsArb(RANKING_PAGE_SIZE - 1),
  fixedLengthRowsArb(RANKING_PAGE_SIZE),
  fixedLengthRowsArb(RANKING_PAGE_SIZE + 1),
  fixedLengthRowsArb(RANKING_PAGE_SIZE * 2),
  fixedLengthRowsArb(RANKING_PAGE_SIZE * 2 + 1),
  rankingRowsArb(120),
  fc.array(rankingRowArb, { minLength: RANKING_PAGE_SIZE + 1, maxLength: 120 })
);

/**
 * 页码生成器：混入脏值与越界值，逐条对应 `pageOf` 的归一规则
 * （非有限值 → 1；非整数先 `Math.floor`；再 clamp 到 `[1, totalPages]`）。
 */
const pageArb: fc.Arbitrary<number> = fc.oneof(
  fc.integer({ min: -5, max: 12 }),
  fc.constantFrom(NaN, Infinity, -Infinity, 0, -0, 1.9, -0.5, 2.5, 3.999),
  fc.integer({ min: 1, max: 1000 })
);

/** 行的完整身份（含 title）：用于多重集比较，不能省字段 */
const rowKey = (r: RankingRow): string =>
  JSON.stringify([r.title, r.sessionId, r.jsonBytes, r.archiveBytesSelf, r.totalBytes, r.mtimeMs]);

/** 多重集计数：`rankingRowArb` 的池子很小，三字段全等的重复行会真实出现，故不能用 Set */
const multiset = (rows: readonly RankingRow[]): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const k = rowKey(row);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
};

const sortedByOrder = (rows: readonly RankingRow[], order: RankingSortOrder): RankingRow[] =>
  [...rows].sort((a, b) => compareRankingRows(a, b, order));

describe('pageOf properties', () => {
  // Feature: storage-usage-analytics, Property 25: 分页恒为全量排序序列的切片
  it('Property 25(a): totalPages === max(1, ceil(K / 50))、total === K、1 ≤ page ≤ totalPages', () => {
    fc.assert(
      fc.property(pagedRowsArb, sortOrderArb, pageArb, (rows, order, page) => {
        const result = pageOf(rows, order, page);
        expect(result.total).toBe(rows.length);
        expect(result.totalPages).toBe(
          Math.max(1, Math.ceil(rows.length / RANKING_PAGE_SIZE))
        );
        // K = 0 时空态仍展示「第 1 / 1 页」，totalPages 不得为 0
        if (rows.length === 0) {
          expect(result.totalPages).toBe(1);
          expect(result.rows).toEqual([]);
        }
        expect(Number.isInteger(result.page)).toBe(true);
        expect(result.page).toBeGreaterThanOrEqual(1);
        expect(result.page).toBeLessThanOrEqual(result.totalPages);
      }),
      { numRuns: 100 }
    );
  });

  // Feature: storage-usage-analytics, Property 25: 分页恒为全量排序序列的切片
  it('Property 25(b): 第 M 页恒等于全量排序序列的 [(M-1)*50, M*50) 切片且长度 ≤ 50', () => {
    fc.assert(
      fc.property(pagedRowsArb, sortOrderArb, pageArb, (rows, order, page) => {
        const result = pageOf(rows, order, page);
        const sorted = sortedByOrder(rows, order);
        const start = (result.page - 1) * RANKING_PAGE_SIZE;
        expect(result.rows).toEqual(sorted.slice(start, start + RANKING_PAGE_SIZE));
        expect(result.rows.length).toBeLessThanOrEqual(RANKING_PAGE_SIZE);
        // 除最后一页外，页内条目数恒为满页
        if (result.page < result.totalPages) {
          expect(result.rows.length).toBe(RANKING_PAGE_SIZE);
        }
      }),
      { numRuns: 100 }
    );
  });

  // Feature: storage-usage-analytics, Property 25: 分页恒为全量排序序列的切片
  it('Property 25(c): 1..N 各页的并集恒等于全量行集合（多重集）且两两不相交', () => {
    fc.assert(
      fc.property(pagedRowsArb, sortOrderArb, (rows, order) => {
        const { totalPages } = pageOf(rows, order, 1);
        const collected: RankingRow[] = [];
        for (let m = 1; m <= totalPages; m += 1) {
          collected.push(...pageOf(rows, order, m).rows);
        }
        // 拼接后的长度恒等于全量长度 ⇒ 各页两两不相交（无任何行被重复投放）
        expect(collected.length).toBe(rows.length);
        // 拼接后的多重集恒等于全量多重集 ⇒ 并集完整且不多不少
        expect(multiset(collected)).toEqual(multiset(rows));
        // 顺序也完整：逐页拼接恒还原整条排序序列
        expect(collected).toEqual(sortedByOrder(rows, order));
      }),
      { numRuns: 100 }
    );
  });

  // Feature: storage-usage-analytics, Property 25: 分页恒为全量排序序列的切片
  it('Property 25(d): 行数减少后当前页恒为 min(M, N)（clamp 归一，Requirement 13.17）', () => {
    fc.assert(
      fc.property(
        pagedRowsArb.chain((rows) => fc.tuple(fc.constant(rows), fc.subarray(rows))),
        sortOrderArb,
        pageArb,
        ([rows, remaining], order, page) => {
          // M：清理前归一后的当前页码
          const before = pageOf(rows, order, page);
          const after = pageOf(remaining, order, before.page);
          const expectedTotalPages = Math.max(
            1,
            Math.ceil(remaining.length / RANKING_PAGE_SIZE)
          );
          expect(after.totalPages).toBe(expectedTotalPages);
          expect(after.page).toBe(Math.min(before.page, expectedTotalPages));
          // 归一后的页恒非空（除全部行被清空的情况）
          if (remaining.length > 0) {
            expect(after.rows.length).toBeGreaterThan(0);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  // Feature: storage-usage-analytics, Property 25: 分页恒为全量排序序列的切片
  it('Property 25(e): 换序后传入 page=1 恒落在第 1 页（RankingPanel 的重置约定）', () => {
    fc.assert(
      fc.property(pagedRowsArb, sortOrderArb, sortOrderArb, (rows, from, to) => {
        // `pageOf` 无状态，"切换 RankingSortOrder 后当前页恒为 1"（Requirement 13.8）
        // 是**调用方约定**：换序时传 `page: 1`。该重置动作属 RankingPanel 行为，
        // 由任务 16.4 实现、示例测试在任务 16.6 覆盖；这里只断言 `pageOf` 能保证的那半：
        // 无论换到哪个方向，传入 1 恒得到第 1 页，且它恒是新序下的首个 50 条切片。
        void from;
        const result = pageOf(rows, to, 1);
        expect(result.page).toBe(1);
        expect(result.rows).toEqual(sortedByOrder(rows, to).slice(0, RANKING_PAGE_SIZE));
      }),
      { numRuns: 100 }
    );
  });

  // Feature: storage-usage-analytics, Property 25: 分页恒为全量排序序列的切片
  it('Property 25(f): pageOf / compareRankingRows 恒为纯函数：结果可复现、入参不被改动', () => {
    fc.assert(
      fc.property(pagedRowsArb, sortOrderArb, pageArb, (rows, order, page) => {
        // 纯函数性质（零 IO 的可观察证据）：同输入多次调用结果恒相同、且不改动入参数组。
        // 直接断言「模块不含 fs import」并不可靠——同模块的 `collectRankingRows`
        // 依赖只读 fs（readdir / stat / readFile），断言整模块无 fs 必然误报。
        const snapshot = rows.map((r) => ({ ...r }));
        const first = pageOf(rows, order, page);
        const second = pageOf(rows, order, page);

        expect(second).toEqual(first);
        expect(second.rows).not.toBe(first.rows);
        // 入参数组既未被重排也未被逐项改写（`pageOf` 对副本排序）
        expect(rows).toEqual(snapshot);
        // 返回的切片是新数组：调用方改动它不会回写到入参
        first.rows.reverse();
        expect(rows).toEqual(snapshot);
        expect(pageOf(rows, order, page)).toEqual(second);

        // 比较函数同样可复现：同一对行任意次调用结果恒相同
        if (rows.length >= 2) {
          const [a, b] = rows;
          expect(compareRankingRows(a, b, order)).toBe(compareRankingRows(a, b, order));
        }
      }),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 24: 排行页取数与行渲染
// Validates: Requirements 13.2, 13.3, 13.10, 13.13
// ---------------------------------------------------------------------------

import * as path from 'path';
import {
  collectRankingRows,
  renderRankingRowHtml,
  rankingTitleCell,
  formatRankingTime,
  RANKING_TITLE_MAX_CHARS,
  RANKING_TITLE_PLACEHOLDER,
} from '../src/storage/ranking';
import { escapeHtml } from '../src/webview/format';
import { formatSize } from '../src/webview/size';
import type { ArchiveInfo } from '../src/credits';

/** 与实现一致的字节数归一：非有限值 / 负数按 0 计。 */
const safeSize = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0);

/* ------------------------------------------------------------------ *
 * 取数半：内存目录 + 可注入 RankingFsDeps
 * ------------------------------------------------------------------ */

const MEM_DIR = path.join('/mem', 'sessionDir');

interface MemEntry {
  name: string;
  kind: 'file' | 'dir';
  size: number;
  mtimeMs: number;
  content?: string;
}

/** 用内存目录搭出一个只读 RankingFsDeps（按文件名的 basename 定位条目）。 */
function makeRankingDeps(entries: MemEntry[]): {
  readdir: (p: string, o: { withFileTypes: true }) => Promise<
    Array<{ name: string; isDirectory(): boolean; isSymbolicLink(): boolean; isFile(): boolean }>
  >;
  stat: (
    p: string
  ) => Promise<{ size: number; mtimeMs: number; isDirectory(): boolean; isSymbolicLink(): boolean }>;
  readFile: (p: string, enc: 'utf8') => Promise<string>;
} {
  const byName = new Map(entries.map((e) => [e.name, e]));
  return {
    readdir: async (p) => {
      if (p !== MEM_DIR) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return entries.map((e) => ({
        name: e.name,
        isDirectory: () => e.kind === 'dir',
        isSymbolicLink: () => false,
        isFile: () => e.kind === 'file',
      }));
    },
    stat: async (p) => {
      const e = byName.get(path.basename(p));
      if (!e) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return {
        size: e.size,
        mtimeMs: e.mtimeMs,
        isDirectory: () => e.kind === 'dir',
        isSymbolicLink: () => false,
      };
    },
    readFile: async (p) => {
      const e = byName.get(path.basename(p));
      if (!e || e.content === undefined) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      return e.content;
    },
  };
}

/** 字节数生成器：正常值 / 0 / NaN / 负数（后两类恒按 0 计）。 */
const fetchSizeArb: fc.Arbitrary<number> = fc.oneof(
  fc.integer({ min: 1, max: 5_000_000 }),
  fc.constant(0),
  fc.constant(Number.NaN),
  fc.integer({ min: -5000, max: -1 })
);

/** mtime 生成器：正常时间戳 / 0 / NaN（NaN 恒归一为 0）。 */
const fetchMtimeArb: fc.Arbitrary<number> = fc.oneof(
  fc.integer({ min: 0, max: 2_000_000_000_000 }),
  fc.constant(0),
  fc.constant(Number.NaN)
);

/**
 * 目录夹具生成器：会话数覆盖跨 50 分页边界（maxLength 60），并混入清单 / 子目录 /
 * 非 .json 文件三类**不应计为会话**的条目。archives 引用同一 id 空间（含 ghost），
 * 使 self 口径归因既非恒空也非恒满。
 */
const dirFixtureArb = fc.record({
  sessions: fc.uniqueArray(fc.tuple(fc.integer({ min: 0, max: 130 }), fetchSizeArb, fetchMtimeArb), {
    selector: (t) => t[0],
    maxLength: 60,
  }),
  hasManifest: fc.boolean(),
  hasSubdir: fc.boolean(),
  hasTxt: fc.boolean(),
  archives: fc.array(
    fc.record({
      n: fc.oneof(fc.integer({ min: 0, max: 130 }), fc.constant(-1)),
      size: fetchSizeArb,
    }),
    { maxLength: 20 }
  ),
});

describe('collectRankingRows properties', () => {
  // Feature: storage-usage-analytics, Property 24: 排行页取数与行渲染
  it('Property 24(fetch): sessionId 集合恒等于目录全部 SessionFile（不截断），totalBytes = jsonBytes + archiveBytesSelf，mtime 取自 stat', async () => {
    await fc.assert(
      fc.asyncProperty(dirFixtureArb, async (fx) => {
        const entries: MemEntry[] = fx.sessions.map(([n, size, mtimeMs]) => ({
          name: `s-${n}.json`,
          kind: 'file',
          size,
          mtimeMs,
          content: '{}',
        }));
        if (fx.hasManifest) {
          entries.push({ name: 'sessions.json', kind: 'file', size: 10, mtimeMs: 1, content: '[]' });
        }
        if (fx.hasSubdir) entries.push({ name: 'nested', kind: 'dir', size: 0, mtimeMs: 1 });
        if (fx.hasTxt) {
          entries.push({ name: 'notes.txt', kind: 'file', size: 5, mtimeMs: 1, content: 'x' });
        }

        const archives: ArchiveInfo[] = fx.archives.map((a, i) => ({
          path: path.join('C:', 'store', 'saves', `a${i}`),
          name: `a${i}`,
          size: a.size,
          chatSessionId: a.n >= 0 ? `s-${a.n}` : 'ghost',
        }));

        const res = await collectRankingRows(
          { sessionDir: MEM_DIR, storeRoot: '', workspacePath: '', archives },
          makeRankingDeps(entries)
        );

        // 全部可读，无跳过（数值精确，不置 partial）
        expect(res.skippedCount).toBe(0);

        // sessionId 集合恒等于目录下全部 SessionFile（清单 / 子目录 / 非 .json 不计入），
        // 且不受 50 条分页边界截断：行数恒等于会话文件数
        const expectedIds = fx.sessions.map(([n]) => `s-${n}`).sort();
        expect(res.rows.map((r) => r.sessionId).sort()).toEqual(expectedIds);
        expect(res.rows.length).toBe(fx.sessions.length);

        const bySid = new Map(fx.sessions.map(([n, size, mtimeMs]) => [`s-${n}`, { size, mtimeMs }]));
        for (const row of res.rows) {
          const src = bySid.get(row.sessionId)!;
          // jsonBytes 恒取自该 SessionFile 自身 stat（归一后）
          expect(row.jsonBytes).toBe(safeSize(src.size));
          // archiveBytesSelf 恒为自身口径归因：chatSessionId 精确等于该 sessionId 的存档之和
          const expectedArchiveSelf = archives
            .filter((a) => a.chatSessionId === row.sessionId)
            .reduce((s, a) => s + safeSize(a.size), 0);
          expect(row.archiveBytesSelf).toBe(expectedArchiveSelf);
          // totalBytes 构造性成立
          expect(row.totalBytes).toBe(row.jsonBytes + row.archiveBytesSelf);
          // mtimeMs 恒取自 stat（NaN 归一为 0）
          expect(row.mtimeMs).toBe(Number.isFinite(src.mtimeMs) ? src.mtimeMs : 0);
        }
      }),
      { numRuns: 100 }
    );
  });
});

/* ------------------------------------------------------------------ *
 * 渲染半：单行 RankingRow → <tr>
 * ------------------------------------------------------------------ */

/** sessionId 生成器：覆盖普通值与含 `<` / `>` / `&` / 单双引号的样本（转义完整性）。 */
const htmlMetaSessionIdArb: fc.Arbitrary<string> = fc.constantFrom(
  's-01',
  '<img src=x onerror=alert(1)>',
  'a & b',
  'q"uote',
  "ap'os",
  '<>&"\''
);

/**
 * mtime 生成器：正常时间戳（覆盖到 ~ 公元 3000 年的宽区间）+ 脏值 sentinel。
 *
 * 上界刻意停在 ~ 公元 3000 年而非 formatRankingTime 的钳制上界（9999-12-31 UTC）：
 * 真实 stat 的 mtime 落在这个宽区间内，而钳制上界在 UTC+ 时区会把年份进位到 10000
 * （本地时间跨过公元 10000）——那是钳制口径按 UTC、格式化按本地时区的边界效应，
 * 与「最后修改时间恒形如 YYYY-MM-DD HH:mm」这条针对真实时间戳的性质无关。
 * NaN 与负数走归一分支（钳到 epoch），验证脏值恒不退化成 Invalid Date / 负年份。
 */
const renderMtimeArb: fc.Arbitrary<number> = fc.oneof(
  fc.constantFrom(...MTIME_MS_POOL),
  fc.integer({ min: 0, max: 32503680000000 }),
  fc.constant(Number.NaN),
  fc.constant(-1000)
);

/** 单行生成器：标题复用 rankingTitleArb（含空白/超长/HTML 元字符），sessionId 含元字符 */
const renderRowArb: fc.Arbitrary<RankingRow> = fc
  .tuple(
    rankingTitleArb,
    htmlMetaSessionIdArb,
    fc.constantFrom(...TOTAL_BYTES_POOL),
    renderMtimeArb,
    fc.double({ min: 0, max: 1, noNaN: true })
  )
  .map(([title, sessionId, totalBytes, mtimeMs, split]) => {
    const jsonBytes = Math.floor(totalBytes * split);
    return { title, sessionId, jsonBytes, archiveBytesSelf: totalBytes - jsonBytes, totalBytes, mtimeMs };
  });

const TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

describe('renderRankingRowHtml properties', () => {
  // Feature: storage-usage-analytics, Property 24: 排行页取数与行渲染
  it('Property 24(render): 六列俱全、空白标题占位、120 截断 + title 属性含完整标题、时间格式、HTML 转义、partial 只影响两列', () => {
    fc.assert(
      fc.property(renderRowArb, fc.boolean(), (row, partial) => {
        const html = renderRankingRowHtml(row, partial);

        // 六列信息俱全（会话标题 / sessionId / JSON / 归因存档 / 占用合计 / 最后修改）+ 操作列
        expect(html).toContain('class="c-title"');
        expect(html).toContain('class="c-id"');
        expect(html).toContain('class="c-time"');
        expect(html).toContain('class="c-num c-total"');
        expect(html).toContain('class="c-ops"');
        // JSON 与归因存档两列恰好是两个 `c-num`（合计列另带 c-total）
        expect((html.match(/<td class="c-num">/g) || []).length).toBe(2);

        // 标题占位 / 截断（用 rankingTitleCell 作独立参照，避免与实现同构比对）
        const cell = rankingTitleCell(row.title);
        if (row.title.trim() === '') {
          expect(cell.text).toBe(RANKING_TITLE_PLACEHOLDER);
          expect(html).toContain('<span class="t">' + RANKING_TITLE_PLACEHOLDER + '</span>');
        }
        if (row.title.length > RANKING_TITLE_MAX_CHARS) {
          // 前 120 字符 + 省略号（共 121 个字符），完整标题另存于 title 属性
          expect(cell.truncated).toBe(true);
          expect(cell.text.length).toBe(RANKING_TITLE_MAX_CHARS + 1);
          expect(cell.text.endsWith('…')).toBe(true);
          expect(cell.full).toBe(row.title);
          expect(html).toContain('title="' + escapeHtml(row.title) + '"');
        }
        // 展示文本与完整标题（均已转义）恒出现
        expect(html).toContain('<span class="t">' + escapeHtml(cell.text) + '</span>');
        expect(html).toContain('title="' + escapeHtml(cell.full) + '"');

        // 最后修改时间恒形如 YYYY-MM-DD HH:mm
        const time = formatRankingTime(row.mtimeMs);
        expect(time).toMatch(TIME_RE);
        expect(html).toContain('<td class="c-time">' + time + '</td>');

        // HTML 转义：动态文本恒不出现未转义的 `<` 开始的标签
        expect(html).not.toContain('<script');
        expect(html).not.toContain('<img');
        // 含元字符的原始动态文本恒不以未转义形态出现（已被 escapeHtml 改写）
        if (/[<>&"']/.test(row.title)) expect(html).not.toContain(row.title);
        if (/[<>&"']/.test(row.sessionId)) expect(html).not.toContain(row.sessionId);
        // 对应的转义形态恒出现
        expect(html).toContain(escapeHtml(row.sessionId));

        // partial 只影响「归因存档」与「占用合计」两列，恒不影响「会话 JSON」列
        const pfx = partial ? '≥' : '';
        expect(html).toContain('<td class="c-num">' + formatSize(row.jsonBytes) + '</td>');
        expect(html).toContain('<td class="c-num">' + pfx + formatSize(row.archiveBytesSelf) + '</td>');
        expect(html).toContain('<td class="c-num c-total">' + pfx + formatSize(row.totalBytes) + '</td>');
        // ≥ 前缀恒只在 partial 时出现，且恰好两处（两个字节列）
        expect((html.match(/≥/g) || []).length).toBe(partial ? 2 : 0);
      }),
      { numRuns: 100 }
    );
  });
});
