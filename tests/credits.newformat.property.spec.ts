/**
 * Kiro 1.x 存储适配 —— 用量求和口径的属性测试。
 *
 * Feature: kiro-1x-storage-adaptation, Property 8: 用量求和口径
 * Validates: Requirements 4.1, 4.2, 4.3
 *
 * 核心命题两条：
 *
 * 1. **只累加 credit 单位项**（Req 4.1、4.2）：`messages.jsonl` 里 `usage_summary` 事件的用量
 *    数组混着工具使用记录、token/request 计量项、以及各种脏值（`1e999` 解析出的 Infinity、
 *    数字字符串、缺 `usage` 键）。合计必须恒等于测试侧**独立**求和的结果：只取「`usage` 是
 *    有限数 且 `unit` 不区分大小写等于 `credit`」的项。
 * 2. **1.x 双口径同值**（Req 4.3、design D4）：用量记在会话自己的消息流里，不存在跨会话归属，
 *    因此 `self` 恒等于 `lineage`。
 *
 * 另外三条支撑性质：**不可用 ≠ 0**（Req 4.7 的口径面：`credits: null` 与 `credits: 0` 严格
 * 区分，否则 UI 会把「没有用量记录」显示成「花了 0」）、**可加性/顺序无关**（用量项在事件间
 * 怎么分布、事件按什么顺序落盘，都不该改变合计）、**坏行容错**（追加写留下的半行不能带走
 * 整个会话的用量）。
 *
 * ## 独立性说明（避免退化成同义反复）
 *
 * 预期值走**两条互不相同**的路径，两条都要与被测实现相符：
 *
 * - {@link expectedTotals}：**形态表驱动**。生成器为每个项声明它的 `unit` 形态与 `usage` 形态，
 *   预期由 {@link UNIT_IS_CREDIT} × {@link usagePart} 两张表直接判定，不看 JSON 文本、
 *   不复刻解析流程。
 * - {@link naiveSumFromText}：**朴素文本重算**。独立写一遍「逐行 JSON.parse → 过滤
 *   `usage_summary` → 取首个用量数组 → 过滤求和」，对应 research-notes 里那次交叉验证
 *   （28 个事件 / 16 个 credit 项 / 合计 737.5206366955888）的做法。
 *
 * 两条路径同时被断言，任何一条与实现漂移都会立刻失败。
 *
 * ## 浮点精度的处理（关键，别随手改成 toBeCloseTo）
 *
 * 双精度加法不满足结合律，而**求和的分组方式在需求里是未定义的**：实现按事件分段求和
 * （每个 `usage_summary` 事件从 0 起累加出小计，再并入总计），测试侧的独立求和用单一
 * 累加器——两者在全精度随机数上末位可能相差 1 ulp。这不是谁错，是同一口径的两种合法结合。
 *
 * 因此断言强度按值域分开：
 *
 * - 与独立预期做**精确**比较的属性，数值取 0.25 的整数倍（见 {@link exactValueArb}）。
 *   这类值的任意部分和在 double 里恒精确，故分组与顺序都不影响结果，`toBe` 成立且能抓住
 *   漏加/重复加/多加一项这类真实缺陷——换成 `toBeCloseTo` 会把它们放过去。
 * - 全精度（含实测的 `147.15274264905472`）单独一条属性：**项数与事件数仍精确断言**，
 *   合计只断言到 1e-9 量级；恰有一个 credit 项时不存在分组歧义，故仍精确断言，
 *   用来钉住数值没有被四舍五入或截断。
 * - 实现对实现的差分属性（插入坏行、换行尾、重复调用）两侧分组完全相同，故一律精确断言，
 *   数值也用全精度。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fc from 'fast-check';
import * as path from 'path';

import {
  parseCreditsFromMessages,
  getCreditsFromMessages,
  getSessionCreditScopes,
  __clearCreditCacheForTest,
  type CreditFsDeps,
  type MessagesCredits,
} from '../src/credits';
import { MESSAGES_FILENAME } from '../src/session/newFormat';

/* ================================================================== *
 * 一、用量项的形态分类
 * ================================================================== */

/** research-notes 记下的实测 credit 数值，用于确认全精度数值不被四舍五入。 */
const MEASURED_CREDIT = 147.15274264905472;

/**
 * `unit` 字段的形态。
 *
 * 前四项是「不区分大小写等于 `credit`」的合格写法（实测既有 `credit` 也有 `CREDIT`）；
 * 其余是必须被排除的陷阱：`credits`（这是实测数据里 `unitPlural` 的值，误取会把复数项算进来）、
 * `token` / `request`（其它计量单位）、空串、缺失（只有 `usedTools` 的工具使用记录就是这形态）、
 * 前后带空格的 `" credit "`（相等判据是全串相等，不是 trim 后相等）、以及非字符串。
 */
type UnitForm =
  | 'credit-lower'
  | 'credit-title'
  | 'credit-upper'
  | 'credit-mixed'
  | 'credits-plural'
  | 'token'
  | 'request'
  | 'empty'
  | 'padded'
  | 'non-string'
  | 'missing';

/** 形态 → JSON 文本里 `"unit"` 的值片段；`null` 表示这一形态不写 `unit` 键。 */
const UNIT_FRAGMENT: Record<UnitForm, string | null> = {
  'credit-lower': '"credit"',
  'credit-title': '"Credit"',
  'credit-upper': '"CREDIT"',
  'credit-mixed': '"cReDiT"',
  'credits-plural': '"credits"',
  token: '"token"',
  request: '"request"',
  empty: '""',
  padded: '" credit "',
  'non-string': '42',
  missing: null,
};

/** 形态 → 是否满足「`unit` 不区分大小写等于 `credit`」（Req 4.1 的单位判据）。 */
const UNIT_IS_CREDIT: Record<UnitForm, boolean> = {
  'credit-lower': true,
  'credit-title': true,
  'credit-upper': true,
  'credit-mixed': true,
  'credits-plural': false,
  token: false,
  request: false,
  empty: false,
  padded: false,
  'non-string': false,
  missing: false,
};

const ALL_UNIT_FORMS = Object.keys(UNIT_FRAGMENT) as UnitForm[];
const CREDIT_UNIT_FORMS = ALL_UNIT_FORMS.filter((f) => UNIT_IS_CREDIT[f]);

/**
 * `usage` 字段的形态。
 *
 * 关于 NaN：**JSON 里没有 NaN 字面量**。真实数据要么把它序列化成 `null`（`JSON.stringify(NaN)`
 * 的结果，即 `usage-null` 形态），要么写出裸 `NaN` 让整行变成非法 JSON（见
 * {@link INERT_LINES} 的 `nan-literal`，由坏行容错那条属性覆盖）。经合法 JSON 能到达的
 * 非有限数只有 Infinity——`1e999` 是合法 JSON 数字，`JSON.parse` 得到 `Infinity`，
 * 这正是实现里 `isFinite` 那道闸门真正要挡的输入。
 */
type UsageForm =
  | 'finite'
  | 'negative'
  | 'zero'
  | 'measured'
  | 'infinity'
  | 'neg-infinity'
  | 'numeric-string'
  | 'null'
  | 'bool'
  | 'missing';

const ALL_USAGE_FORMS: readonly UsageForm[] = [
  'finite',
  'negative',
  'zero',
  'measured',
  'infinity',
  'neg-infinity',
  'numeric-string',
  'null',
  'bool',
  'missing',
];

/** 0.25 整数倍的精确网格：重排顺序的属性要靠它保证部分和逐位精确（见文件头说明）。 */
const exactValueArb: fc.Arbitrary<number> = fc
  .integer({ min: -400, max: 400 })
  .map((n) => normalizeZero(n / 4));

/** 全精度数值：随机 double + 若干实测量级的常量。 */
const fullValueArb: fc.Arbitrary<number> = fc.oneof(
  fc.double({ min: -500, max: 500, noNaN: true }).map(normalizeZero),
  fc.constantFrom(MEASURED_CREDIT, 737.5206366955888, 0.0097, 1, 3.5, -2.25)
);

/** 把 `-0` 归一成 `+0`：`Object.is(-0, 0)` 为假，会让 `toBe` 在零值上假失败。 */
function normalizeZero(v: number): number {
  return Object.is(v, -0) ? 0 : v;
}

/** 对象形态的用量项种子。 */
interface ObjectItemSeed {
  shape: 'object';
  unit: UnitForm;
  usage: UsageForm;
  /** 数值形态用到的基数；非数值形态忽略它。 */
  value: number;
  /** 是否带 `unitPlural`（实测项都带，且它恒不参与判据）。 */
  unitPlural: boolean;
  /** 是否带 `usedTools`（1.x 把它并进了同一项，0.9x 是另立一项）。 */
  usedTools: boolean;
}

