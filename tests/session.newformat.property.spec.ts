/**
 * Kiro 1.x 存储适配 —— 新格式消息解析的属性测试。
 *
 * Feature: kiro-1x-storage-adaptation, Property 4: 消息解析的容错性
 * Validates: Requirements 3.8
 *
 * 核心命题：`messages.jsonl` 是**追加写**的文件，Kiro 进程被杀会留下半行、
 * 磁盘异常会留下垃圾字节。在合法事件序列的**任意位置**插入**任意数量**的非法行，
 * `parseMessagesJsonl` 的四项产出（`text` / `firstUserText` / `hasImage` /
 * `hasAttachment`）必须与不插入时逐字段相等——否则用户会因为一行坏数据丢掉整段历史。
 *
 * 「任意位置」是这条属性的要点，所以注入实现为**位置无关**的分槽插入
 * （见 {@link injectIllegal}）：随机下标、可多处、可同槽多行，覆盖首、尾、中间与聚簇。
 *
 * 测试只依赖 `parseMessagesJsonl` 的公开契约（入参字符串 → 四字段结果），
 * 不复刻它的内部算法：主属性是**差分**断言（插入前 vs 插入后），辅以若干
 * 「某片段恒出现 / 恒不出现」的单向断言。任何一处改成「预期 text 逐字符重算」
 * 都会让测试与实现同步漂移、退化成同义反复。
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { parseMessagesJsonl, MATCHED_PAYLOAD_TYPES } from '../src/session/newFormat';
import type { ParsedMessages } from '../src/session/newFormat';

/* ------------------------------------------------------------------ *
 * 哨兵常量
 * ------------------------------------------------------------------ */

/**
 * 被排除类型（`tool_call` / `usage_summary` / …）事件里携带的可识别字符串。
 * 它恒不应出现在 `text` 中（Req 3.4：白名单之外的事件不进匹配文本）。
 *
 * 刻意含 `_`：合法文本生成器的字符集**不含** `_`（见 {@link visibleTextArb}），
 * 因此「`text` 里出现哨兵」只可能来自被排除事件，不会是随机文本的巧合。
 */
const EXCLUDED_SENTINEL = '__EXCLUDED_PAYLOAD_TEXT__';

/** 内嵌图片数据的可识别载荷；恒不应出现在 `text` 中（Req 3.12）。 */
const B64_SENTINEL = 'QkFTRTY0X0lNQUdFX1NFTlRJTkVM';

/** `data:` URL 形态的图片承载；`text` 中恒不应出现 `data:`（生成器不产出 `:`）。 */
const DATA_URL = `data:image/png;base64,${B64_SENTINEL}`;

/** 实测 14 种 `payload.type` 中被排除在匹配文本之外的 12 种（Req 3.4）。 */
const EXCLUDED_PAYLOAD_TYPES = [
  'tool_call',
  'tool_result',
  'usage_summary',
  'session_metadata',
  'turn_start',
  'turn_end',
  'sub_agent_start',
  'sub_agent_complete',
  'pending_interaction',
  'interaction_resolved',
  'session_event',
  'tombstone',
] as const;

/* ------------------------------------------------------------------ *
 * 非法行生成器
 * ------------------------------------------------------------------ */

/** 非法行的形态标签（覆盖度守卫按它逐类核对）。 */
type IllegalKind =
  | 'truncated-json'
  | 'not-json-text'
  | 'json-number'
  | 'json-string'
  | 'json-null'
  | 'json-array'
  | 'object-without-payload'
  | 'payload-not-object'
  | 'empty-line'
  | 'whitespace-line'
  | 'lone-punctuation';

