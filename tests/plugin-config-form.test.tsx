import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { setLocale } from '../src/renderer/src/i18n'
import { PluginConfigForm } from '../src/renderer/src/components/PluginConfigForm'
import type { PluginRecordView } from '../src/shared/types'

// The assertions pin the Chinese source copy; navigator.language is en-US on
// the Linux CI runner, so pin the effective locale before rendering.
setLocale('zh-CN')

/**
 * `PluginConfigForm` is what turns `settings[]` in a manifest into fields the
 * user can actually edit. The behaviour worth pinning is the seeding rule: what
 * is already stored has to show up when the card is opened, and a password has
 * to stay out of the DOM while still telling the user a value exists.
 */

function record(partial: Partial<PluginRecordView>): PluginRecordView {
  return {
    id: 'worklog',
    name: '工作日志',
    version: 1,
    description: '',
    dir: '/ws/.pilot/plugins/worklog',
    entry: 'index.mjs',
    permissions: [],
    roles: [],
    routes: [],
    tools: [],
    settings: [],
    triggers: [],
    providesSession: false,
    enabled: true,
    granted: [],
    signature: null,
    error: null,
    ...partial,
  }
}

const render = (plugin: PluginRecordView): string =>
  // createElement, not a direct call: the form uses useState, so it has to go
  // through the renderer to get a hook context.
  renderToStaticMarkup(
    createElement(PluginConfigForm, { plugin, busy: false, onSave: () => undefined }),
  )

describe('plugin config form', () => {
  it('seeds the fields from the stored values so a reopened card is not blank', () => {
    const html = render(
      record({
        settings: [
          { key: 'tag', label: '默认标签', type: 'text', required: false, placeholder: 'general', description: '', value: 'ui-test' },
          { key: 'digestSize', label: '回看条数', type: 'number', required: false, placeholder: '5', description: '', value: 3 },
        ],
      }),
    )
    expect(html).toContain('默认标签')
    expect(html).toContain('value="ui-test"')
    expect(html).toContain('value="3"')
  })

  it('falls back to the placeholder when nothing is stored yet', () => {
    const html = render(
      record({
        settings: [
          { key: 'tag', label: '默认标签', type: 'text', required: false, placeholder: 'general', description: '', value: null },
        ],
      }),
    )
    expect(html).toContain('placeholder="general"')
    expect(html).toContain('value=""')
  })

  it('renders a boolean as a checkbox rather than as text', () => {
    const html = render(
      record({
        settings: [
          { key: 'quiet', label: '关闭每日提醒', type: 'boolean', required: false, placeholder: '', description: '', value: true },
        ],
      }),
    )
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('checked=""')
  })

  it('shows that a password is stored without ever carrying the value', () => {
    // The host sends '' for "a password is stored" and null for "none yet"
    // (studio.ts:287), so the field itself is always empty here.
    const stored = render(
      record({
        settings: [
          { key: 'token', label: '令牌', type: 'password', required: true, placeholder: '粘贴令牌', description: '', value: '' },
        ],
      }),
    )
    expect(stored).toContain('type="password"')
    expect(stored).toContain('placeholder="已保存，留空则不改"')
    expect(stored).toContain('value=""')

    const unset = render(
      record({
        settings: [
          { key: 'token', label: '令牌', type: 'password', required: true, placeholder: '粘贴令牌', description: '', value: null },
        ],
      }),
    )
    expect(unset).toContain('placeholder="粘贴令牌"')
  })

  it('renders nothing at all when the manifest declares no settings', () => {
    expect(render(record({ settings: [] }))).toBe('')
  })
})
