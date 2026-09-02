import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { formatSize, sizeBadgeLabel, summaryLabel } from '../src/webview/size';

/** 与实现一致的数值归一：非有限数与负数按 0 计入 */
function num(n: unknown): number {
  return typeof n === 'number' && isFinite(n) && n >= 0 ? n : 0;
}

/** 与实现一致的「可用数值」判据 */
function has(n: unknown): n is number {
  return typeof n === 'number' && isFinite(n) && n >= 0;
}

type Category = { key?: string; label: string; bytes: number; pathHint: string };

// 字节数：正常值 + 缺失 + 非法值（实现按 0 展示）
const bytesArb = fc.oneof(
  fc.integer({ min: 0, max: 4 * 1024 * 1024 * 1024 }),
  fc.constant(undefined),
  fc.constant(-1),
  fc.constant(NaN)
) as fc.Arbitrary<number | undefined>;

const countArb = fc.oneof(
  fc.integer({ min: 0, max: 5000 }),
  fc.constant(undefined),
  fc.constant(-3)
) as fc.Arbitrary<number | undefined>;

// 标签与路径限定为不含 `≥` 与数字的字符，使「`≥` 前缀 ⟺ partial」可判定
const labelArb = fc.stringMatching(/^[A-Za-z \u4e00-\u9fa5]{1,16}$/);
const pathArb = fc.stringMatching(/^[A-Za-z_\-/\\.]{1,24}$/);

const categoryArb: fc.Arbitrary<Category> = fc.record({
  key: fc.oneof(
    fc.constant(undefined),
    fc.constant('sessionJson'),
    fc.constant('executionSaves'),
    fc.constant('other')
  ) as fc.Arbitrary<string | undefined>,
  label: labelArb,
  bytes: fc.integer({ min: 0, max: 1024 * 1024 * 1024 }),
  pathHint: pathArb,
});

const orphanStateArb = fc.constantFrom<'ok' | 'pending' | 'unknown' | undefined>(
  'ok',
  'pending',
  'unknown',
  undefined
);

/** ok 态入参（state 由各用例自行拼接） */
const okOptsArb = fc.record({
  totalBytes: bytesArb,
  resultSetBytes: bytesArb,
  orphanBytes: bytesArb,
  orphanState: orphanStateArb,
  sessionCount: countArb,
  resultCount: countArb,
  jsonBytes: bytesArb,
  archiveBytes: bytesArb,
  categories: fc.oneof(fc.constant(undefined), fc.array(categoryArb, { maxLength: 5 })) as
    fc.Arbitrary<Category[] | undefined>,
  partial: fc.boolean(),
  skippedCount: countArb,
});

const nonOkStateArb = fc.constantFrom<'idle' | 'loading' | 'unavailable' | undefined>(
  'idle',
  'loading',
  'unavailable',
  undefined
);

const NON_OK_TEXT: Record<string, string> = {
  idle: '点击 ⛁ 统计占用',
  loading: '统计中…',
  unavailable: '占用统计不可用',
};

