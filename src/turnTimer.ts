import * as fs from 'fs';
import * as path from 'path';

/**
 * TurnTimerPatch：把「对话进行中实时显示本轮耗时」注入 Kiro 自带的对话面板。
 *
 * ── 为什么只能用打补丁的方式 ────────────────────────────────────────────────
 *
 * Kiro 的对话面板是 `kiro.kiro-agent` 扩展提供的 webview（视图 id
 * `kiroAgent.chatView` / `kiroAgent.standaloneChatView`），UI 是一个 Vite 打出来的
 * React 应用。VSCode 的扩展 API **没有**任何往别的扩展的 webview 里注入内容的口子，
 * 所以想改那个面板只有一条路：改它磁盘上的产物。
 *
 * 面板已经有一个 `PromptTurnFooter` 会渲染 "Elapsed time: 1m 23s"，但那是**轮结束
 * 之后**才出现（数据来自 `usage_summary.elapsedTime`）。AI 还在输出时没有任何耗时
 * 显示——补丁补的就是这段空窗。
 *
 * ── 补丁形态：一个新文件 + 每个入口追加一行 import ──────────────────────────
 *
 * 入口 `dist/<entry>/main.js` 是几百字节的 ESM loader。补丁在其**末尾**追加
 *
 *     import "../kcs-turn-timer.js"; /* kcs-turn-timer *\/
 *
 * 原文件其余字节一个都不动，且追加前先整份备份成 `main.js.kcs-orig`，因此还原是
 * 「拷回备份」这一个动作，不依赖任何字符串编辑的正确性。
 *
 * 三个「为什么这样安全」的事实（都在 Kiro 1.0.337 上核对过）：
 *
 * 1. **CSP 放行**：面板 HTML 的 `script-src` 是
 *    `<webview.cspSource> 'nonce-…' 'wasm-unsafe-eval'`。cspSource 覆盖整个 webview
 *    资源源，所以同目录下的 ESM import 无需 nonce——宿主 bundle 自己 import
 *    `../assets/*.js` 也是靠这一条。
 * 2. **不触发「安装似已损坏」**：`product.json` 的 `checksums` 只覆盖 6 个核心
 *    workbench 文件（workbench.desktop.main.js/.css、preload.js、
 *    extensionHostProcess.js、workbench.html、workbench.js），不含任何扩展 bundle。
 * 3. **可被 Kiro 升级抹掉，但可检测**：升级会整体替换 dist 目录，补丁随之消失。
 *    {@link detectTurnTimer} 因此是每次询问都真读磁盘，`activate()` 会在开关为「开」
 *    时重新补上（见 `extension.ts`）。
 *
 * ── 本模块的职责边界 ────────────────────────────────────────────────────────
 *
 * 只做「探测 / 打上 / 还原」三件事，且**不 import `vscode`**（连 `import type` 都不需要）：
 * 调用方把 `appRoot`（= `vscode.env.appRoot`）与随扩展分发的脚本资源路径传进来。
 * 因此本文件可以被 vitest 直接加载，全部文件系统调用经 {@link TurnTimerFsDeps} 注入，
 * 单元测试无需真的去改一个 Kiro 安装。
 */

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

/** 注入到 Kiro 对话面板 dist 目录下的脚本文件名。 */
export const TURN_TIMER_SCRIPT_FILENAME = 'kcs-turn-timer.js';

/**
 * 入口文件里用来识别「已打补丁」的哨兵，同时也是追加内容的一部分。
 *
 * 刻意带上扩展名字：万一 Kiro 自己或别的工具也往同一个文件追加东西，
 * 我们只认自己的标记，还原时也只摘自己的那一行。
 */
export const TURN_TIMER_MARKER = '/* kcs-turn-timer */';

/** 打补丁前对入口文件做的整份备份的后缀。 */
export const TURN_TIMER_BACKUP_SUFFIX = '.kcs-orig';

