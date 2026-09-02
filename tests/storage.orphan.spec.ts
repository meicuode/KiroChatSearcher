import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as orphanModule from '../src/storage/orphan';
import {
  collectLiveSessions,
  computeOrphans,
  MANIFEST_FILENAME,
  ORPHAN_NOTE,
} from '../src/storage/orphan';
import type { ArchiveInfo } from '../src/credits';
import { mkTempDir, mkTree, rmTempDir, writeRaw, writeSession } from './_helpers';

/**
 * `src/storage/orphan.ts` 的示例测试（Req 3.3、3.6、3.7、11.6）。
 *
 * 与 `storage.orphan.property.spec.ts` 的分工：并集性质（Property 8）与三级短路
 * 状态机（Property 9）已在随机输入空间上被锁定，本文件只钉具体场景与文案内容：
 *
 * 1. 真实临时目录上「会话被删 → 其存档变成孤儿 / 会话仍在 → 不是孤儿」
 * 2. `ORPHAN_NOTE` 的实际文案（机制说明 + 限制理由 + 否定句的作用范围）
 * 3. 模块导出面与 import 面上「只读、无删除入口」这一可静态审查的事实
 */

const WS_DIR = 'ws-example';
const LIVE_ID = 'session-live';
const DOOMED_ID = 'session-doomed';

/** 写入 SessionManifest（顶层数组，字段与 Kiro 实际结构一致的最小子集） */
function writeManifest(dir: string, sessionIds: readonly string[]): void {
  writeRaw(
    dir,
    MANIFEST_FILENAME,
    JSON.stringify(sessionIds.map((id) => ({ sessionId: id, title: `t-${id}` })))
  );
}

/** 构造一条存档记录；`path` / `name` 与判定无关，只需唯一 */
function archive(chatSessionId: string | null, size: number): ArchiveInfo {
  const name = `arch-${chatSessionId ?? 'none'}`;
  return { path: path.join('C:', 'store', 'saves', name), name, size, chatSessionId };
}

const LIVE_ARCHIVE = archive(LIVE_ID, 1_024);
const DOOMED_ARCHIVE = archive(DOOMED_ID, 4_096);
const ARCHIVES: readonly ArchiveInfo[] = [LIVE_ARCHIVE, DOOMED_ARCHIVE];

describe('孤儿判定：存档指向的会话是否仍然存在', () => {
  let base: string;
  let sessionsRoot: string;
  let wsDir: string;

  beforeEach(() => {
    base = mkTempDir('kcs-orphan-example-');
    sessionsRoot = path.join(base, 'workspaceStorage');
    // 两个会话文件 + 同时列出两者的清单：初始状态下两条存档都能归因
    mkTree(sessionsRoot, { [WS_DIR]: {} });
    wsDir = path.join(sessionsRoot, WS_DIR);
    writeSession(wsDir, LIVE_ID, { sessionId: LIVE_ID, messages: [] });
    writeSession(wsDir, DOOMED_ID, { sessionId: DOOMED_ID, messages: [] });
    writeManifest(wsDir, [LIVE_ID, DOOMED_ID]);
  });

  afterEach(() => {
    rmTempDir(base);
  });

  it('会话仍存在时，指向它的存档不被计为孤儿', async () => {
    const live = await collectLiveSessions(sessionsRoot);
    expect(live.complete).toBe(true);
    expect(live.skippedCount).toBe(0);
    expect([...live.ids].sort()).toEqual([DOOMED_ID, LIVE_ID].sort());

    const res = computeOrphans(ARCHIVES, live);
    // 两条存档都归因到现存会话：ok 态且合计为 0（Req 3.3 的反面）
    expect(res.state).toBe('ok');
    expect(res.files).toBe(0);
    expect(res.bytes).toBe(0);
  });

  it('会话文件与清单条目都被删除后，指向它的存档被计为孤儿', async () => {
    // 模拟 FullCleanup：删掉 SessionFile，并从清单里摘掉对应条目（Req 3.8）
    fs.rmSync(path.join(wsDir, `${DOOMED_ID}.json`));
    writeManifest(wsDir, [LIVE_ID]);

    const live = await collectLiveSessions(sessionsRoot);
    expect(live.complete).toBe(true);
    expect([...live.ids]).toEqual([LIVE_ID]);

    const res = computeOrphans(ARCHIVES, live);
    // 只有失去引用的那条计入合计，仍有主的那条不受影响（Req 3.3、3.4）
    expect(res.state).toBe('ok');
    expect(res.files).toBe(1);
    expect(res.bytes).toBe(DOOMED_ARCHIVE.size);
    expect(res.note).toBe(ORPHAN_NOTE);
  });

  it('只删除会话文件但清单条目仍在时，存档仍有主而不是孤儿', async () => {
    // LiveSessionIds 是「文件名 ∪ 清单条目」的并集，故清单还认这个 id 时它仍算现存
    fs.rmSync(path.join(wsDir, `${DOOMED_ID}.json`));

    const live = await collectLiveSessions(sessionsRoot);
    expect(live.complete).toBe(true);
    expect(live.ids.has(DOOMED_ID)).toBe(true);

    const res = computeOrphans(ARCHIVES, live);
    expect(res.state).toBe('ok');
    expect(res.files).toBe(0);
    expect(res.bytes).toBe(0);
  });
});

