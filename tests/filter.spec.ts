import { describe, it, expect } from 'vitest';
import { applyAttachmentFilter } from '../src/webview/filter';

interface Row {
  id: string;
  hasImage?: boolean;
  hasAttachment?: boolean;
}

const rows: Row[] = [
  { id: 'plain', hasImage: false, hasAttachment: false },
  { id: 'img', hasImage: true, hasAttachment: false },
  { id: 'att', hasImage: false, hasAttachment: true },
  { id: 'both', hasImage: true, hasAttachment: true },
];

describe('applyAttachmentFilter', () => {
  it("'all' 原样返回（同一引用语义：内容相等且保序）", () => {
    const out = applyAttachmentFilter(rows, 'all');
    expect(out).toEqual(rows);
  });

  it("'image' 仅保留 hasImage===true", () => {
    const out = applyAttachmentFilter(rows, 'image') as Row[];
    expect(out.map((r) => r.id)).toEqual(['img', 'both']);
  });

  it("'attachment' 仅保留 hasAttachment===true", () => {
    const out = applyAttachmentFilter(rows, 'attachment') as Row[];
    expect(out.map((r) => r.id)).toEqual(['att', 'both']);
  });

  it('缺失布尔字段按 false 处理', () => {
    const partial: Row[] = [{ id: 'x' }, { id: 'y', hasImage: true }];
    expect((applyAttachmentFilter(partial, 'image') as Row[]).map((r) => r.id)).toEqual(['y']);
    expect(applyAttachmentFilter(partial, 'attachment')).toEqual([]);
  });

  it('空输入返回空', () => {
    expect(applyAttachmentFilter([], 'image')).toEqual([]);
    expect(applyAttachmentFilter([], 'all')).toEqual([]);
  });
});
