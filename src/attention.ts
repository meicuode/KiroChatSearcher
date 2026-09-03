import * as path from 'path';

/**
 * PendingApproval：Kiro 在等你人工确认时，把标记打到**窗口标题**上。
 *
 * ── 要解决的问题 ────────────────────────────────────────────────────────────
 *
 * Kiro 需要批准某个工具调用时会推一条 IDE 内通知，但那条通知会自动消失、也不告诉你
 * 是**哪个**窗口在等；开着好几个 Kiro 的时候，经常一小时后才发现第一步都没做完。
 *
 * 窗口标题是唯一能触及 Windows 任务栏的合法手段：VSCode 的 `window.title` 配置直接
 * 决定操作系统窗口标题（实测 Kiro 的窗口标题就是该模板的渲染结果），因此它会出现在
 * Alt+Tab、任务栏悬停预览，以及**任务栏按钮的文字**上（后者取决于系统的
 * 「合并任务栏按钮」设置）。扩展 API 里没有任何设置任务栏图标叠加（overlay icon）
 * 的口子——那是 Electron 的 `setOverlayIcon`，没有暴露给扩展。
 *
 * ── 怎么知道 Kiro 在等确认 ──────────────────────────────────────────────────
 *
 * 不和 kiro-agent 通信（两个扩展之间没有通道），而是读它自己写的会话文件。
 * `messages.jsonl` 里有一对事件，按 `toolCallId` 配对：
 *
 * ```jsonc
 * {"payload":{"type":"pending_interaction","interactionType":"tool_approval",
 *             "toolCallId":"toolu_…","question":"Load skill: item","options":[…]}}
 * {"payload":{"type":"interaction_resolved","toolCallId":"toolu_…",
 *             "outcome":"selected","selectedOption":"always-accept"}}
 * ```
 *
 * 只有 `pending` 而没有对应 `resolved` ⇒ 正在等你。见 {@link scanPendingInteractions}。
 *
 * 本模块**不 import `vscode`**：文件系统与配置读写全部经 {@link AttentionDeps} 注入，
 * 于是解析规则与标题改写都能被单元测试直接覆盖，不需要真的去改一个窗口的设置。
 */

/* ------------------------------------------------------------------ *
 * 1. 解析：谁在等确认（纯函数）
 * ------------------------------------------------------------------ */

/** 一条仍在等待人工处理的交互。 */
export interface PendingInteraction {
  /** 与 `interaction_resolved` 配对的键。 */
  toolCallId: string;
  /** `tool_approval` 等；缺失时为空串。 */
  interactionType: string;
  /** 问题原文（如 `Load skill: item`），可直接展示给用户；缺失时为空串。 */
  question: string;
  /** 事件时间（epoch ms）；时间戳缺失或非法时为 `null`。 */
  at: number | null;
}

/** 一次会话扫描的产出：谁在等确认，以及最后一次「轮结束」是哪一个。 */
export interface SessionActivity {
  /** 仍在等待人工处理的交互。 */
  pending: PendingInteraction[];
  /**
   * 最后一个 `turn_end` 事件的**身份**（优先取事件 id，退回时间戳），没有则为 `null`。
   *
   * 用「身份」而不是「计数」：MessagesFile 只读尾部窗口，文件长大后窗口会往后滑动，
   * 窗口内的 `turn_end` **条数可能减少**——拿计数比对会把「又完成了一轮」误判成没变，
   * 或反过来。事件 id 全局唯一，窗口怎么滑都不影响比对。
   */
  lastTurnEndId: string | null;
}

/**
 * 从 MessagesFile 文本里找出**仍在等待**的交互（{@link scanSessionActivity} 的薄封装）。
 *
 * 判据两条，缺一不可：
 * 1. 没有同 `toolCallId` 的 `interaction_resolved`
 * 2. 该 `pending` 之后没有出现 `turn_end`
 *
 * 第 2 条是防幻影的关键：进程被杀、窗口被关、或用户在别处取消了整轮，都会留下一个
 * 永远等不到 `resolved` 的 `pending`。而只要轮已经结束，就没人在等了。少了这一条，
 * 标记会永久挂在标题上摘不掉。
 *
 * 逐行容错：单行不是合法 JSON 就跳过（`messages.jsonl` 是追加写的，进程被杀会留下
 * 半行），与 `session/newFormat.ts` 同策略。**不抛异常。**
 *
 * 允许只传文件**尾部**片段：`resolved` 恒在其 `pending` 之后，所以尾窗口里出现的
 * `pending`，它的 `resolved`（若有）必然也在同一窗口或更靠后 —— 截取尾部不会
 * 把「已处理」误判成「在等」。
 */
