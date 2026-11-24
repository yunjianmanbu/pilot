import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { setLocale } from '../src/renderer/src/i18n'
import { ToolCard } from '../src/renderer/src/components/SystemToolsPanel'
import { toolSourceLabel } from '../src/renderer/src/components/SessionResourcesPanel'
import type { ToolCatalogEntry } from '../src/shared/types'

// The assertions pin the Chinese source copy; navigator.language is en-US on
// the Linux CI runner, so pin the effective locale before rendering.
setLocale('zh-CN')

/**
 * 插件工具最终能不能被用户看见，取决于两个面板怎么标注来源。
 * 这里直接静态渲染一张工具卡片、直接调用来源标签函数，
 * 因为面板本体要先取清单才出内容（SystemToolsPanel 的 tools 初始为 null）。
 */

function entry(partial: Partial<ToolCatalogEntry>): ToolCatalogEntry {
  return {
    name: 'plugin__worklog__log',
    description: 'Append one line to the work log.',
    descriptionZh: '往工作日志里追加一条记录。',
    risk: 'write',
    source: 'plugin',
    plugin: 'worklog',
    pluginName: '工作日志',
    enabled: true,
    calls: 0,
    ...partial,
  }
}

const render = (tool: ToolCatalogEntry): string => renderToStaticMarkup(<ToolCard tool={tool} />)

describe('tool panel rows for plugins', () => {
  it('names the owning plugin so two plugins with a status tool are distinguishable', () => {
    const html = render(entry({}))
    expect(html).toContain('plugin__worklog__log')
    expect(html).toContain('插件 · 工作日志')
    expect(html).toContain('往工作日志里追加一条记录。')
    expect(html).toContain('写文件')
  })

  it('says 可用 when the plugin is enabled and 未启用 once it is not', () => {
    expect(render(entry({ enabled: true }))).toContain('可用')
    const disabled = render(entry({ enabled: false }))
    expect(disabled).toContain('未启用')
    expect(disabled).not.toContain('>可用<')
  })

  it('falls back to a bare 插件 chip when the manifest has no display name', () => {
    const html = render(entry({ pluginName: undefined }))
    expect(html).toContain('>插件<')
  })

  it('shows the cumulative call count, including plugins never used', () => {
    expect(render(entry({ calls: 0 }))).toContain('调用 0 次')
    expect(render(entry({ calls: 12 }))).toContain('调用 12 次')
  })

  it('leaves built-in and MCP rows unchanged', () => {
    expect(render(entry({ source: 'builtin', name: 'read_file', risk: 'read', calls: 3 }))).toContain(
      '内置',
    )
    expect(toolSourceLabel(entry({ source: 'mcp', server: 'github', plugin: undefined }))).toBe(
      'MCP · github',
    )
  })
})

describe('session resources source label', () => {
  it('matches the tool panel wording for plugin tools', () => {
    expect(toolSourceLabel(entry({}))).toBe('插件 · 工作日志')
    expect(toolSourceLabel(entry({ pluginName: undefined }))).toBe('插件')
  })

  it('keeps the existing labels for the other three sources', () => {
    expect(toolSourceLabel(entry({ source: 'builtin' }))).toBe('内置')
    expect(toolSourceLabel(entry({ source: 'control' }))).toBe('控制')
    expect(toolSourceLabel(entry({ source: 'dynamic' }))).toBe('自写')
  })
})
