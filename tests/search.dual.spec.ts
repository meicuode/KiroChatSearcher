import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  __clearIndexCacheForTest,
  listRecentSessionsInLayout,
  searchSessionsInLayout,
  type LayoutSessionDirs,
  type SearchHit,
} from '../src/search';
import { __clearNewSessionCacheForTest } from '../src/session/newFormat';
import { __clearMigrationMarkerCacheForTest } from '../src/session/origin';
import { __clearCreditCacheForTest, __clearMessagesCreditCacheForTest } from '../src/credits';
import { applyAttachmentFilter, type AttachmentFilterMode } from '../src/webview/filter';
import { getWebviewHtml } from '../src/webview';
import type { StorageLayout } from '../src/layout';
import {
  mkNewSessionTree,
  mkTempDir,
  rmTempDir,
  writeSession,
  type JsonlLineSpec,
  type TreeSpec,
} from './_helpers';

/**
 * 双源浏览与搜索的示例测试（Req 13.1、13.2、13.6、13.7，兼及 13.3、13.4、13.5、9.2–9.4、9.8）。
 *
 * 与 `search.dual.property.spec.ts` 的分工：合并去重与来源判定的**普遍性**
 * （Property 9、10）由属性测试在随机输入空间上锁定；本文件用**具体夹具把口径钉死**
 * ——哪种布局从哪一侧取数、双份留哪一份、截断到几条、过滤在两种格式上给出什么。
 *
 * 夹具一律落在**真实临时目录**：取数范围这件事就是「有没有去读那个目录」，用注入的
 * 内存源反而会把被测的东西（`boundsFor` 按布局选源）替换掉。因此每个用例都同时建出
 * 新旧两侧目录并各放会话，再靠 `layout` 一个字段区分——`new-only` 的用例里旧目录是
 * **存在且有会话**的，只有「按布局跳过它」才能让断言成立。
 *
 * 「过滤后为空」的提示不在 `search.ts` 的职责范围内：`SearchEngine` 只产出 `SearchHit[]`，
 * AttachmentFilter 与状态条文案都在 webview 侧（`src/webview/filter.ts` 的纯函数 +
 * `src/webview.ts` 内联脚本里的 `updateStatus`）。因此本文件把 Req 13.6 钉在
 * 「真实合并列表 × 真实过滤函数」上，把 Req 13.7 钉在「从 `getWebviewHtml` 产出的内联
 * 脚本里取出 `updateStatus` 源码并真的执行它」上——不复制一份文案常量到测试里对拍，
 * 那样只能证明测试自己前后一致。
 */

/** 工作区目录名（1.x 的 `<NewSessionsRoot>/<WsHash16>`；本文件不关心哈希算法本身） */
const WS = 'cc5023603866cd91';

/** 夹具时间基准；各会话的修改时间一律以它加偏移表达，便于断言排序 */
const BASE = Date.parse('2026-09-01T00:00:00.000Z');

/** 一段像真实内嵌图片的 data URL（两种格式的图片夹具共用同一份载荷） */
const DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH';

const tmpDirs: string[] = [];

afterEach(() => {
  // 四个模块级缓存都清掉：会话索引（旧/新）、迁移标记、用量。否则临时目录被复用的
  // 极端情况下用例之间会串扰。
  __clearIndexCacheForTest();
  __clearNewSessionCacheForTest();
  __clearMigrationMarkerCacheForTest();
  __clearCreditCacheForTest();
  __clearMessagesCreditCacheForTest();
  while (tmpDirs.length) rmTempDir(tmpDirs.pop()!);
});

/* ------------------------------------------------------------------ *
 * 夹具：一个临时目录里同时建出新旧两侧
 * ------------------------------------------------------------------ */

interface Roots {
  /** 1.x 的 `~/.kiro/sessions` 替身 */
  newRoot: string;
  /** `<newRoot>/<WS>`，即 NewWorkspaceSessionDir */
  newDir: string;
  /** 0.9x 的 `<workspace-sessions>/<EncodedKey>` 替身 */
  oldDir: string;
}