/**
 * 非法行样本表：显式列举而非随机拼字符串，好处是覆盖度守卫可以**穷举**校验
 * 「每个样本单独插入都不改变解析结果」，比统计式的采样收集强得多。
 *
 * 全部样本不含 `\n` / `\r`：注入后要保持「一行就是一行」，否则一次注入会变成多行，
 * 属性的语义就模糊了（换行本身的处理由行尾无关那条属性单独覆盖）。
 *
 * 若干样本刻意把 {@link EXCLUDED_SENTINEL} 埋在非法结构里（截断的字符串、
 * 顶层无 `payload` 的对象、嵌在数组里的"看起来合法"的事件），用来验证
 * 「解析器不会从非法行里捞文本」。
 */
const ILLEGAL_LINES: Record<IllegalKind, readonly string[]> = {
  // 追加写被中断的典型残留：JSON 在任意位置断掉
  'truncated-json': [
    '{"payload":{"type":"user"',
    '{"id":"e1","timestamp":1,"payload":',
    `{"payload":{"type":"assistant","content":"${EXCLUDED_SENTINEL}`,
    '{"payload":{"type":"user","content":["a",',
  ],
  // 完全不是 JSON 的文本
  'not-json-text': ['nope', '>>> broken <<<', 'undefined', `${EXCLUDED_SENTINEL} raw text`],
  // 合法 JSON 但顶层不是对象
  'json-number': ['42', '0', '-1.5'],
  'json-string': [JSON.stringify('str'), JSON.stringify(EXCLUDED_SENTINEL)],
  'json-null': ['null'],
  'json-array': [
    '[1,2]',
    '[]',
    // 数组里嵌一个"看起来合法"的事件：顶层是数组，取不到 payload，恒不应贡献文本
    `[{"payload":{"type":"user","content":"${EXCLUDED_SENTINEL}"}}]`,
  ],
  // 合法对象但缺 payload（含把事件字段直接放在顶层的错形）
  'object-without-payload': [
    '{}',
    '{"id":"e2","timestamp":2}',
    `{"type":"user","content":"${EXCLUDED_SENTINEL}"}`,
  ],
  // payload 存在但不是对象（数组形态也在内：typeof [] === 'object'，但取不到 type）
  'payload-not-object': [
    '{"payload":42}',
    `{"payload":"${EXCLUDED_SENTINEL}"}`,
    '{"payload":null}',
    '{"payload":true}',
    '{"payload":[1,2]}',
  ],
  'empty-line': [''],
  'whitespace-line': ['   ', '\t', ' \t '],
  'lone-punctuation': ['{', '}', ','],
};

const ILLEGAL_KINDS = Object.keys(ILLEGAL_LINES) as IllegalKind[];

interface IllegalLine {
  kind: IllegalKind;
  line: string;
}

const illegalLineArb: fc.Arbitrary<IllegalLine> = fc.constantFrom(
  ...ILLEGAL_KINDS.flatMap((kind) => ILLEGAL_LINES[kind].map((line) => ({ kind, line })))
);

/* ------------------------------------------------------------------ *
 * 合法事件生成器
 * ------------------------------------------------------------------ */

/**
 * 合法文本的字符集：ASCII 字母数字 + 空格 + 少量中文。
 *
 * 刻意**不含** `_` `:` `{` `"` `\` 与换行——三个后果都是必需的：
 * ① 随机文本永不撞上 {@link EXCLUDED_SENTINEL} 与 `data:`，使「恒不出现」类断言有效；
 * ② `JSON.stringify` 不会产生转义序列，行内不会意外出现换行；
 * ③ 首尾字符取自非空格集合，故生成的文本恒等于它自己的 `trim()`，
 *    使 `firstUserText` 的预期无需复刻 trim 逻辑。
 */
const TEXT_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 中文测试'.split(
  ''
);
const NON_SPACE_CHARS = TEXT_CHARS.filter((c) => c !== ' ');

/** 恒非空、恒已 trim 的可见文本（长度 ≥ 2）。 */
const visibleTextArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...NON_SPACE_CHARS),
    fc.array(fc.constantFrom(...TEXT_CHARS), { maxLength: 12 }),
    fc.constantFrom(...NON_SPACE_CHARS)
  )
  .map(([head, mid, tail]) => head + mid.join('') + tail);

