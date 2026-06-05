/**
 * 附件过滤纯函数。与 webview/format 一样，会被 toString() 注入到 webview
 * 运行时脚本中，确保前端与单元测试使用完全相同的实现。
 *
 * 不依赖任何外部符号（含类型），以保证序列化后在 webview 中可独立运行。
 */

export type AttachmentFilterMode = 'all' | 'image' | 'attachment';

/**
 * 在已得到的结果集上按附件维度过滤。
 * - 'all'        → 原样返回（保序、不增项）
 * - 'image'      → 仅保留 hasImage === true
 * - 'attachment' → 仅保留 hasAttachment === true
 * 返回输入的子序列，保持原有顺序。
 */
export function applyAttachmentFilter(
  results: Array<{ hasImage?: boolean; hasAttachment?: boolean }>,
  mode: AttachmentFilterMode
): Array<{ hasImage?: boolean; hasAttachment?: boolean }> {
  if (mode === 'image') {
    return results.filter((r) => r.hasImage === true);
  }
  if (mode === 'attachment') {
    return results.filter((r) => r.hasAttachment === true);
  }
  return results;
}
