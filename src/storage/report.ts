/**
 * StorageReportCommand 的报告聚合与渲染。
 *
 * 本模块**全部是纯函数**：不做任何文件系统调用、不引入 PathResolver、不读盘。
 * 位于 ReadOnlyPaths 且更严格——连读 API 都不导入，因此「报告生成不写盘」
 * （Req 6.8）在模块图上一眼可判。模块也**不导入 `cleaner.ts`**，渲染结果里
 * 不含任何清理入口（Req 6.10）。
 *
 * 与 `StorageAnalyzer` 的分工（任务 9.4 接线）：
 *   - 取数（枚举工作区会话目录、拿 ArchiveIndex 快照、算每个会话的 SelfFootprint）
 *     由 `StorageAnalyzer` 负责，它已经为 `getSummary` 做了这些事；
 *   - `StorageAnalyzer.getReportData()` 是一层**薄封装**：把取到的 summary、
 *     各工作区明细与各会话占用交给本模块的 `buildReportData()`，直接返回其结果；
 *   - 本模块只做排序、截断、解码展示名与文本渲染，因此可以零 IO 单测。
 *
 * 会话排行恒用自身口径（`self` / `additive: true`），这样各行数值可相加
 * （Req 6.9）；累计口径同一存档会被多个会话重复计入，放进排行会让「前 50 条之和」
 * 变成一个没有意义的数。
 */

import { CATEGORY_META, CATEGORY_ORDER } from './classify';
import { decodeWorkspaceKey, ORPHAN_NOTE } from './orphan';
import {
  SIZE_NOTE,
  type AggregateTotal,
  type LegacyResidueTotal,
  type SessionFootprint,
  type StorageCategory,
  type StorageSummary,
} from './types';
import { formatSize } from '../webview/size';

/** 会话排行默认展示条数（Req 6.3）。 */
export const DEFAULT_SESSION_LIMIT = 50;

/** 标题展示上限，超出截断并加省略号，避免单行撑爆输出通道。 */
const TITLE_MAX = 120;

export interface ReportWorkspaceRow {
  /** 展示名：解码成功为工作区绝对路径，失败回退原始目录名（Req 6.5） */
  display: string;
  /** sessionBytes + execBytes，工作区排行的排序键 */
  bytes: number;
  /** WorkspaceSessionDir 的字节数 */
  sessionBytes: number;
  /** <StoreRoot>/<WorkspaceId> 的字节数（执行存档 + 索引 + 未分类） */
  execBytes: number;
}

export interface ReportSessionRow {
  sessionId: string;
  title: string;
  /** 恒为自身口径（`scope: 'self'`、`additive: true`） */
  footprint: SessionFootprint;
}

/**
 * 报告里的三个聚合维度（Requirement 7.1、8.1）。
 *
 * 三项**全部可选**，且语义是「有值就渲染，没值就整段省略」：
 *
 * - `project`（ProjectSessionTotal）由排行取数的同一次枚举聚合而来，报告能顺手拿到
 * - `allKiro` / `legacyResidue` 是**手动触发**的重量级维度。报告命令**不是**它们的触发器
 *   （Req 8.4：未触发时旧残留目录的枚举必须排除在默认流程之外），所以这里只渲染
 *   「用户此前已经算过、仍在缓存里」的值；没算过就渲染成「未统计」，而不是趁机去扫一遍。
 *   这也是为什么类型上允许 `state: 'idle'` —— 那是常态，不是异常。
 *
 * 取 `AggregateTotal` / `LegacyResidueTotal`（`types.ts` 的领域模型）而不是排行页的
 * 展示视图：报告是纯文本渲染，不该依赖 webview 那一侧的形状。
 */
export interface ReportAggregates {
  project?: AggregateTotal;
  allKiro?: AggregateTotal;
  legacyResidue?: LegacyResidueTotal;
}

export interface StorageReportData {
  summary: StorageSummary;
  /** 三个聚合维度；全部省略时报告不出现「聚合维度」段 */
  aggregates?: ReportAggregates;
  /** 按 `bytes` 降序 */
  workspaces: ReportWorkspaceRow[];
  /** 按 `footprint.totalBytes` 降序，长度恒 ≤ `sessionLimit` */
  sessions: ReportSessionRow[];
  sessionLimit: number;
  /** 总会话数减去展示条数，恒 ≥ 0 */
  omittedSessions: number;
}

/** 单个工作区的输入明细，字段与 `collectLiveSessions().byWorkspace` 对齐。 */
export interface ReportWorkspaceInput {
  /** 目录名，即 EncodedKey */
  dirName: string;
  /** 已解码的工作区路径；缺省或为 null 时本模块用 `decodeWorkspaceKey` 再试一次 */
  decodedPath?: string | null;
  sessionBytes: number;
  /** <StoreRoot>/<WorkspaceId> 的字节数；取不到时传 0 */
  execBytes?: number;
}