/**
 * 需要打补丁的入口。
 *
 * - `session-manager`：**侧边栏**的对话面板（`kiroAgent.chatView`，日常用得最多的那个）
 * - `session-view`：编辑器分栏里打开的单会话面板（`buildEditorPanel`）
 * - `standalone`：独立对话窗口（`kiroAgent.standaloneChatView`）
 *
 * 三个都要打。这一点很容易搞错：`AgentChatViewProvider` 的 `entryPoint` **默认值**是
 * `session-view`，但侧边栏那个 provider 是显式用 `entryPoint:"session-manager"` 构造的
 * （`extension.js` 里 `this.sidebarViewProvider=new iY({…,entryPoint:"session-manager",…})`）。
 * 只打 `session-view` 的话，编辑器分栏和独立窗口有效、而绝大多数人用的侧边栏毫无反应。
 *
 * 剩下的 `workflow-runs` 不渲染对话消息流，不需要处理。
 * 某个入口在当前 Kiro 版本里不存在时按「跳过」处理，不算失败。
 */
export const TURN_TIMER_ENTRIES: readonly string[] = [
  'session-manager',
  'session-view',
  'standalone',
];

/** 对话面板 dist 目录相对 `vscode.env.appRoot`（= `<KiroRoot>/resources/app`）的位置。 */
const CHAT_DIST_RELATIVE = [
  'extensions',
  'kiro.kiro-agent',
  'packages',
  'kiro-ui-agent-chat',
  'dist',
] as const;

/* ------------------------------------------------------------------ *
 * 类型
 * ------------------------------------------------------------------ */

/** {@link TurnTimerFsDeps.statSync} 返回值里本模块用到的最小形状。 */
export interface TurnTimerStat {
  mtimeMs: number;
}

/**
 * 可注入的文件系统依赖。缺省退回真实 `fs`。
 *
 * 与 `src/session/newFormat.ts` 的 `NewFormatFsDeps` 取舍不同：那边是 ReadOnlyPaths、
 * 只允许出现读 API；这里**必须**有写 API，因为打补丁本身就是写别人的安装目录。
 * 正因为如此，写调用被收在这一个接口里、且只有 {@link applyTurnTimer} /
 * {@link revertTurnTimer} 两个函数会用到它们——「哪些代码可能改 Kiro 安装」
 * 在模块依赖图上是可静态审查的，而不是注释里的承诺。
 */
export interface TurnTimerFsDeps {
  existsSync?: (p: string) => boolean;
  statSync?: (p: string) => TurnTimerStat;
  readFileSync?: (p: string, enc: 'utf8') => string;
  writeFileSync?: (p: string, data: string, enc: 'utf8') => void;
  unlinkSync?: (p: string) => void;
}

interface ResolvedFs {
  existsSync: (p: string) => boolean;
  statSync: (p: string) => TurnTimerStat;
  readFileSync: (p: string, enc: 'utf8') => string;
  writeFileSync: (p: string, data: string, enc: 'utf8') => void;
  unlinkSync: (p: string) => void;
}

function resolveFs(deps?: TurnTimerFsDeps): ResolvedFs {
  return {
    existsSync: deps?.existsSync ?? ((p) => fs.existsSync(p)),
    statSync: deps?.statSync ?? ((p) => fs.statSync(p)),
    readFileSync: deps?.readFileSync ?? ((p, enc) => fs.readFileSync(p, enc)),
    writeFileSync: deps?.writeFileSync ?? ((p, data, enc) => fs.writeFileSync(p, data, enc)),
    unlinkSync: deps?.unlinkSync ?? ((p) => fs.unlinkSync(p)),
  };
}

/**
 * 单个入口的补丁状态。
 *
 * `present === false`（该版本没有这个入口）与 `patched === false`（有但没打上）
 * 分开表达：前者是「不需要处理」，后者是「需要处理但还没处理」，
 * 汇总成整体状态时二者不能混为一谈。
 */
export interface TurnTimerEntryStatus {
  /** 入口名，取值来自 {@link TURN_TIMER_ENTRIES}。 */
  entry: string;
  /** `dist/<entry>/main.js` 是否存在。 */
  present: boolean;
  /** 入口文件里是否含 {@link TURN_TIMER_MARKER}。 */
  patched: boolean;
  /** `main.js.kcs-orig` 备份是否存在（还原能否走「拷回备份」这条稳妥路径）。 */
  backedUp: boolean;
}

/**
 * 补丁的五种状态。**刻意区分「文件已改」与「本窗口已加载」**——
 * 这是「设置了但没生效」这个用户困惑的唯一来源：webview 只在创建时读一次 main.js，
 * 打完补丁必须重载窗口才会真正跑起来。
 */
