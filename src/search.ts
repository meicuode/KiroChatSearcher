import * as fs from 'fs';
import * as path from 'path';

export interface SearchHit {
  sessionId: string;
  title: string;
  modified: number;
  snippet: string;
  /** 命中字段；'recent' 表示无关键词的"最近列表"项，snippet 为首条消息预览 */
  matchField: 'title' | 'message' | 'recent';
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
  const out: SearchHit[] = [];

  let files: string[];
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }

  for (const f of files) {
    const full = path.join(dir, f);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    let obj: any;
    try {
      obj = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch {
      continue;
    }

    const title: string = obj.title || obj.name || '';
    let snippet = '';
    let matchField: SearchHit['matchField'] | null = null;

    if (re.test(title)) {
      matchField = 'title';
      snippet = title;
    }

    if (!matchField) {
      const found = findMessageSnippet(obj, re);
      if (found) {
        matchField = 'message';
        snippet = found;
      }
    }

    if (matchField) {
      out.push({
        sessionId: path.basename(f, '.json'),
        title: title || 'Untitled',
        modified: stat.mtimeMs,
        snippet,
        matchField,
      });
    }
  }

  out.sort((a, b) => b.modified - a.modified);
  return out.slice(0, limit);
}

/**
 * 遍历会话历史的不同结构形态，返回首个命中的文本片段。
 * 兼容：
 *   obj.history[i].message.content[j].text
 *   obj.history[i].message.content (string)
 *   obj.messages[i].content / .text
 */
function findMessageSnippet(obj: any, re: RegExp): string | null {
  const candidates: any[] = [];
  if (Array.isArray(obj.history)) candidates.push(...obj.history);
  if (Array.isArray(obj.messages)) candidates.push(...obj.messages);

  for (const item of candidates) {
    const msg = item?.message ?? item;
    const content = msg?.content;
    if (typeof content === 'string') {
      const m = re.exec(content);
      if (m) return makeSnippet(content, m.index);
    } else if (Array.isArray(content)) {
      for (const c of content) {
        const text = typeof c === 'string' ? c : c?.text;
        if (typeof text === 'string') {
          const m = re.exec(text);
          if (m) return makeSnippet(text, m.index);
        }
      }
    } else if (typeof msg?.text === 'string') {
      const m = re.exec(msg.text);
      if (m) return makeSnippet(msg.text, m.index);
    }
  }
  return null;
}

export function makeSnippet(text: string, idx: number, span = 80): string {
  const start = Math.max(0, idx - span);
  const end = Math.min(text.length, idx + span);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return (prefix + text.slice(start, end) + suffix).replace(/\s+/g, ' ').trim();
}

/**
 * 提取会话首条**用户**消息的纯文本，用作"最近"列表里的预览片段。
 * 兼容与 findMessageSnippet 相同的多种历史结构。
 */
function extractFirstUserText(obj: any): string {
  const candidates: any[] = [];
  if (Array.isArray(obj.history)) candidates.push(...obj.history);
  if (Array.isArray(obj.messages)) candidates.push(...obj.messages);

  for (const item of candidates) {
    const msg = item?.message ?? item;
    if (msg?.role && msg.role !== 'user') continue;
    const content = msg?.content;
    if (typeof content === 'string') {
      const t = content.trim();
      if (t) return t;
    } else if (Array.isArray(content)) {
      for (const c of content) {
        const text = typeof c === 'string' ? c : c?.text;
        if (typeof text === 'string' && text.trim()) return text.trim();
      }
    } else if (typeof msg?.text === 'string') {
      const t = msg.text.trim();
      if (t) return t;
    }
  }
  return '';
}

/**
 * 列出指定会话目录下**最近 limit 条**会话（按 mtime 倒序）。
 * 用于无搜索关键词时的默认展示，snippet 取自会话首条用户消息预览。
 * 任何文件级异常都被静默跳过，与 searchSessionsInDir 一致。
 */
export function listRecentSessions(dir: string, limit = 20): SearchHit[] {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }

  // 第一阶段：仅 stat，按 mtime 倒序选出 top-N，避免对全部文件 readFileSync
  const stats: { file: string; mtime: number }[] = [];
  for (const f of files) {
    try {
      const st = fs.statSync(path.join(dir, f));
      stats.push({ file: f, mtime: st.mtimeMs });
    } catch {
      // 跳过无法 stat 的文件
    }
  }
  stats.sort((a, b) => b.mtime - a.mtime);
  const top = stats.slice(0, limit);

  // 第二阶段：仅对 top-N 解析 JSON 提取标题与首条预览
  const out: SearchHit[] = [];
  for (const { file, mtime } of top) {
    let obj: any;
    try {
      obj = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch {
      continue;
    }
    const title: string = obj.title || obj.name || '';
    const preview = extractFirstUserText(obj);
    const snippet = preview
      ? preview.slice(0, 160).replace(/\s+/g, ' ').trim()
      : '';
    out.push({
      sessionId: path.basename(file, '.json'),
      title: title || 'Untitled',
      modified: mtime,
      snippet,
      matchField: 'recent',
    });
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
