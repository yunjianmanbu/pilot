/**
 * 应用级快捷键的判定规则。
 *
 * 单独放一个不碰 React 的文件，只为一件事：把「哪一次按键算数」钉成单测。
 * 规则里有好几条是否定条件（按着 Alt、长按重复、输入法组合中），它们看上去
 * 可以省略，省略了就会在真实的输入法或长按里出问题，而这类问题手工验证很难
 * 每次都覆盖。`App.tsx` 只负责按这里的结果去调用对应动作。
 */

export type AppShortcut = 'new-session' | 'command-palette' | 'settings'

/** 只取判定要用的字段，这样单测可以直接传一个字面量，不必造 KeyboardEvent。 */
export interface ShortcutEventLike {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  repeat?: boolean
  isComposing?: boolean
}

/**
 * 命中就返回对应动作，否则返回 null。
 *
 * - 只认 Ctrl 与 Cmd：Windows/Linux 上是 Ctrl，macOS 上是 Cmd，两者等价。
 * - `Ctrl+Alt+X` 是别的软件的组合键（AltGr 在部分键盘布局上也带 Alt），不抢。
 * - `repeat` 排除长按：按住 Ctrl+N 不该连开一堆会话。
 * - `isComposing` 排除中文输入法组合中的按键，否则拼音里打 `k` 会弹出面板。
 * - `Shift` 不排除：`Ctrl+Shift+N` 的 `key` 是大写 `N`，与小写按同一个键处理，
 *   这正是 Electron 窗口内一直以来的行为，不为它单开一条分支。
 */
export function matchAppShortcut(event: ShortcutEventLike): AppShortcut | null {
  if (!(event.metaKey || event.ctrlKey)) return null
  if (event.altKey || event.repeat || event.isComposing) return null
  const key = event.key.toLowerCase()
  if (key === 'n') return 'new-session'
  if (key === 'k') return 'command-palette'
  if (event.key === ',') return 'settings'
  return null
}