/** 合法事件的形态标签（覆盖度守卫按它逐类核对）。 */
type LegalKind =
  | 'user-string'
  | 'assistant-string'
  | 'user-array'
  | 'assistant-array'
  | 'user-text-field'
  | 'image-content-item'
  | 'image-payload-flag'
  | 'data-url-text'
  | 'context-items'
  | 'excluded-type'
  | 'excluded-with-context';

interface LegalEvent {
  kind: LegalKind;
  /** 序列化后即为 `messages.jsonl` 的一行。 */
  event: unknown;
  /** 恒应出现在 `text` 中的片段（已 trim、非空，按出现顺序）。 */
  visibleTexts: string[];
  /** 该事件的 `payload.type` 是否为 `user`（决定它是否参与 `firstUserText`）。 */
  isUser: boolean;
  /** 该事件是否携带图片标志（Req 3.6）。 */
  expectsImage: boolean;
  /** 该事件是否携带非空上下文引用（Req 3.7 的第一个条件）。 */
  expectsAttachment: boolean;
}

function makeEvent(payload: Record<string, unknown>, seq: number): unknown {
  return { id: `evt-${seq}`, timestamp: 1700000000000 + seq, payload };
}

const seqArb = fc.integer({ min: 0, max: 999 });

/** `content` 为**字符串**的形态（实测样例的主形态）。 */
const stringContentArb: fc.Arbitrary<LegalEvent> = fc
  .tuple(fc.constantFrom('user', 'assistant'), visibleTextArb, seqArb)
  .map(([type, text, seq]) => ({
    kind: (type === 'user' ? 'user-string' : 'assistant-string') as LegalKind,
    event: makeEvent({ type, content: text, source: 'chat' }, seq),
    visibleTexts: [text],
    isUser: type === 'user',
    expectsImage: false,
    expectsAttachment: false,
  }));

/** `content` 为**内容项数组**的形态：`{type:'text',text}` 项与裸字符串项混排。 */
const arrayContentArb: fc.Arbitrary<LegalEvent> = fc
  .tuple(
    fc.constantFrom('user', 'assistant'),
    fc.array(fc.tuple(fc.boolean(), visibleTextArb), { minLength: 1, maxLength: 3 }),
    seqArb
  )
  .map(([type, items, seq]) => ({
    kind: (type === 'user' ? 'user-array' : 'assistant-array') as LegalKind,
    event: makeEvent(
      {
        type,
        content: items.map(([bare, text]) => (bare ? text : { type: 'text', text })),
      },
      seq
    ),
    visibleTexts: items.map(([, text]) => text),
    isUser: type === 'user',
    expectsImage: false,
    expectsAttachment: false,
  }));

/** `content` 缺席、文本直挂 `payload.text` 的兜底形态。 */
const textFieldArb: fc.Arbitrary<LegalEvent> = fc
  .tuple(visibleTextArb, seqArb)
  .map(([text, seq]) => ({
    kind: 'user-text-field' as LegalKind,
    event: makeEvent({ type: 'user', text }, seq),
    visibleTexts: [text],
    isUser: true,
    expectsImage: false,
    expectsAttachment: false,
  }));

/** 内容项级别的图片标志：`type` 含 `image`，或项上有 `imageUrl` / `image` 字段。 */
const imageContentArb: fc.Arbitrary<LegalEvent> = fc
  .tuple(
    fc.constantFrom('user', 'assistant'),
    fc.integer({ min: 0, max: 2 }),
    visibleTextArb,
    seqArb
  )
  .map(([type, variant, text, seq]) => {
    const imagePart = [
      { type: 'image', imageUrl: DATA_URL },
      { type: 'image_url', imageUrl: { url: DATA_URL } },
      { type: 'text', image: { data: B64_SENTINEL, mediaType: 'image/png' } },
    ][variant];
    return {
      kind: 'image-content-item' as LegalKind,
      event: makeEvent({ type, content: [{ type: 'text', text }, imagePart] }, seq),
      visibleTexts: [text],
      isUser: type === 'user',
      expectsImage: true,
      expectsAttachment: false,
    };
  });

