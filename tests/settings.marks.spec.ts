import { describe, it, expect } from 'vitest';
import {
  AttentionWatcher,
  DEFAULT_DONE_MARK,
  DEFAULT_TITLE_MARK,
  type AttentionDeps,
} from '../src/attention';
import { markPreview, normalizeMark } from '../src/webview/marks';
import { getSettingsHtml } from '../src/settings';

/**
 * 设置页「提醒标记」一节：归一化规则、预览、以及页面上那些前端脚本靠 id 抓的锚点。
 *
 * 这一节的风险不在算法难度，而在**三处副本必须说同一件事**：
 *   1. `webview/marks.ts` 里写死的默认字面量
 *   2. `attention.ts` 导出的 `DEFAULT_TITLE_MARK` / `DEFAULT_DONE_MARK`
 *   3. `package.json` 里两项配置的 `default`
 * 副本存在是注入安全逼出来的（注入的函数体不能引用导出常量，见 `webview/marks.ts` 顶部），
 * 所以这里用断言把它们钉在一起——改一处忘了另一处会红，而不是等用户发现默认值不一致。
 *
 * 预览还额外与 `AttentionWatcher` 真写出去的标题做了一次对账：预览不该只是「大概长这样」。
 */

describe('normalizeMark - 归一化', () => {
  it('结尾没有空白就补一个（否则 emoji 和标题会黏在一起）', () => {
    expect(normalizeMark('🔴')).toBe('🔴 ');
    expect(normalizeMark('🔴 ')).toBe('🔴 ');
    expect(normalizeMark('*')).toBe('* ');
  });

  it('已有的尾部空白原样保留，不叠加', () => {
    expect(normalizeMark('🔴  ')).toBe('🔴  ');
    expect(normalizeMark('🔴\t')).toBe('🔴\t');
  });

  it('空 / 纯空白退回 fallback', () => {
    expect(normalizeMark('')).toBe('🔴 ');
    expect(normalizeMark('   ')).toBe('🔴 ');
    expect(normalizeMark('', '✅ ')).toBe('✅ ');
    // 显式给空 fallback 时不硬塞默认值：候选高亮要靠「空值 → 空串」来表示「没选中任何一个」
    expect(normalizeMark('', '')).toBe('');
  });

  it('非字符串入参不抛错（配置文件可以被手改成任何东西）', () => {
    expect(normalizeMark(undefined as unknown as string)).toBe('🔴 ');
    expect(normalizeMark(42 as unknown as string)).toBe('🔴 ');
  });

  it('默认值与 attention.ts 导出的常量一致（注入安全逼出来的副本，必须同步）', () => {
    expect(normalizeMark('')).toBe(DEFAULT_TITLE_MARK);
    expect(markPreview({ titleMark: '', doneMark: '' }).doneMark).toBe(DEFAULT_DONE_MARK);
  });
});

describe('markPreview - 标题预览', () => {
  it('四种情形，✅ 恒排在 🔴 前面', () => {
    const p = markPreview({ titleMark: '🔴 ', doneMark: '✅ ', sample: 'X' });
    expect(p.lines.map((l) => l.title)).toEqual(['✅ 🔴 X', '🔴 X', '✅ X', 'X']);
    expect(p.lines.map((l) => l.label)).toEqual([
      '两者并存',
      '只在等你确认',
      '只是跑完一轮',
      '都没有',
    ]);
  });

  it('预览用的是归一化后的标记，并如实报告「改过你的输入」', () => {
    const p = markPreview({ titleMark: '🟠', doneMark: '🟢', sample: 'X' });
    expect(p.titleMark).toBe('🟠 ');
    expect(p.doneMark).toBe('🟢 ');
    expect(p.normalized).toBe(true);
    expect(p.lines[0].title).toBe('🟢 🟠 X');
  });

  it('两项都已带尾空格时 normalized 为假（不报告没发生的修正）', () => {
    expect(markPreview({ titleMark: '🔴 ', doneMark: '✅ ' }).normalized).toBe(false);
  });

  it('缺省 sample 也能出预览，非字符串入参不抛错', () => {
    expect(markPreview({ titleMark: '🔴 ', doneMark: '✅ ' }).lines[3].title).toBeTruthy();
    const p = markPreview({ titleMark: null, doneMark: undefined } as unknown as {
      titleMark: string;
      doneMark: string;
    });
    expect(p.titleMark).toBe(DEFAULT_TITLE_MARK);
    expect(p.doneMark).toBe(DEFAULT_DONE_MARK);
  });
});