/** 非对象形态的用量项：数组里混进标量、null、嵌套数组等，恒不该被计入。 */
type RawItemLabel = 'number' | 'string' | 'null' | 'bool' | 'nested-array' | 'empty-object';

const RAW_ITEM_TEXT: Record<RawItemLabel, string> = {
  number: '42',
  string: '"credit"',
  null: 'null',
  bool: 'true',
  // 嵌套陷阱：里面是一个"看起来合格"的 credit 项，但它在数组的第二层，恒不该被捞出来
  'nested-array': '[{"usage":8,"unit":"credit"}]',
  'empty-object': '{}',
};

const ALL_RAW_ITEM_LABELS = Object.keys(RAW_ITEM_TEXT) as RawItemLabel[];

interface RawItemSeed {
  shape: 'raw';
  label: RawItemLabel;
}

type ItemSeed = ObjectItemSeed | RawItemSeed;

/**
 * 数值片段与「参与求和的数值」一次给出。
 *
 * 文本与预期共用同一个数值，是刻意的：本测试要验的是**过滤口径**，不是浮点字面量的
 * 往返格式化。`JSON.stringify(number)` 产出最短往返表示，`JSON.parse` 取回同一个 double，
 * 因此 `counted` 与实现真正累加的值逐位相同。
 *
 * @returns `fragment` 为 `null` 表示这一形态不写 `usage` 键；`counted` 为 `null` 表示该项
 *   在「`usage` 是有限数」这一判据上不合格。
 */
function usagePart(seed: ObjectItemSeed): { fragment: string | null; counted: number | null } {
  switch (seed.usage) {
    case 'finite':
      return { fragment: JSON.stringify(seed.value), counted: seed.value };
    case 'negative': {
      // 负数按原值累加：实现只做单位过滤，不替 Kiro 校正它写下的数值
      const v = normalizeZero(-Math.abs(seed.value) - 0.25);
      return { fragment: JSON.stringify(v), counted: v };
    }
    case 'zero':
      return { fragment: '0', counted: 0 };
    case 'measured':
      return { fragment: JSON.stringify(MEASURED_CREDIT), counted: MEASURED_CREDIT };
    // 1e999 是合法 JSON 数字，JSON.parse 得到 Infinity —— 非有限数，恒不计入
    case 'infinity':
      return { fragment: '1e999', counted: null };
    case 'neg-infinity':
      return { fragment: '-1e999', counted: null };
    case 'numeric-string':
      return { fragment: JSON.stringify(String(seed.value)), counted: null };
    // JSON.stringify(NaN) 的结果就是 null：文本层能出现的 "NaN" 只有这个形态
    case 'null':
      return { fragment: 'null', counted: null };
    case 'bool':
      return { fragment: 'true', counted: null };
    case 'missing':
      return { fragment: null, counted: null };
  }
}

/** 用量项 → JSONL 里的文本片段。 */
function itemText(seed: ItemSeed): string {
  if (seed.shape === 'raw') return RAW_ITEM_TEXT[seed.label];

  const parts: string[] = [];
  const { fragment } = usagePart(seed);
  if (fragment !== null) parts.push(`"usage":${fragment}`);
  const unit = UNIT_FRAGMENT[seed.unit];
  if (unit !== null) parts.push(`"unit":${unit}`);
  if (seed.unitPlural) parts.push('"unitPlural":"credits"');
  if (seed.usedTools) parts.push('"usedTools":["read_file","grep_search"]');
  return `{${parts.join(',')}}`;
}

/**
 * 形态表驱动的独立判据（Req 4.1、4.2）：该项参与求和时返回其数值，否则返回 `null`。
 * 两个判据都要成立——`unit` 不区分大小写等于 `credit`，且 `usage` 是有限数。
 */
function itemCredit(seed: ItemSeed): number | null {
  if (seed.shape === 'raw') return null;
  if (!UNIT_IS_CREDIT[seed.unit]) return null;
  return usagePart(seed).counted;
}

/* ================================================================== *
 * 二、usage_summary 事件的形态分类
 * ================================================================== */

/**
 * 事件形态。两个用量数组承载键都要覆盖：`promptTurnSummaries` 是 1.x 实测字段名，
 * `usageSummary` 是同名兜底（0.9x 的写法）。实现**取首个存在的数组，不累加全部别名**，
 * 故 `usage-both-keys` 这一形态专门验「同一事件同时出现两个键时不被重复计入」。
 */
type EventForm =
  /** 实测主形态：`promptTurnSummaries` 承载用量项 */
  | 'usage-prompt'
  /** 同名兜底：只有 `usageSummary` 时照样取数 */
  | 'usage-legacy-key'
  /** 两个键同时出现：只算 `promptTurnSummaries`，`usageSummary` 恒不重复计入 */
  | 'usage-both-keys'
  /** 实测存在的空事件（status 为 failed 的执行）：`promptTurnSummaries: []` */
  | 'usage-empty-array'
  /** 是用量事件，但没有任何用量数组键 */
  | 'usage-no-array'
  /** 数组挂在未知键上：未知形状恒按「无用量项」处理，不去猜 */
  | 'usage-unknown-key'
  /** `promptTurnSummaries` 不是数组（而是对象）→ 顺位取 `usageSummary` */
  | 'usage-prompt-not-array'
  /** 非 usage_summary 事件，却带着形似用量的数组（含正文提到 usage_summary 字样） */
  | 'decoy-other-type';

const ALL_EVENT_FORMS: readonly EventForm[] = [
  'usage-prompt',
  'usage-legacy-key',
  'usage-both-keys',
  'usage-empty-array',
  'usage-no-array',
  'usage-unknown-key',
  'usage-prompt-not-array',
  'decoy-other-type',
];

/** 恒不贡献任何 credit 项、但仍是 usage_summary 事件的形态（不可用来源之一）。 */
const BARREN_USAGE_FORMS: readonly EventForm[] = [
  'usage-empty-array',
  'usage-no-array',
  'usage-unknown-key',
];

interface EventSeed {
  form: EventForm;
  /** 生效数组里的用量项。 */
  items: ItemSeed[];
  /** 只用于 `usage-both-keys` 的第二个键，恒不该被计入。 */
  decoyItems: ItemSeed[];
  /** 只用于 `decoy-other-type` 的 `payload.type`。 */
  decoyType: string;
}

const DECOY_TYPES = [
  'user',
  'assistant',
  'tool_call',
  'tool_result',
  'turn_end',
  'session_metadata',
] as const;

function arrayText(items: readonly ItemSeed[]): string {
  return `[${items.map(itemText).join(',')}]`;
}

/** 事件种子 → `messages.jsonl` 的一行（文本层构造，才能写出 `1e999` 这类字面量）。 */
function eventLine(seed: EventSeed, seq: number): string {
  const f: string[] = [];
  switch (seed.form) {
    case 'usage-prompt':
      f.push('"type":"usage_summary"', `"promptTurnSummaries":${arrayText(seed.items)}`);
      break;
    case 'usage-legacy-key':
      f.push('"type":"usage_summary"', `"usageSummary":${arrayText(seed.items)}`);
      break;
    case 'usage-both-keys':
      f.push(
        '"type":"usage_summary"',
        `"promptTurnSummaries":${arrayText(seed.items)}`,
        `"usageSummary":${arrayText(seed.decoyItems)}`
      );
      break;
    case 'usage-empty-array':
      f.push('"type":"usage_summary"', '"promptTurnSummaries":[]', '"status":"failed"');
      break;
    case 'usage-no-array':
      f.push('"type":"usage_summary"', '"elapsedTime":1056804', '"status":"success"');
      break;
    case 'usage-unknown-key':
      f.push('"type":"usage_summary"', `"summaries":${arrayText(seed.items)}`);
      break;
    case 'usage-prompt-not-array':
      f.push(
        '"type":"usage_summary"',
        // 非数组：合格项的形状但不在数组里，恒不该被取；999 使误取时数值极其醒目
        '"promptTurnSummaries":{"unit":"credit","usage":999}',
        `"usageSummary":${arrayText(seed.items)}`
      );
      break;
    case 'decoy-other-type':
      f.push(
        `"type":${JSON.stringify(seed.decoyType)}`,
        '"content":"a line that mentions usage_summary in its text"',
        `"promptTurnSummaries":${arrayText(seed.items)}`
      );
      break;
  }
  f.push(`"executionId":"exec-${seq}"`);
  return `{"id":"evt-${seq}","timestamp":${1_700_000_000_000 + seq},"payload":{${f.join(',')}}}`;
}

function eventLines(events: readonly EventSeed[]): string[] {
  return events.map((e, i) => eventLine(e, i));
}