export interface ReportSessionInput {
  sessionId: string;
  /** 会话标题（清单优先、回退单文件标题）；空白时展示为 `(无标题)` */
  title?: string;
  /**
   * 该会话的占用。**必须是自身口径**：报告行的语义固定为可相加。
   * 若传入 lineage 口径，本模块按 self 重新标记而不是原样渲染——
   * 让一行标着「累计口径」出现在一个声明「各行可相加」的排行里，
   * 比丢掉这条信息更糟。
   */
  footprint: SessionFootprint;
}

export interface BuildReportInput {
  summary: StorageSummary;
  workspaces: readonly ReportWorkspaceInput[];
  sessions: readonly ReportSessionInput[];
  /** 缺省 50；非法值（负数 / NaN）回退到 50 */
  sessionLimit?: number;
  /** 三个聚合维度（见 {@link ReportAggregates}）；省略时报告不出现该段 */
  aggregates?: ReportAggregates;
}

/* ------------------------------------------------------------------ *
 * 聚合
 * ------------------------------------------------------------------ */

/** 只接受有限非负字节数，其余按 0 计，避免 NaN 污染排序与合计。 */
function safeBytes(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

/** 把标题压成单行并截断：多行标题会破坏「一行一条」的报告结构。 */
function displayTitle(title: string | undefined): string {
  const flat = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : '';
  if (flat.length === 0) return '(无标题)';
  return flat.length > TITLE_MAX ? flat.slice(0, TITLE_MAX) + '…' : flat;
}

/**
 * 工作区展示名：优先已解码路径，其次本模块解码，最后回退原始目录名（Req 6.5）。
 * 目录名也为空时给出占位符，保证展示文本恒非空（Property 13）。
 */
function workspaceDisplay(input: ReportWorkspaceInput): string {
  const decoded =
    typeof input.decodedPath === 'string' && input.decodedPath.length > 0
      ? input.decodedPath
      : decodeWorkspaceKey(input.dirName);
  if (decoded) return decoded;
  return input.dirName.length > 0 ? input.dirName : '(未知工作区)';
}

/** 归一为自身口径，并把字节数重新加总，使 `totalBytes` 与两个分量恒一致。 */
function toSelfFootprint(fp: SessionFootprint, sessionId: string): SessionFootprint {
  const jsonBytes = safeBytes(fp?.jsonBytes);
  const archiveBytes = safeBytes(fp?.archiveBytes);
  return {
    sessionId: fp?.sessionId ?? sessionId,
    scope: 'self',
    additive: true,
    jsonBytes,
    archiveBytes,
    totalBytes: jsonBytes + archiveBytes,
    archivesFound: fp?.archivesFound === true,
  };
}

/**
 * 纯函数：把取数结果聚合成报告数据。
 *
 * - 工作区按 `sessionBytes + execBytes` 降序，会话按自身口径占用降序（Req 6.3）；
 *   两处都用「字节数降序 → 名称/ID 字典序升序」做 tiebreak，使同一输入的输出唯一
 * - 会话列表截断到 `sessionLimit`（默认 50），`omittedSessions = 总数 - 展示数`；
 *   会话数为 0 时截断结果为空数组、`omittedSessions` 为 0（Req 6.4）
 */
export function buildReportData(input: BuildReportInput): StorageReportData {
  const limitRaw = input.sessionLimit;
  const sessionLimit =
    typeof limitRaw === 'number' && Number.isFinite(limitRaw) && limitRaw >= 0
      ? Math.floor(limitRaw)
      : DEFAULT_SESSION_LIMIT;

  const workspaces: ReportWorkspaceRow[] = (input.workspaces ?? []).map((w) => {
    const sessionBytes = safeBytes(w.sessionBytes);
    const execBytes = safeBytes(w.execBytes);
    return {
      display: workspaceDisplay(w),
      bytes: sessionBytes + execBytes,
      sessionBytes,
      execBytes,
    };
  });
  workspaces.sort((a, b) =>
    a.bytes !== b.bytes ? b.bytes - a.bytes : a.display < b.display ? -1 : a.display > b.display ? 1 : 0
  );

  const allSessions: ReportSessionRow[] = (input.sessions ?? []).map((s) => ({
    sessionId: s.sessionId,
    title: displayTitle(s.title),
    footprint: toSelfFootprint(s.footprint, s.sessionId),
  }));
  allSessions.sort((a, b) => {
    const d = b.footprint.totalBytes - a.footprint.totalBytes;
    if (d !== 0) return d;
    return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
  });

  const shown = Math.min(allSessions.length, sessionLimit);
  const out: StorageReportData = {
    summary: input.summary,
    workspaces,
    sessions: allSessions.slice(0, shown),
    sessionLimit,
    omittedSessions: allSessions.length - shown,
  };
  // 原样透传（本模块不对聚合维度做任何重算：那三个数值的口径归 StorageAnalyzer 所有）；
  // 未提供时**不写这个键**，使既有调用方拿到的对象形状与本任务实施前逐字段一致
  if (input.aggregates) out.aggregates = input.aggregates;
  return out;
}

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */

function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

/** 本地时区 `YYYY-MM-DD HH:mm`，与排行页的时间列同一格式。 */
function formatStamp(d: Date): string {
  return (
    d.getFullYear() +
    '-' +
    pad2(d.getMonth() + 1) +
    '-' +
    pad2(d.getDate()) +
    ' ' +
    pad2(d.getHours()) +
    ':' +
    pad2(d.getMinutes())
  );
}

/** 中日韩字符按两列宽计算，使等宽输出通道里的列基本对齐。 */
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    w += c >= 0x1100 && (c <= 0x115f || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6))
      ? 2
      : 1;
  }
  return w;
}

