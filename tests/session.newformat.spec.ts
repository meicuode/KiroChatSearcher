import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  __clearNewSessionCacheForTest,
  listNewSessions,
  parseMessagesJsonl,
  readNewSession,
  readNewSessionMeta,
  UNTITLED_TITLE,
  type NewFormatFsDeps,
  type NewFormatStat,
} from '../src/session/newFormat';
import {
  mkMessagesJsonl,
  mkMigrationMarker,
  mkNewSessionTree,
  mkTempDir,
  rmTempDir,
  writeRaw,
  type JsonlLineSpec,
  type NewSessionTreePaths,
  type NewSessionTreeSpec,
} from './_helpers';

/**
 * `src/session/newFormat.ts` 的示例测试（Req 3.2、3.9、3.10，兼及 3.1、3.3、3.4、
 * 3.6、3.7、3.8、3.11、3.12）。
 *
 * 与 `session.newformat.property.spec.ts` 的分工：坏行容错的**普遍性**（Property 4，
 * 任意位置插入任意非法行不改变其余行的解析结果）由属性测试在随机输入空间上锁定；
 * 本文件钉具体场景与具体取值——标题占位、两种 `content` 形态、12 种被排除的事件类型、
 * 图片/附件角标的各条判定路径、缺文件跳过、`modified` 回退，以及缓存的命中与失效。
 *
 * 夹具用 `mkNewSessionTree` / `mkMessagesJsonl` / `mkMigrationMarker` 在**真实临时目录**
 * 构造（顺带验证这三个构造器可用）；只有需要精确计数「读了几次文件」的缓存用例改用
 * 注入的 {@link NewFormatFsDeps}，因为那些断言要的是调用次数而不是磁盘状态。
 */

/** 工作区目录名（1.x 的 `<sessionsRoot>/<wsHash16>`；本文件不关心哈希算法本身） */
const WS = 'cc5023603866cd91';

/** 被排除在匹配文本之外的 12 种事件类型（Req 3.4；实现以白名单反向覆盖它们） */
const EXCLUDED_TYPES = [
  'tool_call',
  'tool_result',
  'session_metadata',
  'turn_start',
  'turn_end',
  'sub_agent_start',
  'sub_agent_complete',
  'pending_interaction',
  'interaction_resolved',
  'session_event',
  'tombstone',
  'usage_summary',
] as const;

/** 一段像真实内嵌图片的 base64 载荷：断言它既不进 `text` 也不进缓存内容（Req 3.12） */
const BASE64_BLOB = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH';
const DATA_URL = `data:image/png;base64,${BASE64_BLOB}`;

let root: string;

beforeEach(() => {
  // 每个用例都从空缓存开始：缓存是模块级 Map，否则用例间会互相串扰（Req 3.11）
  __clearNewSessionCacheForTest();
  root = mkTempDir('kcs-newformat-');
});

afterEach(() => {
  __clearNewSessionCacheForTest();
  rmTempDir(root);
});

/** 在当前临时 sessions 根下建一个 1.x 会话目录 */
function mkSession(spec: Omit<NewSessionTreeSpec, 'wsHash16'>): NewSessionTreePaths {
  return mkNewSessionTree(root, { wsHash16: WS, ...spec });
}

/** 读一个会话并断言未被跳过（用例主体关心记录内容时用它去掉 `!`） */
function read(paths: NewSessionTreePaths, deps?: NewFormatFsDeps) {
  const rec = readNewSession(paths.sessionDir, deps);
  expect(rec).not.toBeNull();
  return rec!;
}

/** 只改 mtime、不改内容（用于单独验证失效判据里的 `mtimeMs` 分量） */
function touch(file: string, mtimeMs: number): void {
  const t = mtimeMs / 1000;
  fs.utimesSync(file, t, t);
}

interface CountingFs {
  deps: NewFormatFsDeps;
  reads: string[];
  stats: string[];
  readdirs: string[];
  reset(): void;
  readsUnder(dir: string): string[];
}

/**
 * 计数型只读 fs：委托真实 `fs`，但记录每次 `readdirSync` / `statSync` / `readFileSync`
 * 的路径。缓存用例据此断言「命中时一次 `readFileSync` 都不发生」——这是缓存生效的
 * 直接证据，比对比返回值更强（返回值相同也可能是重读了一遍）。
 */
