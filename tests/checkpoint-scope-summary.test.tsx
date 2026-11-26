import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { setLocale } from '../src/renderer/src/i18n'
import { CheckpointScopeSummary } from '../src/renderer/src/components/CheckpointScopeSummary'
import type { CheckpointPreview } from '../src/shared/types'

// Assertions pin the Chinese source copy, so pin the locale first.
setLocale('zh-CN')

function preview(overrides: Partial<CheckpointPreview> = {}): CheckpointPreview {
  return {
    scope: 'all',
    files: 1200,
    bytes: 48 * 1024 * 1024,
    codeFiles: 640,
    codeBytes: 6 * 1024 * 1024,
    omittedDirs: [],
    truncated: false,
    ...overrides,
  }
}

function render(input: {
  preview: CheckpointPreview | null
  error?: string
  busy?: boolean
}): string {
  return renderToStaticMarkup(
    <CheckpointScopeSummary
      preview={input.preview}
      error={input.error ?? ''}
      busy={input.busy ?? false}
    />,
  )
}

describe('CheckpointScopeSummary', () => {
  it('quotes both scopes from one preview so the trade-off is visible', () => {
    const html = render({ preview: preview() })
    // 1,200 files / 48 MB for everything, 640 files / 6 MB for source only.
    expect(html).toContain('1,200')
    expect(html).toContain('48.0 MB')
    expect(html).toContain('640')
    expect(html).toContain('6.0 MB')
    expect(html).toContain('仅源码、文档与配置')
  })

  it('says the numbers are partial when the walk hit its budget', () => {
    const html = render({ preview: preview({ truncated: true }) })
    expect(html).toContain('只扫描了一部分，实际数字会更大。')
  })

  it('shows progress instead of a stale number while the first walk runs', () => {
    const html = render({ preview: null, busy: true })
    expect(html).toContain('正在统计这个工作区的文件…')
  })

  it('reports a failed walk without blocking the rest of the settings', () => {
    const html = render({ preview: null, error: 'Workspace not found' })
    expect(html).toContain('无法统计这个工作区：Workspace not found')
  })

  it('renders an empty hint when there is no workspace to measure', () => {
    expect(render({ preview: null })).toBe('<p class="settings-hint checkpoint-preview-hint"></p>')
  })
})
