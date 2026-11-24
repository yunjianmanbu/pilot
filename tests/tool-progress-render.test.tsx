import './locale-zh.mjs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ToolCard } from '../src/renderer/src/components/ToolCard'
import { RunningPill } from '../src/renderer/src/components/RunningPill'
import { ThinkingIndicator, LiveElapsed } from '../src/renderer/src/components/chat/panels'
import { runElapsedLabel, runningToolLabel, type ToolView } from '../src/renderer/src/ui'

const START = '2026-01-01T00:00:00.000Z'

function at(offsetMs: number): string {
  return new Date(new Date(START).getTime() + offsetMs).toISOString()
}

function tool(overrides: Partial<ToolView> = {}): ToolView {
  return {
    id: 'call-1',
    name: 'run_command',
    args: { command: 'npx vitest run tests' },
    risk: 'exec',
    status: 'running',
    at: START,
    ...overrides,
  }
}

describe('runningToolLabel', () => {
  it('stays quiet for a call that just started', () => {
    expect(runningToolLabel(START, new Date(START).getTime() + 1_500)).toBe('')
    expect(runningToolLabel(undefined, Date.now())).toBe('')
    expect(runningToolLabel('not-a-date', Date.now())).toBe('')
  })

  it('counts a call that is still working', () => {
    expect(runningToolLabel(START, new Date(START).getTime() + 12_000)).toBe('已运行 12s')
  })

  it('says so once the wait is long enough to worry about', () => {
    const label = runningToolLabel(START, new Date(START).getTime() + 95_000)
    expect(label).toBe('已运行 1m 35s · 仍在执行')
  })
})

describe('runElapsedLabel', () => {
  it('stays empty until the wait is worth showing', () => {
    const start = new Date(START).getTime()
    expect(runElapsedLabel(undefined)).toBe('')
    expect(runElapsedLabel(start, start + 900)).toBe('')
  })

  it('counts the whole run, including time spent thinking', () => {
    const start = new Date(START).getTime()
    expect(runElapsedLabel(start, start + 8_000)).toBe('8.0s')
    expect(runElapsedLabel(start, start + 125_000)).toBe('2m 5s')
  })
})

describe('running tool card', () => {
  it('shows step and elapsed time in the topbar pill', () => {
    const html = renderToStaticMarkup(
      <RunningPill startedAt={Date.now() - 95_000} step={7} />,
    )
    expect(html).toContain('执行中')
    expect(html).toContain('第 7 步')
    expect(html).toContain('1m 35s')
    expect(html).toContain('running-elapsed')
  })

  it('omits the counters when neither is known yet', () => {
    const html = renderToStaticMarkup(<RunningPill startedAt={Date.now()} step={0} />)
    expect(html).toContain('执行中')
    expect(html).not.toContain('第 0 步')
    expect(html).not.toContain('running-elapsed')
  })
  it('shows a live counter instead of looking stuck', () => {
    // 90s before "now", so the static render already crosses the quiet threshold.
    const html = renderToStaticMarkup(
      <ToolCard tool={tool({ at: new Date(Date.now() - 90_000).toISOString() })} />,
    )
    expect(html).toContain('仍在执行')
    expect(html).toContain('tool-duration is-running')
  })

  it('keeps a finished call on its recorded duration', () => {
    const html = renderToStaticMarkup(
      <ToolCard tool={tool({ status: 'ok', durationMs: 2_500 })} />,
    )
    expect(html).toContain('2.5s')
    expect(html).not.toContain('仍在执行')
    expect(html).not.toContain('is-running')
  })
})

describe('thinking indicator', () => {
  it('counts the wait so a long silence is visible', () => {
    const html = renderToStaticMarkup(
      <ThinkingIndicator step={4} startedAt={Date.now() - 95_000} />,
    )
    expect(html).toContain('正在执行第 4 步')
    expect(html).toContain('thinking-elapsed')
    expect(html).toContain('1m 35s')
  })

  it('stays quiet for the first seconds and when the start is unknown', () => {
    const quick = renderToStaticMarkup(
      <ThinkingIndicator step={1} startedAt={Date.now()} />,
    )
    expect(quick).toContain('正在理解任务')
    expect(quick).not.toContain('thinking-elapsed')
    const unknown = renderToStaticMarkup(<ThinkingIndicator step={1} />)
    expect(unknown).not.toContain('thinking-elapsed')
  })

  it('reuses the same counter for a run that already streamed text', () => {
    const html = renderToStaticMarkup(
      <LiveElapsed startedAt={Date.now() - 125_000} />,
    )
    expect(html).toContain('2m 5s')
    expect(renderToStaticMarkup(<LiveElapsed />)).toBe('')
  })
})
