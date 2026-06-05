import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  searchSessionsInDir,
  listRecentSessions,
  __clearIndexCacheForTest,
} from '../src/search';
import { mkTempDir, rmTempDir, writeSession, writeRaw } from './_helpers';

const tmpDirs: string[] = [];
afterEach(() => {
  __clearIndexCacheForTest();
  while (tmpDirs.length) rmTempDir(tmpDirs.pop()!);
});

function freshDir(): string {
  const d = mkTempDir();
  tmpDirs.push(d);
  return d;
}

describe('searchSessionsInDir - 命中场景', () => {
  it('标题命中：matchField=title 且 snippet=标题', () => {
    const dir = freshDir();
    writeSession(dir, 'a', { title: 'Refactor the parser', history: [] });
    const hits = searchSessionsInDir(dir, 'parser');
    expect(hits).toHaveLength(1);
    expect(hits[0].matchField).toBe('title');
    expect(hits[0].snippet).toBe('Refactor the parser');
  });

  it('不区分大小写', () => {
    const dir = freshDir();
    writeSession(dir, 'a', { title: 'Hello WORLD' });
    expect(searchSessionsInDir(dir, 'world')).toHaveLength(1);
  });

  it('消息命中：history[].message.content 为字符串', () => {
    const dir = freshDir();
    writeSession(dir, 'a', {
      title: 'untouched',
      history: [{ message: { content: 'please fix the websocket bug here' } }],
    });
    const hits = searchSessionsInDir(dir, 'websocket');
    expect(hits).toHaveLength(1);
    expect(hits[0].matchField).toBe('message');
    expect(hits[0].snippet.toLowerCase()).toContain('websocket');
  });

  it('消息命中：history[].message.content[].text 数组结构', () => {
    const dir = freshDir();
    writeSession(dir, 'a', {
      title: 'x',
      history: [{ message: { content: [{ text: 'a token named foobar appears' }] } }],
    });
    const hits = searchSessionsInDir(dir, 'foobar');
    expect(hits[0].matchField).toBe('message');
    expect(hits[0].snippet).toContain('foobar');
  });

  it('消息命中：messages[].content 结构', () => {
    const dir = freshDir();
    writeSession(dir, 'a', {
      title: 'x',
      messages: [{ content: 'the quick brown fox' }],
    });
    expect(searchSessionsInDir(dir, 'brown')).toHaveLength(1);
  });

  it('消息命中：messages[].text 结构', () => {
    const dir = freshDir();
    writeSession(dir, 'a', { title: 'x', messages: [{ text: 'lonely text field' }] });
    expect(searchSessionsInDir(dir, 'lonely')).toHaveLength(1);
  });
});

describe('searchSessionsInDir - 兜底与容错', () => {
  it('缺少 title/name 时 title 兜底为 Untitled', () => {
    const dir = freshDir();
    writeSession(dir, 'a', { history: [{ message: { content: 'match keyword zzz' } }] });
    const hits = searchSessionsInDir(dir, 'zzz');
    expect(hits[0].title).toBe('Untitled');
  });

  it('空白关键词返回空数组', () => {
    const dir = freshDir();
    writeSession(dir, 'a', { title: 'anything' });
    expect(searchSessionsInDir(dir, '   ')).toEqual([]);
  });

  it('JSON 损坏文件被跳过，其余命中正常返回', () => {
    const dir = freshDir();
    writeRaw(dir, 'broken.json', '{ this is not valid json ');
    writeSession(dir, 'good', { title: 'valid match target' });
    const hits = searchSessionsInDir(dir, 'target');
    expect(hits).toHaveLength(1);
    expect(hits[0].sessionId).toBe('good');
  });

  it('目录不存在时返回空数组且不抛异常', () => {
    expect(searchSessionsInDir('/no/such/dir/here', 'x')).toEqual([]);
  });

  it('name 字段可作为标题来源', () => {
    const dir = freshDir();
    writeSession(dir, 'a', { name: 'named session alpha' });
    const hits = searchSessionsInDir(dir, 'alpha');
    expect(hits[0].title).toBe('named session alpha');
    expect(hits[0].matchField).toBe('title');
  });
});

