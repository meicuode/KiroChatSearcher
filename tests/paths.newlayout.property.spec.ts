/**
 * Kiro 1.x 存储适配 —— 路径层的三条属性：
 *
 * - Property 1  WsHash16 归一化不变性（1.x 新布局的工作区目录名）
 * - Property 2  旧路径解析回归不变（0.9x 解析的纯回归护栏）
 * - Property 20 归属判断按路径段边界（跨平台一致性）
 *
 * 三条都只依赖公开契约（导出函数的入参与返回值），不复刻被测实现的内部算法，
 * 以免测试与实现同步漂移后变成同义反复。
 */
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { computeWsHash16, encodeWorkspaceKeys } from '../src/paths';
import { hash32, workspaceIdCandidates } from '../src/credits';
import { decodeWorkspaceKey } from '../src/storage/orphan';
import { isUnder } from '../src/storage/classify';

/* ------------------------------------------------------------------ *
 * 共用生成器
 * ------------------------------------------------------------------ */

/**
 * 路径段字符集刻意限定为 **ASCII**：本文件多处用整串 `toUpperCase()` / `toLowerCase()`
 * 构造"同一逻辑路径的书写变体"，而 Unicode 的大小写折叠不是双向的
 * （`'ß'.toUpperCase()` 得 `'SS'`，再小写得 `'ss'`），会让"变体"实际变成另一个路径。
 */
const SEGMENT_CHARS =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.'.split('');

const segmentArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...SEGMENT_CHARS), { minLength: 1, maxLength: 10 })
  .map((cs) => cs.join(''));

/** Windows 形态：`<drive>:\seg\seg`，盘符大小写两侧都取到。 */
const winWorkspacePathArb: fc.Arbitrary<string> = fc
  .tuple(fc.constantFrom('c', 'd', 'e', 'Z'), fc.array(segmentArb, { minLength: 1, maxLength: 4 }))
  .map(([drive, segs]) => `${drive}:\\${segs.join('\\')}`);

/** POSIX 形态：`/seg/seg`。 */
const posixWorkspacePathArb: fc.Arbitrary<string> = fc
  .array(segmentArb, { minLength: 1, maxLength: 4 })
  .map((segs) => '/' + segs.join('/'));

const workspacePathArb: fc.Arbitrary<string> = fc.oneof(
  winWorkspacePathArb,
  posixWorkspacePathArb
);

/** 交替使用两种分隔符，覆盖混写形态。 */
function alternateSeparators(p: string): string {
  let i = 0;
  return p.replace(/[\\/]/g, () => (i++ % 2 === 0 ? '\\' : '/'));
}

/**
 * 同一逻辑路径的书写变体全集：
 * {原样, 盘符大写, 盘符小写, 全大写, 全小写} × {全反斜杠, 全正斜杠, 交替混写}。
 * 1.x 的归一化（反斜杠→正斜杠、再转小写）应把它们全部收敛到同一个 WsHash16。
 */
function writingVariants(p: string): string[] {
  const caseForms = new Set<string>([p, p.toLowerCase(), p.toUpperCase()]);
  if (/^[a-zA-Z]:/.test(p)) {
    caseForms.add(p[0].toUpperCase() + p.slice(1));
    caseForms.add(p[0].toLowerCase() + p.slice(1));
  }
  const out = new Set<string>();
  for (const form of caseForms) {
    out.add(form.replace(/[\\/]/g, '\\'));
    out.add(form.replace(/[\\/]/g, '/'));
    out.add(alternateSeparators(form));
  }
  return [...out];
}

/**
 * 0.9x 候选键覆盖的两个维度：盘符大小写 × 斜杠方向（统一替换，不含混写）。
 * 与 `writingVariants` 分开，是因为旧实现的候选集合**不**包含整串大小写变体。
 */
