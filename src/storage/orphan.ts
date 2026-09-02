import { readdir, stat, readFile } from 'fs/promises';
import * as path from 'path';
import { encodeWorkspaceKeys } from '../paths';
import type { ArchiveInfo } from '../credits';
import type { DirentLike, StatLike } from './scanner';
import type { OrphanStat } from './types';

/**
 * LiveSessionIds 采集与孤儿存档判定。
 *
 * 本模块位于 ReadOnlyPaths：只从 `fs/promises` 具名导入 `readdir` / `stat` /
 * `readFile` 三个读 API——写 API 连导入都不存在，因此「统计路径零写入」是模块图上
 * 可静态审查的事实，而不是注释里的承诺。模块也**不导出任何删除入口**：孤儿存档
 * 只被统计，清理能力集中在唯一可写模块 `cleaner.ts`（Req 3.7、8.6）。
 *
 * 结构上分两段，本文件按此顺序组织：
 *
 * 1. 采集：`collectLiveSessions` 枚举全部 WorkspaceSessionDir 下的 SessionFile 与
 *    各 SessionManifest，取 sessionId 并集（Req 3.1）
 * 2. 判定：`computeOrphans` 是纯函数，消费上一步的 `{ ids, complete }` 得出
 *    `OrphanStat`，不做任何 IO（Req 3.2–3.5）
 *
 * `OrphanState` / `OrphanStat` 的单一定义来源在 `./types`，此处只做 re-export，
 * 避免两处各自声明后出现口径漂移。
 */

export type { OrphanState, OrphanStat } from './types';

/**
 * Kiro 在每个 WorkspaceSessionDir 下维护的会话清单文件（顶层为数组）。
 * 它**不是**会话记录，因此不作为一条会话计入 `sessions`，但其中出现的
 * sessionId 仍并入 LiveSessionIds（Req 3.1，与 `search.ts` 的口径一致）。
 */
export const MANIFEST_FILENAME = 'sessions.json';

/**
 * 可注入的只读文件系统依赖。只暴露三个读调用，调用面白名单因此可被属性测试
 * 直接断言（Property 14(a)）。缺省退回 `fs/promises`，生产路径无额外抽象开销。
 */
export interface OrphanFsDeps {
  readdir: (p: string, o: { withFileTypes: true }) => Promise<DirentLike[]>;
  stat: (p: string) => Promise<StatLike>;
  readFile: (p: string, enc: 'utf8') => Promise<string>;
}

/** 单个工作区会话目录的明细，供报告的工作区排行与排行页取数复用（Req 6.3、13.2）。 */
export interface WorkspaceSessionsInfo {
  /** 目录名，即 EncodedKey */
  dirName: string;
  dirPath: string;
  /** 解码失败时为 null，调用方回退展示 `dirName`（Req 6.5） */
  decodedPath: string | null;
  /** 目录内直接文件条目的字节数合计（含 SessionManifest） */
  sessionBytes: number;
  /** 各会话的 JSON 字节数；不含 SessionManifest 自身 */
  sessions: Array<{ sessionId: string; jsonBytes: number }>;
}

export interface LiveSessionsResult {
  ids: Set<string>;
  /** 枚举与清单解析是否全部完成；false 时孤儿判定必须退化为 `pending`（Req 3.2） */
  complete: boolean;
  skippedCount: number;
  byWorkspace: WorkspaceSessionsInfo[];
}

const realFsDeps: OrphanFsDeps = {
  readdir: (p, o) => readdir(p, o) as unknown as Promise<DirentLike[]>,
  stat: (p) => stat(p) as unknown as Promise<StatLike>,
  readFile: (p, enc) => readFile(p, enc),
};

/** 只接受有限正数字节数，其余（NaN / 负数）按 0 计，避免污染合计。 */
function safeBytes(size: number): number {
  return Number.isFinite(size) && size > 0 ? size : 0;
}

