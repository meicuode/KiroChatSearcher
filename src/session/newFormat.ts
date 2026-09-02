import { readdirSync, readFileSync, statSync } from 'fs';
import * as path from 'path';

/**
 * NewFormatReader：把 Kiro 1.x 的**目录型**会话读成与 0.9x 单文件会话同构的记录
 * （Req 3.1–3.13）。
 *
 * 1.x 下一个会话是一个目录 `<NewWorkspaceSessionDir>/<sessionId>/`，其中：
 *
 * - `session.json`：元数据（`id` / `title` / `lastModifiedAt` / `status` …）
 * - `messages.jsonl`：对话本体，**一行一个事件** `{id,timestamp,payload:{type,...}}`
 * - `snapshots/<hash>/<相对路径>`：文件检查点，1.x 里附件/执行存档的对应物
 * - `sub-executions/`、`publish.cursor`、`publish-sub.cursor`：本模块不读
 *
 * 本模块位于 **ReadOnlyPaths**：只从 `fs` 具名导入 `readdirSync` / `statSync` /
 * `readFileSync` 三个读 API——写 API（`unlink` / `writeFile` / `rmdir` / `rm` /
 * `rename` / `cp`）连导入都不存在，因此「读取路径零写入」是模块依赖图上可静态审查的
 * 事实，而不是注释里的承诺（Req 3.13、12.1、12.2）。
 *
 * 选用**同步** API 而非 `fs/promises`：下游 SessionSource（`src/search.ts`）是同步的，
 * `searchSessionsInDir` / `listRecentSessions` 的对外签名在任务 7.1 里明确要求保持不变。
 * 与 SizeScanner 的取舍不同——那边遍历整棵树、必须让出事件循环；这边只读两个文件，
 * 且读取范围被搜索结果条数上限约束。
 *
 * 三段结构，本文件按此顺序组织：
 *
 * 1. 元数据与会话枚举（任务 5.1）：{@link readNewSessionMeta}、{@link listNewSessions}、
 *    {@link listNewSessionDirs}
 * 2. `messages.jsonl` 逐行解析（任务 5.2）：{@link parseMessagesJsonl}
 * 3. `(mtimeMs, size)` 失效缓存（任务 5.3）：{@link readNewSession} 内部 +
 *    {@link __clearNewSessionCacheForTest}
 */

/* ------------------------------------------------------------------ *
 * 常量与类型
 * ------------------------------------------------------------------ */

/** NewSessionDir 下的元数据文件名（NewSessionMetaFile）。 */
export const NEW_SESSION_META_FILENAME = 'session.json';

/** NewSessionDir 下的对话本体文件名（MessagesFile），一行一个事件。 */
export const MESSAGES_FILENAME = 'messages.jsonl';

/** NewSessionDir 下的文件检查点目录名（SnapshotsDir），1.x 的附件对应物。 */
export const SNAPSHOTS_DIRNAME = 'snapshots';

/** 标题缺失 / 空串 / 纯空白时的占位标题（Req 3.2）。 */
export const UNTITLED_TITLE = 'Untitled';

/**
 * 参与匹配文本提取的 `payload.type`（Req 3.3）。
 *
 * 实测 14 种 type 中只有这两种承载人类可读的对话内容；其余 12 种
 * （`tool_call`、`tool_result`、`session_metadata`、`turn_start`、`turn_end`、
 * `sub_agent_start`、`sub_agent_complete`、`pending_interaction`、
 * `interaction_resolved`、`session_event`、`tombstone`、`usage_summary`）
 * 一律排除在匹配文本之外（Req 3.4）——它们是协议/审计数据，把工具参数与结果
 * 纳入搜索会让「搜什么都命中」。用**白名单**而不是黑名单：Kiro 后续版本新增的
 * event type 默认不进匹配文本，不需要同步维护排除列表。
 *
 * 注意 `usage_summary` 只是不进匹配文本，它仍是 1.x 的用量来源，由 CreditReader
 * （`src/credits.ts`）单独解析。
 */
export const MATCHED_PAYLOAD_TYPES: ReadonlySet<string> = new Set(['user', 'assistant']);

