import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { MESSAGES_FILENAME } from './session/newFormat';

/**
 * Kiro 把"每次执行（execution）"的用量摘要存在独立的磁盘缓存里，而不是写进
 * 会话历史 JSON。每个执行存档是一份 JSON，含 `chatSessionId`（该执行所属会话）与
 * 末尾的 `usageSummary` 数组：
 *   [{ "usage": 0.0097, "unit": "credit", "unitPlural": "credits" }, { "usedTools": [...] }, ...]
 *
 * 关键关联方式（逆向自 Kiro 扩展）：
 *  - 执行存储目录 = <globalStorage>/kiro.kiroagent/<workspaceId>/[<hash(SAVES)>/]<hash(executionId)>，
 *    其中 workspaceId = sha256(工作区 fsPath) 十六进制前 32 位（见 ExecutionLogController）。
 *  - 单个执行存档里的 `chatSessionId` 标明它属于哪个会话。
 *  - 普通对话里 `history[].executionId` 直接指向带 usageSummary 的执行；但 **spec / checkpoint
 *    会话**经 `migrateExecutionToSession` 迁移后，history 引用的是无 usageSummary 的记录，真正
 *    的 credit 落在以 `chatSessionId` 标记的执行上。因此本模块统一按 `chatSessionId` 汇总，
 *    比按 history 的 executionId 反查更稳。
 *
 * 该缓存为 LRU（约 500 条执行），旧执行会被淘汰。本模块只读不写。
 *
 * ---
 *
 * **适用范围收窄（Req 4.6）**：以上存档查表机制是 **0.9x 专属**的。Kiro 1.x 把用量搬进了
 * 会话自己的 `messages.jsonl`（`usage_summary` 事件），`hash32(executionId)` → 独立存档
 * 文件这条链路在 1.x 上完全失效。因此本文件分成两段：
 *
 * 1. **0.9x 存档查表**（本段起至 {@link getCreditsForSessions}）——签名与行为一字不改
 * 2. **1.x 消息流取数**（见文件末尾「1.x：从 messages.jsonl 读用量」一节）
 *
 * 两段由 {@link getSessionCreditScopes} 按会话所属格式分派，使上层拿到的 credit 语义
 * 在两种格式下一致（均为「该会话消耗的 credit」，Req 4.9）。求和口径只有一份实现
 * （{@link sumCreditItems}），0.9x 与 1.x 共用，避免两边对「什么算 credit」各持一套。
 */

/** sha256(s) 的十六进制前 32 位——与 Kiro storage 的路径哈希算法一致。 */
export function hash32(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 32);
}

/**
 * 由工作区 fsPath 生成执行存储目录名（workspaceId）的候选集合。
 * Kiro 用 sha256(currentWorkspace.fsPath)；不同系统盘符大小写与斜杠方向有差异，
 * 故对若干变体分别哈希，去重返回。
 */
export function workspaceIdCandidates(workspacePath: string): string[] {
  const variants = new Set<string>();
  const add = (p: string) => variants.add(p);
  add(workspacePath);
  if (/^[a-zA-Z]:/.test(workspacePath)) {
    add(workspacePath[0].toUpperCase() + workspacePath.slice(1));
    add(workspacePath[0].toLowerCase() + workspacePath.slice(1));
  }
  for (const v of [...variants]) {
    add(v.replace(/\\/g, '/'));
    add(v.replace(/\//g, '\\'));
  }
  return [...new Set([...variants].map(hash32))];
}

/** 读取大小：头部足够覆盖顶层 chatSessionId；尾部覆盖末尾 usageSummary。 */
const HEAD_BYTES = 512 * 1024;
const TAIL_BYTES = 128 * 1024;

/** 单个执行存档的解析缓存条目（按 mtime+size 失效）。 */
interface ArchiveEntry {
  mtimeMs: number;
  size: number;
  chatSessionId: string | null;
  credit: number;
  hasUsage: boolean;
  /** 该执行迁移历史中的祖先会话 id（checkpoint 链）。 */
  parentSessionIds: string[];
}

/** 执行存档解析缓存：键为文件绝对路径。 */
const archiveCache = new Map<string, ArchiveEntry>();

/** 目录扫描节流。scope 变化（切换工作区）或超时则重扫。 */
let scanState: { scope: string; scannedAt: number } | null = null;
const SCAN_TTL_MS = 4000;

/**
 * 测试辅助：清空所有进程内缓存。
 *
 * 覆盖 0.9x 的 ArchiveIndex + 扫描节流状态，以及 1.x 的消息流用量缓存
 * （{@link __clearMessagesCreditCacheForTest}）——"所有"这个承诺随 1.x 取数路径的加入
 * 一并兑现，既有调用方（`afterEach` 里清缓存的测试）无需改动即可覆盖新缓存。
 */
export function __clearCreditCacheForTest(): void {
  archiveCache.clear();
  scanState = null;
  __clearMessagesCreditCacheForTest();
}

/**
 * 由会话目录推导执行存储根目录。
 * 会话目录形如 <kiroagent>/workspace-sessions/<key>，向上两级即 kiroagent 根。
 */
export function storeRootFromSessionDir(sessionDir: string): string {
  return path.resolve(sessionDir, '..', '..');
}

const HEX32 = /^[0-9a-f]{32}$/;
const CHAT_SESSION_RE = /"chatSessionId"\s*:\s*"([^"]+)"/;
/** 锚定真正的 usageSummary 字段（键+冒号+数组），避免匹配正文里的词。 */
const USAGE_KEY_RE = /"usageSummary"\s*:\s*\[/;
const PARENT_IDS_RE = /"parentSessionIds"\s*:\s*\[([^\]]*)\]/;

