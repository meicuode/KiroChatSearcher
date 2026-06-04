import { describe, it, expect, vi } from 'vitest';
import { resolveAndExecuteJumpCommand } from '../src/jump';

// 当前实测确认的命令优先级（与 src/jump.ts 的 DEFAULT_CANDIDATES 对应）
const SHOW = 'kiroAgent.showExecutionInChatTab';
const VIEW = 'kiroAgent.viewSpecSession';
const LOAD = 'kiroAgent.loadSessionWithPrompt';

/** 构造一个只对指定命令名成功、其余抛错的 executeCommand mock */
function execOnly(...successCmds: string[]) {
  return vi.fn(async (cmd: string) => {
    if (successCmds.includes(cmd)) return undefined;
    throw new Error(`command '${cmd}' not found`);
  });
}

describe('resolveAndExecuteJumpCommand', () => {
  it('主命令 showExecutionInChatTab 成功 → 使用它，且仅传 sessionId（不带 executionId）', async () => {
    const executeCommand = execOnly(SHOW);
    const res = await resolveAndExecuteJumpCommand('sid1', {
      getCommands: async () => [],
      executeCommand,
    });
    expect(res.invoked).toBe(true);
    expect(res.commandUsed).toBe(SHOW);
    // 关键：只传 sessionId，不能带第二个 executionId 参数（否则会跳到对话开头）
    expect(executeCommand).toHaveBeenCalledWith(SHOW, 'sid1');
  });

  it('即使命令不在 getCommands 列表中也直接尝试调用', async () => {
    // 模拟 Kiro：getCommands 不列出 kiroAgent.* 命令，但命令实际可执行
    const executeCommand = execOnly(SHOW);
    const res = await resolveAndExecuteJumpCommand('sid1b', {
      getCommands: async () => ['workbench.action.files.save'],
      executeCommand,
    });
    expect(res.invoked).toBe(true);
    expect(res.commandUsed).toBe(SHOW);
  });

  it('主命令不可用 → 回退到 viewSpecSession（旧版兼容）', async () => {
    const executeCommand = execOnly(VIEW);
    const res = await resolveAndExecuteJumpCommand('sid2', {
      getCommands: async () => [],
      executeCommand,
    });
    expect(res.invoked).toBe(true);
    expect(res.commandUsed).toBe(VIEW);
    expect(executeCommand).toHaveBeenCalledTimes(2);
  });

  it('前两个都不可用 → 兜底到 loadSessionWithPrompt(sessionId, "")', async () => {
    const executeCommand = execOnly(LOAD);
    const res = await resolveAndExecuteJumpCommand('sid3', {
      getCommands: async () => [],
      executeCommand,
    });
    expect(res.invoked).toBe(true);
    expect(res.commandUsed).toBe(LOAD);
    expect(executeCommand).toHaveBeenCalledTimes(3);
    // 兜底命令需要第二个 prompt 参数（空串）
    expect(executeCommand).toHaveBeenLastCalledWith(LOAD, 'sid3', '');
  });

  it('所有命令都失败 → showError 文案包含全部候选命令名', async () => {
    const showError = vi.fn();
    const executeCommand = execOnly(); // 全部抛错
    const res = await resolveAndExecuteJumpCommand('sid4', {
      getCommands: async () => ['some.other.command'],
      executeCommand,
      showError,
    });
    expect(res.invoked).toBe(false);
    expect(showError).toHaveBeenCalledTimes(1);
    const msg = showError.mock.calls[0][0] as string;
    expect(msg).toContain(SHOW);
    expect(msg).toContain(VIEW);
    expect(msg).toContain(LOAD);
  });

  it('空 sessionId → 不调用任何命令', async () => {
    const executeCommand = vi.fn();
    const showError = vi.fn();
    const res = await resolveAndExecuteJumpCommand('', { executeCommand, showError });
    expect(res.invoked).toBe(false);
    expect(executeCommand).not.toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();
  });

  it('自定义候选列表 → 按给定顺序与传参方式调用', async () => {
    const CUSTOM = 'my.custom.open';
    const executeCommand = execOnly(CUSTOM);
    const res = await resolveAndExecuteJumpCommand('sid5', {
      executeCommand,
      candidates: [{ command: CUSTOM, buildArgs: (id) => [id, { mode: 'x' }] }],
    });
    expect(res.invoked).toBe(true);
    expect(res.commandUsed).toBe(CUSTOM);
    expect(executeCommand).toHaveBeenCalledWith(CUSTOM, 'sid5', { mode: 'x' });
  });
});
