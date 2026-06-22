import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * Kiro 把"每次执行（execution）"的用量摘要存在一份独立的磁盘缓存里，
 * 而不是写进会话历史 JSON。会话文件只保留对 executionId 的引用。
 *
 * 存储布局（逆向自 Kiro 扩展 `ExecutionLogController` + `WriteBackCache`）：
 *   <globalStorage>/kiro.kiroagent/<workspaceId>/[<hash(SAVES)>/]<hash(executionId)>
 * 其中：
 *   - 目录 / 文件名 = sha256(key) 的十六进制前 32 位（见 hash32）。
 *   - 每个执行存档是一份 JSON，含 usageSummary 数组：
 *       [{ "usage": 0.0097, "unit": "credit", "unitPlural": "credits" }, { "usedTools": [...] }, ...]
 *   - 该缓存是 LRU（上限约 500 条），较老的执行会被淘汰，因此并非所有
 *     历史会话都还能查到 credit。
 *
 * 本模块按 executionId 反查这些文件并汇总 credit 用量，只读不写。
 */

/** Kiro 执行存储里 folderKey="KIRO::EXECUTION::SAVES" 的固定哈希子目录名。 */
const SAVES_FOLDER_HASH = hash32('KIRO::EXECUTION::SAVES');

/** sha256(s) 的十六进制前 32 位——与 Kiro storage 的路径哈希算法一致。 */
export function hash32(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 32);
}

/** 单个执行存档文件的解析缓存条目（按 mtime+size 失效）。 */
interface FileCreditEntry {
  mtimeMs: number;
  size: number;
  credits: number;
}

/** executionId 文件解析缓存：键为文件绝对路径。 */
const fileCreditCache = new Map<string, FileCreditEntry>();

/** 执行存储目录的 文件名(hash) → 绝对路径 索引（一个 storeRoot 一份）。 */
interface StoreIndex {
  root: string;
  builtAt: number;
  map: Map<string, string>;
}
let storeIndex: StoreIndex | null = null;

/** 索引重建节流：避免每次查询都重扫目录。 */
const STORE_INDEX_TTL_MS = 4000;

/** 测试辅助：清空所有进程内缓存。 */
export function __clearCreditCacheForTest(): void {
  fileCreditCache.clear();
  storeIndex = null;
}

/**
 * 由会话目录推导执行存储根目录。
 * 会话目录形如 <kiroagent>/workspace-sessions/<key>，向上两级即 kiroagent 根。
 */
export function storeRootFromSessionDir(sessionDir: string): string {
  return path.resolve(sessionDir, '..', '..');
}

const HEX32 = /^[0-9a-f]{32}$/;

/**
 * 递归列出 storeRoot 下所有"32 位十六进制名"的文件（执行存档 / 元数据等）。
 * 深度受限以避开体量巨大的代码库索引子树；跳过 workspace-sessions。
 * 执行存档位于 <root>/<wsId>/<file>（深度 2）或 <root>/<wsId>/<hash(SAVES)>/<file>（深度 3）。
 */
function listHexFiles(root: string, maxDepth = 3): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth && e.name !== 'workspace-sessions') {
          walk(full, depth + 1);
        }
      } else if (HEX32.test(e.name) && !map.has(e.name)) {
        // hash(executionId) 全局唯一，跨 workspaceId 不会真正冲突；保留首个即可。
        map.set(e.name, full);
      }
    }
  };
  walk(root, 1);
  return map;
}

/** 取得（必要时重建）storeRoot 的文件名索引。 */
function getStoreIndex(root: string, forceRebuild = false): Map<string, string> {
  const now = Date.now();
  if (
    !forceRebuild &&
    storeIndex &&
    storeIndex.root === root &&
    now - storeIndex.builtAt < STORE_INDEX_TTL_MS
  ) {
    return storeIndex.map;
  }
  const map = listHexFiles(root);
  storeIndex = { root, builtAt: now, map };
  return map;
}

/** 在索引中定位某 executionId 对应的存档文件；未命中则强制重建一次再试。 */
function locateExecutionFile(root: string, executionId: string): string | null {
  const fileName = hash32(executionId);
  let map = getStoreIndex(root);
  let full = map.get(fileName);
  if (full && fs.existsSync(full)) return full;

  // 缓存未命中或文件已被移动：重建索引重试一次（覆盖新产生的执行）。
  map = getStoreIndex(root, true);
  full = map.get(fileName);
  if (full && fs.existsSync(full)) return full;

  // 兜底：直接按确定性子路径探测（部分版本固定使用 SAVES 子目录布局）。
  return null;
}

/**
 * 从执行存档原文中切出 "usageSummary": [...] 的数组文本。
 * 用括号配对（字符串感知）扫描，避免把整份多 MB 的 operations 一起 JSON.parse。
 */
export function extractUsageSummaryArray(raw: string): string | null {
  const ki = raw.indexOf('"usageSummary"');
  if (ki < 0) return null;
  const start = raw.indexOf('[', ki);
  if (start < 0) return null;

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

/** 解析单个执行存档文件的 credit 用量（带 mtime/size 缓存）。 */
function parseExecutionCredits(file: string): number {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return 0;
  }
  const cached = fileCreditCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.credits;
  }
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return 0;
  }
  const arrText = extractUsageSummaryArray(raw);
  const credits = arrText ? sumCreditsFromUsageSummary(arrText) : 0;
  fileCreditCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, credits });
  return credits;
}

/** 一个会话的 credit 汇总结果。 */
export interface SessionCredits {
  /** 命中的执行存档汇总出的总 credit。 */
  credits: number;
  /** 是否至少找到了一条执行存档（用于区分"0 credit"与"查不到数据"）。 */
  found: boolean;
}

/**
 * 汇总给定 executionId 列表对应的总 credit 用量。
 * @param storeRoot 执行存储根目录（kiroagent 目录），见 storeRootFromSessionDir。
 * @param executionIds 该会话引用的所有 executionId。
 */
export function getCreditsForExecutions(
  storeRoot: string,
  executionIds: readonly string[]
): SessionCredits {
  let credits = 0;
  let found = false;
  for (const eid of executionIds) {
    if (!eid) continue;
    const file = locateExecutionFile(storeRoot, eid);
    if (!file) continue;
    found = true;
    credits += parseExecutionCredits(file);
  }
  return { credits, found };
}

/** 暴露给诊断/测试：SAVES 子目录哈希名。 */
export const __SAVES_FOLDER_HASH = SAVES_FOLDER_HASH;
