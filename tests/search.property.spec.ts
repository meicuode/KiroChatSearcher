import { describe, it, expect, afterEach } from 'vitest';
import fc from 'fast-check';
import {
  searchSessionsInDir,
  makeSnippet,
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

// 仅包含字母数字与空格，避免正则元字符干扰子串语义
const wordArb = fc.stringMatching(/^[a-zA-Z0-9]{2,8}$/);

describe('SearchEngine properties', () => {
  // Feature: kiro-chat-search, Property 4: 关键词命中标题
  it('Property 4: 标题包含关键词时 matchField=title 且 snippet=标题', () => {
    fc.assert(
      fc.property(wordArb, fc.string(), fc.string(), (kw, pre, post) => {
        const dir = freshDir();
        const title = pre + kw + post;
        writeSession(dir, 'only', { title });
        const hits = searchSessionsInDir(dir, kw, 10);
        expect(hits).toHaveLength(1);
        expect(hits[0].matchField).toBe('title');
        expect(hits[0].snippet).toBe(title);
      }),
      { numRuns: 60 }
    );
  });

  // Feature: kiro-chat-search, Property 5: 消息 snippet 截取不变量
  it('Property 5: makeSnippet 长度有界、含关键词、无连续空白', () => {
    fc.assert(
      fc.property(wordArb, fc.array(fc.constantFrom('x', 'y', 'z', ' ', 'ab'), { maxLength: 200 }), (kw, fillerArr) => {
        const filler = fillerArr.join('');
        const text = filler + kw + filler;
        const idx = text.indexOf(kw);
        const snippet = makeSnippet(text, idx, 80);
        // (a) 长度上界
        expect(snippet.length).toBeLessThanOrEqual(2 * 80 + kw.length + 2);
        // (b) 含关键词（大小写无关子串）
        expect(snippet.toLowerCase()).toContain(kw.toLowerCase());
        // (c) 不存在连续两个空白
        expect(/\s\s/.test(snippet)).toBe(false);
      }),
      { numRuns: 80 }
    );
  });

  // Feature: kiro-chat-search, Property 6: 结果排序与限流
  it('Property 6: 结果数 <= limit 且按 modified 倒序', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 11, max: 25 }),
        fc.integer({ min: 1, max: 10 }),
        (n, limit) => {
          const dir = freshDir();
          const base = 1_600_000_000_000;
          for (let i = 0; i < n; i++) {
            // mtime 互不相同
            writeSession(dir, `s${i}`, { title: `kw item ${i}` }, base + i * 60_000);
          }
          const hits = searchSessionsInDir(dir, 'kw', limit);
          expect(hits.length).toBeLessThanOrEqual(limit);
          for (let i = 0; i < hits.length - 1; i++) {
            expect(hits[i].modified).toBeGreaterThanOrEqual(hits[i + 1].modified);
          }
        }
      ),
      { numRuns: 30 }
    );
  });

  // Feature: kiro-chat-search, Property 7: 损坏文件不影响其他命中
  it('Property 7: 加入损坏 JSON 前后结果完全一致且不抛异常', () => {
    fc.assert(
      fc.property(
        fc.array(wordArb, { minLength: 1, maxLength: 6 }),
        (titles) => {
          const dir = freshDir();
          const base = 1_600_000_000_000;
          titles.forEach((t, i) => {
            writeSession(dir, `s${i}`, { title: `kw ${t}` }, base + i * 60_000);
          });
          const before = searchSessionsInDir(dir, 'kw', 10);

          writeRaw(dir, 'corrupt.json', '{ not ::: valid');
          const after = searchSessionsInDir(dir, 'kw', 10);

          expect(after).toEqual(before);
        }
      ),
      { numRuns: 40 }
    );
  });

  // Feature: kiro-chat-search, Property 12: 图片检测正确且不依赖 base64 内容
  it('Property 12: 当且仅当存在图片标志项时 hasImage=true，且与 base64 内容无关', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.string(), // 任意 base64 占位内容（长度/内容不应影响检测结果）
        wordArb,
        (withImage, b64, kw) => {
          const dir = freshDir();
          const content: any[] = [{ type: 'text', text: `${kw} body` }];
          if (withImage) {
            content.push({ type: 'imageUrl', imageUrl: { url: 'data:image/png;base64,' + b64 } });
          }
          writeSession(dir, 's', {
            title: `${kw} t`,
            history: [{ message: { role: 'user', content } }],
          });
          const hits = searchSessionsInDir(dir, kw, 10);
          expect(hits).toHaveLength(1);
          expect(hits[0].hasImage).toBe(withImage);
        }
      ),
      { numRuns: 60 }
    );
  });

  // Feature: kiro-chat-search, Property 13: 附件检测等价于存在非空 contextItems
  it('Property 13: hasAttachment 当且仅当存在非空 contextItems', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 3 }), // contextItems 数量
        wordArb,
        (ctxCount, kw) => {
          const dir = freshDir();
          const contextItems = Array.from({ length: ctxCount }, (_, i) => ({
            id: String(i),
            name: `f${i}.cs`,
            uri: `file:///f${i}.cs`,
            content: 'x',
            description: 'd',
          }));
          writeSession(dir, 's', {
            title: `${kw} t`,
            history: [{ message: { role: 'user', content: `${kw} body` }, contextItems }],
          });
          const hits = searchSessionsInDir(dir, kw, 10);
          expect(hits).toHaveLength(1);
          expect(hits[0].hasAttachment).toBe(ctxCount > 0);
        }
      ),
      { numRuns: 60 }
    );
  });

  // Feature: kiro-chat-search, Property 15: 缓存不改变可观察结果
  it('Property 15: 二次调用（命中缓存）结果一致；mtime 抬高后反映新内容', () => {
    fc.assert(
      fc.property(wordArb, wordArb, (kwA, kwB) => {
        fc.pre(kwA.toLowerCase() !== kwB.toLowerCase());
        const dir = freshDir();
        const base = 1_600_000_000_000;
        writeSession(dir, 's', { title: `${kwA} title` }, base);

        const first = searchSessionsInDir(dir, kwA, 10);
        const second = searchSessionsInDir(dir, kwA, 10); // 走缓存
        expect(second).toEqual(first);
        expect(first).toHaveLength(1);

        // 覆写内容并抬高 mtime → 缓存按 mtime 失效，结果反映新内容
        writeSession(dir, 's', { title: `${kwB} title` }, base + 10_000);
        expect(searchSessionsInDir(dir, kwA, 10)).toHaveLength(0);
        expect(searchSessionsInDir(dir, kwB, 10)).toHaveLength(1);

        __clearIndexCacheForTest();
      }),
      { numRuns: 40 }
    );
  });
});
