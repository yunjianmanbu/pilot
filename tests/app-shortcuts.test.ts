import { describe, expect, it } from 'vitest'
import { matchAppShortcut } from '../src/renderer/src/app-shortcuts'

/**
 * 快捷键判定。这里钉的是「哪一次按键算数」：否定条件（Alt / 长按 / 输入法组合）
 * 少一条，用户就会在 AltGr 键盘、输入法或在长按时遇到意外的弹框与新任务。
 */
describe('应用快捷键判定', () => {
  it('Ctrl+N / Ctrl+K / Ctrl+, 分别对应新任务、命令面板、设置', () => {
    expect(matchAppShortcut({ key: 'n', ctrlKey: true })).toBe('new-session')
    expect(matchAppShortcut({ key: 'k', ctrlKey: true })).toBe('command-palette')
    expect(matchAppShortcut({ key: ',', ctrlKey: true })).toBe('settings')
  })

  it('macOS 上 Cmd 与 Ctrl 等价', () => {
    expect(matchAppShortcut({ key: 'n', metaKey: true })).toBe('new-session')
    expect(matchAppShortcut({ key: 'k', metaKey: true })).toBe('command-palette')
    expect(matchAppShortcut({ key: ',', metaKey: true })).toBe('settings')
  })

  it('大写键名（按住 Shift）仍命中，与原生窗口内行为一致', () => {
    expect(matchAppShortcut({ key: 'N', ctrlKey: true })).toBe('new-session')
    expect(matchAppShortcut({ key: 'K', ctrlKey: true })).toBe('command-palette')
  })

  it('不带修饰键的字母不触发', () => {
    expect(matchAppShortcut({ key: 'n' })).toBeNull()
    expect(matchAppShortcut({ key: 'k' })).toBeNull()
    expect(matchAppShortcut({ key: ',' })).toBeNull()
  })

  it('Ctrl+Alt+X 这类别的应用的组合键不抢', () => {
    expect(matchAppShortcut({ key: 'n', ctrlKey: true, altKey: true })).toBeNull()
    expect(matchAppShortcut({ key: 'k', ctrlKey: true, altKey: true })).toBeNull()
  })

  it('长按不算连续触发：按住 Ctrl+N 不连开会话', () => {
    expect(matchAppShortcut({ key: 'n', ctrlKey: true, repeat: true })).toBeNull()
    expect(matchAppShortcut({ key: 'k', ctrlKey: true, repeat: true })).toBeNull()
  })

  it('输入法组合中的按键不算：拼音里打 k 不弹面板', () => {
    expect(matchAppShortcut({ key: 'k', ctrlKey: true, isComposing: true })).toBeNull()
    expect(matchAppShortcut({ key: 'n', ctrlKey: true, isComposing: true })).toBeNull()
  })

  it('其他按键返回 null，不会误吞', () => {
    for (const key of ['a', 'j', '.', 'Escape', 'Enter', 'Tab']) {
      expect(matchAppShortcut({ key, ctrlKey: true })).toBeNull()
    }
  })
})
