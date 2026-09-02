import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  buildReportData,
  renderStorageReport,
  DEFAULT_SESSION_LIMIT,
  type BuildReportInput,
  type ReportSessionInput,
  type ReportWorkspaceInput,
} from '../src/storage/report';
import { CATEGORY_META, CATEGORY_ORDER } from '../src/storage/classify';
import { decodeWorkspaceKey } from '../src/storage/orphan';
import { encodeWorkspaceKeys } from '../src/paths';
import {
  SIZE_NOTE,
  type CategoryStat,
  type OrphanState,
  type SessionFootprint,
  type StorageCategory,
  type StorageSummary,
} from '../src/storage/types';

// ---------------------------------------------------------------------------
// 报告属性测试的共享生成器（Property 12 / 13 共用，故全部 export）
// ---------------------------------------------------------------------------

/**
 * 字节数取自**很小的池子**：若用宽范围随机数，两行几乎不会撞上「字节数相等」，
 * 排序 tiebreak 与截断边界的断言就会退化成空验证。
 */
export const REPORT_BYTES_POOL = [0, 1, 512, 1024, 4096, 1_048_576] as const;

/** 脏字节数：`buildReportData` / `renderStorageReport` 恒按 0 计，不得污染排序与合计 */
export const DIRTY_BYTES_POOL: readonly number[] = [
  NaN,
  -1,
  -4096,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
];

export const reportBytesArb: fc.Arbitrary<number> = fc.oneof(
  { arbitrary: fc.constantFrom(...REPORT_BYTES_POOL), weight: 6 },
  { arbitrary: fc.constantFrom(...DIRTY_BYTES_POOL), weight: 1 }
);

/** 与被测实现同一口径的「只接受有限正数」规则，用于算期望值 */
export const safeBytes = (n: unknown): number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;

/** 会话 ID 池刻意很小：同 ID / 同字节数的重复行会真实出现，覆盖 tiebreak */
export const SESSION_ID_POOL = ['s-01', 's-02', 's-03', 's-04', 's-05'] as const;

/**
 * 标题池：覆盖普通 / 空 / 纯空白 / 缺省 / 超长（截断）/ 多行（压平）/
 * 与区块标题同形的对抗样本（用来确认区块识别不被数据文本冒充）。
 */
export const REPORT_TITLE_POOL: ReadonlyArray<string | undefined> = [
  '重构存储模块',
  '',
  '   ',
  undefined,
  'A'.repeat(200),
  '第一行\n第二行\t第三行',
  '【4】孤儿存档合计',
  '【3】按会话排行（自身口径，可相加 · 前 50 条，省略 0 条）',
];

export const reportTitleArb: fc.Arbitrary<string | undefined> = fc.constantFrom(
  ...REPORT_TITLE_POOL
);

/**
 * footprint 生成器：**刻意混入 lineage 口径与 `additive: false`**，
 * 并让 `totalBytes` 与两个分量不一致，用来断言 `buildReportData` 恒归一为
 * 自身口径并重算合计（Requirement 6.9）。
 */
export const sessionFootprintArb = (sessionId: string): fc.Arbitrary<SessionFootprint> =>
  fc
    .record({
      sessionId: fc.constantFrom(sessionId, ...SESSION_ID_POOL),
      scope: fc.constantFrom<SessionFootprint['scope']>('self', 'lineage'),
      additive: fc.boolean(),
      jsonBytes: reportBytesArb,
      archiveBytes: reportBytesArb,
      totalBytes: reportBytesArb,
      archivesFound: fc.boolean(),
    })
    .map((fp) => fp as SessionFootprint);

export const reportSessionInputArb: fc.Arbitrary<ReportSessionInput> = fc
  .tuple(fc.constantFrom(...SESSION_ID_POOL), reportTitleArb)
  .chain(([sessionId, title]) =>
    sessionFootprintArb(sessionId).map((footprint) => ({ sessionId, title, footprint }))
  );