/** 从 "parentSessionIds":[...] 文本里抽出其中的字符串 id 列表。 */
function extractParentSessionIds(raw: string): string[] {
  const m = PARENT_IDS_RE.exec(raw);
  if (!m) return [];
  const ids: string[] = [];
  const re = /"([^"]+)"/g;
  let s: RegExpExecArray | null;
  while ((s = re.exec(m[1])) !== null) ids.push(s[1]);
  return ids;
}

/**
 * 从执行存档原文中切出 "usageSummary": [...] 的数组文本。
 * - 锚定 `"usageSummary"<空白>:<空白>[` 模式，避免匹配 operations 正文里出现的
 *   "usageSummary" 词（如本类对话本身的存档）。
 * - 取**最后一个**匹配：真正的顶层 usageSummary 字段在 operations 之后、接近文件末尾。
 * - 括号配对（字符串感知）扫描，避免被字符串内的 ] 提前截断。
 */
export function extractUsageSummaryArray(raw: string): string | null {
  const re = /"usageSummary"\s*:\s*\[/g;
  let m: RegExpExecArray | null;
  let last: RegExpExecArray | null = null;
  while ((m = re.exec(raw)) !== null) last = m;
  if (!last) return null;
  const start = last.index + last[0].length - 1; // '[' 的位置

  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let j = start; j < raw.length; j++) {
    const c = raw[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return raw.slice(start, j + 1);
    }
  }
  return null;
}

/**
 * 单个用量项是否为「带 credit 单位标记的有效数值」。
 *
 * 判据三条，缺一不算：`usage` 是有限数（`NaN` / `Infinity` 不参与求和）、`unit` 是字符串、
 * `unit` **不区分大小写**等于 `credit`（实测既有 `credit` 也有 `CREDIT` 写法）。
 * 不带 credit 单位标记的项——最典型的是只有 `usedTools` 的工具使用记录——据此被排除在
 * 求和之外（Req 4.2）。负数按原值累加：这里只做单位过滤，不替 Kiro 校正它写下的数值。
 */
function isCreditItem(it: unknown): it is { usage: number; unit: string } {
  if (!it || typeof it !== 'object') return false;
  const o = it as { usage?: unknown; unit?: unknown };
  return (
    typeof o.usage === 'number' &&
    isFinite(o.usage) &&
    typeof o.unit === 'string' &&
    o.unit.toLowerCase() === 'credit'
  );
}

/**
 * 值层求和：把一个**已解析**的用量项数组里 unit==='credit' 的 usage 累加。
 *
 * 这是 0.9x 与 1.x 唯一的求和实现：0.9x 走 {@link sumCreditsFromUsageSummary}
 * （文本入口，内部解析后落到这里），1.x 走 {@link parseCreditsFromMessages}
 * （JSONL 行已经是解析后的对象，直接落到这里）。两条路径共用同一谓词，
 * 因此「什么算 credit」在两种格式下恒一致。
 *
 * `count` 是参与求和的项数，供 1.x 区分「合计为 0」与「一项 credit 都没有」
 * （后者要标记为不可用而不是 0，Req 4.7）——0.9x 侧不需要它，故未暴露到公开 API。
 */
