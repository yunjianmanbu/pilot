/**
 * 选中文本 → 待办的纯函数部分。
 *
 * 组件里只做 DOM 事件与定位，能不能加、加进去的是哪段文字，全在这里决定，
 * 这样规则可以直接用单测覆盖（渲染层没有 jsdom）。
 */

/** 待办正文上限。store.addTodo 会截到 4000 字符，这里更短：一条待办不该是一整篇文章。 */
export const MAX_SELECTION_TODO_CHARS = 2_000

export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

/**
 * 把滑动/拖拽选中的一段文字收敛成单行待办正文。
 *
 * - 折行、缩进、列表里的多行空白压成一个空格，粘到待办列表里不会撑出一条空行；
 * - 首尾空白去掉，全空白返回空串（调用方据此不弹菜单）；
 * - 超长直接截断，不补省略号：待办是要发回会话的指令，省略号会被一起发出去。
 */
export function normalizeSelectionText(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_SELECTION_TODO_CHARS)
}

/**
 * 浮动菜单的落点：贴着锚点，但整块留在视口内。
 *
 * 锚点通常是光标（右键）或选中区域的下沿（松手），贴着它会盖住刚选中的字，
 * 因此调用方传入的 y 已经加过偏移。超出下边界时翻到锚点上方，再夹进视口。
 */
export function clampMenuPosition(
  anchor: Point,
  menu: Size,
  viewport: Size,
  margin = 8,
): Point {
  const maxX = Math.max(margin, viewport.width - menu.width - margin)
  const maxY = Math.max(margin, viewport.height - menu.height - margin)
  const below = anchor.y
  const above = anchor.y - menu.height - 12
  const y = below > maxY && above >= margin ? above : below
  return {
    x: Math.min(Math.max(margin, anchor.x), maxX),
    y: Math.min(Math.max(margin, y), maxY),
  }
}