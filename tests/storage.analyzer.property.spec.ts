import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import * as fs from 'fs';
import * as path from 'path';
// hash32 从被测实现之外的既有模块 import：lineage 反查靠 `hash32(executionId) === name`，
// 测试侧要用同一哈希造夹具，并独立重算一遍 credit lineage 闭包做差分验证。
// workspaceIdCandidates / encodeWorkspaceKeys 用于在测试侧独立派生当前工作区在磁盘上的
// 两处落点目录名（Property 2）。
import { hash32, workspaceIdCandidates, type ArchiveInfo } from '../src/credits';
import { computeSessionFootprint, StorageAnalyzer } from '../src/storage/analyzer';
// 归因守恒（Property 5）要同时约束归因侧与孤儿侧，故这里跨模块 import 判定函数：
// 两侧各有一份 `hasOwner` / `safeBytes`，只有放在同一条断言里才能抓到口径漂移。
import { computeOrphans } from '../src/storage/orphan';
import { buildClassifyRoots } from '../src/storage/classify';
import { encodeWorkspaceKeys, type PathResolverDeps } from '../src/paths';
import { mkTempDir, rmTempDir } from './_helpers';

/* ------------------------------------------------------------------ *
 * 共享生成器
 *
 * 本文件承载 design 中划归 analyzer 的多条属性（Property 2/3/4/5/6/7/14(a)/15），
 * 因此生成器与工具集中在顶部并 export，供后续任务追加时复用，避免各自造一套
 * 口径不同的 ArchiveInfo 夹具。
 * ------------------------------------------------------------------ */

/** 存档所在桶目录（Property 3 只关心字节数归因，路径仅需唯一且形态真实） */
export const SAVES_DIR = path.join('C:', 'store', 'ws0', 'saves');

/**
 * sessionId 池：`s1` / `S1` 仅大小写不同，用来钉住「区分大小写严格相等」这一条；
 * 池刻意很小，使随机存档集合高概率同时出现命中与不命中同一会话的条目。
 */
export const SESSION_ID_POOL = ['s1', 'S1', 's2', 'sess-3'] as const;

/** 恒不在 sessionId 池中的 `chatSessionId`，保证「不命中」分支被稳定覆盖 */
export const FOREIGN_SESSION_IDS = ['nobody', 's1x', '1s'] as const;

/** 无归因的 `chatSessionId`：缺失 / 空串 / 纯空白（空格与制表符） */
export const BLANK_CHAT_SESSION_IDS: ReadonlyArray<string | null> = [null, '', '   ', '\t'];

/** 被统计会话的 sessionId */
export const sessionIdArb: fc.Arbitrary<string> = fc.constantFrom(...SESSION_ID_POOL);

/** `chatSessionId`：命中 / 仅大小写不同 / 不命中 / null / 空串 / 纯空白 */
export const chatSessionIdArb: fc.Arbitrary<string | null> = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(...SESSION_ID_POOL) },
  { weight: 1, arbitrary: fc.constantFrom(...FOREIGN_SESSION_IDS) },
  { weight: 1, arbitrary: fc.constantFrom(...BLANK_CHAT_SESSION_IDS) }
);

/** 字节数：正常值 / 0 / NaN / 负数（后三者按 0 计，不得污染合计） */
export const byteSizeArb: fc.Arbitrary<number> = fc.oneof(
  { weight: 4, arbitrary: fc.integer({ min: 1, max: 1 << 20 }) },
  { weight: 1, arbitrary: fc.constant(0) },
  { weight: 1, arbitrary: fc.constant(Number.NaN) },
  { weight: 1, arbitrary: fc.integer({ min: -4096, max: -1 }) }
);

/** 会话 JSON 字节数：与存档字节数同一套异常值覆盖 */
export const jsonBytesArb: fc.Arbitrary<number> = byteSizeArb;

/** 文件名恒为 hex32（`hash32(executionId)` 的形态），按下标生成保证唯一 */
export function archiveName(i: number): string {
  return i.toString(16).padStart(32, '0');
}

/**
 * `ArchiveInfo[]` 生成器：`maxLength` 含 0，故空存档集合被覆盖。
 * `path` / `name` 由下标派生（唯一），`chatSessionId` 与 `size` 覆盖全部分支。
 */
export const archivesArb: fc.Arbitrary<ArchiveInfo[]> = fc
  .array(fc.record({ chatSessionId: chatSessionIdArb, size: byteSizeArb }), { maxLength: 10 })
  .map((items) =>
    items.map((it, i) => ({
      path: path.join(SAVES_DIR, archiveName(i)),
      name: archiveName(i),
      size: it.size,
      chatSessionId: it.chatSessionId,
    }))
  );

/* ------------------------------------------------------------------ *
 * 测试侧独立判据（差分验证用，恒不复用实现的内部函数）
 * ------------------------------------------------------------------ */

/** NaN / 负数按 0 计 */
export function refSafeBytes(size: number): number {
  return Number.isFinite(size) && size > 0 ? size : 0;
}

/** 缺失 / 空串 / 纯空白的 `chatSessionId` 不归因到任何会话 */
export function refHasOwner(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.trim().length > 0;
}

/** 自身口径的匹配集合：`chatSessionId` 区分大小写严格等于 sessionId 且非空白 */
export function refSelfMatches(
  sessionId: string,
  archives: readonly ArchiveInfo[]
): ArchiveInfo[] {
  if (!refHasOwner(sessionId)) return [];
  return archives.filter((a) => refHasOwner(a.chatSessionId) && a.chatSessionId === sessionId);
}

/** 自身口径存档字节数：匹配集合的 `size` 之和 */
export function refSelfArchiveBytes(
  sessionId: string,
  archives: readonly ArchiveInfo[]
): number {
  return refSelfMatches(sessionId, archives).reduce((sum, a) => sum + refSafeBytes(a.size), 0);
}

/* ------------------------------------------------------------------ *
 * Property 3
 * ------------------------------------------------------------------ */

// Feature: storage-usage-analytics, Property 3: 自身口径归因公式
// Validates: Requirements 2.1, 2.8
describe('Property 3: 自身口径归因公式', () => {
  it('Property 3: 自身口径占用恒等于 JSON 字节数 + 严格同 sessionId 的存档字节数之和；匹配集合为空时等于 JSON 字节数且 archivesFound 为 false', () => {
    fc.assert(
      fc.property(sessionIdArb, jsonBytesArb, archivesArb, (sessionId, jsonBytes, archives) => {
        const fp = computeSessionFootprint({ sessionId, jsonBytes, scope: 'self' }, archives);

        // 测试侧独立求和判据
        const matches = refSelfMatches(sessionId, archives);
        const expectedArchiveBytes = refSelfArchiveBytes(sessionId, archives);
        const expectedJsonBytes = refSafeBytes(jsonBytes);

        // (a) 归因公式：两项分别相等，合计等于两项之和
        expect(fp.jsonBytes).toBe(expectedJsonBytes);
        expect(fp.archiveBytes).toBe(expectedArchiveBytes);
        expect(fp.totalBytes).toBe(expectedJsonBytes + expectedArchiveBytes);

        // (b) 字段口径：self 恒可相加，sessionId 与 scope 原样回传
        expect(fp.additive).toBe(true);
        expect(fp.scope).toBe('self');
        expect(fp.sessionId).toBe(sessionId);

        // (c) archivesFound 以「是否命中过存档条目」为准，而非字节数 > 0
        expect(fp.archivesFound).toBe(matches.length > 0);

        // (d) 匹配集合为空（含空存档集合）时占用等于 JSON 字节数本身
        if (matches.length === 0) {
          expect(fp.archiveBytes).toBe(0);
          expect(fp.totalBytes).toBe(expectedJsonBytes);
          expect(fp.archivesFound).toBe(false);
        }

        // (e) 全部由 0 字节存档命中时：字节数为 0 但存档确实找到了
        if (matches.length > 0 && expectedArchiveBytes === 0) {
          expect(fp.archivesFound).toBe(true);
          expect(fp.totalBytes).toBe(expectedJsonBytes);
        }

        // (f) 非法字节数不污染合计：结果恒为有限非负数
        expect(Number.isFinite(fp.totalBytes)).toBe(true);
        expect(fp.totalBytes).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 100 }
    );
  });

  it('Property 3: 归因严格区分大小写——仅大小写不同的 chatSessionId 不被计入', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 4096 }), fc.integer({ min: 1, max: 4096 }), (a, b) => {
        const archives: ArchiveInfo[] = [
          { path: path.join(SAVES_DIR, archiveName(0)), name: archiveName(0), size: a, chatSessionId: 's1' },
          { path: path.join(SAVES_DIR, archiveName(1)), name: archiveName(1), size: b, chatSessionId: 'S1' },
        ];

        const lower = computeSessionFootprint({ sessionId: 's1', jsonBytes: 10, scope: 'self' }, archives);
        const upper = computeSessionFootprint({ sessionId: 'S1', jsonBytes: 10, scope: 'self' }, archives);

        expect(lower.archiveBytes).toBe(a);
        expect(upper.archiveBytes).toBe(b);
        // 两者各自只拿自己那一条，合计恰好等于存档总字节数（不重不漏）
        expect(lower.archiveBytes + upper.archiveBytes).toBe(a + b);
      }),
      { numRuns: 100 }
    );
  });
});

/* ------------------------------------------------------------------ *
 * Property 4 —— 追加生成器与判据
 *
 * lineage 判定要靠 `hash32(executionId) === ArchiveInfo.name` 反查，而
 * `archiveName(i)` 生成的是 `000…0i` 这种人造 hex32，与真实哈希不会相等。
 * 因此这里先取若干 executionId 字符串、用 `hash32` 算出 name 再据此造存档，
 * 保证「命中」分支被真实覆盖，避免差分断言退化为空验证。
 * ------------------------------------------------------------------ */

/** 可被 history 引用的 executionId 池；池很小，使命中与不命中稳定共现 */
export const EXECUTION_ID_POOL = ['exec-0', 'exec-1', 'exec-2', 'exec-3'] as const;

/** 恒不对应任何夹具存档的 executionId（含空串：实现与 credits 侧都应跳过） */
export const FOREIGN_EXECUTION_IDS = ['exec-absent', 'ffff', ''] as const;

/** `historyExecutionIds`：`maxLength` 含 0，故「无 history」被覆盖 */
export const historyExecutionIdsArb: fc.Arbitrary<string[]> = fc.array(
  fc.oneof(
    { weight: 3, arbitrary: fc.constantFrom(...EXECUTION_ID_POOL) },
    { weight: 1, arbitrary: fc.constantFrom(...FOREIGN_EXECUTION_IDS) }
  ),
  { maxLength: 6 }
);

/**
 * 「可被 history 反查命中」的存档：name 恒取 `hash32(EXECUTION_ID_POOL[k])`。
 * 每个池成员各随机决定是否落到夹具里（`include`），故「history 引用了某执行但
 * 该执行的存档不在索引中」这一分支同样被覆盖。
 */
export const linkedArchivesArb: fc.Arbitrary<ArchiveInfo[]> = fc
  .array(
    fc.record({ include: fc.boolean(), chatSessionId: chatSessionIdArb, size: byteSizeArb }),
    { minLength: EXECUTION_ID_POOL.length, maxLength: EXECUTION_ID_POOL.length }
  )
  .map((items) =>
    items
      .map((it, k) => ({ ...it, name: hash32(EXECUTION_ID_POOL[k]) }))
      .filter((it) => it.include)
      .map((it) => ({
        path: path.join(SAVES_DIR, it.name),
        name: it.name,
        size: it.size,
        chatSessionId: it.chatSessionId,
      }))
  );

/** 完整夹具：普通存档（name 恒不被 hash32 命中）+ 可反查存档 + history 引用 */
export const lineageFixtureArb: fc.Arbitrary<{
  archives: ArchiveInfo[];
  historyExecutionIds: string[];
}> = fc
  .tuple(archivesArb, linkedArchivesArb, historyExecutionIdsArb)
  .map(([plain, linked, historyExecutionIds]) => ({
    archives: [...plain, ...linked],
    historyExecutionIds,
  }));

/**
 * 测试侧独立实现的 lineage 闭包：种子 + 经 `hash32(executionId)` 反查 `name`
 * 命中的存档的 `chatSessionId`。**一层并入，不做 parentSessionIds 传递闭包**
 * ——与 `credits.ts` 的 `lineageClosure` 同一规则，用于差分验证。
 */