/**
 * 解析 SessionManifest，返回其中出现的 sessionId。
 *
 * 返回 `null` 表示「文件存在但解析未完成」（读失败 / JSON 非法 / 顶层不是数组），
 * 调用方据此累加 `skippedCount` 并置 `complete = false`；清单**不存在**不算失败，
 * 这是绝大多数目录的常态。
 */
async function readManifestIds(
  deps: OrphanFsDeps,
  manifestPath: string,
  exists: boolean
): Promise<string[] | null> {
  if (!exists) return [];
  let raw: string;
  try {
    raw = await deps.readFile(manifestPath, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: string[] = [];
  for (const item of parsed) {
    const id = (item as { sessionId?: unknown } | null)?.sessionId;
    if (typeof id === 'string' && id.length > 0) out.push(id);
  }
  return out;
}

/**
 * 枚举 `sessionsRoot` 下全部 WorkspaceSessionDir，返回 LiveSessionIds 与各目录明细。
 *
 * - sessionId 取「SessionFile 文件名（去 `.json`）」与「各 SessionManifest 中的
 *   `sessionId` 字段」的并集；`sessions.json` 自身不作为一条会话记录（Req 3.1）
 * - 不读取 SessionFile 内容：sessionId 由文件名得出，字节数由 `stat` 得出，
 *   因此采集成本与会话体积无关
 * - 符号链接不跟随；无法枚举 / stat / 解析的条目累加 `skippedCount` 并把
 *   `complete` 置为 false，使孤儿判定退化为 `pending` 而非误判（Req 3.2、9.1）
 */
export async function collectLiveSessions(
  sessionsRoot: string,
  deps: OrphanFsDeps = realFsDeps
): Promise<LiveSessionsResult> {
  const ids = new Set<string>();
  const byWorkspace: WorkspaceSessionsInfo[] = [];
  let skippedCount = 0;

  let rootEntries: DirentLike[];
  try {
    rootEntries = await deps.readdir(sessionsRoot, { withFileTypes: true });
  } catch {
    // 会话根目录不存在或不可读：枚举未完成，交给 computeOrphans 退化为 pending
    return { ids, complete: false, skippedCount: 1, byWorkspace };
  }

  for (const entry of rootEntries) {
    // 符号链接一律不跟随（避免循环链接与跨目录重复计数）。无法枚举的目录会让
    // LiveSessionIds 不完整，故计入跳过而不是静默忽略——否则现存会话的存档可能
    // 被误判为孤儿。
    if (entry.isSymbolicLink()) {
      skippedCount += 1;
      continue;
    }
    if (!entry.isDirectory()) continue;

    const dirPath = path.join(sessionsRoot, entry.name);
    let dirEntries: DirentLike[];
    try {
      dirEntries = await deps.readdir(dirPath, { withFileTypes: true });
    } catch {
      skippedCount += 1;
      continue;
    }

    const info: WorkspaceSessionsInfo = {
      dirName: entry.name,
      dirPath,
      decodedPath: decodeWorkspaceKey(entry.name),
      sessionBytes: 0,
      sessions: [],
    };
    let manifestExists = false;

    for (const child of dirEntries) {
      if (child.isSymbolicLink()) {
        skippedCount += 1;
        continue;
      }
      // 子目录不参与会话目录的直接文件字节数合计（与 scanner 的口径一致：
      // 目录条目自身不计字节数）
      if (child.isDirectory()) continue;

      const full = path.join(dirPath, child.name);
      let st: StatLike;
      try {
        st = await deps.stat(full);
      } catch {
        skippedCount += 1;
        continue;
      }
      if (st.isDirectory()) continue;

      const bytes = safeBytes(st.size);
      info.sessionBytes += bytes;

      if (child.name === MANIFEST_FILENAME) {
        manifestExists = true;
        continue;
      }
      if (!child.name.endsWith('.json')) continue;

      const sessionId = path.basename(child.name, '.json');
      if (!sessionId) continue;
      ids.add(sessionId);
      info.sessions.push({ sessionId, jsonBytes: bytes });
    }

    const manifestIds = await readManifestIds(
      deps,
      path.join(dirPath, MANIFEST_FILENAME),
      manifestExists
    );
    if (manifestIds === null) {
      skippedCount += 1;
    } else {
      for (const id of manifestIds) ids.add(id);
    }

    byWorkspace.push(info);
  }

  return { ids, complete: skippedCount === 0, skippedCount, byWorkspace };
}

/* ------------------------------------------------------------------ *
 * 孤儿判定
 * ------------------------------------------------------------------ */

/**
 * 孤儿统计的固定说明文案，由两段构成：
 *
 * 1. 机制说明（Req 3.6）：这些字节的来源不是 bug，而是 Kiro 执行存档 LRU 索引
 *    只淘汰内存条目、不删磁盘文件
 * 2. 限制理由（Req 3.7）：孤儿存档不归属 UsageRankingPage 上任一可展示的会话行，
 *    无法满足「只删除已枚举并展示给用户的具体文件」（Req 14.8），因此**只**否定
 *    「批量清理孤儿」这一个入口
 *
 * 文案刻意不写「本版本仅统计、不提供清理」——本特性是提供清理的（排行页上逐会话
 * 的附件清理与全量清理），那种写法会被读成整个特性没有清理能力。所以否定句被限定
 * 到「批量」，并紧接着把用户引导到真正可用的清理入口。
 */
export const ORPHAN_NOTE =
  '孤儿存档来自 Kiro 执行存档的 LRU 索引只淘汰内存条目、磁盘文件仍残留的机制：' +
  '索引里查不到的存档，文件本身还在盘上。' +
  '这类存档不归属占用排行页上任一可展示的会话行，无法满足「只删除已枚举并展示给用户的具体文件」这一前提，' +
  '因此不提供孤儿存档的批量清理入口；要释放空间请在占用排行页上对具体会话执行附件清理或全量清理。';

/** `chatSessionId` 是否可用于归因。缺失 / 空串 / 纯空白都视为无归因。 */
function hasOwner(chatSessionId: string | null | undefined): boolean {
  return typeof chatSessionId === 'string' && chatSessionId.trim().length > 0;
}

/**
 * 纯函数：给定存档条目与 LiveSessionIds 判定孤儿合计（Req 3.2–3.6）。
 *
 * 判定顺序是有意为之的三级短路，两个前置分支都属于「拿不到可信的现存会话集合」，
 * 此时任何判定都可能把活跃会话的存档误报成垃圾，故一律返回 0 而不是尽力而为：
 *
 * 1. `live.complete === false`（枚举 / 清单解析有跳过）→ `pending`：LiveSessionIds
 *    不完整，缺失的那部分 id 会让其存档凭空变成孤儿（Req 3.2）
 * 2. `live.ids.size === 0`（会话目录不存在、全部不可读、或目录存在但有效会话数为 0）
 *    → `unknown`：此时「不属于任何现存会话」对所有存档都成立，把全部存档判为孤儿
 *    是数值上正确却毫无信息量的结论（Req 3.5）
 * 3. 否则 → `ok`：`chatSessionId` 缺失或不在 `live.ids` 中的存档计入合计（Req 3.3、3.4）
 *
 * `pending` 与 `unknown` 两态下 `bytes` 与 `files` 恒为 0。
 *
 * 本模块不导出任何删除入口，判定结果只用于展示。FullCleanup 删掉某会话的
 * SessionFile 与清单条目后，它的残留存档会在下一次统计中因 id 已不在 LiveSessionIds
 * 里而自然落入这里的孤儿集合（Req 3.8）——是上述规则的推论，无需额外代码。
 */
export function computeOrphans(
  archives: readonly ArchiveInfo[],
  live: { ids: ReadonlySet<string>; complete: boolean }
): OrphanStat {
  if (!live.complete) {
    return { state: 'pending', bytes: 0, files: 0, note: ORPHAN_NOTE };
  }
  if (live.ids.size === 0) {
    return { state: 'unknown', bytes: 0, files: 0, note: ORPHAN_NOTE };
  }

  let bytes = 0;
  let files = 0;
  for (const a of archives) {
    if (hasOwner(a.chatSessionId) && live.ids.has(a.chatSessionId as string)) continue;
    bytes += safeBytes(a.size);
    files += 1;
  }
  return { state: 'ok', bytes, files, note: ORPHAN_NOTE };
}

/* ------------------------------------------------------------------ *
 * EncodedKey 解码
 * ------------------------------------------------------------------ */

/**
 * 判断解码结果是否像一个工作区绝对路径。
 *
 * 任意目录名喂给 base64 解码都会得到某串字节，故必须做一次形态校验，
 * 否则报告会展示乱码而不是回退到原始目录名（Req 6.5）。
 */
function isPlausibleWorkspacePath(s: string): boolean {
  if (!s) return false;
  // 控制字符与 U+FFFD（无效 UTF-8 的替换字符）说明这串字节不是路径文本
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\ufffd]/.test(s)) return false;
  // Windows 盘符（C:\ 或 C:/）、POSIX 绝对路径（/…）、UNC（\\server\share）
  return /^[a-zA-Z]:[\\/]/.test(s) || /^[\\/]/.test(s);
}

