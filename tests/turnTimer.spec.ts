import { describe, it, expect } from 'vitest';
import * as path from 'path';
import {
  TURN_TIMER_BACKUP_SUFFIX,
  TURN_TIMER_MARKER,
  TURN_TIMER_SCRIPT_FILENAME,
  applyTurnTimer,
  detectTurnTimer,
  discoverEntryNames,
  revertTurnTimer,
  stripInjection,
  surveyTurnTimerTargets,
  type TurnTimerFsDeps,
  type TurnTimerOptions,
} from '../src/turnTimer';

/**
 * TurnTimerPatch：入口发现、状态判定、打补丁与还原。
 *
 * 这个模块此前**零测试覆盖**，而它是整个扩展唯一会写 Kiro 安装目录的代码，
 * 也是这次线上事故的现场：早先它把目标写死成「`kiro-ui-agent-chat/dist` 下三个入口」，
 * Kiro 1.1.14 把侧边栏与编辑器分栏的面板搬到了新包 `kiro-ui-session-details`，
 * 于是旧包那三个入口依然被打得好好的、探测如实报告 **`on`（已生效）**，
 * 而用户日常用的面板根本不加载那个包——功能完全失效，状态却一片绿。
 *
 * 所以这里的断言重心不是「能不能打上」，而是**状态会不会说谎**：
 * 见「不谎报已生效」那一组。
 */

/* ------------------------------------------------------------------ *
 * 内存文件系统
 * ------------------------------------------------------------------ */

interface MemFs {
  deps: TurnTimerFsDeps;
  /** 当前所有文件内容（绝对路径用 `/` 分隔）。 */
  read(p: string): string | undefined;
  has(p: string): boolean;
  /** 写过的路径序列（判断幂等：不该有多余写入）。 */
  writes: string[];
  /** 删过的路径序列。 */
  unlinks: string[];
}

function memFs(files: Record<string, string>): MemFs {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  const store = new Map<string, { text: string; mtimeMs: number }>();
  const dirs = new Map<string, Set<string>>();
  const writes: string[] = [];
  const unlinks: string[] = [];
  let clock = 1_000;

  const link = (key: string) => {
    let cur = key;
    for (;;) {
      const i = cur.lastIndexOf('/');
      const parent = cur.slice(0, i) || '/';
      const name = cur.slice(i + 1);
      if (!dirs.has(parent)) dirs.set(parent, new Set());
      dirs.get(parent)!.add(name);
      if (parent === '/' || parent === cur) break;
      cur = parent;
    }
  };

  const put = (p: string, text: string) => {
    const key = norm(p);
    store.set(key, { text, mtimeMs: clock++ });
    link(key);
  };

  for (const [p, t] of Object.entries(files)) put(p, t);

  const deps: TurnTimerFsDeps = {
    existsSync: (p) => {
      const k = norm(p);
      return store.has(k) || dirs.has(k);
    },
    statSync: (p) => {
      const e = store.get(norm(p));
      if (!e) throw new Error('ENOENT ' + p);
      return { mtimeMs: e.mtimeMs };
    },
    readdirSync: (p) => {
      const k = norm(p);
      // 对文件调 readdir 必须抛——被测代码正是靠这个判断「不是目录」
      if (store.has(k)) throw new Error('ENOTDIR ' + p);
      const set = dirs.get(k);
      if (!set) throw new Error('ENOENT ' + p);
      return [...set];
    },
    readFileSync: (p) => {
      const e = store.get(norm(p));
      if (!e) throw new Error('ENOENT ' + p);
      return e.text;
    },
    writeFileSync: (p, data) => {
      writes.push(norm(p));
      put(p, data);
    },
    unlinkSync: (p) => {
      const k = norm(p);
      if (!store.delete(k)) throw new Error('ENOENT ' + p);
      unlinks.push(k);
      const i = k.lastIndexOf('/');
      dirs.get(k.slice(0, i) || '/')?.delete(k.slice(i + 1));
    },
  };

  return {
    deps,
    read: (p) => store.get(norm(p))?.text,
    has: (p) => store.has(norm(p)) || dirs.has(norm(p)),
    writes,
    unlinks,
  };
}

/* ------------------------------------------------------------------ *
 * 夹具：照抄 Kiro 1.1.14 的真实形态
 * ------------------------------------------------------------------ */

const APP = '/app';
const AGENT = '/app/extensions/kiro.kiro-agent';
const OLD_DIST = `${AGENT}/packages/kiro-ui-agent-chat/dist`;
const NEW_DIST = `${AGENT}/packages/kiro-ui-session-details/dist`;
const ASSET = '/ext/media/kcs-turn-timer.js';
const SCRIPT_BODY = '/* kcs turn timer v6 */\n';

