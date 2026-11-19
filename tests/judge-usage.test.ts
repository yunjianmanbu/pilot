import { describe, expect, it } from 'vitest'
import {
  addJudgeUsage,
  emptyJudgeUsage,
  sanitizeJudgeUsage,
} from '../src/main/agent/judge-runtime'

describe('judge usage accounting', () => {
  it('sums prompt, completion and cached tokens across requests', () => {
    const usage = emptyJudgeUsage()
    addJudgeUsage(usage, { promptTokens: 100, completionTokens: 20, totalTokens: 120 })
    addJudgeUsage(usage, {
      promptTokens: 300,
      completionTokens: 40,
      totalTokens: 340,
      cacheHitTokens: 250,
    })
    expect(usage).toEqual({ input: 400, output: 60, cacheHit: 250, calls: 2 })
  })

  it('counts a request even when the endpoint reports no usage', () => {
    // A gateway that streams no usage block must not look like "never consulted".
    const usage = emptyJudgeUsage()
    addJudgeUsage(usage, undefined)
    expect(usage).toEqual({ input: 0, output: 0, cacheHit: 0, calls: 1 })
  })

  it('drops a persisted block that claims no request', () => {
    expect(sanitizeJudgeUsage({ input: 10, output: 5, cacheHit: 0, calls: 0 })).toBeUndefined()
    expect(sanitizeJudgeUsage(undefined)).toBeUndefined()
    expect(sanitizeJudgeUsage('12')).toBeUndefined()
  })

  it('clamps hostile persisted numbers instead of trusting them', () => {
    expect(
      sanitizeJudgeUsage({ input: -5, output: 12.7, cacheHit: Number.NaN, calls: 1 }),
    ).toEqual({ input: 0, output: 13, cacheHit: 0, calls: 1 })
    expect(sanitizeJudgeUsage({ input: 1e12, calls: 9 })?.input).toBe(1_000_000_000)
  })
})