function freshRoots(): Roots {
  const tmp = mkTempDir('kcs-search-dual-');
  tmpDirs.push(tmp);
  const newRoot = path.join(tmp, 'home-kiro', 'sessions');
  const newDir = path.join(newRoot, WS);
  // 旧目录刻意保持 `<store>/workspace-sessions/<key>` 的层级：0.9x 源的 decorateHits 会
  // 从会话目录向上两级找存档根，层级不对会走进异常分支（结果不变，但夹具就不像真的了）
  const oldDir = path.join(tmp, 'kiroagent', 'workspace-sessions', 'ws-key');
  fs.mkdirSync(newDir, { recursive: true });
  fs.mkdirSync(oldDir, { recursive: true });
  return { newRoot, newDir, oldDir };
}

/** 两侧目录恒传入，只由 `layout` 决定实际取哪一侧（Req 13.1、13.2 的被测点） */
function dirsFor(roots: Roots, layout: StorageLayout): LayoutSessionDirs {
  return {
    layout,
    newWorkspaceSessionDir: roots.newDir,
    oldWorkspaceSessionDir: roots.oldDir,
  };
}

interface NewSpec {
  sessionId: string;
  title?: string;
  /** 修改时间，写入 `session.json` 的 `lastModifiedAt` */
  modifiedMs?: number;
  events?: JsonlLineSpec[];
  snapshots?: TreeSpec;
}

/** 在新侧建一个 1.x 目录型会话 */
function addNew(roots: Roots, spec: NewSpec): void {
  mkNewSessionTree(roots.newRoot, {
    wsHash16: WS,
    sessionId: spec.sessionId,
    session: {
      title: spec.title,
      lastModifiedAt: new Date(spec.modifiedMs ?? BASE).toISOString(),
    },
    events: spec.events ?? [{ payload: { type: 'user', content: 'hello from 1.x' } }],
    snapshots: spec.snapshots,
  });
}

interface OldSpec {
  sessionId: string;
  title?: string;
  /** 修改时间，落在 `<sessionId>.json` 的 mtime 上 */
  modifiedMs?: number;
  history?: unknown[];
}

/** 在旧侧建一个 0.9x 单文件会话 */
function addOld(roots: Roots, spec: OldSpec): void {
  writeSession(
    roots.oldDir,
    spec.sessionId,
    {
      title: spec.title,
      history: spec.history ?? [{ message: { role: 'user', content: 'hello from 0.9x' } }],
    },
    spec.modifiedMs ?? BASE
  );
}

const idsOf = (hits: readonly SearchHit[]): string[] => hits.map((h) => h.sessionId);

function filterHits(hits: SearchHit[], mode: AttachmentFilterMode): SearchHit[] {
  return applyAttachmentFilter(hits, mode) as SearchHit[];
}

/* ================================================================== *
 * 1. 取数范围（Req 13.1、13.2）
 * ================================================================== */