export function refLineageWanted(
  sessionId: string,
  archives: readonly ArchiveInfo[],
  historyExecutionIds?: readonly string[]
): Set<string> {
  const out = new Set<string>();
  if (refHasOwner(sessionId)) out.add(sessionId);
  const byName = new Map<string, ArchiveInfo>();
  for (const a of archives) byName.set(a.name, a);
  for (const eid of historyExecutionIds ?? []) {
    if (!eid) continue;
    const ent = byName.get(hash32(eid));
    if (ent && refHasOwner(ent.chatSessionId)) out.add(ent.chatSessionId as string);
  }
  return out;
}

/** 归因集合对应的存档（空白 `chatSessionId` 恒不归因） */
export function refMatchesFor(
  wanted: ReadonlySet<string>,
  archives: readonly ArchiveInfo[]
): ArchiveInfo[] {
  return archives.filter(
    (a) => refHasOwner(a.chatSessionId) && wanted.has(a.chatSessionId as string)
  );
}

/** 归因集合对应的存档字节数之和 */
export function refArchiveBytesFor(
  wanted: ReadonlySet<string>,
  archives: readonly ArchiveInfo[]
): number {
  return refMatchesFor(wanted, archives).reduce((sum, a) => sum + refSafeBytes(a.size), 0);
}

/* ------------------------------------------------------------------ *
 * Property 4
 * ------------------------------------------------------------------ */

// Feature: storage-usage-analytics, Property 4: 两种口径的关系与可加性标记
// Validates: Requirements 2.2, 2.4, 2.5
describe('Property 4: 两种口径的关系与可加性标记', () => {
  it('Property 4: lineage 存档部分恒不小于 self，且恒等于既有 credit lineage 判定结果；scope 与 additive 严格对应', () => {
    fc.assert(
      fc.property(
        sessionIdArb,
        jsonBytesArb,
        lineageFixtureArb,
        (sessionId, jsonBytes, { archives, historyExecutionIds }) => {
          const self = computeSessionFootprint(
            { sessionId, jsonBytes, scope: 'self', historyExecutionIds },
            archives
          );
          const lineage = computeSessionFootprint(
            { sessionId, jsonBytes, scope: 'lineage', historyExecutionIds },
            archives
          );

          // (a) lineage ⊇ self：归因集合是超集，故存档部分与合计都不小于自身口径
          expect(lineage.archiveBytes).toBeGreaterThanOrEqual(self.archiveBytes);
          expect(lineage.totalBytes).toBeGreaterThanOrEqual(self.totalBytes);
          // 命中过存档也单调：self 找到则 lineage 必找到
          if (self.archivesFound) expect(lineage.archivesFound).toBe(true);

          // (b) 差分验证：lineage 字节数恒等于测试侧独立求得的 lineage 闭包之和
          const wantedLineage = refLineageWanted(sessionId, archives, historyExecutionIds);
          const wantedSelf = refLineageWanted(sessionId, archives);
          expect(lineage.archiveBytes).toBe(refArchiveBytesFor(wantedLineage, archives));
          expect(lineage.archivesFound).toBe(refMatchesFor(wantedLineage, archives).length > 0);
          // 集合层面确认是超集（而非仅字节数巧合相等）
          for (const id of wantedSelf) expect(wantedLineage.has(id)).toBe(true);

          // (c) self 口径恒忽略 historyExecutionIds：与不传时逐字段一致
          const selfNoHistory = computeSessionFootprint({ sessionId, jsonBytes, scope: 'self' }, archives);
          expect(self).toEqual(selfNoHistory);
          expect(self.archiveBytes).toBe(refSelfArchiveBytes(sessionId, archives));

          // (d) scope 与 additive 严格对应：self → true，lineage → false
          expect(self.scope).toBe('self');
          expect(self.additive).toBe(true);
          expect(lineage.scope).toBe('lineage');
          expect(lineage.additive).toBe(false);

          // (e) JSON 部分与口径无关
          expect(lineage.jsonBytes).toBe(self.jsonBytes);
          expect(lineage.totalBytes).toBe(lineage.jsonBytes + lineage.archiveBytes);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 4: history 反查到他方会话的存档时，lineage 严格大于 self 而 self 不受影响', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 4096 }),
        fc.integer({ min: 1, max: 4096 }),
        (ownBytes, foreignBytes) => {
          const foreignName = hash32(EXECUTION_ID_POOL[0]);
          const archives: ArchiveInfo[] = [
            {
              path: path.join(SAVES_DIR, archiveName(0)),
              name: archiveName(0),
              size: ownBytes,
              chatSessionId: 's1',
            },
            // 该存档属于 s2，仅能经 history 的 executionId → hash32 → name 反查并入
            {
              path: path.join(SAVES_DIR, foreignName),
              name: foreignName,
              size: foreignBytes,
              chatSessionId: 's2',
            },
          ];
          const historyExecutionIds = [EXECUTION_ID_POOL[0]];

          const self = computeSessionFootprint(
            { sessionId: 's1', jsonBytes: 10, scope: 'self', historyExecutionIds },
            archives
          );
          const lineage = computeSessionFootprint(
            { sessionId: 's1', jsonBytes: 10, scope: 'lineage', historyExecutionIds },
            archives
          );

          expect(self.archiveBytes).toBe(ownBytes);
          expect(lineage.archiveBytes).toBe(ownBytes + foreignBytes);
          expect(lineage.archiveBytes).toBeGreaterThan(self.archiveBytes);
          // 同一存档被两个会话计入，故 lineage 结果标记为不可跨会话求和
          expect(lineage.additive).toBe(false);
          expect(self.additive).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });
});

/* ------------------------------------------------------------------ *
 * Property 5 —— 追加生成器与判据
 *
 * 守恒性质同时约束两侧：`computeSessionFootprint`（每个存档被归到哪个会话）与
 * `computeOrphans`（哪些存档不归任何会话）。两侧各有一份 `hasOwner` / `safeBytes`
 * 实现，任一侧判据漂移（例如一侧认纯空白 id 可归因、另一侧不认）就会让
 * 「不重不漏」破掉——这正是本属性要钉住的东西。
 *
 * 关于「执行存档分类总字节数」的简化：这里取夹具中全部存档 `safeBytes(size)`
 * 之和，而不真的跑一遍 `scanTree` 去数 ExecutionSavesBucket。理由是本属性的输入
 * 就是 `ArchiveInfo[]`（ArchiveIndex 的只读快照），归因与孤儿判定两侧消费的都是它，
 * 守恒关系完全发生在这个集合内部；而「磁盘上的存档桶字节数 = 该分类合计」属于
 * 分类划分的性质，已由 Property 1 在真实目录树上覆盖。两条属性各守一段，
 * 在这里重跑目录扫描只会把输入空间重复覆盖一遍。
 * ------------------------------------------------------------------ */

/**
 * LiveSessionIds 生成器。恒取自 `SESSION_ID_POOL` 的子集（外加少量空白 id），
 * 因此与 `archivesArb` 的 `chatSessionId` **部分交叠**：
 * - 落在 `SESSION_ID_POOL` 且被选入 live 的 → 归因到现存会话
 * - 落在 `SESSION_ID_POOL` 但未被选入 live 的、以及 `FOREIGN_SESSION_IDS` → 孤儿（会话已消失）
 * - 空白 `chatSessionId` → 孤儿（无归因）
 *
 * `minLength: 0` 覆盖「无任何现存会话」，用于触发 `unknown` 态；空白 live id
 * （`''` / `'   '`）是刻意保留的边界：它让 `ids.size > 0` 成立（故状态为 `ok`），
 * 但两侧的 `hasOwner` 都拒绝用它归因，守恒因此仍须成立。
 */
export const liveSessionIdsArb: fc.Arbitrary<string[]> = fc.uniqueArray(
  fc.oneof(
    { weight: 5, arbitrary: fc.constantFrom(...SESSION_ID_POOL) },
    { weight: 1, arbitrary: fc.constantFrom('', '   ') }
  ),
  { minLength: 0, maxLength: SESSION_ID_POOL.length + 2 }
);

/** 归因守恒的完整夹具：现存会话集合 + 采集完整性标记 + 存档集合 + 会话 JSON 字节数 */
export const attributionFixtureArb: fc.Arbitrary<{
  liveIds: string[];
  complete: boolean;
  archives: ArchiveInfo[];
  jsonBytes: number;
}> = fc.record({
  liveIds: liveSessionIdsArb,
  // `false` 权重较低：主断言只在 complete === true 时有意义，但 pending 分支
  // 必须被稳定覆盖（那是刻意的降级，见下面第二条断言）
  complete: fc.oneof(
    { weight: 4, arbitrary: fc.constant(true) },
    { weight: 1, arbitrary: fc.constant(false) }
  ),
  archives: archivesArb,
  jsonBytes: byteSizeArb,
});

/** 夹具里全部存档的字节数合计（= 本属性口径下的「执行存档分类总字节数」） */
export function refTotalArchiveBytes(archives: readonly ArchiveInfo[]): number {
  return archives.reduce((sum, a) => sum + refSafeBytes(a.size), 0);
}

/** 各现存会话自身口径存档部分的合计与命中条目数（live id 唯一，故不会重复计数） */
function sumSelfArchiveParts(
  liveIds: readonly string[],
  archives: readonly ArchiveInfo[],
  jsonBytes: number
): { archiveBytes: number; matchedFiles: number; totalBytes: number } {
  let archiveBytes = 0;
  let matchedFiles = 0;
  let totalBytes = 0;
  for (const sessionId of liveIds) {
    const fp = computeSessionFootprint({ sessionId, jsonBytes, scope: 'self' }, archives);
    archiveBytes += fp.archiveBytes;
    matchedFiles += refSelfMatches(sessionId, archives).length;
    totalBytes += fp.totalBytes;
  }
  return { archiveBytes, matchedFiles, totalBytes };
}

/* ------------------------------------------------------------------ *
 * Property 5
 * ------------------------------------------------------------------ */

// Feature: storage-usage-analytics, Property 5: 归因守恒
// Validates: Requirements 2.3
describe('Property 5: 归因守恒', () => {
  it('Property 5: 孤儿判定为 ok 时，Σ 各会话自身口径存档部分 + 孤儿字节数 === 存档总字节数（不重不漏）', () => {
    fc.assert(
      fc.property(attributionFixtureArb, ({ liveIds, complete, archives, jsonBytes }) => {
        const ids = new Set(liveIds);
        // 主断言只覆盖 ok 态：pending / unknown 下孤儿字节数恒为 0，等式本就不成立
        fc.pre(complete === true && ids.size > 0);

        const orphan = computeOrphans(archives, { ids, complete });
        expect(orphan.state).toBe('ok');

        const parts = sumSelfArchiveParts(liveIds, archives, jsonBytes);
        const totalArchiveBytes = refTotalArchiveBytes(archives);

        // (a) 字节数守恒：每个存档恰好被归因到一个现存会话，或被判为孤儿
        expect(parts.archiveBytes + orphan.bytes).toBe(totalArchiveBytes);

        // (b) 文件数守恒：同一等式在条目计数上成立，排除「字节数恰好相等但集合错位」
        // （例如某 0 字节存档两侧都漏掉时 (a) 仍会通过）
        expect(parts.matchedFiles + orphan.files).toBe(archives.length);

        // (c) 两侧不相交：被归因的字节数与孤儿字节数各自不超过总量
        expect(parts.archiveBytes).toBeLessThanOrEqual(totalArchiveBytes);
        expect(orphan.bytes).toBeLessThanOrEqual(totalArchiveBytes);

        // (d) 会话 JSON 字节数不掺入存档侧：Σ totalBytes 减去各会话的 JSON 部分
        // 恰好还原出 (a) 的左项，故 jsonBytes 的取值（含 NaN / 负数）不影响守恒
        const jsonPart = refSafeBytes(jsonBytes) * liveIds.length;
        expect(parts.totalBytes - jsonPart).toBe(parts.archiveBytes);
      }),
      { numRuns: 100 }
    );
  });

  it('Property 5: pending / unknown 两态下孤儿合计恒为 0，Σ 各会话自身口径存档部分 ≤ 存档总字节数', () => {
    fc.assert(
      fc.property(attributionFixtureArb, ({ liveIds, complete, archives, jsonBytes }) => {
        const ids = new Set(liveIds);
        fc.pre(complete === false || ids.size === 0);

        const orphan = computeOrphans(archives, { ids, complete });

        // 采集未完成 → pending（优先于 ids 为空的判断）；否则 ids 为空 → unknown
        expect(orphan.state).toBe(complete === false ? 'pending' : 'unknown');
        // 降级是刻意的：拿不到可信的现存会话集合时不把任何存档判成垃圾
        expect(orphan.bytes).toBe(0);
        expect(orphan.files).toBe(0);

        const parts = sumSelfArchiveParts(liveIds, archives, jsonBytes);
        const totalArchiveBytes = refTotalArchiveBytes(archives);

        // 归因侧照常工作且仍不重不漏，只是孤儿那部分未被计入，故等式退化为不等式
        expect(parts.archiveBytes).toBeLessThanOrEqual(totalArchiveBytes);
        expect(parts.matchedFiles).toBeLessThanOrEqual(archives.length);
      }),
      { numRuns: 100 }
    );
  });

  it('Property 5: 存档归因到现存会话 / 已消失会话 / 空白 chatSessionId 三种去向恰好覆盖全部存档', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 4096 }),
        fc.integer({ min: 1, max: 4096 }),
        fc.integer({ min: 1, max: 4096 }),
        (liveBytes, goneBytes, blankBytes) => {
          const archives: ArchiveInfo[] = [
            // 归因到现存会话 s1
            { path: path.join(SAVES_DIR, archiveName(0)), name: archiveName(0), size: liveBytes, chatSessionId: 's1' },
            // 归因到已消失的会话 s2（不在 LiveSessionIds 中）→ 孤儿
            { path: path.join(SAVES_DIR, archiveName(1)), name: archiveName(1), size: goneBytes, chatSessionId: 's2' },
            // chatSessionId 为纯空白 → 无归因 → 孤儿
            { path: path.join(SAVES_DIR, archiveName(2)), name: archiveName(2), size: blankBytes, chatSessionId: '   ' },
          ];
          const liveIds = ['s1', 'sess-3'];
          const ids = new Set(liveIds);

          const orphan = computeOrphans(archives, { ids, complete: true });
          const parts = sumSelfArchiveParts(liveIds, archives, 100);

          expect(parts.archiveBytes).toBe(liveBytes);
          expect(orphan.bytes).toBe(goneBytes + blankBytes);
          expect(orphan.files).toBe(2);
          // 三种去向合起来恰好是存档总量：不重不漏
          expect(parts.archiveBytes + orphan.bytes).toBe(liveBytes + goneBytes + blankBytes);
          expect(parts.matchedFiles + orphan.files).toBe(archives.length);
        }
      ),
      { numRuns: 100 }
    );
  });
});

