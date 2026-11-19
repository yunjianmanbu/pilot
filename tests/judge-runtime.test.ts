import { describe, expect, it } from 'vitest'
import {
  completeWithWatchdog,
  unparsedResponseReason,
} from '../src/main/agent/judge-runtime'
import { coerceScore, coerceTrue, extractJsonObject } from '../src/main/agent/json'
import { parseJudgeScores } from '../src/main/agent/profile-benchmark'
import type { ModelClient } from '../src/main/agent/loop'

describe('tolerant JSON extraction', () => {
  it('reads an object inside a Markdown fence, including a trailing comma', () => {
    const parsed = extractJsonObject('Here it is:\n```json\n{"score": 85, "pass": true,}\n```\nDone.')
    expect(parsed).toEqual({ score: 85, pass: true })
  })

  it('does not split a brace inside a JSON string', () => {
    const parsed = extractJsonObject('{"note":"use }, not } here","score":91}')
    expect(parsed?.['note']).toBe('use }, not } here')
    expect(parsed?.['score']).toBe(91)
  })

  it('prefers the fenced answer over an example object in prose', () => {
    const parsed = extractJsonObject('An example {"a":1} follows.\n```json\n{"verdict":"ok"}\n```')
    expect(parsed).toEqual({ verdict: 'ok' })
  })

  it('returns null instead of guessing when no object parses', () => {
    expect(extractJsonObject('I could not decide.')).toBeNull()
    expect(extractJsonObject('{"score": 88')).toBeNull()
  })
})

describe('score coercion', () => {
  it('accepts numbers, numeric strings and nested score fields', () => {
    expect(coerceScore(87)).toBe(87)
    expect(coerceScore('87')).toBe(87)
    expect(coerceScore('87/100')).toBe(87)
    expect(coerceScore('87 分')).toBe(87)
    expect(coerceScore({ score: '87' })).toBe(87)
    expect(coerceScore(0.85)).toBe(85)
    expect(coerceScore('high')).toBeNull()
  })

  it('clamps to the score range', () => {
    expect(coerceScore(140)).toBe(100)
    expect(coerceScore(-4)).toBe(0)
  })

  it('accepts a boolean encoded as a string', () => {
    expect(coerceTrue(true)).toBe(true)
    expect(coerceTrue('true')).toBe(true)
    expect(coerceTrue('false')).toBe(false)
    expect(coerceTrue(1)).toBe(false)
  })

  it('parses judge scores returned as strings or uppercase keys', () => {
    expect(parseJudgeScores('{"a":{"score":"81"},"b":{"score":74}}')).toEqual({ a: 81, b: 74 })
    expect(parseJudgeScores('```json\n{"A":{"score":70},"B":{"score":"66"}}\n```')).toEqual({
      a: 70,
      b: 66,
    })
    expect(parseJudgeScores('{"scores":{"a":60,"b":55}}')).toEqual({ a: 60, b: 55 })
  })
})

describe('judge watchdog', () => {
  it('keeps waiting while reasoning deltas keep arriving', async () => {
    const client: ModelClient = {
      async complete(request) {
        for (let index = 0; index < 5; index += 1) {
          await new Promise((resolve) => setTimeout(resolve, 150))
          await request.onReasoningDelta?.(`thinking ${index}`)
        }
        return { content: '{"score":88}', toolCalls: [], reasoning: 'done', finishReason: 'stop' }
      },
    }
    const response = await completeWithWatchdog(
      client,
      { messages: [], tools: [] },
      { idleMs: 1_000, firstTokenMs: 1_000, totalMs: 10_000 },
    )
    expect(response.content).toBe('{"score":88}')
  })

  it('stops a silent endpoint and names the timeout', async () => {
    const client: ModelClient = {
      complete(request) {
        return new Promise((_, reject) => {
          request.signal?.addEventListener(
            'abort',
            () => reject(new Error('The operation was aborted')),
            { once: true },
          )
        })
      },
    }
    await expect(
      completeWithWatchdog(
        client,
        { messages: [], tools: [] },
        { idleMs: 1_000, firstTokenMs: 1_000, totalMs: 10_000 },
      ),
    ).rejects.toThrow('没有收到新内容')
  }, 10_000)

  it('explains an empty answer that only contains thinking', () => {
    expect(
      unparsedResponseReason({
        content: '',
        toolCalls: [],
        reasoning: 'long reasoning',
        finishReason: 'length',
      }),
    ).toContain('思考占满了输出上限')
    expect(
      unparsedResponseReason({ content: '', toolCalls: [], reasoning: 'why', finishReason: 'stop' }),
    ).toContain('只返回了思考内容')
    expect(unparsedResponseReason({ content: '', toolCalls: [] })).toBe('返回内容为空')
    expect(unparsedResponseReason({ content: 'not json', toolCalls: [] })).toContain('没有可解析')
  })
})