/**
 * `session.json` 的字段形状（实测 Kiro 1.0.337）。
 *
 * 全部字段可选，`id` 除外——但即使 `id` 缺失也不影响读取：会话身份的权威来源是
 * **目录名**，见 {@link readNewSession} 的说明。
 */
export interface NewSessionMeta {
  schemaVersion?: string;
  dataModelVersion?: number;
  /** 会话 id；正常与所在目录名相同。 */
  id: string;
  title?: string;
  /** `chat` / `spec` / `autopilot` 等，1.x 的会话模式。 */
  agentMode?: string;
  workspacePaths?: string[];
  createdAt?: string;
  /** ISO 时间串，最后修改时间的首选来源（Req 3.10）。 */
  lastModifiedAt?: string;
  modelId?: string;
  status?: string;
}

/**
 * 一个 1.x 会话被读成的精简记录。
 *
 * 刻意**不保留**原始 JSON / JSONL 文本：`messages.jsonl` 单个会话可达数 MB，
 * 其中内嵌 base64 图片占大头。只留下匹配与展示所需的字段，使记录可以常驻
 * 进程内缓存而不把大体积内容一起钉在内存里（Req 3.12）。
 */
export interface NewSessionRecord {
  /** 会话 id = NewSessionDir 的目录名（跳转命令按它定位会话）。 */
  sessionId: string;
  /** NewSessionDir 绝对路径。 */
  dir: string;
  /** 展示标题；缺失 / 空串 / 纯空白 → `Untitled`（Req 3.2）。 */
  title: string;
  /** 最后修改时间（epoch ms）：`lastModifiedAt`，缺失或非法时回退 MessagesFile 的 mtime（Req 3.10）。 */
  modified: number;
  /** 关键词匹配用的纯文本：仅 `user` / `assistant` 事件，已剔除 base64 图片数据（Req 3.3、3.12）。 */
  text: string;
  /** 「最近列表」的预览来源：首条 `user` 事件的文本（无关键词时展示）。 */
  firstUserText: string;
  /** 会话是否含内嵌图片（Req 3.6）。 */
  hasImage: boolean;
  /** 会话是否含附件：非空上下文引用，或 SnapshotsDir 内有文件（Req 3.7）。 */
  hasAttachment: boolean;
  /**
   * 该会话的 credit 合计（`usage_summary` 事件中 `unit === 'credit'` 的求和）。
   *
   * 本模块**不解析用量**，因此读取结果中该字段恒为 `undefined`（字段缺席）；
   * 由 CreditReader（`src/credits.ts` 的 `getCreditsFromMessages`）填充。
   * 三态刻意分开，避免上层把「还没算」当成「算过但没有」：
   * `undefined` = 尚未解析，`null` = 已解析但不可用（Req 4.7），`number` = 合计值。
   */
  credits?: number | null;
}

/** `statSync` 返回值中本模块用到的最小形状。 */
export interface NewFormatStat {
  size: number;
  mtimeMs: number;
  isDirectory(): boolean;
}

/**
 * 可注入的**只读**文件系统依赖（风格对齐 `storage/orphan.ts` 的 `OrphanFsDeps`）。
 *
 * 只暴露三个读调用，因此「调用面 ⊆ {readdirSync, statSync, readFileSync}」可以被
 * 属性测试直接断言（Property 11）。缺省退回真实 `fs`，生产路径无额外抽象开销；
 * 注入点的存在使单元测试可以在不落盘的前提下构造「缺 `session.json`」
 * 「`lastModifiedAt` 非法」「JSONL 中夹坏行」这类夹具。
 *
 * 只注入「列名字」这一步（不用 `withFileTypes`），「是目录还是文件」统一走
 * `statSync`——与 `layout.ts` 的 `LayoutFsDeps` 取同一口径，注入实现无需伪造 Dirent。
 */
export interface NewFormatFsDeps {
  readdirSync?: (p: string) => string[];
  statSync?: (p: string) => NewFormatStat;
  readFileSync?: (p: string, enc: 'utf8') => string;
}

interface ResolvedDeps {
  readdirSync: (p: string) => string[];
  statSync: (p: string) => NewFormatStat;
  readFileSync: (p: string, enc: 'utf8') => string;
}

