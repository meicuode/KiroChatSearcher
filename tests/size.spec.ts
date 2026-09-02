import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { formatSize, parseSize, sizeBadgeLabel, summaryLabel } from '../src/webview/size';

/**
 * SizeFormatter 的示例测试：只锁定**具体边界值**与**模块纯净性**。
 *
 * 随机输入空间上的形态分档、单调性与近似往返由 tests/size.property.spec.ts
 * （Property 20/21/22）覆盖，两个标签函数的随机输入由
 * tests/storage.badge.property.spec.ts（Property 10/11）覆盖，此处不重复。
 */

const K = 1024;
const K2 = K * K;
const K3 = K2 * K;
const K4 = K3 * K;

describe('formatSize - 单位与精度边界具体值', () => {
  it.each([
    [0, '0B'],
    [1, '1B'],
    [1023, '1023B'],
    [K, '1.0KB'],
    [1536, '1.5KB'],
    [K2 - 1, '1024.0KB'],
    [K2, '1.0MB'],
    [100 * K2, '100.0MB'],
    [K3 - 1, '1024.0MB'],
    [K3, '1.00GB'],
    [1.5 * K3, '1.50GB'],
    [K4 - 1, '1024.00GB'],
    [K4, '1.00TB'],
    [1024 * K4, '1024.00TB'],
  ])('formatSize(%d) === %s', (bytes, expected) => {
    expect(formatSize(bytes)).toBe(expected);
  });

  it('单位切换边界取「低单位进位」而非提前换单位', () => {
    // 1024³-1 落在 MB 档，展示为 1024.0MB；只有恰好到 1024³ 才切到 GB。
    expect(formatSize(K3 - 1)).toBe('1024.0MB');
    expect(formatSize(K3)).toBe('1.00GB');
    // 该取法让边界处 parse(format(n)) 单调不降：1024.0MB 解析回 1024³。
    expect(parseSize(formatSize(K3 - 1))).toBe(K3);
    expect(parseSize(formatSize(K3 - 1))).toBeLessThanOrEqual(parseSize(formatSize(K3)));
  });

  it('小于 1024 的非整数按整数四舍五入展示', () => {
    expect(formatSize(1023.4)).toBe('1023B');
    expect(formatSize(1023.5)).toBe('1024B');
  });

  it.each([
    ['负整数', -1],
    ['负小数', -0.5],
    ['NaN', NaN],
    ['+Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('非法输入（%s）返回占位 `-`', (_label, bad) => {
    expect(formatSize(bad as number)).toBe('-');
  });

  it('非数值输入也返回占位 `-`', () => {
    expect(formatSize('1024' as unknown as number)).toBe('-');
    expect(formatSize(undefined as unknown as number)).toBe('-');
    expect(formatSize(null as unknown as number)).toBe('-');
  });
});

describe('parseSize - 具体文本', () => {
  it.each([
    ['0B', 0],
    ['1023B', 1023],
    ['1.0KB', K],
    ['1.5KB', 1536],
    ['1024.0KB', K2],
    ['1.0MB', K2],
    ['1024.0MB', K3],
    ['1.00GB', K3],
    ['1024.00GB', K4],
    ['1.00TB', K4],
  ])('parseSize(%s) === %d', (text, expected) => {
    expect(parseSize(text)).toBe(expected);
  });

  it('单位大小写不敏感', () => {
    expect(parseSize('12.3mb')).toBe(12.3 * K2);
    expect(parseSize('12.3Mb')).toBe(12.3 * K2);
    expect(parseSize('5b')).toBe(5);
  });

  it('容忍首尾空白与数值、单位之间的空白', () => {
    expect(parseSize('  12.3 MB  ')).toBe(12.3 * K2);
    expect(parseSize('\t1 KB\n')).toBe(K);
  });

  it.each([
    ['占位文本', '-'],
    ['空串', ''],
    ['纯空白', '   '],
    ['无单位', '1024'],
    ['无数值', 'MB'],
    ['不可识别文本', 'abc'],
    ['未知单位', '1.0PB'],
    ['带符号', '-1B'],
    ['逗号小数', '1,5MB'],
    ['多余尾串', '1.0KB extra'],
  ])('不可识别输入（%s）返回 NaN', (_label, text) => {
    expect(parseSize(text)).toBeNaN();
  });

  it('非字符串输入返回 NaN', () => {
    expect(parseSize(1024 as unknown as string)).toBeNaN();
    expect(parseSize(undefined as unknown as string)).toBeNaN();
    expect(parseSize(null as unknown as string)).toBeNaN();
  });
});

describe('src/webview/size.ts - 模块纯净性', () => {
  const sourcePath = path.join(__dirname, '..', 'src', 'webview', 'size.ts');
  const source = fs.readFileSync(sourcePath, 'utf8');
  /**
   * 注释里会正当地提到 DOM / vscode（说明「不依赖」），因此先剥离块注释与行注释，
   * 只对代码文本做标识符断言。
   */
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('无任何 import / require（源码可被 toString 注入 webview 后独立运行）', () => {
    expect(source).not.toMatch(/^\s*import\b/m);
    expect(code).not.toMatch(/\brequire\s*\(/);
  });

  it.each(['document', 'window', 'vscode', 'globalThis', 'process', 'localStorage'])(
    '代码中不出现宿主标识符 %s',
    (ident) => {
      expect(code).not.toMatch(new RegExp('\\b' + ident + '\\b'));
    }
  );

  it('在无 DOM 的 node 环境下四个导出均可直接调用', () => {
    expect(typeof (globalThis as Record<string, unknown>).document).toBe('undefined');
    expect(typeof (globalThis as Record<string, unknown>).window).toBe('undefined');

    expect(formatSize(K2)).toBe('1.0MB');
    expect(parseSize('1.0MB')).toBe(K2);
    expect(sizeBadgeLabel({ jsonBytes: K, archiveBytesSelf: K })!.value).toBe('2.0KB');
    expect(summaryLabel({ state: 'ok', totalBytes: K2 })!.text).toContain('1.0MB');
  });
});