/**
 * EncodedKey → 工作区绝对路径；失败返回 `null`（调用方回退展示原始目录名）。
 *
 * 是 `encodeWorkspaceKeys` 的逆向：编码把 `+`→`-`、`/`→`_`，并把 `=` padding
 * **也**替换为 `_`，因此尾部下划线到底是 `/` 还是 padding 存在歧义。做法是按
 * 可能的 padding 长度（受尾部下划线个数限制，至多 2）逐个尝试，并用「再编码一次
 * 是否得回原 key」作为判据——判据直接调用 `encodeWorkspaceKeys(decoded)[0]`
 * （原始路径对应的键恒在首位），因此解码与编码规则不可能漂移。
 *
 * 由于 `/` 与 `=` 共用 `_`，该编码本身不是单射：`…cA_` 既可能来自「base64 带
 * 1 位 padding」，也可能来自「base64 末位恰是 `/`」——两个候选都能通过再编码
 * 校验。因此尝试顺序取 padding 从多到少：padding 分支覆盖 2/3 的路径长度，
 * 而末位为 `/` 要求最后一个字节的低 6 位全为 1（ASCII 下即以 `?` 结尾，
 * Windows 路径非法、POSIX 路径罕见）。歧义不可消除，只能取更可能的一支；
 * 取错时调用方拿到的仍是一个合法路径文本，展示层无需特殊处理。
 */
export function decodeWorkspaceKey(key: string): string | null {
  if (typeof key !== 'string' || key.length === 0) return null;
  // 编码保留了 padding，故合法键长度恒为 4 的倍数且只含 base64url 字符
  if (key.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9\-_]+$/.test(key)) return null;

  const trailingUnderscores = key.length - key.replace(/_+$/, '').length;
  const maxPad = Math.min(2, trailingUnderscores);

  for (let pad = maxPad; pad >= 0; pad--) {
    const body = key.slice(0, key.length - pad);
    const b64 = body.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
    let decoded: string;
    try {
      decoded = Buffer.from(b64, 'base64').toString('utf8');
    } catch {
      continue;
    }
    if (!decoded) continue;
    // Buffer 的 base64 解码对非法输入是宽容的，所以必须用「再编码」精确校验
    if (encodeWorkspaceKeys(decoded)[0] !== key) continue;
    if (!isPlausibleWorkspacePath(decoded)) continue;
    return decoded;
  }
  return null;
}
