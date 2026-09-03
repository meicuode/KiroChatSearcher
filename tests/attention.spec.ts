import { describe, it, expect } from 'vitest';
import {
  AttentionWatcher,
  DEFAULT_TITLE_MARK,
  isTitleMarked,
  markTitle,
  normalizeMark,
  scanPendingInteractions,
  scanSessionActivity,
  stripAnyMark,
  unmarkTitle,
  type AttentionDeps,
  type PendingInteraction,
} from '../src/attention';

/**
 * 待确认提醒的两块核心逻辑：
 *
 * 1. `scanPendingInteractions` —— 解析 kiro-agent 写的 `messages.jsonl`。这是**外部
 *    进程写的、随版本演进的**数据，且判据（`turn_end` 作废先前 pending）不直观，
 *    错了会导致标记永久挂在标题上摘不掉，所以逐条钉住。
 * 2. `AttentionWatcher` 的标题同步 —— 还原策略不依赖任何持久化的「原值」，
 *    必须验证「我们没来过」这个终态在几种初始配置下都成立。
 */

const MARK = '* ';

/** 造一行 messages.jsonl 事件。 */
function line(payload: Record<string, unknown>, timestamp = '2026-09-03T01:00:00.000Z'): string {
  return JSON.stringify({ id: String(payload.toolCallId ?? 'x'), timestamp, payload });
}

const pendingLine = (id: string, question = 'List Directory') =>
  line({
    type: 'pending_interaction',
    interactionType: 'tool_approval',
    toolCallId: id,
    question,
    options: [{ optionId: 'accept', name: 'Allow', kind: 'allow_once' }],
  });

const resolvedLine = (id: string) =>
  line({ type: 'interaction_resolved', toolCallId: id, outcome: 'selected', selectedOption: 'accept' });

const turnEndLine = () => line({ type: 'turn_end', stopReason: 'end_turn', executionId: 'e1' });

describe('scanPendingInteractions - 等待项判定', () => {
  it('只有 pending 没有 resolved → 算等待中', () => {
    const out = scanPendingInteractions([pendingLine('t1', 'Load skill: item')].join('\n'));
    expect(out).toHaveLength(1);
    expect(out[0].toolCallId).toBe('t1');
    expect(out[0].question).toBe('Load skill: item');
    expect(out[0].interactionType).toBe('tool_approval');
    expect(out[0].at).toBe(Date.parse('2026-09-03T01:00:00.000Z'));
  });

  it('pending 后有同 id 的 resolved → 不算等待', () => {
    const out = scanPendingInteractions([pendingLine('t1'), resolvedLine('t1')].join('\n'));
    expect(out).toEqual([]);
  });

  it('resolved 的是别的 id → 原 pending 仍在等待', () => {
    const out = scanPendingInteractions([pendingLine('t1'), resolvedLine('t2')].join('\n'));
    expect(out.map((p) => p.toolCallId)).toEqual(['t1']);
  });

  it('pending 之后出现 turn_end → 视为无人等待（防幻影）', () => {
    // 进程被杀 / 窗口被关 / 整轮被取消，都会留下永远等不到 resolved 的 pending。
    // 少了这条规则，标记会永久挂在标题上。
    const out = scanPendingInteractions([pendingLine('t1'), turnEndLine()].join('\n'));
    expect(out).toEqual([]);
  });

  it('turn_end 之后新开的 pending 仍然算等待', () => {
    const out = scanPendingInteractions(
      [pendingLine('t1'), turnEndLine(), pendingLine('t2')].join('\n')
    );
    expect(out.map((p) => p.toolCallId)).toEqual(['t2']);
  });

  it('多个并存的 pending 全部返回，且按 toolCallId 去重', () => {
    const out = scanPendingInteractions(
      [pendingLine('t1'), pendingLine('t2'), pendingLine('t1')].join('\n')
    );
    expect(out.map((p) => p.toolCallId).sort()).toEqual(['t1', 't2']);
  });

  it('坏行（尾部截断产生的半行）被跳过，不影响其余行', () => {
    const truncated = pendingLine('t0').slice(20); // 模拟从中间截断读到的第一行
    const out = scanPendingInteractions([truncated, pendingLine('t1')].join('\n'));
    expect(out.map((p) => p.toolCallId)).toEqual(['t1']);
  });

  it('空文本 / 无关事件 → 没有等待项', () => {
    expect(scanPendingInteractions('')).toEqual([]);
    expect(
      scanPendingInteractions([line({ type: 'assistant', content: 'hi' }), turnEndLine()].join('\n'))
    ).toEqual([]);
  });

  it('缺字段时降级而不抛：无 toolCallId 的 pending 被忽略', () => {
    const out = scanPendingInteractions(
      [line({ type: 'pending_interaction', question: '无 id' }), pendingLine('t1')].join('\n')
    );
    expect(out.map((p) => p.toolCallId)).toEqual(['t1']);
  });

  it('时间戳非法时 at 为 null，不影响其余字段', () => {
    const raw = JSON.stringify({
      timestamp: 'not-a-date',
      payload: { type: 'pending_interaction', toolCallId: 't1', question: 'Q' },
    });
    const out = scanPendingInteractions(raw);
    expect(out[0].at).toBeNull();
    expect(out[0].question).toBe('Q');
  });
});

