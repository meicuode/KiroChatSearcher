import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import * as path from 'path';
import {
  listRecentSessionsInLayout,
  searchSessionsInLayout,
  type LayoutSessionDirs,
  type LayoutSources,
  type SearchHit,
  type SessionEntry,
  type SessionRecord,
  type SessionSource,
  type SessionSourceKind,
} from '../src/search';
import {
  __clearMigrationMarkerCacheForTest,
  determineSessionOrigin,
} from '../src/session/origin';
import type { StorageLayout } from '../src/layout';
import type { SessionOrigin } from '../src/storage/types';
import { mkMigrationMarker, mkTempDir, rmTempDir } from './_helpers';

/**
 * 双源合并去重与来源判定的属性测试（design.md 的 Property 9、Property 10）。
 *
 * 与 `search.dual.spec.ts` 的分工：那边用具体夹具把口径钉死（哪种布局读哪一侧、
 * 截断到几条、过滤语义），这边在随机输入空间上锁定两条**普遍性**结论。
 *
 * 取数一律走注入的**内存假源**（`LayoutSources.newSource` / `oldSource`）：这两条属性
 * 关心的是流水线的合并/去重/判定，与「一条会话怎么从磁盘读出来」无关，用内存源既能
 * 让 100 次运行的输入空间铺得开（两侧 sessionId 的交/并/空集 × 三种布局 × mtime 相等），
 * 又不必为每次运行建几十个目录。
 *
 * **唯一必须落真实磁盘的是 MigrationMarker**：`collectMigratedSessionIds` 在
 * `collectAcross` 内部用真实 `fs` 读旧目录里的 `._migration-<uuid>.json`，没有注入点。
 * 因此旧侧目录用真实临时目录，里面**只**放标记文件（会话本身仍由假源提供）；
 * 某次运行不需要标记时，旧侧目录指向一个不存在的路径（`readdir` 失败被吞掉，
 * 语义等价于「没有标记」），这一档零 IO。
 */

/** 修改时间基准；各会话的 mtime 一律以它加档位偏移表达 */
const BASE = Date.parse('2026-09-01T00:00:00.000Z');

/** 所有会话标题都含它，故关键词搜索恒命中标题，两个入口的结果集可直接对拍 */
const KEYWORD = 'kw';

/** 取一个远大于会话数上限的 limit：这两条属性要求「覆盖全部被枚举会话」，不能被截断干扰 */
const LIMIT = 100;

/** 写进 MigrationMarker 的 `v1WorkspaceDirectory`（本文件不关心它的值） */
const WS_PATH = process.platform === 'win32' ? 'd:\\ws' : '/ws';

/** 一个会话在双源中的存在形态 */
type Side = 'new' | 'old' | 'both';

/** 三种被测布局（`none` 不启用任何来源，不属于这两条属性的输入空间） */
const LAYOUTS: readonly StorageLayout[] = ['both', 'new-only', 'old-only'];

/* ------------------------------------------------------------------ *
 * 临时目录：整个文件共用一个基目录，每次运行取一个独立子目录
 * ------------------------------------------------------------------ */

let baseTmp: string | null = null;
let runSeq = 0;

function tmpRoot(): string {
  if (!baseTmp) baseTmp = mkTempDir('kcs-search-dual-prop-');
  return baseTmp;
}

afterEach(() => {
  // 标记缓存按路径键缓存，且不带 (mtimeMs, size) 失效判据（标记文件一次写入不再改动），
  // 故临时目录被回收后必须清掉，避免跨用例串扰
  __clearMigrationMarkerCacheForTest();
  if (baseTmp) {
    rmTempDir(baseTmp);
    baseTmp = null;
  }
  runSeq = 0;
});

/* ------------------------------------------------------------------ *
 * 内存假源
 * ------------------------------------------------------------------ */

/** 记录假源被驱动的情况，用于断言「补字段只发给属于自己那一侧的结果」 */
interface SourceProbe {
  /** 被 `listEntries` 枚举过的目录 */
  listed: string[];
  /** 被 `decorateHits` 收到的 sessionId */
  decorated: string[];
}