const fixedLengthSessionsArb = (n: number): fc.Arbitrary<ReportSessionInput[]> =>
  fc.array(reportSessionInputArb, { minLength: n, maxLength: n });

/**
 * 会话列表生成器：必须**跨过 `sessionLimit` 的边界**，否则截断与「省略 N 条」
 * 两条断言退化为空验证。显式混入 0 / 1 / 49 / 50 / 51 / 120 条，
 * 其中 0 条同时是 Requirement 6.4 的空态样本。
 */
export const reportSessionsArb: fc.Arbitrary<ReportSessionInput[]> = fc.oneof(
  fixedLengthSessionsArb(0),
  fixedLengthSessionsArb(1),
  fixedLengthSessionsArb(DEFAULT_SESSION_LIMIT - 1),
  fixedLengthSessionsArb(DEFAULT_SESSION_LIMIT),
  fixedLengthSessionsArb(DEFAULT_SESSION_LIMIT + 1),
  fixedLengthSessionsArb(120),
  fc.array(reportSessionInputArb, { maxLength: 60 })
);

/** 工作区绝对路径池（Property 13 的往返样本同源） */
export const WORKSPACE_PATH_POOL = [
  'D:\\Projects\\KiroExt\\KiroChatSearcher',
  'C:\\work\\a',
  '/home/u/proj',
  '\\\\server\\share\\proj',
] as const;

/** 目录名池：可解码的 EncodedKey + 不可解码 / 空目录名 */
export const workspaceDirNameArb: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(...WORKSPACE_PATH_POOL).map((p) => encodeWorkspaceKeys(p)[0]),
  fc.constantFrom('not-a-key', 'zzzz', 'AAAA', '一二三', '')
);

export const reportWorkspaceInputArb: fc.Arbitrary<ReportWorkspaceInput> = fc.record({
  dirName: workspaceDirNameArb,
  decodedPath: fc.oneof(
    fc.constant(undefined),
    fc.constant(null),
    fc.constantFrom(...WORKSPACE_PATH_POOL)
  ),
  sessionBytes: reportBytesArb,
  execBytes: fc.oneof(fc.constant(undefined), reportBytesArb),
});

/** 工作区列表：显式覆盖空列表与「序号宽度 > 1」（≥ 10 个工作区） */
export const reportWorkspacesArb: fc.Arbitrary<ReportWorkspaceInput[]> = fc.oneof(
  fc.constant([] as ReportWorkspaceInput[]),
  fc.array(reportWorkspaceInputArb, { maxLength: 6 }),
  fc.array(reportWorkspaceInputArb, { minLength: 10, maxLength: 13 })
);

/** 分类明细：用 subarray 覆盖「缺分类」的输入，报告仍恒渲染全部 7 个分类行 */
export const categoriesArb: fc.Arbitrary<CategoryStat[]> = fc
  .subarray([...CATEGORY_ORDER] as StorageCategory[])
  .chain((keys) =>
    fc
      .array(fc.tuple(reportBytesArb, reportBytesArb), {
        minLength: keys.length,
        maxLength: keys.length,
      })
      .map((pairs) =>
        keys.map((k, i) => ({
          category: k,
          label: CATEGORY_META[k].label,
          pathHint: CATEGORY_META[k].pathHint,
          note: CATEGORY_META[k].note,
          bytes: pairs[i][0],
          files: pairs[i][1],
        }))
      )
  );