function legacyVariants(p: string): string[] {
  const driveForms = new Set<string>([p]);
  if (/^[a-zA-Z]:/.test(p)) {
    driveForms.add(p[0].toUpperCase() + p.slice(1));
    driveForms.add(p[0].toLowerCase() + p.slice(1));
  }
  const out = new Set<string>();
  for (const form of driveForms) {
    out.add(form.replace(/[\\/]/g, '\\'));
    out.add(form.replace(/[\\/]/g, '/'));
  }
  return [...out];
}

const HEX16 = /^[0-9a-f]{16}$/;
const HEX32 = /^[0-9a-f]{32}$/;

/* ------------------------------------------------------------------ *
 * Property 1
 * ------------------------------------------------------------------ */

/** 研究笔记里的两个实测基线（本机 Kiro 1.0.337 实盘目录名）。 */
const WS_HASH16_BASELINES = [
  ['d:\\Projects\\KiroExt\\KiroChatSearcher', 'cc5023603866cd91'],
  ['d:\\SurErp\\ERP-OMS-Workspaces', '6082f0c94c5c4af8'],
] as const;

describe('paths 新布局属性：WsHash16', () => {
  // Feature: kiro-1x-storage-adaptation, Property 1: WsHash16 归一化不变性
  // Validates: Requirements 2.1, 2.2, 2.3, 2.4, 14.3
  it('Property 1: 盘符大小写 × 斜杠方向的任意书写变体恒得同一 WsHash16', () => {
    fc.assert(
      fc.property(workspacePathArb, (p) => {
        const expected = computeWsHash16(p);
        for (const v of writingVariants(p)) {
          expect(computeWsHash16(v)).toBe(expected);
        }
      }),
      { numRuns: 100 }
    );
  });

  // Feature: kiro-1x-storage-adaptation, Property 1: WsHash16 归一化不变性
  // Validates: Requirements 2.1, 2.4
  it('Property 1: 产物恒为 16 位小写十六进制', () => {
    fc.assert(
      fc.property(workspacePathArb, (p) => {
        for (const v of writingVariants(p)) {
          const h = computeWsHash16(v);
          expect(h).toMatch(HEX16);
          expect(h).toBe(h.toLowerCase());
        }
      }),
      { numRuns: 100 }
    );
  });

  // Feature: kiro-1x-storage-adaptation, Property 1: WsHash16 归一化不变性
  // Validates: Requirements 2.1, 2.2
  it('Property 1: 纯函数——同输入恒同输出、无隐藏状态、入参不被改动', () => {
    fc.assert(
      fc.property(workspacePathArb, (p) => {
        const snapshot = String(p);
        const first = computeWsHash16(p);
        expect(computeWsHash16(p)).toBe(first);
        // 中间穿插其它输入：若实现复用了同一个 Hash 实例（常见错法），此处会暴露
        for (const v of writingVariants(p)) computeWsHash16(v);
        expect(computeWsHash16(p)).toBe(first);
        // 入参不被改写（返回新串而非原地改写）
        expect(p).toBe(snapshot);
      }),
      { numRuns: 100 }
    );
  });

  // Feature: kiro-1x-storage-adaptation, Property 1: WsHash16 归一化不变性
  // Validates: Requirements 2.1, 2.6, 14.3
  it('Property 1: 与 credits.hash32 恒不相等——两套算法不可互相替用', () => {
    fc.assert(
      fc.property(workspacePathArb, (p) => {
        const id32 = hash32(p);
        expect(id32).toMatch(HEX32);
        // 摘要范围不同：WsHash16 取 16 位、WorkspaceId 取 32 位
        expect(computeWsHash16(p)).not.toBe(id32);
        // 归一化也不同：凡书写形式≠归一化形式的变体，连「取 hash32 前 16 位」都不等于 WsHash16
        for (const v of writingVariants(p)) {
          const normalized = v.replace(/\\/g, '/').toLowerCase();
          if (v !== normalized) {
            expect(hash32(v).slice(0, 16)).not.toBe(computeWsHash16(v));
          }
        }
      }),
      { numRuns: 100 }
    );
  });

  // Feature: kiro-1x-storage-adaptation, Property 1: WsHash16 归一化不变性
  // Validates: Requirements 2.4
  it('Property 1: 两个实测基线路径的任意书写变体恒得基线哈希', () => {
    fc.assert(
      fc.property(fc.constantFrom(...WS_HASH16_BASELINES), fc.nat(), ([p, expected], pick) => {
        const variants = writingVariants(p);
        expect(computeWsHash16(p)).toBe(expected);
        expect(computeWsHash16(variants[pick % variants.length])).toBe(expected);
      }),
      { numRuns: 100 }
    );
  });
});