function sumCreditItems(arr: unknown): { credits: number; count: number } {
  if (!Array.isArray(arr)) return { credits: 0, count: 0 };
  let credits = 0;
  let count = 0;
  for (const it of arr) {
    if (isCreditItem(it)) {
      credits += it.usage;
      count++;
    }
  }
  return { credits, count };
}

/**
 * 把 usageSummary 数组文本里 unit==='credit' 的 usage 求和。
 *
 * 0.9x 存档查表的入口，签名与语义保持不变（非数组 / 损坏输入恒返回 0）；
 * 求和谓词委托给共用的 {@link sumCreditItems}，与 1.x 消息流取数同口径。
 */
export function sumCreditsFromUsageSummary(arrayText: string): number {
  let arr: unknown;
  try {
    arr = JSON.parse(arrayText);
  } catch {
    return 0;
  }
  return sumCreditItems(arr).credits;
}

/** 读文件头部+尾部；若头部找不到 chatSessionId，则整读以确保可靠提取。 */
function readForParse(file: string, size: number): { head: string; tail: string; full: string | null } {
  if (size <= HEAD_BYTES + TAIL_BYTES) {
    const all = fs.readFileSync(file, 'utf8');
    return { head: all, tail: all, full: all };
  }
  const fd = fs.openSync(file, 'r');
  try {
    const headBuf = Buffer.allocUnsafe(HEAD_BYTES);
    fs.readSync(fd, headBuf, 0, HEAD_BYTES, 0);
    const tailBuf = Buffer.allocUnsafe(TAIL_BYTES);
    fs.readSync(fd, tailBuf, 0, TAIL_BYTES, size - TAIL_BYTES);
    return { head: headBuf.toString('utf8'), tail: tailBuf.toString('utf8'), full: null };
  } finally {
    fs.closeSync(fd);
  }
}

/** 解析单个执行存档，提取 chatSessionId 与 credit。 */
function parseArchive(file: string, size: number): Omit<ArchiveEntry, 'mtimeMs' | 'size'> {
  let head: string;
  let tail: string;
  let full: string | null;
  try {
    ({ head, tail, full } = readForParse(file, size));
  } catch {
    return { chatSessionId: null, credit: 0, hasUsage: false, parentSessionIds: [] };
  }

  // chatSessionId：先头部，再尾部；仍找不到且是大文件，则整读兜底。
  let chatSessionId: string | null = null;
  let m = CHAT_SESSION_RE.exec(head);
  if (!m && tail !== head) m = CHAT_SESSION_RE.exec(tail);
  if (!m && full === null) {
    try {
      full = fs.readFileSync(file, 'utf8');
      m = CHAT_SESSION_RE.exec(full);
    } catch {
      /* ignore */
    }
  }
  if (m) chatSessionId = m[1];

  // parentSessionIds（checkpoint 祖先链）位于顶部，随 chatSessionId 一并取。
  const parentSource = full ?? head;
  const parentSessionIds = extractParentSessionIds(parentSource);

  // usageSummary 在文件末尾，通常落在尾部窗口内。
  let credit = 0;
  let hasUsage = false;
  if (USAGE_KEY_RE.test(tail)) {
    let arrText = extractUsageSummaryArray(tail);
    if (arrText === null) {
      // 字段存在但数组被尾部窗口截断（usageSummary 超大）→ 整读兜底。
      if (full === null) {
        try {
          full = fs.readFileSync(file, 'utf8');
        } catch {
          /* ignore */
        }
      }
      if (full) arrText = extractUsageSummaryArray(full);
    }
    if (arrText !== null) {
      hasUsage = true;
      credit = sumCreditsFromUsageSummary(arrText);
    }
  } else if (full && full !== tail && USAGE_KEY_RE.test(full)) {
    const arrText = extractUsageSummaryArray(full);
    if (arrText !== null) {
      hasUsage = true;
      credit = sumCreditsFromUsageSummary(arrText);
    }
  }
  return { chatSessionId, credit, hasUsage, parentSessionIds };
}

/** 递归遍历一个目录，解析其中的 hex 命名执行存档（按 mtime/size 复用缓存）。 */
function walkScope(dir: string, depth: number, maxDepth: number, seen: Set<string>): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth < maxDepth) walkScope(full, depth + 1, maxDepth, seen);
    } else if (HEX32.test(e.name)) {
      seen.add(full);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      const cached = archiveCache.get(full);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) continue;
      const parsed = parseArchive(full, stat.size);
      archiveCache.set(full, { mtimeMs: stat.mtimeMs, size: stat.size, ...parsed });
    }
  }
}

