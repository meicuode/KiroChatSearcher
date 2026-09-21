import * as fs from 'fs';
import * as path from 'path';

/**
 * TurnTimerPatch：把「对话进行中实时显示本轮耗时」注入 Kiro 自带的对话面板。
 *
 * ── 为什么只能用打补丁的方式 ────────────────────────────────────────────────
 *
 * Kiro 的对话面板是 `kiro.kiro-agent` 扩展提供的 webview，UI 是一个 Vite 打出来的
 * React 应用。VSCode 的扩展 API **没有**任何往别的扩展的 webview 里注入内容的口子，
 * 所以想改那个面板只有一条路：改它磁盘上的产物。
 *
 * 面板已经有一个 `PromptTurnFooter` 会渲染 "Elapsed time: 1m 23s"，但那是**轮结束
 * 之后**才出现（数据来自 `usage_summary.elapsedTime`）。AI 还在输出时没有任何耗时
 * 显示——补丁补的就是这段空窗。
 *
 * ── 补丁形态：一个新文件 + 每个入口追加一行 import ──────────────────────────
 *
 * 入口是 `<某个 dist>/<entry>/main.js`。补丁在其**末尾**追加
 *
 *     import "../kcs-turn-timer.js"; /* kcs-turn-timer *\/
 *
 * 原文件其余字节一个都不动，且追加前先整份备份成 `main.js.kcs-orig`，因此还原是
 * 「拷回备份」这一个动作，不依赖任何字符串编辑的正确性。
 *
 * 三个「为什么这样安全」的事实（在 Kiro 1.0.337 与 1.1.14 上都核对过）：
 *
 * 1. **CSP 放行**：面板 HTML 的 `script-src` 是
 *    `<webview.cspSource> 'nonce-…' 'wasm-unsafe-eval'`。cspSource 覆盖整个 webview
 *    资源源，所以同目录下的 ESM import 无需 nonce——宿主 bundle 自己 import
 *    `../assets/*.js` 也是靠这一条。
 * 2. **不触发「安装似已损坏」**：`product.json` 的 `checksums` 只覆盖 6 个核心
 *    workbench 文件，不含任何扩展 bundle。
 * 3. **可被 Kiro 升级抹掉，但可检测**：升级会整体替换 dist 目录，补丁随之消失。
 *    {@link detectTurnTimer} 因此是每次询问都真读磁盘，`activate()` 会在开关为「开」
 *    时重新补上（见 `extension.ts`）。
 *
 * ── 为什么入口清单必须动态发现，而不能写死 ──────────────────────────────────
 *
 * 这里踩过一次真实的坑，值得原地记下来。
 *
 * 早先的实现把目标写死成「`packages/kiro-ui-agent-chat/dist` 下的
 * `session-manager` / `session-view` / `standalone` 三个入口」。Kiro 1.1.14 新增了一个包
 * `kiro-ui-session-details`，并把侧边栏与编辑器分栏的对话面板搬了过去：
 *
 * ```js
 * Q8 = ["packages","kiro-ui-agent-chat","dist"]        // 旧
 * z8 = ["packages","kiro-ui-session-details","dist"]   // 新
 * function bundleFor(t) {
 *   let e = t === "session-surface" || t === "session-manager-surface",
 *       r = e ? z8 : Q8;                                // ← 换包
 *   return { buildOutput: { module: true, scriptPath: path.join(...r, t, "main.js"), … } };
 * }
 * ```
 *
 * 于是旧包那三个入口**依然被我们打得好好的**，探测也如实报告「已生效」——但用户日常
 * 用的面板根本不加载那个包，功能实际完全失效。**状态说了真话，却是废话**：它只认自己
 * 知道的那一个目录，Kiro 换了地方它就会自信地报告一切正常。这比直接报错更糟，因为它
 * 剥夺了用户发现问题的机会。
 *
 * 所以现在：入口名从 **Kiro 自己的 bundle** 里认（`entryPoint:"…"` 这类字面量），
 * 再用**文件系统确认**它落在哪个 dist 下（见 {@link surveyTurnTimerTargets}）。
 * 既不假设包名、也不假设 `packages/<pkg>/dist` 这个层级结构——只假设「入口是某个目录下
 * 的 `main.js`，而注入脚本放在它的上一级」，而这正是 `import "../kcs-turn-timer.js"`
 * 这个相对路径本身的含义。认不出入口清单时退回内置清单，并在状态里**明确说明已降级**，
 * 而不是假装一切正常。
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

/** 注入到对话面板 dist 目录下的脚本文件名。 */
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

