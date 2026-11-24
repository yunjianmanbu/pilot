import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { setLocale } from '../src/renderer/src/i18n'
import { PluginFacts, triggerLabel } from '../src/renderer/src/components/PluginFacts'
import type { PluginRecordView } from '../src/shared/types'

// The assertions pin the Chinese source copy; navigator.language is en-US on
// the Linux CI runner, so pin the effective locale before rendering.
setLocale('zh-CN')

/**
 * The installed-plugin card is the only place a user can see what a plugin
 * exposes before enabling it. These tests render it directly: driving the whole
 * `PluginsPanel` would need IPC, and the thing under test is the fact block.
 */

function record(partial: Partial<PluginRecordView>): PluginRecordView {
  return {
    id: 'worklog',
    name: '工作日志',
    version: 1,
    description: '',
    dir: '/ws/.pilot/plugins/worklog',
    entry: 'index.mjs',
    permissions: ['entries:read'],
    roles: [],
    routes: [{ method: 'POST', path: 'log', auth: 'required', permission: null, description: '' }],
    tools: [
      { name: 'log', description: '', risk: 'write', route: 'log', method: 'POST' },
      { name: 'recent', description: '', risk: 'read', route: 'recent', method: 'POST' },
    ],
    settings: [],
    triggers: [],
    providesSession: false,
    enabled: true,
    granted: ['entries:read'],
    signature: null,
    error: null,
    ...partial,
  }
}

describe('plugin card facts', () => {
  it('lists tools with their risk so a write tool is visible before enabling', () => {
    const html = renderToStaticMarkup(PluginFacts({ plugin: record({}) }))
    expect(html).toContain('智能体工具')
    expect(html).toContain('log（write）')
    expect(html).toContain('recent（read）')
    expect(html).toContain('POST log')
    expect(html).toContain('entries:read')
  })

  it('says 无 when a plugin exposes nothing', () => {
    const html = renderToStaticMarkup(
      PluginFacts({ plugin: record({ tools: [], routes: [], permissions: [] }) }),
    )
    expect(html).toContain('无')
    expect(html).not.toContain('触发器')
  })

  it('renders a schedule trigger as a sentence, not a code', () => {
    const daily = renderToStaticMarkup(
      PluginFacts({
        plugin: record({ triggers: [{ event: 'schedule', everyMinutes: null, timeOfDay: '18:00' }] }),
      }),
    )
    expect(daily).toContain('触发器')
    expect(daily).toContain('18:00')

    expect(triggerLabel({ event: 'schedule', everyMinutes: 30, timeOfDay: null })).toContain('30')
    expect(triggerLabel({ event: 'run.completed', everyMinutes: null, timeOfDay: null })).toBeTruthy()
    expect(
      triggerLabel({ event: 'session.created', everyMinutes: null, timeOfDay: null }),
    ).toBeTruthy()
  })
})