/**
 * 刷新执行存档索引。优先把扫描限定在当前工作区对应的 workspaceId 目录，
 * 避免遍历其它工作区的大量大文件；定位不到时回退扫描整个 storeRoot。
 */
function refreshIndex(storeRoot: string, scopeDirs: string[], force = false): void {
  const scope = scopeDirs.length ? scopeDirs.join('|') : storeRoot;
  const now = Date.now();
  if (!force && scanState && scanState.scope === scope && now - scanState.scannedAt < SCAN_TTL_MS) {
    return;
  }

  const seen = new Set<string>();
  if (scopeDirs.length) {
    for (const d of scopeDirs) walkScope(d, 1, 2, seen);
  } else {
    // 回退：扫描整棵树（跳过 workspace-sessions）
    const root = storeRoot;
    const walkAll = (dir: string, depth: number) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (depth < 3 && e.name !== 'workspace-sessions') walkAll(full, depth + 1);
        } else if (HEX32.test(e.name)) {
          seen.add(full);
          let stat: fs.Stats;
          try {
            stat = fs.statSync(full);
          } catch {
            continue;
          }
          const cached = archiveCache.get(full);
          if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) continue;
          archiveCache.set(full, { mtimeMs: stat.mtimeMs, size: stat.size, ...parseArchive(full, stat.size) });
        }
      }
    };
    walkAll(root, 1);
  }

  // 清理本次未见到、但属于本 scope 的旧条目
  const prefixes = scopeDirs.length ? scopeDirs : [storeRoot];
  for (const key of archiveCache.keys()) {
    if (prefixes.some((p) => key.startsWith(p)) && !seen.has(key)) {
      archiveCache.delete(key);
    }
  }

  scanState = { scope, scannedAt: now };
}

/**
 * 把 workspacePath 解析为 storeRoot 下实际存在的 workspaceId 目录列表。
 * 定位不到（返回空数组）时调用方回退扫描整个 storeRoot。
 */
function resolveScopeDirs(storeRoot: string, workspacePath?: string): string[] {
  if (!workspacePath) return [];
  return workspaceIdCandidates(workspacePath)
    .map((id) => path.join(storeRoot, id))
    .filter((d) => {
      try {
        return fs.statSync(d).isDirectory();
      } catch {
        return false;
      }
    });
}

/** ArchiveIndex 中单个执行存档的只读视图。 */
export interface ArchiveInfo {
  /** 存档文件绝对路径 */
  path: string;
  /** 文件名，即 hash32(executionId)，供 history executionId 反查 */
  name: string;
  size: number;
  chatSessionId: string | null;
}

/**
 * 返回 ArchiveIndex 的只读快照。内部走既有 refreshIndex（4 秒节流），
 * 不新增扫描策略、不读取存档内容——`size` 与 `chatSessionId` 均取自已有缓存条目。
 * @param storeRoot kiroagent 目录，见 storeRootFromSessionDir。
 * @param opts.workspacePath 当前工作区 fsPath，用于把刷新范围限定到对应 workspaceId 目录。
 */
export function listArchiveEntries(storeRoot: string, opts: { workspacePath?: string } = {}): ArchiveInfo[] {
  refreshIndex(storeRoot, resolveScopeDirs(storeRoot, opts.workspacePath));

  const out: ArchiveInfo[] = [];
  for (const [p, e] of archiveCache) {
    out.push({ path: p, name: path.basename(p), size: e.size, chatSessionId: e.chatSessionId });
  }
  return out;
}

/**
 * 从 ArchiveIndex 中摘除指定绝对路径的条目，返回实际摘除的条目数。
 * 只删 Map 键，不接受 sessionId、不做匹配、不触发扫描、不改节流状态；用于文件已被
 * SessionCleaner 删除后立即让索引与磁盘一致，避免 4 秒节流窗口内继续用陈旧条目算占用。
 */
export function dropArchiveEntries(paths: readonly string[]): number {
  let dropped = 0;
  for (const p of paths) {
    if (archiveCache.delete(p)) dropped++;
  }
  return dropped;
}

