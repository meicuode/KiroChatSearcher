import { describe, it, expect } from 'vitest';
import {
  AttentionWatcher,
  isTitleMarked,
  markTitle,
  scanPendingInteractions,
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

/** 可编程的依赖替身：记录标题写入序列，供断言还原终态。 */
function makeDeps(opts: {
  files?: Record<string, string>;
  title?: { workspaceValue?: string; globalValue?: string; defaultValue?: string };
}) {
  const files = opts.files ?? {};
  const title = { ...(opts.title ?? { defaultValue: '${dirty}${activeEditorShort}' }) };
  const writes: Array<string | undefined> = [];
  const states: PendingInteraction[][] = [];
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
    onStateChange: (p) => void states.push([...p]),
  };
  return { deps, writes, states, title };
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
    expect(states[states.length - 1]).toEqual([]);
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
    expect(states[0].map((p) => p.toolCallId)).toEqual(['t1']);
  });

  it('dispose 摘掉标记', async () => {
    const { deps, writes } = makeDeps({ files: waiting });
    const w = new AttentionWatcher(deps, MARK);
    await w.refresh();
    await w.dispose();
    expect(writes[1]).toBeUndefined();
    expect(w.pending).toEqual([]);
  });
});