/** payload 顶层直挂图片标志（部分事件不把图片放进 content 项）。 */
const imagePayloadFlagArb: fc.Arbitrary<LegalEvent> = fc
  .tuple(fc.constantFrom('user', 'assistant'), fc.boolean(), visibleTextArb, seqArb)
  .map(([type, useImageField, text, seq]) => ({
    kind: 'image-payload-flag' as LegalKind,
    event: makeEvent(
      useImageField
        ? { type, content: text, image: { data: B64_SENTINEL } }
        : { type, content: text, imageUrl: DATA_URL },
      seq
    ),
    visibleTexts: [text],
    isUser: type === 'user',
    expectsImage: true,
    expectsAttachment: false,
  }));

/**
 * 裸 `data:` URL 字符串项：**不是**图片标志（裸字符串项不带 `type`），
 * 但它的 base64 恒不应进入 `text`。这两件事必须分开断言，否则会把
 * 「没识别成图片」和「base64 漏进文本」混为一谈。
 */
const dataUrlTextArb: fc.Arbitrary<LegalEvent> = fc
  .tuple(visibleTextArb, seqArb)
  .map(([text, seq]) => ({
    kind: 'data-url-text' as LegalKind,
    event: makeEvent({ type: 'user', content: [DATA_URL, { type: 'text', text }] }, seq),
    visibleTexts: [text],
    isUser: true,
    expectsImage: false,
    expectsAttachment: false,
  }));

const CONTEXT_KEYS = ['contextItems', 'contextItem', 'contextReferences'] as const;

/** 携带非空上下文引用的事件（Req 3.7 的第一个条件）。 */
const contextItemsArb: fc.Arbitrary<LegalEvent> = fc
  .tuple(fc.constantFrom(...CONTEXT_KEYS), visibleTextArb, seqArb)
  .map(([key, text, seq]) => ({
    kind: 'context-items' as LegalKind,
    event: makeEvent(
      { type: 'user', content: text, [key]: [{ type: 'file', path: 'src/a.ts' }] },
      seq
    ),
    visibleTexts: [text],
    isUser: true,
    expectsImage: false,
    expectsAttachment: true,
  }));

/**
 * 被排除类型的事件：文本一律换成哨兵，且**不**带图片 / 上下文标志，
 * 使「哨兵恒不进 text」与图片/附件的判定互不干扰。
 */
const excludedTypeArb: fc.Arbitrary<LegalEvent> = fc
  .tuple(fc.constantFrom(...EXCLUDED_PAYLOAD_TYPES), fc.boolean(), seqArb)
  .map(([type, asArray, seq]) => ({
    kind: 'excluded-type' as LegalKind,
    event: makeEvent(
      asArray
        ? { type, content: [{ type: 'text', text: EXCLUDED_SENTINEL }], name: 'fsWrite' }
        : { type, content: EXCLUDED_SENTINEL, text: EXCLUDED_SENTINEL },
      seq
    ),
    visibleTexts: [],
    isUser: false,
    expectsImage: false,
    expectsAttachment: false,
  }));

/**
 * 被排除类型 + 非空 `contextItems`：附件检测**不限**事件类型（Req 3.7），
 * 但文本仍不得进入匹配范围（Req 3.4）。这一类同时压住两条规则的交叉点。
 */
const excludedWithContextArb: fc.Arbitrary<LegalEvent> = fc
  .tuple(fc.constantFrom(...EXCLUDED_PAYLOAD_TYPES), seqArb)
  .map(([type, seq]) => ({
    kind: 'excluded-with-context' as LegalKind,
    event: makeEvent(
      { type, content: EXCLUDED_SENTINEL, contextItems: [{ type: 'file', path: 'README.md' }] },
      seq
    ),
    visibleTexts: [],
    isUser: false,
    expectsImage: false,
    expectsAttachment: true,
  }));