function resolveDeps(deps?: NewFormatFsDeps): ResolvedDeps {
  return {
    readdirSync: deps?.readdirSync ?? ((p) => readdirSync(p)),
    statSync: deps?.statSync ?? ((p) => statSync(p)),
    readFileSync: deps?.readFileSync ?? ((p, enc) => readFileSync(p, enc)),
  };
}

/* ------------------------------------------------------------------ *
 * 1. 元数据与会话枚举（任务 5.1）
 * ------------------------------------------------------------------ */

/**
 * 读取并解析 NewSessionMetaFile。
 *
 * @returns 解析结果；文件不存在、读失败、JSON 非法或顶层不是对象时返回 `null`
 *   （调用方据此跳过该会话，Req 3.9）。**不抛异常**。
 */
export function readNewSessionMeta(
  sessionDir: string,
  deps?: NewFormatFsDeps
): NewSessionMeta | null {
  const d = resolveDeps(deps);
  let raw: string;
  try {
    raw = d.readFileSync(path.join(sessionDir, NEW_SESSION_META_FILENAME), 'utf8');
  } catch {
    return null;
  }
  return parseNewSessionMeta(raw);
}

/**
 * 纯函数：把 `session.json` 文本解析为 {@link NewSessionMeta}。
 *
 * 逐字段做类型校验而不是直接 `as NewSessionMeta`：这是外部进程写的文件，
 * 任何字段都可能缺失或变型，未校验的强制转换会把「字段是数字」的意外
 * 顺着 `title` 一路带到 HTML 渲染层。
 *
 * @returns JSON 非法或顶层不是对象时返回 `null`。
 */
export function parseNewSessionMeta(raw: string): NewSessionMeta | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  return {
    schemaVersion: str(o.schemaVersion),
    dataModelVersion: typeof o.dataModelVersion === 'number' ? o.dataModelVersion : undefined,
    id: str(o.id) ?? '',
    title: str(o.title),
    agentMode: str(o.agentMode),
    workspacePaths: Array.isArray(o.workspacePaths)
      ? o.workspacePaths.filter((p): p is string => typeof p === 'string')
      : undefined,
    createdAt: str(o.createdAt),
    lastModifiedAt: str(o.lastModifiedAt),
    modelId: str(o.modelId),
    status: str(o.status),
  };
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** 标题归一化：缺失 / 空串 / 纯空白 → `Untitled`（Req 3.2）。 */
function normalizeTitle(title: string | undefined): string {
  return typeof title === 'string' && title.trim() ? title : UNTITLED_TITLE;
}

/**
 * 枚举一个 NewWorkspaceSessionDir 下的全部会话并读成记录。
 *
 * **会话来源是目录枚举，不是 `session-index/<WsHash16>.jsonl`**（Req 3.1、design D3）。
 * 那个索引是**追加式 op 日志**：会话被删除后，它的 `add` 条目仍留在文件里，
 * 拿它当来源会列出磁盘上已不存在的会话——搜索结果点进去必然报错，占用统计还会
 * 把不存在的会话算进合计。目录枚举的代价是失去索引记录的「新增顺序」，
 * 但排序本来按 `lastModifiedAt`，不依赖它。
 *
 * 单个会话的任何问题（不是目录、缺 `session.json` 或 `messages.jsonl`、
 * `stat` 失败）只跳过该会话并继续其余（Req 3.9）；`workspaceSessionDir` 整体
 * 不可枚举时返回空数组。**全程不抛异常。**
 *
 * @returns 成功解析的会话记录，顺序与目录枚举顺序一致（排序交给调用方）。
 */
export function listNewSessions(
  workspaceSessionDir: string,
  deps?: NewFormatFsDeps
): NewSessionRecord[] {
  const dirs = listNewSessionDirs(workspaceSessionDir, deps);
  // 目录不存在 / 不可读：该工作区在 1.x 下无会话可读，交由调用方按布局处理。
  // 此时**不**动缓存——「这次没看到目录」与「目录里确实没有会话」是两回事。
  if (!dirs) return [];

  const out: NewSessionRecord[] = [];
  for (const dir of dirs) {
    const rec = readNewSession(dir, deps);
    if (rec) out.push(rec);
  }

  evictMissingNewSessions(workspaceSessionDir, new Set(dirs));
  return out;
}

