import * as fs from 'fs';
import * as path from 'path';

export interface SearchHit {
  sessionId: string;
  title: string;
  modified: number;
  snippet: string;
  matchField: 'title' | 'message';
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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