export type TurnTimerState =
  /** 找不到对话面板 dist：不在 Kiro 里运行，或 Kiro 版本换了目录布局。 */
  | 'unavailable'
  /** 一个入口都没打上补丁。 */
  | 'off'
  /** 部分入口打上了，或注入脚本缺失 / 与扩展内置版本不一致。 */
  | 'partial'
  /** 文件全部就位，但补丁是在本窗口启动**之后**打的 → 需重载窗口才生效。 */
  | 'pending-reload'
  /** 文件全部就位，且在本窗口启动前就打好了 → 本窗口正在跑。 */
  | 'on';

/** 一次探测的完整结果（设置页据此渲染，不做二次判断）。 */
export interface TurnTimerStatus {
  state: TurnTimerState;
  /** 对话面板 dist 绝对路径；`unavailable` 时为 `null`。 */
  distDir: string | null;
  /** dist 下的注入脚本是否存在。 */
  scriptInstalled: boolean;
  /** 已安装的注入脚本内容是否与扩展内置的那份一致（扩展升级后可能落后）。 */
  scriptUpToDate: boolean;
  /** 各入口逐项状态（供设置页展开技术细节）。 */
  entries: TurnTimerEntryStatus[];
  /** 补丁写入时刻（epoch ms）= 已安装脚本的 mtime；拿不到时为 `null`。 */
  appliedAt: number | null;
  /** 本窗口扩展宿主的启动时刻（epoch ms）；未提供时 `pending-reload` 无从判断。 */
  hostStartedAt: number | null;
  /** `unavailable` / `partial` 的原因，直接给用户看。 */
  detail: string;
}

/** {@link detectTurnTimer} / {@link applyTurnTimer} / {@link revertTurnTimer} 的公共入参。 */
export interface TurnTimerOptions {
  /** `vscode.env.appRoot`，即 `<KiroRoot>/resources/app`。 */
  appRoot: string;
  /** 随扩展分发的注入脚本绝对路径（`<extension>/media/kcs-turn-timer.js`）。 */
  assetPath: string;
  /**
   * 本窗口扩展宿主的启动时刻（epoch ms）。
   * 生产侧用 {@link hostStartedAt} 估算；不传则不判 `pending-reload`。
   */
  hostStartedAt?: number;
  fsDeps?: TurnTimerFsDeps;
}

/** 打补丁 / 还原的结果。 */
export interface TurnTimerActionResult {
  /** 是否全部成功。失败时 `error` 必有值，且 `status` 仍是**动作后**的真实状态。 */
  ok: boolean;
  /** 本次是否真的改动了磁盘（幂等重跑时为 `false`）。 */
  changed: boolean;
  /** 失败原因（权限不足、目录不存在等），直接给用户看。 */
  error?: string;
  status: TurnTimerStatus;
}

/* ------------------------------------------------------------------ *
 * 路径与时刻
 * ------------------------------------------------------------------ */

/**
 * 由 `appRoot` 推出对话面板 dist 目录。纯路径拼接，不判断存在性。
 */
export function chatUiDistDir(appRoot: string): string {
  return path.join(appRoot, ...CHAT_DIST_RELATIVE);
}

/**
 * 估算本窗口扩展宿主的启动时刻。
 *
 * 用 `process.uptime()` 反推而不是在 `activate()` 里记一个时间戳：`activate()` 可能
 * 被「视图首次展开」这类事件推迟很久才触发，那时记下的时刻会晚于 webview 的创建时刻，
 * 于是「补丁在窗口启动后打的」这个判断会假阳性。宿主进程的 uptime 与 webview
 * 的生命周期同源，是更贴近事实的参照点。
 */
export function hostStartedAt(now: number = Date.now(), uptimeSeconds?: number): number {
  const uptime = uptimeSeconds ?? process.uptime();
  const started = now - uptime * 1000;
  return Number.isFinite(started) ? started : now;
}

function entryMainPath(distDir: string, entry: string): string {
  return path.join(distDir, entry, 'main.js');
}

/* ------------------------------------------------------------------ *
 * 探测
 * ------------------------------------------------------------------ */