/**
 * Kiro bundle 里 `entryPoint` 的四种真实写法（1.1.14 实测）。
 * 末尾那些 `entryPoints:[…]` 是代码分析模块的无关字段，用来确认不会被误认成入口。
 */
const KIRO_BUNDLE = [
  'constructor({context:e,entryPoint:r="session-view",initData:n}){}',
  'this.sidebarViewProvider=new RY({context:e,entryPoint:"session-manager-surface"});',
  'new RY({context:this.context,entryPoint:"session-surface",initData:{id:e.id}});',
  'if(t.standalone.entryPoint==="standalone"){}',
  'a.setSidebarViewProvider(new RY({context:r,entryPoint:"session-manager"}),d);',
  'return{entryPoints:[...t.entryPoints],moduleDependencies:x};',
  'r.push({type:"cli",function:n,module:s.module});e.entryPoints=r;',
].join('\n');

const ENTRY_BODY = 'createRoot(document.getElementById("root")).render(x);\n';
const PATCHED_BODY = `${ENTRY_BODY}import "../${TURN_TIMER_SCRIPT_FILENAME}"; ${TURN_TIMER_MARKER}\n`;

/** 造一棵 Kiro 安装树。`patched` 里列出的入口预先打好补丁。 */
function tree(opts: {
  patched?: string[];
  scriptIn?: string[];
  scriptBody?: string;
  bundle?: string;
  extraEntries?: Record<string, string>;
} = {}): Record<string, string> {
  const patched = new Set(opts.patched ?? []);
  const out: Record<string, string> = {
    [ASSET]: SCRIPT_BODY,
    [`${AGENT}/dist/extension.js`]: opts.bundle ?? KIRO_BUNDLE,
  };
  const add = (dist: string, entry: string) => {
    out[`${dist}/${entry}/main.js`] = patched.has(entry) ? PATCHED_BODY : ENTRY_BODY;
  };
  add(OLD_DIST, 'session-manager');
  add(OLD_DIST, 'session-view');
  add(OLD_DIST, 'standalone');
  add(NEW_DIST, 'session-manager-surface');
  add(NEW_DIST, 'session-surface');
  // 无关产物：不是入口（没有 main.js）也不该被碰
  out[`${OLD_DIST}/assets/mermaid-abc.js`] = 'irrelevant';
  out[`${NEW_DIST}/style.css`] = 'irrelevant';
  for (const dist of opts.scriptIn ?? []) {
    out[`${dist}/${TURN_TIMER_SCRIPT_FILENAME}`] = opts.scriptBody ?? SCRIPT_BODY;
  }
  Object.assign(out, opts.extraEntries ?? {});
  return out;
}

function optsFor(fs: MemFs, hostStartedAt?: number): TurnTimerOptions {
  const o: TurnTimerOptions = { appRoot: APP, assetPath: ASSET, fsDeps: fs.deps };
  if (hostStartedAt !== undefined) o.hostStartedAt = hostStartedAt;
  return o;
}

const p = (...segs: string[]) => path.join(...segs);

/* ------------------------------------------------------------------ *
 * 1. 入口发现
 * ------------------------------------------------------------------ */

describe('discoverEntryNames - 从 Kiro 的 bundle 里认入口', () => {
  it('四种写法都认得，去重并排序', () => {
    expect(discoverEntryNames(KIRO_BUNDLE)).toEqual([
      'session-manager',
      'session-manager-surface',
      'session-surface',
      'session-view',
      'standalone',
    ]);
  });

  it('不把 entryPoints 这类无关字段误认成入口名', () => {
    const names = discoverEntryNames('e.entryPoints=r;return{entryPoints:[...t.entryPoints]};');
    expect(names).toEqual([]);
  });

  it('认不出任何东西时返回空数组（交给调用方降级）', () => {
    expect(discoverEntryNames('')).toEqual([]);
    expect(discoverEntryNames('no entry points here')).toEqual([]);
  });
});

