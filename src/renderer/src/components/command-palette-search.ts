/**
 * 命令面板的检索与光标移动。
 *
 * 这两件事单独放一个没有 React 的文件里：面板的交互（方向键、回车）只能靠
 * 真的按键去验证，而匹配规则和「到最后一条再按向下回到第一条」这类边界是纯逻辑，
 * 值得用单测钉死。组件只负责把结果画出来。
 */

export interface PaletteEntry {
  id: string
  /** 界面上显示的命令名，中文词条直接进 `t()`。 */
  title: string
  /** 分组名（操作 / 视图），用来在列表右侧标出这条命令属于哪一类。 */
  group: string
  /**
   * 只参与匹配、不显示的别名：英文单词、同义词、快捷键名。
   * 中文标题对英文用户的键盘输入没有帮助，靠这些词才能搜到。
   */
  keywords?: string[]
}

const normalize = (value: string): string => value.trim().toLowerCase()

/**
 * 按空白拆分关键词，每个词都要命中（AND），命中范围是标题 + 分组 + 别名。
 *
 * 不做模糊打分与重排：命令面板里条目是固定的二十来条，用户按顺序记位置比
 * 「猜哪条更相关」更可靠，保持列表顺序不变，光标不会在输入过程中跳走。
 */
export function filterPalette<T extends PaletteEntry>(items: T[], query: string): T[] {
  const needle = normalize(query)
  if (!needle) return items
  const tokens = needle.split(/\s+/).filter(Boolean)
  return items.filter((item) => {
    const haystack = normalize(
      [item.title, item.group, ...(item.keywords ?? [])].join(' '),
    )
    return tokens.every((token) => haystack.includes(token))
  })
}

/**
 * 上下移动光标，到头回绕。
 *
 * `cursor` 落在列表之外（第一次打开时是 0，但过滤后可能已经为空）时按方向给
 * 一个合理的起点：向下从第一条开始，向上从最后一条开始。
 */
export function movePaletteCursor(cursor: number, delta: number, length: number): number {
  if (length <= 0) return -1
  const inside = cursor >= 0 && cursor < length
  if (!inside) return delta > 0 ? 0 : length - 1
  return (cursor + delta + length) % length
}