/**
 * 读一遍磁盘，得出当前补丁状态。**只读，不写**。
 *
 * 每次询问都真读文件而不缓存：Kiro 可能在两次询问之间升级并抹掉补丁，
 * 缓存下来的「已生效」会变成谎言，而这个函数恰恰是用户判断「设置到底生效没有」
 * 的唯一依据。代价是几次 `existsSync` + 两个小文件的 `readFileSync`，可忽略。
 *
 * 任何文件系统异常都收敛成状态而不抛：设置页必须永远能打开并说明情况。
 */
export function detectTurnTimer(opts: TurnTimerOptions): TurnTimerStatus {
  const d = resolveFs(opts.fsDeps);
  const distDir = chatUiDistDir(opts.appRoot);
  const hostStart = opts.hostStartedAt ?? null;

  const base: TurnTimerStatus = {
    state: 'unavailable',
    distDir: null,
    scriptInstalled: false,
    scriptUpToDate: false,
    entries: [],
    appliedAt: null,
    hostStartedAt: hostStart,
    detail: '',
  };

  let distExists = false;
  try {
    distExists = d.existsSync(distDir);
  } catch {
    distExists = false;
  }
  if (!distExists) {
    return {
      ...base,
      detail:
        '找不到 Kiro 对话面板目录，无法注入。可能不是在 Kiro 里运行，' +
        '或这个 Kiro 版本换了目录布局（补丁需要重新适配）。',
    };
  }

  const scriptPath = path.join(distDir, TURN_TIMER_SCRIPT_FILENAME);
  const scriptInstalled = safeExists(d, scriptPath);
  const installedSource = scriptInstalled ? safeRead(d, scriptPath) : null;
  const assetSource = safeRead(d, opts.assetPath);
  // 资源读不出来时不敢断言「已过期」：那会把一个本可用的补丁标成 partial，
  // 促使用户去点重试，而重试同样读不到资源、必然失败。
  const scriptUpToDate =
    installedSource !== null && (assetSource === null || installedSource === assetSource);

  const entries: TurnTimerEntryStatus[] = TURN_TIMER_ENTRIES.map((entry) => {
    const main = entryMainPath(distDir, entry);
    const present = safeExists(d, main);
    const source = present ? safeRead(d, main) : null;
    return {
      entry,
      present,
      patched: source !== null && source.includes(TURN_TIMER_MARKER),
      backedUp: safeExists(d, main + TURN_TIMER_BACKUP_SUFFIX),
    };
  });

  const existing = entries.filter((e) => e.present);
  const patched = existing.filter((e) => e.patched);

  let appliedAt: number | null = null;
  if (scriptInstalled) {
    try {
      const st = d.statSync(scriptPath);
      if (typeof st?.mtimeMs === 'number' && Number.isFinite(st.mtimeMs)) appliedAt = st.mtimeMs;
    } catch {
      appliedAt = null;
    }
  }

  const common = { ...base, distDir, scriptInstalled, scriptUpToDate, entries, appliedAt };

  if (existing.length === 0) {
    return {
      ...common,
      state: 'unavailable',
      detail:
        '对话面板目录存在，但找不到任何可注入的入口文件（' +
        TURN_TIMER_ENTRIES.join(' / ') +
        '）。这个 Kiro 版本的产物结构变了，补丁需要重新适配。',
    };
  }

  if (patched.length === 0) {
    return { ...common, state: 'off', detail: '' };
  }

  if (patched.length < existing.length) {
    const missing = existing.filter((e) => !e.patched).map((e) => e.entry);
    return {
      ...common,
      state: 'partial',
      detail: `以下入口尚未注入：${missing.join('、')}。点「重试注入」补齐。`,
    };
  }

  if (!scriptInstalled) {
    return {
      ...common,
      state: 'partial',
      detail: '入口已注入，但注入脚本文件不在了（可能被清理工具删掉）。点「重试注入」修复。',
    };
  }

  if (!scriptUpToDate) {
    return {
      ...common,
      state: 'partial',
      detail: '已注入的脚本与当前扩展内置的版本不一致（扩展升级后需要重新覆盖）。点「重试注入」更新。',
    };
  }

  // 文件全部就位。剩下唯一的问题是「本窗口的 webview 加载的是补丁前还是补丁后的
  // main.js」——webview 只在创建时读一次，所以补丁晚于宿主启动就意味着还没生效。
  if (hostStart !== null && appliedAt !== null && appliedAt > hostStart) {
    return {
      ...common,
      state: 'pending-reload',
      detail: '补丁已写入，但本窗口的对话面板还是补丁前加载的。重载窗口后生效。',
    };
  }

  return { ...common, state: 'on', detail: '' };
}