/* ------------------------------------------------------------------ *
 * 预览 ⨝ 真实写入：预览拼的必须就是 AttentionWatcher 写进 window.title 的那个串
 * ------------------------------------------------------------------ */

function eventLine(id: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ id, timestamp: '2026-09-03T01:00:00.000Z', payload });
}

const pendingLine = (id: string) =>
  eventLine(id, { type: 'pending_interaction', interactionType: 'tool_approval', toolCallId: id });

const turnEndLine = (id: string) => eventLine(id, { type: 'turn_end', stopReason: 'end_turn' });

describe('预览与真实标题一致', () => {
  it('「两者并存」那一行等于 watcher 实际写出去的标题', async () => {
    const titleMark = '🟠 ';
    const doneMark = '🎉 ';
    const base = '我的项目 - Kiro';

    let raw = turnEndLine('turn-1');
    const writes: Array<string | undefined> = [];
    const deps: AttentionDeps = {
      sessionDir: () => '/ws',
      listDir: () => ['s1'],
      readTail: () => raw,
      // 只给 defaultValue：还原策略不依赖持久化原值，这也是最常见的真实情形
      readTitle: () => ({ defaultValue: base }),
      writeTitle: async (v) => void writes.push(v),
      onStateChange: () => {},
      isWindowFocused: () => false,
    };

    const w = new AttentionWatcher(deps, titleMark, [], doneMark);
    await w.refresh(); // 首次只建基线，不该触发「完成」
    expect(writes).toEqual([]);

    // 又跑完一轮（新的 turn_end id），并且卡在一个待确认上
    raw = [turnEndLine('turn-2'), pendingLine('t1')].join('\n');
    await w.refresh();

    expect(w.hasDone).toBe(true);
    expect(w.pending).toHaveLength(1);
    const both = markPreview({ titleMark, doneMark, sample: base }).lines[0].title;
    expect(writes).toEqual([both]);
  });
});

/* ------------------------------------------------------------------ *
 * 页面：版本号 + 「提醒标记」一节的锚点
 * ------------------------------------------------------------------ */

const CSP = 'vscode-webview://kcs';
const NONCE = 'settings-marks-nonce';

describe('getSettingsHtml - 版本号', () => {
  it('给了版本号就渲染 v<版本>', () => {
    const html = getSettingsHtml(CSP, NONCE, '1.6.1');
    expect(html).toContain('<span class="ver">v1.6.1</span>');
  });

  it('没给版本号时不留空标签', () => {
    expect(getSettingsHtml(CSP, NONCE)).not.toContain('class="ver"');
  });

  it('版本号做 HTML 转义（取数来源以后变了也不至于成为注入点）', () => {
    const html = getSettingsHtml(CSP, NONCE, '1.0.0"><script>x</script>');
    expect(html).not.toContain('"><script>x');
    expect(html).toContain('&quot;&gt;&lt;script&gt;x&lt;/script&gt;');
  });
});

describe('getSettingsHtml - 提醒标记一节', () => {
  const html = getSettingsHtml(CSP, NONCE, '1.6.1');

  it('前端脚本抓的 id 都在页面上', () => {
    for (const id of [
      'marksSection',
      'marksEnabled',
      'marksSwitchBox',
      'markFields',
      'titleMark',
      'doneMark',
      'titleMarkPresets',
      'doneMarkPresets',
      'markPreview',
      'markHint',
      'marksSaved',
    ]) {
      expect(html, `缺少 id="${id}"`).toContain(`id="${id}"`);
    }
  });

  it('注入了归一化与预览两个纯函数（漏注入的话预览会整段不动）', () => {
    expect(html).toContain('function normalizeMark');
    expect(html).toContain('function markPreview');
  });

  it('候选标记都能归一化成「非空 + 尾部留白」，且默认值在候选里', () => {
    const marks = [...html.matchAll(/data-mark="([^"]*)"/g)].map((m) => m[1]);
    expect(marks.length).toBeGreaterThanOrEqual(10);
    for (const m of marks) {
      const n = normalizeMark(m, '');
      expect(n, `候选 ${JSON.stringify(m)} 归一化后为空`).not.toBe('');
      expect(/\s$/.test(n), `候选 ${JSON.stringify(m)} 结尾没有留白`).toBe(true);
    }
    expect(marks.map((m) => normalizeMark(m, ''))).toContain(DEFAULT_TITLE_MARK);
    expect(marks.map((m) => normalizeMark(m, ''))).toContain(DEFAULT_DONE_MARK);
  });
});
