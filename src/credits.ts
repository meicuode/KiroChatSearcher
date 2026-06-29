import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

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

/** 测试辅助：清空所有进程内缓存。 */
export function __clearCreditCacheForTest(): void {
  archiveCache.clear();
  scanState = null;
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

/** 把 usageSummary 数组文本里 unit==='credit' 的 usage 求和。 */
export function sumCreditsFromUsageSummary(arrayText: string): number {
  let arr: unknown;
  try {
    arr = JSON.parse(arrayText);
  } catch {
    return 0;
  }
  if (!Array.isArray(arr)) return 0;
  let sum = 0;
  for (const it of arr as any[]) {
    if (
      it &&
      typeof it.usage === 'number' &&
      isFinite(it.usage) &&
      typeof it.unit === 'string' &&
      it.unit.toLowerCase() === 'credit'
    ) {
      sum += it.usage;
    }
  }
  return sum;
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

  let scopeDirs: string[] = [];
  if (opts.workspacePath) {
    scopeDirs = workspaceIdCandidates(opts.workspacePath)
      .map((id) => path.join(storeRoot, id))
      .filter((d) => {
        try {
          return fs.statSync(d).isDirectory();
        } catch {
          return false;
        }
      });
  }

  refreshIndex(storeRoot, scopeDirs);

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