describe('标题标记 - 幂等性', () => {
  it('markTitle 幂等，不会叠成 **', () => {
    const once = markTitle('${activeEditorShort}', MARK);
    expect(once).toBe('* ${activeEditorShort}');
    expect(markTitle(once, MARK)).toBe(once);
  });

  it('unmarkTitle 幂等，且能摘掉历史遗留的多层前缀', () => {
    expect(unmarkTitle('* a', MARK)).toBe('a');
    expect(unmarkTitle('* * * a', MARK)).toBe('a');
    expect(unmarkTitle('a', MARK)).toBe('a');
  });

  it('isTitleMarked 与 mark/unmark 一致', () => {
    expect(isTitleMarked('* a', MARK)).toBe(true);
    expect(isTitleMarked('a', MARK)).toBe(false);
    expect(isTitleMarked('a', '')).toBe(false);
  });
});

describe('scanSessionActivity - 轮结束身份', () => {
  it('取最后一个 turn_end 的事件 id', () => {
    const raw = [
      line({ type: 'turn_end', stopReason: 'end_turn' }, '2026-09-03T01:00:00.000Z'),
      line({ type: 'turn_end', stopReason: 'end_turn' }, '2026-09-03T02:00:00.000Z'),
    ]
      .map((l, i) => l.replace('"id":"x"', `"id":"turn-${i}"`))
      .join('\n');
    expect(scanSessionActivity(raw).lastTurnEndId).toBe('turn-1');
  });

  it('没有 id 时退回时间戳', () => {
    const raw = JSON.stringify({
      timestamp: '2026-09-03T03:00:00.000Z',
      payload: { type: 'turn_end' },
    });
    expect(scanSessionActivity(raw).lastTurnEndId).toBe('2026-09-03T03:00:00.000Z');
  });

  it('没有 turn_end 时为 null', () => {
    expect(scanSessionActivity(pendingLine('t1')).lastTurnEndId).toBeNull();
  });

  it('与 pending 判定在同一次遍历里得出，互不干扰', () => {
    const raw = [pendingLine('t1'), turnEndLine(), pendingLine('t2')].join('\n');
    const a = scanSessionActivity(raw);
    expect(a.pending.map((p) => p.toolCallId)).toEqual(['t2']);
    expect(a.lastTurnEndId).not.toBeNull();
  });
});