export function scanPendingInteractions(raw: string): PendingInteraction[] {
  return scanSessionActivity(raw).pending;
}

/**
 * 一次遍历同时得出「谁在等确认」与「最后一次轮结束的身份」。
 *
 * 两件事合在一次遍历里，是因为它们读的是同一批行、判据还互相牵连
 * （`turn_end` 既作废先前的 pending，又是「完成」的信号）。
 */
export function scanSessionActivity(raw: string): SessionActivity {
  const pending = new Map<string, PendingInteraction>();
  const resolved = new Set<string>();
  let lastTurnEndId: string | null = null;

  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    // 廉价预筛：三个关键 token 都不含的行不可能影响结果，跳过 JSON.parse。
    // 单个会话可达数 MB，逐行全解析的开销远大于一次子串查找。
    if (
      !line.includes('pending_interaction') &&
      !line.includes('interaction_resolved') &&
      !line.includes('turn_end')
    ) {
      continue;
    }

    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event === null || typeof event !== 'object') continue;

    const payload = (event as { payload?: unknown }).payload;
    if (payload === null || typeof payload !== 'object') continue;
    const p = payload as Record<string, unknown>;
    const type = typeof p.type === 'string' ? p.type : '';

    if (type === 'turn_end') {
      // 轮结束 ⇒ 此刻之前的一切 pending 都不再有人等
      pending.clear();
      resolved.clear();
      const id = (event as { id?: unknown }).id;
      const ts = (event as { timestamp?: unknown }).timestamp;
      if (typeof id === 'string' && id) lastTurnEndId = id;
      else if (typeof ts === 'string' && ts) lastTurnEndId = ts;
      continue;
    }

    const toolCallId = typeof p.toolCallId === 'string' ? p.toolCallId : '';
    if (!toolCallId) continue;

    if (type === 'pending_interaction') {
      pending.set(toolCallId, {
        toolCallId,
        interactionType: typeof p.interactionType === 'string' ? p.interactionType : '',
        question: typeof p.question === 'string' ? p.question : '',
        at: parseTimestamp((event as { timestamp?: unknown }).timestamp),
      });
    } else if (type === 'interaction_resolved') {
      resolved.add(toolCallId);
      pending.delete(toolCallId);
    }
  }

  return {
    pending: [...pending.values()].filter((it) => !resolved.has(it.toolCallId)),
    lastTurnEndId,
  };
}

function parseTimestamp(v: unknown): number | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/* ------------------------------------------------------------------ *
 * 2. 标题改写（纯函数）
 * ------------------------------------------------------------------ */

/**
 * 给标题模板加上标记前缀。**幂等**：已带该前缀时原样返回，不会叠成 `** `。
 *
 * 幂等很要紧：等待期间任何一次配置回读 + 重写都可能再走一遍这里，不幂等就会
 * 每次多一个星号，最后标题变成一串符号。
 */
export function markTitle(title: string, mark: string): string {
  if (!mark) return title;
  return title.startsWith(mark) ? title : mark + title;
}

/**
 * 摘掉标题的标记前缀。**幂等**，且会摘掉重复叠加的多层前缀
 * （历史残留、或旧版本非幂等写入留下的 `** `）。
 */
export function unmarkTitle(title: string, mark: string): string {
  if (!mark) return title;
  let out = title;
  while (out.startsWith(mark)) out = out.slice(mark.length);
  return out;
}

/** 标题当前是否带标记。 */
export function isTitleMarked(title: string, mark: string): boolean {
  return !!mark && title.startsWith(mark);
}

/** 依次摘掉任意一个候选标记（当前标记 + 历史标记），直到都不匹配。 */
export function stripAnyMark(title: string, marks: readonly string[]): string {
  let out = title;
  let changed = true;
  while (changed) {
    changed = false;
    for (const m of marks) {
      if (m && out.startsWith(m)) {
        out = out.slice(m.length);
        changed = true;
      }
    }
  }
  return out;
}

/**
 * 归一化用户配置的标记。
 *
 * - 空 / 纯空白 → 退回默认，避免「配了个空串」导致标题看不出任何区别却仍在改配置
 * - 结尾没有空白就补一个：否则会渲染成 `🔴Kiro Chat Search`，emoji 和文字黏在一起
 *   （用户配的时候很容易忘掉那个空格）
 */