/* ------------------------------------------------------------------ *
 * Property 2
 * ------------------------------------------------------------------ */

describe('paths 旧布局属性：0.9x 解析回归护栏', () => {
  /** 编码把 '+'→'-'、'/'→'_'，并把 '=' padding 也替换为 '_'，故产物只含这些字符。 */
  const BASE64URL = /^[A-Za-z0-9_-]+$/;

  // Feature: kiro-1x-storage-adaptation, Property 2: 旧路径解析回归不变
  // Validates: Requirements 2.5
  it('Property 2: encodeWorkspaceKeys 恒去重、恒只含 base64url 字符集、首元素恒对应原始路径', () => {
    fc.assert(
      fc.property(workspacePathArb, (p) => {
        const keys = encodeWorkspaceKeys(p);
        expect(keys.length).toBeGreaterThan(0);
        expect(new Set(keys).size).toBe(keys.length);
        for (const k of keys) {
          expect(k).toMatch(BASE64URL);
          // padding 被保留（替换为 '_'）而非删除，故长度恒为 4 的倍数
          expect(k.length % 4).toBe(0);
        }
        // 首元素恒对应原始路径：解码回来恒得原串
        expect(decodeWorkspaceKey(keys[0])).toBe(p);
        for (const v of legacyVariants(p)) {
          // 每个变体的键恒落在候选集合内（候选覆盖盘符大小写 × 斜杠方向两个维度）
          expect(keys).toContain(encodeWorkspaceKeys(v)[0]);
          // 且首元素随输入逐字符变化：换一个变体作输入，首元素必换
          if (v !== p) expect(encodeWorkspaceKeys(v)[0]).not.toBe(keys[0]);
        }
      }),
      { numRuns: 100 }
    );
  });

  // Feature: kiro-1x-storage-adaptation, Property 2: 旧路径解析回归不变
  // Validates: Requirements 2.5
  it('Property 2: 每个候选键恒可被 decodeWorkspaceKey 还原为同一逻辑路径的某个变体', () => {
    const norm = (s: string) => s.replace(/[\\/]/g, '/').toLowerCase();
    fc.assert(
      fc.property(workspacePathArb, (p) => {
        for (const key of encodeWorkspaceKeys(p)) {
          const decoded = decodeWorkspaceKey(key);
          expect(decoded).not.toBeNull();
          // 自洽：还原结果再编码恒得回同一个键（decode 自身的判据）
          expect(encodeWorkspaceKeys(decoded as string)[0]).toBe(key);
          // 且它恒是同一逻辑路径的书写变体（仅盘符大小写 / 斜杠方向不同）
          expect(norm(decoded as string)).toBe(norm(p));
        }
      }),
      { numRuns: 100 }
    );
  });

  // Feature: kiro-1x-storage-adaptation, Property 2: 旧路径解析回归不变
  // Validates: Requirements 2.6
  it('Property 2: hash32 恒为 32 位小写十六进制且恒不做归一化（与 WsHash16 形成对照）', () => {
    fc.assert(
      fc.property(winWorkspacePathArb, (p) => {
        const lowerDrive = p[0].toLowerCase() + p.slice(1);
        const upperDrive = p[0].toUpperCase() + p.slice(1);
        const forward = p.replace(/\\/g, '/');
        for (const v of [p, lowerDrive, upperDrive, forward]) {
          const h = hash32(v);
          expect(h).toMatch(HEX32);
          expect(h).toBe(h.toLowerCase());
          expect(hash32(v)).toBe(h); // 确定性
        }
        // 0.9x 的 WorkspaceId 对原始字符串取摘要：书写形式不同即哈希不同
        expect(hash32(lowerDrive)).not.toBe(hash32(upperDrive));
        expect(hash32(p)).not.toBe(hash32(forward));
        // 对照：同样这些变体在 1.x 的 WsHash16 下恒收敛到同一值
        expect(computeWsHash16(lowerDrive)).toBe(computeWsHash16(upperDrive));
        expect(computeWsHash16(p)).toBe(computeWsHash16(forward));
      }),
      { numRuns: 100 }
    );
  });

  // Feature: kiro-1x-storage-adaptation, Property 2: 旧路径解析回归不变
  // Validates: Requirements 2.6
  it('Property 2: workspaceIdCandidates 恒非空、恒去重、每项恒为 hex32 且恒含各变体的 id', () => {
    fc.assert(
      fc.property(workspacePathArb, (p) => {
        const ids = workspaceIdCandidates(p);
        expect(ids.length).toBeGreaterThan(0);
        expect(new Set(ids).size).toBe(ids.length);
        for (const id of ids) expect(id).toMatch(HEX32);
        expect(ids).toContain(hash32(p));
        for (const v of legacyVariants(p)) expect(ids).toContain(hash32(v));
      }),
      { numRuns: 100 }
    );
  });
});