describe('searchSessionsInDir - 排序与 limit', () => {
  it('按 mtime 倒序并截断到 limit', () => {
    const dir = freshDir();
    const base = Date.now();
    for (let i = 0; i < 15; i++) {
      writeSession(dir, `s${i}`, { title: `match item ${i}` }, base + i * 1000);
    }
    const hits = searchSessionsInDir(dir, 'match', 10);
    expect(hits).toHaveLength(10);
    for (let i = 0; i < hits.length - 1; i++) {
      expect(hits[i].modified).toBeGreaterThanOrEqual(hits[i + 1].modified);
    }
    // 最新的应排在最前
    expect(hits[0].title).toBe('match item 14');
  });
});


describe('listRecentSessions', () => {
  it('按 mtime 倒序、限制到 limit 条、matchField=recent', () => {
    const dir = freshDir();
    const now = Date.now();
    // 写入 5 条会话，mtime 递增
    for (let i = 0; i < 5; i++) {
      writeSession(
        dir,
        `s${i}`,
        {
          title: `t${i}`,
          history: [
            { message: { role: 'user', content: [{ type: 'text', text: `hello-${i}` }] } },
          ],
        },
        now + i * 1000
      );
    }
    const recent = listRecentSessions(dir, 3);
    expect(recent).toHaveLength(3);
    expect(recent.map((r) => r.title)).toEqual(['t4', 't3', 't2']);
    for (const r of recent) {
      expect(r.matchField).toBe('recent');
      expect(r.snippet.startsWith('hello-')).toBe(true);
    }
  });

  it('snippet 取自首条用户消息（跳过 assistant），缺少时为空串', () => {
    const dir = freshDir();
    writeSession(dir, 'with-user', {
      title: '有用户消息',
      history: [
        { message: { role: 'assistant', content: '助手消息' } },
        { message: { role: 'user', content: '你好世界' } },
      ],
    });
    writeSession(dir, 'no-user', {
      title: '只有助手',
      history: [{ message: { role: 'assistant', content: '只我一个' } }],
    });
    const recent = listRecentSessions(dir, 10);
    const a = recent.find((r) => r.title === '有用户消息');
    const b = recent.find((r) => r.title === '只有助手');
    expect(a?.snippet).toBe('你好世界');
    expect(b?.snippet).toBe('');
  });

  it('损坏 JSON 与 stat 失败的文件被静默跳过，不影响其余结果', () => {
    const dir = freshDir();
    writeSession(dir, 'good', { title: '正常', history: [] });
    writeRaw(dir, 'bad.json', '{not-json');
    const recent = listRecentSessions(dir, 10);
    expect(recent.map((r) => r.title)).toEqual(['正常']);
  });

  it('读不到目录时返回空数组', () => {
    const recent = listRecentSessions('/no/such/dir/exists/here', 10);
    expect(recent).toEqual([]);
  });

  it('缺少 title 与 name 时回退到 Untitled', () => {
    const dir = freshDir();
    writeSession(dir, 'anon', { history: [{ message: { role: 'user', content: 'hi' } }] });
    const recent = listRecentSessions(dir, 10);
    expect(recent[0].title).toBe('Untitled');
    expect(recent[0].snippet).toBe('hi');
  });
});