export const storageSummaryArb: fc.Arbitrary<StorageSummary> = fc.record({
  status: fc.constantFrom<StorageSummary['status']>('ok', 'unavailable'),
  userDataDir: fc.oneof(
    fc.constant(null),
    fc.constantFrom('C:\\Users\\u\\AppData\\Roaming\\Kiro', '/home/u/.config/Kiro')
  ),
  totalBytes: reportBytesArb,
  totalFiles: reportBytesArb,
  categories: categoriesArb,
  currentWorkspaceBytes: reportBytesArb,
  projectFootprintTotal: reportBytesArb,
  orphan: fc.record({
    state: fc.constantFrom<OrphanState>('ok', 'pending', 'unknown'),
    bytes: reportBytesArb,
    files: reportBytesArb,
    note: fc.constantFrom('', '孤儿存档不提供批量清理入口'),
  }),
  // partial 两值都要覆盖：为 true 时全部数值加 ≥ 前缀，区块结构不得因此改变
  partial: fc.boolean(),
  skippedCount: reportBytesArb,
  sessionCount: reportBytesArb,
  sizeNote: fc.constantFrom('', SIZE_NOTE),
  scannedAt: fc.integer({ min: 0, max: 1_700_000_000_000 }),
}) as fc.Arbitrary<StorageSummary>;

/** `sessionLimit`：缺省 / 显式小值 / 0 / 超过总条数 / 非法值 */
export const sessionLimitArb: fc.Arbitrary<number | undefined> = fc.oneof(
  fc.constant(undefined),
  fc.constantFrom(0, 1, 3, 10, DEFAULT_SESSION_LIMIT, 120),
  fc.constantFrom(-1, -50, NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 2.7)
);

/** 与被测实现同一口径的 limit 归一规则（非法值回退 50） */
export const expectedSessionLimit = (raw: number | undefined): number =>
  typeof raw === 'number' && Number.isFinite(raw) && raw >= 0
    ? Math.floor(raw)
    : DEFAULT_SESSION_LIMIT;

export const buildReportInputArb: fc.Arbitrary<BuildReportInput> = fc.record({
  summary: storageSummaryArb,
  workspaces: reportWorkspacesArb,
  sessions: reportSessionsArb,
  sessionLimit: sessionLimitArb,
});

// ---------------------------------------------------------------------------
// 区块定位辅助：按**整行前缀**识别区块标题
// ---------------------------------------------------------------------------

/** 四区块标题的固定前缀，顺序即要求的展示顺序（Requirement 6.2） */
export const BLOCK_PREFIXES = [
  '【1】分类构成',
  '【2】按工作区排行',
  '【3】按会话排行',
  '【4】孤儿存档合计',
] as const;

/**
 * 每个区块标题在整行维度恒出现且只出现一次。
 * 数据行恒以两个空格缩进，因此标题与数据文本不会互相冒充
 * （生成器里刻意放了与区块标题同形的会话标题来检验这一点）。
 */
function blockHeaderIndexes(lines: readonly string[]): number[] {
  return BLOCK_PREFIXES.map((prefix) => {
    const hits: number[] = [];
    lines.forEach((line, i) => {
      if (line.startsWith(prefix)) hits.push(i);
    });
    expect(hits.length).toBe(1);
    return hits[0];
  });
}

/** 区块体：标题之后到首个空行（或文本结尾）之间的行 */
function blockBody(lines: readonly string[], headerIndex: number): string[] {
  const body: string[] = [];
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    if (lines[i] === '') break;
    body.push(lines[i]);
  }
  return body;
}

const renderLines = (input: BuildReportInput) => {
  const data = buildReportData(input);
  const lines = renderStorageReport(data, new Date(1_700_000_000_000)).split('\n');
  return { data, lines, idx: blockHeaderIndexes(lines) };
};