function newProbe(): SourceProbe {
  return { listed: [], decorated: [] };
}

/**
 * 一个内存 SessionSource：枚举与读取都来自给定的记录数组，不碰磁盘。
 *
 * `listEntries` 仍按 `path.join(dir, sessionId)` 造出条目路径（形状与两个真实源一致），
 * 但从不读它；`readSession` 按 sessionId 查表。
 */
function memorySource(
  kind: SessionSourceKind,
  records: readonly SessionRecord[],
  probe: SourceProbe
): SessionSource {
  const byId = new Map(records.map((r) => [r.sessionId, r]));
  return {
    kind,
    listEntries(dir: string): SessionEntry[] | null {
      probe.listed.push(dir);
      return records.map((r) => ({ sessionId: r.sessionId, path: path.join(dir, r.sessionId) }));
    },
    readSession(entry: SessionEntry): SessionRecord | null {
      return byId.get(entry.sessionId) ?? null;
    },
    decorateHits(_dir: string, hits: SearchHit[]): void {
      for (const h of hits) probe.decorated.push(h.sessionId);
    },
  };
}

/**
 * 造一条会话记录。`tag` 标出它来自哪一侧，因此「双份留了哪一份」可以从
 * `title` / `snippet` 上直接读出来，而不必靠 `layout` 字段自证。
 */
function record(sessionId: string, tag: 'new' | 'old', modified: number): SessionRecord {
  return {
    sessionId,
    modified,
    title: `${KEYWORD} ${sessionId} from ${tag}`,
    text: `${KEYWORD} body written by ${tag} for ${sessionId}`,
    firstUserText: `preview from ${tag} for ${sessionId}`,
    hasImage: false,
    hasAttachment: false,
  };
}

/* ------------------------------------------------------------------ *
 * 生成器：一个"世界" = 若干会话计划 + 一种布局
 * ------------------------------------------------------------------ */

/** 单个会话的计划：形态、所在侧、两侧各自的 mtime 档位、旧目录里有无指向它的标记 */
interface Plan {
  /** sessionId 是否带 `sess_` 前缀（1.x 新建形态）；否则为裸 uuid（迁移形态） */
  prefixed: boolean;
  side: Side;
  /** 新侧那份的 mtime 档位（值域刻意窄，制造大量 mtime 相等） */
  newTick: number;
  /** 旧侧那份的 mtime 档位；与 newTick 无关，故旧份可能比新份更新 */
  oldTick: number;
  /** 旧目录里是否存在 `v2SessionId` 指向它的 MigrationMarker */
  marked: boolean;
}

const planArb: fc.Arbitrary<Plan> = fc.record({
  prefixed: fc.boolean(),
  side: fc.constantFrom<Side>('new', 'old', 'both'),
  newTick: fc.integer({ min: 0, max: 3 }),
  oldTick: fc.integer({ min: 0, max: 3 }),
  marked: fc.boolean(),
});

/** 0～6 条会话：空数组覆盖「两侧皆空」，`side` 的组合覆盖交集/并集/单侧 */
const plansArb: fc.Arbitrary<Plan[]> = fc.array(planArb, { maxLength: 6 });

interface World {
  layout: StorageLayout;
  dirs: LayoutSessionDirs;
  sources: LayoutSources;
  /** 按计划顺序展开的 sessionId */
  ids: string[];
  /** 新侧枚举得到的 sessionId */
  newIds: Set<string>;
  /** 旧侧枚举得到的 sessionId */
  oldIds: Set<string>;
  /** 旧目录里有标记指向的 sessionId */
  markedIds: Set<string>;
  /** 该布局是否启用新源 / 旧源 */
  usesNew: boolean;
  usesOld: boolean;
  newProbe: SourceProbe;
  oldProbe: SourceProbe;
  /** sessionId → 新侧那份记录 */
  newById: Map<string, SessionRecord>;
  /** sessionId → 旧侧那份记录 */
  oldById: Map<string, SessionRecord>;
}

/**
 * 按计划造出一个世界。
 *
 * sessionId 由下标派生以保证互不相同：带前缀者形如 `sess_f0e1…-0`，裸 uuid 形如
 * `f0e1…-0`。两侧目录**恒非 null**，实际取哪一侧只由 `layout` 决定（这正是
 * `boundsFor` 的被测点）。
 */
