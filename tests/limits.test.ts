import { describe, expect, it } from 'vitest'
import {
  CONTEXT_SAFETY_TOKENS,
  contextCeiling,
  effectiveContextTokens,
  effectiveOutputTokens,
  FALLBACK_LIMITS,
  modelLimits,
  OUTPUT_RESERVE_TOKENS,
  subagentContextTokens,
} from '../src/shared/modelLimits'

describe('model limits', () => {
  it('gives Claude endpoints the 1M context / 64K output envelope', () => {
    expect(modelLimits('claude-sonnet-4-5')).toEqual({
      contextTokens: 1_000_000,
      outputTokens: 64_000,
    })
  })

  it('keeps DeepSeek within its real provider envelope', () => {
    expect(modelLimits('deepseek-chat')).toEqual({
      contextTokens: 128_000,
      outputTokens: 8_192,
    })
    expect(modelLimits('deepseek-reasoner').outputTokens).toBe(64_000)
  })

  it('gives Qwen and GLM the 1M window their APIs expose', () => {
    expect(modelLimits('qwen3.8-max')).toEqual({
      contextTokens: 1_000_000,
      outputTokens: 32_000,
    })
    expect(modelLimits('glm-5.3').contextTokens).toBe(1_000_000)
  })

  it('falls back to a 200K window for unknown endpoints', () => {
    expect(modelLimits('some-local-model')).toEqual(FALLBACK_LIMITS)
  })

  it('clamps the configured budget to the model window minus the reserves', () => {
    const claudeCeiling = 1_000_000 - CONTEXT_SAFETY_TOKENS - OUTPUT_RESERVE_TOKENS
    expect(contextCeiling('claude-opus-4-6')).toBe(claudeCeiling)
    expect(effectiveContextTokens(1_000_000, 'claude-opus-4-6')).toBe(claudeCeiling)
    expect(effectiveContextTokens(1_000_000, 'deepseek-chat')).toBe(128_000 - 12_000)
    expect(effectiveContextTokens(1_000_000, '')).toBe(200_000 - 12_000)
  })

  it('keeps an ask that is already below the ceiling', () => {
    expect(effectiveContextTokens(32_000, 'claude-opus-4-6')).toBe(32_000)
    expect(effectiveContextTokens(0, 'claude-opus-4-6')).toBe(988_000)
  })

  it('gives subagents half the window at most', () => {
    expect(subagentContextTokens(1_000_000, 'claude-opus-4-6')).toBe(500_000)
    expect(subagentContextTokens(1_000_000, 'deepseek-chat')).toBe(64_000)
    expect(subagentContextTokens(1_000_000, '')).toBe(100_000)
    // never above the main budget, never dormantly smaller than the floor
    expect(subagentContextTokens(20_000, 'claude-opus-4-6')).toBe(20_000)
  })

  it('clamps output tokens to the model ceiling', () => {
    expect(effectiveOutputTokens(64_000, 'claude-opus-4-6')).toBe(64_000)
    expect(effectiveOutputTokens(64_000, 'deepseek-chat')).toBe(8_192)
    expect(effectiveOutputTokens(0, 'deepseek-chat')).toBe(0)
  })
})