const legalEventArb: fc.Arbitrary<LegalEvent> = fc.oneof(
  stringContentArb,
  arrayContentArb,
  textFieldArb,
  imageContentArb,
  imagePayloadFlagArb,
  dataUrlTextArb,
  contextItemsArb,
  excludedTypeArb,
  excludedWithContextArb
);

const LEGAL_KINDS: LegalKind[] = [
  'user-string',
  'assistant-string',
  'user-array',
  'assistant-array',
  'user-text-field',
  'image-content-item',
  'image-payload-flag',
  'data-url-text',
  'context-items',
  'excluded-type',
  'excluded-with-context',
];

/** 合法事件序列（允许为空：只有非法行的极端文件也必须能读出空结果）。 */
const legalSequenceArb: fc.Arbitrary<LegalEvent[]> = fc.array(legalEventArb, {
  minLength: 0,
  maxLength: 8,
});

/** 注入描述：`slot` 为原始行序列的**槽位下标**（0 = 首行之前，n = 末行之后）。 */
const injectionsArb: fc.Arbitrary<Array<{ slot: number; line: string; kind: IllegalKind }>> =
  fc.array(
    fc.tuple(fc.nat({ max: 64 }), illegalLineArb).map(([slot, il]) => ({ slot, ...il })),
    { minLength: 0, maxLength: 8 }
  );

/* ------------------------------------------------------------------ *
 * 辅助
 * ------------------------------------------------------------------ */

function toLines(events: readonly LegalEvent[]): string[] {
  return events.map((e) => JSON.stringify(e.event));
}

/**
 * 位置无关注入：把非法行按槽位分桶后与合法行交错展开。
 *
 * 用「槽位」而不是「在开头/结尾插一行」，是这条属性的价值所在：
 * 同一槽位可落多行（聚簇的垃圾字节）、槽 0 与槽 n 覆盖首尾，
 * 其余槽覆盖任意中间位置。`slot` 取模映射到合法槽位，故生成器无需知道序列长度。
 */
function injectIllegal(
  legalLines: readonly string[],
  injections: readonly { slot: number; line: string }[]
): string[] {
  const slotCount = legalLines.length + 1;
  const buckets: string[][] = Array.from({ length: slotCount }, () => []);
  for (const inj of injections) {
    buckets[((inj.slot % slotCount) + slotCount) % slotCount].push(inj.line);
  }
  const out: string[] = [];
  for (let i = 0; i < legalLines.length; i++) {
    out.push(...buckets[i], legalLines[i]);
  }
  out.push(...buckets[legalLines.length]);
  return out;
}

/** 四项产出逐字段相等（比 toEqual 更明确地点出被比较的字段）。 */
function expectSameFields(actual: ParsedMessages, expected: ParsedMessages): void {
  expect(actual.text).toBe(expected.text);
  expect(actual.firstUserText).toBe(expected.firstUserText);
  expect(actual.hasImage).toBe(expected.hasImage);
  expect(actual.hasAttachment).toBe(expected.hasAttachment);
}

/** 序列中首个 `user` 事件的首个可见文本（已 trim），无则空串。 */
function expectedFirstUserText(events: readonly LegalEvent[]): string {
  for (const e of events) {
    if (e.isUser && e.visibleTexts.length > 0) return e.visibleTexts[0];
  }
  return '';
}

/** 通用不变量：与「插入了什么」无关，任何一次解析结果都应满足。 */
function expectInvariants(result: ParsedMessages, events: readonly LegalEvent[]): void {
  // 白名单内事件的文本恒出现（挡住"解析器直接返回空"这类退化实现）
  for (const e of events) {
    for (const t of e.visibleTexts) expect(result.text).toContain(t);
  }
  // 被排除类型的文本恒不出现（Req 3.4）
  expect(result.text).not.toContain(EXCLUDED_SENTINEL);
  // 内嵌图片数据与 data: URL 恒不出现（Req 3.12）；生成器不产出 ':' 与 '_'，故无误报
  expect(result.text).not.toContain(B64_SENTINEL);
  expect(result.text).not.toContain('data:');

  expect(result.firstUserText).toBe(expectedFirstUserText(events));
  expect(result.hasImage).toBe(events.some((e) => e.expectsImage));
  expect(result.hasAttachment).toBe(events.some((e) => e.expectsAttachment));
}