/** 入口文件名。 */
export const TURN_TIMER_ENTRY_FILENAME = 'main.js';

/** Kiro agent 扩展目录相对 `vscode.env.appRoot` 的位置。 */
const AGENT_EXT_RELATIVE = ['extensions', 'kiro.kiro-agent'] as const;

/** Kiro agent 扩展自己的 bundle（入口清单从这里认）。 */
const AGENT_BUNDLE_RELATIVE = ['dist', 'extension.js'] as const;

/**
 * 认不出入口清单时的退路。
 *
 * 只是兜底，不是权威：它的存在只为了「解析失败也别直接歸零」，
 * 走到这条路时状态里会明确标注已降级（见 {@link TurnTimerSurvey.source}）。
 *
 * - `session-manager` / `session-view` / `standalone`：Kiro 1.0.x 的三个入口
 * - `session-manager-surface` / `session-surface`：1.1.x 起侧边栏与编辑器分栏用的
 */
const FALLBACK_ENTRIES: readonly string[] = [
  'session-manager',
  'session-view',
  'standalone',
  'session-manager-surface',
  'session-surface',
];

/** 目录索引不往这些目录里走（体积大且不可能放入口）。 */
const INDEX_SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'assets',
  '.bin',
  'snapshots',
]);

/** 目录索引的最大深度（agent 扩展根 → packages → 包 → dist → 入口 = 4）。 */
const INDEX_MAX_DEPTH = 5;

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
  /** 列目录；传入的是文件或不可读时应抛异常（本模块据此判断「不是目录」）。 */
  readdirSync?: (p: string) => string[];
  readFileSync?: (p: string, enc: 'utf8') => string;
  writeFileSync?: (p: string, data: string, enc: 'utf8') => void;
  unlinkSync?: (p: string) => void;
}

interface ResolvedFs {
  existsSync: (p: string) => boolean;
  statSync: (p: string) => TurnTimerStat;
  readdirSync: (p: string) => string[];
  readFileSync: (p: string, enc: 'utf8') => string;
  writeFileSync: (p: string, data: string, enc: 'utf8') => void;
  unlinkSync: (p: string) => void;
}

function resolveFs(deps?: TurnTimerFsDeps): ResolvedFs {
  return {
    existsSync: deps?.existsSync ?? ((p) => fs.existsSync(p)),
    statSync: deps?.statSync ?? ((p) => fs.statSync(p)),
    readdirSync: deps?.readdirSync ?? ((p) => fs.readdirSync(p)),
    readFileSync: deps?.readFileSync ?? ((p, enc) => fs.readFileSync(p, enc)),
    writeFileSync: deps?.writeFileSync ?? ((p, data, enc) => fs.writeFileSync(p, data, enc)),
    unlinkSync: deps?.unlinkSync ?? ((p) => fs.unlinkSync(p)),
  };
}

/**
 * 一个待注入的产物包：一个 dist 目录 + 该目录下需要注入的入口。
 *
 * 一个 Kiro 版本可能同时有多个（1.1.14 就是两个：旧包给独立窗口用，新包给侧边栏与
 * 编辑器分栏用），每个 dist 都要单独放一份注入脚本——因为 import 是相对路径。
 */
export interface TurnTimerBundle {
  /** 展示用标签：dist 相对 agent 扩展根的路径，如 `packages/kiro-ui-agent-chat/dist`。 */
  label: string;
  /** dist 绝对路径（注入脚本就放这里）。 */
  distDir: string;
  /** 该 dist 下需要注入的入口名。 */
  entries: string[];
}