/* ------------------------------------------------------------------ *
 * Property 2 —— 真实临时目录夹具
 *
 * 不同于 Property 3/4/5 的纯 `ArchiveInfo[]` 输入：`getSummary` 的
 * `currentWorkspaceBytes` 需要真的 `scanTree` 两处目录，因此本属性在临时目录里
 * 造一个 UserDataDir，注入 `pathResolver` 让 `getKiroUserDataDir` 返回它，
 * 在「当前工作区的 WorkspaceSessionDir」与「<StoreRoot>/<WorkspaceId>」两处
 * 各放随机字节数的文件，并额外放入其它工作区目录 / 日志目录作为噪声——
 * 后者必须被排除在 `currentWorkspaceBytes` 之外。
 *
 * 独立判据：测试侧用真实 fs 递归求和（`sumFileBytes`）算出两处目录的字节数之和，
 * 与实现的 `currentWorkspaceBytes` 逐字节对比；求和口径与 `scanTree` 一致
 * （只计文件与符号链接条目，目录自身不计）。
 * ------------------------------------------------------------------ */

/** UserDataDir 到 StoreRoot 的相对段（与 buildClassifyRoots 一致）。 */
const STORE_SEGS_2 = ['User', 'globalStorage', 'kiro.kiroagent'] as const;

/** 单个夹具文件：字节数与是否落入子目录（后者用于触发递归求和）。 */
interface FixtureEntry {
  bytes: number;
  nested: boolean;
}

const fixtureEntryArb: fc.Arbitrary<FixtureEntry> = fc.record({
  bytes: fc.integer({ min: 0, max: 4096 }),
  nested: fc.boolean(),
});

/** 一组夹具文件；`maxLength` 含 0，故「目录存在但为空」被覆盖。 */
const fixtureEntriesArb: fc.Arbitrary<FixtureEntry[]> = fc.array(fixtureEntryArb, { maxLength: 5 });

/**
 * 工作区路径：POSIX 形态 + 数字后缀。刻意用 POSIX 形态避免盘符大小写变体在磁盘上
 * 同时存在——本属性只在首个编码变体处造目录，故 `existingDirs` 恒只命中它一个。
 */
const workspacePath2Arb: fc.Arbitrary<string> = fc
  .tuple(fc.constantFrom('/home/kcs/alpha', '/home/kcs/beta', '/work/proj', '/srv/x y z'), fc.integer({ min: 0, max: 199 }))
  .map(([base, n]) => `${base}-${n}`);

/** 把一组夹具文件写入 `dir`（数字叶子 = 字节数）；返回创建的文件数。 */
function writeFixtureEntries(dir: string, entries: readonly FixtureEntry[]): void {
  entries.forEach((e, i) => {
    const rel = e.nested ? path.join('sub', `f${i}.bin`) : `f${i}.bin`;
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, Buffer.alloc(e.bytes, 0x61));
  });
}

/**
 * 独立 oracle：递归求和一棵目录树里全部文件（含符号链接条目）的字节数，目录自身不计。
 * 用 `lstatSync` 因此不跟随符号链接——与 `scanTree` 的口径一致。目录不存在时返回 0。
 */
function sumFileBytes(dir: string): number {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let total = 0;
  for (const name of names) {
    const full = path.join(dir, name);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) total += sumFileBytes(full);
    else total += st.size;
  }
  return total;
}

/** 注入的 PathResolver：linux + XDG_CONFIG_HOME 指向 runDir，使 UserDataDir = runDir/Kiro。 */
function pathResolverFor(runDir: string): PathResolverDeps {
  return {
    platform: 'linux',
    env: { XDG_CONFIG_HOME: runDir },
    homedir: () => runDir,
    existsSync: () => true,
    statSync: () => ({ isDirectory: () => true }),
  };
}

// Feature: storage-usage-analytics, Property 2: 当前工作区归属等于两处目录之和
// Validates: Requirements 1.10
describe('Property 2: 当前工作区归属等于两处目录之和', () => {
  let base: string | null = null;
  let seq = 0;

  afterEach(() => {
    if (base) rmTempDir(base);
    base = null;
  });

  it('Property 2: currentWorkspaceBytes 恒等于 WorkspaceSessionDir 与 <StoreRoot>/<WorkspaceId> 两处字节数之和（噪声目录被排除）', async () => {
    base = mkTempDir('kcs-analyzer-ws-');
    const fixtureBase = base;

    await fc.assert(
      fc.asyncProperty(
        workspacePath2Arb,
        fixtureEntriesArb,
        fixtureEntriesArb,
        fixtureEntriesArb,
        fc.boolean(),
        fc.boolean(),
        async (workspacePath, sessionEntries, execEntries, noiseEntries, createSession, createExec) => {
          const runDir = path.join(fixtureBase, `r${seq++}`);
          const userDataDir = path.join(runDir, 'Kiro');
          const roots = buildClassifyRoots(userDataDir);
          // 恒建出 SessionsRoot，使 UserDataDir 结构完整（即便本次不建目标会话目录）
          fs.mkdirSync(roots.sessionsRoot, { recursive: true });

          const encodedKey = encodeWorkspaceKeys(workspacePath)[0];
          const workspaceId = workspaceIdCandidates(workspacePath)[0];
          const sessionDir = path.join(roots.sessionsRoot, encodedKey);
          const execDir = path.join(roots.storeRoot, workspaceId);

          if (createSession) writeFixtureEntries(sessionDir, sessionEntries);
          if (createExec) writeFixtureEntries(execDir, execEntries);

          // 噪声：另一个工作区的两处目录 + 运行日志目录；均不应计入 currentWorkspaceBytes
          const otherKey = encodeWorkspaceKeys(`${workspacePath}-other`)[0];
          const otherId = workspaceIdCandidates(`${workspacePath}-other`)[0];
          writeFixtureEntries(path.join(roots.sessionsRoot, otherKey), noiseEntries);
          writeFixtureEntries(path.join(roots.storeRoot, otherId), noiseEntries);
          writeFixtureEntries(roots.logsDir, noiseEntries);

          const analyzer = new StorageAnalyzer({
            pathResolver: pathResolverFor(runDir),
            workspacePath,
            // 归属字节数不依赖存档索引；注入空集合避免读真实磁盘且保证确定性
            listArchives: () => [],
          });

          const summary = await analyzer.getSummary({ force: true });

          // 独立求和：两处目标目录的文件字节数之和（目录不存在时各为 0）
          const oracle = sumFileBytes(sessionDir) + sumFileBytes(execDir);

          expect(summary.status).toBe('ok');
          expect(summary.currentWorkspaceBytes).toBe(oracle);
          // currentWorkspaceBytes 恒不超过总占用（噪声与两处目标都计入 totalBytes）
          expect(summary.currentWorkspaceBytes).toBeLessThanOrEqual(summary.totalBytes);
        }
      ),
      // 真实临时目录夹具 + 每轮一次整树 scanTree 属 IO 密集：并行跑全量测试套件时
      // 100 轮会逼近/超过默认 5s 用例超时。按 design 测试策略对真实 fs 夹具的放宽降到
      // 50 轮（仍覆盖建/不建两处目录、空目录、噪声排除等分支），并给出显式宽松超时。
      { numRuns: 50 }
    );
  }, 60_000);

  it('Property 2: 无工作区（workspacePath 为 null）时 currentWorkspaceBytes 恒为 0', async () => {
    base = mkTempDir('kcs-analyzer-ws-null-');
    const fixtureBase = base;

    await fc.assert(
      fc.asyncProperty(workspacePath2Arb, fixtureEntriesArb, fixtureEntriesArb, async (workspacePath, sessionEntries, execEntries) => {
        const runDir = path.join(fixtureBase, `r${seq++}`);
        const userDataDir = path.join(runDir, 'Kiro');
        const roots = buildClassifyRoots(userDataDir);
        fs.mkdirSync(roots.sessionsRoot, { recursive: true });

        // 即便磁盘上确有会话目录与执行目录，无工作区时也不该归属到「当前工作区」
        writeFixtureEntries(path.join(roots.sessionsRoot, encodeWorkspaceKeys(workspacePath)[0]), sessionEntries);
        writeFixtureEntries(path.join(roots.storeRoot, workspaceIdCandidates(workspacePath)[0]), execEntries);

        const analyzer = new StorageAnalyzer({
          pathResolver: pathResolverFor(runDir),
          workspacePath: null,
          listArchives: () => [],
        });

        const summary = await analyzer.getSummary({ force: true });
        expect(summary.status).toBe('ok');
        expect(summary.currentWorkspaceBytes).toBe(0);
        expect(summary.projectFootprintTotal).toBe(0);
        expect(summary.sessionCount).toBe(0);
      }),
      { numRuns: 50 }
    );
  }, 60_000);

  it('Property 2: 工作区目录不存在时 currentWorkspaceBytes 为 0（仅噪声目录存在）', async () => {
    base = mkTempDir('kcs-analyzer-ws-absent-');
    const runDir = path.join(base, 'r0');
    const userDataDir = path.join(runDir, 'Kiro');
    const roots = buildClassifyRoots(userDataDir);
    fs.mkdirSync(roots.sessionsRoot, { recursive: true });

    const workspacePath = '/home/kcs/absent-ws';
    // 只造别的工作区目录与日志，绝不建当前工作区的两处目录
    writeFixtureEntries(path.join(roots.sessionsRoot, encodeWorkspaceKeys('/home/kcs/other')[0]), [
      { bytes: 100, nested: false },
      { bytes: 200, nested: true },
    ]);
    writeFixtureEntries(roots.logsDir, [{ bytes: 300, nested: false }]);

    const analyzer = new StorageAnalyzer({
      pathResolver: pathResolverFor(runDir),
      workspacePath,
      listArchives: () => [],
    });

    const summary = await analyzer.getSummary({ force: true });
    expect(summary.status).toBe('ok');
    expect(summary.currentWorkspaceBytes).toBe(0);
    // 噪声确实被扫到了（总量 > 0），但没有归属到当前工作区
    expect(summary.totalBytes).toBeGreaterThan(0);
  }, 60_000);
});

