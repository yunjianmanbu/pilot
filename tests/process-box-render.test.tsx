import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ProcessBox } from '../src/renderer/src/components/ProcessBox'
import { ToolCard } from '../src/renderer/src/components/ToolCard'
import { buildTranscript, formatClock, type UIMessage, type ToolView } from '../src/renderer/src/ui'
import type { StoredMessage } from '../src/shared/types'

function step(id: string, content: string, reasoning: string, toolIds: string[]): StoredMessage {
  return {
    id,
    role: 'assistant',
    content,
    reasoning,
    createdAt: '2026-01-01T00:00:00.000Z',
    runId: 'run-1',
    toolCalls: toolIds.map((toolId) => ({
      id: toolId,
      name: 'read_file',
      arguments: { path: `${toolId}.ts` },
    })),
  }
}

function processOf(messages: StoredMessage[]): Extract<UIMessage, { kind: 'process' }> {
  const block = buildTranscript(messages).find((entry) => entry.kind === 'process')
  if (!block || block.kind !== 'process') throw new Error('missing process block')
  return block
}

function countSteps(html: string): number {
  const matches = html.match(/class="(?:reasoning-block|process-note|tool-card )/g) ?? []
  return matches.length
}

describe('ProcessBox collapsed rendering', () => {
  it('renders only the five newest steps of a long run', () => {
    const process = processOf([
      step('m1', '先看目录', '思考一', ['t1', 't2']),
      step('m2', '继续读文件', '思考二', ['t3', 't4']),
      step('m3', '', '思考三', ['t5', 't6']),
      step('m4', '', '', ['t7', 't8']),
    ])
    expect(process.tools).toHaveLength(8)

    const html = renderToStaticMarkup(<ProcessBox process={process} />)
    // 13 recorded steps: 2 notes, 3 reasoning blocks, 8 tool cards.
    expect(countSteps(html)).toBe(5)
    expect(html).toContain('更早的 8 项执行过程')
    expect(html).toContain('t5.ts')
    expect(html).toContain('t8.ts')
    expect(html).not.toContain('t4.ts')
    expect(html).not.toContain('先看目录')
  })

  it('renders every step of a short run without the expand hint', () => {
    const process = processOf([step('m1', '', '只有一步', ['only'])])
    const html = renderToStaticMarkup(<ProcessBox process={process} />)
    expect(countSteps(html)).toBe(2)
    expect(html).not.toContain('更早的')
  })

  it('numbers reasoning steps by their position in the whole run', () => {
    const process = processOf([
      step('m1', '', '思考一', ['a1']),
      step('m2', '', '思考二', ['a2']),
      step('m3', '', '思考三', ['a3']),
      step('m4', '', '思考四', ['a4']),
      step('m5', '', '思考五', ['a5']),
      step('m6', '', '思考六', ['a6']),
    ])

    const html = renderToStaticMarkup(<ProcessBox process={process} />)
    // The window holds the newest five parts; the two reasoning blocks in it
    // keep their run-wide numbers instead of restarting at 1.
    expect(countSteps(html)).toBe(5)
    expect(html).toContain('思考过程 5')
    expect(html).toContain('思考过程 6')
    expect(html).not.toContain('思考过程 1')
    expect(html).not.toContain('思考过程 2')
    expect(html).not.toContain('思考一')
  })

  it('opens each step with its execution time', () => {
    const process = processOf([step('m1', '先看目录', '思考一', ['t1'])])
    const clock = formatClock('2026-01-01T00:00:00.000Z')
    expect(clock).toMatch(/^\d{2}:\d{2}:\d{2}$/)

    const html = renderToStaticMarkup(<ProcessBox process={process} />)
    // Reasoning block and interim note both carry the stored message time.
    expect(html.match(/执行时间/g) ?? []).toHaveLength(2)
    expect(html).toContain(`执行时间 ${clock}`)
  })

  it('puts the execution time on the first line of an expanded tool card', () => {
    const at = '2026-01-01T03:04:05.000Z'
    const tool: ToolView = {
      id: 't1',
      name: 'read_file',
      args: { path: 'a.ts' },
      risk: 'read',
      status: 'error',
      at,
      result: { ok: false, output: 'boom', error: 'boom' },
    }

    const html = renderToStaticMarkup(<ToolCard tool={tool} />)
    expect(html).toContain(`执行时间 ${formatClock(at)}`)
    // The stamp comes before the parameter block inside the opened body.
    expect(html.indexOf('process-time')).toBeLessThan(html.indexOf('tool-args'))
  })
})
