import * as fs from 'fs';
import * as path from 'path';
import { getCreditsForSessions, storeRootFromSessionDir } from './credits';

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
   * 该会话**自身**的真实 credit 消耗（只统计 chatSessionId==本会话的执行，不含 checkpoint 继承）。
   * 查不到带用量的执行时为 undefined。默认展示口径（方案 C）。
   */
  credits?: number;
  /**
   * 整段对话的累计 credit（含 checkpoint 祖先链）。可选展示口径（方案 A）。
   * 查不到时为 undefined。
   */
  creditsLineage?: number;
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
  /** 会话顶层的上下文占用百分比（Kiro 本地估算），无则 undefined */
  contextPercentage?: number;
  /** 会话顶层的工作区 fsPath，用于把 credit 扫描限定到对应存储目录 */
  workspacePath?: string;
  /** 会话 history 引用的 executionId（用于 checkpoint lineage 追溯祖先会话） */
  executionIds: string[];
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
    // 收集 executionId（用于 checkpoint lineage：这些执行常属于祖先会话）
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
  contextPercentage?: number;
  workspacePath?: string;
  executionIds: string[];
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
      const wsPath =
        typeof obj?.workspacePath === 'string'
          ? obj.workspacePath
          : typeof obj?.workspaceDirectory === 'string'
          ? obj.workspaceDirectory
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
        contextPercentage: ctxPct,
        workspacePath: wsPath,
        executionIds: parsed.executionIds,
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
      contextPercentage: entry.contextPercentage,
      workspacePath: entry.workspacePath,
      executionIds: entry.executionIds,
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
  attachCredits(dir, limited, workspacePathOf(entries), execIdsOf(entries));
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
  for (const e of entries.slice(0, limit)) {
    const snippet = e.firstUserText
      ? e.firstUserText.slice(0, 160).replace(/\s+/g, ' ').trim()
      : '';
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
  attachCredits(dir, out, workspacePathOf(entries), execIdsOf(entries));
  return out;
}

/** 取一组会话里的工作区 fsPath（同一目录下的会话共享同一工作区）。 */
function workspacePathOf(entries: ResolvedSession[]): string | undefined {
  for (const e of entries) {
    if (e.workspacePath) return e.workspacePath;
  }
  return undefined;
}

/** 建立 sessionId → 其 history executionId 列表 的映射（供 lineage 追溯）。 */
function execIdsOf(entries: ResolvedSession[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const e of entries) m.set(e.sessionId, e.executionIds);
  return m;
}

/**
 * 为最终返回的结果集补充 credit 用量（只对有限的结果集做汇总，避免无谓开销）。
 * credit 按执行存档的 chatSessionId 与会话 sessionId 匹配汇总，并顺 history executionId
 * 追溯 checkpoint 祖先会话一并合计（见 credits.ts 说明）；查不到带用量的执行则保持
 * undefined，由上层回退展示 contextPercentage。异常一律吞掉，不影响搜索结果本身。
 */
function attachCredits(
  dir: string,
  hits: SearchHit[],
  workspacePath: string | undefined,
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
    try {
      const ids = execIdsById.get(hit.sessionId);
      // C：会话自身消耗（不含 checkpoint 继承）
      const self = getCreditsForSessions(storeRoot, [hit.sessionId], {
        workspacePath,
        includeLineage: false,
      });
      if (self.found) hit.credits = self.credits;
      // A：整段对话累计（含 checkpoint 祖先链）
      const lineage = getCreditsForSessions(storeRoot, [hit.sessionId], {
        workspacePath,
        historyExecutionIds: ids,
      });
      if (lineage.found) hit.creditsLineage = lineage.credits;
    } catch {
      // 汇总失败不影响结果展示
    }
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
