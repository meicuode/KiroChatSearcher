import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  mkTempDir,
  rmTempDir,
  mkTree,
  snapshotTree,
  canSymlink,
  recordingReadFs,
  recordingCleanerFs,
  mkNewSessionTree,
  mkMessagesJsonl,
  mkMigrationMarker,
} from './_helpers';

const dirs: string[] = [];
function tmp(): string {
  const d = mkTempDir('kcs-helpers-');
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmTempDir(dirs.pop()!);
});

describe('mkTree / snapshotTree', () => {
  it('按声明式描述创建嵌套目录、指定字节数与 mtime', () => {
    const root = tmp();
    mkTree(root, {
      logs: { 'a.log': 100, nested: { 'b.log': 5 } },
      'c.json': { kind: 'file', content: '{"a":1}', mtimeMs: 1_600_000_000_000 },
    });

    expect(fs.statSync(path.join(root, 'logs', 'a.log')).size).toBe(100);
    expect(fs.statSync(path.join(root, 'logs', 'nested', 'b.log')).size).toBe(5);
    expect(fs.readFileSync(path.join(root, 'c.json'), 'utf8')).toBe('{"a":1}');
    expect(fs.statSync(path.join(root, 'c.json')).mtimeMs).toBe(1_600_000_000_000);

    const snap = snapshotTree(root);
    expect(Object.keys(snap).sort()).toEqual([
      '.',
      'c.json',
      'logs',
      'logs/a.log',
      'logs/nested',
      'logs/nested/b.log',
    ]);
    expect(snap['logs/a.log'].size).toBe(100);
  });

  it('快照不跟随符号链接，只记录链接自身条目', () => {
    const root = tmp();
    mkTree(root, { target: { 'x.bin': 30 } });
    if (!canSymlink(root)) return; // 无符号链接权限时跳过
    mkTree(root, { link: { kind: 'link', target: 'target' } });

    const snap = snapshotTree(root);
    expect(snap['link']).toBeDefined();
    expect(snap['link/x.bin']).toBeUndefined();
    expect(fs.lstatSync(path.join(root, 'link')).isSymbolicLink()).toBe(true);
  });
});

describe('recordingReadFs', () => {
  it('只暴露读调用并记录方法名与实参', async () => {
    const root = tmp();
    mkTree(root, { 'a.json': '{}' });
    const { deps, calls } = recordingReadFs();

    const entries = await deps.readdir(root, { withFileTypes: true });
    await deps.lstat(path.join(root, 'a.json'));
    await deps.readFile(path.join(root, 'a.json'), 'utf8');

    expect(entries.map((e) => e.name)).toEqual(['a.json']);
    expect(calls.map((c) => c.op)).toEqual(['readdir', 'lstat', 'readFile']);
    expect(new Set(Object.keys(deps))).toEqual(
      new Set(['readdir', 'lstat', 'stat', 'readFile', 'yieldNow'])
    );
  });
});

