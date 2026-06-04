import { describe, it, expect, afterEach } from 'vitest';
import { searchSessionsInDir } from '../src/search';
import { mkTempDir, rmTempDir, writeSession, writeRaw } from './_helpers';

const tmpDirs: string[] = [];
afterEach(() => {
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