/** 入口发现的结果。 */
export interface TurnTimerSurvey {
  /** `kiro` = 从 Kiro 的 bundle 里认出来的；`fallback` = 认不出、退回内置清单。 */
  source: 'kiro' | 'fallback';
  /** 降级原因（`source === 'fallback'` 时有值）。 */
  reason?: string;
  /** 认出的入口名（去重排序）。 */
  discovered: string[];
  /** 定位到磁盘的包 + 入口。 */
  bundles: TurnTimerBundle[];
  /**
   * 认出来了、但磁盘上找不到对应 `<dir>/main.js` 的入口名。
   *
   * **只作诊断，不参与状态判定**：入口名是用宽松正则从 minified 代码里捞的，
   * 必然混进一些根本不是入口的字符串，拿它报警会变成天天误报。
   */
  unlocated: string[];
}

/**
 * 单个入口的补丁状态。
 *
 * `present === false`（该版本没有这个入口）与 `patched === false`（有但没打上）
 * 分开表达：前者是「不需要处理」，后者是「需要处理但还没处理」，
 * 汇总成整体状态时二者不能混为一谈。
 */
export interface TurnTimerEntryStatus {
  /** 入口名。 */
  entry: string;
  /** `<dist>/<entry>/main.js` 是否存在。 */
  present: boolean;
  /** 入口文件里是否含 {@link TURN_TIMER_MARKER}。 */
  patched: boolean;
  /** `main.js.kcs-orig` 备份是否存在（还原能否走「拷回备份」这条稳妥路径）。 */
  backedUp: boolean;
}

/** 单个产物包的补丁状态。 */
export interface TurnTimerBundleStatus {
  label: string;
  distDir: string;
  /** 该 dist 下的注入脚本是否存在。 */
  scriptInstalled: boolean;
  /** 该 dist 下已安装的脚本是否与扩展内置的那份一致。 */
  scriptUpToDate: boolean;
  /** 该 dist 下注入脚本的 mtime；拿不到时为 `null`。 */
  appliedAt: number | null;
  entries: TurnTimerEntryStatus[];
}

/**
 * 补丁的五种状态。**刻意区分「文件已改」与「本窗口已加载」**——
 * 这是「设置了但没生效」这个用户困惑的唯一来源：webview 只在创建时读一次 main.js，
 * 打完补丁必须重载窗口才会真正跑起来。
 */
export type TurnTimerState =
  /** 一个可注入的入口都没找到：不在 Kiro 里运行，或产物结构变了。 */
  | 'unavailable'
  /** 一个入口都没打上补丁。 */
  | 'off'
  /** 部分入口打上了，或注入脚本缺失 / 与扩展内置版本不一致，或入口清单已降级。 */
  | 'partial'
  /** 文件全部就位，但补丁是在本窗口启动**之后**打的 → 需重载窗口才生效。 */
  | 'pending-reload'
  /** 文件全部就位，且在本窗口启动前就打好了 → 本窗口正在跑。 */
  | 'on';

/** 一次探测的完整结果（设置页据此渲染，不做二次判断）。 */
export interface TurnTimerStatus {
  state: TurnTimerState;
  /** 逐包状态（供设置页展开技术细节）。 */
  bundles: TurnTimerBundleStatus[];
  /** **所有**包的注入脚本都就位。 */
  scriptInstalled: boolean;
  /** **所有**已安装的注入脚本都与扩展内置版本一致。 */
  scriptUpToDate: boolean;
  /** 各包注入脚本 mtime 的最大值（= 最后一次写补丁的时刻）；拿不到时 `null`。 */
  appliedAt: number | null;
  /** 本窗口扩展宿主的启动时刻（epoch ms）；未提供时 `pending-reload` 无从判断。 */
  hostStartedAt: number | null;
  /** 入口发现的结果（含是否降级）。 */
  survey: TurnTimerSurvey;
  /** 非 `on` 状态的原因，直接给用户看。 */
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

/** 由 `appRoot` 推出 Kiro agent 扩展目录。纯路径拼接，不判断存在性。 */
export function agentExtensionDir(appRoot: string): string {
  return path.join(appRoot, ...AGENT_EXT_RELATIVE);
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
  return path.join(distDir, entry, TURN_TIMER_ENTRY_FILENAME);
}

/* ------------------------------------------------------------------ *
 * 入口发现
 * ------------------------------------------------------------------ */

/**
 * 从 Kiro agent 扩展的 bundle 文本里认出入口名。**纯函数**。
 *
 * 认的是 minified 代码里 `entryPoint` 附近的字符串字面量，四种真实写法都要覆盖：
 *
 * ```js
 * entryPoint: r = "session-view"          // 构造函数默认参数
 * entryPoint: "session-manager-surface"   // 显式构造
 * { entryPoint: "standalone" }            // 对象字面量
 * t.standalone.entryPoint === "standalone"// 比较
 * ```
 *
 * 刻意**宽松**：宁可多捞一些不是入口的字符串，也不要漏掉真入口——多捞的那些会在
 * 下一步「文件系统确认」里自然被滤掉（磁盘上没有对应的 `<name>/main.js`），
 * 而漏掉真入口的代价就是这次这个 bug：功能静默失效。
 */
export function discoverEntryNames(bundleSource: string): string[] {
  const re = /entryPoint\s*(?::\s*(?:[A-Za-z_$][\w$]*\s*=\s*)?|={2,3}\s*)"([A-Za-z][\w.-]{1,47})"/g;
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(bundleSource)) !== null) found.add(m[1]);
  return [...found].sort();
}

