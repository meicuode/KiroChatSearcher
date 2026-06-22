import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  hash32,
  extractUsageSummaryArray,
  sumCreditsFromUsageSummary,
  getCreditsForExecutions,
  storeRootFromSessionDir,
  __clearCreditCacheForTest,
} from '../src/credits';
import {
  listRecentSessions,
  searchSessionsInDir,
  __clearIndexCacheForTest,
} from '../src/search';
import { mkTempDir, rmTempDir } from './_helpers';

const tmpDirs: string[] = [];
afterEach(() => {
  __clearCreditCacheForTest();
  __clearIndexCacheForTest();
  while (tmpDirs.length) rmTempDir(tmpDirs.pop()!);
});

function freshDir(): string {
  const d = mkTempDir();
  tmpDirs.push(d);
  return d;
}

/** 在 storeRoot 下按 Kiro 的哈希布局写一个执行存档文件。 */
function writeExecution(
  storeRoot: string,
  workspaceId: string,
  executionId: string,
  obj: unknown,
  opts: { underSavesFolder?: boolean } = {}
): string {
  let dir = path.join(storeRoot, workspaceId);
  if (opts.underSavesFolder) {
    dir = path.join(dir, hash32('KIRO::EXECUTION::SAVES'));
  }
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, hash32(executionId));
  fs.writeFileSync(full, JSON.stringify(obj), 'utf8');
  return full;
}