function countingFs(): CountingFs {
  const reads: string[] = [];
  const stats: string[] = [];
  const readdirs: string[] = [];
  const deps: NewFormatFsDeps = {
    readdirSync: (p: string) => {
      readdirs.push(p);
      return fs.readdirSync(p);
    },
    statSync: (p: string): NewFormatStat => {
      stats.push(p);
      return fs.statSync(p);
    },
    readFileSync: (p: string, enc: 'utf8') => {
      reads.push(p);
      return fs.readFileSync(p, enc);
    },
  };
  return {
    deps,
    reads,
    stats,
    readdirs,
    reset() {
      reads.length = 0;
      stats.length = 0;
      readdirs.length = 0;
    },
    readsUnder(dir) {
      return reads.filter((p) => p.startsWith(dir));
    },
  };
}

/* ------------------------------------------------------------------ *
 * 1. 标题（Req 3.2）
 * ------------------------------------------------------------------ */

describe('标题：正常取 title，缺失/空/纯空白 → Untitled（Req 3.2）', () => {
  it('正常标题原样返回', () => {
    const t = mkSession({ sessionId: 'sess_title_ok', session: { title: 'Spec: 1.x 存储适配' } });
    expect(read(t).title).toBe('Spec: 1.x 存储适配');
  });

  it('title 字段缺失 → Untitled', () => {
    // 夹具里显式 undefined 的字段经 JSON.stringify 后被省略，即磁盘上没有该字段
    const t = mkSession({ sessionId: 'sess_title_missing', session: { title: undefined } });
    expect(fs.readFileSync(t.sessionJson!, 'utf8')).not.toContain('"title"');
    expect(read(t).title).toBe(UNTITLED_TITLE);
    expect(UNTITLED_TITLE).toBe('Untitled');
  });

  it('title 为空串 → Untitled', () => {
    const t = mkSession({ sessionId: 'sess_title_empty', session: { title: '' } });
    expect(read(t).title).toBe(UNTITLED_TITLE);
  });

  it('title 为纯空白（空格/制表/换行）→ Untitled', () => {
    const t = mkSession({ sessionId: 'sess_title_blank', session: { title: ' \t\n ' } });
    expect(read(t).title).toBe(UNTITLED_TITLE);
  });
});

/* ------------------------------------------------------------------ *
 * 2. 匹配文本与预览（Req 3.3、3.4）
 * ------------------------------------------------------------------ */

describe('匹配文本与预览：只取 user / assistant（Req 3.3、3.4）', () => {
  it('content 为字符串：user 与 assistant 的文本按出现顺序进入 text', () => {
    const t = mkSession({
      sessionId: 'sess_text_string',
      events: [
        { payload: { type: 'user', content: 'fix the websocket bug', source: 'chat' } },
        { payload: { type: 'assistant', content: 'patched the reconnect path' } },
      ],
    });
    const rec = read(t);
    expect(rec.text).toBe('fix the websocket bug\npatched the reconnect path');
    expect(rec.firstUserText).toBe('fix the websocket bug');
  });

  it('content 为内容项数组：文本项与裸字符串项都被提取', () => {
    const parsed = parseMessagesJsonl(
      mkMessagesJsonl([
        {
          payload: {
            type: 'user',
            content: ['bare-string-item', { type: 'text', text: 'object-text-item' }],
          },
        },
        { payload: { type: 'assistant', content: [{ type: 'text', text: 'assistant-item' }] } },
      ])
    );
    expect(parsed.text).toBe('bare-string-item\nobject-text-item\nassistant-item');
    expect(parsed.firstUserText).toBe('bare-string-item');
  });

  it('预览取首条 user 事件的文本，assistant 在前也不影响', () => {
    const t = mkSession({
      sessionId: 'sess_preview',
      events: [
        { payload: { type: 'assistant', content: 'greeting first' } },
        { payload: { type: 'user', content: '  first user line  ' } },
        { payload: { type: 'user', content: 'second user line' } },
      ],
    });
    const rec = read(t);
    // firstUserText 已 trim；text 保留原文
    expect(rec.firstUserText).toBe('first user line');
    expect(rec.text).toContain('  first user line  ');
  });

  it('12 种被排除的事件类型：其文本不进 text', () => {
    const events: JsonlLineSpec[] = [
      { payload: { type: 'user', content: 'KEEP-user' } },
      ...EXCLUDED_TYPES.map<JsonlLineSpec>((type) => ({
        payload: { type, content: `DROP-${type}` },
      })),
      { payload: { type: 'assistant', content: 'KEEP-assistant' } },
    ];
    const t = mkSession({ sessionId: 'sess_excluded', events });
    const rec = read(t);

    expect(rec.text).toBe('KEEP-user\nKEEP-assistant');
    for (const type of EXCLUDED_TYPES) {
      expect(rec.text).not.toContain(`DROP-${type}`);
    }
    // 排除只针对匹配文本；这些事件本身确实写进了磁盘（不是夹具没生成）
    expect(fs.readFileSync(t.messagesJsonl!, 'utf8')).toContain('DROP-tool_result');
  });

  it('未知/新增的事件类型默认不进 text（白名单而非黑名单）', () => {
    const parsed = parseMessagesJsonl(
      mkMessagesJsonl([
        { payload: { type: 'user', content: 'KEEP-user' } },
        { payload: { type: 'brand_new_future_event', content: 'DROP-unknown' } },
      ])
    );
    expect(parsed.text).toBe('KEEP-user');
  });
});