/**
 * 只做**枚举**：列出 NewWorkspaceSessionDir 下的全部 NewSessionDir 绝对路径。
 *
 * 从 {@link listNewSessions} 里单独抽出来，是为了让 `search.ts` 的 SessionSource
 * 能把「枚举 → 读取 → 缓存收尾」三段分别挂到接口的三个成员上（design D1 的注入点），
 * 而不必为新格式重写一份读取逻辑，也不必让 `listEntries` 顺手把内容一起读了
 * ——那会绕过 {@link readNewSession} 的 `(mtimeMs, size)` 缓存判据（Req 3.11）。
 *
 * @returns 会话目录列表（顺序与目录枚举顺序一致）；**该目录整体不可枚举时返回 `null`**。
 *   `null` 与 `[]` 语义不同：`[]` 表示「目录可读但没有会话」（缓存里该目录下的残留键
 *   应被摘除），`null` 表示「这次没看到目录」（缓存原样保留）。单个条目 `stat` 失败
 *   或不是目录时只跳过它，其余条目照常。**不抛异常。**
 */
export function listNewSessionDirs(
  workspaceSessionDir: string,
  deps?: NewFormatFsDeps
): string[] | null {
  const d = resolveDeps(deps);
  let names: string[];
  try {
    names = d.readdirSync(workspaceSessionDir);
  } catch {
    return null;
  }

  const out: string[] = [];
  for (const name of names) {
    const dir = path.join(workspaceSessionDir, name);
    try {
      if (!d.statSync(dir).isDirectory()) continue;
    } catch {
      // 单个条目 stat 失败只跳过它，其余条目照常
      continue;
    }
    out.push(dir);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 2. messages.jsonl 逐行解析（任务 5.2）
 * ------------------------------------------------------------------ */

/** {@link parseMessagesJsonl} 的产出。 */
export interface ParsedMessages {
  /** 仅 `user` / `assistant` 事件的文本，按出现顺序以 `\n` 连接。 */
  text: string;
  /** 首条 `user` 事件的文本（已 trim），无则空串。 */
  firstUserText: string;
  /** 是否见到图片标志（命中首个即停止检测）。 */
  hasImage: boolean;
  /** 是否见到非空上下文引用（`contextItems` 等）。 */
  hasAttachment: boolean;
}

/**
 * 纯函数：逐行解析 MessagesFile 文本，一次遍历同时算出四项产出。
 *
 * - **匹配文本**只取 `payload.type` ∈ {@link MATCHED_PAYLOAD_TYPES} 的事件（Req 3.3、3.4）
 * - **图片检测**（Req 3.6）不限事件类型：图片可能出现在 `user` 的输入里，也可能
 *   出现在 `tool_result` 里；只看**标志**（内容项 `type` 含 `image`，或存在
 *   `imageUrl` / `image` 字段），命中首个即停止该会话的图片检测
 * - **附件检测**（Req 3.7）同样不限事件类型：任一事件带非空 `contextItems`
 *   （或 `contextItem` / `contextReferences`）即成立，命中即停止
 * - **坏行容错**（Req 3.8）：单行不是合法 JSON 就跳过该行，继续解析其余行——
 *   `messages.jsonl` 是追加写的，进程被杀会留下半行；把整个会话判为不可读
 *   会让用户丢失整段历史
 *
 * **内嵌 base64 图片数据不进文本、不进比对**（Req 3.12）：图片内容项一经识别就整项
 * 跳过，其 `imageUrl` / `image` 里的 base64 既不读也不比；文本收集另外挡掉
 * `data:` URL 形态的字符串。逐行处理也意味着单行的大 base64 只在该行的
 * `JSON.parse` 期间存在，不会被拼进常驻的 `text`。
 */
export function parseMessagesJsonl(raw: string): ParsedMessages {
  const textParts: string[] = [];
  let firstUserText = '';
  let hasImage = false;
  let hasAttachment = false;

  // 按行切分：`\r\n` 与 `\n` 都算行尾；空行与纯空白行不是事件，直接跳过
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;

    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      // 坏行：跳过，不影响其余行（Req 3.8）
      continue;
    }
    if (event === null || typeof event !== 'object') continue;

    const payload = (event as { payload?: unknown }).payload;
    if (payload === null || typeof payload !== 'object') continue;
    const p = payload as Record<string, unknown>;

    if (!hasAttachment && hasContextRefs(p)) hasAttachment = true;
    if (!hasImage && hasPayloadImageFlag(p)) hasImage = true;

    const type = typeof p.type === 'string' ? p.type : '';
    if (!MATCHED_PAYLOAD_TYPES.has(type)) continue;

    for (const t of extractTexts(p)) {
      textParts.push(t);
      if (!firstUserText && type === 'user' && t.trim()) firstUserText = t.trim();
    }
  }

  return { text: textParts.join('\n'), firstUserText, hasImage, hasAttachment };
}