/* ------------------------------------------------------------------ *
 * Property 6 —— 真实临时目录夹具
 *
 * 与 Property 2 同一套 mkTempDir + 注入 pathResolver 的真实目录树夹具（复用
 * 顶部的 `pathResolverFor` / `workspacePath2Arb`）。本属性钉住的是「非会话数据不
 * 进入会话占用」：向 SessionManifest（`sessions.json`）与 UnclassifiedBucket
 * （<StoreRoot>/<WorkspaceId>/<非 saves/metadata 桶>，实测为源码文件快照）各追加
 * 任意字节后——
 *   (a) 每个会话的占用（jsonBytes + 归因存档字节数）恒保持不变（Req 2.6、2.7）；
 *   (b) ProjectFootprintTotal 与参与统计的会话数恒保持不变；
 *   (c) manifest 的字节增量恒计入「对话 JSON」分类（sessionJson），不落到任何
 *       会话占用上；UnclassifiedBucket 的增量恒计入「其他/未分类」分类。
 *
 * 差分做法：用两个**独立**的 StorageAnalyzer 实例分别在追加前 / 追加后各跑一次
 * `getReportData`（`force: true`）。之所以不复用同一实例：SubtreeCache 以
 * `(mtimeMs, 直接子条目数)` 失效，而向既有文件**追加**内容既不改父目录 mtime、
 * 也不改子条目数，同一实例会命中陈旧子树聚合、读不到追加后的字节。两个实例各持
 * 自己的缓存，等价于「两次全新统计」，这正是本属性要比较的对象。
 * `getReportData` 一次即给出 summary（含分类明细与 ProjectFootprintTotal）与逐
 * 会话的 self 口径 footprint，故每侧只需一次扫描。
 * ------------------------------------------------------------------ */

/** Property 6 会话 id 池：彼此无大小写冲突，避免 Windows 大小写不敏感文件系统上
 *  `s1.json` 与 `S1.json` 落到同一文件。 */
const P6_SESSION_POOL = ['p6-sess-a', 'p6-sess-b', 'p6-sess-c', 'p6-sess-d'] as const;

/** UnclassifiedBucket 目录名：取 `hash32` 于一个自造常量，保证是 hex32 且恒不等于
 *  真实的 SAVES / METADATA 桶名（输入串不同，哈希必不同）。 */
const P6_UNCLASSIFIED_BUCKET = hash32('P6::UNCLASSIFIED::SNAPSHOT');

/** 每个 sessionId 各随机决定是否落入夹具（`include`），并带自己的 JSON 字节数。
 *  `minLength === maxLength === 池大小` + filter 覆盖「0 个会话」到「全部会话」。 */
const p6SessionsArb: fc.Arbitrary<Array<{ sessionId: string; jsonBytes: number }>> = fc
  .array(fc.record({ include: fc.boolean(), jsonBytes: fc.integer({ min: 0, max: 4096 }) }), {
    minLength: P6_SESSION_POOL.length,
    maxLength: P6_SESSION_POOL.length,
  })
  .map((items) =>
    items
      .map((it, i) => ({ ...it, sessionId: P6_SESSION_POOL[i] }))
      .filter((it) => it.include)
      .map((it) => ({ sessionId: it.sessionId, jsonBytes: it.jsonBytes }))
  );

/** 注入的存档集合：`chatSessionId` 覆盖命中会话 / 外部会话，使 footprint 的
 *  archiveBytes 分支被真实覆盖（存档为注入，不需落盘）。 */
const p6ArchivesArb: fc.Arbitrary<ArchiveInfo[]> = fc
  .array(
    fc.record({
      chatSessionId: fc.oneof(
        { weight: 4, arbitrary: fc.constantFrom(...P6_SESSION_POOL) },
        { weight: 1, arbitrary: fc.constantFrom('p6-foreign', 'p6-gone') }
      ),
      size: fc.integer({ min: 0, max: 65536 }),
    }),
    { maxLength: 8 }
  )
  .map((items) =>
    items.map((it, i) => ({
      path: path.join(SAVES_DIR, archiveName(i)),
      name: archiveName(i),
      size: it.size,
      chatSessionId: it.chatSessionId,
    }))
  );

/** 每个 UnclassifiedBucket 快照文件的字节数；`minLength: 1` 保证恒有一个可供追加。 */
const p6UnclassifiedBytesArb: fc.Arbitrary<number[]> = fc.array(fc.integer({ min: 0, max: 4096 }), {
  minLength: 1,
  maxLength: 4,
});

/** 追加字节数恒 ≥ 1，使分类增量非零、断言有意义。 */
const p6AppendArb: fc.Arbitrary<number> = fc.integer({ min: 1, max: 8192 });

/** 某分类的字节数（缺失记 0）。 */
function categoryBytesOf(summary: StorageSummary, category: string): number {
  const c = summary.categories.find((x) => x.category === category);
  return c ? c.bytes : 0;
}

/** sessionId → self 口径占用合计，供逐会话差分。 */
function footprintTotals(sessions: ReadonlyArray<{ sessionId: string; footprint: SessionFootprint }>): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of sessions) m.set(s.sessionId, s.footprint.totalBytes);
  return m;
}

// Feature: storage-usage-analytics, Property 6: 非会话数据被排除在会话占用之外
// Validates: Requirements 2.6, 2.7
describe('Property 6: 非会话数据被排除在会话占用之外', () => {
  let base: string | null = null;
  let seq = 0;

  afterEach(() => {
    if (base) rmTempDir(base);
    base = null;
  });

  it('Property 6: 向 sessions.json 与 UnclassifiedBucket 追加字节，所有会话占用与 ProjectFootprintTotal 恒不变，manifest 增量恒计入「对话 JSON」', async () => {
    base = mkTempDir('kcs-analyzer-nonsession-');
    const fixtureBase = base;

    await fc.assert(
      fc.asyncProperty(
        workspacePath2Arb,
        p6SessionsArb,
        p6ArchivesArb,
        fc.integer({ min: 0, max: 2048 }), // manifest 初始字节数
        p6UnclassifiedBytesArb,
        p6AppendArb, // 追加到 sessions.json 的字节数
        p6AppendArb, // 追加到 UnclassifiedBucket 首个快照的字节数
        async (
          workspacePath,
          sessions,
          archives,
          manifestBytes,
          unclassifiedBytes,
          manifestAppend,
          unclassifiedAppend
        ) => {
          const runDir = path.join(fixtureBase, `r${seq++}`);
          const userDataDir = path.join(runDir, 'Kiro');
          const roots = buildClassifyRoots(userDataDir);

          const encodedKey = encodeWorkspaceKeys(workspacePath)[0];
          const workspaceId = workspaceIdCandidates(workspacePath)[0];
          const sessionDir = path.join(roots.sessionsRoot, encodedKey);
          const bucketDir = path.join(roots.storeRoot, workspaceId, P6_UNCLASSIFIED_BUCKET);

          // 会话 JSON 文件（各自 sessionId 命名，恒不与 sessions.json 冲突）
          fs.mkdirSync(sessionDir, { recursive: true });
          for (const s of sessions) {
            fs.writeFileSync(path.join(sessionDir, `${s.sessionId}.json`), Buffer.alloc(s.jsonBytes, 0x61));
          }
          // SessionManifest：内容无关紧要（会话占用不读它），填充字节即可
          const manifestPath = path.join(sessionDir, 'sessions.json');
          fs.writeFileSync(manifestPath, Buffer.alloc(manifestBytes, 0x7b));

          // UnclassifiedBucket 源码快照文件
          fs.mkdirSync(bucketDir, { recursive: true });
          unclassifiedBytes.forEach((b, i) => {
            fs.writeFileSync(path.join(bucketDir, `snap${i}.bin`), Buffer.alloc(b, 0x63));
          });
          const firstSnapPath = path.join(bucketDir, 'snap0.bin');

          const mkAnalyzer = (): StorageAnalyzer =>
            new StorageAnalyzer({
              pathResolver: pathResolverFor(runDir),
              workspacePath,
              listArchives: () => archives,
            });

          // ---- 追加前 ----
          const before = await mkAnalyzer().getReportData({ force: true });
          expect(before.summary.status).toBe('ok');
          const beforeSessionJson = categoryBytesOf(before.summary, 'sessionJson');
          const beforeUnclassified = categoryBytesOf(before.summary, 'unclassified');
          const beforeFootprints = footprintTotals(before.sessions);

          // ---- 追加非会话数据 ----
          fs.appendFileSync(manifestPath, Buffer.alloc(manifestAppend, 0x7b));
          fs.appendFileSync(firstSnapPath, Buffer.alloc(unclassifiedAppend, 0x63));

          // ---- 追加后（全新实例，绕开 SubtreeCache 对追加的不敏感）----
          const after = await mkAnalyzer().getReportData({ force: true });
          expect(after.summary.status).toBe('ok');
          const afterFootprints = footprintTotals(after.sessions);

          // (a) 逐会话占用恒不变：键集合一致，且每个 sessionId 的占用逐字节相等
          expect([...afterFootprints.keys()].sort()).toEqual([...beforeFootprints.keys()].sort());
          for (const [id, total] of beforeFootprints) {
            expect(afterFootprints.get(id)).toBe(total);
          }

          // (b) ProjectFootprintTotal 与会话数恒不变
          expect(after.summary.projectFootprintTotal).toBe(before.summary.projectFootprintTotal);
          expect(after.summary.sessionCount).toBe(before.summary.sessionCount);
          // 会话数恒等于落盘的会话文件数（sessions.json 不计为会话记录，Req 2.6）
          expect(after.summary.sessionCount).toBe(sessions.length);

          // (c) manifest 增量恒计入「对话 JSON」，UnclassifiedBucket 增量恒计入「其他/未分类」
          expect(categoryBytesOf(after.summary, 'sessionJson') - beforeSessionJson).toBe(manifestAppend);
          expect(categoryBytesOf(after.summary, 'unclassified') - beforeUnclassified).toBe(unclassifiedAppend);
          // 总量的增量恰好是两处追加之和，说明非会话数据的增长都落到了非会话分类上
          expect(after.summary.totalBytes - before.summary.totalBytes).toBe(manifestAppend + unclassifiedAppend);
        }
      ),
      { numRuns: 100 }
    );
  }, 120_000);
});

/* ------------------------------------------------------------------ *
 * Property 7 —— 真实临时目录夹具
 *
 * 复用 Property 2/6 的 mkTempDir + 注入 pathResolver 的真实目录树夹具，以及
 * Property 6 的会话 / 清单 / UnclassifiedBucket / 注入存档生成器（workspacePath2Arb、
 * p6SessionsArb、p6ArchivesArb、p6UnclassifiedBytesArb、P6_UNCLASSIFIED_BUCKET 等）。
 * 本属性钉住的是「统计幂等且缓存透明」：对一个**建好后不再改动**的夹具，
 *   (a) 冷缓存（首次 force 统计）与热缓存（同一实例、非 force、命中 StorageCache）
 *       的结果恒逐字段相等（Req 7.5：60 秒内直接返回缓存，且缓存值与首次统计一致）；
 *   (b) 强制重算（同一实例、force:true，绕过 StorageCache 但复用 SubtreeCache）
 *       的结果与冷缓存恒相等（Req 7.6：未变化子树被复用后聚合值不变）；
 *   (c) 一个**全新实例**（冷 SubtreeCache + 冷 StorageCache）对同一未改动夹具统计，
 *       结果与冷缓存恒逐字节相等（Req 2.9、11.5：同一输入恒返回相同 StorageSummary
 *       与相同会话占用，统计过程无副作用且可重复）。
 *
 * 时钟注入：`StorageSummary.scannedAt` 取自 `this.clock()`（缺省 `Date.now`），
 * 不同次统计的墙钟时刻本会不同。为了能对**整个** StorageReportData（含 summary
 * 的 scannedAt、categories、currentWorkspaceBytes、projectFootprintTotal、
 * sessionCount、orphan 与逐会话 footprint）做 `toEqual` 的逐字节比较，这里给每个
 * analyzer 注入同一个固定时钟——统计结果本就不该依赖「什么时候统计的」，固定时钟
 * 只是把这条隐含前提显式化；同时固定时钟保证 60 秒 TTL 恒不过期，热缓存分支被稳定命中。
 * ------------------------------------------------------------------ */

/** 固定时钟：使 scannedAt 在冷 / 热 / 强制 / 全新实例四次统计间恒相等，且 TTL 恒不过期。 */
const P7_FIXED_NOW = 1_700_000_000_000;