describe('recordingCleanerFs', () => {
  const p = (n: string) => path.resolve('/store', n);

  it('在内存树上模拟 unlink/stat/readFile/writeFile 并记录调用', async () => {
    const fsx = recordingCleanerFs({ [p('a.bin')]: 10, [p('sessions.json')]: '[]' });

    expect((await fsx.deps.stat(p('a.bin'))).size).toBe(10);
    await fsx.deps.unlink(p('a.bin'));
    expect(fsx.exists(p('a.bin'))).toBe(false);
    await fsx.deps.writeFile(p('sessions.json'), '[1]', 'utf8');
    expect(await fsx.deps.readFile(p('sessions.json'), 'utf8')).toBe('[1]');

    expect(fsx.calls.map((c) => c.op)).toEqual([
      'stat',
      'unlink',
      'writeFile',
      'readFile',
    ]);
    await expect(fsx.deps.stat(p('a.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('锁类失败按 times 次数后放行，不可重试失败恒失败', async () => {
    const fsx = recordingCleanerFs(
      { [p('a.bin')]: 10, [p('b.bin')]: 10 },
      {
        lock: { [p('a.bin')]: { code: 'EBUSY', times: 2, op: 'unlink' } },
        fatal: { [p('b.bin')]: { code: 'EIO', op: 'unlink' } },
      }
    );

    await expect(fsx.deps.unlink(p('a.bin'))).rejects.toMatchObject({ code: 'EBUSY' });
    await expect(fsx.deps.unlink(p('a.bin'))).rejects.toMatchObject({ code: 'EBUSY' });
    await fsx.deps.unlink(p('a.bin'));
    expect(fsx.exists(p('a.bin'))).toBe(false);

    await expect(fsx.deps.unlink(p('b.bin'))).rejects.toMatchObject({ code: 'EIO' });
    await expect(fsx.deps.unlink(p('b.bin'))).rejects.toMatchObject({ code: 'EIO' });
    expect(fsx.exists(p('b.bin'))).toBe(true);
  });

  it('applyAfterConfirm 支持改 size/mtimeMs 与让文件消失', async () => {
    const fsx = recordingCleanerFs(
      { [p('a.bin')]: 10, [p('b.bin')]: 10, [p('c.bin')]: 10 },
      {
        afterConfirm: {
          [p('a.bin')]: { size: 20 },
          [p('b.bin')]: { mtimeMs: 42 },
          [p('c.bin')]: { missing: true },
        },
      }
    );

    expect(fsx.applyAfterConfirm()).toBe(3);
    expect((await fsx.deps.stat(p('a.bin'))).size).toBe(20);
    expect((await fsx.deps.stat(p('b.bin'))).mtimeMs).toBe(42);
    expect(fsx.exists(p('c.bin'))).toBe(false);
  });

  it('delay 只记录毫秒数不真的等待', async () => {
    const fsx = recordingCleanerFs({});
    await fsx.deps.delay?.(200);
    await fsx.deps.delay?.(200);
    expect(fsx.delays).toEqual([200, 200]);
  });
});

describe('mkMessagesJsonl', () => {
  it('每行生成 {id,timestamp,payload}，缺省 id 与 timestamp 递增', () => {
    const text = mkMessagesJsonl(
      [
        { payload: { type: 'user', content: 'hi' } },
        { id: 'x', timestamp: '2020-01-01T00:00:00.000Z', payload: { type: 'assistant' } },
      ],
      { baseTimestampMs: Date.parse('2026-09-01T00:00:00.000Z') }
    );

    const lines = text.split('\n');
    expect(text.endsWith('\n')).toBe(true);
    expect(lines[2]).toBe(''); // 末尾换行
    expect(JSON.parse(lines[0])).toEqual({
      id: 'evt-1',
      timestamp: '2026-09-01T00:00:00.000Z',
      payload: { type: 'user', content: 'hi' },
    });
    expect(JSON.parse(lines[1])).toEqual({
      id: 'x',
      timestamp: '2020-01-01T00:00:00.000Z',
      payload: { type: 'assistant' },
    });
  });

  it('支持在任意位置插入原样写入的非法 JSON 行', () => {
    const text = mkMessagesJsonl([
      { payload: { type: 'user' } },
      '{ not json',
      { raw: '' },
      { payload: { type: 'assistant' } },
    ]);

    const lines = text.trimEnd().split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe('{ not json');
    expect(lines[2]).toBe('');
    expect(() => JSON.parse(lines[1])).toThrow();
    expect(JSON.parse(lines[3]).payload.type).toBe('assistant');
  });

  it('空序列产出空串，trailingNewline=false 时不加尾换行', () => {
    expect(mkMessagesJsonl([])).toBe('');
    expect(mkMessagesJsonl([{ payload: { type: 'user' } }], { trailingNewline: false })).not.toMatch(
      /\n$/
    );
  });
});

describe('mkNewSessionTree', () => {
  it('构造 <wsHash16>/<sessionId>/ 目录型会话，含 session.json 与 messages.jsonl', () => {
    const root = tmp();
    const t = mkNewSessionTree(root, {
      wsHash16: 'cc5023603866cd91',
      sessionId: 'sess_abc',
      session: { title: 'Spec: foo', lastModifiedAt: '2026-09-01T05:07:55.425Z' },
      events: [{ payload: { type: 'user', content: 'hello' } }],
      messagesMtimeMs: 1_600_000_000_000,
    });

    expect(t.workspaceDir).toBe(path.join(root, 'cc5023603866cd91'));
    expect(t.sessionDir).toBe(path.join(root, 'cc5023603866cd91', 'sess_abc'));

    const meta = JSON.parse(fs.readFileSync(t.sessionJson!, 'utf8'));
    expect(meta.id).toBe('sess_abc'); // 缺省取 sessionId
    expect(meta.title).toBe('Spec: foo');
    expect(meta.lastModifiedAt).toBe('2026-09-01T05:07:55.425Z');
    expect(meta.schemaVersion).toBe('1.0.0');

    expect(fs.statSync(t.messagesJsonl!).mtimeMs).toBe(1_600_000_000_000);
    expect(JSON.parse(fs.readFileSync(t.messagesJsonl!, 'utf8').trimEnd()).payload.content).toBe(
      'hello'
    );
    expect(t.snapshotsDir).toBeNull();
    expect(t.subExecutionsDir).toBeNull();
  });

  it('snapshots / sub-executions 的多级键展开为目录，数字为字节数', () => {
    const root = tmp();
    const t = mkNewSessionTree(root, {
      wsHash16: 'ws00000000000001',
      sessionId: 'sess_snap',
      snapshots: { 'h1/src/a.ts': 120, 'h1/src/b.ts': 3, 'h2\\deep\\c.md': 7 },
      subExecutions: { 'sub-1/messages.jsonl': '{}' },
      extra: { 'publish.cursor': 8 },
    });

    expect(fs.statSync(path.join(t.snapshotsDir!, 'h1', 'src', 'a.ts')).size).toBe(120);
    expect(fs.statSync(path.join(t.snapshotsDir!, 'h1', 'src', 'b.ts')).size).toBe(3);
    expect(fs.statSync(path.join(t.snapshotsDir!, 'h2', 'deep', 'c.md')).size).toBe(7);
    expect(fs.readFileSync(path.join(t.subExecutionsDir!, 'sub-1', 'messages.jsonl'), 'utf8')).toBe(
      '{}'
    );
    expect(fs.statSync(path.join(t.sessionDir, 'publish.cursor')).size).toBe(8);
  });

  it('session/events 为 null 时不生成对应文件；raw 变体可写入非法 JSON', () => {
    const root = tmp();
    const missing = mkNewSessionTree(root, {
      wsHash16: 'ws00000000000002',
      sessionId: 'sess_missing',
      session: null,
      events: null,
      snapshots: {},
    });

    expect(missing.sessionJson).toBeNull();
    expect(missing.messagesJsonl).toBeNull();
    expect(fs.existsSync(path.join(missing.sessionDir, 'session.json'))).toBe(false);
    expect(fs.existsSync(path.join(missing.sessionDir, 'messages.jsonl'))).toBe(false);
    expect(fs.statSync(missing.snapshotsDir!).isDirectory()).toBe(true); // 空目录仍建出

    const raw = mkNewSessionTree(root, {
      wsHash16: 'ws00000000000002',
      sessionId: 'sess_raw',
      sessionJsonRaw: '{ broken',
      messagesJsonlRaw: 'nope\n',
    });
    expect(fs.readFileSync(raw.sessionJson!, 'utf8')).toBe('{ broken');
    expect(fs.readFileSync(raw.messagesJsonl!, 'utf8')).toBe('nope\n');
  });

  it('显式 undefined 的 session 字段在产出 JSON 中被省略', () => {
    const root = tmp();
    const t = mkNewSessionTree(root, {
      wsHash16: 'ws00000000000003',
      sessionId: 'sess_undef',
      session: { lastModifiedAt: undefined, title: '   ' },
    });

    const meta = JSON.parse(fs.readFileSync(t.sessionJson!, 'utf8'));
    expect('lastModifiedAt' in meta).toBe(false);
    expect(meta.title).toBe('   ');
  });
});

describe('mkMigrationMarker', () => {
  it('在旧目录写出 ._migration-<uuid>.json，workspaceHash 用旧算法前 16 位', () => {
    const root = tmp();
    const oldDir = path.join(root, 'EncodedKey');
    const ws = 'd:\\Projects\\KiroExt\\KiroChatSearcher';
    const full = mkMigrationMarker(oldDir, '9f8fb2af-0d80-4521-852d-f1404757d60f', ws, {
      uuid: '11111111-2222-3333-4444-555555555555',
      migratedAt: '2026-08-31T09:50:30.724Z',
    });

    expect(path.basename(full)).toBe('._migration-11111111-2222-3333-4444-555555555555.json');
    expect(JSON.parse(fs.readFileSync(full, 'utf8'))).toEqual({
      migratedAt: '2026-08-31T09:50:30.724Z',
      v2SessionId: '9f8fb2af-0d80-4521-852d-f1404757d60f',
      workspaceHash: crypto.createHash('sha256').update(ws, 'utf8').digest('hex').slice(0, 16),
      v1WorkspaceDirectory: ws,
      markerVersion: 2,
    });
  });

  it('缺省随机 uuid，且可覆盖 workspaceHash 与 markerVersion', () => {
    const root = tmp();
    const a = mkMigrationMarker(root, 's1', '/ws');
    const b = mkMigrationMarker(root, 's2', '/ws', {
      workspaceHash: '2cdaa0f6fffc6b9e',
      markerVersion: 3,
    });

    expect(a).not.toBe(b);
    expect(path.basename(a)).toMatch(/^\._migration-[0-9a-f-]{36}\.json$/);
    const mb = JSON.parse(fs.readFileSync(b, 'utf8'));
    expect(mb.workspaceHash).toBe('2cdaa0f6fffc6b9e');
    expect(mb.markerVersion).toBe(3);
  });
});
