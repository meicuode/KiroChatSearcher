import * as fs from 'fs';
import * as path from 'path';
import { getCreditsForExecutions, storeRootFromSessionDir } from './credits';

export interface SearchHit {
  sessionId: string;
  title: string;
  modified: number;
  snippet: string;
  /** 命中字段；'recent' 表示无关键词的"最近列表"项，snippet 为首条消息预览 */
  matchField: 'title' | 'message' | 'recent';
  /** 会话是否含内嵌图片（content[].type~image 或 imageUrl/image 字段） */
  hasImage: boolean;
  /** 会话是否含非空 contextItems 附件 */
  hasAttachment: boolean;
  /**
   * 该会话的真实 credit 消耗（来自 Kiro 执行存档的 usageSummary 汇总）。
   * 查不到执行存档（已被 LRU 淘汰 / 旧版本）时为 undefined。
   */
  credits?: number;
  /**
   * 会话上下文窗口占用百分比（Kiro 本地估算，写在会话 JSON 顶层）。
   * 作为 credit 不可用时的回退展示。
   */
  contextPercentage?: number;
}

/**
 * 进程内会话索引缓存条目。仅保留匹配/展示所需的精简数据，
 * 不保留原始 JSON，避免把 base64 图片等大体积内容常驻内存。
 */
interface SessionIndexEntry {
  sessionId: string;
  mtimeMs: number;
  /** 文件字节大小，与 mtimeMs 共同作为失效判据 */
  size: number;
  /** 单个会话文件里的原始标题（往往是泛化的 "Agent"），作为清单缺失时的回退 */
  rawTitle: string;
  /** 用于关键词匹配的纯文本（已剔除 base64 图片数据） */
  text: string;
  /** 最近列表的预览来源（首条用户消息） */
  firstUserText: string;
  hasImage: boolean;
  hasAttachment: boolean;
  /** 该会话引用的所有 executionId（用于反查执行存档里的 credit 用量） */
  executionIds: string[];
  /** 会话顶层的上下文占用百分比（Kiro 本地估算），无则 undefined */
  contextPercentage?: number;
}

/**
 * 会话索引缓存：键为 SessionFile 绝对路径，值为解析后的精简条目。
 * 进程内内存缓存，不持久化；扩展停用随进程释放。
 */
const indexCache = new Map<string, SessionIndexEntry>();

/** 测试辅助：清空缓存（不影响生产逻辑） */
export function __clearIndexCacheForTest(): void {
  indexCache.clear();
}

/**
 * 把一个会话对象解析为精简索引条目所需的字段。
 * 一次遍历同时算出：可匹配纯文本、首条用户消息预览、hasImage、hasAttachment。
 * - 文本构建跳过内嵌 base64 图片（imageUrl/image/data: URL）。
 * - 图片检测见到标志即短路，不读取 base64 内容。
 */
function parseSessionContent(obj: any): {
  text: string;
  firstUserText: string;
  hasImage: boolean;
  hasAttachment: boolean;
  executionIds: string[];
} {
  const items: any[] = [];
  if (Array.isArray(obj?.history)) items.push(...obj.history);
  if (Array.isArray(obj?.messages)) items.push(...obj.messages);

  const textParts: string[] = [];
  let firstUserText = '';
  let hasImage = false;
  let hasAttachment = false;
  const executionIds: string[] = [];
  const seenExec = new Set<string>();

  for (const item of items) {
    // 收集 executionId（落在 history 条目层级，常见于 assistant 轮次）
    const eid = item?.executionId;
    if (typeof eid === 'string' && eid && !seenExec.has(eid)) {
      seenExec.add(eid);
      executionIds.push(eid);
    }

    // 附件：任一消息项的 contextItems 为非空数组
    if (!hasAttachment && Array.isArray(item?.contextItems) && item.contextItems.length > 0) {
      hasAttachment = true;
    }

    const msg = item?.message ?? item;
    const role = msg?.role;
    const content = msg?.content;

    if (typeof content === 'string') {
      if (content) textParts.push(content);
      if (!firstUserText && (!role || role === 'user') && content.trim()) {
        firstUserText = content.trim();
      }
    } else if (Array.isArray(content)) {
      for (const c of content) {
        // 图片检测：标志命中即短路，不碰 base64 内容
        if (!hasImage && isImagePart(c)) {
          hasImage = true;
          continue; // 不把图片项纳入文本
        }
        const text = typeof c === 'string' ? c : c?.text;
        if (typeof text === 'string' && text) {
          textParts.push(text);
          if (!firstUserText && (!role || role === 'user') && text.trim()) {
            firstUserText = text.trim();
          }
        }
      }
    } else if (typeof msg?.text === 'string') {
      if (msg.text) textParts.push(msg.text);
      if (!firstUserText && (!role || role === 'user') && msg.text.trim()) {
        firstUserText = msg.text.trim();
      }
    }
  }

  return {
    text: textParts.join('\n'),
    firstUserText,
    hasImage,
    hasAttachment,
    executionIds,
  };
}