// Feature: storage-usage-analytics, Property 7: 统计幂等且缓存透明
// Validates: Requirements 2.9, 7.6, 11.5
describe('Property 7: 统计幂等且缓存透明', () => {
  let base: string | null = null;
  let seq = 0;

  afterEach(() => {
    if (base) rmTempDir(base);
    base = null;
  });

  it('Property 7: 未变化夹具上，冷缓存 / 热缓存（StorageCache）/ 强制重算（复用 SubtreeCache）/ 全新实例四次统计恒逐字节相等', async () => {
    base = mkTempDir('kcs-analyzer-idempotent-');
    const fixtureBase = base;

    await fc.assert(
      fc.asyncProperty(
        workspacePath2Arb,
        p6SessionsArb,
        p6ArchivesArb,
        fc.integer({ min: 0, max: 2048 }), // sessions.json 清单字节数
        p6UnclassifiedBytesArb,
        async (workspacePath, sessions, archives, manifestBytes, unclassifiedBytes) => {
          const runDir = path.join(fixtureBase, `r${seq++}`);
          const userDataDir = path.join(runDir, 'Kiro');
          const roots = buildClassifyRoots(userDataDir);

          const encodedKey = encodeWorkspaceKeys(workspacePath)[0];
          const workspaceId = workspaceIdCandidates(workspacePath)[0];
          const sessionDir = path.join(roots.sessionsRoot, encodedKey);
          const bucketDir = path.join(roots.storeRoot, workspaceId, P6_UNCLASSIFIED_BUCKET);

          // 会话 JSON 文件 + SessionManifest（内容无关，仅填充字节）
          fs.mkdirSync(sessionDir, { recursive: true });
          for (const s of sessions) {
            fs.writeFileSync(path.join(sessionDir, `${s.sessionId}.json`), Buffer.alloc(s.jsonBytes, 0x61));
          }
          fs.writeFileSync(path.join(sessionDir, 'sessions.json'), Buffer.alloc(manifestBytes, 0x7b));

          // UnclassifiedBucket 源码快照文件（<StoreRoot>/<WorkspaceId>/<非已知桶> 下）
          fs.mkdirSync(bucketDir, { recursive: true });
          unclassifiedBytes.forEach((b, i) => {
            fs.writeFileSync(path.join(bucketDir, `snap${i}.bin`), Buffer.alloc(b, 0x63));
          });

          const mkAnalyzer = (): StorageAnalyzer =>
            new StorageAnalyzer({
              pathResolver: pathResolverFor(runDir),
              workspacePath,
              listArchives: () => archives,
              // 固定时钟：scannedAt 恒定 + TTL 恒不过期（见块注释）
              now: () => P7_FIXED_NOW,
            });

          // 夹具建好后不再有任何写操作——以下四次统计的输入完全相同。
          const analyzer = mkAnalyzer();

          // (1) 冷缓存：首次 force 统计，SubtreeCache 与 StorageCache 均为空
          const cold = await analyzer.getReportData({ force: true });
          expect(cold.summary.status).toBe('ok');

          // (2) 热缓存：同一实例、非 force → 命中 StorageCache（60 秒内直接返回，不重新枚举）
          const hot = await analyzer.getReportData({});
          expect(hot).toEqual(cold);

          // (3) 强制重算：同一实例、force:true → 绕过 StorageCache 但复用 SubtreeCache 的子树聚合
          const forced = await analyzer.getReportData({ force: true });
          expect(forced).toEqual(cold);

          // (4) 全新实例：冷 SubtreeCache + 冷 StorageCache，对同一未改动夹具重新统计
          const fresh = await mkAnalyzer().getReportData({ force: true });
          expect(fresh).toEqual(cold);

          // 冷 / 热 / 强制 / 全新四次统计的 summary 亦逐字节相等（含 scannedAt）——
          // 缓存对结果透明，结果只由夹具决定
          expect(hot.summary).toEqual(cold.summary);
          expect(forced.summary).toEqual(cold.summary);
          expect(fresh.summary).toEqual(cold.summary);
          // 逐会话占用在四次统计间恒不变（键集合与每个 sessionId 的 self 口径合计均相等）
          expect(footprintTotals(fresh.sessions)).toEqual(footprintTotals(cold.sessions));

          // getSummary 与 getReportData 两个入口在同一实例上恒给出相同 summary（缓存透明跨入口成立）
          const summaryEntry = await mkAnalyzer().getSummary({ force: true });
          expect(summaryEntry).toEqual(cold.summary);
          // 同一实例连读两次 getSummary（第二次命中 StorageCache）恒相等
          const reread = await mkAnalyzer();
          const first = await reread.getSummary({ force: true });
          const second = await reread.getSummary({});
          expect(second).toEqual(first);
        }
      ),
      // 真实临时目录夹具 + 每轮四次整树扫描属 IO 密集：按 design 对真实 fs 夹具的放宽
      // 取 50 轮（仍覆盖 0 个会话到全部会话、随机存档归因、随机清单 / 快照字节等分支），
      // 并给出显式宽松超时。
      { numRuns: 50 }
    );
  }, 120_000);
});

/* ------------------------------------------------------------------ *
 * Property 14(a) —— 真实临时目录夹具 + 记录型只读 fs
 *
 * 复用 Property 2/6/7 的同一套夹具设施（`mkTempDir` / `pathResolverFor` /
 * `workspacePath2Arb` / `buildClassifyRoots` / `encodeWorkspaceKeys` /
 * `workspaceIdCandidates` / `P6_SESSION_POOL`），本属性钉住的是**调用面**而不是数值：
 * 一次完整的 ReadOnlyPaths 执行（汇总统计 `getSummary` + 会话占用
 * `computeSessionFootprint` + 报告取数与渲染 `getReportData` / `renderStorageReport`
 * + 排行页取数 `collectRankingRows` / `analyzer.getRankingRows`）之后：
 *
 *   (a) 夹具目录树逐字节未改变——`snapshotTree` 前后的「路径集合 × (size, mtimeMs)」
 *       恒完全相等，故不存在任何写入、删除、重命名或 mtime 变化（Req 6.8、9.7、11.8）；
 *   (b) 该执行期间出现的文件系统调用名集合恒 ⊆
 *       `{ readdir, lstat, stat, readFile, readFileSync }`，且恒不含任何写调用
 *       （`writeFile` / `appendFile` / `unlink` / `rm` / `rmdir` / `rename` /
 *       `copyFile` / `mkdir` / `mkdtemp` / …）（Req 7.4、9.7、13.14）；
 *   (c) 恒不读取存档内容——每个 `readFile` 实参的分类恒为 `sessionJson`
 *       （即恒落在 `<SessionsRoot>` 下），恒不落在 `<StoreRoot>/<WorkspaceId>` 下、
 *       恒不等于任何 ExecutionArchive 的路径（Req 7.1：存档字节数与 `chatSessionId`
 *       一律取自 ArchiveIndex 只读快照，内容读取只由既有 credit 索引模块承担）。
 *
 * 两种手段各补一段盲区，缺一不可：`recordingReadFs` 只看得见经 `fsDeps` 注入点发生的
 * 调用，模块若绕过注入点直接 `fs.promises.writeFile` 它一无所知——那一段由
 * `snapshotTree` 的前后对比兜住；反过来，`snapshotTree` 看不见「建了临时文件又删掉」
 * 这类自我抹除的写入，也看不见「打开存档文件读内容」（读不改变 size / mtime）——
 * 那两段由调用面白名单与 `readFile` 实参分类兜住。模块图上「连写 API 的 import
 * 都不存在」这一条则由末尾的静态审查用例断言（临时文件的唯一入口也在其中）。
 *
 * 存档索引注入为 `() => archives`（`ArchiveInfo.path` 指向**真实落盘**的存档文件），
 * 而不是让 `listArchiveEntries` 去读真实磁盘：这样「存档文件确实存在且被扫描器
 * lstat 过、但从未被 readFile」才是一条有内容的断言（否则文件不存在，不读它是废话）。
 * ------------------------------------------------------------------ */

// 只读约束的判据来自实现自己的分类函数：`readFile` 的实参必须归入 `sessionJson`
// 分类。用 `classifyPath` 而不是测试侧自己拼前缀，是为了让「哪些路径算存档」与
// 统计口径同源——分类规则若漂移，这条断言会跟着一起变严/变松，不会各说各话。
import { classifyPath, isUnder } from '../src/storage/classify';
import { collectRankingRows } from '../src/storage/ranking';
import { renderStorageReport } from '../src/storage/report';
import { recordingReadFs, snapshotTree, type CallRecord } from './_helpers';

/** 只读调用面白名单（Property 14(a) 的断言对象）。 */
const P14_ALLOWED_FS_OPS: readonly string[] = ['readdir', 'lstat', 'stat', 'readFile', 'readFileSync'];

/**
 * `yieldNow` 不是文件系统调用而是让出事件循环的调度钩子（`recordingReadFs` 一并记录）。
 * 把它单列而不是塞进白名单：白名单是「允许碰磁盘的 API」，多一个非 IO 名字会让
 * 这条断言的含义变模糊。
 */
const P14_NON_FS_OPS: readonly string[] = ['yieldNow'];

/** 写调用黑名单：出现任何一个即失败（含创建临时文件用的 `mkdtemp` / `open`）。 */
const P14_WRITE_OPS: readonly string[] = [
  'writeFile',
  'appendFile',
  'unlink',
  'rm',
  'rmdir',
  'rename',
  'copyFile',
  'cp',
  'mkdir',
  'mkdtemp',
  'truncate',
  'utimes',
  'chmod',
  'symlink',
  'link',
  'open',
  'createWriteStream',
  'writeFileSync',
  'unlinkSync',
  'mkdirSync',
];

/** 固定时钟：使 `scannedAt` 与报告渲染时间确定，且 60 秒 TTL 恒不过期。 */
const P14_FIXED_NOW = 1_700_000_000_000;

/** 单个会话夹具：字节数 + 是否登记在清单里 + 内容是否损坏。 */
interface P14Session {
  sessionId: string;
  jsonBytes: number;
  /** 登记在 `sessions.json` 里 → 标题来自清单；否则触发排行页回退读该会话文件 */
  inManifest: boolean;
  /** 内容为截断的 JSON → 回退解析失败分支（仍不得计入跳过、仍只能是 readFile） */
  brokenJson: boolean;
}

/**
 * 会话夹具生成器。`inManifest: false` 是关键分支：它让 `collectRankingRows` 走
 * `readSelfTitle` 回退去 `readFile` 该会话文件——这是只读路径上**唯一**会打开
 * 被统计文件内容的地方，必须被覆盖到，否则「readFile 实参恒为 sessionJson 分类」
 * 会退化成只验证清单一个文件。`minLength === maxLength === 池大小` + filter 覆盖
 * 「0 个会话」到「全部会话」。
 */
const p14SessionsArb: fc.Arbitrary<P14Session[]> = fc
  .array(
    fc.record({
      include: fc.boolean(),
      jsonBytes: fc.integer({ min: 0, max: 2048 }),
      inManifest: fc.boolean(),
      brokenJson: fc.boolean(),
    }),
    { minLength: P6_SESSION_POOL.length, maxLength: P6_SESSION_POOL.length }
  )
  .map((items) =>
    items
      .map((it, i) => ({ ...it, sessionId: P6_SESSION_POOL[i] }))
      .filter((it) => it.include)
      .map(({ sessionId, jsonBytes, inManifest, brokenJson }) => ({
        sessionId,
        jsonBytes,
        inManifest,
        brokenJson,
      }))
  );

/** 落盘存档条目：字节数 + 归属会话（含不命中任何会话的外部 id）。 */
const p14ArchiveEntriesArb: fc.Arbitrary<Array<{ bytes: number; owner: string }>> = fc.array(
  fc.record({
    bytes: fc.integer({ min: 0, max: 8192 }),
    owner: fc.oneof(
      { weight: 4, arbitrary: fc.constantFrom(...P6_SESSION_POOL) },
      { weight: 1, arbitrary: fc.constantFrom('p14-foreign', 'p14-gone') }
    ),
  }),
  { maxLength: 5 }
);

/**
 * 会话文件内容：合法 JSON（带 `title`）或被截断的 JSON，再用尾随空格补到目标字节数
 * （`JSON.parse` 允许尾随空白，故补白不改变解析结果）。
 */
function p14SessionContent(s: P14Session): Buffer {
  const head = s.brokenJson
    ? `{"title": "broken-${s.sessionId}`
    : JSON.stringify({ title: `self-${s.sessionId}`, name: 'Agent' });
  const pad = Math.max(0, s.jsonBytes - Buffer.byteLength(head, 'utf8'));
  return Buffer.from(head + ' '.repeat(pad), 'utf8');
}

