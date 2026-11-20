import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  TopbarMenu,
  TopbarMenuPopup,
  type TopbarMenuItem,
} from '../src/renderer/src/components/TopbarMenu'
import { ClockIcon, CopyIcon, DiffIcon } from '../src/renderer/src/icons'

/**
 * 顶栏挤成一条时最先丢的是会话标题，所以这里守住两件事：
 * 触发器默认收起（30px），以及收起的操作一项都不少、分组和勾选都对。
 */

const noop = (): void => {}

function items(overrides: Partial<TopbarMenuItem> = {}): TopbarMenuItem[] {
  return [
    { key: 'copy', label: '复制完整对话记录', icon: <CopyIcon />, onSelect: noop },
    { key: 'changes', label: '变更审阅', icon: <DiffIcon />, active: true, ...overrides, onSelect: noop },
    {
      key: 'schedule',
      label: '定时任务',
      icon: <ClockIcon />,
      dividerBefore: true,
      onSelect: noop,
    },
  ]
}

describe('TopbarMenu trigger', () => {
  it('默认收起：只有一个按钮，不带菜单', () => {
    const html = renderToStaticMarkup(
      <TopbarMenu items={items()} label="会话操作" title="更多会话操作" />,
    )
    const buttons = html.match(/<button[\s\S]*?<\/button>/g) ?? []
    expect(buttons).toHaveLength(1)
    expect(html).toContain('aria-haspopup="menu"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('aria-label="会话操作"')
    expect(html).toContain('title="更多会话操作"')
    expect(html).not.toContain('topbar-menu-pop')
    expect(html).not.toContain('role="menuitem"')
  })

  it('面板打开时触发器进入活跃态，方便知道某个面板还开着', () => {
    const closed = renderToStaticMarkup(
      <TopbarMenu
        items={items({ active: false })}
        label="会话操作"
      />,
    )
    expect(closed).not.toContain('topbar-icon is-active')

    const open = renderToStaticMarkup(<TopbarMenu items={items()} label="会话操作" />)
    expect(open).toContain('class="topbar-icon is-active"')
  })
})

describe('TopbarMenuPopup', () => {
  it('按顺序渲染每一项，并保留分组分隔线', () => {
    const html = renderToStaticMarkup(
      <TopbarMenuPopup items={items()} label="会话操作" />,
    )
    expect(html).toContain('role="menu"')
    expect(html).toContain('aria-label="会话操作"')
    const labels = [...html.matchAll(/class="topbar-menu-label">([^<]+)</g)].map((m) => m[1])
    expect(labels).toEqual(['复制完整对话记录', '变更审阅', '定时任务'])
    expect(html.match(/role="separator"/g)).toHaveLength(1)
    // 分隔线必须落在「定时任务」之前，把会话操作和产出/计划操作分开。
    expect(html.indexOf('topbar-menu-sep')).toBeLessThan(html.indexOf('定时任务'))
  })

  it('已打开的面板打勾，未打开的不带勾', () => {
    const html = renderToStaticMarkup(<TopbarMenuPopup items={items()} label="会话操作" />)
    const marked = html.match(/class="topbar-menu-item is-active"/g) ?? []
    expect(marked).toHaveLength(1)
    expect(html.match(/topbar-menu-check/g)).toHaveLength(1)
    expect(html).toContain('title="变更审阅"')
  })

  it('禁用项被禁用且仍标注原因（悬停说明）', () => {
    const html = renderToStaticMarkup(
      <TopbarMenuPopup
        items={[
          {
            key: 'fork',
            label: '创建会话副本',
            icon: <CopyIcon />,
            hint: '当前会话正在执行，结束后可以创建副本',
            disabled: true,
            onSelect: noop,
          },
        ]}
        label="会话操作"
      />,
    )
    expect(html).toContain('disabled')
    expect(html).toContain('title="当前会话正在执行，结束后可以创建副本"')
  })
})