describe('hash32', () => {
  it('与 Kiro 实测哈希一致（已知键）', () => {
    // 这些值在真实 Kiro 安装上逆向核对过。
    expect(hash32('KIRO::EXECUTION::METADATA')).toBe('f62de366d0006e17ea00a01f6624aabf');
    expect(hash32('KIRO::EXECUTION::SAVES')).toBe('414d1636299d2b9e4ce7e17fb11f63e9');
    expect(hash32('7c56dac9-b51a-4be0-aca5-48aa0c669eae')).toBe(
      '12ead51a160773e06f3e20f6fbd0e5a2'
    );
  });

  it('输出恒为 32 位十六进制', () => {
    expect(hash32('anything')).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('extractUsageSummaryArray', () => {
  it('从含大 operations 的对象中只切出 usageSummary 数组', () => {
    const raw = JSON.stringify({
      operations: [{ output: { message: ']'.repeat(1000) } }],
      usageSummary: [
        { usage: 0.12, unit: 'credit', unitPlural: 'credits' },
        { usedTools: ['execute_pwsh'] },
      ],
      tail: true,
    });
    const arr = extractUsageSummaryArray(raw);
    expect(arr).not.toBeNull();
    const parsed = JSON.parse(arr!);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].unit).toBe('credit');
  });

  it('字符串内的 ] 不会提前截断数组', () => {
    const raw = '{"usageSummary":[{"unit":"credit","usage":1,"note":"has ] bracket"}]}';
    const arr = extractUsageSummaryArray(raw);
    expect(JSON.parse(arr!)[0].note).toBe('has ] bracket');
  });

  it('无 usageSummary 时返回 null', () => {
    expect(extractUsageSummaryArray('{"foo":1}')).toBeNull();
  });
});

describe('sumCreditsFromUsageSummary', () => {
  it('只累加 unit==="credit" 的 usage', () => {
    const text = JSON.stringify([
      { usage: 0.1, unit: 'credit' },
      { usage: 99, unit: 'tokens' }, // 非 credit，忽略
      { usedTools: ['x'] }, // 无 usage，忽略
      { usage: 0.05, unit: 'CREDIT' }, // 大小写不敏感
    ]);
    expect(sumCreditsFromUsageSummary(text)).toBeCloseTo(0.15, 10);
  });

  it('非数组 / 损坏输入返回 0', () => {
    expect(sumCreditsFromUsageSummary('not json')).toBe(0);
    expect(sumCreditsFromUsageSummary('{"a":1}')).toBe(0);
  });
});

describe('storeRootFromSessionDir', () => {
  it('向上两级得到 kiroagent 根', () => {
    const root = path.join('/x', 'kiro.kiroagent');
    const sessionDir = path.join(root, 'workspace-sessions', 'ENCODEDKEY');
    expect(storeRootFromSessionDir(sessionDir)).toBe(path.resolve(root));
  });
});

describe('getCreditsForExecutions', () => {
  it('跨多个执行汇总 credit（扁平布局 + SAVES 子目录布局都能找到）', () => {
    const root = freshDir();
    writeExecution(root, 'ws1', 'eid-A', {
      executionId: 'eid-A',
      usageSummary: [{ usage: 0.2, unit: 'credit', unitPlural: 'credits' }],
    });
    writeExecution(
      root,
      'ws1',
      'eid-B',
      {
        executionId: 'eid-B',
        usageSummary: [
          { usage: 0.3, unit: 'credit' },
          { usedTools: ['execute_pwsh'] },
        ],
      },
      { underSavesFolder: true }
    );

    const res = getCreditsForExecutions(root, ['eid-A', 'eid-B']);
    expect(res.found).toBe(true);
    expect(res.credits).toBeCloseTo(0.5, 10);
  });

  it('找不到任何执行存档时 found=false、credits=0', () => {
    const root = freshDir();
    const res = getCreditsForExecutions(root, ['missing-eid']);
    expect(res.found).toBe(false);
    expect(res.credits).toBe(0);
  });

  it('部分命中：缺失的 executionId 被跳过，仍返回 found=true', () => {
    const root = freshDir();
    writeExecution(root, 'ws1', 'eid-A', {
      usageSummary: [{ usage: 1.5, unit: 'credit' }],
    });
    const res = getCreditsForExecutions(root, ['eid-A', 'eid-gone']);
    expect(res.found).toBe(true);
    expect(res.credits).toBeCloseTo(1.5, 10);
  });

  it('空 executionId 列表安全返回', () => {
    const root = freshDir();
    expect(getCreditsForExecutions(root, [])).toEqual({ credits: 0, found: false });
  });
});

describe('search 集成：credits / contextPercentage 流入结果', () => {
  /** 搭建 <root>/workspace-sessions/<key>/ 会话目录与同级执行存档。 */
  function buildLayout() {
    const root = freshDir(); // 充当 kiro.kiroagent 根
    const sessionDir = path.join(root, 'workspace-sessions', 'ENCODEDKEY');
    fs.mkdirSync(sessionDir, { recursive: true });
    return { root, sessionDir };
  }

  it('listRecentSessions 汇总会话的 credit 并附带上下文百分比', () => {
    const { root, sessionDir } = buildLayout();
    // 会话引用两个 executionId，且带 contextUsagePercentage
    fs.writeFileSync(
      path.join(sessionDir, 's1.json'),
      JSON.stringify({
        title: 'Session One',
        contextUsagePercentage: 42.5,
        history: [
          { message: { role: 'user', content: 'hello' } },
          { message: { role: 'assistant', content: 'hi' }, executionId: 'eid-A' },
          { message: { role: 'assistant', content: 'more' }, executionId: 'eid-B' },
        ],
      }),
      'utf8'
    );
    writeExecution(root, 'ws1', 'eid-A', {
      usageSummary: [{ usage: 0.4, unit: 'credit' }],
    });
    writeExecution(root, 'ws1', 'eid-B', {
      usageSummary: [{ usage: 0.6, unit: 'credit' }],
    });

    const hits = listRecentSessions(sessionDir, 20);
    expect(hits).toHaveLength(1);
    expect(hits[0].credits).toBeCloseTo(1.0, 10);
    expect(hits[0].contextPercentage).toBeCloseTo(42.5, 10);
  });

  it('查不到执行存档时 credits 保持 undefined，但仍带 contextPercentage 回退', () => {
    const { sessionDir } = buildLayout();
    fs.writeFileSync(
      path.join(sessionDir, 's2.json'),
      JSON.stringify({
        title: 'No Exec Data',
        contextUsagePercentage: 12.3,
        history: [{ message: { role: 'assistant', content: 'x' }, executionId: 'gone' }],
      }),
      'utf8'
    );
    const hits = searchSessionsInDir(sessionDir, 'No Exec', 10);
    expect(hits).toHaveLength(1);
    expect(hits[0].credits).toBeUndefined();
    expect(hits[0].contextPercentage).toBeCloseTo(12.3, 10);
  });
});
