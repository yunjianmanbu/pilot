import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { hidesSessionTopbar, type MainView } from '../src/renderer/src/ui'

/**
 * 左下角三个全局资源页（知识 / 链接 / 办公文档）要独占右侧区域：
 * 会话顶栏里那排控件（工作区、会话标题、会话模型、执行模式、会话操作）对全局页没有意义，
 * 顶栏一在，页面就被顶下去 55px、检索结果少显示一整行。
 *
 * 这两条断言守的是「整条顶栏不渲染」，而不是「用 CSS 藏起来」——藏起来仍占位，
 * 且 DOM 里还留着会话级的按钮。
 */

const ALL_VIEWS: MainView[] = [
  'chat',
  'todos',
  'scheduled',
  'memory',
  'tools',
  'models',
  'preferences',
  'plugins',
  'knowledge',
  'links',
  'documents',
]

describe('hidesSessionTopbar', () => {
  it('三个全局资源页隐藏会话顶栏', () => {
    expect(ALL_VIEWS.filter(hidesSessionTopbar)).toEqual(['knowledge', 'links', 'documents'])
  })

  it('会话与其它面板仍保留顶栏（它们要靠顶栏切工作区、看运行状态）', () => {
    for (const view of ALL_VIEWS.filter((entry) => !hidesSessionTopbar(entry))) {
      expect(hidesSessionTopbar(view), view).toBe(false)
    }
  })
})

describe('App 顶栏接法', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../src/renderer/src/App.tsx', import.meta.url)),
    'utf8',
  )

  it('顶栏挂在 fullBleed 条件分支里，隐藏时整段不出 DOM', () => {
    expect(source).toContain('const fullBleed = hidesSessionTopbar(view)')
    // 条件为真给 null，否则才渲染 <header className="topbar">
    expect(source).toMatch(/\{fullBleed \? null : \(\s*<header className="topbar">/)
  })

  it('main-area 里没有第二处顶栏：header 只出现在那个分支内', () => {
    const headers = source.match(/<header className="topbar">/g) ?? []
    expect(headers).toHaveLength(1)
  })
})