/** 事件对合计的贡献：是否算一条 usage_summary 事件，以及哪个数组的项参与求和。 */
function contribution(seed: EventSeed): { isUsageEvent: boolean; counted: readonly ItemSeed[] } {
  switch (seed.form) {
    case 'usage-prompt':
    case 'usage-legacy-key':
    // 两个键并存时只有首个（promptTurnSummaries）生效
    case 'usage-both-keys':
    // 首个键不是数组时顺位取 usageSummary
    case 'usage-prompt-not-array':
      return { isUsageEvent: true, counted: seed.items };
    case 'usage-empty-array':
    case 'usage-no-array':
    case 'usage-unknown-key':
      return { isUsageEvent: true, counted: [] };
    case 'decoy-other-type':
      return { isUsageEvent: false, counted: [] };
  }
}

interface Totals {
  credits: number;
  usageSummaryCount: number;
  creditItemCount: number;
}

/** 独立预期（路径一）：形态表驱动，按事件序 + 项序累加。 */
function expectedTotals(events: readonly EventSeed[]): Totals {
  let credits = 0;
  let usageSummaryCount = 0;
  let creditItemCount = 0;
  for (const ev of events) {
    const { isUsageEvent, counted } = contribution(ev);
    if (isUsageEvent) usageSummaryCount++;
    for (const it of counted) {
      const c = itemCredit(it);
      if (c !== null) {
        credits += c;
        creditItemCount++;
      }
    }
  }
  return { credits, usageSummaryCount, creditItemCount };
}

/**
 * 独立预期（路径二）：朴素文本重算。
 * 只依赖「逐行 JSON → `usage_summary` → 首个用量数组 → `usage` 有限数且 `unit` 为 credit」
 * 这条口径，不看生成器的形态标签，因此能挡住「形态表与实现一起写错」的相关失效。
 */
function naiveSumFromText(raw: string): Totals {
  let credits = 0;
  let usageSummaryCount = 0;
  let creditItemCount = 0;

  for (const line of raw.split('\n')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== 'object') continue;
    const payload = (parsed as { payload?: unknown }).payload;
    if (payload === null || typeof payload !== 'object') continue;
    const p = payload as Record<string, unknown>;
    if (p['type'] !== 'usage_summary') continue;

    usageSummaryCount++;
    const arr = [p['promptTurnSummaries'], p['usageSummary']].find((v) => Array.isArray(v));
    if (!Array.isArray(arr)) continue;

    for (const item of arr as unknown[]) {
      if (item === null || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      const usage = rec['usage'];
      const unit = rec['unit'];
      if (typeof usage !== 'number' || !Number.isFinite(usage)) continue;
      if (typeof unit !== 'string' || unit.toLowerCase() !== 'credit') continue;
      credits += usage;
      creditItemCount++;
    }
  }
  return { credits, usageSummaryCount, creditItemCount };
}

/* ================================================================== *
 * 三、坏行 / 惰性行
 * ================================================================== */

/**
 * 插入后恒不改变任何计数的行，两类：
 * ① 真正的非法 JSON（追加写被中断的半行、裸 `NaN` / `Infinity` 字面量、纯文本）；
 * ② 合法 JSON 但结构上无法承载用量（顶层不是事件对象、payload 不是对象、type 不匹配）。
 *
 * 多数样本刻意把「合格的 credit 项」埋在不可用的结构里——若实现改成正则捞数字或
 * 递归找 `usage`，这些行会立刻污染合计。
 *
 * 全部样本不含 `\r` / `\n`：注入一行就是一行，行尾语义由其它属性单独覆盖。
 */
type InertKind =
  | 'truncated-json'
  | 'nan-literal'
  | 'not-json-text'
  | 'json-scalar'
  | 'json-array-wrapper'
  | 'payload-not-object'
  | 'object-without-payload'
  | 'blank'
  | 'lone-punctuation'
  | 'type-mismatch';

const INERT_LINES: Record<InertKind, readonly string[]> = {
  'truncated-json': [
    '{"payload":{"type":"usage_summary","promptTurnSummaries":[{"unit":"credit","usage":9',
    '{"id":"x","timestamp":1,"payload":{"type":"usage_summary",',
    '{"payload":{"type":"usage_summary","promptTurnSummaries":[{"unit":"cre',
  ],
  // JSON 没有 NaN / Infinity 字面量：真写出来整行就不是合法 JSON
  'nan-literal': [
    '{"payload":{"type":"usage_summary","promptTurnSummaries":[{"unit":"credit","usage":NaN}]}}',
    '{"payload":{"type":"usage_summary","promptTurnSummaries":[{"unit":"credit","usage":Infinity}]}}',
    '{"payload":{"type":"usage_summary","promptTurnSummaries":[{"unit":"credit","usage":undefined}]}}',
  ],
  'not-json-text': ['usage_summary', '>>> broken usage_summary <<<', 'usage_summary: 12.5 credit'],
  'json-scalar': ['42', 'null', '"usage_summary"', 'true'],
  'json-array-wrapper': [
    '[{"payload":{"type":"usage_summary","promptTurnSummaries":[{"unit":"credit","usage":9}]}}]',
    '[]',
  ],
  'payload-not-object': [
    '{"payload":"usage_summary"}',
    '{"payload":null}',
    '{"payload":42}',
    '{"payload":[{"type":"usage_summary","promptTurnSummaries":[{"unit":"credit","usage":9}]}]}',
  ],
  'object-without-payload': [
    '{}',
    '{"type":"usage_summary","promptTurnSummaries":[{"unit":"credit","usage":9}]}',
    '{"id":"x","timestamp":1}',
  ],
  blank: ['', '   ', '\t'],
  'lone-punctuation': ['{', '}', ','],
  // 类型名不是恰好 usage_summary：区分大小写、不做前缀匹配
  'type-mismatch': [
    '{"payload":{"type":"USAGE_SUMMARY","promptTurnSummaries":[{"unit":"credit","usage":9}]}}',
    '{"payload":{"type":"usage_summary_v2","promptTurnSummaries":[{"unit":"credit","usage":9}]}}',
    '{"payload":{"type":"tool_result","promptTurnSummaries":[{"unit":"credit","usage":9}]}}',
  ],
};

const ALL_INERT_KINDS = Object.keys(INERT_LINES) as InertKind[];

interface InertLine {
  kind: InertKind;
  line: string;
}

const inertLineArb: fc.Arbitrary<InertLine> = fc.constantFrom(
  ...ALL_INERT_KINDS.flatMap((kind) => INERT_LINES[kind].map((line) => ({ kind, line })))
);

/* ================================================================== *
 * 四、生成器
 * ================================================================== */

interface ItemArbOptions {
  values: fc.Arbitrary<number>;
  usageForms: readonly UsageForm[];
  unitForms?: readonly UnitForm[];
}

function objectItemArb(opts: ItemArbOptions): fc.Arbitrary<ObjectItemSeed> {
  return fc.record({
    shape: fc.constant<'object'>('object'),
    unit: fc.constantFrom(...(opts.unitForms ?? ALL_UNIT_FORMS)),
    usage: fc.constantFrom(...opts.usageForms),
    value: opts.values,
    unitPlural: fc.boolean(),
    usedTools: fc.boolean(),
  });
}

const rawItemArb: fc.Arbitrary<RawItemSeed> = fc.record({
  shape: fc.constant<'raw'>('raw'),
  label: fc.constantFrom(...ALL_RAW_ITEM_LABELS),
});

/** 用量项：对象形态占多数（权重 6:1），非对象形态作为脏数据混入。 */
function itemArb(opts: ItemArbOptions): fc.Arbitrary<ItemSeed> {
  return fc.oneof({ arbitrary: objectItemArb(opts), weight: 6 }, { arbitrary: rawItemArb, weight: 1 });
}

function itemsArb(opts: ItemArbOptions, maxLength = 5): fc.Arbitrary<ItemSeed[]> {
  return fc.array(itemArb(opts), { minLength: 0, maxLength });
}

interface EventArbOptions extends ItemArbOptions {
  forms?: readonly EventForm[];
  maxItems?: number;
}

function eventArb(opts: EventArbOptions): fc.Arbitrary<EventSeed> {
  const items = itemsArb(opts, opts.maxItems ?? 5);
  return fc.record({
    form: fc.constantFrom(...(opts.forms ?? ALL_EVENT_FORMS)),
    items,
    decoyItems: items,
    decoyType: fc.constantFrom(...DECOY_TYPES),
  });
}

/** 全精度、全形态的生成器（实现对实现的差分属性、以及全精度那条属性用）。 */
const FULL_ITEM_OPTS: ItemArbOptions = { values: fullValueArb, usageForms: ALL_USAGE_FORMS };

