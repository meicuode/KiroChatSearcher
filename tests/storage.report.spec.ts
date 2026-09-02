import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  buildReportData,
  renderStorageReport,
  type BuildReportInput,
} from '../src/storage/report';
import { ORPHAN_NOTE } from '../src/storage/orphan';
import { SIZE_NOTE, type StorageSummary } from '../src/storage/types';

/**
 * `src/storage/report.ts` 的示例测试（Req 6.10、6.11）。
 *
 * 与 `storage.report.property.spec.ts` 的分工：结构不变量（Property 12）与
 * EncodedKey 往返（Property 13）已在随机输入空间被锁定，本文件只钉**具体场景**：
 *
 * 1. 一份含若干工作区与会话的报告渲染后四区块齐全、且不含把报告自身当作操作面的
 *    清理入口措辞（孤儿区块的说明与引导文案是允许的）
 * 2. 模块源码 import 面上不出现 `cleaner`（可静态审查的事实，Req 6.10）
 * 3. 孤儿区块文案含「不提供批量清理」及其理由与去排行页的引导，
 *    且不含整体否定清理能力的表述（Req 6.11）
 * 4. 空数据（0 工作区 / 0 会话）时四区块标题仍在、且「省略 0 条」出现（Req 6.4）
 */

const SOURCE_PATH = path.resolve(process.cwd(), 'src/storage/report.ts');

/** 四区块标题的固定前缀，顺序即要求的展示顺序 */
const BLOCK_TITLES = [
  '【1】分类构成',
  '【2】按工作区排行',
  '【3】按会话排行',
  '【4】孤儿存档合计',
] as const;

/** 一份具体的、含数据的报告输入；orphan.note 留空以走 ORPHAN_NOTE 默认文案 */
function makeSummary(): StorageSummary {
  return {
    status: 'ok',
    userDataDir: 'C:\\Users\\u\\AppData\\Roaming\\Kiro',
    totalBytes: 5_242_880,
    totalFiles: 128,
    categories: [
      {
        category: 'sessionJson',
        label: '会话 JSON',
        pathHint: 'workspaceStorage/<ws>/…',
        bytes: 1_048_576,
        files: 42,
      },
      {
        category: 'executionSaves',
        label: '执行存档',
        pathHint: '<StoreRoot>/saves',
        bytes: 4_194_304,
        files: 80,
      },
    ],
    currentWorkspaceBytes: 2_097_152,
    projectFootprintTotal: 2_097_152,
    orphan: { state: 'ok', bytes: 65_536, files: 3, note: '' },
    partial: false,
    skippedCount: 0,
    sessionCount: 2,
    sizeNote: SIZE_NOTE,
    scannedAt: 1_700_000_000_000,
  };
}

function makePopulatedInput(): BuildReportInput {
  return {
    summary: makeSummary(),
    workspaces: [
      {
        dirName: 'ws-a',
        decodedPath: 'D:\\Projects\\Alpha',
        sessionBytes: 1_048_576,
        execBytes: 524_288,
      },
      {
        dirName: 'ws-b',
        decodedPath: 'D:\\Projects\\Beta',
        sessionBytes: 262_144,
        execBytes: 0,
      },
    ],
    sessions: [
      {
        sessionId: 's-01',
        title: '重构存储模块',
        footprint: {
          sessionId: 's-01',
          scope: 'self',
          additive: true,
          jsonBytes: 4096,
          archiveBytes: 1_044_480,
          totalBytes: 1_048_576,
          archivesFound: true,
        },
      },
      {
        sessionId: 's-02',
        title: '修复搜索高亮',
        footprint: {
          sessionId: 's-02',
          scope: 'self',
          additive: true,
          jsonBytes: 2048,
          archiveBytes: 0,
          totalBytes: 2048,
          archivesFound: false,
        },
      },
    ],
  };
}

const FIXED_NOW = new Date(1_700_000_000_000);