describe('surveyTurnTimerTargets - 用文件系统确认入口落在哪个 dist', () => {
  it('跨两个包正确分组（Kiro 1.1.x 的真实形态）', () => {
    const fs = memFs(tree());
    const s = surveyTurnTimerTargets(optsFor(fs));
    expect(s.source).toBe('kiro');
    expect(s.bundles.map((b) => b.label)).toEqual([
      'packages/kiro-ui-agent-chat/dist',
      'packages/kiro-ui-session-details/dist',
    ]);
    expect(s.bundles[0].entries).toEqual(['session-manager', 'session-view', 'standalone']);
    expect(s.bundles[1].entries).toEqual(['session-manager-surface', 'session-surface']);
    expect(s.unlocated).toEqual([]);
  });

  it('不假设 packages/<pkg>/dist 这个层级：入口挪到别处也能找到', () => {
    // 只保留一个入口，且放在完全不同的层级下
    const fs = memFs({
      [ASSET]: SCRIPT_BODY,
      [`${AGENT}/dist/extension.js`]: 'new X({entryPoint:"session-surface"});',
      [`${AGENT}/webviews/build/session-surface/main.js`]: ENTRY_BODY,
    });
    const s = surveyTurnTimerTargets(optsFor(fs));
    expect(s.bundles).toHaveLength(1);
    expect(s.bundles[0].label).toBe('webviews/build');
    expect(s.bundles[0].entries).toEqual(['session-surface']);
  });

  it('读不到 Kiro 的 bundle → 降级为内置清单，并说明原因', () => {
    const t = tree();
    delete t[`${AGENT}/dist/extension.js`];
    const s = surveyTurnTimerTargets(optsFor(memFs(t)));
    expect(s.source).toBe('fallback');
    expect(s.reason).toContain('读不到');
    // 降级清单仍然覆盖到两个包（内置清单是并集）
    expect(s.bundles).toHaveLength(2);
  });

  it('认不出入口名 → 同样降级，原因不同', () => {
    const s = surveyTurnTimerTargets(optsFor(memFs(tree({ bundle: 'nothing useful here' }))));
    expect(s.source).toBe('fallback');
    expect(s.reason).toContain('没认出');
  });

  it('认出来但磁盘上没有的名字只进 unlocated，不影响分组', () => {
    const fs = memFs(tree({ bundle: KIRO_BUNDLE + '\nnew X({entryPoint:"ghost-surface"});' }));
    const s = surveyTurnTimerTargets(optsFor(fs));
    expect(s.discovered).toContain('ghost-surface');
    expect(s.unlocated).toEqual(['ghost-surface']);
    expect(s.bundles).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ *
 * 2. 不谎报已生效（本次事故的回归钉子）
 * ------------------------------------------------------------------ */

describe('detectTurnTimer - 不谎报已生效', () => {
  it('旧包全打上、新包没打 → partial，且点名是哪个包的哪些入口', () => {
    // 这正是 Kiro 1.1.14 升级后的真实状态：旧实现在这里会报 on
    const fs = memFs(
      tree({
        patched: ['session-manager', 'session-view', 'standalone'],
        scriptIn: [OLD_DIST],
      })
    );
    const st = detectTurnTimer(optsFor(fs));
    expect(st.state).toBe('partial');
    expect(st.detail).toContain('kiro-ui-session-details');
    expect(st.detail).toContain('session-manager-surface');
    expect(st.detail).toContain('session-surface');
    expect(st.scriptInstalled).toBe(false); // 新包那份还不存在
  });

  it('入口清单降级时绝不报 on，即使磁盘上全都打好了', () => {
    const t = tree({
      patched: ['session-manager', 'session-view', 'standalone', 'session-manager-surface', 'session-surface'],
      scriptIn: [OLD_DIST, NEW_DIST],
    });
    delete t[`${AGENT}/dist/extension.js`]; // 认不出清单
    const st = detectTurnTimer(optsFor(memFs(t), Number.MAX_SAFE_INTEGER));
    expect(st.state).toBe('partial');
    expect(st.survey.source).toBe('fallback');
    expect(st.detail).toContain('无法确认');
  });

  it('两个包都打好、脚本一致、且补丁早于本窗口启动 → on', () => {
    const fs = memFs(
      tree({
        patched: [
          'session-manager',
          'session-view',
          'standalone',
          'session-manager-surface',
          'session-surface',
        ],
        scriptIn: [OLD_DIST, NEW_DIST],
      })
    );
    const st = detectTurnTimer(optsFor(fs, Number.MAX_SAFE_INTEGER));
    expect(st.state).toBe('on');
    expect(st.scriptInstalled).toBe(true);
    expect(st.scriptUpToDate).toBe(true);
    expect(st.detail).toBe('');
  });

  it('补丁晚于本窗口启动 → pending-reload（webview 只在创建时读一次）', () => {
    const fs = memFs(
      tree({
        patched: [
          'session-manager',
          'session-view',
          'standalone',
          'session-manager-surface',
          'session-surface',
        ],
        scriptIn: [OLD_DIST, NEW_DIST],
      })
    );
    const st = detectTurnTimer(optsFor(fs, 0));
    expect(st.state).toBe('pending-reload');
  });

  it('任一包的脚本内容过期 → partial', () => {
    const fs = memFs(
      tree({
        patched: [
          'session-manager',
          'session-view',
          'standalone',
          'session-manager-surface',
          'session-surface',
        ],
        scriptIn: [OLD_DIST, NEW_DIST],
        scriptBody: '/* 旧版本 */\n',
      })
    );
    const st = detectTurnTimer(optsFor(fs, Number.MAX_SAFE_INTEGER));
    expect(st.state).toBe('partial');
    expect(st.detail).toContain('版本不一致');
  });

  it('一个入口都打不上 → off', () => {
    const st = detectTurnTimer(optsFor(memFs(tree())));
    expect(st.state).toBe('off');
    expect(st.detail).toBe('');
  });

  it('找不到任何入口 → unavailable，不抛异常', () => {
    const fs = memFs({ [ASSET]: SCRIPT_BODY, [`${AGENT}/dist/extension.js`]: KIRO_BUNDLE });
    const st = detectTurnTimer(optsFor(fs));
    expect(st.state).toBe('unavailable');
    expect(st.detail).toContain('找不到');
  });

  it('appRoot 整个不存在也只是 unavailable', () => {
    const fs = memFs({ [ASSET]: SCRIPT_BODY });
    expect(() => detectTurnTimer(optsFor(fs))).not.toThrow();
    expect(detectTurnTimer(optsFor(fs)).state).toBe('unavailable');
  });
});

/* ------------------------------------------------------------------ *
 * 3. 打补丁
 * ------------------------------------------------------------------ */

describe('applyTurnTimer', () => {
  it('每个 dist 各写一份脚本，每个入口备份后追加一行 import', () => {
    const fs = memFs(tree());
    const res = applyTurnTimer(optsFor(fs, Number.MAX_SAFE_INTEGER));

    expect(res.ok).toBe(true);
    expect(res.changed).toBe(true);
    expect(res.status.state).toBe('on');

    // import 是相对路径 ../kcs-turn-timer.js，所以两个 dist 都要有自己那份
    expect(fs.read(p(OLD_DIST, TURN_TIMER_SCRIPT_FILENAME))).toBe(SCRIPT_BODY);
    expect(fs.read(p(NEW_DIST, TURN_TIMER_SCRIPT_FILENAME))).toBe(SCRIPT_BODY);

    for (const [dist, entry] of [
      [OLD_DIST, 'session-manager'],
      [OLD_DIST, 'session-view'],
      [OLD_DIST, 'standalone'],
      [NEW_DIST, 'session-manager-surface'],
      [NEW_DIST, 'session-surface'],
    ] as const) {
      const main = p(dist, entry, 'main.js');
      expect(fs.read(main), `${entry} 未注入`).toContain(TURN_TIMER_MARKER);
      expect(fs.read(main + TURN_TIMER_BACKUP_SUFFIX), `${entry} 未备份`).toBe(ENTRY_BODY);
    }
  });

  it('幂等：已完整打好时一次写入都不做', () => {
    const fs = memFs(tree());
    applyTurnTimer(optsFor(fs));
    const before = fs.writes.length;
    const res = applyTurnTimer(optsFor(fs));
    expect(res.ok).toBe(true);
    expect(res.changed).toBe(false);
    expect(fs.writes.length).toBe(before);
  });

  it('只补齐缺的那个包，已打好的入口不重复注入', () => {
    const fs = memFs(
      tree({ patched: ['session-manager', 'session-view', 'standalone'], scriptIn: [OLD_DIST] })
    );
    const res = applyTurnTimer(optsFor(fs, Number.MAX_SAFE_INTEGER));
    expect(res.ok).toBe(true);
    expect(res.status.state).toBe('on');
    // 旧包三个入口一个都没被再写一遍
    expect(fs.writes.filter((w) => w.includes('kiro-ui-agent-chat'))).toEqual([]);
    // 标记只出现一次，没叠加
    const main = fs.read(p(NEW_DIST, 'session-surface', 'main.js')) ?? '';
    expect(main.split(TURN_TIMER_MARKER).length - 1).toBe(1);
  });

  it('备份失败就不动原文件（宁可不生效，也不留改了却无法稳妥还原的入口）', () => {
    const fs = memFs(tree());
    const orig = fs.deps.writeFileSync!;
    fs.deps.writeFileSync = (pp, data, enc) => {
      if (pp.includes('session-surface') && pp.endsWith(TURN_TIMER_BACKUP_SUFFIX)) {
        throw new Error('EACCES');
      }
      orig(pp, data, enc);
    };
    const res = applyTurnTimer(optsFor(fs));
    expect(res.ok).toBe(false);
    expect(res.error).toContain('备份');
    // 该入口保持原样
    expect(fs.read(p(NEW_DIST, 'session-surface', 'main.js'))).toBe(ENTRY_BODY);
    // 其余入口照常打上
    expect(fs.read(p(NEW_DIST, 'session-manager-surface', 'main.js'))).toContain(TURN_TIMER_MARKER);
  });

  it('读不到扩展内置脚本时明确报错，不动任何文件', () => {
    const t = tree();
    delete t[ASSET];
    const fs = memFs(t);
    const res = applyTurnTimer(optsFor(fs));
    expect(res.ok).toBe(false);
    expect(res.error).toContain('读不到扩展内置的注入脚本');
    expect(fs.writes).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 4. 还原
 * ------------------------------------------------------------------ */

describe('revertTurnTimer', () => {
  it('拷回备份，字节精确，并删掉每个 dist 的脚本', () => {
    const fs = memFs(tree());
    applyTurnTimer(optsFor(fs));
    const res = revertTurnTimer(optsFor(fs));

    expect(res.ok).toBe(true);
    expect(res.changed).toBe(true);
    expect(res.status.state).toBe('off');

    expect(fs.read(p(OLD_DIST, 'session-manager', 'main.js'))).toBe(ENTRY_BODY);
    expect(fs.read(p(NEW_DIST, 'session-surface', 'main.js'))).toBe(ENTRY_BODY);
    expect(fs.has(p(OLD_DIST, TURN_TIMER_SCRIPT_FILENAME))).toBe(false);
    expect(fs.has(p(NEW_DIST, TURN_TIMER_SCRIPT_FILENAME))).toBe(false);
    // 备份也清掉，不留垃圾
    expect(fs.has(p(NEW_DIST, 'session-surface', 'main.js' + TURN_TIMER_BACKUP_SUFFIX))).toBe(false);
  });

  it('备份丢了就按标记摘行兜底', () => {
    const fs = memFs(tree());
    applyTurnTimer(optsFor(fs));
    fs.deps.unlinkSync!(p(NEW_DIST, 'session-surface', 'main.js' + TURN_TIMER_BACKUP_SUFFIX));

    const res = revertTurnTimer(optsFor(fs));
    expect(res.ok).toBe(true);
    expect(fs.read(p(NEW_DIST, 'session-surface', 'main.js'))).toBe(ENTRY_BODY);
  });

  it('Kiro 换过入口名后，旧入口上的残留也会被清掉（认标记而不认名字）', () => {
    // 先按旧清单打好，然后 Kiro 的 bundle 只剩新入口
    const fs = memFs(tree());
    applyTurnTimer(optsFor(fs));
    fs.deps.writeFileSync!(
      `${AGENT}/dist/extension.js`,
      'new X({entryPoint:"session-surface"});',
      'utf8'
    );

    const s = surveyTurnTimerTargets(optsFor(fs));
    expect(s.bundles.flatMap((b) => b.entries)).toEqual(['session-surface']); // 只认得一个了

    const res = revertTurnTimer(optsFor(fs));
    expect(res.ok).toBe(true);
    // 已经不在清单里的入口同样被还原，不留永久改动
    expect(fs.read(p(OLD_DIST, 'session-manager', 'main.js'))).toBe(ENTRY_BODY);
    expect(fs.read(p(OLD_DIST, 'standalone', 'main.js'))).toBe(ENTRY_BODY);
    expect(fs.has(p(OLD_DIST, TURN_TIMER_SCRIPT_FILENAME))).toBe(false);
  });

  it('本来没打过时不写任何文件', () => {
    const fs = memFs(tree());
    const res = revertTurnTimer(optsFor(fs));
    expect(res.changed).toBe(false);
    expect(fs.writes).toEqual([]);
  });
});

describe('stripInjection', () => {
  it('只丢含标记的整行，保留原有行尾风格', () => {
    const src = `a();\r\nb();\nimport "../x.js"; ${TURN_TIMER_MARKER}\nc();\n`;
    expect(stripInjection(src)).toBe('a();\r\nb();\nc();\n');
  });

  it('没有标记时原样返回', () => {
    expect(stripInjection('a();\n')).toBe('a();\n');
  });
});
