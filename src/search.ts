import * as fs from 'fs';
import * as path from 'path';

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
  title: string;
  /** 用于关键词匹配的纯文本（已剔除 base64 图片数据） */
  text: string;
  /** 最近列表的预览来源（首条用户消息） */
  firstUserText: string;
  hasImage: boolean;
  hasAttachment: boolean;
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
} {
  const items: any[] = [];
  if (Array.isArray(obj?.history)) items.push(...obj.history);
  if (Array.isArray(obj?.messages)) items.push(...obj.messages);

  const textParts: string[] = [];
  let firstUserText = '';
  let hasImage = false;
  let hasAttachment = false;

  for (const item of items) {
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
  };
}

/** 判断 content 数组项是否为图片（不读取 base64 内容） */
function isImagePart(c: any): boolean {
  if (!c || typeof c !== 'object') return false;
  const t = typeof c.type === 'string' ? c.type.toLowerCase() : '';
  return t.includes('image') || c.imageUrl != null || c.image != null;
}

/**
 * 加载目录的会话索引，按 mtime 失效复用缓存。
 * - 命中且 mtime 未变 → 复用缓存条目，不 read/parse。
 * - 未命中或 mtime 变化 → 解析并写回缓存。
 * - 清理缓存中已在目录消失的条目。
 * 返回值的顺序与 files 一致；解析失败的文件被跳过。
 */
function loadIndex(dir: string): SessionIndexEntry[] {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }

  const seenPaths = new Set<string>();
  const out: SessionIndexEntry[] = [];

  for (const f of files) {
    const full = path.join(dir, f);
    seenPaths.add(full);

    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }

    const cached = indexCache.get(full);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      out.push(cached);
      continue;
    }

    let obj: any;
    try {
      obj = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch {
      // 解析失败：跳过且不写入缓存；若之前有旧条目则移除
      indexCache.delete(full);
      continue;
    }

    const parsed = parseSessionContent(obj);
    const entry: SessionIndexEntry = {
      sessionId: path.basename(f, '.json'),
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      title: obj?.title || obj?.name || '',
      text: parsed.text,
      firstUserText: parsed.firstUserText,
      hasImage: parsed.hasImage,
      hasAttachment: parsed.hasAttachment,
    };
    indexCache.set(full, entry);
    out.push(entry);
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
      });
    }
  }

  out.sort((a, b) => b.modified - a.modified);
  return out.slice(0, limit);
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
    });
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