/**
 * 建一张「目录名 → 含 `main.js` 的目录绝对路径」索引。
 *
 * 一次遍历建索引，而不是为每个候选名各走一次树：候选名里混着不少噪音，
 * 逐个去搜会把一次遍历放大成十几次。
 *
 * 不假设 `packages/<pkg>/dist/<entry>` 这个层级：只要某个目录里有 `main.js`，
 * 它就可能是入口，而注入脚本放在它的上一级——这正是
 * `import "../kcs-turn-timer.js"` 这个相对路径的含义。于是 Kiro 把包挪到别处也依然能找到。
 *
 * 同名目录只记第一个命中：入口名在 Kiro 的产物里是唯一的。
 */
function indexEntryDirs(d: ResolvedFs, root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, depth: number): void => {
    if (depth > INDEX_MAX_DEPTH) return;
    for (const name of safeReaddir(d, dir)) {
      if (INDEX_SKIP_DIRS.has(name)) continue;
      const full = path.join(dir, name);
      // 文件的 readdir 会抛 → safeReaddir 返回空数组，因此不需要单独判断是不是目录
      if (!out.has(name) && safeExists(d, path.join(full, TURN_TIMER_ENTRY_FILENAME))) {
        out.set(name, full);
      }
      walk(full, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

/**
 * 查明「这个 Kiro 当前有哪些对话面板入口、分别落在哪个 dist 下」。**只读**。
 *
 * 两步，缺一不可：
 * 1. 从 Kiro 自己的 bundle 里认出入口名——**它才是权威**，写死清单就会重演
 *    「Kiro 换包而我们毫无感知」那个 bug（见文件头）。
 * 2. 用文件系统确认每个名字对应的目录在哪——顺带把第 1 步宽松正则多捞的噪音滤掉。
 */
export function surveyTurnTimerTargets(opts: TurnTimerOptions): TurnTimerSurvey {
  const d = resolveFs(opts.fsDeps);
  const agentExt = agentExtensionDir(opts.appRoot);

  const bundleSource = safeRead(d, path.join(agentExt, ...AGENT_BUNDLE_RELATIVE));
  let discovered = bundleSource === null ? [] : discoverEntryNames(bundleSource);
  let source: 'kiro' | 'fallback' = 'kiro';
  let reason: string | undefined;

  if (discovered.length === 0) {
    source = 'fallback';
    reason =
      bundleSource === null
        ? '读不到 Kiro agent 扩展的 bundle，无法确认它当前加载哪些对话面板入口'
        : '在 Kiro agent 扩展的 bundle 里没认出任何入口名（它可能改了写法）';
    discovered = [...FALLBACK_ENTRIES];
  }

  const index = indexEntryDirs(d, agentExt);
  const byDist = new Map<string, string[]>();
  const unlocated: string[] = [];

  for (const entry of discovered) {
    const entryDir = index.get(entry);
    if (entryDir === undefined) {
      unlocated.push(entry);
      continue;
    }
    const distDir = path.dirname(entryDir);
    const list = byDist.get(distDir);
    if (list) list.push(entry);
    else byDist.set(distDir, [entry]);
  }

  const bundles: TurnTimerBundle[] = [...byDist.entries()]
    .map(([distDir, entries]) => ({
      label: path.relative(agentExt, distDir).split(path.sep).join('/') || distDir,
      distDir,
      entries: entries.slice().sort(),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const survey: TurnTimerSurvey = { source, discovered, bundles, unlocated };
  if (reason !== undefined) survey.reason = reason;
  return survey;
}

/* ------------------------------------------------------------------ *
 * 探测
 * ------------------------------------------------------------------ */

/**
 * 读一遍磁盘，得出当前补丁状态。**只读，不写**。
 *
 * 每次询问都真读文件而不缓存：Kiro 可能在两次询问之间升级并抹掉补丁，
 * 缓存下来的「已生效」会变成谎言，而这个函数恰恰是用户判断「设置到底生效没有」
 * 的唯一依据。代价是一次目录索引 + 几次 `existsSync` + 几个小文件的 `readFileSync`。
 *
 * 任何文件系统异常都收敛成状态而不抛：设置页必须永远能打开并说明情况。
 */
export function detectTurnTimer(opts: TurnTimerOptions): TurnTimerStatus {
  const d = resolveFs(opts.fsDeps);
  const hostStart = opts.hostStartedAt ?? null;
  const survey = surveyTurnTimerTargets(opts);
  const assetSource = safeRead(d, opts.assetPath);

  const bundles: TurnTimerBundleStatus[] = survey.bundles.map((b) => {
    const scriptPath = path.join(b.distDir, TURN_TIMER_SCRIPT_FILENAME);
    const scriptInstalled = safeExists(d, scriptPath);
    const installedSource = scriptInstalled ? safeRead(d, scriptPath) : null;
    // 资源读不出来时不敢断言「已过期」：那会把一个本可用的补丁标成 partial，
    // 促使用户去点重试，而重试同样读不到资源、必然失败。
    const scriptUpToDate =
      installedSource !== null && (assetSource === null || installedSource === assetSource);

    let appliedAt: number | null = null;
    if (scriptInstalled) {
      try {
        const st = d.statSync(scriptPath);
        if (typeof st?.mtimeMs === 'number' && Number.isFinite(st.mtimeMs)) appliedAt = st.mtimeMs;
      } catch {
        appliedAt = null;
      }
    }

    const entries: TurnTimerEntryStatus[] = b.entries.map((entry) => {
      const main = entryMainPath(b.distDir, entry);
      const present = safeExists(d, main);
      const source = present ? safeRead(d, main) : null;
      return {
        entry,
        present,
        patched: source !== null && source.includes(TURN_TIMER_MARKER),
        backedUp: safeExists(d, main + TURN_TIMER_BACKUP_SUFFIX),
      };
    });

    return { label: b.label, distDir: b.distDir, scriptInstalled, scriptUpToDate, appliedAt, entries };
  });

  const allEntries = bundles.flatMap((b) => b.entries);
  const existing = allEntries.filter((e) => e.present);
  const patched = existing.filter((e) => e.patched);
  // 有入口要注入的包才要求脚本就位：一个入口都没有的包不该拖累整体判定
  const active = bundles.filter((b) => b.entries.some((e) => e.present));
  const scriptInstalled = active.length > 0 && active.every((b) => b.scriptInstalled);
  const scriptUpToDate = active.length > 0 && active.every((b) => b.scriptUpToDate);
  const appliedAt = active.reduce<number | null>(
    (acc, b) => (b.appliedAt === null ? acc : acc === null ? b.appliedAt : Math.max(acc, b.appliedAt)),
    null
  );

  const base: TurnTimerStatus = {
    state: 'unavailable',
    bundles,
    scriptInstalled,
    scriptUpToDate,
    appliedAt,
    hostStartedAt: hostStart,
    survey,
    detail: '',
  };

  if (existing.length === 0) {
    return {
      ...base,
      detail:
        '找不到任何可注入的对话面板入口。可能不是在 Kiro 里运行，' +
        '或这个 Kiro 版本换了产物结构（补丁需要重新适配）。' +
        (survey.source === 'fallback' ? `\n另外：${survey.reason}。` : ''),
    };
  }

  // 入口清单降级时**绝不**报告 on：此刻我们根本不知道 Kiro 在用哪些入口，
  // 「已生效」这个结论没有依据。这正是上一次静默失效的教训。
  if (survey.source === 'fallback') {
    return {
      ...base,
      state: 'partial',
      detail:
        `${survey.reason}，已退回内置入口清单。` +
        '若 Kiro 换过对话面板入口，实时耗时可能不会出现——请反馈给扩展作者更新适配。',
    };
  }

  if (patched.length === 0) {
    return { ...base, state: 'off', detail: '' };
  }

  if (patched.length < existing.length) {
    const missing = describeMissing(bundles);
    return {
      ...base,
      state: 'partial',
      detail: `以下入口尚未注入：${missing}。点「重试注入」补齐。`,
    };
  }

  if (!scriptInstalled) {
    return {
      ...base,
      state: 'partial',
      detail: '入口已注入，但注入脚本文件不在了（可能被清理工具删掉）。点「重试注入」修复。',
    };
  }

  if (!scriptUpToDate) {
    return {
      ...base,
      state: 'partial',
      detail:
        '已注入的脚本与当前扩展内置的版本不一致（扩展升级后需要重新覆盖）。点「重试注入」更新。',
    };
  }

  // 文件全部就位。剩下唯一的问题是「本窗口的 webview 加载的是补丁前还是补丁后的
  // main.js」——webview 只在创建时读一次，所以补丁晚于宿主启动就意味着还没生效。
  if (hostStart !== null && appliedAt !== null && appliedAt > hostStart) {
    return {
      ...base,
      state: 'pending-reload',
      detail: '补丁已写入，但本窗口的对话面板还是补丁前加载的。重载窗口后生效。',
    };
  }

  return { ...base, state: 'on', detail: '' };
}

/** 「哪些入口还没注入」的可读描述，带上所属包——多包时不带包名根本分不清。 */
function describeMissing(bundles: readonly TurnTimerBundleStatus[]): string {
  const parts: string[] = [];
  for (const b of bundles) {
    const miss = b.entries.filter((e) => e.present && !e.patched).map((e) => e.entry);
    if (miss.length > 0) parts.push(`${b.label} 下的 ${miss.join('、')}`);
  }
  return parts.join('；');
}

function safeExists(d: ResolvedFs, p: string): boolean {
  try {
    return d.existsSync(p);
  } catch {
    return false;
  }
}

function safeReaddir(d: ResolvedFs, p: string): string[] {
  try {
    const names = d.readdirSync(p);
    return Array.isArray(names) ? names : [];
  } catch {
    return [];
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
 * 每个 dist 各写一份注入脚本——import 是相对路径 `../kcs-turn-timer.js`，
 * 跨包共用一份做不到。
 *
 * 单个入口失败（只读、被占用）不中断其余入口：把错误收集起来一起报，
 * 状态里如实体现为 `partial`，用户点「重试注入」重跑即可——而不是一失败就整体回滚，
 * 那反而会把已经好了的入口也弄坏。
 */
export function applyTurnTimer(opts: TurnTimerOptions): TurnTimerActionResult {
  const d = resolveFs(opts.fsDeps);
  const survey = surveyTurnTimerTargets(opts);

  if (survey.bundles.length === 0) {
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

  for (const bundle of survey.bundles) {
    // 1) 脚本：内容不同才写，避免每次 activate 都刷新 mtime——mtime 是
    //    `pending-reload` 的判据，无谓刷新会让已生效的补丁被误报成「需重载」。
    const scriptPath = path.join(bundle.distDir, TURN_TIMER_SCRIPT_FILENAME);
    const installed = safeRead(d, scriptPath);
    if (installed !== assetSource) {
      try {
        d.writeFileSync(scriptPath, assetSource, 'utf8');
        changed = true;
      } catch (e: unknown) {
        errors.push(`写入 ${bundle.label}/${TURN_TIMER_SCRIPT_FILENAME} 失败：${messageOf(e)}`);
      }
    }

    // 2) 各入口：备份 → 追加 import
    for (const entry of bundle.entries) {
      const main = entryMainPath(bundle.distDir, entry);
      if (!safeExists(d, main)) continue; // 该版本没有这个入口，跳过不算失败

      const source = safeRead(d, main);
      if (source === null) {
        errors.push(`读不到入口文件 ${bundle.label}/${entry}/main.js`);
        continue;
      }
      if (source.includes(TURN_TIMER_MARKER)) continue; // 已打过

      const backup = main + TURN_TIMER_BACKUP_SUFFIX;
      if (!safeExists(d, backup)) {
        try {
          d.writeFileSync(backup, source, 'utf8');
        } catch (e: unknown) {
          // 备份失败就不动原文件：宁可不生效，也不留一个改了却无法稳妥还原的入口
          errors.push(
            `备份 ${bundle.label}/${entry}/main.js 失败，已跳过该入口：${messageOf(e)}`
          );
          continue;
        }
      }

      try {
        d.writeFileSync(main, source + injectionLine(source), 'utf8');
        changed = true;
      } catch (e: unknown) {
        errors.push(`注入 ${bundle.label}/${entry}/main.js 失败：${messageOf(e)}`);
      }
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
 *
 * 清理范围是「当前发现的入口」∪「**磁盘上任何带我们标记的入口**」：
 * Kiro 换过入口名之后，旧入口不再出现在发现结果里，若只按发现结果还原就会把改动
 * 永久留在那儿。所以这里额外扫一遍目录索引，认标记而不认名字。
 */
export function revertTurnTimer(opts: TurnTimerOptions): TurnTimerActionResult {
  const d = resolveFs(opts.fsDeps);
  const agentExt = agentExtensionDir(opts.appRoot);
  const survey = surveyTurnTimerTargets(opts);

  // 发现结果里的入口
  const targets = new Map<string, string>(); // main.js 绝对路径 -> 展示标签
  for (const b of survey.bundles) {
    for (const entry of b.entries) {
      targets.set(entryMainPath(b.distDir, entry), `${b.label}/${entry}`);
    }
  }
  // 再加上任何带我们标记的入口（哪怕它已经不在发现结果里）
  for (const [name, dir] of indexEntryDirs(d, agentExt)) {
    const main = path.join(dir, TURN_TIMER_ENTRY_FILENAME);
    if (targets.has(main)) continue;
    const source = safeRead(d, main);
    if (source !== null && source.includes(TURN_TIMER_MARKER)) {
      targets.set(main, path.relative(agentExt, dir).split(path.sep).join('/') || name);
    }
  }

  if (targets.size === 0) {
    const status = detectTurnTimer(opts);
    return { ok: false, changed: false, error: status.detail, status };
  }

  const errors: string[] = [];
  let changed = false;
  const touchedDists = new Set<string>();

  for (const [main, label] of targets) {
    if (!safeExists(d, main)) continue;
    touchedDists.add(path.dirname(path.dirname(main)));

    const backup = main + TURN_TIMER_BACKUP_SUFFIX;
    const backupSource = safeExists(d, backup) ? safeRead(d, backup) : null;

    if (backupSource !== null) {
      try {
        d.writeFileSync(main, backupSource, 'utf8');
        changed = true;
      } catch (e: unknown) {
        errors.push(`还原 ${label}/main.js 失败：${messageOf(e)}`);
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
      errors.push(`清除 ${label}/main.js 的注入行失败：${messageOf(e)}`);
    }
  }

  // 每个动过的 dist 各删一份注入脚本
  for (const distDir of touchedDists) {
    const scriptPath = path.join(distDir, TURN_TIMER_SCRIPT_FILENAME);
    if (!safeExists(d, scriptPath)) continue;
    try {
      d.unlinkSync(scriptPath);
      changed = true;
    } catch (e: unknown) {
      errors.push(`删除 ${scriptPath} 失败：${messageOf(e)}`);
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
 * 还原是**字节精确**的；对原本不以换行结尾的文件会多留一个结尾换行。
 * 首选的还原路径始终是拷回 `.kcs-orig` 备份，那条路径无条件字节精确。
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