describe('SearchEngine - 图片/附件标记', () => {
  it('含 imageUrl 的会话 hasImage=true，纯文本会话 hasImage=false', () => {
    const dir = freshDir();
    writeSession(dir, 'img', {
      title: 'with image keyword foo',
      history: [
        {
          message: {
            role: 'user',
            content: [
              { type: 'text', text: 'foo here' },
              { type: 'imageUrl', imageUrl: { url: 'data:image/jpeg;base64,/9j/4AAQSkZ...' } },
            ],
          },
        },
      ],
    });
    writeSession(dir, 'plain', {
      title: 'plain foo only',
      history: [{ message: { role: 'user', content: 'just foo text' } }],
    });
    const hits = searchSessionsInDir(dir, 'foo');
    const img = hits.find((h) => h.sessionId === 'img');
    const plain = hits.find((h) => h.sessionId === 'plain');
    expect(img?.hasImage).toBe(true);
    expect(plain?.hasImage).toBe(false);
  });

  it('type 含 image（大小写无关）也算图片', () => {
    const dir = freshDir();
    writeSession(dir, 'a', {
      title: 'has Image foo',
      history: [{ message: { role: 'user', content: [{ type: 'IMAGE', text: 'foo' }] } }],
    });
    const hits = searchSessionsInDir(dir, 'foo');
    expect(hits[0].hasImage).toBe(true);
  });

  it('非空 contextItems → hasAttachment=true；空数组/缺失 → false', () => {
    const dir = freshDir();
    writeSession(dir, 'attached', {
      title: 'attached foo',
      history: [
        {
          message: { role: 'user', content: 'foo' },
          contextItems: [{ id: '1', name: 'x.cs', uri: 'file:///x.cs', content: '...', description: 'd' }],
        },
      ],
    });
    writeSession(dir, 'empty-ctx', {
      title: 'empty foo',
      history: [{ message: { role: 'user', content: 'foo' }, contextItems: [] }],
    });
    writeSession(dir, 'no-ctx', {
      title: 'none foo',
      history: [{ message: { role: 'user', content: 'foo' } }],
    });
    const hits = searchSessionsInDir(dir, 'foo');
    expect(hits.find((h) => h.sessionId === 'attached')?.hasAttachment).toBe(true);
    expect(hits.find((h) => h.sessionId === 'empty-ctx')?.hasAttachment).toBe(false);
    expect(hits.find((h) => h.sessionId === 'no-ctx')?.hasAttachment).toBe(false);
  });

  it('base64 图片数据不进入匹配文本（搜 base64 片段搜不到）', () => {
    const dir = freshDir();
    writeSession(dir, 'img', {
      title: 'title only',
      history: [
        {
          message: {
            role: 'user',
            content: [
              { type: 'text', text: 'normal words' },
              { type: 'imageUrl', imageUrl: { url: 'data:image/jpeg;base64,ZZUNIQUEZZ12345' } },
            ],
          },
        },
      ],
    });
    // base64 里的独特串不应被命中（图片项被排除在匹配文本之外）
    expect(searchSessionsInDir(dir, 'ZZUNIQUEZZ')).toHaveLength(0);
    // 普通文本仍可命中
    expect(searchSessionsInDir(dir, 'normal words')).toHaveLength(1);
  });

  it('listRecentSessions 同样带 hasImage / hasAttachment', () => {
    const dir = freshDir();
    writeSession(dir, 'r', {
      title: '最近含图',
      history: [{ message: { role: 'user', content: [{ type: 'imageUrl', imageUrl: { url: 'data:image/png;base64,AAA' } }] } }],
    });
    const recent = listRecentSessions(dir, 10);
    expect(recent[0].hasImage).toBe(true);
    expect(recent[0].hasAttachment).toBe(false);
  });
});

describe('SearchEngine - 索引缓存', () => {
  it('连续两次调用结果一致（第二次走缓存）', () => {
    const dir = freshDir();
    const base = Date.now();
    writeSession(dir, 'a', { title: 'cache foo a' }, base);
    writeSession(dir, 'b', { title: 'cache foo b' }, base + 1000);
    const first = searchSessionsInDir(dir, 'foo');
    const second = searchSessionsInDir(dir, 'foo');
    expect(second).toEqual(first);
  });

  it('改文件并抬高 mtime 后结果反映新内容', () => {
    const dir = freshDir();
    const base = Date.now();
    writeSession(dir, 's', { title: 'old keyword alpha' }, base);
    expect(searchSessionsInDir(dir, 'alpha')).toHaveLength(1);
    expect(searchSessionsInDir(dir, 'beta')).toHaveLength(0);

    // 覆写为新内容，mtime 抬高
    writeSession(dir, 's', { title: 'new keyword beta' }, base + 5000);
    expect(searchSessionsInDir(dir, 'beta')).toHaveLength(1);
    expect(searchSessionsInDir(dir, 'alpha')).toHaveLength(0);
  });

  it('删除文件后不再返回该会话', () => {
    const dir = freshDir();
    const base = Date.now();
    writeSession(dir, 'keep', { title: 'foo keep' }, base);
    writeSession(dir, 'gone', { title: 'foo gone' }, base + 1000);
    expect(searchSessionsInDir(dir, 'foo')).toHaveLength(2);

    // 删除其中一个
    fs.unlinkSync(path.join(dir, 'gone.json'));
    const after = searchSessionsInDir(dir, 'foo');
    expect(after).toHaveLength(1);
    expect(after[0].sessionId).toBe('keep');
  });
});
