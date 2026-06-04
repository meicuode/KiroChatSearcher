import { describe, it, expect, vi } from 'vitest';
import { resolveAndExecuteJumpCommand } from '../src/jump';

const VIEW = 'kiroAgent.viewSpecSession';
const OPEN = 'kiroAgent.openChatSession';

describe('resolveAndExecuteJumpCommand', () => {
  it('viewSpecSession 存在并成功 → 使用它', async () => {
    const executeCommand = vi.fn().mockResolvedValue(undefined);
    const res = await resolveAndExecuteJumpCommand('sid1', {
      getCommands: async () => [VIEW, OPEN],
      executeCommand,
    });
    expect(res.invoked).toBe(true);
    expect(res.commandUsed).toBe(VIEW);
    expect(executeCommand).toHaveBeenCalledWith(VIEW, 'sid1');
  });

  it('viewSpecSession 抛错 → 回退到 openChatSession', async () => {
    const executeCommand = vi.fn(async (cmd: string) => {
      if (cmd === VIEW) throw new Error('boom');
      return undefined;
    });
    const res = await resolveAndExecuteJumpCommand('sid2', {
      getCommands: async () => [VIEW, OPEN],
      executeCommand,
    });
    expect(res.invoked).toBe(true);
    expect(res.commandUsed).toBe(OPEN);
    expect(executeCommand).toHaveBeenCalledTimes(2);
  });

  it('只有 openChatSession 可用 → 使用 openChatSession', async () => {
    const executeCommand = vi.fn().mockResolvedValue(undefined);
    const res = await resolveAndExecuteJumpCommand('sid3', {
      getCommands: async () => [OPEN],
      executeCommand,
    });
    expect(res.invoked).toBe(true);
    expect(res.commandUsed).toBe(OPEN);
  });

  it('两个命令都不可用 → showError 文案同时包含两个命令名', async () => {
    const showError = vi.fn();
    const executeCommand = vi.fn();
    const res = await resolveAndExecuteJumpCommand('sid4', {
      getCommands: async () => ['some.other.command'],
      executeCommand,
      showError,
    });
    expect(res.invoked).toBe(false);
    expect(executeCommand).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledTimes(1);
    const msg = showError.mock.calls[0][0] as string;
    expect(msg).toContain(VIEW);
    expect(msg).toContain(OPEN);
  });

  it('空 sessionId → 不调用任何命令', async () => {
    const executeCommand = vi.fn();
    const showError = vi.fn();
    const res = await resolveAndExecuteJumpCommand('', { executeCommand, showError });
    expect(res.invoked).toBe(false);
    expect(executeCommand).not.toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();
  });

  it('getCommands 抛错 → 仍尝试候选命令', async () => {
    const executeCommand = vi.fn().mockResolvedValue(undefined);
    const res = await resolveAndExecuteJumpCommand('sid5', {
      getCommands: async () => {
        throw new Error('no api');
      },
      executeCommand,
    });
    // available 为空时不按列表过滤，直接尝试候选
    expect(res.invoked).toBe(true);
    expect(res.commandUsed).toBe(VIEW);
  });
});
