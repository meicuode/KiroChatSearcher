/**
 * Kiro 1.x 存储适配 —— 跳转命令候选链的**示例测试**。
 *
 * 与 `tests/jump.spec.ts`（0.9x 回归）的分工：那份文件钉的是「不带布局信息的既有调用形态
 * 行为逐字不变」，本文件钉的是本次适配新增的那一层——按布局推导候选链。
 *
 * 候选链的三条事实全部来自对 kiro-agent 1.0.653 `dist/extension.js` 的实测，
 * 而不是推测（见 research-notes.md 第 4 节）：
 *
 * - `kiroAgent.showExecutionInChatTab` 与 `kiroAgent.viewSpecSession` 在 1.x 上已**移除**；
 * - `kiroAgent.loadSessionWithPrompt` 还在，但签名变成 `(_sessionId, prompt)`，
 *   **sessionId 被忽略**、prompt 被当作一条新用户消息发给当前会话——所以它绝不能进 1.x 候选，
 *   本文件为此单列一条断言把它钉在候选链之外（Req 15.15）；
 * - 正确入口是 `kiroAgent.viewSession(sessionId, title?)`，降级是
 *   `kiroAgent.sessions.switch(sessionId, windowId, source)`，其中 `windowId` 必须留空
 *   （传了会去 standalone 连接池找那个窗口的 client，找不到就静默 return），`source` 取 `'local'`。
 *
 * 全部用注入的 `executeCommand` mock，不触碰 vscode API，也不需要真实 Kiro 在场。
 *
 * _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 15.15_
 */
import { describe, it, expect, vi } from 'vitest';

import {
  buildJumpCandidates,
  resolveAndExecuteJumpCommand,
  LEGACY_JUMP_COMMANDS,
  NEW_JUMP_COMMANDS,
} from '../src/jump';
import type { JumpTarget } from '../src/jump';

/* ------------------------------------------------------------------ *
 * 命令名与夹具
 * ------------------------------------------------------------------ */

/** 1.x 候选 */
const VIEW_SESSION = 'kiroAgent.viewSession';
const SESSIONS_SWITCH = 'kiroAgent.sessions.switch';
/** 0.9x 候选（1.x 上前两个已移除，第三个有副作用） */
const SHOW = 'kiroAgent.showExecutionInChatTab';
const VIEW_SPEC = 'kiroAgent.viewSpecSession';
const LOAD = 'kiroAgent.loadSessionWithPrompt';

/** 1.x 新建会话的 id 形态 */
const SESS_PREFIXED = 'sess_3f2a8c1e-4b5d-4e6f-8a9b-0c1d2e3f4a5b';
/** 从 0.9x 迁移而来的会话在 1.x 下仍是裸 uuid */
const BARE_UUID = '7d9e5b21-8c34-4f56-9a78-b1c2d3e4f5a6';

/** 构造一个只对指定命令名成功、其余抛错的 executeCommand mock */
function execOnly(...successCmds: string[]) {
  return vi.fn(async (cmd: string) => {
    if (successCmds.includes(cmd)) return undefined;
    throw new Error(`command '${cmd}' not found`);
  });
}

/** 取 mock 上被调用过的命令名序列 */
function calledCommands(mock: ReturnType<typeof execOnly>): string[] {
  return mock.mock.calls.map((c) => c[0] as string);
}

/* ------------------------------------------------------------------ *
 * 1.x 候选链：优先级与传参
 * ------------------------------------------------------------------ */