/* ------------------------------------------------------------------ *
 * Property 4
 * ------------------------------------------------------------------ */

// Feature: kiro-1x-storage-adaptation, Property 4: 消息解析的容错性
// Validates: Requirements 3.8
describe('newFormat 属性：messages.jsonl 解析的容错性', () => {
  // Feature: kiro-1x-storage-adaptation, Property 4: 消息解析的容错性
  // Validates: Requirements 3.8
  it('Property 4: 任意位置插入任意数量非法行，四项产出恒与不插入时逐字段相等', () => {
    fc.assert(
      fc.property(legalSequenceArb, injectionsArb, (events, injections) => {
        const legalLines = toLines(events);
        const baseline = parseMessagesJsonl(legalLines.join('\n'));
        const polluted = parseMessagesJsonl(injectIllegal(legalLines, injections).join('\n'));

        expectSameFields(polluted, baseline);
        expectInvariants(baseline, events);
        expectInvariants(polluted, events);
      }),
      { numRuns: 200 }
    );
  });

  // Feature: kiro-1x-storage-adaptation, Property 4: 消息解析的容错性
  // Validates: Requirements 3.8
  it('Property 4: 非法行全部堆在同一位置（首/中/尾）时结果同样不变', () => {
    fc.assert(
      fc.property(
        fc.array(legalEventArb, { minLength: 1, maxLength: 6 }),
        fc.array(illegalLineArb, { minLength: 1, maxLength: 6 }),
        fc.nat({ max: 64 }),
        (events, illegals, slot) => {
          const legalLines = toLines(events);
          const baseline = parseMessagesJsonl(legalLines.join('\n'));
          const target = slot % (legalLines.length + 1);
          const injections = illegals.map((il) => ({ slot: target, line: il.line }));
          expectSameFields(
            parseMessagesJsonl(injectIllegal(legalLines, injections).join('\n')),
            baseline
          );
        }
      ),
      { numRuns: 150 }
    );
  });

  // Feature: kiro-1x-storage-adaptation, Property 4: 消息解析的容错性
  // Validates: Requirements 3.8
  it('Property 4: 纯函数——同输入恒同输出，且入参字符串不被改动', () => {
    fc.assert(
      fc.property(legalSequenceArb, injectionsArb, (events, injections) => {
        const raw = injectIllegal(toLines(events), injections).join('\n');
        const snapshot = String(raw);

        const first = parseMessagesJsonl(raw);
        // 中间穿插其它输入：若实现复用了模块级可变状态（常见错法），此处会暴露
        parseMessagesJsonl('{"payload":{"type":"user","content":"other"}}');
        parseMessagesJsonl('');
        const second = parseMessagesJsonl(raw);

        expectSameFields(second, first);
        expect(raw).toBe(snapshot);
        // 返回的是新对象，调用方改动不会污染下一次结果
        expect(second).not.toBe(first);
      }),
      { numRuns: 150 }
    );
  });

  // Feature: kiro-1x-storage-adaptation, Property 4: 消息解析的容错性
  // Validates: Requirements 3.4, 3.8
  it('Property 4: 被排除类型里的文本恒不出现在 text 中', () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(excludedTypeArb, excludedWithContextArb), {
          minLength: 1,
          maxLength: 8,
        }),
        legalSequenceArb,
        injectionsArb,
        (excluded, others, injections) => {
          const events = [...excluded, ...others];
          const lines = injectIllegal(toLines(events), injections);
          const result = parseMessagesJsonl(lines.join('\n'));

          expect(result.text).not.toContain(EXCLUDED_SENTINEL);
          // 被排除事件本身不带图片标志，故 hasImage 只可能由其余事件贡献
          expect(result.hasImage).toBe(others.some((e) => e.expectsImage));
          // 而附件判定不限事件类型：被排除事件带的 contextItems 恒计入
          expect(result.hasAttachment).toBe(events.some((e) => e.expectsAttachment));
        }
      ),
      { numRuns: 150 }
    );
  });

  // Feature: kiro-1x-storage-adaptation, Property 4: 消息解析的容错性
  // Validates: Requirements 3.8, 3.12
  it('Property 4: base64 与 data: URL 恒不进入 text', () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(imageContentArb, imagePayloadFlagArb, dataUrlTextArb), {
          minLength: 1,
          maxLength: 6,
        }),
        legalSequenceArb,
        injectionsArb,
        (imaged, others, injections) => {
          const events = [...imaged, ...others];
          const raw = injectIllegal(toLines(events), injections).join('\n');
          // 前置：原始文本里确实含 base64 载荷（否则这条属性没在测该风险）
          expect(raw).toContain(B64_SENTINEL);

          const result = parseMessagesJsonl(raw);
          expect(result.text).not.toContain(B64_SENTINEL);
          expect(result.text).not.toContain('data:');
          expect(result.firstUserText).not.toContain(B64_SENTINEL);
          expect(result.firstUserText).not.toContain('data:');
          // 图片标志仍被识别：不进文本 ≠ 不算图片
          expect(result.hasImage).toBe(events.some((e) => e.expectsImage));
        }
      ),
      { numRuns: 150 }
    );
  });

  // Feature: kiro-1x-storage-adaptation, Property 4: 消息解析的容错性
  // Validates: Requirements 3.6, 3.7, 3.8
  it('Property 4: 单调性——尾部追加合法事件后 hasImage / hasAttachment 恒不回落', () => {
    fc.assert(
      fc.property(
        legalSequenceArb,
        fc.array(legalEventArb, { minLength: 1, maxLength: 5 }),
        injectionsArb,
        (base, appended, injections) => {
          const baseLines = injectIllegal(toLines(base), injections);
          const before = parseMessagesJsonl(baseLines.join('\n'));
          const after = parseMessagesJsonl([...baseLines, ...toLines(appended)].join('\n'));

          if (before.hasImage) expect(after.hasImage).toBe(true);
          if (before.hasAttachment) expect(after.hasAttachment).toBe(true);
          // 已确定的首条 user 文本不会被后续事件改写
          if (before.firstUserText) expect(after.firstUserText).toBe(before.firstUserText);
          // 追加只在尾部拼接，已有文本恒为新文本的前缀
          expect(after.text.startsWith(before.text)).toBe(true);
        }
      ),
      { numRuns: 150 }
    );
  });

  // Feature: kiro-1x-storage-adaptation, Property 4: 消息解析的容错性
  // Validates: Requirements 3.8
  it('Property 4: 行尾无关——同一逻辑序列用 \\n 与 \\r\\n 连接结果恒相等', () => {
    fc.assert(
      fc.property(legalSequenceArb, injectionsArb, (events, injections) => {
        const lines = injectIllegal(toLines(events), injections);
        const lf = parseMessagesJsonl(lines.join('\n'));
        const crlf = parseMessagesJsonl(lines.join('\r\n'));

        expectSameFields(crlf, lf);
        // 末行带行尾符 / 文件末尾多个空行同样不改变结果
        expectSameFields(parseMessagesJsonl(lines.join('\n') + '\n'), lf);
        expectSameFields(parseMessagesJsonl(lines.join('\r\n') + '\r\n'), lf);
        expectSameFields(parseMessagesJsonl(lines.join('\r\n') + '\n\r\n'), lf);
      }),
      { numRuns: 150 }
    );
  });
});