/** 一个会话的 credit 汇总结果。 */
export interface SessionCredits {
  /** 该会话所有执行存档汇总出的总 credit。 */
  credits: number;
  /**
   * 是否至少有一条该会话的执行存档**带 usageSummary 用量数据**。
   * 用于区分"该对话确实消耗 0 credit"与"没记录用量 / 已被 LRU 淘汰"。
   */
  found: boolean;
}

export interface CreditQueryOptions {
  /** 当前工作区 fsPath，用于把扫描限定到对应的 workspaceId 目录（强烈建议传入）。 */
  workspacePath?: string;
  /**
   * 是否纳入 checkpoint 祖先链的消耗（默认 true）。
   * spec 的 checkpoint 会话会从父会话继承整段对话，其消耗记在父/祖先会话的 chatSessionId 下；
   * 开启后会把祖先会话一并合计，得到整条对话的总消耗。
   */
  includeLineage?: boolean;
  /**
   * 该会话 history 引用的 executionId。checkpoint 会话的 history 引用的执行往往属于
   * 祖先会话——据此把这些执行所属的 chatSessionId 并入 lineage（这是连接 checkpoint
   * 与其源会话最可靠的线索）。
   */
  historyExecutionIds?: readonly string[];
}

/**
 * 由目标会话出发求 lineage 会话集合：把 history 引用的执行所属的 chatSessionId 并入。
 * 这是连接 checkpoint 会话与其源（祖先）会话最可靠的、有方向的线索——checkpoint 的
 * history 引用的执行属于祖先会话，因此一层并入即可覆盖整条 lineage（history 通常已包含
 * 各祖先轮次的执行）。不使用 parentSessionIds 做传递闭包，以免反向/跨链过度连接而高估。
 * 返回包含目标自身的会话 id 集合。
 */
function lineageClosure(
  seeds: Set<string>,
  byName: Map<string, ArchiveEntry>,
  historyExecutionIds?: readonly string[]
): Set<string> {
  const out = new Set(seeds);
  if (historyExecutionIds) {
    for (const eid of historyExecutionIds) {
      const ent = byName.get(hash32(eid));
      if (ent?.chatSessionId) out.add(ent.chatSessionId);
    }
  }
  return out;
}

/**
 * 汇总属于给定会话的总 credit 用量（按执行存档的 `chatSessionId` 匹配）。
 * 默认纳入 checkpoint 祖先链（见 includeLineage / historyExecutionIds）。
 * @param storeRoot kiroagent 目录，见 storeRootFromSessionDir。
 * @param sessionIds 目标 sessionId 列表（通常一个）。
 */
export function getCreditsForSessions(
  storeRoot: string,
  sessionIds: readonly string[],
  opts: CreditQueryOptions = {}
): SessionCredits {
  const seeds = new Set(sessionIds.filter(Boolean));
  if (seeds.size === 0) return { credits: 0, found: false };

  refreshIndex(storeRoot, resolveScopeDirs(storeRoot, opts.workspacePath));

  let wanted: Set<string>;
  if (opts.includeLineage === false) {
    wanted = seeds;
  } else {
    // 文件名(hash(executionId)) → 条目，供 history executionId 反查所属会话
    const byName = new Map<string, ArchiveEntry>();
    for (const [p, e] of archiveCache) byName.set(path.basename(p), e);
    wanted = lineageClosure(seeds, byName, opts.historyExecutionIds);
  }

  let credits = 0;
  let found = false;
  for (const entry of archiveCache.values()) {
    if (entry.chatSessionId && entry.hasUsage && wanted.has(entry.chatSessionId)) {
      found = true;
      credits += entry.credit;
    }
  }
  return { credits, found };
}

/* ================================================================== *
 * 1.x：从 messages.jsonl 读用量（任务 6.1 / 6.2）
 * ================================================================== */

/**
 * UsageSummaryEvent 的 `payload.type` 取值。
 *
 * 该事件是 1.x 唯一的用量来源：0.9x 的独立执行存档在 1.x 下不复存在，
 * 用量随对话一起追加进会话自己的 `messages.jsonl`。
 */
const USAGE_SUMMARY_TYPE = 'usage_summary';