describe('AttentionWatcher - 完成状态（✅）', () => {
  const DONE = '✅ ';

  /** 造一个「一轮已结束」的会话文本，turn_end 带指定 id。 */
  const withTurnEnd = (id: string) =>
    JSON.stringify({ id, timestamp: '2026-09-03T01:00:00.000Z', payload: { type: 'turn_end' } });

  it('首次扫描只建立基线，历史 turn_end 不会亮 ✅', async () => {
    // 否则一打开窗口，每个会话的最后一轮都会被当成「刚跑完」
    const { deps, writes } = makeDeps({ files: { 's1/messages.jsonl': withTurnEnd('old') } });
    const w = new AttentionWatcher(deps, MARK, [], DONE);
    await w.refresh();
    expect(w.hasDone).toBe(false);
    expect(writes).toEqual([]);
  });

  it('基线之后出现新的 turn_end 且窗口无焦点 → 亮 ✅', async () => {
    const files: Record<string, string> = { 's1/messages.jsonl': withTurnEnd('old') };
    const { deps, writes, focus } = makeDeps({ files, title: { defaultValue: '${rootName}' } });
    deps.readTail = () => files['s1/messages.jsonl'];
    focus.value = false;
    const w = new AttentionWatcher(deps, MARK, [], DONE);
    await w.refresh();

    files['s1/messages.jsonl'] += '\n' + withTurnEnd('fresh');
    await w.refresh();
    expect(w.hasDone).toBe(true);
    expect(writes).toEqual(['✅ ${rootName}']);
  });

  it('窗口有焦点时跑完不亮 ✅（你正盯着看，不需要提醒）', async () => {
    const files: Record<string, string> = { 's1/messages.jsonl': withTurnEnd('old') };
    const { deps, writes, focus } = makeDeps({ files });
    deps.readTail = () => files['s1/messages.jsonl'];
    focus.value = true;
    const w = new AttentionWatcher(deps, MARK, [], DONE);
    await w.refresh();
    files['s1/messages.jsonl'] += '\n' + withTurnEnd('fresh');
    await w.refresh();
    expect(w.hasDone).toBe(false);
    expect(writes).toEqual([]);
  });

  it('多会话「任一完成就亮」', async () => {
    const files: Record<string, string> = {
      's1/messages.jsonl': withTurnEnd('a1'),
      's2/messages.jsonl': withTurnEnd('b1'),
    };
    const { deps } = makeDeps({ files });
    deps.readTail = (file) => {
      const k = Object.keys(files).find((x) => file.replace(/\\/g, '/').includes('/' + x));
      return k === undefined ? null : files[k];
    };
    const w = new AttentionWatcher(deps, MARK, [], DONE);
    await w.refresh();
    expect(w.hasDone).toBe(false);
    // 只有 s2 又跑完一轮
    files['s2/messages.jsonl'] += '\n' + withTurnEnd('b2');
    await w.refresh();
    expect(w.hasDone).toBe(true);
  });

  it('聚焦窗口后 ✅ 消失，但待确认标记不受影响', async () => {
    const files: Record<string, string> = {
      's1/messages.jsonl': withTurnEnd('old'),
    };
    const { deps, writes, focus } = makeDeps({ files, title: { defaultValue: 'T' } });
    deps.readTail = () => files['s1/messages.jsonl'];
    const w = new AttentionWatcher(deps, MARK, [], DONE);
    await w.refresh();

    // 又跑完一轮，同时冒出一个待确认 → 两个标记并存，✅ 在前
    files['s1/messages.jsonl'] += '\n' + withTurnEnd('fresh') + '\n' + pendingLine('t1');
    await w.refresh();
    expect(writes[writes.length - 1]).toBe('✅ * T');
    expect(w.hasDone).toBe(true);
    expect(w.pending).toHaveLength(1);

    // 聚焦：只摘 ✅，🔴/* 留着
    focus.value = true;
    await w.onWindowFocused();
    expect(w.hasDone).toBe(false);
    expect(w.pending).toHaveLength(1);
    expect(writes[writes.length - 1]).toBe('* T');
  });

  it('从「只有待确认」变成「两者并存」时标题被改写，不会漏改', async () => {
    // 用布尔 marked 会漏掉这种前缀变化，故用「当前写了什么前缀」比对
    const files: Record<string, string> = { 's1/messages.jsonl': pendingLine('t1') };
    const { deps, writes } = makeDeps({ files, title: { defaultValue: 'T' } });
    deps.readTail = () => files['s1/messages.jsonl'];
    const w = new AttentionWatcher(deps, MARK, [], DONE);
    await w.refresh();
    expect(writes).toEqual(['* T']);

    files['s1/messages.jsonl'] += '\n' + withTurnEnd('f1');
    await w.refresh();
    // turn_end 作废了先前的 pending，于是只剩 ✅
    expect(writes[writes.length - 1]).toBe('✅ T');
  });

  it('未提供 isWindowFocused 时按「无焦点」处理，宁可多提醒一次', async () => {
    const files: Record<string, string> = { 's1/messages.jsonl': withTurnEnd('old') };
    const { deps } = makeDeps({ files, title: { defaultValue: 'T' } });
    deps.readTail = () => files['s1/messages.jsonl'];
    delete (deps as { isWindowFocused?: unknown }).isWindowFocused;
    const w = new AttentionWatcher(deps, MARK, [], DONE);
    await w.refresh();
    files['s1/messages.jsonl'] += '\n' + withTurnEnd('fresh');
    await w.refresh();
    expect(w.hasDone).toBe(true);
  });

  it('doneMark 同样走归一化，且与 titleMark 不会互相顶替', async () => {
    const files: Record<string, string> = { 's1/messages.jsonl': withTurnEnd('old') };
    const { deps, writes } = makeDeps({ files, title: { defaultValue: 'T' } });
    deps.readTail = () => files['s1/messages.jsonl'];
    const w = new AttentionWatcher(deps, '🔴', [], '🎉'); // 两个都不带空格
    await w.refresh();
    files['s1/messages.jsonl'] += '\n' + withTurnEnd('fresh') + '\n' + pendingLine('t1');
    await w.refresh();
    expect(writes[writes.length - 1]).toBe('🎉 🔴 T');
  });

  it('dispose 把 ✅ 一起摘掉', async () => {
    const files: Record<string, string> = { 's1/messages.jsonl': withTurnEnd('old') };
    const { deps, writes } = makeDeps({ files, title: { defaultValue: 'T' } });
    deps.readTail = () => files['s1/messages.jsonl'];
    const w = new AttentionWatcher(deps, MARK, [], DONE);
    await w.refresh();
    files['s1/messages.jsonl'] += '\n' + withTurnEnd('fresh');
    await w.refresh();
    expect(w.isMarked).toBe(true);
    await w.dispose();
    expect(w.hasDone).toBe(false);
    expect(writes[writes.length - 1]).toBeUndefined();
  });
});

