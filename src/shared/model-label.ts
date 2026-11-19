/**
 * 模型标签：给同一个端点在不同项目/公司下起的短标注（「个人」「公司A」）。
 *
 * 标签只影响展示与辨识，不参与路由：真正决定请求发往哪里的是模型资源本身。
 * 上限四个字，避免把下拉框撑长、也避免标签变成第二份模型名。
 */

export const MODEL_TAG_MAX_LENGTH = 4

/** 按字符（而不是 UTF-16 码元）计数，贴 4 个中文或 4 个 emoji 都算超限。 */
export function modelTagLength(value: unknown): number {
  if (typeof value !== 'string') return 0
  return Array.from(value.trim()).length
}

/** 收敛成一个可直接落盘的标签：去空白、截到上限；非字符串一律视为没有标签。 */
export function normalizeModelTag(value: unknown): string {
  if (typeof value !== 'string') return ''
  const collapsed = value.replace(/\s+/g, ' ').trim()
  return Array.from(collapsed).slice(0, MODEL_TAG_MAX_LENGTH).join('')
}

/** 下拉框文案：「模型名称 · 标签」；没有标签时只显示名称。 */
export function modelOptionLabel(name: string, tag: string): string {
  const title = name.trim()
  const clean = normalizeModelTag(tag)
  if (!clean) return title
  return title ? `${title} · ${clean}` : clean
}