/**
 * 承载用量项数组的字段名（有序，**取首个存在的数组**）。
 *
 * 实测形状（Kiro 1.0.337，`payload` 已展开）：
 *
 * ```json
 * {
 *   "type": "usage_summary",
 *   "promptTurnSummaries": [
 *     { "unit": "credit", "unitPlural": "credits", "usage": 147.15, "usedTools": ["read_file", ...] }
 *   ],
 *   "elapsedTime": 1056804, "status": "success",
 *   "executionId": "25dcf9dc-...", "requestIds": ["..."]
 * }
 * ```
 *
 * 用量项与 0.9x 存档里 `usageSummary` 数组的项**同构**（都是 `{usage, unit, unitPlural}`，
 * 只是 1.x 把 `usedTools` 并进了同一项而不是另立一项），因此求和直接复用
 * {@link sumCreditItems}，无需为 1.x 另写一份口径。
 *
 * `usageSummary` 作为同名兜底列在后面：1.x 若把字段名回退成 0.9x 的写法，取数不至于
 * 整体失效。**取首个存在的数组而不是累加全部**，避免同一份数据被两个别名重复计入。
 * 两个键都不存在（如实测到的 `"promptTurnSummaries": []` 之外的未知形状）时该事件贡献
 * 0 项——按「不可用」而不是猜一个数字处理（Req 4.7）。
 */
const USAGE_ARRAY_KEYS = ['promptTurnSummaries', 'usageSummary'] as const;

/** 1.x 会话的用量解析结果。 */
export interface MessagesCredits {
  /**
   * credit 合计；**不可用时为 `null`**（Req 4.7）。
   *
   * `null` 与 `0` 严格区分：`0` 是"这个会话确实没花 credit"，`null` 是"没有可用的用量
   * 记录"（无 `usage_summary` 事件、事件里没有任何 credit 单位项、或文件读不出来）。
   * 上层据此决定**省略**角标而不是显示一个 0（Req 4.8）。
   */
  credits: number | null;
  /** 是否取到可用用量；恒等于 `credits !== null`，与 {@link SessionCredits.found} 同名同义。 */
  found: boolean;
  /** 命中的 UsageSummaryEvent 条数。用于区分「一条用量事件都没有」与「有事件但无 credit 项」。 */
  usageSummaryCount: number;
  /** 参与求和的 credit 项数（`usage` 为有限数且 `unit` 为 credit 的项）。 */
  creditItemCount: number;
}

/** `statSync` 返回值中本段用到的最小形状（真实 `fs.Stats` 结构上即满足）。 */
export interface CreditFileStat {
  size: number;
  mtimeMs: number;
}

/**
 * 可注入的**只读**文件系统依赖（风格对齐 `session/newFormat.ts` 的 `NewFormatFsDeps`）。
 *
 * 只暴露 `statSync` 与 `readFileSync` 两个读调用：写 API 不在这里、也不在本模块的 import
 * 里，因此「CreditReader 只读」是模块依赖图上可静态审查的事实（Req 4.10、12.2）。
 * 缺省退回真实 `fs`，生产路径无额外抽象开销；注入点的存在使「无 `usage_summary`」
 * 「混入非 credit 单位项」「缓存按 `(mtimeMs, size)` 失效」这些用例都能脱离真实磁盘单测。
 */
export interface CreditFsDeps {
  statSync?: (p: string) => CreditFileStat;
  readFileSync?: (p: string, enc: 'utf8') => string;
}

interface ResolvedCreditDeps {
  statSync: (p: string) => CreditFileStat;
  readFileSync: (p: string, enc: 'utf8') => string;
}

function resolveCreditDeps(deps?: CreditFsDeps): ResolvedCreditDeps {
  return {
    statSync: deps?.statSync ?? ((p) => fs.statSync(p)),
    readFileSync: deps?.readFileSync ?? ((p, enc) => fs.readFileSync(p, enc)),
  };
}

/** 不可用结果的构造器（每次新对象，调用方改动不会串到缓存或其它调用点）。 */
function unavailableCredits(usageSummaryCount = 0): MessagesCredits {
  return { credits: null, found: false, usageSummaryCount, creditItemCount: 0 };
}

