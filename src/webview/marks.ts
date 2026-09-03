/**
 * 提醒标记（窗口标题前缀）的**纯逻辑**：归一化 + 预览。
 *
 * 和 `turnTimer.ts` 同一个角色：宿主与设置页 webview 共用同一份实现（webview 侧靠
 * `fn.toString()` 注入），因此单元测试断言的字符串就是用户在设置页里看到的那几行。
 *
 * ── 注入安全的三条硬约束（`tests/webview.inline-script.spec.ts` 会抓）──────────
 * 1. 函数体**不得**引用被 `export` 的模块级常量：tsc 的 CommonJS 输出会把这类引用
 *    重写成 `exports.X`，而 webview 里没有 `exports`，注入后一执行就抛 ReferenceError。
 *    ⇒ 两个默认标记在**函数签名里以字面量写死**，而不是引用 `attention.ts` 的
 *      `DEFAULT_TITLE_MARK` / `DEFAULT_DONE_MARK`。
 *    ⇒ 字面量因此出现在两处，`tests/settings.marks.spec.ts` 有一条守卫断言它们相等，
 *      改一处忘了另一处会红。
 * 2. 同理不得引用跨模块 `import` 进来的绑定（会被重写成 `mod_1.X`）。
 * 3. 允许互相调用：`export function` 在 CJS 输出里仍保留本地绑定（只有
 *    `export const` 会被重写），所以 {@link markPreview} 可以直接调
 *    {@link normalizeMark}——只要两份源码都注入进同一段脚本。
 */

/**
 * 归一化用户配置的标记。
 *
 * - 空 / 纯空白 → 退回 `fallback`，避免「配了个空串」导致标题看不出任何区别却仍在改配置
 * - 结尾没有空白就补一个：否则会渲染成 `🔴我的项目`，emoji 和文字黏在一起
 *   （用户手填的时候很容易忘掉那个空格）
 */
export function normalizeMark(mark: string, fallback: string = '🔴 '): string {
  const raw = typeof mark === 'string' ? mark : '';
  if (!raw.trim()) return fallback;
  return /\s$/.test(raw) ? raw : raw + ' ';
}

/** {@link markPreview} 的入参：两个标记的**原始**配置值（未归一化）。 */
export interface MarkPreviewInput {
  /** 待确认标记的原始配置值。 */
  titleMark: string;
  /** 已完成标记的原始配置值。 */
  doneMark: string;
  /** 预览用的示例标题（不带任何标记）；缺省用一个通用示例。 */
  sample?: string;
}

/** 预览里的一行：一种情形 + 该情形下的完整标题。 */
export interface MarkPreviewLine {
  /** 情形说明，如「只在等你确认」。 */
  label: string;
  /** 该情形下窗口标题的样子。 */
  title: string;
}

/** 预览结果（设置页直接渲染，不做二次判断）。 */
export interface MarkPreviewResult {
  /** 归一化后的待确认标记（漏了尾空格时这里已补上）。 */
  titleMark: string;
  /** 归一化后的已完成标记。 */
  doneMark: string;
  /**
   * 归一化是否改动过用户的输入。
   *
   * 有它才能解释「我明明填的是 `🔴`，怎么预览里多了个空格」——把一次静默的修正
   * 变成一句可见的说明，而不是让用户以为自己填错了。
   */
  normalized: boolean;
  /** 四种情形，顺序即展示顺序（信息量从大到小）。 */
  lines: MarkPreviewLine[];
}

/**
 * 由两个标记算出窗口标题在四种情形下的样子。
 *
 * 并存时 `✅` 排在 `🔴` **前面**，与 `AttentionWatcher.desiredPrefix()` 一致——预览
 * 不该只是「大概长这样」，它拼出来的就是真的会被写进 `window.title` 的那个字符串。
 */
export function markPreview(input: MarkPreviewInput): MarkPreviewResult {
  const rawTitle = input && typeof input.titleMark === 'string' ? input.titleMark : '';
  const rawDone = input && typeof input.doneMark === 'string' ? input.doneMark : '';
  const sample = (input && input.sample) || '我的项目 - Kiro';
  const mark = normalizeMark(rawTitle, '🔴 ');
  const done = normalizeMark(rawDone, '✅ ');
  return {
    titleMark: mark,
    doneMark: done,
    normalized: mark !== rawTitle || done !== rawDone,
    lines: [
      { label: '两者并存', title: done + mark + sample },
      { label: '只在等你确认', title: mark + sample },
      { label: '只是跑完一轮', title: done + sample },
      { label: '都没有', title: sample },
    ],
  };
}