/** `calls` 中某个调用名出现的次数。 */
function p14OpCount(calls: readonly CallRecord[], op: string): number {
  return calls.reduce((n, c) => (c.op === op ? n + 1 : n), 0);
}

/** 某个调用名的首个实参（路径）集合，已归一化便于比较。 */
function p14PathArgs(calls: readonly CallRecord[], op: string): string[] {
  return calls.filter((c) => c.op === op).map((c) => path.normalize(String(c.args[0])));
}

// Feature: storage-usage-analytics, Property 14(a): 两段式调用面约束——统计路径只读
// Validates: Requirements 6.8, 7.1, 7.4, 9.7, 11.8, 13.14
describe('Property 14(a): 两段式调用面约束——统计路径只读', () => {
  let base: string | null = null;
  let seq = 0;

  afterEach(() => {
    if (base) rmTempDir(base);
    base = null;
  });

  it('Property 14(a): 一次完整的 ReadOnlyPaths 执行（汇总 + 会话占用 + 报告 + 排行页取数）前后目录树恒逐字节相等，调用名集合恒 ⊆ { readdir, lstat, stat, readFile, readFileSync } 且恒不读取存档内容', async () => {
    base = mkTempDir('kcs-analyzer-readonly-');
    const fixtureBase = base;

    await fc.assert(
      fc.asyncProperty(
        workspacePath2Arb,
        p14SessionsArb,
        p14ArchiveEntriesArb,
        fc.integer({ min: 0, max: 2048 }), // sessions.json 之外的清单填充字节
        p6UnclassifiedBytesArb,
        async (workspacePath, sessions, archiveEntries, manifestPad, unclassifiedBytes) => {
          const runDir = path.join(fixtureBase, `r${seq++}`);
          const userDataDir = path.join(runDir, 'Kiro');
          const roots = buildClassifyRoots(userDataDir);

          const encodedKey = encodeWorkspaceKeys(workspacePath)[0];
          const workspaceId = workspaceIdCandidates(workspacePath)[0];
          const sessionDir = path.join(roots.sessionsRoot, encodedKey);
          const execWorkspaceDir = path.join(roots.storeRoot, workspaceId);
          const savesDir = path.join(execWorkspaceDir, roots.savesBucket);
          const metadataDir = path.join(execWorkspaceDir, roots.metadataBucket);
          const bucketDir = path.join(execWorkspaceDir, P6_UNCLASSIFIED_BUCKET);

          // ---- 夹具：会话目录（会话文件 + 清单）----
          fs.mkdirSync(sessionDir, { recursive: true });
          for (const s of sessions) {
            fs.writeFileSync(path.join(sessionDir, `${s.sessionId}.json`), p14SessionContent(s));
          }
          const manifest = sessions
            .filter((s) => s.inManifest)
            .map((s) => ({ sessionId: s.sessionId, title: `manifest-${s.sessionId}` }));
          fs.writeFileSync(
            path.join(sessionDir, 'sessions.json'),
            Buffer.from(JSON.stringify(manifest) + ' '.repeat(manifestPad), 'utf8')
          );

          // ---- 夹具：执行存档桶（真实落盘）+ 执行索引桶 + 未分类快照 + 日志噪声 ----
          fs.mkdirSync(savesDir, { recursive: true });
          const archives: ArchiveInfo[] = archiveEntries.map((e, i) => {
            const name = hash32(`p14-exec-${i}`);
            const full = path.join(savesDir, name);
            // 内容刻意写成看起来「值得解析」的 JSON：若实现真去读它，断言才抓得住
            fs.writeFileSync(full, Buffer.alloc(e.bytes, 0x7b));
            return { path: full, name, size: e.bytes, chatSessionId: e.owner };
          });
          fs.mkdirSync(metadataDir, { recursive: true });
          fs.writeFileSync(path.join(metadataDir, hash32('p14-index')), Buffer.alloc(64, 0x7b));
          fs.mkdirSync(bucketDir, { recursive: true });
          unclassifiedBytes.forEach((b, i) => {
            fs.writeFileSync(path.join(bucketDir, `snap${i}.bin`), Buffer.alloc(b, 0x63));
          });
          fs.mkdirSync(roots.logsDir, { recursive: true });
          fs.writeFileSync(path.join(roots.logsDir, 'main.log'), Buffer.alloc(128, 0x6c));

          const archivePaths = new Set(archives.map((a) => path.normalize(a.path)));

          // ---- 前置快照（夹具建完后不再有任何写操作）----
          const before = snapshotTree(runDir);

          // ---- 记录型只读 fs：analyzer 把它分发给 scanner / orphan / ranking ----
          const { deps, calls } = recordingReadFs();

          // 注入点自身的形状也是断言对象：连写 API 都拿不到（Req 9.7）
          for (const key of Object.keys(deps)) {
            expect([...P14_ALLOWED_FS_OPS, ...P14_NON_FS_OPS]).toContain(key);
          }

          const analyzer = new StorageAnalyzer({
            pathResolver: pathResolverFor(runDir),
            workspacePath,
            fsDeps: deps,
            // 存档字节数与 chatSessionId 取自 ArchiveIndex 只读快照（Req 7.1）
            listArchives: () => archives,
            now: () => P14_FIXED_NOW,
          });

          // ---- 一次完整的 ReadOnlyPaths 执行 ----
          // (1) 汇总统计
          const summary = await analyzer.getSummary({ force: true });
          // (2) 报告取数 + 渲染（渲染为纯函数，固定 now 使输出确定）
          const report = await analyzer.getReportData({ force: true });
          const reportText = renderStorageReport(report, new Date(P14_FIXED_NOW));
          // (3) 排行页取数：经 analyzer 入口
          const ranking = await analyzer.getRankingRows({ force: true });
          // (4) 排行页取数：直接调用取数函数，注入同一个记录型只读 fs
          const direct = await collectRankingRows(
            { sessionDir, storeRoot: roots.storeRoot, workspacePath, archives },
            deps
          );
          // (5) 会话占用（纯函数，零 IO；在此一并跑过以覆盖「完整执行」）
          for (const s of sessions) {
            const fp = computeSessionFootprint(
              { sessionId: s.sessionId, jsonBytes: s.jsonBytes, scope: 'self' },
              archives
            );
            expect(fp.totalBytes).toBe(fp.jsonBytes + fp.archiveBytes);
          }

          // ---- (a) 目录树逐字节未改变：无写入、无删除、无 mtime 变化 ----
          expect(snapshotTree(runDir)).toEqual(before);

          // ---- (b) 调用面白名单 ----
          const ops = [...new Set(calls.map((c) => c.op))].sort();
          for (const op of ops) {
            expect([...P14_ALLOWED_FS_OPS, ...P14_NON_FS_OPS]).toContain(op);
          }
          for (const write of P14_WRITE_OPS) {
            expect(ops).not.toContain(write);
          }

          // ---- (c) 恒不读取存档内容：每个 readFile 实参恒归入 sessionJson 分类 ----
          const readFileArgs = p14PathArgs(calls, 'readFile');
          for (const p of readFileArgs) {
            expect(classifyPath(roots, p)).toBe('sessionJson');
            expect(p.endsWith('.json')).toBe(true);
            // 存档路径与 <StoreRoot>/<WorkspaceId> 整棵子树都不得被打开
            expect(archivePaths.has(p)).toBe(false);
            expect(isUnder(execWorkspaceDir, p)).toBe(false);
          }

          // ---- 非空验证：以上子集断言不是因为「压根没碰磁盘」而通过 ----
          expect(p14OpCount(calls, 'readdir')).toBeGreaterThan(0);
          expect(p14OpCount(calls, 'lstat')).toBeGreaterThan(0);
          expect(p14OpCount(calls, 'stat')).toBeGreaterThan(0);
          // 报告取数恒读一次会话清单，故 readFile 恒至少发生一次
          expect(readFileArgs.length).toBeGreaterThan(0);
          // 存档文件确实存在且被扫描器 lstat 过（只取字节数），因此「未被 readFile」有内容
          if (archives.length > 0) {
            const lstatArgs = new Set(p14PathArgs(calls, 'lstat'));
            for (const p of archivePaths) expect(lstatArgs.has(p)).toBe(true);
          }
          // 四个入口都真的产出了结果（执行未在中途退化为空跑）
          expect(summary.status).toBe('ok');
          expect(reportText.length).toBeGreaterThan(0);
          expect(ranking.rows.length).toBe(sessions.length);
          expect(direct.rows.length).toBe(sessions.length);
        }
      ),
      // 真实临时目录夹具 + 每轮多次整树扫描属 IO 密集：按本文件 Property 2/6/7 对真实 fs
      // 夹具的同一放宽取 50 轮（仍覆盖 0 个会话到全部会话、清单命中与回退读、损坏 JSON、
      // 0 到 5 个落盘存档等分支），并给出显式宽松超时。
      { numRuns: 50 }
    );
  }, 120_000);

  /**
   * 静态审查补齐 `snapshotTree` 的盲区：建了临时文件又在同一次执行里删掉，前后快照
   * 完全相同，运行期无从察觉（Req 6.8 明确把「随后被清理的文件」也算违规）。而写入的
   * 唯一入口是 fs 的写 API，因此「ReadOnlyPaths 的模块图里连写 API 的 import 都不存在」
   * 是比运行期计数更强的事实。`orphan.ts` 已有同类审查（见 storage.orphan.spec.ts），
   * 这里覆盖其余 ReadOnlyPaths 模块。
   */
  it('Property 14(a): ReadOnlyPaths 的模块图里恒只具名导入只读 fs API，无命名空间导入、无任何写 API', () => {
    const READ_ONLY_FS_API = new Set([
      'readdir',
      'lstat',
      'stat',
      'readFile',
      'readdirSync',
      'lstatSync',
      'statSync',
      'readFileSync',
      'existsSync',
      'access',
      'realpath',
    ]);
    const modules = [
      'src/storage/analyzer.ts',
      'src/storage/scanner.ts',
      'src/storage/ranking.ts',
      'src/storage/report.ts',
      'src/storage/classify.ts',
      'src/storage/types.ts',
    ];

    for (const rel of modules) {
      const code = fs
        .readFileSync(path.resolve(process.cwd(), rel), 'utf8')
        // 去掉注释：只读约束的说明文字里正列着 `unlink` / `writeFile` 等词
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');

      expect(code).not.toMatch(/require\(\s*'(fs|fs\/promises|node:fs[^']*)'\s*\)/);

      const fsImports = [
        ...code.matchAll(/import\s+([^;]+?)\s+from\s+'(fs|fs\/promises|node:fs[^']*)'/g),
      ];
      for (const [, clause] of fsImports) {
        // 命名空间导入（import * as fs）会把整个写 API 面一起带进来
        expect(clause).not.toMatch(/\*\s+as/);
        expect(clause.trim().startsWith('{')).toBe(true);
        for (const raw of clause.replace(/[{}]/g, '').split(',')) {
          const name = raw.trim().split(/\s+as\s+/)[0];
          if (!name) continue;
          expect(READ_ONLY_FS_API.has(name)).toBe(true);
        }
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * Property 15 —— 真实临时目录夹具 + 记录型只读 fs + 两个工作区
 *
 * 复用 Property 2/6/7/14(a) 的同一套夹具设施（`mkTempDir` / `rmTempDir` /
 * `pathResolverFor` / `workspacePath2Arb` / `buildClassifyRoots` /
 * `encodeWorkspaceKeys` / `workspaceIdCandidates` / `recordingReadFs` /
 * `p14PathArgs`），钉住的是**非显式动作的调用面**：对任意「视图变为可见 / 输入关键词 /
 * 切换过滤 / 点击既有刷新按钮 / 无工作区下打开排行页」的动作序列（随机顺序、含重复），
 *
 *   (a) `scanTree` 恒不被调用、目录枚举调用次数恒为 0——注入 `StorageAnalyzer` 的
 *       `fsDeps` 是 `recordingReadFs`，而 `scanTree` 触碰磁盘的**唯一**途径就是
 *       `opts.fsDeps.readdir` / `lstat`（scanner 的全部 IO 都经该注入点），因此
 *       「记录数组恒为空」与「scanTree 调用次数为 0」是等价的可观测事实
 *       （Req 4.2、7.7、7.12）；排行页一侧另有 `getRankingRows` 计数器恒为 0
 *       （Req 13.16：无工作区时**直接**进入 no-workspace，绝不调用 analyzer）；
 *   (b) 为渲染结果角标而访问的路径集合恒不含其它工作区的目录——夹具里除当前工作区外
 *       还有**第二个**工作区，其 `<StoreRoot>/<其它 WorkspaceId>/<saves>` 下放着
 *       `chatSessionId` **刻意指向当前工作区会话**的存档（字节数恒 > 0）。于是
 *       「跨工作区枚举」有两个独立的可观测后果：ArchiveIndex 快照里出现其它工作区的
 *       路径、以及角标的 `archiveBytesSelf` 被那些外部字节数抬高。两条都被断言
 *       （Req 7.2、4.8）；
 *   (c) 非空验证：同一个 analyzer 实例在**显式**动作（`getSummary({force:true})`）后
 *       readdir 次数恒 > 0 且确实枚举到了其它工作区的目录——故 (a) 的「恒 0 次」不是
 *       因为夹具里没东西可枚举，(b) 的「不含其它工作区」也不是因为那些目录不存在。
 *
 * 动作到实现的映射（本特性未改动搜索面板的取数路径，故这里驱动的就是生产路径本身）：
 *   - 视图变为可见 / 点击既有刷新按钮 → `listRecentSessions` / `searchSessionsInDir`
 *     （`SearchSession.runSearch`：空关键词走最近列表，`hardRefresh` 按当前关键词重取）
 *   - 输入关键词                     → `searchSessionsInDir`
 *   - 切换过滤                       → `applyAttachmentFilter`（纯函数，零 IO）
 *   - 无工作区下打开排行页           → `RankingPanel` 收到 `ready` / `refresh`
 *
 * `RankingPanel` 的构造函数是 private 且只依赖 `vscode.WebviewPanel` 的三个方法
 * （`webview.onDidReceiveMessage` / `webview.postMessage` / `onDidDispose` / `dispose`），
 * 而 vscode 在该模块里是惰性 `require`（只在 `showOrCreate` 里求值），因此这里用一个
 * 结构化的假面板直接构造真实的 `RankingPanel`，驱动的是**实现自己**的五态取数核心，
 * 而不是测试侧的复刻品。
 * ------------------------------------------------------------------ */

import { RankingPanel, type RankingPanelDeps } from '../src/storage/ranking';
// ArchiveIndex 是进程内全局缓存：每轮必须清空，否则上一轮临时目录的条目会被
// `listArchiveEntries`（它遍历整个 cache）带进本轮结果，把跨工作区断言污染成假绿。
import { __clearCreditCacheForTest, listArchiveEntries } from '../src/credits';
import {
  __clearIndexCacheForTest,
  listRecentSessions,
  searchSessionsInDir,
  type SearchHit,
} from '../src/search';
import { applyAttachmentFilter, type AttachmentFilterMode } from '../src/webview/filter';

/** 固定时钟：使 60 秒 StorageCache 恒不过期（本属性只在最后一步显式强制刷新）。 */
const P15_FIXED_NOW = 1_700_000_000_000;

/** 当前工作区的会话 id 池（彼此无大小写冲突，避免大小写不敏感文件系统上撞文件）。 */
const P15_SESSION_POOL = ['p15-sess-a', 'p15-sess-b', 'p15-sess-c'] as const;

/** 其它工作区的会话 id 池：恒不应出现在任何一条结果里。 */
const P15_OTHER_SESSION_POOL = ['p15-alien-x', 'p15-alien-y'] as const;

/** 会话正文池：前两条含可命中的关键词，第三条恒不命中。 */
const P15_TEXT_POOL = [
  '讨论 kiro 存储占用的口径',
  'alpha 项目的排期与风险',
  '与关键词无关的闲聊正文',
] as const;

/** 关键词池：命中 / 不命中 / 空串 / 纯空白（后两者走「切回最近列表」分支）。 */
const P15_KEYWORDS = ['kiro', 'alpha', 'zzz-no-match', '', '   '] as const;

/** 五种非显式动作。 */
type P15Kind = 'visible' | 'keyword' | 'filter' | 'refresh' | 'rankingNoWorkspace';

const P15_KINDS: readonly P15Kind[] = [
  'visible',
  'keyword',
  'filter',
  'refresh',
  'rankingNoWorkspace',
];

/** 每步动作携带自己的关键词与过滤模式。 */
interface P15Step {
  kind: P15Kind;
  keyword: string;
  mode: AttachmentFilterMode;
}

/**
 * 动作序列：先是**五种动作的一个随机排列**（保证每轮都覆盖全部动作变体，Property 15
 * 的「动作序列覆盖」要求），再追加 0~3 步随机重复（覆盖同一动作连发与交错）。
 */
const p15StepsArb: fc.Arbitrary<P15Step[]> = fc
  .tuple(
    fc.shuffledSubarray([...P15_KINDS], {
      minLength: P15_KINDS.length,
      maxLength: P15_KINDS.length,
    }),
    fc.array(fc.constantFrom(...P15_KINDS), { maxLength: 3 }),
    fc.array(fc.constantFrom(...P15_KEYWORDS), { minLength: 8, maxLength: 8 }),
    fc.array(fc.constantFrom('all', 'image', 'attachment'), { minLength: 8, maxLength: 8 })
  )
  .map(([perm, extra, keywords, modes]) =>
    [...perm, ...extra].map((kind, i) => ({
      kind,
      keyword: keywords[i % keywords.length],
      mode: modes[i % modes.length] as AttachmentFilterMode,
    }))
  );

/** 当前工作区的会话夹具。 */
interface P15Session {
  sessionId: string;
  text: string;
  hasImage: boolean;
  hasAttachment: boolean;
}

/** `minLength === maxLength === 池大小` + filter：覆盖「0 个会话」到「全部会话」。 */
const p15SessionsArb: fc.Arbitrary<P15Session[]> = fc
  .array(
    fc.record({
      include: fc.boolean(),
      text: fc.constantFrom(...P15_TEXT_POOL),
      hasImage: fc.boolean(),
      hasAttachment: fc.boolean(),
    }),
    { minLength: P15_SESSION_POOL.length, maxLength: P15_SESSION_POOL.length }
  )
  .map((items) =>
    items
      .map((it, i) => ({ ...it, sessionId: P15_SESSION_POOL[i] }))
      .filter((it) => it.include)
      .map(({ sessionId, text, hasImage, hasAttachment }) => ({
        sessionId,
        text,
        hasImage,
        hasAttachment,
      }))
  );

/** 存档夹具：归属会话 + 填充字节数。 */
interface P15ArchiveSpec {
  owner: string;
  pad: number;
}

/** 当前工作区的存档：含命中会话与不命中任何会话（`p15-nobody`）两种归属。 */
const p15ArchivesArb: fc.Arbitrary<P15ArchiveSpec[]> = fc.array(
  fc.record({
    owner: fc.oneof(
      { weight: 4, arbitrary: fc.constantFrom(...P15_SESSION_POOL) },
      { weight: 1, arbitrary: fc.constant('p15-nobody') }
    ),
    pad: fc.integer({ min: 0, max: 512 }),
  }),
  { maxLength: 4 }
);

/**
 * 其它工作区的存档（跨工作区泄漏探针）：`owner` 恒取**当前工作区**的会话 id、
 * `pad` 恒 ≥ 64，因此一旦枚举越界，`archiveBytesSelf` 必然被抬高、
 * ArchiveIndex 快照里也必然出现其它工作区的路径。`minLength: 1` 保证探针恒被布设。
 */
const p15ForeignArchivesArb: fc.Arbitrary<P15ArchiveSpec[]> = fc.array(
  fc.record({
    owner: fc.constantFrom(...P15_SESSION_POOL),
    pad: fc.integer({ min: 64, max: 512 }),
  }),
  { minLength: 1, maxLength: 3 }
);

/**
 * 执行存档内容：`chatSessionId` 以 credit 索引的正则（`"chatSessionId"\s*:\s*"..."`）
 * 可提取的形态写入，`pad` 决定文件字节数。文件名恒为 hex32，否则不被 ArchiveIndex 收录。
 */
function p15ArchiveContent(spec: P15ArchiveSpec): Buffer {
  return Buffer.from(
    `{"chatSessionId":"${spec.owner}","pad":"${'x'.repeat(spec.pad)}"}`,
    'utf8'
  );
}

/**
 * 会话 JSON：带 `workspacePath`（搜索路径据此把 ArchiveIndex 刷新限定到当前工作区的
 * workspaceId 目录——这正是被断言的收窄机制），带正文、可选内嵌图片与 contextItems 附件
 * （供「切换过滤」动作有真实可过滤的数据）。刻意**不**写 `executionId`，
 * 使 lineage 口径的种子集合恒只有会话自身，两个口径的期望值一致、断言无歧义。
 */
function p15SessionContent(s: P15Session, workspacePath: string): string {
  const content: unknown[] = [];
  if (s.hasImage) content.push({ type: 'image', imageUrl: 'inline-image-placeholder' });
  content.push({ type: 'text', text: s.text });
  const item: Record<string, unknown> = { message: { role: 'user', content } };
  if (s.hasAttachment) item.contextItems = [{ path: 'src/a.ts' }];
  return JSON.stringify({ title: `t-${s.sessionId}`, workspacePath, history: [item] });
}

/** 假 WebviewPanel：只实现 `RankingPanel` 真正用到的四个方法。 */
interface P15FakePanel {
  /** 宿主 → webview 的全部出站消息 */
  posted: unknown[];
  /** webview → 宿主：驱动 `RankingPanel.onMessage` */
  send(msg: unknown): void;
  /** 传给 `RankingPanel` 构造函数的面板对象 */
  panel: unknown;
  disposeCount(): number;
}

function p15FakePanel(): P15FakePanel {
  const posted: unknown[] = [];
  const handlers: Array<(raw: unknown) => void> = [];
  let disposed = 0;
  const noop = { dispose: () => {} };
  const register = (
    listener: (raw: unknown) => void,
    _thisArgs?: unknown,
    disposables?: Array<{ dispose(): void }>
  ) => {
    handlers.push(listener);
    disposables?.push(noop);
    return noop;
  };

  const panel = {
    webview: {
      onDidReceiveMessage: register,
      postMessage: (m: unknown) => {
        posted.push(m);
        return Promise.resolve(true);
      },
    },
    onDidDispose: register,
    dispose: () => {
      disposed++;
    },
  };

  return {
    posted,
    send: (msg: unknown) => {
      for (const h of handlers) h(msg);
    },
    panel,
    disposeCount: () => disposed,
  };
}

/**
 * `RankingPanel` 的构造签名（private 构造函数只是编译期约束，运行时是普通构造函数）。
 * 用局部类型别名而不是 `any`，保证这段仍受类型检查约束。
 */
type P15RankingPanelCtor = new (
  panel: unknown,
  deps: RankingPanelDeps
) => { dispose(): void; refresh(opts?: { force?: boolean }): Promise<void> };

/** 剥注释：只读/不枚举的约束说明里正列着 `scanTree` 等词，静态审查必须先剥掉。 */
function p15StripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

// Feature: storage-usage-analytics, Property 15: 非显式动作恒不触发全量枚举
// Validates: Requirements 4.2, 4.8, 7.2, 7.7, 7.12, 13.16
describe('Property 15: 非显式动作恒不触发全量枚举', () => {
  let base: string | null = null;
  let seq = 0;

  afterEach(() => {
    __clearCreditCacheForTest();
    __clearIndexCacheForTest();
    if (base) rmTempDir(base);
    base = null;
  });

  it('Property 15: 任意「视图可见 / 输入关键词 / 切换过滤 / 点击刷新 / 无工作区打开排行页」动作序列后，scanTree 调用次数恒为 0、排行页取数恒未被调用，且角标取数访问的路径恒不含其它工作区目录', async () => {
    base = mkTempDir('kcs-analyzer-implicit-');
    const fixtureBase = base;

    await fc.assert(
      fc.asyncProperty(
        workspacePath2Arb,
        p15SessionsArb,
        p15ArchivesArb,
        p15ForeignArchivesArb,
        p15StepsArb,
        async (workspacePath, sessions, archiveSpecs, foreignSpecs, steps) => {
          // 进程内全局缓存逐轮归零（ArchiveIndex 与会话索引都是模块级 Map）
          __clearCreditCacheForTest();
          __clearIndexCacheForTest();

          const runDir = path.join(fixtureBase, `r${seq++}`);
          const userDataDir = path.join(runDir, 'Kiro');
          const roots = buildClassifyRoots(userDataDir);

          // ---- 当前工作区 ----
          const sessionDir = path.join(roots.sessionsRoot, encodeWorkspaceKeys(workspacePath)[0]);
          const workspaceStoreDir = path.join(
            roots.storeRoot,
            workspaceIdCandidates(workspacePath)[0]
          );
          const savesDir = path.join(workspaceStoreDir, roots.savesBucket);

          // ---- 其它工作区（同一 StoreRoot 下的另一份落点，恒不该被碰）----
          const otherWorkspacePath = `${workspacePath}-other`;
          const otherSessionDir = path.join(
            roots.sessionsRoot,
            encodeWorkspaceKeys(otherWorkspacePath)[0]
          );
          const otherStoreDir = path.join(
            roots.storeRoot,
            workspaceIdCandidates(otherWorkspacePath)[0]
          );
          const otherSavesDir = path.join(otherStoreDir, roots.savesBucket);

          // ---- 夹具：当前工作区的会话文件 + 清单 ----
          fs.mkdirSync(sessionDir, { recursive: true });
          const jsonBytesById = new Map<string, number>();
          for (const s of sessions) {
            const full = path.join(sessionDir, `${s.sessionId}.json`);
            fs.writeFileSync(full, p15SessionContent(s, workspacePath), 'utf8');
            jsonBytesById.set(s.sessionId, fs.statSync(full).size);
          }
          fs.writeFileSync(
            path.join(sessionDir, 'sessions.json'),
            JSON.stringify(
              sessions.map((s) => ({ sessionId: s.sessionId, title: `manifest-${s.sessionId}` }))
            ),
            'utf8'
          );

          // ---- 夹具：当前工作区的执行存档 ----
          fs.mkdirSync(savesDir, { recursive: true });
          const archives: ArchiveInfo[] = archiveSpecs.map((spec, i) => {
            const name = hash32(`p15-cur-${i}`);
            const full = path.join(savesDir, name);
            const buf = p15ArchiveContent(spec);
            fs.writeFileSync(full, buf);
            return { path: full, name, size: buf.length, chatSessionId: spec.owner };
          });

          // 期望值（测试侧独立求和）：只有**当前工作区**的存档才归因到会话
          const selfBytesById = new Map<string, number>();
          const selfCountById = new Map<string, number>();
          for (const id of P15_SESSION_POOL) {
            const mine = archives.filter((a) => a.chatSessionId === id);
            selfBytesById.set(
              id,
              mine.reduce((sum, a) => sum + a.size, 0)
            );
            selfCountById.set(id, mine.length);
          }

          // ---- 夹具：其它工作区的会话与存档（跨工作区泄漏探针）----
          fs.mkdirSync(otherSessionDir, { recursive: true });
          for (const alien of P15_OTHER_SESSION_POOL) {
            fs.writeFileSync(
              path.join(otherSessionDir, `${alien}.json`),
              p15SessionContent(
                { sessionId: alien, text: P15_TEXT_POOL[0], hasImage: true, hasAttachment: true },
                otherWorkspacePath
              ),
              'utf8'
            );
          }
          fs.mkdirSync(otherSavesDir, { recursive: true });
          const foreignArchivePaths = foreignSpecs.map((spec, i) => {
            const full = path.join(otherSavesDir, hash32(`p15-other-${i}`));
            fs.writeFileSync(full, p15ArchiveContent(spec));
            return full;
          });
          // 探针必须真的存在且字节数 > 0，否则「不含其它工作区」会退化成废话
          for (const p of foreignArchivePaths) {
            expect(fs.statSync(p).size).toBeGreaterThan(0);
          }
          // 日志目录：显式动作的整树枚举会碰到它，非显式动作恒不会
          fs.mkdirSync(roots.logsDir, { recursive: true });
          fs.writeFileSync(path.join(roots.logsDir, 'main.log'), Buffer.alloc(128, 0x6c));

          // ---- 记录型只读 fs：scanTree 触碰磁盘的唯一途径 ----
          const { deps, calls } = recordingReadFs();
          const analyzer = new StorageAnalyzer({
            pathResolver: pathResolverFor(runDir),
            workspacePath,
            fsDeps: deps,
            listArchives: () => archives,
            now: () => P15_FIXED_NOW,
          });

          // 排行页取数计数器：包在**真实** analyzer 外面，一旦被调用就会产生 readdir，
          // 因此「计数为 0」与「calls 为空」互为交叉校验（Req 13.16）
          let rankingRowsCalls = 0;
          const rankingDeps: RankingPanelDeps = {
            analyzer: {
              async getRankingRows(opts: { force: boolean }) {
                rankingRowsCalls++;
                const r = await analyzer.getRankingRows(opts);
                return { rows: r.rows, partial: r.partial, skippedCount: r.skippedCount };
              },
            },
            cleaner: {
              run: () => Promise.reject(new Error('P15: 非显式动作不应触发清理')),
            },
            // 无工作区：排行页恒进入 no-workspace 态且绝不枚举目录（Req 13.16）
            workspacePath: null,
            log: () => {},
          };
          const RankingPanelCtor = RankingPanel as unknown as P15RankingPanelCtor;

          // ---- 逐步执行动作序列 ----
          const observed: SearchHit[] = [];
          const openedPanels: Array<{ dispose(): void }> = [];
          const panelStates: P15FakePanel[] = [];
          let lastKeyword = '';
          let lastHits: SearchHit[] = [];

          const fetchFor = (keyword: string): SearchHit[] => {
            const trimmed = keyword.trim();
            lastKeyword = trimmed;
            // `SearchSession.runSearch`：空关键词切回最近列表，否则按关键词搜索
            return trimmed ? searchSessionsInDir(sessionDir, trimmed, 10) : listRecentSessions(sessionDir, 20);
          };

          for (const step of steps) {
            switch (step.kind) {
              case 'visible':
                // 视图变为可见：SummaryBar 置 IdleState，只重取结果（Req 4.2）
                lastHits = fetchFor('');
                observed.push(...lastHits);
                break;
              case 'keyword':
                // 输入关键词（Req 7.7）
                lastHits = fetchFor(step.keyword);
                observed.push(...lastHits);
                break;
              case 'filter':
                // 切换过滤：先按当前关键词 revalidate，再在结果集上跑纯函数过滤
                lastHits = fetchFor(lastKeyword);
                observed.push(...lastHits);
                // applyAttachmentFilter 返回的是入参的子序列（同一批对象），故断言其
                // 元素类型仍为 SearchHit 是安全的
                lastHits = applyAttachmentFilter(lastHits, step.mode) as SearchHit[];
                for (const h of lastHits) {
                  if (step.mode === 'image') expect(h.hasImage).toBe(true);
                  if (step.mode === 'attachment') expect(h.hasAttachment).toBe(true);
                }
                break;
              case 'refresh':
                // 点击既有刷新按钮：仅重新取搜索结果，不触发占用统计（Req 4.8）
                lastHits = fetchFor(lastKeyword);
                observed.push(...lastHits);
                break;
              case 'rankingNoWorkspace': {
                // 无工作区下打开排行页：ready 触发首次取数，refresh 再来一次（Req 13.16）
                const fake = p15FakePanel();
                const panel = new RankingPanelCtor(fake.panel, rankingDeps);
                openedPanels.push(panel);
                panelStates.push(fake);
                fake.send({ type: 'ready' });
                fake.send({ type: 'refresh' });
                // no-workspace 分支在任何 await 之前返回，这里仍让出一次微任务以确保
                // 「如果它真的去 await analyzer」也来得及被记录
                await Promise.resolve();
                break;
              }
            }

            // 逐步不变式：任一动作之后都不得出现一次目录枚举
            expect(calls).toEqual([]);
            expect(rankingRowsCalls).toBe(0);
          }

          // ---- (a) scanTree 恒未被调用：注入点上一次调用都没有 ----
          expect(calls).toEqual([]);
          expect(p14OpCount(calls, 'readdir')).toBe(0);
          expect(rankingRowsCalls).toBe(0);

          // ---- 无工作区排行页：恒只 post no-workspace，结构不变、绝不取数 ----
          for (const fake of panelStates) {
            expect(fake.posted.length).toBeGreaterThan(0);
            for (const m of fake.posted) {
              expect(m).toEqual({ type: 'state', state: 'no-workspace' });
            }
          }

          // ---- (b) 角标取数访问的路径集合恒不含其它工作区目录 ----
          // ArchiveIndex 快照即「本次枚举实际收录到的存档路径集合」：在 4 秒节流窗口内
          // 本调用不会重扫，读出的就是搜索路径刚刚建立的那份；若本轮没有任何结果集取数
          // （0 个会话），本调用自己按同一收窄口径扫一次，结论同样成立。
          const indexed = listArchiveEntries(roots.storeRoot, { workspacePath }).map((a) =>
            path.normalize(a.path)
          );
          for (const p of indexed) {
            expect(isUnder(otherStoreDir, p)).toBe(false);
            expect(isUnder(otherSessionDir, p)).toBe(false);
            expect(isUnder(workspaceStoreDir, p)).toBe(true);
          }
          const normalizedForeign = new Set(foreignArchivePaths.map((p) => path.normalize(p)));
          for (const p of indexed) expect(normalizedForeign.has(p)).toBe(false);
          // 更强的等式形态（顺带保证上面的逐条断言不是在空集合上循环）：
          // 收录到的路径集合恒**恰好**是当前工作区的那批存档，一个不多一个不少
          expect(new Set(indexed)).toEqual(new Set(archives.map((a) => path.normalize(a.path))));

          // ---- 结果集恒不含其它工作区的会话，角标数值恒不含其它工作区的字节数 ----
          const currentIds = new Set(sessions.map((s) => s.sessionId));
          for (const hit of observed) {
            expect(currentIds.has(hit.sessionId)).toBe(true);
            expect(P15_OTHER_SESSION_POOL as readonly string[]).not.toContain(hit.sessionId);
            expect(hit.sessionJsonBytes).toBe(jsonBytesById.get(hit.sessionId));
            // 自身与累计两个口径都只应收到当前工作区的存档字节数
            expect(hit.archiveBytesSelf).toBe(selfBytesById.get(hit.sessionId));
            expect(hit.archiveBytesLineage).toBe(selfBytesById.get(hit.sessionId));
            expect(hit.archivesFound).toBe((selfCountById.get(hit.sessionId) ?? 0) > 0);
          }

          // ---- (c) 非空验证：同一实例在显式动作后确实做了全量枚举 ----
          const summary = await analyzer.getSummary({ force: true });
          expect(summary.status).toBe('ok');
          const readdirArgs = p14PathArgs(calls, 'readdir');
          expect(readdirArgs.length).toBeGreaterThan(0);
          // 且显式枚举确实会走到其它工作区目录 —— 故前面「恒不含其它工作区」是有内容的
          expect(readdirArgs.some((p) => isUnder(otherStoreDir, p))).toBe(true);
          expect(readdirArgs.some((p) => isUnder(otherSessionDir, p))).toBe(true);

          for (const panel of openedPanels) panel.dispose();
        }
      ),
      // 真实临时目录夹具（每轮建两个工作区的目录树 + 一次显式全量枚举）属 IO 密集：
      // 按本文件 Property 2/6/7/14(a) 对真实 fs 夹具的同一放宽取 50 轮，并给显式宽松超时。
      { numRuns: 50 }
    );
  }, 120_000);

  /**
   * 运行期计数只能证明「本次没调用」，静态审查补上「压根调不到」这一层：
   * 搜索面板的取数模块（`src/search.ts`，即角标与结果列表的唯一自动取数路径）
   * 在模块图上连 `scanTree` / `StorageAnalyzer` 都不认识——它只从 analyzer 取
   * 纯函数 `computeSessionFootprint`，存档数据一律来自 ArchiveIndex 的只读快照。
   * 因此「非显式动作触发全量枚举」在该路径上不是靠约定避免，而是不可达（Req 7.12）。
   */
  it('Property 15: 结果集取数路径（src/search.ts）的模块图里恒不出现 scanTree 与 StorageAnalyzer', () => {
    const code = p15StripComments(
      fs.readFileSync(path.resolve(process.cwd(), 'src/search.ts'), 'utf8')
    );

    expect(code).not.toContain('scanTree');
    expect(code).not.toContain('StorageAnalyzer');
    expect(code).not.toContain('SizeScanner');
    expect(code).not.toMatch(/from\s+'\.\/storage\/scanner'/);
    expect(code).not.toMatch(/from\s+'\.\/storage\/(ranking|report|orphan)'/);

    // analyzer 的取用面恒只有零 IO 的归因纯函数
    const analyzerImports = [
      ...code.matchAll(/import\s+\{([^}]+)\}\s+from\s+'\.\/storage\/analyzer'/g),
    ];
    expect(analyzerImports.length).toBe(1);
    expect(
      analyzerImports[0][1]
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    ).toEqual(['computeSessionFootprint']);
  });
});