describe('标记归一化与多标记摘除', () => {
  it('默认标记是彩色实心圆点 + 空格', () => {
    expect(DEFAULT_TITLE_MARK).toBe('🔴 ');
  });

  it('结尾缺空格自动补上（否则 emoji 会和标题黏在一起）', () => {
    expect(normalizeMark('🔴')).toBe('🔴 ');
    expect(normalizeMark('🔴 ')).toBe('🔴 ');
    expect(normalizeMark('[等待]')).toBe('[等待] ');
    // 已有其它空白（如制表符）也算，不重复补
    expect(normalizeMark('🔔\t')).toBe('🔔\t');
  });

  it('空 / 纯空白退回默认', () => {
    expect(normalizeMark('')).toBe(DEFAULT_TITLE_MARK);
    expect(normalizeMark('   ')).toBe(DEFAULT_TITLE_MARK);
    expect(normalizeMark(undefined as unknown as string)).toBe(DEFAULT_TITLE_MARK);
  });

  it('emoji 标记的 mark/unmark 与纯文本一致（代理对不被切坏）', () => {
    const t = markTitle('${rootName}', '🔴 ');
    expect(t).toBe('🔴 ${rootName}');
    expect(markTitle(t, '🔴 ')).toBe(t);
    expect(unmarkTitle(t, '🔴 ')).toBe('${rootName}');
    expect(isTitleMarked(t, '🔴 ')).toBe(true);
    expect(isTitleMarked(t, '🔔 ')).toBe(false);
  });

  it('stripAnyMark 能摘掉换过标记后混叠的多种前缀', () => {
    expect(stripAnyMark('🔴 * a', ['🔴 ', '* '])).toBe('a');
    expect(stripAnyMark('* 🔴 a', ['🔴 ', '* '])).toBe('a');
    expect(stripAnyMark('a', ['🔴 ', '* '])).toBe('a');
    expect(stripAnyMark('🔴 a', ['', '🔴 '])).toBe('a'); // 空标记不参与、不死循环
  });
});