function buildWorld(plans: readonly Plan[], layout: StorageLayout): World {
  const ids = plans.map(
    (p, i) => `${p.prefixed ? 'sess_' : ''}f0e1d2c3-0000-4000-8000-00000000000${i}`
  );

  const newRecords: SessionRecord[] = [];
  const oldRecords: SessionRecord[] = [];
  const markedIds = new Set<string>();
  plans.forEach((p, i) => {
    const id = ids[i];
    if (p.side !== 'old') newRecords.push(record(id, 'new', BASE + p.newTick * 1000));
    if (p.side !== 'new') oldRecords.push(record(id, 'old', BASE + p.oldTick * 1000));
    if (p.marked) markedIds.add(id);
  });

  const seq = runSeq++;
  const newDir = path.join(tmpRoot(), `new-${seq}`);
  // 标记文件是唯一必须真的落盘的东西；一个也没有时给一个不存在的目录（零 IO）
  const oldDir = path.join(tmpRoot(), markedIds.size ? `old-${seq}` : `old-absent-${seq}`);
  for (const id of markedIds) mkMigrationMarker(oldDir, id, WS_PATH);

  const probes = { neu: newProbe(), old: newProbe() };

  return {
    layout,
    dirs: { layout, newWorkspaceSessionDir: newDir, oldWorkspaceSessionDir: oldDir },
    sources: {
      newSource: memorySource('new', newRecords, probes.neu),
      oldSource: memorySource('old', oldRecords, probes.old),
    },
    ids,
    newIds: new Set(newRecords.map((r) => r.sessionId)),
    oldIds: new Set(oldRecords.map((r) => r.sessionId)),
    markedIds,
    usesNew: layout === 'both' || layout === 'new-only',
    usesOld: layout === 'both' || layout === 'old-only',
    newProbe: probes.neu,
    oldProbe: probes.old,
    newById: new Map(newRecords.map((r) => [r.sessionId, r])),
    oldById: new Map(oldRecords.map((r) => [r.sessionId, r])),
  };
}

/** 该布局下**应当被枚举**的 sessionId 集合（去重后的期望结果集） */
function expectedIds(w: World): Set<string> {
  const out = new Set<string>();
  if (w.usesNew) for (const id of w.newIds) out.add(id);
  if (w.usesOld) for (const id of w.oldIds) out.add(id);
  return out;
}

/** 该会话的展示来源侧：新侧有就取新侧（Req 13.3 的"以新格式为展示来源"） */
function expectedSide(w: World, id: string): SessionSourceKind {
  return w.usesNew && w.newIds.has(id) ? 'new' : 'old';
}

/**
 * 由需求条文手写的期望 SessionOrigin（**不调用被测的 `determineSessionOrigin`**，
 * 免得变成同义反复；两者的一致性另有一条断言专门比对）。
 *
 * | 条件 | 取值 | 依据 |
 * | --- | --- | --- |
 * | 另一侧也有同 sessionId 的一份 | `migrated` | Req 9.8 |
 * | 旧目录里有指向它的 MigrationMarker | `migrated` | Req 9.5 |
 * | 读自新目录 + `sess_` 前缀 | `new` | Req 9.2 |
 * | 读自新目录 + 裸 uuid | `migrated` | Req 9.3 |
 * | 读自旧目录且以上皆不成立 | `legacy-unmigrated` | Req 9.4 |
 *
 * 两处「按布局收窄」不是额外规则，而是「事实从哪来」：布局没启用的那一侧既不枚举
 * 会话、也不读它的标记文件，故 `presentInOtherSide` 与 `hasMigrationMarker` 只能在
 * 被启用的一侧成立。标记只存在于旧目录，因此 `new-only` 下恒观测不到。
 */
function originFacts(
  w: World,
  id: string
): { source: SessionSourceKind; presentInOtherSide: boolean; hasMigrationMarker: boolean } {
  const onNew = w.usesNew && w.newIds.has(id);
  const onOld = w.usesOld && w.oldIds.has(id);
  const source = onNew ? 'new' : 'old';
  return {
    source,
    presentInOtherSide: source === 'new' ? onOld : onNew,
    hasMigrationMarker: w.usesOld && w.markedIds.has(id),
  };
}