function padDisplay(s: string, width: number): string {
  const gap = width - displayWidth(s);
  return gap > 0 ? s + ' '.repeat(gap) : s;
}

/**
 * 一个聚合维度的一行文本（Requirement 7.1、7.12、8.1、8.6）。
 *
 * `≥` 前缀按**该维度自己的** `partial` 决定，而不是跟着 `summary.partial`：
 * 三个维度各扫各自的范围，汇总统计跳过了条目并不意味着某个聚合维度的数值也是下限。
 *
 * 非 `ok` 三态直接写成文字而不是补 0：`idle`（未统计）在报告里是常态——报告命令不触发
 * 那两个重量级维度（Req 8.4），显示 `0 B` 会被读成「扫过了、确实是空的」。
 */
function aggregateLine(label: string, total: AggregateTotal | undefined): string {
  if (!total) return '  ' + label + ': 未统计';
  if (total.state === 'idle') return '  ' + label + ': 未统计（在占用排行页手动触发）';
  if (total.state === 'loading') return '  ' + label + ': 统计中…';
  if (total.state === 'unavailable') return '  ' + label + ': 不可用（对应目录不存在或不可读）';

  const pfx = total.partial === true ? '≥' : '';
  const parts = [
    pfx + formatSize(safeBytes(total.bytes)),
    safeBytes(total.files) + ' 个文件',
    safeBytes(total.sessionCount) + ' 个会话',
    safeBytes(total.workspaceCount) + ' 个工作区目录',
  ];
  let line = '  ' + label + ': ' + parts.join(' / ');
  if (total.partial === true) {
    line += '（已跳过 ' + safeBytes(total.skippedCount) + ' 个条目，为下限值）';
  }
  return line;
}

/**
 * 纯函数：渲染固定四区块的报告文本（Req 6.2、6.4）。
 *
 * 区块结构与顺序恒定，不因数据为空而被提示文案替换：会话数为 0 时区块标题里
 * 仍保留「前 N 条，省略 0 条」，区块体为空行数（Req 6.4）。
 *
 * `summary.partial` 为 true 时所有数值加 `≥` 前缀，表示这些数是下限
 * （Req 4.11 的同一约定）；头部固定注明体积口径为 stat 逻辑字节数（Req 8.4）。
 *
 * 报告不含任何清理入口（Req 6.10）；孤儿区块的说明只否定「批量清理」并给出理由，
 * 同时把单会话清理引导到占用排行页（Req 6.11）。
 */