/**
 * 纯函数：逐行解析 MessagesFile 文本，汇总 1.x 会话的 credit 用量（Req 4.1、4.2、4.7）。
 *
 * - 只取 `payload.type === 'usage_summary'` 的事件；其余 13 种事件类型一概不看
 * - 每个事件里取首个存在的用量项数组（见 {@link USAGE_ARRAY_KEYS}），
 *   把 `unit` 不区分大小写等于 `credit` 的 `usage` 累加（口径见 {@link sumCreditItems}）
 * - **无 `usage_summary`、或全部 `usage_summary` 都没有 credit 项 → `credits` 为 `null`**
 *   （标记不可用，不是 0）
 * - 坏行容错：单行不是合法 JSON 就跳过该行，继续其余行——`messages.jsonl` 是追加写的，
 *   进程被杀会留下半行，不能因此把整个会话的用量判为不可读（与 NewFormatReader 同策略）
 *
 * **廉价预筛**：只对包含 `usage_summary` 这个 token 的行做 `JSON.parse`。单个会话的
 * `messages.jsonl` 可达数 MB，大头是 `tool_result` 与内嵌 base64，逐行全解析的开销远大于
 * 一次子串查找。代价是把字母写成 `\uXXXX` 转义的病态输入会被漏过——那种情况下结果是
 * 「不可用」而不是错误数字，与本函数其余边界的处理方向一致。
 */
export function parseCreditsFromMessages(raw: string): MessagesCredits {
  let credits = 0;
  let usageSummaryCount = 0;
  let creditItemCount = 0;

  for (const line of raw.split(/\r?\n/)) {
    // 预筛：不含 token 的行不可能是用量事件，跳过解析
    if (!line.includes(USAGE_SUMMARY_TYPE)) continue;

    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // 坏行跳过，不影响其余行
    }
    if (event === null || typeof event !== 'object') continue;

    const payload = (event as { payload?: unknown }).payload;
    if (payload === null || typeof payload !== 'object') continue;
    const p = payload as Record<string, unknown>;
    if (p.type !== USAGE_SUMMARY_TYPE) continue;

    usageSummaryCount++;
    for (const key of USAGE_ARRAY_KEYS) {
      if (!Array.isArray(p[key])) continue;
      const { credits: sum, count } = sumCreditItems(p[key]);
      credits += sum;
      creditItemCount += count;
      break; // 首个存在的数组即为该事件的用量来源
    }
  }

  if (creditItemCount === 0) return unavailableCredits(usageSummaryCount);
  return { credits, found: true, usageSummaryCount, creditItemCount };
}

/** 1.x 消息流用量的解析缓存条目（按 MessagesFile 的 mtime+size 失效）。 */
interface MessagesCreditEntry extends MessagesCredits {
  mtimeMs: number;
  size: number;
}

/**
 * 1.x 用量解析缓存：键为 `messages.jsonl` 的绝对路径。
 * 进程内内存缓存，不持久化（与 ArchiveIndex、会话索引一致）。
 */
const messagesCreditCache = new Map<string, MessagesCreditEntry>();

/** 测试辅助：清空 1.x 消息流用量缓存。 */
export function __clearMessagesCreditCacheForTest(): void {
  messagesCreditCache.clear();
}

/**
 * 读取一个 1.x 会话（NewSessionDir）的 credit 用量。
 *
 * 缓存判据是 `messages.jsonl` 的 `(mtimeMs, size)`（Req 4.11）：两个数都与缓存条目一致
 * 就直接复用，不 `readFile`、不解析。用量只随消息追加而变，而任何追加都会同时改变这两个
 * 数，因此这条判据既够灵敏又不会漏——与 NewFormatReader 的会话缓存同一策略。
 *
 * `stat` 或 `readFile` 失败（会话目录里没有 `messages.jsonl`、文件不可读）时返回**不可用**
 * 并摘除缓存键，**不抛异常**（Req 4.7）。
 *
 * @param sessionDir NewSessionDir 绝对路径（`<NewWorkspaceSessionDir>/<sessionId>`）。
 * @param deps 只读 fs 注入点，缺省用真实 `fs`。
 */
export function getCreditsFromMessages(sessionDir: string, deps?: CreditFsDeps): MessagesCredits {
  const d = resolveCreditDeps(deps);
  const file = path.join(sessionDir, MESSAGES_FILENAME);

  let stat: CreditFileStat;
  try {
    stat = d.statSync(file);
  } catch {
    messagesCreditCache.delete(file);
    return unavailableCredits();
  }

  const cached = messagesCreditCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return {
      credits: cached.credits,
      found: cached.found,
      usageSummaryCount: cached.usageSummaryCount,
      creditItemCount: cached.creditItemCount,
    };
  }

  let raw: string;
  try {
    raw = d.readFileSync(file, 'utf8');
  } catch {
    messagesCreditCache.delete(file);
    return unavailableCredits();
  }

  const parsed = parseCreditsFromMessages(raw);
  messagesCreditCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, ...parsed });
  return parsed;
}