const eventSeqArb: fc.Arbitrary<EventSeed[]> = fc.array(eventArb(FULL_ITEM_OPTS), {
  minLength: 0,
  maxLength: 7,
});

/**
 * 精确网格生成器：排除 measured，数值恒为 0.25 的整数倍。
 * 与独立预期做精确比较、以及要重排分组/顺序的属性都用它（见文件头「浮点精度的处理」）。
 */
const EXACT_ITEM_OPTS: ItemArbOptions = {
  values: exactValueArb,
  usageForms: ALL_USAGE_FORMS.filter((f) => f !== 'measured'),
};

/** 精确网格上的事件序列：形态覆盖与 {@link eventSeqArb} 相同，只是数值落在网格上。 */
const exactEventSeqArb: fc.Arbitrary<EventSeed[]> = fc.array(eventArb(EXACT_ITEM_OPTS), {
  minLength: 0,
  maxLength: 7,
});

/** 恒有效的 credit 项（unit 取合格的四种写法之一，usage 取精确网格上的有限数）。 */
const exactCreditItemArb: fc.Arbitrary<ObjectItemSeed> = objectItemArb({
  values: exactValueArb,
  usageForms: ['finite', 'negative', 'zero'],
  unitForms: CREDIT_UNIT_FORMS,
});

/** 恒不合格的项：unit 不是 credit，或 usage 不是有限数。 */
const nonCreditItemArb: fc.Arbitrary<ItemSeed> = fc.oneof(
  objectItemArb({
    values: fullValueArb,
    usageForms: ALL_USAGE_FORMS,
    unitForms: ALL_UNIT_FORMS.filter((f) => !UNIT_IS_CREDIT[f]),
  }),
  objectItemArb({
    values: fullValueArb,
    usageForms: ['infinity', 'neg-infinity', 'numeric-string', 'null', 'bool', 'missing'],
    unitForms: ALL_UNIT_FORMS,
  }),
  rawItemArb
);

/** 承载用量数组的两个键（`usage-prompt` = 实测名，`usage-legacy-key` = 同名兜底）。 */
const CARRIER_FORMS: readonly EventForm[] = ['usage-prompt', 'usage-legacy-key'];

/** 槽位下标序列：用于「任意位置注入」——见 {@link interleave}。 */
const slotsArb = fc.array(fc.nat({ max: 64 }), { minLength: 1, maxLength: 8 });

/* ================================================================== *
 * 五、辅助
 * ================================================================== */

/**
 * 位置无关注入：把 `extras` 按槽位分桶后与 `base` 交错展开。
 * 槽 0 = 首元素之前，槽 n = 末元素之后，同槽可落多个（聚簇）。
 * 既用于往行序列里插坏行，也用于往用量数组里插非 credit 项。
 */
function interleave<T>(base: readonly T[], extras: readonly T[], slots: readonly number[]): T[] {
  const slotCount = base.length + 1;
  const buckets: T[][] = Array.from({ length: slotCount }, () => []);
  extras.forEach((x, i) => {
    const s = slots.length > 0 ? slots[i % slots.length] : 0;
    buckets[((s % slotCount) + slotCount) % slotCount].push(x);
  });
  const out: T[] = [];
  for (let i = 0; i < base.length; i++) out.push(...buckets[i], base[i]);
  out.push(...buckets[base.length]);
  return out;
}

/** 由随机键导出的确定性置换（稳定排序，键相同按原下标）。 */
function permute<T>(xs: readonly T[], keys: readonly number[]): T[] {
  return xs
    .map((x, i) => ({ x, k: keys.length > 0 ? keys[i % keys.length] : 0, i }))
    .sort((a, b) => a.k - b.k || a.i - b.i)
    .map((e) => e.x);
}

/**
 * 断言一次解析结果与独立预期一致。
 * **不可用 ≠ 0** 就钉在这里：`creditItemCount === 0` 时 `credits` 必须是 `null`、
 * `found` 必须是 `false`；有 credit 项时必须是数字（哪怕合计恰好为 0）。
 */
function expectMatchesTotals(got: MessagesCredits, exp: Totals): void {
  if (exp.creditItemCount === 0) {
    expect(got.credits).toBeNull();
    expect(got.found).toBe(false);
  } else {
    expect(got.credits).toBe(exp.credits);
    expect(got.found).toBe(true);
    expect(typeof got.credits).toBe('number');
  }
  expect(got.usageSummaryCount).toBe(exp.usageSummaryCount);
  expect(got.creditItemCount).toBe(exp.creditItemCount);
  // found 恒等于 credits !== null（两者不可能各说一套）
  expect(got.found).toBe(got.credits !== null);
}

/** 注入的只读 fs 夹具。每次调用换一个会话目录，避免进程内缓存跨用例串味。 */
let fixtureSeq = 0;
const FAKE_SESSIONS_ROOT = path.resolve('fixtures', 'kcs-fake-1x-sessions');

interface SessionFixture {
  dir: string;
  file: string;
  deps: CreditFsDeps;
  calls: string[];
}