/* ------------------------------------------------------------------ *
 * 覆盖度守卫
 * ------------------------------------------------------------------ */

describe('newFormat 属性：生成器覆盖度守卫', () => {
  // Feature: kiro-1x-storage-adaptation, Property 4: 消息解析的容错性
  // Validates: Requirements 3.8
  it('覆盖度: 非法行样本表覆盖全部形态，且每个样本单独插入都不改变结果', () => {
    // 表结构完整：每一类都有样本，且样本不含换行（注入后仍是"一行"）
    expect(new Set(ILLEGAL_KINDS)).toEqual(
      new Set<IllegalKind>([
        'truncated-json',
        'not-json-text',
        'json-number',
        'json-string',
        'json-null',
        'json-array',
        'object-without-payload',
        'payload-not-object',
        'empty-line',
        'whitespace-line',
        'lone-punctuation',
      ])
    );
    for (const kind of ILLEGAL_KINDS) {
      expect(ILLEGAL_LINES[kind].length).toBeGreaterThan(0);
      for (const line of ILLEGAL_LINES[kind]) expect(line).not.toMatch(/[\r\n]/);
    }

    // 生成器确实能产出每一类
    const sampled = new Set(fc.sample(illegalLineArb, 600).map((il) => il.kind));
    expect(sampled).toEqual(new Set(ILLEGAL_KINDS));

    // 穷举：每个样本 × 每个槽位，结果恒等于不插入时（比统计采样更强的确定性守卫）
    const fixture: LegalEvent[] = [
      {
        kind: 'user-string',
        event: makeEvent({ type: 'user', content: 'hello world' }, 1),
        visibleTexts: ['hello world'],
        isUser: true,
        expectsImage: false,
        expectsAttachment: false,
      },
      {
        kind: 'image-content-item',
        event: makeEvent(
          {
            type: 'assistant',
            content: [
              { type: 'text', text: 'reply text' },
              { type: 'image', imageUrl: DATA_URL },
            ],
          },
          2
        ),
        visibleTexts: ['reply text'],
        isUser: false,
        expectsImage: true,
        expectsAttachment: false,
      },
      {
        kind: 'context-items',
        event: makeEvent(
          { type: 'user', content: 'second ask', contextItems: [{ type: 'file', path: 'a.ts' }] },
          3
        ),
        visibleTexts: ['second ask'],
        isUser: true,
        expectsImage: false,
        expectsAttachment: true,
      },
    ];
    const fixtureLines = toLines(fixture);
    const baseline = parseMessagesJsonl(fixtureLines.join('\n'));
    expectInvariants(baseline, fixture);

    for (const kind of ILLEGAL_KINDS) {
      for (const line of ILLEGAL_LINES[kind]) {
        for (let slot = 0; slot <= fixtureLines.length; slot++) {
          const polluted = parseMessagesJsonl(
            injectIllegal(fixtureLines, [{ slot, line }]).join('\n')
          );
          expectSameFields(polluted, baseline);
        }
      }
    }
  });

  // Feature: kiro-1x-storage-adaptation, Property 4: 消息解析的容错性
  // Validates: Requirements 3.3, 3.4, 3.8
  it('覆盖度: 合法事件生成器产出全部形态，且被排除类型确实在白名单之外', () => {
    const sampled = new Set(fc.sample(legalEventArb, 900).map((e) => e.kind));
    expect(sampled).toEqual(new Set(LEGAL_KINDS));

    // 被排除类型不在白名单内（白名单一旦放宽，哨兵类断言会失去意义，此处先失败）
    expect([...MATCHED_PAYLOAD_TYPES].sort()).toEqual(['assistant', 'user']);
    for (const t of EXCLUDED_PAYLOAD_TYPES) expect(MATCHED_PAYLOAD_TYPES.has(t)).toBe(false);

    // 合法文本字符集不含哨兵/data: 会用到的字符，"恒不出现"类断言才没有误报
    for (const s of fc.sample(visibleTextArb, 200)) {
      expect(s).toBe(s.trim());
      expect(s.length).toBeGreaterThan(0);
      expect(s).not.toMatch(/[_:{}"\\\r\n]/);
    }
  });
});