describe('双源取数范围 - 三种布局', () => {
  /** 三个用例共用同一份夹具：新侧一条、旧侧一条，两侧目录都存在且都有会话 */
  function bothSidesFilled(): Roots {
    const roots = freshRoots();
    addNew(roots, {
      sessionId: 'sess_alpha',
      title: 'ranged keyword on the new side',
      modifiedMs: BASE + 2000,
    });
    addOld(roots, {
      sessionId: 'legacy-uuid-1',
      title: 'ranged keyword on the old side',
      modifiedMs: BASE + 1000,
    });
    return roots;
  }

  it('new-only：只从 NewWorkspaceSessionDir 取数（旧目录有会话也不出现）', () => {
    const roots = bothSidesFilled();
    const dirs = dirsFor(roots, 'new-only');

    const recent = listRecentSessionsInLayout(dirs);
    expect(idsOf(recent)).toEqual(['sess_alpha']);
    expect(recent[0].layout).toBe('new');
    // 新目录里带 `sess_` 前缀且旧侧无同 id → 1.x 新建（Req 9.2）
    expect(recent[0].origin).toBe('new');

    const hits = searchSessionsInLayout(dirs, 'ranged keyword');
    expect(idsOf(hits)).toEqual(['sess_alpha']);
  });

  it('old-only：只从 OldWorkspaceSessionDir 取数（新目录有会话也不出现）', () => {
    const roots = bothSidesFilled();
    const dirs = dirsFor(roots, 'old-only');

    const recent = listRecentSessionsInLayout(dirs);
    expect(idsOf(recent)).toEqual(['legacy-uuid-1']);
    expect(recent[0].layout).toBe('old');
    // 只存在于旧目录、且没有迁移标记 → 未迁移（Req 9.4）
    expect(recent[0].origin).toBe('legacy-unmigrated');

    const hits = searchSessionsInLayout(dirs, 'ranged keyword');
    expect(idsOf(hits)).toEqual(['legacy-uuid-1']);
  });

  it('both：两侧合并出数，并按最后修改时间倒序（Req 13.4）', () => {
    const roots = freshRoots();
    addNew(roots, { sessionId: 'sess_new-old', title: 'merged keyword A', modifiedMs: BASE + 1000 });
    addOld(roots, { sessionId: 'legacy-mid', title: 'merged keyword B', modifiedMs: BASE + 2000 });
    addNew(roots, { sessionId: 'sess_newest', title: 'merged keyword C', modifiedMs: BASE + 3000 });
    const dirs = dirsFor(roots, 'both');

    const recent = listRecentSessionsInLayout(dirs);
    expect(idsOf(recent)).toEqual(['sess_newest', 'legacy-mid', 'sess_new-old']);
    expect(recent.map((h) => h.layout)).toEqual(['new', 'old', 'new']);
    expect(recent.map((h) => h.modified)).toEqual([BASE + 3000, BASE + 2000, BASE + 1000]);

    const hits = searchSessionsInLayout(dirs, 'merged keyword');
    expect(idsOf(hits)).toEqual(['sess_newest', 'legacy-mid', 'sess_new-old']);
  });
});

/* ================================================================== *
 * 2. 同 sessionId 去重（Req 13.3、9.8）
 * ================================================================== */

describe('双源去重 - 同 sessionId 双份', () => {
  /** 迁移后两侧各留一份：新侧内容较新，旧侧是残留 */
  function duplicated(): Roots {
    const roots = freshRoots();
    addNew(roots, {
      sessionId: 'dup-uuid',
      title: 'dup title from the new side',
      modifiedMs: BASE + 5000,
      events: [{ payload: { type: 'user', content: 'body written by 1.x' } }],
    });
    addOld(roots, {
      sessionId: 'dup-uuid',
      title: 'dup title from the old side',
      modifiedMs: BASE + 1000,
      history: [{ message: { role: 'user', content: 'body written by 0.9x' } }],
    });
    return roots;
  }

  it('列表里只出现一次，且取新格式那份（layout=new、origin=migrated）', () => {
    const dirs = dirsFor(duplicated(), 'both');

    const recent = listRecentSessionsInLayout(dirs);
    expect(idsOf(recent)).toEqual(['dup-uuid']);
    expect(recent[0].layout).toBe('new');
    expect(recent[0].origin).toBe('migrated');
    expect(recent[0].title).toBe('dup title from the new side');
    expect(recent[0].snippet).toBe('body written by 1.x');
    expect(recent[0].modified).toBe(BASE + 5000);
  });

  it('被丢弃的旧份连关键词匹配都不参与（去重发生在匹配之前）', () => {
    const dirs = dirsFor(duplicated(), 'both');

    // 只有旧份才含这些字样：它们既不该产出第二条，也不该产出任何一条
    expect(searchSessionsInLayout(dirs, 'from the old side')).toEqual([]);
    expect(searchSessionsInLayout(dirs, 'written by 0.9x')).toEqual([]);

    const hits = searchSessionsInLayout(dirs, 'dup title');
    expect(idsOf(hits)).toEqual(['dup-uuid']);
    expect(hits[0].layout).toBe('new');
    expect(hits[0].origin).toBe('migrated');
  });

  it('去重只作用于双份那一条，其余会话的来源取值不受影响', () => {
    const roots = duplicated();
    addNew(roots, { sessionId: 'sess_fresh', title: 'fresh one', modifiedMs: BASE + 6000 });
    addOld(roots, { sessionId: 'legacy-only', title: 'legacy one', modifiedMs: BASE + 2000 });

    const recent = listRecentSessionsInLayout(dirsFor(roots, 'both'));
    expect(idsOf(recent)).toEqual(['sess_fresh', 'dup-uuid', 'legacy-only']);
    expect(recent.map((h) => h.origin)).toEqual(['new', 'migrated', 'legacy-unmigrated']);
    expect(recent.map((h) => h.layout)).toEqual(['new', 'new', 'old']);
  });
});