/* ------------------------------------------------------------------ *
 * Property 20
 * ------------------------------------------------------------------ */

/** 当前平台的分隔符是否为反斜杠（决定"方向翻转"是否只是写法差异）。 */
const IS_WIN_SEP = path.sep === '\\';
/** 用平台原生分隔符构造绝对路径，`isUnder` 内部走的是平台版 `path.relative`。 */
const FS_ROOT = IS_WIN_SEP ? 'D:\\' : '/';

/** 目录名：含设计里点名的同前缀样本（sessions / logs / session-index）与随机 ASCII 名。 */
const dirNameArb: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom('sessions', 'logs', 'session-index', 'snapshots', 'sub-executions'),
  fc
    .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), {
      minLength: 1,
      maxLength: 8,
    })
    .map((cs) => cs.join(''))
);

/** 同前缀后缀：让兄弟目录名以被测目录名为**字符串前缀**，暴露裸 startsWith 的错法。 */
const siblingSuffixArb: fc.Arbitrary<string> = fc.constantFrom(
  '-old',
  '2',
  '_v2',
  '.bak',
  '-new',
  'x'
);

/**
 * 子目录名：额外掺入 `..bar` / `...` / `.hidden` —— 以 `..` 开头但**不是** `..` 段的
 * 合法目录名，按段比较才不会把它们误判成越界。刻意不含 `.` 与 `..` 自身
 * （那两个会被规范化掉，等于换了个路径，不属于"真子项"）。
 */
const childSegArb: fc.Arbitrary<string> = fc.oneof(
  dirNameArb,
  fc.constantFrom('..bar', '...', '.hidden')
);

/** 把根之后的每个分隔符改写成双分隔符（不动根，以避开 UNC / POSIX 双斜杠的特殊语义）。 */
function dupSeparators(p: string): string {
  const rest = p.startsWith(FS_ROOT) ? p.slice(FS_ROOT.length) : p;
  return FS_ROOT + rest.split(path.sep).join(path.sep + path.sep);
}