describe('renderStorageReport: 四区块齐全且不含清理操作入口（Req 6.10）', () => {
  const text = renderStorageReport(buildReportData(makePopulatedInput()), FIXED_NOW);

  it('四区块标题按固定顺序恰好各出现一次', () => {
    const positions = BLOCK_TITLES.map((title) => {
      const lines = text.split('\n').filter((l) => l.startsWith(title));
      expect(lines.length).toBe(1);
      return text.indexOf(title);
    });
    // 顺序恒为 分类构成 → 按工作区排行 → 按会话排行 → 孤儿存档合计
    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i - 1]).toBeLessThan(positions[i]);
    }
  });

  it('渲染出具体的工作区行与会话行', () => {
    expect(text).toContain('D:\\Projects\\Alpha');
    expect(text).toContain('D:\\Projects\\Beta');
    expect(text).toContain('重构存储模块');
    expect(text).toContain('（s-01）');
    // 未找到归因存档的会话标注保留
    expect(text).toContain('（未找到归因存档）');
  });

  it('不含把报告自身当作操作面的清理入口措辞', () => {
    // 孤儿区块允许出现「附件清理 / 全量清理 / 不提供清理入口」这类说明与引导；
    // 报告不应出现「点击 / 执行清理 / 一键 / 按钮」这类将报告当成操作面的表述
    for (const phrase of ['点击', '执行清理', '一键清理', '一键', '按钮', '立即清理', '前往清理']) {
      expect(text).not.toContain(phrase);
    }
    // 报告明确声明自身只是诊断快照、不提供清理入口
    expect(text).toContain('本报告只做诊断快照，不提供清理入口');
  });
});

describe('report.ts 模块 import 面不引入 cleaner（Req 6.10）', () => {
  it('源码任一 import 语句都不出现 cleaner', () => {
    const src = fs.readFileSync(SOURCE_PATH, 'utf8');
    // 去掉块注释与行注释，避免文档里提到「不导入 cleaner.ts」这类说明干扰断言
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const importLines = [...code.matchAll(/import[^;]*?from\s*['"][^'"]+['"]/g)].map((m) => m[0]);
    expect(importLines.length).toBeGreaterThan(0);
    for (const line of importLines) {
      expect(line).not.toContain('cleaner');
    }
    // 也不允许绕过静态 import 动态取 cleaner
    expect(code).not.toMatch(/require\(\s*['"][^'"]*cleaner/);
    expect(code).not.toMatch(/import\(\s*['"][^'"]*cleaner/);
  });
});

describe('孤儿区块文案：只否定批量清理并给出引导（Req 6.11）', () => {
  const text = renderStorageReport(buildReportData(makePopulatedInput()), FIXED_NOW);

  it('含「不提供批量清理」入口及其理由', () => {
    expect(text).toContain('批量清理');
    expect(text).toContain('不提供孤儿存档的批量清理入口');
    // 理由：不归属排行页上任一可展示的会话行
    expect(text).toContain('不归属');
    expect(text).toContain('可展示的会话行');
    expect(text).toContain('只删除已枚举并展示给用户的具体文件');
  });

  it('把单会话清理引导到占用排行页（附件清理 / 全量清理）', () => {
    expect(text).toContain('占用排行页');
    expect(text).toContain('附件清理');
    expect(text).toContain('全量清理');
  });

  it('不出现整体否定清理能力的表述', () => {
    for (const phrase of [
      '本版本仅统计',
      '仅统计',
      '只统计不清理',
      '不支持清理',
      '暂不支持清理',
      '无法清理',
      '不能清理',
      '没有清理',
    ]) {
      expect(text).not.toContain(phrase);
    }
    // 默认孤儿文案确实来自 ORPHAN_NOTE（orphan.note 为空时回退）
    expect(text).toContain(ORPHAN_NOTE);
  });
});

describe('空数据渲染：四区块标题仍在、省略 0 条（Req 6.4）', () => {
  const emptyInput: BuildReportInput = {
    summary: { ...makeSummary(), sessionCount: 0 },
    workspaces: [],
    sessions: [],
  };
  const text = renderStorageReport(buildReportData(emptyInput), FIXED_NOW);

  it('四区块标题不因数据为空而被提示文案替换', () => {
    for (const title of BLOCK_TITLES) {
      expect(text.split('\n').filter((l) => l.startsWith(title)).length).toBe(1);
    }
  });

  it('工作区计数为 0、会话区块显示「省略 0 条」', () => {
    expect(text).toContain('【2】按工作区排行（共 0 个工作区）');
    expect(text).toContain('省略 0 条');
  });
});