/* ================================================================== *
 * 3. 排序与截断（Req 13.4）
 * ================================================================== */

describe('双源排序与 limit 截断', () => {
  /** 两侧各 12 条、修改时间交错（旧偶、新奇），故任何截断都必然横跨两种格式 */
  function interleaved(): Roots {
    const roots = freshRoots();
    for (let i = 0; i < 12; i++) {
      addOld(roots, {
        sessionId: `legacy-${i}`,
        title: `paged match old ${i}`,
        modifiedMs: BASE + 2 * i * 1000,
      });
      addNew(roots, {
        sessionId: `sess_new-${i}`,
        title: `paged match new ${i}`,
        modifiedMs: BASE + (2 * i + 1) * 1000,
      });
    }
    return roots;
  }

  it('搜索默认截断到 10 条，且截断在排序之后', () => {
    const dirs = dirsFor(interleaved(), 'both');
    const hits = searchSessionsInLayout(dirs, 'paged match');

    expect(hits).toHaveLength(10);
    // 24 条里最新的 10 条：sess_new-11 / legacy-11 / sess_new-10 / … / legacy-7
    expect(idsOf(hits)).toEqual([
      'sess_new-11',
      'legacy-11',
      'sess_new-10',
      'legacy-10',
      'sess_new-9',
      'legacy-9',
      'sess_new-8',
      'legacy-8',
      'sess_new-7',
      'legacy-7',
    ]);
    for (let i = 0; i < hits.length - 1; i++) {
      expect(hits[i].modified).toBeGreaterThan(hits[i + 1].modified);
    }
  });

  it('最近列表默认截断到 20 条，两种格式都在截断后的列表里', () => {
    const dirs = dirsFor(interleaved(), 'both');
    const recent = listRecentSessionsInLayout(dirs);

    expect(recent).toHaveLength(20);
    expect(recent[0].sessionId).toBe('sess_new-11');
    expect(recent[19].sessionId).toBe('legacy-2');
    expect(recent.filter((h) => h.layout === 'new')).toHaveLength(10);
    expect(recent.filter((h) => h.layout === 'old')).toHaveLength(10);
    for (let i = 0; i < recent.length - 1; i++) {
      expect(recent[i].modified).toBeGreaterThan(recent[i + 1].modified);
    }
  });

  it('显式 limit 同样在合并后的统一列表上生效', () => {
    const dirs = dirsFor(interleaved(), 'both');
    expect(idsOf(searchSessionsInLayout(dirs, 'paged match', 3))).toEqual([
      'sess_new-11',
      'legacy-11',
      'sess_new-10',
    ]);
    expect(idsOf(listRecentSessionsInLayout(dirs, 2))).toEqual(['sess_new-11', 'legacy-11']);
  });
});

