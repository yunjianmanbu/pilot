import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { setLocale } from '../src/renderer/src/i18n'
import { CheckpointList } from '../src/renderer/src/components/CheckpointDialog'
import type { Checkpoint, SettingsView } from '../src/shared/types'

// Assertions pin the Chinese source copy, so pin the locale first.
setLocale('zh-CN')

function checkpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    id: 'cp-1',
    sessionId: 'session-1',
    workspacePath: 'E:/work',
    label: '自动快照',
    trigger: 'prompt',
    createdAt: '2026-01-01T00:00:00.000Z',
    files: 120,
    bytes: 2 * 1024 * 1024,
    messageCount: 4,
    complete: true,
    skipped: 0,
    scope: 'all',
    ...overrides,
  } as Checkpoint
}

function render(items: Checkpoint[], checkpointIgnore: string[] = []): string {
  return renderToStaticMarkup(
    <CheckpointList
      items={items}
      ignored={[]}
      settings={{ checkpointIgnore } as SettingsView}
      working=""
      onRestore={() => {}}
      onSkip={() => {}}
    />,
  )
}

describe('CheckpointList coverage hint', () => {
  it('names the directories a snapshot could not hold and offers to skip them', () => {
    const html = render([
      checkpoint({
        omittedDirs: [{ path: 'pilot/release', files: 640, bytes: 180 * 1024 * 1024 }],
      }),
    ])
    expect(html).toContain('这次快照放不下以下目录')
    expect(html).toContain('pilot/release')
    expect(html).toContain('640')
    expect(html).toContain('跳过此目录')
    expect(html).not.toContain('已跳过')
  })

  it('marks an omitted directory as already skipped when the setting covers it', () => {
    const html = render(
      [
        checkpoint({
          omittedDirs: [{ path: 'pilot/release', files: 640, bytes: 180 * 1024 * 1024 }],
        }),
      ],
      ['pilot/release'],
    )
    expect(html).toContain('已跳过')
    expect(html).not.toContain('跳过此目录')
    expect(html).toContain('disabled')
  })

  it('leaves the row clean when a snapshot covered everything', () => {
    const html = render([checkpoint()])
    expect(html).not.toContain('这次快照放不下以下目录')
    // The scope badge still says what the snapshot covered.
    expect(html).toContain('全部文件')
  })

  it('labels a source-only snapshot as such, and still warns about a truncated one', () => {
    const html = render([checkpoint({ scope: 'code', complete: false, skipped: 7 })])
    expect(html).toContain('仅源码')
    expect(html).toContain('不完整：跳过')
    expect(html).toContain('7')
  })
})