/** 会话所属的存储格式：`new` = 1.x 目录型，`old` = 0.9x 单文件。 */
export type SessionStorageFormat = 'new' | 'old';

/** 两个 CreditScope（`self` / `lineage`）的取数结果。 */
export interface ScopedCredits {
  /** `self` 口径：该会话自身消耗；不可用为 `null`。 */
  self: number | null;
  /**
   * `lineage` 口径：整段对话累计（含 0.9x 的 checkpoint 祖先链）；不可用为 `null`。
   * **1.x 恒等于 {@link self}**，原因见 {@link getSessionCreditScopes}。
   */
  lineage: number | null;
  /** 是否至少一个口径可用（0.9x 的 checkpoint 会话可能 self 不可用而 lineage 可用）。 */
  found: boolean;
  /** 实际生效的取数路径，便于 tooltip 说明来源与排查。 */
  format: SessionStorageFormat;
}

/** {@link getSessionCreditScopes} 的取数目标：按格式分派的可辨识联合。 */
export type CreditTarget =
  | {
      format: 'new';
      /** NewSessionDir 绝对路径。 */
      sessionDir: string;
      /** 只读 fs 注入点，缺省用真实 `fs`。 */
      deps?: CreditFsDeps;
    }
  | {
      format: 'old';
      /** kiroagent 目录，见 {@link storeRootFromSessionDir}。 */
      storeRoot: string;
      sessionId: string;
      /** 当前工作区 fsPath，把存档扫描限定到对应的 workspaceId 目录（强烈建议传入）。 */
      workspacePath?: string;
      /** 该会话 history 引用的 executionId，供 checkpoint 祖先链追溯。 */
      historyExecutionIds?: readonly string[];
    };

/**
 * 按会话所属格式选择取数路径，一次返回两个 CreditScope 的数值（Req 4.3、4.5、4.9）。
 *
 * - **1.x（`format: 'new'`）**：走 {@link getCreditsFromMessages}，`self` 与 `lineage`
 *   取**同一值**。
 * - **0.9x（`format: 'old'`）**：走既有存档查表 {@link getCreditsForSessions}，
 *   保留既有双口径语义——`self` 用 `includeLineage: false` 只算自身 `chatSessionId`，
 *   `lineage` 顺 `historyExecutionIds` 并入 checkpoint 祖先会话。
 *
 * ### 为什么 1.x 两个口径同值
 *
 * 0.9x 需要 lineage 追溯，是因为用量记在**独立的执行存档**里：spec 的 checkpoint 会话
 * 从父会话继承整段对话，被继承那部分的消耗挂在祖先会话的 `chatSessionId` 下，光看自身
 * 会严重低估，所以必须顺 history 的 executionId 反查祖先。
 *
 * 1.x 的 `usage_summary` 事件**直接落在会话自己的 `messages.jsonl` 里**，会话目录物理隔离，
 * 不存在"消耗记在别的会话名下"这回事——追溯没有对象，`lineage` 也就没有额外可加的量。
 * 因此两个口径同值（design D4）。UI 的 `Σ` 开关照旧保留（0.9x 会话仍需要它），只是对 1.x
 * 会话不改变数值，并由 tooltip 说明原因（Req 4.4），否则用户会以为开关坏了。
 *
 * 两种格式下 credit 的语义因此一致：都是「该会话消耗的 credit」，上层无需按来源分支。
 */
export function getSessionCreditScopes(target: CreditTarget): ScopedCredits {
  if (target.format === 'new') {
    const { credits } = getCreditsFromMessages(target.sessionDir, target.deps);
    // self 与 lineage 取同一值：用量记在会话自身消息流中，无跨会话归属可追溯
    return { self: credits, lineage: credits, found: credits !== null, format: 'new' };
  }

  const self = getCreditsForSessions(target.storeRoot, [target.sessionId], {
    workspacePath: target.workspacePath,
    includeLineage: false,
  });
  const lineage = getCreditsForSessions(target.storeRoot, [target.sessionId], {
    workspacePath: target.workspacePath,
    historyExecutionIds: target.historyExecutionIds,
  });
  return {
    // found 为假即「查不到带用量的执行」，映射为 null 而不是 0，与 1.x 的不可用同义
    self: self.found ? self.credits : null,
    lineage: lineage.found ? lineage.credits : null,
    found: self.found || lineage.found,
    format: 'old',
  };
}