/* ================================================================== *
 * 4. AttachmentFilter 在合并列表上的语义（Req 13.6）
 * ================================================================== */

/** 四种附件形态，两种格式各建一条，用于逐对比对过滤语义 */
const SHAPES = ['plain', 'image', 'attachment', 'both'] as const;
type Shape = (typeof SHAPES)[number];

/** 1.x：图片走 content 项的 `type: 'image'`，附件走 payload 的 `contextItems` */
function newEvents(shape: Shape): JsonlLineSpec[] {
  const withImage = shape === 'image' || shape === 'both';
  const withAttachment = shape === 'attachment' || shape === 'both';
  const payload: Record<string, unknown> = {
    type: 'user',
    content: withImage
      ? [{ type: 'text', text: `shaped ${shape}` }, { type: 'image', imageUrl: { url: DATA_URL } }]
      : `shaped ${shape}`,
  };
  if (withAttachment) {
    payload.contextItems = [{ id: '1', name: 'x.ts', uri: 'file:///x.ts' }];
  }
  return [{ payload: payload as { type: string } }];
}

/** 0.9x：图片走 content 项的 `type: 'imageUrl'`，附件走 history 项的 `contextItems` */
function oldHistory(shape: Shape): unknown[] {
  const withImage = shape === 'image' || shape === 'both';
  const withAttachment = shape === 'attachment' || shape === 'both';
  const item: Record<string, unknown> = {
    message: {
      role: 'user',
      content: withImage
        ? [
            { type: 'text', text: `shaped ${shape}` },
            { type: 'imageUrl', imageUrl: { url: DATA_URL } },
          ]
        : `shaped ${shape}`,
    },
  };
  if (withAttachment) {
    item.contextItems = [{ id: '1', name: 'x.cs', uri: 'file:///x.cs' }];
  }
  return [item];
}

describe('AttachmentFilter 在合并列表上的过滤语义', () => {
  /** 两种格式 × 四种形态 = 8 条，交错修改时间使新旧成对相邻 */
  function shaped(): LayoutSessionDirs {
    const roots = freshRoots();
    SHAPES.forEach((shape, i) => {
      addNew(roots, {
        sessionId: `sess_${shape}`,
        title: `shaped ${shape} new`,
        modifiedMs: BASE + (2 * i + 1) * 1000,
        events: newEvents(shape),
      });
      addOld(roots, {
        sessionId: `legacy-${shape}`,
        title: `shaped ${shape} old`,
        modifiedMs: BASE + 2 * i * 1000,
        history: oldHistory(shape),
      });
    });
    return dirsFor(roots, 'both');
  }

  it('同一形态的新旧会话得到相同的 hasImage / hasAttachment', () => {
    const merged = listRecentSessionsInLayout(shaped());
    expect(merged).toHaveLength(8);

    for (const shape of SHAPES) {
      const nu = merged.find((h) => h.sessionId === `sess_${shape}`)!;
      const old = merged.find((h) => h.sessionId === `legacy-${shape}`)!;
      expect({ hasImage: nu.hasImage, hasAttachment: nu.hasAttachment }).toEqual({
        hasImage: old.hasImage,
        hasAttachment: old.hasAttachment,
      });
    }

    // 顺带钉死四种形态各自的取值，避免"两侧一致地都错"
    const flagsOf = (id: string) => {
      const h = merged.find((x) => x.sessionId === id)!;
      return [h.hasImage, h.hasAttachment];
    };
    expect(flagsOf('sess_plain')).toEqual([false, false]);
    expect(flagsOf('sess_image')).toEqual([true, false]);
    expect(flagsOf('sess_attachment')).toEqual([false, true]);
    expect(flagsOf('sess_both')).toEqual([true, true]);
  });

  it("'image' / 'attachment' 各保留两种格式对应的那 4 条，'all' 原样保序", () => {
    const merged = listRecentSessionsInLayout(shaped());

    expect(idsOf(filterHits(merged, 'image')).sort()).toEqual(
      ['sess_image', 'sess_both', 'legacy-image', 'legacy-both'].sort()
    );
    expect(idsOf(filterHits(merged, 'attachment')).sort()).toEqual(
      ['sess_attachment', 'sess_both', 'legacy-attachment', 'legacy-both'].sort()
    );
    expect(filterHits(merged, 'all')).toEqual(merged);

    // 过滤是子序列：合并后的倒序排列在过滤后仍然成立
    const filtered = filterHits(merged, 'image');
    for (let i = 0; i < filtered.length - 1; i++) {
      expect(filtered[i].modified).toBeGreaterThan(filtered[i + 1].modified);
    }
  });

  it("搜索结果上叠加过滤：两种格式各保留含图的那条", () => {
    const dirs = shaped();
    const hits = searchSessionsInLayout(dirs, 'shaped');
    expect(hits).toHaveLength(8);
    expect(idsOf(filterHits(hits, 'image')).sort()).toEqual(
      ['sess_image', 'sess_both', 'legacy-image', 'legacy-both'].sort()
    );
  });

  it('1.x 特有的附件来源（snapshots 内有文件）同样被 attachment 过滤保留', () => {
    const roots = freshRoots();
    // 没有 contextItems，附件性完全来自 snapshots/ 里的文件（Req 3.7 的第二个条件）
    addNew(roots, {
      sessionId: 'sess_snap',
      title: 'snapshot only',
      modifiedMs: BASE + 2000,
      events: [{ payload: { type: 'user', content: 'no context items here' } }],
      snapshots: { 'h1/src/a.ts': 120 },
    });
    addOld(roots, { sessionId: 'legacy-plain', title: 'plain old', modifiedMs: BASE + 1000 });

    const merged = listRecentSessionsInLayout(dirsFor(roots, 'both'));
    expect(merged.find((h) => h.sessionId === 'sess_snap')!.hasAttachment).toBe(true);
    expect(idsOf(filterHits(merged, 'attachment'))).toEqual(['sess_snap']);
  });
});