/** 可编程的依赖替身：记录标题写入序列，供断言还原终态。 */
function makeDeps(opts: {
  files?: Record<string, string>;
  title?: { workspaceValue?: string; globalValue?: string; defaultValue?: string };
}) {
  const files = opts.files ?? {};
  const title = { ...(opts.title ?? { defaultValue: '${dirty}${activeEditorShort}' }) };
  const writes: Array<string | undefined> = [];
  const states: Array<{ pending: PendingInteraction[]; done: boolean }> = [];
  const focus = { value: false };
  const deps: AttentionDeps = {
    sessionDir: () => '/ws',
    listDir: () => Object.keys(files).map((k) => k.split('/')[0]),
    readTail: (file) => {
      const key = Object.keys(files).find((k) => file.replace(/\\/g, '/').includes('/' + k));
      return key === undefined ? null : files[key];
    },
    readTitle: () => ({ ...title }),
    writeTitle: async (value) => {
      writes.push(value);
      title.workspaceValue = value;
    },
    onStateChange: (s) => void states.push({ pending: [...s.pending], done: s.done }),
    isWindowFocused: () => focus.value,
  };
  return { deps, writes, states, title, focus };
}

describe('AttentionWatcher - 标题同步', () => {
  const waiting = { 's1/messages.jsonl': pendingLine('t1', 'Load skill: item') };
  const settled = { 's1/messages.jsonl': [pendingLine('t1'), resolvedLine('t1')].join('\n') };

  it('检测到等待项时给标题加标记；重复 refresh 不重复写', async () => {
    const { deps, writes } = makeDeps({ files: waiting });
    const w = new AttentionWatcher(deps, MARK);
    await w.refresh();
    expect(writes).toEqual(['* ${dirty}${activeEditorShort}']);
    await w.refresh();
    expect(writes).toHaveLength(1); // 状态未变 → 不写配置
    expect(w.pending.map((p) => p.question)).toEqual(['Load skill: item']);
  });

  it('没有等待项时不写任何配置', async () => {
    const { deps, writes } = makeDeps({ files: settled });
    const w = new AttentionWatcher(deps, MARK);
    await w.refresh();
    expect(writes).toEqual([]);
    expect(w.pending).toEqual([]);
  });

  it('等待结束后删除工作区键，让配置回到「我们没来过」的样子', async () => {
    const { deps, writes, states } = makeDeps({ files: waiting });
    const w = new AttentionWatcher(deps, MARK);
    await w.refresh();
    // 文件变成「已处理」
    (deps as unknown as { readTail: () => string }).readTail = () => settled['s1/messages.jsonl'];
    await w.refresh();
    expect(writes).toEqual(['* ${dirty}${activeEditorShort}', undefined]);
    expect(states[states.length - 1].pending).toEqual([]);
  });

  it('用户自己在工作区层设过标题时，还原成他的值而不是删键', async () => {
    const { deps, writes } = makeDeps({
      files: waiting,
      title: { workspaceValue: 'MY ${rootName}', globalValue: 'G', defaultValue: 'D' },
    });
    const w = new AttentionWatcher(deps, MARK);
    await w.refresh();
    expect(writes[0]).toBe('* MY ${rootName}');
    (deps as unknown as { readTail: () => string }).readTail = () => settled['s1/messages.jsonl'];
    await w.refresh();
    expect(writes[1]).toBe('MY ${rootName}');
  });

  it('clearStaleMark 摘掉上次进程被杀留下的残留标记', async () => {
    const { deps, writes } = makeDeps({
      files: settled,
      title: { workspaceValue: '* ${rootName}', defaultValue: '${rootName}' },
    });
    const w = new AttentionWatcher(deps, MARK);
    await w.clearStaleMark();
    // 摘掉后与 default 相同 → 删键
    expect(writes).toEqual([undefined]);
  });

  it('用户换过标记时，clearStaleMark 能摘掉旧标记留下的前缀', async () => {
    // 1.4.x 用的是 '* '，改成 '🔴 ' 后旧前缀仍留在某个工作区的 settings.json 里
    const { deps, writes } = makeDeps({
      files: settled,
      title: { workspaceValue: '* ${rootName}', defaultValue: '${rootName}' },
    });
    const w = new AttentionWatcher(deps, '🔴 ', ['* ']);
    await w.clearStaleMark();
    expect(writes).toEqual([undefined]); // 摘掉后与 default 相同 → 删键
  });

  it('emoji 标记走完整的打上 → 还原流程', async () => {
    const files: Record<string, string> = { 's1/messages.jsonl': pendingLine('t1') };
    const { deps, writes } = makeDeps({ files, title: { defaultValue: '${rootName}' } });
    deps.readTail = () => files['s1/messages.jsonl'];
    const w = new AttentionWatcher(deps, '🔴', ['* ']); // 故意不带空格，验证归一化
    await w.refresh();
    expect(writes[0]).toBe('🔴 ${rootName}');
    files['s1/messages.jsonl'] += '\n' + resolvedLine('t1');
    await w.refresh();
    expect(writes[1]).toBeUndefined();
  });

  it('clearStaleMark 在没有残留时什么都不做', async () => {
    const { deps, writes } = makeDeps({ files: settled, title: { defaultValue: 'D' } });
    const w = new AttentionWatcher(deps, MARK);
    await w.clearStaleMark();
    expect(writes).toEqual([]);
  });

  it('无工作区 / 目录不可读时按「无等待」处理，并摘掉可能的残留', async () => {
    const { deps, writes } = makeDeps({ files: waiting });
    const w = new AttentionWatcher(deps, MARK);
    await w.refresh();
    expect(writes).toHaveLength(1);
    (deps as unknown as { sessionDir: () => null }).sessionDir = () => null;
    await w.refresh();
    expect(writes[1]).toBeUndefined();
  });

  it('写配置失败不抛出，状态仍然更新（状态栏那一路照常）', async () => {
    const { deps, states } = makeDeps({ files: waiting });
    deps.writeTitle = async () => {
      throw new Error('settings.json 只读');
    };
    const w = new AttentionWatcher(deps, MARK);
    await expect(w.refresh()).resolves.toBeUndefined();
    expect(states[0].pending.map((p) => p.toolCallId)).toEqual(['t1']);
  });

  it('同一项目下多个会话在等 → 汇总计数，逐个确认时标记一直保留到最后一个', async () => {
    // 这是多开/多会话的核心行为：只要还有任意一个会话在等，窗口标记就不能摘。
    const files: Record<string, string> = {
      's1/messages.jsonl': pendingLine('t1', '会话1 要批准'),
      's2/messages.jsonl': pendingLine('t2', '会话2 要批准'),
      's3/messages.jsonl': pendingLine('t3', '会话3 要批准'),
    };
    const { deps, writes, states } = makeDeps({ files });
    // 让 readTail 每次都按当前 files 取值（模拟磁盘被 Kiro 追加改写）
    deps.readTail = (file) => {
      const key = Object.keys(files).find((k) => file.replace(/\\/g, '/').includes('/' + k));
      return key === undefined ? null : files[key];
    };
    const w = new AttentionWatcher(deps, MARK);

    await w.refresh();
    expect(w.pending.map((p) => p.toolCallId).sort()).toEqual(['t1', 't2', 't3']);
    expect(writes).toEqual(['* ${dirty}${activeEditorShort}']);

    // 确认掉第 1 个 → 还剩 2 个，标记必须保留（不能有新的写入，尤其不能写 undefined）
    files['s1/messages.jsonl'] += '\n' + resolvedLine('t1');
    await w.refresh();
    expect(w.pending.map((p) => p.toolCallId).sort()).toEqual(['t2', 't3']);
    expect(writes).toHaveLength(1);

    // 再确认掉第 2 个 → 还剩 1 个，标记依然保留
    files['s2/messages.jsonl'] += '\n' + resolvedLine('t2');
    await w.refresh();
    expect(w.pending.map((p) => p.toolCallId)).toEqual(['t3']);
    expect(writes).toHaveLength(1);

    // 最后一个也确认掉 → 这时才还原
    files['s3/messages.jsonl'] += '\n' + resolvedLine('t3');
    await w.refresh();
    expect(w.pending).toEqual([]);
    expect(writes).toEqual(['* ${dirty}${activeEditorShort}', undefined]);

    // 状态回调把每一次数量变化都报了出去（状态栏据此显示「待确认 N」）
    expect(states.map((s) => s.pending.length)).toEqual([3, 2, 1, 0]);
  });

  it('一个会话里同时挂着多个待确认，逐个确认同样只在清空后还原', async () => {
    const files: Record<string, string> = {
      's1/messages.jsonl': [pendingLine('a'), pendingLine('b')].join('\n'),
    };
    const { deps, writes } = makeDeps({ files });
    deps.readTail = () => files['s1/messages.jsonl'];
    const w = new AttentionWatcher(deps, MARK);

    await w.refresh();
    expect(w.pending).toHaveLength(2);
    files['s1/messages.jsonl'] += '\n' + resolvedLine('a');
    await w.refresh();
    expect(w.pending.map((p) => p.toolCallId)).toEqual(['b']);
    expect(writes).toHaveLength(1); // 仍在等 → 不还原
    files['s1/messages.jsonl'] += '\n' + resolvedLine('b');
    await w.refresh();
    expect(writes[1]).toBeUndefined();
  });

  it('isMarked 反映标记态，供调用方决定要不要开兜底对账', async () => {
    const files: Record<string, string> = { 's1/messages.jsonl': pendingLine('t1') };
    const { deps } = makeDeps({ files });
    deps.readTail = () => files['s1/messages.jsonl'];
    const w = new AttentionWatcher(deps, MARK);

    expect(w.isMarked).toBe(false);
    await w.refresh();
    expect(w.isMarked).toBe(true);
    files['s1/messages.jsonl'] += '\n' + resolvedLine('t1');
    await w.refresh();
    expect(w.isMarked).toBe(false);
  });

  it('确认发生在别处（本进程没收到变更事件）时，下一次对账能把标记摘掉', async () => {
    // 复现实测遇到的滞留：标记写下后，解决动作由另一个窗口/进程完成，
    // 本进程只能靠周期性对账发现「已经没人在等了」。
    const files: Record<string, string> = { 's1/messages.jsonl': pendingLine('t1') };
    const { deps, writes } = makeDeps({ files });
    deps.readTail = () => files['s1/messages.jsonl'];
    const w = new AttentionWatcher(deps, MARK);
    await w.refresh();
    expect(w.isMarked).toBe(true);

    files['s1/messages.jsonl'] += '\n' + resolvedLine('t1');
    // 没有任何变更事件，直接由对账触发的 refresh 收尾
    await w.refresh();
    expect(w.isMarked).toBe(false);
    expect(writes[writes.length - 1]).toBeUndefined();
  });

  it('dispose 摘掉标记（两个标志都清）', async () => {
    const { deps, writes } = makeDeps({ files: waiting });
    const w = new AttentionWatcher(deps, MARK);
    await w.refresh();
    await w.dispose();
    expect(writes[1]).toBeUndefined();
    expect(w.pending).toEqual([]);
  });
});
