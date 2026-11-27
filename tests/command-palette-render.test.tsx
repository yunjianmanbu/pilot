import './locale-zh.mjs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CommandPalette, type PaletteCommand } from '../src/renderer/src/components/CommandPalette'

const commands: PaletteCommand[] = [
  {
    id: 'new-session',
    title: '新建任务',
    group: '操作',
    keywords: ['new'],
    icon: null,
    shortcut: 'Ctrl+N',
    run: () => undefined,
  },
  {
    id: 'export-pack',
    title: '导出工作区包',
    group: '操作',
    keywords: ['pack'],
    icon: null,
    disabled: true,
    run: () => undefined,
  },
]

const html = (open: boolean): string =>
  renderToStaticMarkup(
    <CommandPalette open={open} commands={commands} onClose={() => undefined} />,
  )

describe('命令面板渲染', () => {
  it('关闭时不渲染任何东西', () => {
    expect(html(false)).toBe('')
  })

  it('打开时是一个对话框，带搜索框与可搜索列表', () => {
    const markup = html(true)
    expect(markup).toContain('role="dialog"')
    expect(markup).toContain('aria-modal="true"')
    expect(markup).toContain('aria-label="命令面板"')
    expect(markup).toContain('搜索命令：新建任务、设置、切换视图…')
    expect(markup).toContain('role="listbox"')
    expect(markup).toContain('Esc 关闭')
  })

  it('每条命令一行：图标位、标题、分组，有快捷键的显示在行尾', () => {
    const markup = html(true)
    expect(markup).toContain('新建任务')
    expect(markup).toContain('导出工作区包')
    expect(markup).toContain('<kbd class="palette-kbd">Ctrl+N</kbd>')
    expect(markup).toContain('class="palette-group">操作')
  })

  it('不可用的命令带 disabled，不会被误当成可点', () => {
    const markup = html(true)
    expect(markup).toMatch(/class="palette-item is-disabled" disabled=""/)
  })

  it('第一条默认被选中（键盘一进来就能直接回车）', () => {
    const markup = html(true)
    expect(markup).toMatch(/id="palette-new-session"[^>]*aria-selected="true"/)
    expect(markup).toMatch(/id="palette-export-pack"[^>]*aria-selected="false"/)
  })

  it('输入框把选中项告诉读屏软件', () => {
    expect(html(true)).toContain('aria-activedescendant="palette-new-session"')
  })
})