/* ================================================================== *
 * 5. 过滤后为空时的提示（Req 13.7）
 * ================================================================== */

/**
 * 从 `getWebviewHtml` 产出的内联脚本里取出 `updateStatus` 的**真实源码**并执行它。
 *
 * 状态条文案不在 `search.ts` 里，而在 `src/webview.ts` 的内联脚本模板里（`updateStatus`
 * 是模板文本的一部分，不像 `applyAttachmentFilter` 那样是被 `toString()` 注入的导出函数，
 * 因此没法直接 import）。这里取源码 + `new Function` 把它读到的四个闭包变量
 * （`currentResults` / `filterMode` / `currentKeyword` / `setStatus`）变成形参，
 * 从而在测试里跑的是**线上那一份分支逻辑**，而不是抄一遍文案常量做对拍。
 */
const NONCE = 'kcs-search-dual-nonce';

function inlineScript(): string {
  const html = getWebviewHtml(
    { cspSource: 'vscode-webview://kcs' } as unknown as Parameters<typeof getWebviewHtml>[0],
    NONCE
  );
  const open = `<script nonce="${NONCE}">`;
  const i = html.indexOf(open);
  expect(i, '未找到带 nonce 的 script 开标签').toBeGreaterThanOrEqual(0);
  const j = html.indexOf('</script>', i + open.length);
  expect(j, '未找到 script 闭标签').toBeGreaterThan(i);
  return html.slice(i + open.length, j);
}

/** 按花括号配平截取一个具名函数声明的完整源码 */
function extractFunctionSource(script: string, name: string): string {
  const head = `function ${name}(`;
  const start = script.indexOf(head);
  expect(start, `未在内联脚本中找到 function ${name}`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = script.indexOf('{', start); i < script.length; i++) {
    if (script[i] === '{') depth++;
    else if (script[i] === '}' && --depth === 0) return script.slice(start, i + 1);
  }
  throw new Error(`function ${name} 的花括号不配平`);
}