describe('summaryLabel properties', () => {
  // Feature: storage-usage-analytics, Property 10: SummaryBar 输出覆盖三项数值、四态文案与下限标记
  it('Property 10(a): ok 态文本覆盖三项数值，tooltip 覆盖拆解、会话数/结果条数与分类明细', () => {
    fc.assert(
      fc.property(okOptsArb, (opts) => {
        const out = summaryLabel({ state: 'ok', ...opts })!;
        expect(out).not.toBeNull();

        const pfx = opts.partial ? '≥' : '';
        const size = (n: unknown) => pfx + formatSize(num(n));

        // 三项数值恒同时出现在文本中
        expect(out.text).toContain('项目 ' + size(opts.totalBytes));
        expect(out.text).toContain('结果 ' + size(opts.resultSetBytes));
        expect(out.text).toContain('孤儿 ' + size(opts.orphanBytes));

        // tooltip 恒给出会话 JSON 与归因存档的拆解（缺省时回退到对应分类，再缺省按 0）
        const cats = opts.categories ?? [];
        const pickCat = (key: string) => {
          for (const c of cats) if (c && c.key === key && has(c.bytes)) return c.bytes;
          return undefined;
        };
        const jsonBytes = has(opts.jsonBytes) ? opts.jsonBytes : pickCat('sessionJson');
        const archiveBytes = has(opts.archiveBytes) ? opts.archiveBytes : pickCat('executionSaves');
        expect(out.title).toContain(
          '拆解：会话 JSON ' + size(jsonBytes) + ' + 归因存档 ' + size(archiveBytes)
        );

        // tooltip 恒给出参与统计的会话数与结果条数
        expect(out.title).toContain(
          '参与统计的会话数 ' + num(opts.sessionCount) + ' · 结果条数 ' + num(opts.resultCount)
        );

        // 分类明细存在时，恒为每个分类给出标签、格式化字节数与磁盘路径
        for (const c of cats) {
          expect(out.title).toContain(c.label + ' ' + size(c.bytes) + ' — ' + c.pathHint);
        }
      }),
      { numRuns: 100 }
    );
  });

  // Feature: storage-usage-analytics, Property 10: SummaryBar 输出覆盖三项数值、四态文案与下限标记
  it('Property 10(b): idle / loading / unavailable 三态输出固定文案且恒不含任何占用数值', () => {
    fc.assert(
      fc.property(nonOkStateArb, okOptsArb, (state, opts) => {
        const out = summaryLabel({ state, ...opts })!;
        expect(out).not.toBeNull();

        expect(out.text).toBe(NON_OK_TEXT[state ?? 'idle']);
        // 恒不含任何数值：判据为「不含数字」而非不含特定串
        expect(out.text).not.toMatch(/[0-9]/);
        expect(out.title).not.toMatch(/[0-9]/);
        // 也恒不出现下限标记
        expect(out.text).not.toContain('≥');
        expect(out.title).not.toContain('≥');
      }),
      { numRuns: 100 }
    );
  });

  // Feature: storage-usage-analytics, Property 10: SummaryBar 输出覆盖三项数值、四态文案与下限标记
  it('Property 10(c): ok 态输出含 `≥` 与 partial === true 恒等价，partial 时 tooltip 含被跳过条目数', () => {
    fc.assert(
      fc.property(okOptsArb, (opts) => {
        const out = summaryLabel({ state: 'ok', ...opts })!;
        const partial = opts.partial === true;

        expect(out.text.includes('≥')).toBe(partial);
        expect(out.title.includes('≥')).toBe(partial);

        if (partial) {
          expect(out.title).toContain(
            '已跳过 ' + num(opts.skippedCount) + ' 个条目'
          );
        }
      }),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 11: SizeBadge 渲染与鲁棒性
// ---------------------------------------------------------------------------

const WARN_THRESHOLD = 100 * 1024 * 1024;

type BadgeOpts = {
  scope?: 'self' | 'lineage';
  jsonBytes?: number;
  archiveBytesSelf?: number;
  archiveBytesLineage?: number;
  archivesFound?: boolean;
};

const scopeArb = fc.constantFrom<'self' | 'lineage' | undefined>('self', 'lineage', undefined);
const archivesFoundArb = fc.constantFrom<boolean | undefined>(true, false, undefined);

/** 角标入参：字节数覆盖正常值 / 缺失 / 非法值，`archivesFound` 覆盖三态 */
const badgeOptsArb: fc.Arbitrary<BadgeOpts> = fc.record({
  scope: scopeArb,
  jsonBytes: bytesArb,
  archiveBytesSelf: bytesArb,
  archiveBytesLineage: bytesArb,
  archivesFound: archivesFoundArb,
});

/** 偏置到 100MB 警示阈值附近，使 `warn` 的边界被真正覆盖 */
const nearThresholdArb = fc.oneof(
  fc.integer({ min: WARN_THRESHOLD - 2048, max: WARN_THRESHOLD + 2048 }),
  fc.integer({ min: 0, max: 4 * 1024 * 1024 * 1024 }),
  fc.constant(undefined),
  fc.constant(NaN),
  fc.constant(-1)
) as fc.Arbitrary<number | undefined>;

const nearThresholdOptsArb: fc.Arbitrary<BadgeOpts> = fc.record({
  scope: scopeArb,
  jsonBytes: nearThresholdArb,
  archiveBytesSelf: nearThresholdArb,
  archiveBytesLineage: nearThresholdArb,
  archivesFound: archivesFoundArb,
});

/** 与实现一致的口径选择与存档可用性判定，供拆解与阈值断言复用 */
function resolve(opts: BadgeOpts): { jsonBytes: number; archiveBytes: number; unavailable: boolean } | null {
  if (!has(opts.jsonBytes)) return null;
  const scoped = opts.scope === 'lineage' ? opts.archiveBytesLineage : opts.archiveBytesSelf;
  const unavailable = opts.archivesFound === false || !has(scoped);
  return {
    jsonBytes: opts.jsonBytes,
    archiveBytes: unavailable ? 0 : (scoped as number),
    unavailable,
  };
}

/** 抽出 tooltip 中的全部格式化字节数值 */
function sizeTokens(title: string): string[] {
  return title.match(/[0-9]+(?:\.[0-9]+)?(?:B|KB|MB|GB|TB)/g) ?? [];
}

describe('sizeBadgeLabel properties', () => {
  // Feature: storage-usage-analytics, Property 11: SizeBadge 渲染与鲁棒性
  it('Property 11(a): scope 为 self / lineage 时展示值恒等于对应口径的 jsonBytes + archiveBytes', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 4 * 1024 * 1024 * 1024 }),
        fc.integer({ min: 0, max: 4 * 1024 * 1024 * 1024 }),
        fc.integer({ min: 0, max: 4 * 1024 * 1024 * 1024 }),
        fc.constantFrom<boolean | undefined>(true, undefined),
        (jsonBytes, archiveBytesSelf, archiveBytesLineage, archivesFound) => {
          const base = { jsonBytes, archiveBytesSelf, archiveBytesLineage, archivesFound };

          const self = sizeBadgeLabel({ ...base, scope: 'self' })!;
          const lineage = sizeBadgeLabel({ ...base, scope: 'lineage' })!;
          const dflt = sizeBadgeLabel(base)!;

          expect(self.value).toBe(formatSize(jsonBytes + archiveBytesSelf));
          expect(lineage.value).toBe(formatSize(jsonBytes + archiveBytesLineage));
          // scope 缺省恒取 self 口径
          expect(dflt.value).toBe(self.value);
          // 存档可用时 tooltip 恒不含存档不可用说明
          expect(self.title).not.toContain('存档数据不可用');
          expect(lineage.title).not.toContain('存档数据不可用');
        }
      ),
      { numRuns: 100 }
    );
  });

  // Feature: storage-usage-analytics, Property 11: SizeBadge 渲染与鲁棒性
  it('Property 11(b): archivesFound === false 时展示值恒等于 jsonBytes 且 tooltip 恒含存档不可用说明', () => {
    fc.assert(
      fc.property(badgeOptsArb, (opts) => {
        const out = sizeBadgeLabel({ ...opts, archivesFound: false });
        if (!has(opts.jsonBytes)) {
          expect(out).toBeNull();
          return;
        }
        expect(out!.value).toBe(formatSize(opts.jsonBytes));
        expect(out!.title).toContain('存档数据不可用或已被 LRU 索引淘汰');
      }),
      { numRuns: 100 }
    );
  });

  // Feature: storage-usage-analytics, Property 11: SizeBadge 渲染与鲁棒性
  it('Property 11(c): tooltip 恒分行拆解 JSON 与存档字节，且两者之和的格式化结果恒等于角标数值', () => {
    fc.assert(
      fc.property(badgeOptsArb, (opts) => {
        const out = sizeBadgeLabel(opts);
        const exp = resolve(opts);
        if (exp === null) {
          expect(out).toBeNull();
          return;
        }

        const lines = out!.title.split('\n');
        expect(lines[0]).toBe('会话 JSON ' + formatSize(exp.jsonBytes));
        expect(lines[1].startsWith('归因存档')).toBe(true);
        expect(lines[1].endsWith(' ' + formatSize(exp.archiveBytes))).toBe(true);

        // tooltip 恒只出现两个字节数值（JSON 行与存档行），使「两行之和」可判定
        const tokens = sizeTokens(out!.title);
        expect(tokens).toEqual([formatSize(exp.jsonBytes), formatSize(exp.archiveBytes)]);

        // 两行拆解之和的格式化结果恒等于角标数值
        expect(formatSize(exp.jsonBytes + exp.archiveBytes)).toBe(out!.value);
      }),
      { numRuns: 100 }
    );
  });

  // Feature: storage-usage-analytics, Property 11: SizeBadge 渲染与鲁棒性
  it('Property 11(d): warn === true 与「总占用 ≥ 100 MB」恒等价', () => {
    fc.assert(
      fc.property(nearThresholdOptsArb, (opts) => {
        const out = sizeBadgeLabel(opts);
        const exp = resolve(opts);
        if (exp === null) {
          expect(out).toBeNull();
          return;
        }
        expect(out!.warn).toBe(exp.jsonBytes + exp.archiveBytes >= WARN_THRESHOLD);
      }),
      { numRuns: 100 }
    );
  });

  // Feature: storage-usage-analytics, Property 11: SizeBadge 渲染与鲁棒性
  it('Property 11(e): 数值无法取得时恒返回 null，且同一数组中其余条目的角标恒不受影响', () => {
    fc.assert(
      fc.property(fc.array(badgeOptsArb, { minLength: 1, maxLength: 12 }), (list) => {
        const mapped = list.map((o) => sizeBadgeLabel(o));

        const nullIdx = mapped.flatMap((r, i) => (r === null ? [i] : []));
        const missingIdx = list.flatMap((o, i) => (has(o.jsonBytes) ? [] : [i]));
        // null 的位置恒与「jsonBytes 不可取得」的位置一致
        expect(nullIdx).toEqual(missingIdx);

        // 其余位置的角标恒与单独调用的结果相同（互不影响）
        for (let i = 0; i < list.length; i++) {
          if (mapped[i] === null) continue;
          expect(mapped[i]).toEqual(sizeBadgeLabel(list[i]));
        }
      }),
      { numRuns: 100 }
    );
  });
});
