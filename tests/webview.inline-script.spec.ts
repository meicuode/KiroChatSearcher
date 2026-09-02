import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import * as fs from 'fs';
import * as ts from 'typescript';
import { getRankingHtml } from '../src/storage/ranking';
import { getWebviewHtml } from '../src/webview';

/**
 * 内联脚本启动守卫：把两个 webview 的**整段内联脚本**放进极简 DOM 替身里真正执行，
 * 断言（a）不抛异常、（b）启动握手消息 `{ type: 'ready' }` 已发出。
 *
 * ── 为什么需要这层守卫 ──────────────────────────────────────────────────────
 *
 * 两个 webview 都用 `fn.toString()` 把宿主侧纯函数的**源码**注入内联脚本。源码里出现
 * 什么标识符不由我们写的 TS 决定，而由 tsc 的 CommonJS 输出决定：
 *
 *   - 被 `export` 的 `const` → 引用被重写成 `exports.X`
 *   - 跨模块 `import` 的绑定 → 引用被重写成 `mod_1.X`
 *
 * webview 里既没有 `exports` 也没有 `mod_1`，注入的函数一执行就抛 ReferenceError。
 * 排行页真实踩过这个坑：`pageOf` 编译后引用 `exports.RANKING_PAGE_SIZE`，脚本在收尾的
 * `render()` 处抛错，紧跟其后的 `vscode.postMessage({ type: 'ready' })` 永远发不出去，
 * 宿主收不到 ready 就不会开始取数，页面永远停在骨架里那句静态的「统计中…」。
 * 既有 387 个测试全绿：它们只摘执行 `canInteract` / `canRefresh` / `syncControls`
 * 这三个写在模板里、不引用任何模块作用域符号的函数，恒碰不到 `exports`。
 *
 * ── 两类断言分别能抓住什么（顺序即从弱到强）────────────────────────────────
 *
 *   1. 「ESM 路径执行」：vitest 经 vite 把 TS 转成 **ESM**，ESM 下导出的 const 与导入
 *      绑定的引用都保持裸标识符，因此这一档**抓不到** `exports.` 这类重写问题。
 *      它的价值在于抓「脚本自身的运行时错误」：拼错的变量名、少绑的元素、TDZ、
 *      漏注入的函数等——即 DOM 替身跑得通与否这件事本身。
 *   2. 「CJS 路径执行 + 文本扫描」：用 tsc 的 CommonJS 输出（与 `npm run compile`
 *      产出的 `out/` 同一套编译选项）加载模块，再执行同一段脚本。**这一档才是真正
 *      复现线上失败的那一档**：编译期重写在此可见，坏代码会在这里抛
 *      `ReferenceError: exports is not defined`。随后的正则扫描是同一事实的静态版本，
 *      在抛错之外再给出可读的失败信息（指出泄漏的是 `exports.` 还是 `mod_1.`）。
 *
 * 走的是 `require.extensions['.ts']` + `ts.transpileModule` 现场转译，而不是读
 * `out/` 目录：测试不依赖构建产物是否新鲜，也不要求先跑 `npm run compile`。
 */

/* ------------------------------------------------------------------ *
 * CJS 加载：与 tsconfig.json 同一套编译选项现场转译 TS 源码
 * ------------------------------------------------------------------ */

const requireCjs = createRequire(import.meta.url);

let tsHookInstalled = false;

/** 安装 `.ts` 的 require 钩子（幂等）：转译选项与 tsconfig.json 逐项一致。 */
function installTsRequireHook(): void {
  if (tsHookInstalled) return;
  const extensions = requireCjs.extensions as Record<
    string,
    (module: NodeModule, filename: string) => void
  >;
  extensions['.ts'] = (module, filename) => {
    const source = fs.readFileSync(filename, 'utf8');
    const { outputText } = ts.transpileModule(source, {
      fileName: filename,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
    });
    (module as unknown as { _compile(code: string, filename: string): void })._compile(
      outputText,
      filename
    );
  };
  tsHookInstalled = true;
}

/** 以 CommonJS（= 线上 `out/` 的编译形态）加载相对本测试文件的 TS 模块。 */
function loadAsCommonJs<T>(relativePath: string): T {
  installTsRequireHook();
  return requireCjs(fileURLToPath(new URL(relativePath, import.meta.url))) as T;
}

/* ------------------------------------------------------------------ *
 * 极简 DOM 替身
 * ------------------------------------------------------------------ */

type AnyEl = Record<string, unknown>;

function makeClassList() {
  const set = new Set<string>();
  return {
    add: (c: string) => void set.add(c),
    remove: (c: string) => void set.delete(c),
    contains: (c: string) => set.has(c),
    toggle: (c: string, on?: boolean) => {
      const next = on === undefined ? !set.has(c) : !!on;
      if (next) set.add(c);
      else set.delete(c);
      return next;
    },
  };
}

/** 元素替身：只提供两段脚本实际触达的属性与方法。 */
function makeElement(tag: string): AnyEl {
  return {
    tagName: tag,
    value: '',
    textContent: '',
    innerHTML: '',
    title: '',
    className: '',
    disabled: false,
    style: {} as Record<string, string>,
    dataset: {} as Record<string, string>,
    children: { length: 0 },
    classList: makeClassList(),
    addEventListener: () => {},
    removeAttribute: () => {},
    setAttribute: () => {},
    appendChild: () => {},
    focus: () => {},
    select: () => {},
    querySelectorAll: () => [] as AnyEl[],
    querySelector: () => null,
    closest: () => null,
  };
}