/* ------------------------------------------------------------------ *
 * 3. hasImage（Req 3.6、3.12）
 * ------------------------------------------------------------------ */

describe('hasImage：只看标志、不碰 base64 数据（Req 3.6、3.12）', () => {
  it('内容项 type 含 image → true，且图片项不进 text', () => {
    const t = mkSession({
      sessionId: 'sess_img_part',
      events: [
        {
          payload: {
            type: 'user',
            content: [
              { type: 'text', text: 'look at this screenshot' },
              { type: 'image', imageUrl: DATA_URL },
            ],
          },
        },
      ],
    });
    const rec = read(t);
    expect(rec.hasImage).toBe(true);
    expect(rec.text).toBe('look at this screenshot');
    expect(rec.text).not.toContain(BASE64_BLOB);
  });

  it('payload 顶层有 imageUrl 字段 → true', () => {
    const t = mkSession({
      sessionId: 'sess_img_url',
      events: [{ payload: { type: 'user', content: 'with pasted image', imageUrl: DATA_URL } }],
    });
    const rec = read(t);
    expect(rec.hasImage).toBe(true);
    expect(rec.text).toBe('with pasted image');
  });

  it('payload 顶层有 image 字段 → true', () => {
    const t = mkSession({
      sessionId: 'sess_img_field',
      events: [
        { payload: { type: 'user', content: 'attached', image: { data: BASE64_BLOB } } },
      ],
    });
    expect(read(t).hasImage).toBe(true);
  });

  it('图片标志出现在非 user/assistant 事件里（如 tool_result）同样为 true', () => {
    const parsed = parseMessagesJsonl(
      mkMessagesJsonl([
        { payload: { type: 'user', content: 'render it' } },
        { payload: { type: 'tool_result', content: [{ type: 'image', image: BASE64_BLOB }] } },
      ])
    );
    expect(parsed.hasImage).toBe(true);
    expect(parsed.text).toBe('render it');
  });

  it('无图片标志 → false', () => {
    const t = mkSession({
      sessionId: 'sess_img_none',
      events: [
        { payload: { type: 'user', content: 'plain question' } },
        { payload: { type: 'assistant', content: 'plain answer' } },
      ],
    });
    expect(read(t).hasImage).toBe(false);
  });

  it('content 直接是 data: URL 字符串时不进 text', () => {
    const parsed = parseMessagesJsonl(
      mkMessagesJsonl([{ payload: { type: 'user', content: DATA_URL } }])
    );
    expect(parsed.text).toBe('');
    expect(parsed.text).not.toContain(BASE64_BLOB);
  });
});

/* ------------------------------------------------------------------ *
 * 4. hasAttachment（Req 3.7）
 * ------------------------------------------------------------------ */