/** 判断 content 数组项是否为图片（不读取 base64 内容） */
function isImagePart(c: any): boolean {
  if (!c || typeof c !== 'object') return false;
  const t = typeof c.type === 'string' ? c.type.toLowerCase() : '';
  return t.includes('image') || c.imageUrl != null || c.image != null;
}

/**
 * Kiro 在会话目录下维护一个 `sessions.json` 清单文件，顶层是数组，
 * 每项形如 { sessionId, title, dateCreated, workspaceDirectory }。
 * 它是会话**标题的权威来源**（单个会话文件里的 title 往往只是泛化的 "Agent"）。
 * 该文件本身不是会话记录，必须从会话列表中排除。
 */
const MANIFEST_FILENAME = 'sessions.json';

/** 读取 sessions.json 清单，返回 sessionId → 官方标题 的映射；失败则返回空 Map。 */
function loadTitleMap(dir: string): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const raw = fs.readFileSync(path.join(dir, MANIFEST_FILENAME), 'utf8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      for (const it of arr) {
        const id = it?.sessionId;
        const title = it?.title;
        if (typeof id === 'string' && typeof title === 'string' && title.trim()) {
          map.set(id, title);
        }
      }
    }
  } catch {
    // 清单不存在或损坏：回退到单文件标题
  }
  return map;
}

/** loadIndex 的产出：在缓存条目基础上解析出"最终展示标题"（清单优先）。 */
interface ResolvedSession {
  sessionId: string;
  mtimeMs: number;
  title: string;
  text: string;
  firstUserText: string;
  hasImage: boolean;
  hasAttachment: boolean;
  executionIds: string[];
  contextPercentage?: number;
}

/**
 * 加载目录的会话索引，按 (mtime, size) 失效复用缓存。
 * - 命中且 mtime/size 未变 → 复用缓存条目，不 read/parse。
 * - 未命中或变化 → 解析并写回缓存。
 * - 清理缓存中已在目录消失的条目。
 * - 跳过 sessions.json 清单文件；并用清单中的官方标题覆盖单文件标题。
 * 返回值的顺序与 files 一致；解析失败的文件被跳过。
 */
function loadIndex(dir: string): ResolvedSession[] {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }

  const titleMap = loadTitleMap(dir);
  const seenPaths = new Set<string>();
  const out: ResolvedSession[] = [];

  for (const f of files) {
    // 跳过会话清单文件——它不是会话记录（顶层是数组），点击会导致跳转报错
    if (f === MANIFEST_FILENAME) continue;

    const full = path.join(dir, f);
    seenPaths.add(full);

    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }

    let entry = indexCache.get(full);
    if (!entry || entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) {
      let obj: any;
      try {
        obj = JSON.parse(fs.readFileSync(full, 'utf8'));
      } catch {
        // 解析失败：跳过且不写入缓存；若之前有旧条目则移除
        indexCache.delete(full);
        continue;
      }
      const parsed = parseSessionContent(obj);
      const ctxPct =
        typeof obj?.contextUsagePercentage === 'number'
          ? obj.contextUsagePercentage
          : undefined;
      entry = {
        sessionId: path.basename(f, '.json'),
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        rawTitle: obj?.title || obj?.name || '',
        text: parsed.text,
        firstUserText: parsed.firstUserText,
        hasImage: parsed.hasImage,
        hasAttachment: parsed.hasAttachment,
        executionIds: parsed.executionIds,
        contextPercentage: ctxPct,
      };
      indexCache.set(full, entry);
    }

    // 最终标题：清单官方标题优先，其次单文件标题，最后 Untitled
    const title = titleMap.get(entry.sessionId) || entry.rawTitle || 'Untitled';
    out.push({
      sessionId: entry.sessionId,
      mtimeMs: entry.mtimeMs,
      title,
      text: entry.text,
      firstUserText: entry.firstUserText,
      hasImage: entry.hasImage,
      hasAttachment: entry.hasAttachment,
      executionIds: entry.executionIds,
      contextPercentage: entry.contextPercentage,
    });
  }

  // 清理：缓存中存在但目录下已消失的条目（仅清理本目录下的键）
  const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
  for (const key of indexCache.keys()) {
    if (key.startsWith(prefix) && !seenPaths.has(key)) {
      indexCache.delete(key);
    }
  }

  return out;
}