function expectedOrigin(w: World, id: string): SessionOrigin {
  const { source, presentInOtherSide, hasMigrationMarker } = originFacts(w, id);
  if (presentInOtherSide || hasMigrationMarker) return 'migrated';
  if (source === 'new') return id.startsWith('sess_') ? 'new' : 'migrated';
  return 'legacy-unmigrated';
}

const idsOf = (hits: readonly SearchHit[]): string[] => hits.map((h) => h.sessionId);

const originsOf = (hits: readonly SearchHit[]): Record<string, SessionOrigin> =>
  Object.fromEntries(hits.map((h) => [h.sessionId, h.origin]));

/** 两个入口共用同一份流水线，故两条属性都在它们**各自**的结果上验证 */
function runBoth(w: World): { recent: SearchHit[]; search: SearchHit[] } {
  return {
    recent: listRecentSessionsInLayout(w.dirs, LIMIT, w.sources),
    search: searchSessionsInLayout(w.dirs, KEYWORD, LIMIT, w.sources),
  };
}

/* ================================================================== *
 * Property 9: 双源合并去重
 * ================================================================== */

describe('双源合并去重（Property 9）', () => {
  // Feature: kiro-1x-storage-adaptation, Property 9: 双源合并去重
  // `both` 布局下同一 sessionId 恒只出现一次，且其 SessionOrigin 恒为 `migrated`。
  // **Validates: Requirements 9.8, 13.3**
  it('Property 9: both 布局下同一 sessionId 恒只出现一次，且其 origin 恒为 migrated', () => {
    fc.assert(
      fc.property(plansArb, (plans) => {
        const w = buildWorld(plans, 'both');
        const dupIds = w.ids.filter((id) => w.newIds.has(id) && w.oldIds.has(id));

        for (const hits of [runBoth(w).recent, runBoth(w).search]) {
          // (a) 一个 sessionId 恒只出现一次（Req 13.3、9.8 的"只展示一次"）
          expect(idsOf(hits)).toEqual([...new Set(idsOf(hits))]);
          // (b) 合并出的是两侧的并集，一条不多一条不少（Req 13.1）
          expect(new Set(idsOf(hits))).toEqual(expectedIds(w));

          for (const id of dupIds) {
            const hit = hits.find((h) => h.sessionId === id);
            expect(hit, `双份会话 ${id} 应出现在合并列表里`).toBeDefined();
            // (c) 双份恒判为 migrated（Property 9 的后半句）
            expect(hit!.origin).toBe('migrated');
            // (d) 留下的恒是新格式那份：`layout` 与内容都取自新侧，
            //     即便旧份的 mtime 更大（生成器允许 oldTick > newTick）
            const fromNew = w.newById.get(id)!;
            expect(hit!.layout).toBe('new');
            expect(hit!.title).toBe(fromNew.title);
            expect(hit!.modified).toBe(fromNew.modified);
            expect(hit!.title).not.toContain('from old');
          }
        }

        // (e) 排序恒非升（截断在排序之后；此处 limit 足够大，只验排序）
        const recent = runBoth(w).recent;
        for (let i = 0; i < recent.length - 1; i++) {
          expect(recent[i].modified).toBeGreaterThanOrEqual(recent[i + 1].modified);
        }
      }),
      { numRuns: 120 }
    );
  });

  // 同一条属性的补充面：去重发生在匹配之前，故被丢弃的旧份既不进结果、也不被补字段
  it('Property 9: 被丢弃的旧份不参与匹配，也不会被旧源补字段', () => {
    fc.assert(
      fc.property(plansArb, (plans) => {
        const w = buildWorld(plans, 'both');
        const dupIds = new Set(w.ids.filter((id) => w.newIds.has(id) && w.oldIds.has(id)));

        // 只有旧份的正文才含 "written by old"：双份会话恒不应因旧份内容而命中
        const hits = searchSessionsInLayout(w.dirs, 'written by old', LIMIT, w.sources);
        for (const hit of hits) {
          expect(dupIds.has(hit.sessionId)).toBe(false);
          expect(hit.layout).toBe('old');
        }

        // decorateHits 只收到属于自己那一侧的结果，双份会话恒不进旧源的补字段范围
        listRecentSessionsInLayout(w.dirs, LIMIT, w.sources);
        for (const id of w.oldProbe.decorated) expect(dupIds.has(id)).toBe(false);
        for (const id of w.newProbe.decorated) expect(w.newIds.has(id)).toBe(true);
      }),
      { numRuns: 120 }
    );
  });
});