/**
 * 从一个 `user` / `assistant` 事件的 payload 里取出文本片段。
 *
 * 实测样例是 `content` 为**字符串**的形态：
 * `{"payload":{"type":"user","content":"Create the tasks for ...","source":"chat"}}`。
 * 同时兼容 `content` 为**内容项数组**（`[{type:'text',text:'...'}]`，也允许裸字符串项）
 * 以及 `payload.text` 直挂的形态。**无法识别的形状按「无文本」处理而不抛错**：
 * 这是外部进程写的文件，形状随 Kiro 版本演进，宁可少搜到一条也不能让整个会话读不出来。
 *
 * 图片内容项整项跳过，不进文本（Req 3.12）；图片**标志**的判定不在这里，
 * 而在 {@link hasPayloadImageFlag}——那里对全部事件类型生效，不只 `user` / `assistant`。
 */
function extractTexts(p: Record<string, unknown>): string[] {
  const out: string[] = [];
  const content = p.content;

  if (typeof content === 'string') {
    if (content && !isDataUrl(content)) out.push(content);
  } else if (Array.isArray(content)) {
    for (const item of content) {
      if (isImagePart(item)) continue; // 不读、不比对、不进文本
      const t = typeof item === 'string' ? item : str((item as Record<string, unknown>)?.text);
      if (t && !isDataUrl(t)) out.push(t);
    }
  } else if (content === undefined || content === null) {
    // `content` 缺失时的兜底形状；`content` 已提供文本时不重复计入
    const t = str(p.text);
    if (t && !isDataUrl(t)) out.push(t);
  }

  return out;
}

/** `data:` URL 形态的字符串一律不进匹配文本（内嵌 base64 图片的常见承载）。 */
function isDataUrl(s: string): boolean {
  return s.startsWith('data:');
}

/**
 * 内容项是否为图片（Req 3.6）。
 *
 * **只看标志，不碰数据**：`type` 含 `image`，或存在 `imageUrl` / `image` 字段即算命中；
 * 字段里的 base64 既不读取长度也不解码。
 */
function isImagePart(c: unknown): boolean {
  if (c === null || typeof c !== 'object') return false;
  const o = c as Record<string, unknown>;
  const t = typeof o.type === 'string' ? o.type.toLowerCase() : '';
  return t.includes('image') || o.imageUrl != null || o.image != null;
}

/** payload 自身是否直挂图片标志（部分事件把图片放在 payload 顶层而非 content 项里）。 */
function hasPayloadImageFlag(p: Record<string, unknown>): boolean {
  if (p.imageUrl != null || p.image != null) return true;
  const content = p.content;
  if (Array.isArray(content)) return content.some(isImagePart);
  return false;
}

/**
 * 事件是否携带非空上下文引用（Req 3.7 的第一个条件）。
 *
 * `contextItems` 是实测字段名；`contextItem` / `contextReferences` 作为同义兜底，
 * 避免字段更名后附件角标整体消失。只判断「是非空数组」，不读取引用内容。
 */
function hasContextRefs(p: Record<string, unknown>): boolean {
  for (const key of ['contextItems', 'contextItem', 'contextReferences']) {
    const v = p[key];
    if (Array.isArray(v) && v.length > 0) return true;
  }
  return false;
}

/**
 * SnapshotsDir 是否存在且含至少一个文件（Req 3.7 的第二个条件）。
 *
 * 递归下探到**首个文件**即返回：`snapshots/<hash>/<相对路径>` 的第一层是 hash 目录，
 * 只判断「hash 目录存在」会把「快照目录已建但文件已被清理」误判为有附件。
 * 深度上限兜住异常深的目录树（正常快照树只有几层），命中即短路，不做全量遍历。
 */