describe('storage report structure properties', () => {
  // Feature: storage-usage-analytics, Property 12: 报告结构不变量
  it('Property 12(a): 四区块恒存在、顺序恒定，且不因工作区/会话列表为空而消失', () => {
    fc.assert(
      fc.property(buildReportInputArb, (input) => {
        const { data, lines, idx } = renderLines(input);

        // 顺序恒为 分类构成 → 按工作区排行 → 按会话排行 → 孤儿存档合计
        expect(idx[0]).toBeLessThan(idx[1]);
        expect(idx[1]).toBeLessThan(idx[2]);
        expect(idx[2]).toBeLessThan(idx[3]);

        // 【1】恒渲染全部 7 个分类行（summary.categories 缺项时按 0 补，行不消失）
        const catBody = blockBody(lines, idx[0]);
        expect(catBody.length).toBe(CATEGORY_ORDER.length);
        CATEGORY_ORDER.forEach((key, i) => {
          expect(catBody[i]).toContain(CATEGORY_META[key].label);
          expect(catBody[i]).toContain(CATEGORY_META[key].pathHint);
        });

        // 【2】【3】的标题恒带计数，区块体行数恒等于数据行数（含 0 行的空态）
        expect(lines[idx[1]]).toBe(
          '【2】按工作区排行（共 ' + data.workspaces.length + ' 个工作区）'
        );
        expect(blockBody(lines, idx[1]).length).toBe(data.workspaces.length);
        expect(lines[idx[2]]).toBe(
          '【3】按会话排行（自身口径，可相加 · 前 ' +
            data.sessionLimit +
            ' 条，省略 ' +
            data.omittedSessions +
            ' 条）'
        );
        expect(blockBody(lines, idx[2]).length).toBe(data.sessions.length);

        // 空态：区块标题仍在、区块体为空，且不以提示文案替换（Requirement 6.4）
        if (input.workspaces.length === 0) {
          expect(blockBody(lines, idx[1])).toEqual([]);
        }
        if (input.sessions.length === 0) {
          expect(blockBody(lines, idx[2])).toEqual([]);
          expect(data.omittedSessions).toBe(0);
          expect(lines[idx[2]]).toContain('省略 0 条');
        }

        // 【4】恒有合计行；partial 为 true 时数值带 ≥ 前缀
        const orphanLine = lines[idx[3] + 1];
        expect(orphanLine).toContain('个文件');
        expect(orphanLine.includes('≥')).toBe(input.summary.partial === true);
      }),
      { numRuns: 100 }
    );
  });

  // Feature: storage-usage-analytics, Property 12: 报告结构不变量
  it('Property 12(b): 工作区行恒按字节数降序，bytes 恒等于会话与执行数据之和', () => {
    fc.assert(
      fc.property(buildReportInputArb, (input) => {
        const { data, lines, idx } = renderLines(input);

        expect(data.workspaces.length).toBe(input.workspaces.length);
        for (let i = 1; i < data.workspaces.length; i += 1) {
          expect(data.workspaces[i - 1].bytes).toBeGreaterThanOrEqual(data.workspaces[i].bytes);
        }
        // 展示的字节数恒是两个分量之和，且脏值按 0 计（不出现 NaN）
        const expectedBytes = input.workspaces
          .map((w) => safeBytes(w.sessionBytes) + safeBytes(w.execBytes))
          .sort((a, b) => b - a);
        expect(data.workspaces.map((w) => w.bytes)).toEqual(expectedBytes);
        data.workspaces.forEach((w) => {
          expect(w.bytes).toBe(w.sessionBytes + w.execBytes);
          expect(Number.isFinite(w.bytes)).toBe(true);
        });

        // 渲染顺序与数据顺序恒一致，序号从 1 递增
        const body = blockBody(lines, idx[1]);
        body.forEach((line, i) => {
          expect(line.trim().startsWith(String(i + 1) + '. ')).toBe(true);
          expect(line).toContain(data.workspaces[i].display);
        });
      }),
      { numRuns: 100 }
    );
  });

  // Feature: storage-usage-analytics, Property 12: 报告结构不变量
  it('Property 12(c): 会话行恒按自身口径字节数降序，且恒是全量降序序列的前 N 项', () => {
    fc.assert(
      fc.property(buildReportInputArb, (input) => {
        const { data, lines, idx } = renderLines(input);

        for (let i = 1; i < data.sessions.length; i += 1) {
          expect(data.sessions[i - 1].footprint.totalBytes).toBeGreaterThanOrEqual(
            data.sessions[i].footprint.totalBytes
          );
        }

        const allBytes = input.sessions
          .map((s) => safeBytes(s.footprint.jsonBytes) + safeBytes(s.footprint.archiveBytes))
          .sort((a, b) => b - a);
        const shown = Math.min(allBytes.length, expectedSessionLimit(input.sessionLimit));
        expect(data.sessions.map((r) => r.footprint.totalBytes)).toEqual(
          allBytes.slice(0, shown)
        );

        // 渲染顺序与数据顺序恒一致（序号 + 会话 ID 逐行对齐）
        const body = blockBody(lines, idx[2]);
        body.forEach((line, i) => {
          expect(line.trim().startsWith(String(i + 1) + '. ')).toBe(true);
          expect(line).toContain('（' + data.sessions[i].sessionId + '）');
        });
      }),
      { numRuns: 100 }
    );
  });

  // Feature: storage-usage-analytics, Property 12: 报告结构不变量
  it('Property 12(d): 行数恒 ≤ sessionLimit，省略数恒等于总条数减展示条数', () => {
    fc.assert(
      fc.property(buildReportInputArb, (input) => {
        const { data, lines, idx } = renderLines(input);
        const limit = expectedSessionLimit(input.sessionLimit);

        // 非法 / 缺省 limit 恒回退 50
        expect(data.sessionLimit).toBe(limit);
        if (input.sessionLimit === undefined || !Number.isFinite(input.sessionLimit as number)) {
          expect(data.sessionLimit).toBe(DEFAULT_SESSION_LIMIT);
        }

        expect(data.sessions.length).toBeLessThanOrEqual(data.sessionLimit);
        expect(data.omittedSessions).toBe(input.sessions.length - data.sessions.length);
        expect(data.omittedSessions).toBeGreaterThanOrEqual(0);
        // 展示条数恒取「总条数」与「limit」的较小者，超限时才有省略
        expect(data.sessions.length).toBe(Math.min(input.sessions.length, limit));
        expect(data.omittedSessions > 0).toBe(input.sessions.length > limit);

        // 标题里的 N 恒与 omittedSessions 一致，渲染行数恒等于展示条数
        expect(lines[idx[2]]).toContain('省略 ' + data.omittedSessions + ' 条');
        expect(blockBody(lines, idx[2]).length).toBe(data.sessions.length);
      }),
      { numRuns: 100 }
    );
  });

  // Feature: storage-usage-analytics, Property 12: 报告结构不变量
  it('Property 12(e): 会话行口径恒为 self（additive === true）且合计恒等于两分量之和', () => {
    fc.assert(
      fc.property(buildReportInputArb, (input) => {
        const { data, lines, idx } = renderLines(input);

        data.sessions.forEach((row) => {
          const fp = row.footprint;
          // 即使输入是 lineage / additive: false，报告行也恒被归一为自身口径
          expect(fp.scope).toBe('self');
          expect(fp.additive).toBe(true);
          expect(fp.totalBytes).toBe(fp.jsonBytes + fp.archiveBytes);
          expect(fp.jsonBytes).toBeGreaterThanOrEqual(0);
          expect(fp.archiveBytes).toBeGreaterThanOrEqual(0);
          expect(Number.isFinite(fp.totalBytes)).toBe(true);
          // 标题恒压成单行且非空，不破坏「一行一条」的结构
          expect(row.title.length).toBeGreaterThan(0);
          expect(row.title).not.toContain('\n');
        });

        // 区块标题恒声明自身口径，且渲染文本不出现「累计口径」字样
        expect(lines[idx[2]]).toContain('自身口径，可相加');
        expect(lines.join('\n')).not.toContain('累计口径');
      }),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 13 专属生成器：常规工作区绝对路径 与 不可解码目录名
// ---------------------------------------------------------------------------

/**
 * 路径段池：覆盖 ASCII / 含空格 / 中文 / 含点与连字符下划线，且**长度各异**——
 * base64 的 padding 位数由字节数 mod 3 决定，段长参差才能让 0 / 1 / 2 三种
 * padding（即尾部 0 / 1 / 2 个 `_`）都被真实覆盖。这正是 `decodeWorkspaceKey`
 * 「按 padding 从多到少尝试」那段逻辑的输入空间。
 */
export const PATH_SEGMENT_POOL = [
  'Projects',
  'KiroExt',
  'KiroChatSearcher',
  'my app',
  '中文目录',
  '源码 v2',
  'a',
  'bb',
  'ccc',
  'x.y-z',
  '_tmp',
] as const;

/** 根前缀池：Windows 盘符（含大小写与两种斜杠）、POSIX、UNC */
export const WORKSPACE_ROOT_POOL = [
  { prefix: 'C:\\', sep: '\\' },
  { prefix: 'd:\\', sep: '\\' },
  { prefix: 'C:/', sep: '/' },
  { prefix: '/', sep: '/' },
  { prefix: '/home/u/', sep: '/' },
  { prefix: '\\\\server\\share\\', sep: '\\' },
] as const;

/**
 * **常规**工作区绝对路径生成器。
 *
 * 刻意不构造以 `?` 结尾的路径：`encodeWorkspaceKeys` 把 `/` 与 `=` padding 都映射
 * 为 `_`，编码因此不是单射，末字节低 6 位全为 1（ASCII 下即以 `?` 结尾）时两个
 * padding 分支都能通过再编码校验，实现按「padding 优先」取更可能的一支。那是
 * 实现里已记录的取舍，不是本属性要证伪的对象——本属性锁定的是常规路径（盘符 /
 * POSIX / UNC / 中文 / 空格）上往返恒成立。
 */
export const regularWorkspacePathArb: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(...WORKSPACE_PATH_POOL),
  fc
    .tuple(
      fc.constantFrom(...WORKSPACE_ROOT_POOL),
      fc.array(fc.constantFrom(...PATH_SEGMENT_POOL), { minLength: 1, maxLength: 4 })
    )
    .map(([root, segs]) => root.prefix + segs.join(root.sep))
);

/**
 * 不可解码 / 非法目录名池，逐条对应 `decodeWorkspaceKey` 的一条拒绝路径：
 * 长度非 4 的倍数、含非 base64url 字符、解码出控制字符、解码出无效 UTF-8
 * （U+FFFD）、解码成合法文本但不是绝对路径、空目录名。
 */
export const UNDECODABLE_DIR_NAME_POOL = [
  'not-a-key', // 长度 9，非 4 的倍数
  'zzz', // 长度 3
  '一二三', // 含非 base64url 字符
  'AAAA', // 解码为 3 个 NUL —— 形态校验拒绝控制字符
  'AAAAAAAA',
  '____', // 解码为无效 UTF-8，得到 U+FFFD
  '-_-_-_-_',
  'aGVsbG8gd29ybGQ_', // 'hello world'：合法文本但不是绝对路径
  'Li4vLi4vZXRj', // '../../etc'：相对路径
  '', // 空目录名 → 占位符分支
] as const;

/** 随机 base64url 串（长度为 4 的倍数）：绝大多数不可解码，覆盖池子之外的输入 */
const randomKeyLikeArb: fc.Arbitrary<string> = fc
  .array(
    fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.split('')),
    { minLength: 4, maxLength: 16 }
  )
  .map((chars) => chars.slice(0, chars.length - (chars.length % 4)).join(''))
  .filter((s) => s.length >= 4);

/** 目录名生成器：可解码的真实 EncodedKey + 不可解码 / 非法目录名 */
export const property13DirNameArb: fc.Arbitrary<string> = fc.oneof(
  { arbitrary: regularWorkspacePathArb.map((p) => encodeWorkspaceKeys(p)[0]), weight: 3 },
  { arbitrary: fc.constantFrom(...UNDECODABLE_DIR_NAME_POOL), weight: 3 },
  { arbitrary: randomKeyLikeArb, weight: 1 }
);

export const property13WorkspaceArb: fc.Arbitrary<ReportWorkspaceInput> = fc.record({
  dirName: property13DirNameArb,
  // decodedPath 三态：缺省 / null（两者都要求本模块自行解码）/ 已解码路径（直接采用）
  decodedPath: fc.oneof(
    fc.constant(undefined),
    fc.constant(null),
    fc.constantFrom(...WORKSPACE_PATH_POOL)
  ),
  sessionBytes: reportBytesArb,
  execBytes: fc.oneof(fc.constant(undefined), reportBytesArb),
});

/** 展示文本恒不含控制字符与 U+FFFD（乱码兜底断言） */
// eslint-disable-next-line no-control-regex
const GARBLED_RE = /[\u0000-\u001f\u007f\ufffd]/;

describe('storage report EncodedKey decode properties', () => {
  // Feature: storage-usage-analytics, Property 13: EncodedKey 解码往返与失败回退
  it('Property 13(a): 对任意常规工作区绝对路径，decodeWorkspaceKey(encodeWorkspaceKeys(p)[0]) 恒返回 p', () => {
    fc.assert(
      fc.property(regularWorkspacePathArb, (p) => {
        const key = encodeWorkspaceKeys(p)[0];
        // 编码保留 `=` padding（替换为 `_`），故键长恒为 4 的倍数且只含 base64url 字符
        expect(key.length % 4).toBe(0);
        expect(/^[A-Za-z0-9\-_]+$/.test(key)).toBe(true);

        expect(decodeWorkspaceKey(key)).toBe(p);
      }),
      { numRuns: 100 }
    );
  });

  // Feature: storage-usage-analytics, Property 13: EncodedKey 解码往返与失败回退
  it('Property 13(b): 已知非法 / 不可解码目录名恒解码为 null', () => {
    fc.assert(
      fc.property(fc.constantFrom(...UNDECODABLE_DIR_NAME_POOL), (dirName) => {
        expect(decodeWorkspaceKey(dirName)).toBeNull();
      }),
      { numRuns: 100 }
    );
  });

  // Feature: storage-usage-analytics, Property 13: EncodedKey 解码往返与失败回退
  it('Property 13(c): 报告展示文本恒非空、恒无乱码，且恒落在「解码结果 / 原始目录名 / 占位符」三者之一', () => {
    fc.assert(
      fc.property(
        fc.record({
          summary: storageSummaryArb,
          workspaces: fc.array(property13WorkspaceArb, { minLength: 1, maxLength: 6 }),
          sessions: fc.constant([] as ReportSessionInput[]),
          sessionLimit: fc.constant(undefined),
        }) as fc.Arbitrary<BuildReportInput>,
        (input) => {
          const data = buildReportData(input);
          const text = renderStorageReport(data, new Date(1_700_000_000_000));

          // 展示名与输入按字节数排序后不再逐位对齐，故按多重集合比对
          const expected = input.workspaces
            .map((w) => {
              const decoded =
                typeof w.decodedPath === 'string' && w.decodedPath.length > 0
                  ? w.decodedPath
                  : decodeWorkspaceKey(w.dirName);
              if (decoded) return decoded;
              return w.dirName.length > 0 ? w.dirName : '(未知工作区)';
            })
            .sort();
          expect(data.workspaces.map((w) => w.display).sort()).toEqual(expected);

          data.workspaces.forEach((w) => {
            // 恒非空
            expect(w.display.length).toBeGreaterThan(0);
            // 恒无乱码：不出现 U+FFFD 与控制字符
            expect(GARBLED_RE.test(w.display)).toBe(false);
            // 恒出现在报告的工作区排行区块里
            expect(text).toContain(w.display);
          });

          // 整篇报告同样不得出现替换字符（解码失败恒回退而非渲染乱码）
          expect(text).not.toContain('\ufffd');
        }
      ),
      { numRuns: 100 }
    );
  });
});