export function normalizeMark(mark: string, fallback: string = DEFAULT_TITLE_MARK): string {
  const raw = typeof mark === 'string' ? mark : '';
  if (!raw.trim()) return fallback;
  return /\s$/.test(raw) ? raw : raw + ' ';
}

/**
 * 「刚跑完一轮」的默认标记：白底对勾 + 空格。
 *
 * 与待确认的 🔴 并存时排在**前面**（`✅ 🔴 标题`）：两者语义不同——✅ 是「有结果了，
 * 回来看看」，🔴 是「卡着等你点」。绿色与红色在任务栏小尺寸下也容易区分。
 */
export const DEFAULT_DONE_MARK = '✅ ';

/**
 * 默认标记：红色圆点 + 空格。
 *
 * 选它的理由：任务栏按钮上的可视尺寸只有十几像素，此时**纯色块比线条图形好认得多**
 * ——🔔 / ⚠️ 这类有内部结构的图形在这个尺寸下会糊成一团，而实心圆点的颜色一眼可辨。
 * 红色又是「需要我处理」的通用语义。实测 Windows 窗口标题按 UTF-16 原样保留 emoji，
 * 🔴 / 🔔 / ✋ / ❗ / ⏳ / ⚠️ / 🟠 / 👉 写入读回完全一致。
 */
export const DEFAULT_TITLE_MARK = '🔴 ';

/* ------------------------------------------------------------------ *
 * 3. 状态机（注入依赖，不碰 vscode）
 * ------------------------------------------------------------------ */

/** MessagesFile 的文件名（与 `session/newFormat.ts` 同一常量值）。 */
export const MESSAGES_FILENAME = 'messages.jsonl';

/**
 * 读取 MessagesFile 尾部的窗口大小。
 *
 * 512KB 足以覆盖「当前这一轮」的全部事件；再往前的内容对判断「现在有没有人在等」
 * 没有影响（`turn_end` 会把更早的 pending 全部清掉）。
 */
export const TAIL_BYTES = 512 * 1024;

/** 注入的文件系统 / 配置 / UI 依赖。 */
export interface AttentionDeps {
  /** 当前工作区的 1.x 会话目录；无工作区或非 1.x 布局时返回 `null`。 */
  sessionDir(): string | null;
  /** 列出目录下的条目名；不可读时返回 `null`。 */
  listDir(dir: string): string[] | null;
  /** 读文件尾部最多 `maxBytes` 字节的 utf8 文本；读不到返回 `null`。 */
  readTail(file: string, maxBytes: number): string | null;
  /** 读当前 `window.title` 的三个层级值。 */
  readTitle(): { workspaceValue?: string; globalValue?: string; defaultValue?: string };
  /** 写 `window.title` 的工作区层级值；`undefined` 表示删除该键。 */
  writeTitle(value: string | undefined): Promise<void>;
  /** 反馈当前状态（状态栏等 UI 由调用方实现）。 */
  onStateChange(state: AttentionState): void;
  /**
   * 当前窗口是否有焦点。
   *
   * 决定「刚跑完一轮」要不要亮标记：你正盯着屏幕看它跑完，就不需要提醒。
   * 缺省视为**无焦点**（宁可多提醒一次，也不要漏掉真正需要提醒的场合）。
   */
  isWindowFocused?(): boolean;
  /** 诊断输出；缺省静默。 */
  log?(message: string): void;
}

/** 对外反馈的状态快照。 */
export interface AttentionState {
  /** 仍在等待人工确认的交互。 */
  pending: readonly PendingInteraction[];
  /** 是否有「在你不看的时候跑完了一轮」尚未被你查看。 */
  done: boolean;
}

/**
 * 等待确认监视器。
 *
 * 只做「扫描 → 比较 → 改标题」，**不自己排程**：何时调用 {@link refresh} 由外部的
 * 文件监听与防抖决定。这样单元测试可以逐步驱动状态机，不必和真实的 fs.watch 赛跑。
 */