describe('paths 归属判断属性：路径段边界', () => {
  // Feature: kiro-1x-storage-adaptation, Property 20: 归属判断按路径段边界
  // Validates: Requirements 14.2
  it('Property 20: 同前缀兄弟目录恒互不为子项', () => {
    fc.assert(
      fc.property(
        fc.array(dirNameArb, { minLength: 1, maxLength: 3 }),
        dirNameArb,
        siblingSuffixArb,
        (baseSegs, name, suffix) => {
          const base = path.join(FS_ROOT, ...baseSegs);
          const target = path.join(base, name);
          const sibling = path.join(base, name + suffix);

          // 前置：兄弟名确实以被测名为裸字符串前缀（否则这条属性就没在测该错法）
          expect(sibling.startsWith(target)).toBe(true);

          expect(isUnder(target, sibling)).toBe(false);
          expect(isUnder(sibling, target)).toBe(false);
          // 兄弟目录里的深层文件同样不属于被测目录
          expect(isUnder(target, path.join(sibling, 'inner.json'))).toBe(false);
          // 两者都仍是共同父目录的子项
          expect(isUnder(base, target)).toBe(true);
          expect(isUnder(base, sibling)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  // Feature: kiro-1x-storage-adaptation, Property 20: 归属判断按路径段边界
  // Validates: Requirements 14.2
  it('Property 20: 真子项与自身恒被判为子项，反向恒不成立', () => {
    fc.assert(
      fc.property(
        fc.array(dirNameArb, { minLength: 1, maxLength: 3 }),
        fc.array(childSegArb, { minLength: 1, maxLength: 3 }),
        (baseSegs, childSegs) => {
          const parent = path.join(FS_ROOT, ...baseSegs);
          const child = path.join(parent, ...childSegs);

          expect(isUnder(parent, child)).toBe(true);
          // 自反：`isUnder(p, p) === true`（实现以 relative === '' 判定，含"自身"语义）
          expect(isUnder(parent, parent)).toBe(true);
          expect(isUnder(child, child)).toBe(true);
          // 反向恒不成立
          expect(isUnder(child, parent)).toBe(false);
          // 逐级祖先恒把 child 判为子项
          let cursor = parent;
          for (const seg of childSegs) {
            cursor = path.join(cursor, seg);
            expect(isUnder(cursor, child)).toBe(true);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  // Feature: kiro-1x-storage-adaptation, Property 20: 归属判断按路径段边界
  // Validates: Requirements 14.2
  it('Property 20: 分隔符书写变体不改变判定结果', () => {
    fc.assert(
      fc.property(
        fc.array(dirNameArb, { minLength: 1, maxLength: 2 }),
        dirNameArb,
        siblingSuffixArb,
        dirNameArb,
        (baseSegs, name, suffix, leaf) => {
          const base = path.join(FS_ROOT, ...baseSegs);
          const target = path.join(base, name);
          const child = path.join(target, leaf);
          const sibling = path.join(base, name + suffix);

          const cases: Array<[string, string, boolean]> = [
            [target, child, true],
            [target, target, true],
            [target, sibling, false],
          ];

          for (const [a, b, expected] of cases) {
            expect(isUnder(a, b)).toBe(expected);
            // 尾部分隔符
            expect(isUnder(a + path.sep, b)).toBe(expected);
            expect(isUnder(a, b + path.sep)).toBe(expected);
            // 重复分隔符
            expect(isUnder(dupSeparators(a), dupSeparators(b))).toBe(expected);
            // 方向翻转：仅在分隔符为反斜杠的平台上属于"写法变体"。POSIX 下 '\' 是
            // 合法文件名字符，翻转会改变路径语义而非写法，故不在该平台断言。
            if (IS_WIN_SEP) {
              const flip = (s: string) => s.replace(/\\/g, '/');
              expect(isUnder(flip(a), flip(b))).toBe(expected);
              expect(isUnder(a, flip(b))).toBe(expected);
              expect(isUnder(flip(a), b)).toBe(expected);
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
