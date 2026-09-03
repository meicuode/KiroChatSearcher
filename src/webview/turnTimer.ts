/**
 * 设置页「对话耗时显示」状态行的文案。
 *
 * 与 `size.ts` 的 `summaryLabel` 同一个角色：**纯函数**，宿主与 webview 共用同一份
 * 实现（webview 侧靠 `fn.toString()` 注入），因此单元测试断言的字符串就是用户看到的。
 *
 * 三条硬约束（`tests/webview.inline-script.spec.ts` 会抓）：
 * 1. 函数体**不得**引用任何被 `export` 的模块级常量——tsc 的 CommonJS 输出会把它们
 *    重写成 `exports.X`，而 webview 里没有 `exports`，注入后一执行就抛 ReferenceError。
 * 2. 同理不得引用跨模块 `import` 进来的绑定（会被重写成 `mod_1.X`）。
 * 3. 因此状态 → 文案的映射表写在函数体**内部**，重复几个字面量换取注入安全。
 */

/** 状态行的语气，决定颜色（设置页 CSS 按 `data-tone` 取色）。 */
export type TurnTimerTone = 'ok' | 'warn' | 'error' | 'muted';

/** {@link turnTimerStatusLabel} 的入参：设置意图 + 磁盘实况 + 本窗口是否已过期。 */
export interface TurnTimerLabelInput {
  /** 用户在设置页里的意图（持久化在 globalState），不是磁盘实况。 */
  enabled: boolean;
  /** `detectTurnTimer()` 得出的磁盘实况。 */
  state: 'unavailable' | 'off' | 'partial' | 'pending-reload' | 'on';
  /** 状态的补充说明，直接透传给用户。 */
  detail?: string;
  /** 本窗口启动后动过补丁文件 → 当前面板加载的是旧版本，需重载才一致。 */
  dirty?: boolean;
}

/** 状态行渲染所需的一切（设置页不做二次判断）。 */
export interface TurnTimerLabel {
  tone: TurnTimerTone;
  /** 行首的状态符号。 */
  badge: string;
  /** 一句话结论。 */
  text: string;
  /** 悬浮说明（`detail` 为空时退回结论本身）。 */
  title: string;
  /** 是否值得给出「重试」入口。 */
  canRetry: boolean;
  /** 是否值得给出「重载窗口」入口。 */
  canReload: boolean;
}

/**
 * 把「设置意图 + 磁盘实况」翻译成用户能直接理解的一行。
 *
 * 核心是把两个容易被混为一谈的事实分开表达：
 * - **磁盘上打没打补丁**（`state`）
 * - **当前这个窗口的对话面板到底跑没跑起来**（`dirty` / `pending-reload`）
 *
 * 对话面板是 webview，只在创建时读一次入口文件。所以「已写入」不等于「已生效」，
 * 而用户看到的恰恰是后者——不区分这两件事，就会出现「我开了啊，怎么没反应」。
 */
export function turnTimerStatusLabel(input: TurnTimerLabelInput): TurnTimerLabel {
  const enabled = !!(input && input.enabled);
  const state = (input && input.state) || 'unavailable';
  const detail = (input && input.detail) || '';
  const dirty = !!(input && input.dirty);

  const withTitle = function (label: TurnTimerLabel): TurnTimerLabel {
    return {
      tone: label.tone,
      badge: label.badge,
      text: label.text,
      title: detail || label.text,
      canRetry: label.canRetry,
      canReload: label.canReload,
    };
  };

  // 环境本身不支持：重试无害（可能是临时权限问题），重载窗口无意义
  if (state === 'unavailable') {
    return withTitle({
      tone: 'error',
      badge: '⚠',
      text: '不可用：找不到 Kiro 对话面板',
      title: '',
      canRetry: true,
      canReload: false,
    });
  }

  // 本窗口动过补丁文件 → 无论开还是关，当前面板都还是旧的
  if (dirty) {
    return withTitle({
      tone: 'warn',
      badge: '⟳',
      text: enabled ? '已写入，重载窗口后生效' : '已移除，重载窗口后停止显示',
      title: '',
      canRetry: false,
      canReload: true,
    });
  }

  if (enabled) {
    if (state === 'on') {
      return withTitle({
        tone: 'ok',
        badge: '●',
        text: '已生效：对话进行中会显示本轮耗时',
        title: '',
        canRetry: false,
        canReload: false,
      });
    }
    if (state === 'pending-reload') {
      return withTitle({
        tone: 'warn',
        badge: '⟳',
        text: '已写入，重载窗口后生效',
        title: '',
        canRetry: false,
        canReload: true,
      });
    }
    if (state === 'partial') {
      return withTitle({
        tone: 'warn',
        badge: '⚠',
        text: '只注入了一部分，未完全生效',
        title: '',
        canRetry: true,
        canReload: true,
      });
    }
    // state === 'off' 而设置为开：Kiro 升级抹掉了补丁，或写入失败
    return withTitle({
      tone: 'error',
      badge: '✕',
      text: '未生效：补丁不在了（Kiro 升级会抹掉，点重试重新写入）',
      title: '',
      canRetry: true,
      canReload: false,
    });
  }

  if (state === 'off') {
    return withTitle({
      tone: 'muted',
      badge: '○',
      text: '已关闭：对话面板保持 Kiro 原样',
      title: '',
      canRetry: false,
      canReload: false,
    });
  }

  // 设置为关但磁盘上仍有补丁残留
  return withTitle({
    tone: 'warn',
    badge: '⚠',
    text: '已关闭，但补丁仍残留在 Kiro 里，点重试清除',
    title: '',
    canRetry: true,
    canReload: false,
  });
}