describe('hasAttachment：非空上下文引用 或 snapshots/ 内有文件（Req 3.7）', () => {
  it('路径一：事件带非空 contextItems → true（无需 snapshots/）', () => {
    const t = mkSession({
      sessionId: 'sess_ctx',
      events: [
        {
          payload: {
            type: 'user',
            content: 'check #File src/a.ts',
            contextItems: [{ type: 'file', path: 'src/a.ts' }],
          },
        },
      ],
    });
    expect(t.snapshotsDir).toBeNull();
    expect(read(t).hasAttachment).toBe(true);
  });

  it('路径二：snapshots/<hash>/<相对路径> 下确有文件 → true（无 contextItems）', () => {
    const t = mkSession({
      sessionId: 'sess_snap_file',
      events: [{ payload: { type: 'user', content: 'edit a file' } }],
      snapshots: { 'h1/src/a.ts': 120 },
    });
    expect(fs.existsSync(path.join(t.snapshotsDir!, 'h1', 'src', 'a.ts'))).toBe(true);
    expect(read(t).hasAttachment).toBe(true);
  });

  it('snapshots/ 目录存在但没有文件 → false', () => {
    const t = mkSession({
      sessionId: 'sess_snap_empty',
      events: [{ payload: { type: 'user', content: 'no attachment' } }],
      snapshots: {},
    });
    expect(fs.existsSync(t.snapshotsDir!)).toBe(true);
    expect(fs.readdirSync(t.snapshotsDir!)).toEqual([]);
    expect(read(t).hasAttachment).toBe(false);
  });

  it('snapshots/<hash>/ 存在但其中已无文件 → false（只判到 hash 目录会误判）', () => {
    const t = mkSession({
      sessionId: 'sess_snap_hash_only',
      events: [{ payload: { type: 'user', content: 'cleaned snapshots' } }],
      snapshots: { h1: {} },
    });
    expect(fs.readdirSync(t.snapshotsDir!)).toEqual(['h1']);
    expect(read(t).hasAttachment).toBe(false);
  });

  it('contextItems 为空数组且无 snapshots/ → false', () => {
    const t = mkSession({
      sessionId: 'sess_ctx_empty',
      events: [{ payload: { type: 'user', content: 'nothing attached', contextItems: [] } }],
    });
    expect(read(t).hasAttachment).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 5. 坏行跳过（Req 3.8）
 * ------------------------------------------------------------------ */

describe('坏行：单行非法 JSON 只跳过该行（Req 3.8）', () => {
  it('中间夹一行非法 JSON，前后两行照常解析', () => {
    const t = mkSession({
      sessionId: 'sess_badline',
      events: [
        { payload: { type: 'user', content: 'before the bad line' } },
        '{"id":"evt-truncated","payload":{"type":"user","content":"half writ',
        { payload: { type: 'assistant', content: 'after the bad line' } },
      ],
    });
    const rec = read(t);
    expect(rec.text).toBe('before the bad line\nafter the bad line');
    expect(rec.firstUserText).toBe('before the bad line');
  });

  it('多种坏行形态（空行、纯空白、裸文本、截断 JSON）都不影响其余行', () => {
    const parsed = parseMessagesJsonl(
      mkMessagesJsonl([
        { payload: { type: 'user', content: 'line-1' } },
        '',
        '   ',
        'not json at all',
        '{ "payload": { "type": "user", "content": "unterminated',
        '[1,2,3]',
        { payload: { type: 'assistant', content: 'line-2' } },
      ])
    );
    expect(parsed.text).toBe('line-1\nline-2');
  });

  it('整个 messages.jsonl 全是坏行 → 会话仍可读，只是文本为空', () => {
    const t = mkSession({
      sessionId: 'sess_all_bad',
      messagesJsonlRaw: 'garbage\n{ broken\nalso garbage\n',
      session: { title: 'Broken messages' },
    });
    const rec = read(t);
    expect(rec.title).toBe('Broken messages');
    expect(rec.text).toBe('');
    expect(rec.firstUserText).toBe('');
  });
});

/* ------------------------------------------------------------------ *
 * 6. 缺文件跳过（Req 3.9）
 * ------------------------------------------------------------------ */

describe('缺文件的会话被跳过，其余会话照常返回（Req 3.9）', () => {
  it('缺 session.json / 缺 messages.jsonl / session.json 非法的会话都被跳过', () => {
    const ok = mkSession({
      sessionId: 'sess_ok',
      session: { title: 'Healthy' },
      events: [{ payload: { type: 'user', content: 'healthy session' } }],
    });
    const noMeta = mkSession({
      sessionId: 'sess_no_meta',
      session: null,
      events: [{ payload: { type: 'user', content: 'orphan messages' } }],
    });
    const noMsgs = mkSession({ sessionId: 'sess_no_msgs', events: null });
    const badMeta = mkSession({
      sessionId: 'sess_bad_meta',
      sessionJsonRaw: '{ "title": "unterminated',
      events: [{ payload: { type: 'user', content: 'meta is broken' } }],
    });

    // 夹具确实没生成对应文件（否则下面的断言会因别的原因通过）
    expect(fs.existsSync(path.join(noMeta.sessionDir, 'session.json'))).toBe(false);
    expect(fs.existsSync(path.join(noMsgs.sessionDir, 'messages.jsonl'))).toBe(false);

    let recs: ReturnType<typeof listNewSessions> = [];
    expect(() => {
      recs = listNewSessions(ok.workspaceDir);
    }).not.toThrow();

    expect(recs.map((r) => r.sessionId)).toEqual(['sess_ok']);
    expect(recs[0].title).toBe('Healthy');
    // 单个会话直接读时同样返回 null 而不抛
    expect(readNewSession(noMeta.sessionDir)).toBeNull();
    expect(readNewSession(noMsgs.sessionDir)).toBeNull();
    expect(readNewSession(badMeta.sessionDir)).toBeNull();
    expect(readNewSessionMeta(noMeta.sessionDir)).toBeNull();
    expect(readNewSessionMeta(badMeta.sessionDir)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * 7. modified 回退（Req 3.10）
 * ------------------------------------------------------------------ */

describe('modified：lastModifiedAt 优先，缺失或非法时回退 messages.jsonl 的 mtime（Req 3.10）', () => {
  const MSG_MTIME = 1_600_000_000_000;
  const LAST_MODIFIED = '2026-09-01T05:07:55.425Z';

  it('lastModifiedAt 合法 → 取它', () => {
    const t = mkSession({
      sessionId: 'sess_mod_ok',
      session: { lastModifiedAt: LAST_MODIFIED },
      messagesMtimeMs: MSG_MTIME,
    });
    const rec = read(t);
    expect(rec.modified).toBe(Date.parse(LAST_MODIFIED));
    // 确认它不是碰巧等于回退值
    expect(rec.modified).not.toBe(fs.statSync(t.messagesJsonl!).mtimeMs);
  });

  it('lastModifiedAt 缺失 → 回退 messages.jsonl 的 mtime', () => {
    const t = mkSession({
      sessionId: 'sess_mod_missing',
      session: { lastModifiedAt: undefined },
      messagesMtimeMs: MSG_MTIME,
    });
    expect(fs.readFileSync(t.sessionJson!, 'utf8')).not.toContain('lastModifiedAt');

    const mtime = fs.statSync(t.messagesJsonl!).mtimeMs;
    expect(read(t).modified).toBe(mtime);
    // 夹具设置的 mtime 确实生效（文件系统时间精度带来的偏差远小于 1s）
    expect(Math.abs(mtime - MSG_MTIME)).toBeLessThan(1000);
  });

  it("lastModifiedAt 非法（'nope'）→ 回退 messages.jsonl 的 mtime", () => {
    const t = mkSession({
      sessionId: 'sess_mod_bad',
      session: { lastModifiedAt: 'nope' },
      messagesMtimeMs: MSG_MTIME,
    });
    expect(read(t).modified).toBe(fs.statSync(t.messagesJsonl!).mtimeMs);
  });

  it('lastModifiedAt 为纯空白 → 回退 messages.jsonl 的 mtime', () => {
    const t = mkSession({
      sessionId: 'sess_mod_blank',
      session: { lastModifiedAt: '   ' },
      messagesMtimeMs: MSG_MTIME,
    });
    expect(read(t).modified).toBe(fs.statSync(t.messagesJsonl!).mtimeMs);
  });
});

/* ------------------------------------------------------------------ *
 * 8. 会话枚举与 sessionId（Req 3.1）
 * ------------------------------------------------------------------ */

describe('会话枚举：以目录枚举为来源（Req 3.1）', () => {
  it('工作区目录下的文件不被当成会话，且不会被读取', () => {
    const t = mkSession({
      sessionId: 'sess_enum',
      events: [{ payload: { type: 'user', content: 'only real session' } }],
    });
    // 1.x 真实存在的同级文件：追加式索引与游标，都不是会话
    const indexFile = writeRaw(t.workspaceDir, 'session-index.jsonl', '{"op":"add"}\n');
    const cursorFile = writeRaw(t.workspaceDir, 'publish.cursor', '12');

    const c = countingFs();
    const recs = listNewSessions(t.workspaceDir, c.deps);

    expect(recs.map((r) => r.sessionId)).toEqual(['sess_enum']);
    expect(c.readdirs).toContain(t.workspaceDir);
    expect(c.reads).not.toContain(indexFile);
    expect(c.reads).not.toContain(cursorFile);
  });

  it('目录不可读时返回空数组而不抛', () => {
    const missing = path.join(root, 'ws-does-not-exist');
    expect(listNewSessions(missing)).toEqual([]);

    const throwing: NewFormatFsDeps = {
      readdirSync: () => {
        const e = new Error("EACCES: permission denied, scandir") as Error & { code: string };
        e.code = 'EACCES';
        throw e;
      },
    };
    let recs: ReturnType<typeof listNewSessions> = [{} as never];
    expect(() => {
      recs = listNewSessions(path.join(root, WS), throwing);
    }).not.toThrow();
    expect(recs).toEqual([]);
  });

  it('单个条目 stat 失败只跳过它，其余会话照常返回', () => {
    const a = mkSession({
      sessionId: 'sess_stat_ok',
      events: [{ payload: { type: 'user', content: 'fine' } }],
    });
    mkSession({ sessionId: 'sess_stat_fail', events: [{ payload: { type: 'user', content: 'x' } }] });

    const failing: NewFormatFsDeps = {
      statSync: (p: string): NewFormatStat => {
        if (p.includes('sess_stat_fail')) throw new Error('EIO: stat failed');
        return fs.statSync(p);
      },
    };
    const recs = listNewSessions(a.workspaceDir, failing);
    expect(recs.map((r) => r.sessionId)).toEqual(['sess_stat_ok']);
  });

  it('sessionId 恒取目录名，即使 session.json 的 id 不同', () => {
    const t = mkSession({
      sessionId: 'sess_dirname_wins',
      session: { id: 'totally-different-id' },
    });
    // 夹具确实写入了不一致的 id
    expect(readNewSessionMeta(t.sessionDir)?.id).toBe('totally-different-id');

    const rec = read(t);
    expect(rec.sessionId).toBe('sess_dirname_wins');
    expect(rec.dir).toBe(t.sessionDir);
    expect(listNewSessions(t.workspaceDir).map((r) => r.sessionId)).toEqual(['sess_dirname_wins']);
  });

  it('迁移来的会话（裸 uuid 目录名）照常读取，旧目录里的迁移标记不在读取面上', () => {
    const uuid = '3f1b6b0e-2c4a-4f3d-9a71-9f2b0c8d4e55';
    const t = mkSession({
      sessionId: uuid,
      session: { title: 'Migrated chat' },
      events: [{ payload: { type: 'user', content: 'came from 0.9x' } }],
    });
    const legacyWsDir = path.join(root, 'workspaceStorage', 'ws-encoded-key');
    const marker = mkMigrationMarker(legacyWsDir, uuid, 'd:\\Projects\\Demo');

    const c = countingFs();
    const rec = read(t, c.deps);

    expect(rec.sessionId).toBe(uuid);
    expect(rec.title).toBe('Migrated chat');
    expect(rec.text).toBe('came from 0.9x');
    // 只访问 NewSessionDir：迁移标记既没被读，也没被动（Req 3.13）
    expect(c.reads).not.toContain(marker);
    const touched = [...c.reads, ...c.stats, ...c.readdirs];
    expect(touched.every((p) => p.startsWith(t.sessionDir))).toBe(true);
    expect(fs.existsSync(marker)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 9. (mtimeMs, size) 失效缓存（Req 3.11）
 * ------------------------------------------------------------------ */

describe('缓存：按 (mtimeMs, size) 失效（Req 3.11）', () => {
  it('同一会话连续读两次，第二次不再 readFileSync', () => {
    const t = mkSession({
      sessionId: 'sess_cache_hit',
      session: { title: 'Cached' },
      events: [{ payload: { type: 'user', content: 'cache me' } }],
    });
    const c = countingFs();

    const first = read(t, c.deps);
    expect(c.readsUnder(t.sessionDir)).toEqual([
      path.join(t.sessionDir, 'session.json'),
      path.join(t.sessionDir, 'messages.jsonl'),
    ]);

    c.reset();
    const second = read(t, c.deps);
    expect(c.reads).toEqual([]);
    // 缓存命中时仍 stat 两个文件（失效判据就是它们）
    expect(c.stats).toEqual([
      path.join(t.sessionDir, 'session.json'),
      path.join(t.sessionDir, 'messages.jsonl'),
    ]);
    expect(second).toEqual(first);
    // 每次返回新对象：调用方改动不污染缓存
    expect(second).not.toBe(first);
  });

  it('只改 messages.jsonl 的 mtime（内容不变）也会重读该会话', () => {
    const t = mkSession({
      sessionId: 'sess_cache_mtime',
      events: [{ payload: { type: 'user', content: 'unchanged content' } }],
      messagesMtimeMs: 1_600_000_000_000,
    });
    const c = countingFs();
    read(t, c.deps);

    c.reset();
    touch(t.messagesJsonl!, 1_600_000_600_000);
    const rec = read(t, c.deps);

    expect(c.readsUnder(t.sessionDir)).toHaveLength(2);
    expect(rec.text).toBe('unchanged content');
  });

  it('改动一个会话后只重读该会话，其余会话继续复用缓存', () => {
    const a = mkSession({
      sessionId: 'sess_a',
      events: [{ payload: { type: 'user', content: 'a-original' } }],
    });
    const b = mkSession({
      sessionId: 'sess_b',
      events: [{ payload: { type: 'user', content: 'b-original' } }],
    });
    const c = countingFs();

    const firstPass = listNewSessions(a.workspaceDir, c.deps);
    expect(firstPass.map((r) => r.sessionId)).toEqual(['sess_a', 'sess_b']);
    expect(c.reads).toHaveLength(4);

    // 第二遍：两个会话都没变，一次 readFileSync 都不发生
    c.reset();
    const cached = listNewSessions(a.workspaceDir, c.deps);
    expect(c.reads).toEqual([]);
    expect(cached.map((r) => r.text)).toEqual(['a-original', 'b-original']);

    // 只改 A 的 messages.jsonl（内容与 mtime 都变）
    c.reset();
    fs.writeFileSync(
      a.messagesJsonl!,
      mkMessagesJsonl([{ payload: { type: 'user', content: 'a-updated-and-longer' } }]),
      'utf8'
    );
    touch(a.messagesJsonl!, 1_700_000_000_000);
    const afterEdit = listNewSessions(a.workspaceDir, c.deps);

    expect(c.readsUnder(a.sessionDir)).toHaveLength(2);
    expect(c.readsUnder(b.sessionDir)).toHaveLength(0);
    expect(afterEdit.map((r) => r.text)).toEqual(['a-updated-and-longer', 'b-original']);
  });

  it('__clearNewSessionCacheForTest() 后全量重读', () => {
    mkSession({ sessionId: 'sess_a', events: [{ payload: { type: 'user', content: 'a' } }] });
    const b = mkSession({
      sessionId: 'sess_b',
      events: [{ payload: { type: 'user', content: 'b' } }],
    });
    const c = countingFs();

    listNewSessions(b.workspaceDir, c.deps);
    c.reset();
    listNewSessions(b.workspaceDir, c.deps);
    expect(c.reads).toEqual([]);

    __clearNewSessionCacheForTest();
    c.reset();
    const recs = listNewSessions(b.workspaceDir, c.deps);
    // 2 个会话 × 2 个文件
    expect(c.reads).toHaveLength(4);
    expect(recs.map((r) => r.sessionId)).toEqual(['sess_a', 'sess_b']);
  });

  it('缓存内容里不含内嵌 base64 图片数据（Req 3.12）', () => {
    const t = mkSession({
      sessionId: 'sess_cache_no_base64',
      events: [
        {
          payload: {
            type: 'user',
            content: [
              { type: 'text', text: 'see attachment' },
              { type: 'image', imageUrl: DATA_URL },
            ],
          },
        },
      ],
    });
    const first = read(t);
    // 第二次为缓存命中：命中路径产出的记录同样不含 base64
    const second = read(t);
    for (const rec of [first, second]) {
      expect(rec.hasImage).toBe(true);
      expect(rec.text).toBe('see attachment');
      expect(JSON.stringify(rec)).not.toContain(BASE64_BLOB);
    }
  });
});