function snapshotsHaveFile(sessionDir: string, d: ResolvedDeps, depth = 4): boolean {
  return dirHasFile(path.join(sessionDir, SNAPSHOTS_DIRNAME), d, depth);
}

function dirHasFile(dir: string, d: ResolvedDeps, depth: number): boolean {
  if (depth <= 0) return false;
  let names: string[];
  try {
    names = d.readdirSync(dir);
  } catch {
    // 目录不存在 / 不可读：视为该条件不成立
    return false;
  }
  for (const name of names) {
    const full = path.join(dir, name);
    let isDir: boolean;
    try {
      isDir = d.statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) return true;
    if (dirHasFile(full, d, depth - 1)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * 3. (mtimeMs, size) 失效缓存（任务 5.3）
 * ------------------------------------------------------------------ */

/**
 * 进程内会话缓存条目。
 *
 * 与 `search.ts` 的 `SessionIndexEntry` 同一风格：只留匹配/展示所需的精简数据，
 * 不保留原始文本，避免把 base64 图片等大体积内容常驻内存（Req 3.12）。
 * 失效判据是 **MessagesFile 与 NewSessionMetaFile 各自的 `(mtimeMs, size)`
 * 组合**（Req 3.11）——两者任一变化即重解析。
 */
interface NewSessionCacheEntry {
  sessionId: string;
  metaMtimeMs: number;
  metaSize: number;
  msgMtimeMs: number;
  msgSize: number;
  title: string;
  modified: number;
  text: string;
  firstUserText: string;
  hasImage: boolean;
  hasAttachment: boolean;
}

/**
 * 1.x 会话缓存：键为 NewSessionDir 绝对路径。
 * 进程内内存缓存，不持久化；扩展停用随进程释放（与 `search.ts` 的 `indexCache` 一致）。
 */
const newSessionCache = new Map<string, NewSessionCacheEntry>();

/** 测试辅助：清空缓存（不影响生产逻辑；对齐 `search.ts` 的 `__clearIndexCacheForTest`）。 */
export function __clearNewSessionCacheForTest(): void {
  newSessionCache.clear();
}

/**
 * 读取单个 NewSessionDir，产出 {@link NewSessionRecord}。
 *
 * 缓存命中条件：`session.json` 与 `messages.jsonl` 的 `(mtimeMs, size)` **四个数全部**
 * 与缓存条目一致（Req 3.11）。命中时不 `readFile`、不解析，直接复用；否则重读重解析
 * 并写回缓存。
 *
 * 已知边界（Req 3.11 把失效判据限定为这两个文件，故此处如实记录）：单独往
 * `snapshots/` 里增删文件而不动这两个文件时，`hasAttachment` 会沿用缓存值。
 * 实际写快照必然伴随 `messages.jsonl` 追加对应的 `tool_call` / `tool_result` 事件，
 * 因此这个窗口在 Kiro 的写入序列下不出现；测试若要构造它，用
 * {@link __clearNewSessionCacheForTest} 显式清缓存。
 *
 * `sessionId` 取**目录名**而非 `session.json` 的 `id`：目录名是 Kiro 定位会话的实际
 * 依据（跳转命令 `kiroAgent.viewSession(sessionId)` 与占用统计都按它走），
 * 元数据里的 `id` 只是同一信息的副本，两者不一致时目录名才是真的。
 *
 * @returns 缺 `session.json` 或 `messages.jsonl`（含 stat 失败、JSON 非法）时返回
 *   `null`，表示该会话应被跳过（Req 3.9）。**不抛异常。**
 */
export function readNewSession(
  sessionDir: string,
  deps?: NewFormatFsDeps
): NewSessionRecord | null {
  const d = resolveDeps(deps);
  const metaPath = path.join(sessionDir, NEW_SESSION_META_FILENAME);
  const msgPath = path.join(sessionDir, MESSAGES_FILENAME);

  // 先 stat 两个必需文件：任一缺失即跳过该会话，且顺带拿到失效判据（Req 3.9、3.11）
  let metaStat: NewFormatStat;
  let msgStat: NewFormatStat;
  try {
    metaStat = d.statSync(metaPath);
    msgStat = d.statSync(msgPath);
  } catch {
    newSessionCache.delete(sessionDir);
    return null;
  }
  if (metaStat.isDirectory() || msgStat.isDirectory()) {
    newSessionCache.delete(sessionDir);
    return null;
  }

  const cached = newSessionCache.get(sessionDir);
  if (
    cached &&
    cached.metaMtimeMs === metaStat.mtimeMs &&
    cached.metaSize === metaStat.size &&
    cached.msgMtimeMs === msgStat.mtimeMs &&
    cached.msgSize === msgStat.size
  ) {
    return toRecord(sessionDir, cached);
  }

  let metaRaw: string;
  let msgRaw: string;
  try {
    metaRaw = d.readFileSync(metaPath, 'utf8');
    msgRaw = d.readFileSync(msgPath, 'utf8');
  } catch {
    newSessionCache.delete(sessionDir);
    return null;
  }

  const meta = parseNewSessionMeta(metaRaw);
  if (!meta) {
    // `session.json` 存在但不可解析：与缺文件同等处理，跳过该会话（Req 3.9）
    newSessionCache.delete(sessionDir);
    return null;
  }

  const parsed = parseMessagesJsonl(msgRaw);
  const entry: NewSessionCacheEntry = {
    sessionId: path.basename(sessionDir),
    metaMtimeMs: metaStat.mtimeMs,
    metaSize: metaStat.size,
    msgMtimeMs: msgStat.mtimeMs,
    msgSize: msgStat.size,
    title: normalizeTitle(meta.title),
    modified: resolveModified(meta.lastModifiedAt, msgStat.mtimeMs),
    text: parsed.text,
    firstUserText: parsed.firstUserText,
    hasImage: parsed.hasImage,
    // 两个条件任一成立即为真；上下文引用已成立时不再枚举 snapshots/（Req 3.7）
    hasAttachment: parsed.hasAttachment || snapshotsHaveFile(sessionDir, d),
  };
  newSessionCache.set(sessionDir, entry);
  return toRecord(sessionDir, entry);
}

/**
 * 最后修改时间（Req 3.10）：`lastModifiedAt` 优先，缺失或不是合法时间戳时回退
 * MessagesFile 的 mtime。
 *
 * 回退而不是取 0：排序按修改时间倒序，0 会把元数据略有残缺的会话永久压到列表末尾，
 * 而 `messages.jsonl` 的 mtime 恰是「最后写入对话」的时刻，语义上就是想要的那个值。
 */
function resolveModified(lastModifiedAt: string | undefined, msgMtimeMs: number): number {
  if (typeof lastModifiedAt === 'string' && lastModifiedAt.trim()) {
    const t = Date.parse(lastModifiedAt);
    if (Number.isFinite(t)) return t;
  }
  return msgMtimeMs;
}

/** 缓存条目 → 对外记录（每次返回新对象，调用方的改动不会污染缓存）。 */
function toRecord(dir: string, e: NewSessionCacheEntry): NewSessionRecord {
  return {
    sessionId: e.sessionId,
    dir,
    title: e.title,
    modified: e.modified,
    text: e.text,
    firstUserText: e.firstUserText,
    hasImage: e.hasImage,
    hasAttachment: e.hasAttachment,
  };
}

/**
 * 清理缓存中已在目录里消失的会话（只清理该工作区目录下的键）。
 *
 * 与 `search.ts` 的同名收尾逻辑一致：FullCleanup 删掉整个 NewSessionDir 后，
 * 若不摘除缓存键，被删会话会一直留在缓存里占内存（记录本身不会被返回，
 * 因为 {@link listNewSessions} 每次都重新枚举目录）。
 *
 * 导出是为了让 `search.ts` 的 SessionSource 把它挂到 `evictMissing` 成员上——
 * 缓存归本模块所有，收尾也只能由本模块做，注入点因此拿到的是同一份实现。
 */
export function evictMissingNewSessions(
  workspaceSessionDir: string,
  seenDirs: ReadonlySet<string>
): void {
  const prefix = workspaceSessionDir.endsWith(path.sep)
    ? workspaceSessionDir
    : workspaceSessionDir + path.sep;
  for (const key of newSessionCache.keys()) {
    if (key.startsWith(prefix) && !seenDirs.has(key)) newSessionCache.delete(key);
  }
}