export class AttentionWatcher {
  private readonly deps: AttentionDeps;
  /** 待确认标记。 */
  private readonly mark: string;
  /** 「刚跑完一轮」标记。 */
  private readonly doneMark: string;
  /**
   * 曾经用过的标记前缀。
   *
   * 用户改了标记（比如从 `* ` 换成 `🔴 `）而上一次的标记还留在配置里时，
   * 只认新标记会摘不掉旧的。清理残留时把这些一并尝试。
   */
  private readonly legacyMarks: readonly string[];
  /** 当前已知的等待项（按 toolCallId 去重后的快照）。 */
  private current: PendingInteraction[] = [];
  /** 是否有「你不在看的时候跑完的一轮」尚未被查看。 */
  private done = false;
  /**
   * 我们当前写进标题的前缀（可能是 `''` / `doneMark` / `mark` / 两者拼接）。
   *
   * 存「写了什么」而不是布尔「打没打标记」：两个标志组合出四种前缀，
   * 用布尔无法判断「需不需要改写」，会导致 pending 消失但 done 仍在时漏改标题。
   */
  private currentPrefix = '';
  /**
   * 每个会话文件最后一个 `turn_end` 的身份。
   *
   * 首次扫描只**建立基线**、不触发「完成」——否则一打开窗口，历史上每个会话的
   * 最后一轮都会被当成「刚刚跑完」，标题上立刻挂一个假的 ✅。
   */
  private lastTurnEnds = new Map<string, string | null>();
  /** 基线是否已建立。 */
  private baselined = false;

  constructor(
    deps: AttentionDeps,
    mark: string,
    legacyMarks: readonly string[] = [],
    doneMark: string = DEFAULT_DONE_MARK
  ) {
    this.deps = deps;
    this.mark = normalizeMark(mark);
    this.doneMark = normalizeMark(doneMark, DEFAULT_DONE_MARK);
    this.legacyMarks = legacyMarks.filter(
      (m) => m && m !== this.mark && m !== this.doneMark
    );
  }

  /** 当前生效的全部标记（含历史标记），用于摘除时逐个尝试。 */
  private get allMarks(): string[] {
    return [this.mark, this.doneMark, ...this.legacyMarks];
  }

  /** 由两个标志拼出应有的标题前缀。 */
  private desiredPrefix(): string {
    return (this.done ? this.doneMark : '') + (this.current.length > 0 ? this.mark : '');
  }

  /** 当前等待项的只读快照。 */
  get pending(): readonly PendingInteraction[] {
    return this.current;
  }

  /** 是否有未查看的「已完成」。 */
  get hasDone(): boolean {
    return this.done;
  }

  /**
   * 窗口获得焦点：清掉「已完成」标记。
   *
   * 这就是「主动点过这个窗口之后 ✅ 就消失」——你已经看到了，提醒的使命结束。
   * 待确认标记**不受影响**：那件事还没做完。
   */
  async onWindowFocused(): Promise<void> {
    if (!this.done) return;
    this.done = false;
    this.deps.log?.('[待确认] 窗口获得焦点，清除完成标记');
    this.deps.onStateChange({ pending: this.current, done: false });
    await this.syncTitle();
  }

  /**
   * 扫一遍工作区下所有会话，更新状态并在需要时改标题。
   *
   * 无工作区 / 非 1.x 布局 / 目录不可读时按「没有等待项」处理——这些都不是错误，
   * 只是本功能在该环境下无从判断，此时也应当把可能残留的标记摘掉。
   */
  async refresh(): Promise<void> {
    const { pending: next, turnEnds } = this.collect();

    // 「刚跑完一轮」：任一会话的最后一个 turn_end 变了身份即算完成。
    // 「任一完成就亮」是刻意的语义——你关心的是「有东西跑完了，回来看看」，
    // 而不是「所有会话都停了」；后者在多会话下几乎永远等不到。
    let finished = false;
    if (this.baselined) {
      for (const [file, id] of turnEnds) {
        if (id !== null && this.lastTurnEnds.get(file) !== id) finished = true;
      }
    }
    this.lastTurnEnds = turnEnds;
    this.baselined = true;

    const wasDone = this.done;
    if (finished && !this.isFocused()) {
      this.done = true;
      this.deps.log?.('[待确认] 有会话跑完了一轮，且窗口无焦点 → 亮完成标记');
    }

    const pendingChanged = !sameIds(this.current, next);
    this.current = next;
    if (pendingChanged) {
      this.deps.log?.(
        `[待确认] ${next.length} 项` +
          (next.length > 0 ? '：' + next.map((p) => p.question || p.toolCallId).join(' / ') : '')
      );
    }
    if (pendingChanged || this.done !== wasDone) {
      this.deps.onStateChange({ pending: next, done: this.done });
    }
    await this.syncTitle();
  }

  private isFocused(): boolean {
    try {
      return this.deps.isWindowFocused?.() ?? false;
    } catch {
      return false;
    }
  }

  /** 摘掉标记并清空状态（扩展停用 / 功能被关闭时调用）。 */
  async dispose(): Promise<void> {
    this.current = [];
    this.done = false;
    await this.syncTitle();
  }