describe('1.x 候选链（Req 5.1、5.2、5.3、5.6）', () => {
  it('viewSession 可用 → 优先调用它，并传入 sessionId 与标题', async () => {
    const executeCommand = execOnly(VIEW_SESSION);
    const res = await resolveAndExecuteJumpCommand(
      { sessionId: SESS_PREFIXED, title: '重构存储层', layout: 'new-only', sessionLayout: 'new' },
      { executeCommand }
    );

    expect(res.invoked).toBe(true);
    // Req 5.9：结果里给出实际生效的命令名
    expect(res.commandUsed).toBe(VIEW_SESSION);
    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect(executeCommand).toHaveBeenCalledWith(VIEW_SESSION, SESS_PREFIXED, '重构存储层');
  });

  it('viewSession 不可用 → 回退 sessions.switch，且 windowId 留空、source 取 local', async () => {
    const executeCommand = execOnly(SESSIONS_SWITCH);
    const res = await resolveAndExecuteJumpCommand(
      { sessionId: SESS_PREFIXED, title: '重构存储层', layout: 'both', sessionLayout: 'new' },
      { executeCommand }
    );

    expect(res.invoked).toBe(true);
    expect(res.commandUsed).toBe(SESSIONS_SWITCH);
    expect(calledCommands(executeCommand)).toEqual([VIEW_SESSION, SESSIONS_SWITCH]);
    // windowId=undefined 才走「当前窗口」分支；source='remote' 会切到远端来源，故取 'local'
    expect(executeCommand).toHaveBeenLastCalledWith(
      SESSIONS_SWITCH,
      SESS_PREFIXED,
      undefined,
      'local'
    );
  });

  it('1.x 候选恰为 viewSession → sessions.switch 两项，不含任何 0.9x 命令', () => {
    const candidates = buildJumpCandidates({
      sessionId: SESS_PREFIXED,
      title: 't',
      layout: 'new-only',
    });

    expect(candidates.map((c) => c.command)).toEqual([VIEW_SESSION, SESSIONS_SWITCH]);
    // 与模块导出的命令名常量对齐，避免两处口径漂移
    expect(NEW_JUMP_COMMANDS).toEqual([VIEW_SESSION, SESSIONS_SWITCH]);
    expect(LEGACY_JUMP_COMMANDS).toEqual([SHOW, VIEW_SPEC, LOAD]);
  });

  it('1.x 候选中不含 loadSessionWithPrompt：全部失败时也绝不调用它（Req 15.15）', async () => {
    const showError = vi.fn();
    const executeCommand = execOnly(); // 全部抛错，逼出完整候选链
    const res = await resolveAndExecuteJumpCommand(
      { sessionId: SESS_PREFIXED, title: 't', layout: 'both' },
      { executeCommand, showError }
    );

    expect(res.invoked).toBe(false);
    // 只试了 1.x 两项：那条会向当前会话发消息的兜底命令一次都没被碰到
    expect(calledCommands(executeCommand)).toEqual([VIEW_SESSION, SESSIONS_SWITCH]);
    expect(calledCommands(executeCommand)).not.toContain(LOAD);
    // Req 5.7：提示里列出已尝试的候选命令名，且不该出现未尝试的命令
    const msg = showError.mock.calls[0][0] as string;
    expect(msg).toContain(VIEW_SESSION);
    expect(msg).toContain(SESSIONS_SWITCH);
    expect(msg).not.toContain(LOAD);
  });

  it('new-only / both 下即使条目是 0.9x 格式，也不追加带副作用的 0.9x 兜底', async () => {
    const executeCommand = execOnly(); // 全部抛错
    // both 布局里未迁移的旧会话：1.x 打不开是事实，但不能拿 loadSessionWithPrompt 去污染当前会话
    await resolveAndExecuteJumpCommand(
      { sessionId: BARE_UUID, layout: 'both', sessionLayout: 'old' },
      { executeCommand }
    );

    expect(calledCommands(executeCommand)).toEqual([VIEW_SESSION, SESSIONS_SWITCH]);
  });
});

/* ------------------------------------------------------------------ *
 * 标题参数（Req 5.6）
 * ------------------------------------------------------------------ */

describe('viewSession 的标题参数（Req 5.6）', () => {
  it.each([
    ['未提供标题', undefined],
    ['空字符串', ''],
    ['纯空白', '   \t\n '],
  ])('%s → 省略第二个参数，只传 sessionId', async (_label, title) => {
    const executeCommand = execOnly(VIEW_SESSION);
    await resolveAndExecuteJumpCommand(
      { sessionId: SESS_PREFIXED, title: title as string | undefined, layout: 'new-only' },
      { executeCommand }
    );

    expect(executeCommand).toHaveBeenCalledWith(VIEW_SESSION, SESS_PREFIXED);
    // 关键：参数个数为 1（命令名之外只有 sessionId），不是「传了个 undefined」
    expect(executeCommand.mock.calls[0]).toHaveLength(2);
  });

  it('非空标题原样传入，不做修剪或改写', async () => {
    const executeCommand = execOnly(VIEW_SESSION);
    await resolveAndExecuteJumpCommand(
      { sessionId: SESS_PREFIXED, title: '  带空白的标题  ', layout: 'new-only' },
      { executeCommand }
    );

    expect(executeCommand).toHaveBeenCalledWith(VIEW_SESSION, SESS_PREFIXED, '  带空白的标题  ');
  });
});

/* ------------------------------------------------------------------ *
 * sessionId 原样传递（Req 5.5）
 * ------------------------------------------------------------------ */