function enoent(p: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, '${p}'`), { code: 'ENOENT' });
}

/**
 * 造一个「目录里有 messages.jsonl，内容为 raw」的注入夹具。
 * `statSync` 的 `size` 取真实字节数、`mtimeMs` 逐夹具递增，使
 * `(mtimeMs, size)` 缓存判据在测试里的行为与真实磁盘一致。
 */
function newSessionFixture(raw: string): SessionFixture {
  const seq = ++fixtureSeq;
  const dir = path.join(FAKE_SESSIONS_ROOT, `sess-${seq}`);
  const file = path.join(dir, MESSAGES_FILENAME);
  const calls: string[] = [];
  return {
    dir,
    file,
    calls,
    deps: {
      statSync: (p) => {
        calls.push(`stat:${p}`);
        if (p !== file) throw enoent(p);
        return { size: Buffer.byteLength(raw, 'utf8'), mtimeMs: 1_700_000_000_000 + seq };
      },
      readFileSync: (p) => {
        calls.push(`read:${p}`);
        if (p !== file) throw enoent(p);
        return raw;
      },
    },
  };
}

/** 造一个「messages.jsonl 不存在」的夹具（读不到 ≠ 花了 0）。 */
function missingSessionFixture(): SessionFixture {
  const seq = ++fixtureSeq;
  const dir = path.join(FAKE_SESSIONS_ROOT, `missing-${seq}`);
  const calls: string[] = [];
  return {
    dir,
    file: path.join(dir, MESSAGES_FILENAME),
    calls,
    deps: {
      statSync: (p) => {
        calls.push(`stat:${p}`);
        throw enoent(p);
      },
      readFileSync: (p) => {
        calls.push(`read:${p}`);
        throw enoent(p);
      },
    },
  };
}

beforeEach(() => {
  // 1.x 用量缓存也在其中（__clearCreditCacheForTest 覆盖两代缓存）
  __clearCreditCacheForTest();
});

/* ================================================================== *
 * Property 8 —— 求和口径
 * ================================================================== */

// Feature: kiro-1x-storage-adaptation, Property 8: 用量求和口径
// Validates: Requirements 4.1, 4.2, 4.3
describe('Property 8: 用量求和口径', () => {
  // Feature: kiro-1x-storage-adaptation, Property 8: 用量求和口径
  // Validates: Requirements 4.1, 4.2
  it('Property 8: 合计恒等于独立求和——只累加 unit 为 credit（不分大小写）且 usage 为有限数的项', () => {
    fc.assert(
      fc.property(exactEventSeqArb, (events) => {
        const raw = eventLines(events).join('\n');
        const got = parseCreditsFromMessages(raw);
        const exp = expectedTotals(events);

        // 路径一：形态表驱动的预期
        expectMatchesTotals(got, exp);

        // 路径二：朴素文本重算（独立于生成器的形态标签）
        const naive = naiveSumFromText(raw);
        expect(naive.creditItemCount).toBe(exp.creditItemCount);
        expect(naive.usageSummaryCount).toBe(exp.usageSummaryCount);
        expect(naive.credits).toBe(exp.credits);
      }),
      { numRuns: 300 }
    );
  });

  // Feature: kiro-1x-storage-adaptation, Property 8: 用量求和口径
  // Validates: Requirements 4.1, 4.2
  it('Property 8: 全精度数值下项数与事件数恒精确、合计恒在 1e-9 内，单项时恒逐位相等（不被四舍五入）', () => {
    fc.assert(
      fc.property(eventSeqArb, (events) => {
        const raw = eventLines(events).join('\n');
        const got = parseCreditsFromMessages(raw);
        const exp = expectedTotals(events);
        const naive = naiveSumFromText(raw);

        // 「哪些项参与」是精确断言的部分——口径本身不容许任何偏差
        expect(got.usageSummaryCount).toBe(exp.usageSummaryCount);
        expect(got.creditItemCount).toBe(exp.creditItemCount);
        expect(naive.creditItemCount).toBe(exp.creditItemCount);
        expect(got.found).toBe(exp.creditItemCount > 0);
        expect(got.found).toBe(got.credits !== null);

        if (exp.creditItemCount === 0) {
          expect(got.credits).toBeNull();
          return;
        }
        // 恰一项时无分组歧义：逐位相等，钉住数值未被四舍五入 / 截断
        if (exp.creditItemCount === 1) {
          expect(got.credits).toBe(exp.credits);
          expect(naive.credits).toBe(exp.credits);
          return;
        }
        // 多项：实现按事件分段求和、预期用单一累加器，双精度下允许末位差异
        expect(got.credits as number).toBeCloseTo(exp.credits, 9);
        expect(naive.credits).toBeCloseTo(exp.credits, 9);
      }),
      { numRuns: 300 }
    );
  });

  // Feature: kiro-1x-storage-adaptation, Property 8: 用量求和口径
  // Validates: Requirements 4.2
  it('Property 8: 在用量数组任意位置插入任意数量非 credit 项，合计与 creditItemCount 恒不变', () => {
    fc.assert(
      fc.property(
        fc.array(exactCreditItemArb, { minLength: 0, maxLength: 6 }),
        fc.array(nonCreditItemArb, { minLength: 1, maxLength: 8 }),
        slotsArb,
        fc.constantFrom(...CARRIER_FORMS),
        (creditItems, junk, slots, form) => {
          const base: EventSeed = { form, items: [...creditItems], decoyItems: [], decoyType: 'user' };
          const polluted: EventSeed = {
            form,
            items: interleave(creditItems, junk, slots),
            decoyItems: [],
            decoyType: 'user',
          };

          const before = parseCreditsFromMessages(eventLines([base]).join('\n'));
          const after = parseCreditsFromMessages(eventLines([polluted]).join('\n'));

          expect(after.credits).toBe(before.credits);
          expect(after.found).toBe(before.found);
          expect(after.creditItemCount).toBe(before.creditItemCount);
          expect(after.usageSummaryCount).toBe(before.usageSummaryCount);
          // 前置：注入的确实全是不合格项（否则这条属性没在测该风险）
          expect(junk.every((it) => itemCredit(it) === null)).toBe(true);
        }
      ),
      { numRuns: 200 }
    );
  });

  // Feature: kiro-1x-storage-adaptation, Property 8: 用量求和口径
  // Validates: Requirements 4.1, 4.2
  it('Property 8: 同一事件同时出现 promptTurnSummaries 与 usageSummary 时，恒只计入前者', () => {
    fc.assert(
      fc.property(
        fc.array(exactCreditItemArb, { minLength: 0, maxLength: 5 }),
        fc.array(exactCreditItemArb, { minLength: 1, maxLength: 5 }),
        (primary, secondary) => {
          const both: EventSeed = {
            form: 'usage-both-keys',
            items: [...primary],
            decoyItems: [...secondary],
            decoyType: 'user',
          };
          const onlyPrimary: EventSeed = {
            form: 'usage-prompt',
            items: [...primary],
            decoyItems: [],
            decoyType: 'user',
          };

          const got = parseCreditsFromMessages(eventLines([both]).join('\n'));
          const expected = parseCreditsFromMessages(eventLines([onlyPrimary]).join('\n'));

          expect(got.credits).toBe(expected.credits);
          expect(got.creditItemCount).toBe(expected.creditItemCount);
          expect(got.usageSummaryCount).toBe(1);

          // 别名不被累加：项数恒等于首个数组的项数，而不是两个数组之和
          expect(got.creditItemCount).toBe(primary.length);
          expect(got.creditItemCount).not.toBe(primary.length + secondary.length);
        }
      ),
      { numRuns: 200 }
    );
  });

  // Feature: kiro-1x-storage-adaptation, Property 8: 用量求和口径
  // Validates: Requirements 4.1
  it('Property 8: 两种承载键（promptTurnSummaries / usageSummary）对同一组用量项恒得同一合计', () => {
    fc.assert(
      fc.property(itemsArb(EXACT_ITEM_OPTS, 6), (items) => {
        const asPrompt = parseCreditsFromMessages(
          eventLines([{ form: 'usage-prompt', items, decoyItems: [], decoyType: 'user' }]).join('\n')
        );
        const asLegacy = parseCreditsFromMessages(
          eventLines([{ form: 'usage-legacy-key', items, decoyItems: [], decoyType: 'user' }]).join(
            '\n'
          )
        );

        expect(asLegacy.credits).toBe(asPrompt.credits);
        expect(asLegacy.found).toBe(asPrompt.found);
        expect(asLegacy.creditItemCount).toBe(asPrompt.creditItemCount);
        expect(asLegacy.usageSummaryCount).toBe(asPrompt.usageSummaryCount);
      }),
      { numRuns: 200 }
    );
  });
});

/* ================================================================== *
 * Property 8 —— 不可用 ≠ 0
 * ================================================================== */

// Feature: kiro-1x-storage-adaptation, Property 8: 用量求和口径
// Validates: Requirements 4.1, 4.2, 4.3
describe('Property 8: 不可用与零的区分', () => {
  // Feature: kiro-1x-storage-adaptation, Property 8: 用量求和口径
  // Validates: Requirements 4.1
  it('Property 8: 完全没有 usage_summary 事件时，credits 恒为 null、found 恒为 false、事件数恒为 0', () => {
    fc.assert(
      fc.property(
        fc.array(
          eventArb({ ...FULL_ITEM_OPTS, forms: ['decoy-other-type'] }),
          { minLength: 0, maxLength: 6 }
        ),
        fc.array(inertLineArb, { minLength: 0, maxLength: 6 }),
        slotsArb,
        (decoys, inert, slots) => {
          const lines = interleave(
            eventLines(decoys),
            inert.map((i) => i.line),
            slots
          );
          const got = parseCreditsFromMessages(lines.join('\n'));

          expect(got.credits).toBeNull();
          expect(got.found).toBe(false);
          expect(got.usageSummaryCount).toBe(0);
          expect(got.creditItemCount).toBe(0);
        }
      ),
      { numRuns: 200 }
    );
  });

  // Feature: kiro-1x-storage-adaptation, Property 8: 用量求和口径
  // Validates: Requirements 4.1, 4.2
  it('Property 8: 有 usage_summary 事件但无 credit 项时，credits 恒为 null 而事件数恒 > 0（含 promptTurnSummaries: [] 的空事件）', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            // 空数组 / 无数组 / 未知键：事件在、项为零
            eventArb({ ...FULL_ITEM_OPTS, forms: BARREN_USAGE_FORMS }),
            // 有数组但项全不合格
            fc.record({
              form: fc.constantFrom(...CARRIER_FORMS),
              items: fc.array(nonCreditItemArb, { minLength: 1, maxLength: 5 }),
              decoyItems: fc.constant<ItemSeed[]>([]),
              decoyType: fc.constant('user'),
            })
          ),
          { minLength: 1, maxLength: 6 }
        ),
        fc.array(inertLineArb, { minLength: 0, maxLength: 4 }),
        slotsArb,
        (events, inert, slots) => {
          const lines = interleave(
            eventLines(events),
            inert.map((i) => i.line),
            slots
          );
          const got = parseCreditsFromMessages(lines.join('\n'));

          // 不可用：null 而不是 0 —— UI 据此省略角标，而不是显示「花了 0」
          expect(got.credits).toBeNull();
          expect(got.found).toBe(false);
          expect(got.creditItemCount).toBe(0);
          // 事件确实被识别到了（区别于「一条用量事件都没有」）
          expect(got.usageSummaryCount).toBe(events.length);
        }
      ),
      { numRuns: 200 }
    );
  });

  // Feature: kiro-1x-storage-adaptation, Property 8: 用量求和口径
  // Validates: Requirements 4.1, 4.2
  it('Property 8: credit 项的 usage 全为 0 时，credits 恒为 0 且 found 恒为 true（确实花了 0，不是不可用）', () => {
    fc.assert(
      fc.property(
        fc.array(
          objectItemArb({ values: fc.constant(0), usageForms: ['zero'], unitForms: CREDIT_UNIT_FORMS }),
          { minLength: 1, maxLength: 6 }
        ),
        fc.array(nonCreditItemArb, { minLength: 0, maxLength: 5 }),
        slotsArb,
        fc.constantFrom(...CARRIER_FORMS),
        (zeros, junk, slots, form) => {
          const items = interleave(zeros, junk, slots);
          const got = parseCreditsFromMessages(
            eventLines([{ form, items, decoyItems: [], decoyType: 'user' }]).join('\n')
          );

          expect(got.credits).toBe(0);
          expect(got.credits).not.toBeNull();
          expect(got.found).toBe(true);
          expect(got.creditItemCount).toBe(zeros.length);
        }
      ),
      { numRuns: 200 }
    );
  });

  // Feature: kiro-1x-storage-adaptation, Property 8: 用量求和口径
  // Validates: Requirements 4.1, 4.3
  it('Property 8: 恰有 credit 项时 credits 恒为数字、found 恒为 true；缺 messages.jsonl 恒为不可用', () => {
    fc.assert(
      fc.property(
        fc.array(exactCreditItemArb, { minLength: 1, maxLength: 6 }),
        fc.constantFrom(...CARRIER_FORMS),
        (creditItems, form) => {
          const raw = eventLines([
            { form, items: [...creditItems], decoyItems: [], decoyType: 'user' },
          ]).join('\n');

          const fixture = newSessionFixture(raw);
          const viaReader = getCreditsFromMessages(fixture.dir, fixture.deps);
          expect(typeof viaReader.credits).toBe('number');
          expect(viaReader.found).toBe(true);
          // 带缓存的读取与纯解析恒同值（缓存不改变口径）
          expect(viaReader.credits).toBe(parseCreditsFromMessages(raw).credits);

          // 文件缺失：不可用而不是 0，且不抛异常
          const missing = missingSessionFixture();
          const gone = getCreditsFromMessages(missing.dir, missing.deps);
          expect(gone.credits).toBeNull();
          expect(gone.found).toBe(false);
          expect(gone.usageSummaryCount).toBe(0);
          expect(gone.creditItemCount).toBe(0);
        }
      ),
      { numRuns: 150 }
    );
  });
});

/* ================================================================== *
 * Property 8 —— 1.x 双口径同值（design D4）
 * ================================================================== */

// Feature: kiro-1x-storage-adaptation, Property 8: 用量求和口径
// Validates: Requirements 4.3
describe('Property 8: 1.x 双口径同值', () => {
  // Feature: kiro-1x-storage-adaptation, Property 8: 用量求和口径
  // Validates: Requirements 4.3
  it('Property 8: getSessionCreditScopes({format:"new"}) 的 self 恒等于 lineage', () => {
    fc.assert(
      fc.property(eventSeqArb, (events) => {
        const raw = eventLines(events).join('\n');
        const fixture = newSessionFixture(raw);

        const scoped = getSessionCreditScopes({
          format: 'new',
          sessionDir: fixture.dir,
          deps: fixture.deps,
        });

        // 同值：null 与 null 也算相等（toBe 走 Object.is）
        expect(scoped.self).toBe(scoped.lineage);
        expect(scoped.format).toBe('new');
        expect(scoped.found).toBe(scoped.self !== null);

        // 与消息流解析结果同值：口径不因走 scopes 分派而改变
        const pure = parseCreditsFromMessages(raw);
        expect(scoped.self).toBe(pure.credits);
        expect(scoped.lineage).toBe(pure.credits);

        // 不可用恒映射为 null，绝不落成 0
        if (!pure.found) {
          expect(scoped.self).toBeNull();
          expect(scoped.lineage).toBeNull();
          expect(scoped.found).toBe(false);
        }
      }),
      { numRuns: 200 }
    );
  });

  // Feature: kiro-1x-storage-adaptation, Property 8: 用量求和口径
  // Validates: Requirements 4.3
  it('Property 8: Σ 开关（self ↔ lineage）在 1.x 上恒不改变数值，且缺文件时两口径同为 null', () => {
    fc.assert(
      fc.property(eventSeqArb, (events) => {
        const raw = eventLines(events).join('\n');
        const fixture = newSessionFixture(raw);
        const target = { format: 'new' as const, sessionDir: fixture.dir, deps: fixture.deps };

        // 连续两次取数（第二次走缓存）：两个口径的四个数值恒两两相等
        const first = getSessionCreditScopes(target);
        const second = getSessionCreditScopes(target);
        for (const v of [first.self, first.lineage, second.self, second.lineage]) {
          expect(v).toBe(first.self);
        }
        expect(second.found).toBe(first.found);

        // 入参未被改动
        expect(target.sessionDir).toBe(fixture.dir);
        expect(target.format).toBe('new');

        const missing = missingSessionFixture();
        const gone = getSessionCreditScopes({
          format: 'new',
          sessionDir: missing.dir,
          deps: missing.deps,
        });
        expect(gone.self).toBe(gone.lineage);
        expect(gone.self).toBeNull();
        expect(gone.found).toBe(false);
        expect(gone.format).toBe('new');
      }),
      { numRuns: 150 }
    );
  });
});

/* ================================================================== *
 * Property 8 —— 可加性与顺序无关
 * ================================================================== */

// Feature: kiro-1x-storage-adaptation, Property 8: 用量求和口径
// Validates: Requirements 4.1, 4.2
describe('Property 8: 可加性与顺序无关', () => {
  // Feature: kiro-1x-storage-adaptation, Property 8: 用量求和口径
  // Validates: Requirements 4.1
  it('Property 8: 用量项在多个 usage_summary 事件间任意重新分布，合计与 creditItemCount 恒不变', () => {
    fc.assert(
      fc.property(
        fc.array(itemArb(EXACT_ITEM_OPTS), { minLength: 0, maxLength: 12 }),
        fc.array(fc.nat({ max: 5 }), { minLength: 1, maxLength: 12 }),
        fc.integer({ min: 1, max: 6 }),
        fc.array(fc.constantFrom(...CARRIER_FORMS), { minLength: 1, maxLength: 6 }),
        (items, assignment, bucketCount, carriers) => {
          // 基线：全部项挤在一个事件里
          const single: EventSeed[] = [
            { form: 'usage-prompt', items: [...items], decoyItems: [], decoyType: 'user' },
          ];

          // 变体：每项按 assignment 落到 bucketCount 个事件之一，承载键也逐事件切换
          const buckets: ItemSeed[][] = Array.from({ length: bucketCount }, () => []);
          items.forEach((it, i) => buckets[assignment[i % assignment.length] % bucketCount].push(it));
          const spread: EventSeed[] = buckets.map((bucket, i) => ({
            form: carriers[i % carriers.length],
            items: bucket,
            decoyItems: [],
            decoyType: 'user',
          }));

          const one = parseCreditsFromMessages(eventLines(single).join('\n'));
          const many = parseCreditsFromMessages(eventLines(spread).join('\n'));

          expect(many.credits).toBe(one.credits);
          expect(many.found).toBe(one.found);
          expect(many.creditItemCount).toBe(one.creditItemCount);
          // 事件数按分布变化（这是唯一允许变的量）
          expect(one.usageSummaryCount).toBe(1);
          expect(many.usageSummaryCount).toBe(bucketCount);
        }
      ),
      { numRuns: 200 }
    );
  });

  // Feature: kiro-1x-storage-adaptation, Property 8: 用量求和口径
  // Validates: Requirements 4.1
  it('Property 8: 事件顺序任意打乱，合计与两个计数恒不变', () => {
    fc.assert(
      fc.property(
        fc.array(eventArb(EXACT_ITEM_OPTS), { minLength: 0, maxLength: 7 }),
        fc.array(fc.nat({ max: 32 }), { minLength: 1, maxLength: 8 }),
        (events, keys) => {
          const before = parseCreditsFromMessages(eventLines(events).join('\n'));
          const after = parseCreditsFromMessages(eventLines(permute(events, keys)).join('\n'));

          expect(after.credits).toBe(before.credits);
          expect(after.found).toBe(before.found);
          expect(after.creditItemCount).toBe(before.creditItemCount);
          expect(after.usageSummaryCount).toBe(before.usageSummaryCount);
        }
      ),
      { numRuns: 200 }
    );
  });

  // Feature: kiro-1x-storage-adaptation, Property 8: 用量求和口径
  // Validates: Requirements 4.1
  it('Property 8: 追加新事件恒只增不减——合计恒等于旧合计加新增部分', () => {
    fc.assert(
      fc.property(
        fc.array(eventArb(EXACT_ITEM_OPTS), { minLength: 0, maxLength: 5 }),
        fc.array(eventArb(EXACT_ITEM_OPTS), { minLength: 1, maxLength: 5 }),
        (base, appended) => {
          const before = parseCreditsFromMessages(eventLines(base).join('\n'));
          const addedOnly = parseCreditsFromMessages(eventLines(appended).join('\n'));
          const after = parseCreditsFromMessages(eventLines([...base, ...appended]).join('\n'));

          expect(after.creditItemCount).toBe(before.creditItemCount + addedOnly.creditItemCount);
          expect(after.usageSummaryCount).toBe(
            before.usageSummaryCount + addedOnly.usageSummaryCount
          );
          // 可加性受「不可用 ≠ 0」约束：两半都不可用时和恒为 null，不能塌成 0
          const bothUnavailable = !before.found && !addedOnly.found;
          expect(after.credits).toBe(
            bothUnavailable ? null : (before.credits ?? 0) + (addedOnly.credits ?? 0)
          );
          // 可用性单调：一旦有过 credit 项，追加后恒不回落到不可用
          expect(after.found).toBe(!bothUnavailable);
        }
      ),
      { numRuns: 200 }
    );
  });
});

/* ================================================================== *
 * Property 8 —— 坏行容错与纯函数性
 * ================================================================== */

// Feature: kiro-1x-storage-adaptation, Property 8: 用量求和口径
// Validates: Requirements 4.1, 4.2
describe('Property 8: 坏行容错与纯函数性', () => {
  // Feature: kiro-1x-storage-adaptation, Property 8: 用量求和口径
  // Validates: Requirements 4.1
  it('Property 8: 任意位置插入任意数量坏行，合计与两个计数恒与不插入时相等', () => {
    fc.assert(
      fc.property(eventSeqArb, fc.array(inertLineArb, { minLength: 0, maxLength: 8 }), slotsArb, (
        events,
        inert,
        slots
      ) => {
        const legal = eventLines(events);
        const before = parseCreditsFromMessages(legal.join('\n'));
        const after = parseCreditsFromMessages(
          interleave(
            legal,
            inert.map((i) => i.line),
            slots
          ).join('\n')
        );

        expect(after.credits).toBe(before.credits);
        expect(after.found).toBe(before.found);
        expect(after.creditItemCount).toBe(before.creditItemCount);
        expect(after.usageSummaryCount).toBe(before.usageSummaryCount);
      }),
      { numRuns: 200 }
    );
  });

  // Feature: kiro-1x-storage-adaptation, Property 8: 用量求和口径
  // Validates: Requirements 4.1
  it('Property 8: 行尾无关——\\n 与 \\r\\n、末尾多余空行恒不改变结果', () => {
    fc.assert(
      fc.property(eventSeqArb, fc.array(inertLineArb, { minLength: 0, maxLength: 4 }), slotsArb, (
        events,
        inert,
        slots
      ) => {
        const lines = interleave(
          eventLines(events),
          inert.map((i) => i.line),
          slots
        );
        const lf = parseCreditsFromMessages(lines.join('\n'));

        for (const variant of [
          lines.join('\r\n'),
          lines.join('\n') + '\n',
          lines.join('\r\n') + '\r\n',
          lines.join('\n') + '\n\r\n',
        ]) {
          const got = parseCreditsFromMessages(variant);
          expect(got.credits).toBe(lf.credits);
          expect(got.found).toBe(lf.found);
          expect(got.creditItemCount).toBe(lf.creditItemCount);
          expect(got.usageSummaryCount).toBe(lf.usageSummaryCount);
        }
      }),
      { numRuns: 150 }
    );
  });

  // Feature: kiro-1x-storage-adaptation, Property 8: 用量求和口径
  // Validates: Requirements 4.1, 4.2
  it('Property 8: 纯函数——同输入恒同输出、入参不被改动、返回对象互不共享', () => {
    fc.assert(
      fc.property(eventSeqArb, (events) => {
        const raw = eventLines(events).join('\n');
        const snapshot = String(raw);

        const first = parseCreditsFromMessages(raw);
        // 中间穿插其它输入：若实现藏了模块级可变状态，这里会暴露
        parseCreditsFromMessages(
          '{"payload":{"type":"usage_summary","promptTurnSummaries":[{"unit":"credit","usage":123.5}]}}'
        );
        parseCreditsFromMessages('');
        const second = parseCreditsFromMessages(raw);

        expect(second.credits).toBe(first.credits);
        expect(second.found).toBe(first.found);
        expect(second.creditItemCount).toBe(first.creditItemCount);
        expect(second.usageSummaryCount).toBe(first.usageSummaryCount);

        // 入参字符串未被改动；返回的是彼此独立的新对象
        expect(raw).toBe(snapshot);
        expect(second).not.toBe(first);
      }),
      { numRuns: 200 }
    );
  });

  // Feature: kiro-1x-storage-adaptation, Property 8: 用量求和口径
  // Validates: Requirements 4.1
  it('Property 8: 改动上一次返回值恒不污染缓存——缓存命中结果与首次解析恒同值', () => {
    fc.assert(
      fc.property(eventSeqArb, (events) => {
        const raw = eventLines(events).join('\n');
        const expected = parseCreditsFromMessages(raw);
        const fixture = newSessionFixture(raw);

        const first = getCreditsFromMessages(fixture.dir, fixture.deps);
        expect(first.credits).toBe(expected.credits);

        // 调用方改动返回值（UI 层常见的就地改写）
        (first as { credits: number | null }).credits = 999_999;
        (first as { found: boolean }).found = true;

        const second = getCreditsFromMessages(fixture.dir, fixture.deps);
        expect(second.credits).toBe(expected.credits);
        expect(second.found).toBe(expected.found);
        expect(second.creditItemCount).toBe(expected.creditItemCount);
        expect(second).not.toBe(first);

        // 第二次走 (mtimeMs, size) 缓存：文件只被读过一次，口径不因缓存而变
        expect(fixture.calls.filter((c) => c.startsWith('read:')).length).toBe(1);
      }),
      { numRuns: 150 }
    );
  });
});

/* ================================================================== *
 * 覆盖度守卫
 * ================================================================== */

/** 覆盖度采样用固定 seed：守卫本身必须是确定性的，不能偶发漏采。 */
const COVERAGE_SAMPLE = { numRuns: 1200, seed: 20_260_607 } as const;

// Feature: kiro-1x-storage-adaptation, Property 8: 用量求和口径
// Validates: Requirements 4.1, 4.2, 4.3
describe('Property 8: 生成器覆盖度守卫', () => {
  // Feature: kiro-1x-storage-adaptation, Property 8: 用量求和口径
  // Validates: Requirements 4.1, 4.2
  it('覆盖度: unit 形态表齐全（含大小写变体、token/request、空串、缺失），且合格集合恰为四种 credit 写法', () => {
    expect(new Set(ALL_UNIT_FORMS)).toEqual(
      new Set<UnitForm>([
        'credit-lower',
        'credit-title',
        'credit-upper',
        'credit-mixed',
        'credits-plural',
        'token',
        'request',
        'empty',
        'padded',
        'non-string',
        'missing',
      ])
    );
    // 合格集合：恰为不区分大小写等于 credit 的四种写法
    expect(new Set(CREDIT_UNIT_FORMS)).toEqual(
      new Set<UnitForm>(['credit-lower', 'credit-title', 'credit-upper', 'credit-mixed'])
    );
    // 形态表与判据自洽：合格 ⇔ 片段是字符串且小写后等于 credit
    for (const form of ALL_UNIT_FORMS) {
      const frag = UNIT_FRAGMENT[form];
      const isCreditText =
        frag !== null && frag.startsWith('"') && frag.slice(1, -1).toLowerCase() === 'credit';
      expect(UNIT_IS_CREDIT[form]).toBe(isCreditText);
    }

    // 生成器确实产出每一种 unit 形态
    const sampled = new Set(
      fc
        .sample(objectItemArb(FULL_ITEM_OPTS), COVERAGE_SAMPLE)
        .map((it) => it.unit)
    );
    expect(sampled).toEqual(new Set(ALL_UNIT_FORMS));
  });

  // Feature: kiro-1x-storage-adaptation, Property 8: 用量求和口径
  // Validates: Requirements 4.1, 4.2
  it('覆盖度: usage 形态齐全（含 Infinity、数字字符串、null=NaN 序列化形态、缺失、负数、零），且合格集合恰为有限数形态', () => {
    const sampled = new Set(
      fc.sample(objectItemArb(FULL_ITEM_OPTS), COVERAGE_SAMPLE).map((it) => it.usage)
    );
    expect(sampled).toEqual(new Set(ALL_USAGE_FORMS));

    // 合格 ⇔ 形态落在四种有限数写法上
    const seed = (usage: UsageForm): ObjectItemSeed => ({
      shape: 'object',
      unit: 'credit-lower',
      usage,
      value: 12.5,
      unitPlural: true,
      usedTools: true,
    });
    const finiteForms = ALL_USAGE_FORMS.filter((f) => usagePart(seed(f)).counted !== null);
    expect(new Set(finiteForms)).toEqual(
      new Set<UsageForm>(['finite', 'negative', 'zero', 'measured'])
    );

    // 不合格形态确实以「文本层可达」的方式被写出，并被实现排除
    for (const form of ALL_USAGE_FORMS.filter((f) => !finiteForms.includes(f))) {
      const line = eventLines([
        { form: 'usage-prompt', items: [seed(form)], decoyItems: [], decoyType: 'user' },
      ]).join('\n');
      const got = parseCreditsFromMessages(line);
      expect(got.usageSummaryCount).toBe(1); // 事件被识别
      expect(got.creditItemCount).toBe(0); // 但项不合格
      expect(got.credits).toBeNull();
    }

    // 1e999 确实是合法 JSON 且解析为 Infinity（该形态的前提）
    expect(JSON.parse('{"usage":1e999}').usage).toBe(Infinity);
    // 而裸 NaN 不是合法 JSON —— 故 NaN 形态只能由坏行覆盖
    expect(() => JSON.parse('{"usage":NaN}')).toThrow();
    // JSON.stringify(NaN) 落成 null，即 'null' 形态
    expect(JSON.stringify({ usage: NaN })).toBe('{"usage":null}');
  });

  // Feature: kiro-1x-storage-adaptation, Property 8: 用量求和口径
  // Validates: Requirements 4.1, 4.2
  it('覆盖度: 事件形态齐全（两种承载键、双键并存、空数组事件、非数组、未知键、非用量事件）', () => {
    const sampled = new Set(fc.sample(eventArb(FULL_ITEM_OPTS), COVERAGE_SAMPLE).map((e) => e.form));
    expect(sampled).toEqual(new Set(ALL_EVENT_FORMS));

    // 空数组事件的文本形态就是实测到的 promptTurnSummaries: []
    const emptyLine = eventLines([
      { form: 'usage-empty-array', items: [], decoyItems: [], decoyType: 'user' },
    ])[0];
    expect(emptyLine).toContain('"promptTurnSummaries":[]');
    const emptyGot = parseCreditsFromMessages(emptyLine);
    expect(emptyGot.usageSummaryCount).toBe(1);
    expect(emptyGot.credits).toBeNull();
    expect(emptyGot.found).toBe(false);

    // 两个承载键都在生成的文本里真实出现过
    const texts = ALL_EVENT_FORMS.map((form) =>
      eventLines([{ form, items: [], decoyItems: [], decoyType: 'user' }])[0]
    ).join('\n');
    expect(texts).toContain('"promptTurnSummaries"');
    expect(texts).toContain('"usageSummary"');
    expect(texts).toContain('"summaries"');

    // 非对象项样本齐全
    expect(new Set(ALL_RAW_ITEM_LABELS)).toEqual(
      new Set<RawItemLabel>(['number', 'string', 'null', 'bool', 'nested-array', 'empty-object'])
    );
  });

  // Feature: kiro-1x-storage-adaptation, Property 8: 用量求和口径
  // Validates: Requirements 4.1
  it('覆盖度: 主生成器同时产出两种不可用来源（完全无事件 / 有事件但无 credit 项）与可用结果', () => {
    const samples = fc.sample(eventSeqArb, COVERAGE_SAMPLE).map((events) => {
      const got = parseCreditsFromMessages(eventLines(events).join('\n'));
      return { got, events };
    });

    // 来源一：完全没有 usage_summary 事件
    expect(
      samples.some((s) => !s.got.found && s.got.usageSummaryCount === 0)
    ).toBe(true);
    // 来源二：有事件但一个 credit 项都没有
    expect(
      samples.some((s) => !s.got.found && s.got.usageSummaryCount > 0)
    ).toBe(true);
    // 可用结果也占相当比例（否则前面几条属性等于在空集上恒真）
    expect(samples.filter((s) => s.got.found).length).toBeGreaterThan(samples.length / 10);
    // 其中确实出现过非零合计
    expect(samples.some((s) => s.got.found && s.got.credits !== 0)).toBe(true);
    // 空事件（promptTurnSummaries: []）确实被采到
    expect(samples.some((s) => s.events.some((e) => e.form === 'usage-empty-array'))).toBe(true);
  });

  // Feature: kiro-1x-storage-adaptation, Property 8: 用量求和口径
  // Validates: Requirements 4.1
  it('覆盖度: 坏行样本表齐全，且每个样本单独插入任意槽位都不改变任何计数（穷举）', () => {
    expect(new Set(ALL_INERT_KINDS)).toEqual(
      new Set<InertKind>([
        'truncated-json',
        'nan-literal',
        'not-json-text',
        'json-scalar',
        'json-array-wrapper',
        'payload-not-object',
        'object-without-payload',
        'blank',
        'lone-punctuation',
        'type-mismatch',
      ])
    );
    for (const kind of ALL_INERT_KINDS) {
      expect(INERT_LINES[kind].length).toBeGreaterThan(0);
      for (const line of INERT_LINES[kind]) expect(line).not.toMatch(/[\r\n]/);
    }
    expect(new Set(fc.sample(inertLineArb, COVERAGE_SAMPLE).map((i) => i.kind))).toEqual(
      new Set(ALL_INERT_KINDS)
    );

    // 穷举：固定夹具 × 每个坏行样本 × 每个槽位，四项计数恒不变
    const fixture: EventSeed[] = [
      {
        form: 'usage-prompt',
        items: [
          {
            shape: 'object',
            unit: 'credit-lower',
            usage: 'measured',
            value: MEASURED_CREDIT,
            unitPlural: true,
            usedTools: true,
          },
          { shape: 'object', unit: 'token', usage: 'finite', value: 3, unitPlural: false, usedTools: false },
        ],
        decoyItems: [],
        decoyType: 'user',
      },
      { form: 'usage-empty-array', items: [], decoyItems: [], decoyType: 'user' },
      { form: 'decoy-other-type', items: [], decoyItems: [], decoyType: 'tool_result' },
    ];
    const legal = eventLines(fixture);
    const baseline = parseCreditsFromMessages(legal.join('\n'));
    // 前置：夹具本身给出一个可用的、来自实测数值的合计
    expect(baseline.credits).toBe(MEASURED_CREDIT);
    expect(baseline.found).toBe(true);
    expect(baseline.usageSummaryCount).toBe(2);
    expect(baseline.creditItemCount).toBe(1);

    for (const kind of ALL_INERT_KINDS) {
      for (const line of INERT_LINES[kind]) {
        for (let slot = 0; slot <= legal.length; slot++) {
          const got = parseCreditsFromMessages(interleave(legal, [line], [slot]).join('\n'));
          expect(got.credits).toBe(baseline.credits);
          expect(got.found).toBe(baseline.found);
          expect(got.usageSummaryCount).toBe(baseline.usageSummaryCount);
          expect(got.creditItemCount).toBe(baseline.creditItemCount);
        }
      }
    }
  });

  // Feature: kiro-1x-storage-adaptation, Property 8: 用量求和口径
  // Validates: Requirements 4.1
  it('覆盖度: 精确网格数值恒落在 0.25 倍数上且分组/顺序无关，精确断言因此成立', () => {
    const values = fc.sample(exactValueArb, COVERAGE_SAMPLE);
    for (const v of values) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v * 4).toBe(Math.round(v * 4)); // 恒为 0.25 的整数倍
      expect(Math.abs(v)).toBeLessThanOrEqual(100);
    }

    // 顺序无关：正序与逆序求和逐位相等
    const head = values.slice(0, 24);
    const asc = head.reduce((a, b) => a + b, 0);
    const desc = [...head].reverse().reduce((a, b) => a + b, 0);
    expect(desc).toBe(asc);

    // 分组无关：单一累加器 vs 分段小计再合并，逐位相等
    //（实现按事件分段求和，故这一条正是精确断言得以成立的依据）
    const segmented = [head.slice(0, 7), head.slice(7, 15), head.slice(15)].reduce(
      (acc, seg) => acc + seg.reduce((a, b) => a + b, 0),
      0
    );
    expect(segmented).toBe(asc);

    // 精确网格事件序列仍覆盖全部 unit 形态，且数值恒在网格上、恒不含 measured 形态
    const seqs = fc.sample(exactEventSeqArb, COVERAGE_SAMPLE);
    const units = new Set<UnitForm>();
    for (const events of seqs) {
      for (const item of [...events.flatMap((e) => e.items), ...events.flatMap((e) => e.decoyItems)]) {
        if (item.shape !== 'object') continue;
        units.add(item.unit);
        expect(item.usage).not.toBe('measured');
        expect(item.value * 4).toBe(Math.round(item.value * 4));
      }
    }
    expect(units).toEqual(new Set(ALL_UNIT_FORMS));
  });
});