describe('ORPHAN_NOTE 文案内容', () => {
  it('包含 LRU 索引只淘汰内存条目、磁盘文件残留的机制说明（Req 3.6）', () => {
    expect(ORPHAN_NOTE).toContain('LRU');
    expect(ORPHAN_NOTE).toContain('内存条目');
    expect(ORPHAN_NOTE).toContain('磁盘文件');
    expect(ORPHAN_NOTE).toContain('残留');
  });

  it('包含「不提供批量清理」及其理由（Req 3.7）', () => {
    expect(ORPHAN_NOTE).toContain('批量清理');
    expect(ORPHAN_NOTE).toContain('不提供孤儿存档的批量清理入口');
    // 理由：不归属排行页上任一可展示的会话行，无法满足 Req 14.8 的删除前提
    expect(ORPHAN_NOTE).toContain('不归属');
    expect(ORPHAN_NOTE).toContain('可展示的会话行');
    expect(ORPHAN_NOTE).toContain('只删除已枚举并展示给用户的具体文件');
  });

  it('否定句被限定在「批量」上，不出现整体否定清理能力的表述', () => {
    // 本特性是提供清理的（排行页上逐会话的附件清理与全量清理），文案不能被读成
    // 「整个特性只统计不清理」
    for (const phrase of [
      '本版本仅统计',
      '仅统计',
      '只统计不清理',
      '不提供清理',
      '不支持清理',
      '暂不支持清理',
      '无法清理',
      '不能清理',
      '没有清理',
    ]) {
      expect(ORPHAN_NOTE).not.toContain(phrase);
    }

    // 更强的约束：每一处「不提供」的作用对象都紧跟着「批量」，
    // 因此不存在一个泛指清理能力的否定句
    const occurrences: number[] = [];
    for (let i = ORPHAN_NOTE.indexOf('不提供'); i !== -1; i = ORPHAN_NOTE.indexOf('不提供', i + 1)) {
      occurrences.push(i);
    }
    expect(occurrences.length).toBeGreaterThan(0);
    for (const at of occurrences) {
      expect(ORPHAN_NOTE.slice(at, at + 20)).toContain('批量');
    }

    // 并且把用户引导到真正可用的清理入口
    expect(ORPHAN_NOTE).toContain('附件清理');
    expect(ORPHAN_NOTE).toContain('全量清理');
  });
});

describe('模块只读约束：无删除导出、无写 fs 依赖（Req 3.7、11.6）', () => {
  const SOURCE_PATH = path.resolve(process.cwd(), 'src/storage/orphan.ts');

  /** 去掉块注释、行注释与 JSDoc，避免文档里出现的词干扰源码文本断言 */
  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  }

  it('导出集合恒为固定的只读入口，不含任何删除入口', () => {
    const exported = Object.keys(orphanModule).sort();
    expect(exported).toEqual(
      [
        'MANIFEST_FILENAME',
        'ORPHAN_NOTE',
        'collectLiveSessions',
        'computeOrphans',
        'decodeWorkspaceKey',
      ].sort()
    );
    for (const name of exported) {
      expect(name).not.toMatch(/unlink|delete|remove|clean|purge|prune|rmdir/i);
    }
  });

  it('源码只从 fs 具名导入读 API，且不出现任何写 fs 调用', () => {
    const src = fs.readFileSync(SOURCE_PATH, 'utf8');
    const code = stripComments(src);

    // 所有 fs 导入都必须是具名导入，且名字落在只读白名单内
    const fsImports = [...code.matchAll(/import\s+([^;]+?)\s+from\s+'(fs|fs\/promises|node:fs[^']*)'/g)];
    expect(fsImports.length).toBeGreaterThan(0);
    const READ_ONLY_API = new Set(['readdir', 'stat', 'lstat', 'readFile', 'access', 'realpath']);
    for (const [, clause] of fsImports) {
      // 命名空间导入（import * as fs）会把写 API 一起带进来，因此不允许
      expect(clause).not.toMatch(/\*\s+as/);
      expect(clause.trim().startsWith('{')).toBe(true);
      for (const raw of clause.replace(/[{}]/g, '').split(',')) {
        const name = raw.trim().split(/\s+as\s+/)[0];
        if (!name) continue;
        expect(READ_ONLY_API.has(name)).toBe(true);
      }
    }

    // 也不允许绕过 import 拿到 fs
    expect(code).not.toMatch(/require\(\s*['"]node:?fs/);

    // 写 API 的标识符在源码里根本不出现
    for (const api of [
      'writeFile',
      'appendFile',
      'unlink',
      'rmdir',
      'mkdir',
      'rename',
      'truncate',
      'copyFile',
      'createWriteStream',
    ]) {
      expect(code).not.toContain(api);
    }
    expect(code).not.toMatch(/\brm\b/);
  });
});