  /** 当前是否处于「已打标记」状态。调用方据此决定要不要开兜底对账。 */
  get isMarked(): boolean {
    return this.currentPrefix !== '';
  }

  /**
   * 启动时的残留清理：进程上次是被杀掉的（没走到还原）时，标记会留在配置里。
   * 与 {@link refresh} 分开是因为这一步必须**无条件**执行一次，
   * 哪怕此刻确实有等待项——先归零，再由 refresh 决定要不要重新打上。
   */
  async clearStaleMark(): Promise<void> {
    const t = this.deps.readTitle();
    const ws = t.workspaceValue;
    if (typeof ws !== 'string') {
      this.currentPrefix = '';
      return;
    }
    const marks = this.allMarks;
    // 当前两个标记与历史标记都要认：用户换过标记时，旧前缀同样得摘掉
    const hit = marks.find((m) => isTitleMarked(ws, m));
    if (hit !== undefined) {
      this.deps.log?.(`[待确认] 清理上次遗留的标题标记（${JSON.stringify(hit)}）`);
      const stripped = stripAnyMark(ws, marks);
      const fallback = stripAnyMark(t.globalValue ?? t.defaultValue ?? '', marks);
      try {
        await this.deps.writeTitle(stripped === fallback ? undefined : stripped);
      } catch (e: unknown) {
        this.deps.log?.('[待确认] 清理遗留标记失败：' + messageOf(e));
      }
    }
    this.currentPrefix = '';
  }

  /** 枚举工作区下每个会话的 MessagesFile 尾部，汇总等待项。 */
  private collect(): {
    pending: PendingInteraction[];
    turnEnds: Map<string, string | null>;
  } {
    const turnEnds = new Map<string, string | null>();
    const dir = this.deps.sessionDir();
    if (!dir) return { pending: [], turnEnds };
    const names = this.deps.listDir(dir);
    if (!names) return { pending: [], turnEnds };

    const out: PendingInteraction[] = [];
    const seen = new Set<string>();
    for (const name of names) {
      const file = path.join(dir, name, MESSAGES_FILENAME);
      const raw = this.deps.readTail(file, TAIL_BYTES);
      if (raw === null) continue;
      const activity = scanSessionActivity(raw);
      turnEnds.set(file, activity.lastTurnEndId);
      for (const item of activity.pending) {
        if (seen.has(item.toolCallId)) continue;
        seen.add(item.toolCallId);
        out.push(item);
      }
    }
    return { pending: out, turnEnds };
  }

  /**
   * 让标题与 `waiting` 一致。**幂等**：状态没变化时不写配置。
   *
   * 还原策略刻意不依赖任何持久化的「原值」：摘掉标记后，如果结果与
   * global/default 层级的值相同，就**删除**工作区层级的键，让配置回到我们没来过的
   * 样子；否则写回摘掉标记的值（说明用户自己在工作区层级设过标题）。
   * 这样即使跨进程重启、globalState 丢失，也不会留下一个我们凭空写出来的键。
   */
  private async syncTitle(): Promise<void> {
    const desired = this.desiredPrefix();
    if (desired === this.currentPrefix) return;

    const t = this.deps.readTitle();
    const marks = this.allMarks;
    // 基线一律先把已知标记全摘掉再拼，因此「🔴 → ✅ 🔴」这类前缀变化不会叠加
    const base = stripAnyMark(t.workspaceValue ?? t.globalValue ?? t.defaultValue ?? '', marks);
    const fallback = stripAnyMark(t.globalValue ?? t.defaultValue ?? '', marks);
    const target = desired + base;

    try {
      // 回到「我们没来过」的样子时删掉工作区键，而不是留一个与上层同值的冗余键
      await this.deps.writeTitle(target === fallback ? undefined : target);
      this.currentPrefix = desired;
    } catch (e: unknown) {
      // 写配置失败（只读工作区、settings.json 被占用）不应让功能整体崩掉：
      // 状态栏那一路提示仍然有效。
      this.deps.log?.('[待确认] 更新窗口标题失败：' + messageOf(e));
    }
  }
}

function sameIds(a: readonly PendingInteraction[], b: readonly PendingInteraction[]): boolean {
  if (a.length !== b.length) return false;
  const ids = new Set(a.map((x) => x.toolCallId));
  return b.every((x) => ids.has(x.toolCallId));
}

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  const m = (e as { message?: unknown } | null | undefined)?.message;
  return typeof m === 'string' ? m : String(e);
}