interface StatusCall {
  text: string;
  isError: unknown;
  title: unknown;
}

function runUpdateStatus(state: {
  currentResults: readonly unknown[];
  filterMode: AttachmentFilterMode;
  currentKeyword: string;
}): StatusCall {
  const src = extractFunctionSource(inlineScript(), 'updateStatus');
  const fn = new Function(
    'currentResults',
    'filterMode',
    'currentKeyword',
    'setStatus',
    `${src}\nreturn updateStatus();`
  );
  let captured: StatusCall | undefined;
  fn(
    state.currentResults,
    state.filterMode,
    state.currentKeyword,
    (text: string, isError: unknown, title: unknown) => {
      captured = { text, isError, title };
    }
  );
  expect(captured, 'updateStatus 未调用 setStatus').toBeDefined();
  return captured!;
}

describe('过滤后为空时的状态提示', () => {
  /** 合并列表里两种格式各一条，且**都不含**图片：按 'image' 过滤必然为空 */
  function noImageAnywhere(): SearchHit[] {
    const roots = freshRoots();
    addNew(roots, {
      sessionId: 'sess_plain',
      title: 'plain new side',
      modifiedMs: BASE + 2000,
      events: [{ payload: { type: 'user', content: 'text only' } }],
    });
    addOld(roots, { sessionId: 'legacy-plain', title: 'plain old side', modifiedMs: BASE + 1000 });
    const merged = listRecentSessionsInLayout(dirsFor(roots, 'both'));
    expect(idsOf(merged)).toEqual(['sess_plain', 'legacy-plain']);
    expect(merged.every((h) => !h.hasImage)).toBe(true);
    return merged;
  }

  it('最近列表按图片过滤后为空 → 「没有符合条件的对话」（非错误态）', () => {
    const filtered = filterHits(noImageAnywhere(), 'image');
    expect(filtered).toEqual([]);

    const status = runUpdateStatus({
      currentResults: filtered,
      filterMode: 'image',
      currentKeyword: '',
    });
    expect(status.text).toBe('没有符合条件的对话');
    expect(status.isError).toBe(false);
  });

  it('关键词命中后再按附件过滤为空 → 同一句「没有符合条件的对话」', () => {
    const merged = noImageAnywhere();
    const hits = filterHits(merged, 'attachment');
    expect(hits).toEqual([]);

    const status = runUpdateStatus({
      currentResults: hits,
      filterMode: 'attachment',
      currentKeyword: 'plain',
    });
    expect(status.text).toBe('没有符合条件的对话');
    expect(status.isError).toBe(false);
  });

  it('过滤未生效时的空结果仍走各自既有文案（与过滤为空可区分）', () => {
    expect(
      runUpdateStatus({ currentResults: [], filterMode: 'all', currentKeyword: '' }).text
    ).toBe('当前项目还没有对话历史');
    expect(
      runUpdateStatus({ currentResults: [], filterMode: 'all', currentKeyword: 'nothing' }).text
    ).toBe('没有匹配的对话');
  });

  it('过滤后非空时给出「已按附件过滤」而不是空提示', () => {
    const roots = freshRoots();
    addNew(roots, {
      sessionId: 'sess_img',
      title: 'has image',
      modifiedMs: BASE + 1000,
      events: [{ payload: { type: 'user', content: [{ type: 'image', imageUrl: { url: DATA_URL } }] } }],
    });
    addOld(roots, { sessionId: 'legacy-plain', title: 'plain old side', modifiedMs: BASE + 500 });

    const filtered = filterHits(listRecentSessionsInLayout(dirsFor(roots, 'both')), 'image');
    expect(idsOf(filtered)).toEqual(['sess_img']);

    const status = runUpdateStatus({
      currentResults: filtered,
      filterMode: 'image',
      currentKeyword: '',
    });
    expect(status.text).toBe('最近 1 个对话（已按附件过滤）');
  });
});