function safeExists(d: ResolvedFs, p: string): boolean {
  try {
    return d.existsSync(p);
  } catch {
    return false;
  }
}

function safeRead(d: ResolvedFs, p: string): string | null {
  try {
    return d.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 打补丁
 * ------------------------------------------------------------------ */

/**
 * 打上（或补齐 / 更新）补丁。**幂等**：已完整打好时不写任何文件，`changed` 为 `false`。
 *
 * 写入顺序刻意是「先脚本、后入口」：入口里的 import 一旦生效就会去找那个脚本，
 * 反序会留下一个短暂窗口，此时面板加载会因找不到模块而在控制台报错。
 *
 * 单个入口失败（只读、被占用）不中断其余入口：把错误收集起来一起报，
 * 状态里如实体现为 `partial`，用户点「重试注入」重跑即可——而不是一失败就整体回滚，
 * 那反而会把已经好了的入口也弄坏。
 */
export function applyTurnTimer(opts: TurnTimerOptions): TurnTimerActionResult {
  const d = resolveFs(opts.fsDeps);
  const distDir = chatUiDistDir(opts.appRoot);

  if (!safeExists(d, distDir)) {
    const status = detectTurnTimer(opts);
    return { ok: false, changed: false, error: status.detail, status };
  }

  const assetSource = safeRead(d, opts.assetPath);
  if (assetSource === null) {
    const status = detectTurnTimer(opts);
    return {
      ok: false,
      changed: false,
      error: `读不到扩展内置的注入脚本：${opts.assetPath}`,
      status,
    };
  }

  const errors: string[] = [];
  let changed = false;

  // 1) 脚本：内容不同才写，避免每次 activate 都刷新 mtime——mtime 是
  //    `pending-reload` 的判据，无谓刷新会让已生效的补丁被误报成「需重载」。
  const scriptPath = path.join(distDir, TURN_TIMER_SCRIPT_FILENAME);
  const installed = safeRead(d, scriptPath);
  if (installed !== assetSource) {
    try {
      d.writeFileSync(scriptPath, assetSource, 'utf8');
      changed = true;
    } catch (e: unknown) {
      errors.push(`写入 ${TURN_TIMER_SCRIPT_FILENAME} 失败：${messageOf(e)}`);
    }
  }

  // 2) 各入口：备份 → 追加 import
  for (const entry of TURN_TIMER_ENTRIES) {
    const main = entryMainPath(distDir, entry);
    if (!safeExists(d, main)) continue; // 该版本没有这个入口，跳过不算失败

    const source = safeRead(d, main);
    if (source === null) {
      errors.push(`读不到入口文件 ${entry}/main.js`);
      continue;
    }
    if (source.includes(TURN_TIMER_MARKER)) continue; // 已打过

    const backup = main + TURN_TIMER_BACKUP_SUFFIX;
    if (!safeExists(d, backup)) {
      try {
        d.writeFileSync(backup, source, 'utf8');
      } catch (e: unknown) {
        // 备份失败就不动原文件：宁可不生效，也不留一个改了却无法稳妥还原的入口
        errors.push(`备份 ${entry}/main.js 失败，已跳过该入口：${messageOf(e)}`);
        continue;
      }
    }

    try {
      d.writeFileSync(main, source + injectionLine(source), 'utf8');
      changed = true;
    } catch (e: unknown) {
      errors.push(`注入 ${entry}/main.js 失败：${messageOf(e)}`);
    }
  }

  const status = detectTurnTimer(opts);
  if (errors.length > 0) {
    return { ok: false, changed, error: errors.join('\n'), status };
  }
  return { ok: true, changed, status };
}

/**
 * 追加到入口文件末尾的内容。
 *
 * 只在原文件**没有**以换行结尾时才补一个换行，绝不无条件加前置 `\n`——否则会多出一个
 * 空行，而 {@link stripInjection} 只丢弃含标记的整行，那个空行会留下来，
 * 使兜底还原不再字节精确。`import` 声明会被提升，写在末尾不影响它先于宿主 bundle
 * 的模块体求值。
 */
function injectionLine(source: string): string {
  const prefix = source.endsWith('\n') || source === '' ? '' : '\n';
  return `${prefix}import "../${TURN_TIMER_SCRIPT_FILENAME}"; ${TURN_TIMER_MARKER}\n`;
}

/* ------------------------------------------------------------------ *
 * 还原
 * ------------------------------------------------------------------ */

/**
 * 还原补丁。**幂等**：本来就没打过时不写任何文件。
 *
 * 优先「拷回备份」——那是字节级的原样恢复，不依赖任何字符串编辑的正确性。
 * 备份丢了（用户手工删过、或 Kiro 升级只留下我们的注入行）才退化成按标记摘行，
 * 且只摘含 {@link TURN_TIMER_MARKER} 的行，不碰其余内容。
 */
export function revertTurnTimer(opts: TurnTimerOptions): TurnTimerActionResult {
  const d = resolveFs(opts.fsDeps);
  const distDir = chatUiDistDir(opts.appRoot);

  if (!safeExists(d, distDir)) {
    const status = detectTurnTimer(opts);
    return { ok: false, changed: false, error: status.detail, status };
  }

  const errors: string[] = [];
  let changed = false;

  for (const entry of TURN_TIMER_ENTRIES) {
    const main = entryMainPath(distDir, entry);
    if (!safeExists(d, main)) continue;

    const backup = main + TURN_TIMER_BACKUP_SUFFIX;
    const backupSource = safeExists(d, backup) ? safeRead(d, backup) : null;

    if (backupSource !== null) {
      try {
        d.writeFileSync(main, backupSource, 'utf8');
        changed = true;
      } catch (e: unknown) {
        errors.push(`还原 ${entry}/main.js 失败：${messageOf(e)}`);
        continue;
      }
      try {
        d.unlinkSync(backup);
      } catch {
        // 备份删不掉无伤大雅：入口已是原样，下次打补丁会复用这份备份
      }
      continue;
    }

    const source = safeRead(d, main);
    if (source === null || !source.includes(TURN_TIMER_MARKER)) continue;
    const stripped = stripInjection(source);
    try {
      d.writeFileSync(main, stripped, 'utf8');
      changed = true;
    } catch (e: unknown) {
      errors.push(`清除 ${entry}/main.js 的注入行失败：${messageOf(e)}`);
    }
  }

  const scriptPath = path.join(distDir, TURN_TIMER_SCRIPT_FILENAME);
  if (safeExists(d, scriptPath)) {
    try {
      d.unlinkSync(scriptPath);
      changed = true;
    } catch (e: unknown) {
      errors.push(`删除 ${TURN_TIMER_SCRIPT_FILENAME} 失败：${messageOf(e)}`);
    }
  }

  const status = detectTurnTimer(opts);
  if (errors.length > 0) {
    return { ok: false, changed, error: errors.join('\n'), status };
  }
  return { ok: true, changed, status };
}

/**
 * 纯函数：按行摘掉含标记的注入行（**备份缺失时**的兜底还原）。
 *
 * 保留原文件的行尾风格：按 `\r\n` 切分再原样拼回会改写混用换行的文件，
 * 所以用 `(?<=\n)` 只在换行**之后**切，行尾字符随行保留，只丢弃命中标记的整行。
 *
 * 精确度：配合 {@link injectionLine} 的条件换行，对「原文以换行结尾」的文件
 * （Kiro 的两个入口都是）还原是**字节精确**的；对原本不以换行结尾的文件会多留一个
 * 结尾换行。首选的还原路径始终是拷回 `.kcs-orig` 备份，那条路径无条件字节精确。
 */
export function stripInjection(source: string): string {
  return source
    .split(/(?<=\n)/)
    .filter((line) => !line.includes(TURN_TIMER_MARKER))
    .join('');
}

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  const m = (e as { message?: unknown } | null | undefined)?.message;
  return typeof m === 'string' ? m : String(e);
}