describe('sessionId 原样传递（Req 5.5）', () => {
  it.each([
    ['sess_ 前缀（1.x 新建）', SESS_PREFIXED],
    ['裸 uuid（0.9x 迁移而来）', BARE_UUID],
  ])('%s → 前缀不改写、不补齐、不截断', async (_label, sessionId) => {
    const viaView = execOnly(VIEW_SESSION);
    await resolveAndExecuteJumpCommand({ sessionId, title: 'x', layout: 'both' }, {
      executeCommand: viaView,
    });
    expect(viaView).toHaveBeenCalledWith(VIEW_SESSION, sessionId, 'x');

    // 降级候选同样原样传递
    const viaSwitch = execOnly(SESSIONS_SWITCH);
    await resolveAndExecuteJumpCommand({ sessionId, layout: 'both' }, {
      executeCommand: viaSwitch,
    });
    expect(viaSwitch).toHaveBeenLastCalledWith(SESSIONS_SWITCH, sessionId, undefined, 'local');
  });

  it('空 sessionId → 一个命令都不调用，也不弹提示', async () => {
    const executeCommand = vi.fn();
    const showError = vi.fn();
    const res = await resolveAndExecuteJumpCommand({ sessionId: '', layout: 'new-only' }, {
      executeCommand,
      showError,
    });

    expect(res.invoked).toBe(false);
    expect(executeCommand).not.toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ *
 * old-only 布局的降级候选（Req 5.4）
 * ------------------------------------------------------------------ */

describe('old-only 布局的 0.9x 降级候选（Req 5.4）', () => {
  const oldOnly: JumpTarget = {
    sessionId: BARE_UUID,
    title: '旧版会话',
    layout: 'old-only',
    sessionLayout: 'old',
  };

  it('候选链 = 1.x 两项 + 0.9x 三项，顺序固定', () => {
    expect(buildJumpCandidates(oldOnly).map((c) => c.command)).toEqual([
      VIEW_SESSION,
      SESSIONS_SWITCH,
      SHOW,
      VIEW_SPEC,
      LOAD,
    ]);
  });

  it('旧版 Kiro 上（只有 showExecutionInChatTab 可用）跳转结果与适配前一致', async () => {
    const executeCommand = execOnly(SHOW);
    const res = await resolveAndExecuteJumpCommand(oldOnly, { executeCommand });

    expect(res.invoked).toBe(true);
    expect(res.commandUsed).toBe(SHOW);
    expect(calledCommands(executeCommand)).toEqual([VIEW_SESSION, SESSIONS_SWITCH, SHOW]);
    // 0.9x 主命令仍只传 sessionId：带上 executionId 会把视图定位到最早一条执行记录
    expect(executeCommand).toHaveBeenLastCalledWith(SHOW, BARE_UUID);
  });

  it('全部失败 → 提示列出全部 5 个已尝试的候选命令名', async () => {
    const showError = vi.fn();
    const executeCommand = execOnly();
    const res = await resolveAndExecuteJumpCommand(oldOnly, { executeCommand, showError });

    expect(res.invoked).toBe(false);
    expect(calledCommands(executeCommand)).toEqual([
      VIEW_SESSION,
      SESSIONS_SWITCH,
      SHOW,
      VIEW_SPEC,
      LOAD,
    ]);
    const msg = showError.mock.calls[0][0] as string;
    for (const cmd of [VIEW_SESSION, SESSIONS_SWITCH, SHOW, VIEW_SPEC, LOAD]) {
      expect(msg).toContain(cmd);
    }
  });

  it('条目已是 1.x 目录型会话时不追加 0.9x 候选（条目级判据优先于工作区布局）', () => {
    expect(
      buildJumpCandidates({ ...oldOnly, sessionLayout: 'new' }).map((c) => c.command)
    ).toEqual([VIEW_SESSION, SESSIONS_SWITCH]);
  });
});

/* ------------------------------------------------------------------ *
 * 既有调用形态的兼容（0.9x 回归线的补充说明）
 * ------------------------------------------------------------------ */

describe('两种调用形态的候选链差异', () => {
  it('传 sessionId 字符串（既有形态）→ 恒为 0.9x 三项，不受本次适配影响', async () => {
    const executeCommand = execOnly(SHOW);
    const res = await resolveAndExecuteJumpCommand(BARE_UUID, { executeCommand });

    expect(res.commandUsed).toBe(SHOW);
    expect(calledCommands(executeCommand)).toEqual([SHOW]);
  });

  it('显式给出 candidates 时完全覆盖按布局的推导', async () => {
    const CUSTOM = 'my.custom.open';
    const executeCommand = execOnly(CUSTOM);
    const res = await resolveAndExecuteJumpCommand(
      { sessionId: SESS_PREFIXED, layout: 'old-only' },
      { executeCommand, candidates: [{ command: CUSTOM, buildArgs: (id) => [id] }] }
    );

    expect(res.commandUsed).toBe(CUSTOM);
    expect(calledCommands(executeCommand)).toEqual([CUSTOM]);
  });
});