function makeDocument() {
  const byId = new Map<string, AnyEl>();
  return {
    getElementById(id: string): AnyEl {
      let el = byId.get(id);
      if (!el) {
        el = makeElement('div');
        byId.set(id, el);
      }
      return el;
    },
    querySelector: (sel: string): AnyEl => makeElement(sel),
    querySelectorAll: (): AnyEl[] => [],
    createElement: (tag: string): AnyEl => makeElement(tag),
    addEventListener: () => {},
  };
}

/** 取 `<script nonce="...">` 与 `</script>` 之间的脚本原文（不含标签本身）。 */
function extractInlineScript(html: string, nonce: string): string {
  const open = `<script nonce="${nonce}">`;
  const i = html.indexOf(open);
  expect(i, '未找到带 nonce 的 script 开标签').toBeGreaterThanOrEqual(0);
  const j = html.indexOf('</script>', i + open.length);
  expect(j, '未找到 script 闭标签').toBeGreaterThan(i);
  return html.slice(i + open.length, j);
}

interface RunResult {
  script: string;
  posted: Array<{ type?: string }>;
}

/**
 * 在 DOM 替身里执行整段内联脚本。
 *
 * `new Function` 的形参把 `document` / `window` / `acquireVsCodeApi` / 定时器注入函数
 * 作用域——注入的函数源码里若还残留 `exports` / `mod_1` 这类自由变量，它们在这个作用域
 * （以及全局）都不存在，执行到那一行必抛 ReferenceError，正是我们要抓的失败。
 * 定时器换成不真正排程的替身：只为让脚本跑完，不给测试留下悬挂的异步回调。
 */
function runInlineScript(html: string, nonce: string): RunResult {
  const script = extractInlineScript(html, nonce);
  const posted: Array<{ type?: string }> = [];
  const api = {
    postMessage: (m: { type?: string }) => void posted.push(m),
    getState: () => undefined,
    setState: () => {},
  };
  const fn = new Function(
    'document',
    'window',
    'acquireVsCodeApi',
    'setTimeout',
    'clearTimeout',
    script
  );
  fn(
    makeDocument(),
    { addEventListener: () => {} },
    () => api,
    () => 0,
    () => {}
  );
  return { script, posted };
}

/** tsc CommonJS 输出会引入、而 webview 里根本不存在的两种自由变量。 */
const CJS_REWRITE_LEAKS: Array<{ re: RegExp; hint: string }> = [
  {
    re: /\bexports\s*\./,
    hint: '注入的函数体引用了被导出的 const（tsc 会重写成 exports.X）；改为引用模块内未导出的私有绑定，并把声明注入脚本',
  },
  {
    re: /\b[A-Za-z_$][\w$]*_\d+\s*\.\s*[A-Za-z_$]/,
    hint: '注入的函数体引用了跨模块导入的绑定（tsc 会重写成 mod_1.X）；改为别名导入 + 模块内同名局部 const',
  },
];

function expectNoCjsRewriteLeak(script: string, label: string): void {
  for (const { re, hint } of CJS_REWRITE_LEAKS) {
    const hit = re.exec(script);
    expect(hit, `${label} 的内联脚本出现 ${hit?.[0]}：${hint}`).toBeNull();
  }
}

/* ------------------------------------------------------------------ *
 * 1. ESM 路径（vitest 直接 import）：抓脚本自身的运行时错误
 * ------------------------------------------------------------------ */

const NONCE = 'kcs-inline-script-guard-nonce';

describe('内联脚本启动 - ESM 路径（抓脚本自身的运行时错误）', () => {
  it('排行页脚本执行不抛错，并发出 ready', () => {
    const { posted } = runInlineScript(getRankingHtml('vscode-webview://kcs', NONCE), NONCE);
    expect(posted).toContainEqual({ type: 'ready' });
  });

  it('搜索面板脚本执行不抛错，并发出 ready', () => {
    const html = getWebviewHtml(
      { cspSource: 'vscode-webview://kcs' } as unknown as Parameters<typeof getWebviewHtml>[0],
      NONCE
    );
    const { posted } = runInlineScript(html, NONCE);
    expect(posted).toContainEqual({ type: 'ready' });
  });
});

/* ------------------------------------------------------------------ *
 * 2. CJS 路径（= 线上 out/ 的编译形态）：抓 exports. / mod_1. 重写
 * ------------------------------------------------------------------ */

describe('内联脚本启动 - CJS 路径（抓 tsc 的 exports. / mod_1. 重写）', () => {
  it('排行页：CommonJS 编译形态下脚本仍能执行并发出 ready，且脚本文本无重写泄漏', () => {
    const mod = loadAsCommonJs<typeof import('../src/storage/ranking')>(
      '../src/storage/ranking.ts'
    );
    const { script, posted } = runInlineScript(mod.getRankingHtml('vscode-webview://kcs', NONCE), NONCE);
    expectNoCjsRewriteLeak(script, '排行页');
    expect(posted).toContainEqual({ type: 'ready' });
  });

  it('搜索面板：CommonJS 编译形态下脚本仍能执行并发出 ready，且脚本文本无重写泄漏', () => {
    const mod = loadAsCommonJs<typeof import('../src/webview')>('../src/webview.ts');
    const html = mod.getWebviewHtml(
      { cspSource: 'vscode-webview://kcs' } as unknown as Parameters<typeof getWebviewHtml>[0],
      NONCE
    );
    const { script, posted } = runInlineScript(html, NONCE);
    expectNoCjsRewriteLeak(script, '搜索面板');
    expect(posted).toContainEqual({ type: 'ready' });
  });
});