/**
 * 在指定的会话目录中按关键词全文搜索。
 * 返回结果按修改时间倒序，并截断到 limit 条。
 */
export function searchSessionsInDir(
  dir: string,
  keyword: string,
  limit = 10
): SearchHit[] {
  if (!keyword.trim()) return [];
  const re = new RegExp(escapeRegExp(keyword), 'i');

  const entries = loadIndex(dir);
  const out: SearchHit[] = [];
  const execIdsById = new Map<string, string[]>();

  for (const e of entries) {
    let snippet = '';
    let matchField: 'title' | 'message' | null = null;

    if (re.test(e.title)) {
      matchField = 'title';
      snippet = e.title;
    } else {
      const m = re.exec(e.text);
      if (m) {
        matchField = 'message';
        snippet = makeSnippet(e.text, m.index);
      }
    }

    if (matchField) {
      execIdsById.set(e.sessionId, e.executionIds);
      out.push({
        sessionId: e.sessionId,
        title: e.title || 'Untitled',
        modified: e.mtimeMs,
        snippet,
        matchField,
        hasImage: e.hasImage,
        hasAttachment: e.hasAttachment,
        contextPercentage: e.contextPercentage,
      });
    }
  }

  out.sort((a, b) => b.modified - a.modified);
  const limited = out.slice(0, limit);
  attachCredits(dir, limited, execIdsById);
  return limited;
}

export function makeSnippet(text: string, idx: number, span = 80): string {
  const start = Math.max(0, idx - span);
  const end = Math.min(text.length, idx + span);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return (prefix + text.slice(start, end) + suffix).replace(/\s+/g, ' ').trim();
}

/**
 * 列出指定会话目录下**最近 limit 条**会话（按 mtime 倒序）。
 * 用于无搜索关键词时的默认展示，snippet 取自会话首条用户消息预览。
 * 任何文件级异常都被静默跳过，与 searchSessionsInDir 一致。
 */
export function listRecentSessions(dir: string, limit = 20): SearchHit[] {
  const entries = loadIndex(dir);
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const out: SearchHit[] = [];
  const execIdsById = new Map<string, string[]>();
  for (const e of entries.slice(0, limit)) {
    const snippet = e.firstUserText
      ? e.firstUserText.slice(0, 160).replace(/\s+/g, ' ').trim()
      : '';
    execIdsById.set(e.sessionId, e.executionIds);
    out.push({
      sessionId: e.sessionId,
      title: e.title || 'Untitled',
      modified: e.mtimeMs,
      snippet,
      matchField: 'recent',
      hasImage: e.hasImage,
      hasAttachment: e.hasAttachment,
      contextPercentage: e.contextPercentage,
    });
  }
  attachCredits(dir, out, execIdsById);
  return out;
}

/**
 * 为最终返回的结果集补充 credit 用量（只对有限的结果集做反查，避免全量扫描）。
 * credit 取自 Kiro 执行存档；查不到（已被 LRU 淘汰 / 旧版本）则保持 undefined，
 * 由上层回退展示 contextPercentage。任何异常都被吞掉，不影响搜索结果本身。
 */
function attachCredits(
  dir: string,
  hits: SearchHit[],
  execIdsById: Map<string, string[]>
): void {
  if (!hits.length) return;
  let storeRoot: string;
  try {
    storeRoot = storeRootFromSessionDir(dir);
  } catch {
    return;
  }
  for (const hit of hits) {
    const ids = execIdsById.get(hit.sessionId);
    if (!ids || ids.length === 0) continue;
    try {
      const { credits, found } = getCreditsForExecutions(storeRoot, ids);
      if (found) hit.credits = credits;
    } catch {
      // 反查失败不影响结果展示
    }
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