export function renderStorageReport(data: StorageReportData, now?: Date): string {
  const s = data.summary;
  const partial = s.partial === true;
  const size = (n: unknown) => (partial ? '≥' : '') + formatSize(safeBytes(n));
  const out: string[] = [];

  // ---- 头部 ----
  out.push('Kiro 存储占用分析 · ' + formatStamp(now ?? new Date()));
  out.push('用户数据目录: ' + (s.userDataDir ?? '(未能定位)'));
  if (s.status !== 'ok') {
    out.push('状态: 占用统计不可用（未能定位 Kiro 用户数据目录或统计整体失败），以下数值均为 0');
  }
  out.push('总占用: ' + size(s.totalBytes) + ' / ' + safeBytes(s.totalFiles) + ' 个文件');
  out.push('口径: ' + (s.sizeNote || SIZE_NOTE));
  if (partial) {
    out.push(
      '统计不完整: 已跳过 ' + safeBytes(s.skippedCount) + ' 个条目（不可读或超出深度上限），带 ≥ 的数值为下限'
    );
  }

  // ---- 聚合维度（Req 7.1、8.1）----
  // 放在头部而不是另立一个编号区块：这三个数是汇总级信息，读者正是在「总占用」附近找它们；
  // 而【1】~【4】的标题顺序与区块体行数被既有断言逐条钉住，插一个新编号块会动到那些不变量。
  const agg = data.aggregates;
  if (agg) {
    out.push('聚合维度:');
    out.push(aggregateLine('当前项目会话总占用', agg.project));
    out.push(aggregateLine('整个 Kiro 会话总占用', agg.allKiro));
    const residue = agg.legacyResidue;
    out.push(aggregateLine('旧格式残留（独立维度，默认不计入上一项）', residue));
    if (residue && residue.state === 'ok') {
      const rp = residue.partial === true ? '≥' : '';
      out.push(
        '    其中已迁移仅残留 ' +
          rp +
          formatSize(safeBytes(residue.migratedResidueBytes)) +
          '（可清理） · 未迁移或无法按会话归属 ' +
          rp +
          formatSize(safeBytes(residue.unmigratedBytes)) +
          '（默认不清理）'
      );
      out.push('    「未迁移」部分的会话在 Kiro 1.x 界面中不可见，删除后不可恢复');
    }
  }
  out.push('');

  // ---- 【1】分类构成 ----
  out.push('【1】分类构成');
  const byCategory = new Map<StorageCategory, { bytes: number; files: number }>();
  for (const c of s.categories ?? []) {
    byCategory.set(c.category, { bytes: safeBytes(c.bytes), files: safeBytes(c.files) });
  }
  const labelWidth = Math.max(
    ...CATEGORY_ORDER.map((k) => displayWidth(CATEGORY_META[k].label))
  );
  for (const key of CATEGORY_ORDER) {
    const meta = CATEGORY_META[key];
    const agg = byCategory.get(key) ?? { bytes: 0, files: 0 };
    out.push(
      '  ' +
        padDisplay(meta.label, labelWidth) +
        '  ' +
        size(agg.bytes) +
        '  ' +
        agg.files +
        ' 个文件  ' +
        meta.pathHint +
        (meta.note ? '（' + meta.note + '）' : '')
    );
  }
  out.push('');

  // ---- 【2】按工作区排行 ----
  out.push('【2】按工作区排行（共 ' + data.workspaces.length + ' 个工作区）');
  const wsIndexWidth = String(data.workspaces.length).length;
  data.workspaces.forEach((w, i) => {
    out.push(
      '  ' +
        String(i + 1).padStart(wsIndexWidth) +
        '. ' +
        size(w.bytes) +
        '  ' +
        w.display +
        '（会话 ' +
        size(w.sessionBytes) +
        ' + 执行数据 ' +
        size(w.execBytes) +
        '）'
    );
  });
  out.push('');

  // ---- 【3】按会话排行 ----
  out.push(
    '【3】按会话排行（自身口径，可相加 · 前 ' +
      data.sessionLimit +
      ' 条，省略 ' +
      data.omittedSessions +
      ' 条）'
  );
  const seIndexWidth = String(Math.max(1, data.sessions.length)).length;
  data.sessions.forEach((row, i) => {
    const fp = row.footprint;
    out.push(
      '  ' +
        String(i + 1).padStart(seIndexWidth) +
        '. ' +
        size(fp.totalBytes) +
        '  会话 JSON ' +
        size(fp.jsonBytes) +
        ' + 存档 ' +
        size(fp.archiveBytes) +
        (fp.archivesFound ? '' : '（未找到归因存档）') +
        '  ' +
        row.title +
        '（' +
        row.sessionId +
        '）'
    );
  });
  out.push('');

  // ---- 【4】孤儿存档合计 ----
  const orphan = s.orphan;
  const stateSuffix =
    orphan?.state === 'pending' ? '（待判定）' : orphan?.state === 'unknown' ? '（未确定）' : '';
  out.push('【4】孤儿存档合计');
  out.push(
    '  ' + size(orphan?.bytes) + ' / ' + safeBytes(orphan?.files) + ' 个文件' + stateSuffix
  );
  if (orphan?.state === 'pending') {
    out.push('  会话清单尚未完整读取，孤儿判定暂缓，该数值可能偏低');
  } else if (orphan?.state === 'unknown') {
    out.push('  未能取得任何现存会话 ID，不把全部存档判为孤儿');
  }
  out.push('  说明: ' + (orphan?.note || ORPHAN_NOTE));
  out.push(
    '  单会话清理: 在「Kiro: 存储占用排行」页对具体会话执行附件清理或全量清理；本报告只做诊断快照，不提供清理入口。'
  );

  return out.join('\n');
}
