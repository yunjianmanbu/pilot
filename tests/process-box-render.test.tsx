import './locale-zh.mjs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ProcessBox } from '../src/renderer/src/components/ProcessBox'
import { reasoningPeek } from '../src/renderer/src/components/ReasoningBlock'
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

describe('reasoning summary line', () => {
  it('keeps only the first non-empty line, flattened', () => {
    expect(reasoningPeek('\n\n  先看目录  \n再读文件')).toBe('先看目录')
    expect(reasoningPeek('第一行\t有   空白\n第二行')).toBe('第一行 有 空白')
    expect(reasoningPeek('   \n\n')).toBe('')
  })

  it('clips a long first line with an ellipsis', () => {
    const long = '甲'.repeat(120)
    const peek = reasoningPeek(long)
    expect(peek).toBe(`${'甲'.repeat(80)}…`)
    expect(reasoningPeek(long, 5)).toBe('甲甲甲甲甲…')
  })

  it('shows the peek inside the folded summary of a step', () => {
    const process = processOf([step('m1', '', '先检查依赖\n然后跑测试', ['t1'])])
    const html = renderToStaticMarkup(<ProcessBox process={process} />)
    const summary = html.slice(html.indexOf('<summary>'), html.indexOf('</summary>'))
    expect(summary).toContain('reasoning-peek')
    expect(summary).toContain('先检查依赖')
    expect(summary).not.toContain('然后跑测试')
  })
})

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

  it('drops the step numbers from the collapsed reasoning rows', () => {
    const process = processOf([
      step('m1', '', '思考一', ['a1']),
      step('m2', '', '思考二', ['a2']),
      step('m3', '', '思考三', ['a3']),
      step('m4', '', '思考四', ['a4']),
      step('m5', '', '思考五', ['a5']),
      step('m6', '', '思考六', ['a6']),
    ])

    const html = renderToStaticMarkup(<ProcessBox process={process} />)
    // The window holds the newest five parts; every row is titled
    // 「思考过程」 with no run-wide index after it.
    expect(countSteps(html)).toBe(5)
    expect(html).toContain('思考过程')
    expect(html).not.toMatch(/思考过程\s*\d/)
    // The title carries the first line of that step's thinking instead.
    expect(html).toContain('思考五')
    expect(html).toContain('思考六')
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

describe('live process box progress', () => {
  it('counts how long a still-running box has been working', () => {
    const process = {
      ...processOf([step('m1', '', '思考一', ['t1'])]),
      live: true,
      startedAt: Date.now() - 95_000,
    }
    const html = renderToStaticMarkup(<ProcessBox process={process} />)
    expect(html).toContain('process-elapsed')
    expect(html).toContain('1m 35s')
    expect(html).toContain('执行中')
  })

  it('keeps a finished box free of the live counter', () => {
    const process = processOf([step('m1', '', '思考一', ['t1'])])
    const html = renderToStaticMarkup(<ProcessBox process={process} />)
    expect(html).not.toContain('process-elapsed')
    expect(html).toContain('执行完成')
  })
})