/* ================================================================== *
 * Property 10: 来源判定确定且完备
 * ================================================================== */

describe('来源判定确定且完备（Property 10）', () => {
  const worldArb = fc.tuple(plansArb, fc.constantFrom(...LAYOUTS));

  // Feature: kiro-1x-storage-adaptation, Property 10: 来源判定确定且完备
  // SessionOrigin 恒取三值之一、覆盖全部被枚举会话，且同一磁盘状态下可重复。
  // **Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5, 9.9**
  it('Property 10: origin 恒取三值之一、覆盖全部被枚举会话，且重复调用结果相同', () => {
    fc.assert(
      fc.property(worldArb, ([plans, layout]) => {
        const w = buildWorld(plans, layout);
        const first = runBoth(w);

        for (const hits of [first.recent, first.search]) {
          // (a) 完备性：取值恒落在三值域内（Req 9.1）
          for (const hit of hits) {
            expect(['new', 'migrated', 'legacy-unmigrated']).toContain(hit.origin);
          }
          // (b) 覆盖性：该布局下被枚举的每个会话恰好出现一次并带上 origin
          expect(idsOf(hits).sort()).toEqual([...expectedIds(w)].sort());
          // (c) 判定与需求条文一致（Req 9.2–9.5、9.8）
          for (const hit of hits) {
            expect(hit.origin, `${hit.sessionId} 的 origin`).toBe(expectedOrigin(w, hit.sessionId));
            expect(hit.layout).toBe(expectedSide(w, hit.sessionId));
          }
        }

        // (d) 可重复：磁盘状态未变时重复调用恒得同一取值（Req 9.9）
        const second = runBoth(w);
        expect(originsOf(second.recent)).toEqual(originsOf(first.recent));
        expect(originsOf(second.search)).toEqual(originsOf(first.search));
        // 两个入口共用同一判定，故彼此也恒一致
        expect(originsOf(first.search)).toEqual(originsOf(first.recent));
      }),
      { numRuns: 120 }
    );
  });

  // 判定规则本身：纯函数对同一组事实的产出与需求条文表格逐条吻合
  it('Property 10: determineSessionOrigin 与需求条文的规则表逐条吻合', () => {
    fc.assert(
      fc.property(worldArb, ([plans, layout]) => {
        const w = buildWorld(plans, layout);
        for (const id of expectedIds(w)) {
          expect(determineSessionOrigin({ sessionId: id, ...originFacts(w, id) })).toBe(
            expectedOrigin(w, id)
          );
        }
      }),
      { numRuns: 120 }
    );
  });

  // 三个取值都得真的被生成器打到，否则上面的断言可能只是在空集上成立
  it('Property 10: 生成器确实覆盖三种取值与三种布局', () => {
    const seenOrigins = new Set<SessionOrigin>();
    const seenLayouts = new Set<StorageLayout>();
    fc.assert(
      fc.property(fc.tuple(plansArb, fc.constantFrom(...LAYOUTS)), ([plans, layout]) => {
        const w = buildWorld(plans, layout);
        seenLayouts.add(layout);
        for (const hit of listRecentSessionsInLayout(w.dirs, LIMIT, w.sources)) {
          seenOrigins.add(hit.origin);
        }
      }),
      { numRuns: 120 }
    );
    expect([...seenOrigins].sort()).toEqual(['legacy-unmigrated', 'migrated', 'new']);
    expect([...seenLayouts].sort()).toEqual(['both', 'new-only', 'old-only']);
  });
});
