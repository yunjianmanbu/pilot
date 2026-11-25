import { describe, expect, it } from 'vitest'
import { buildExplorePrompt } from '../src/main/agent/explore'
import { buildSystemPrompt, thinkingLanguageGuard } from '../src/main/agent/prompt'
import { buildReviewSystemPrompt } from '../src/main/agent/review'
import { buildPrompt as buildSubagentPrompt } from '../src/main/agent/subagent'

/**
 * 偶发的「中文模式里出现英文或日文思考」有两个来源，单靠「用中文思考」这句
 * 指令压不住：工具输出是英文时代码会跟着切成英文，CJK 模型还会整段漂到日文。
 * 因此四处提示词必须带上同一条加固子句，且例句不能反过来禁止目标语言。
 */
describe('thinkingLanguageGuard', () => {
  it('forbids drifting into another language for a single step', () => {
    const zh = thinkingLanguageGuard('zh-CN')
    expect(zh).toContain('Do not switch thinking to another language')
    expect(zh).toContain('restate it in Simplified Chinese')
    // 英文与日文是实际观察到的两种漂移，必须点名。
    expect(zh).toContain('English')
    expect(zh).toContain('Japanese')
  })

  it('never tells an English UI not to think in English', () => {
    const en = thinkingLanguageGuard('en')
    expect(en).toContain('restate it in English')
    expect(en).not.toContain('not English')
    expect(en).toContain('not Simplified Chinese')
  })

  it('defaults to the app Chinese default when the locale is unknown', () => {
    expect(thinkingLanguageGuard(undefined)).toContain('restate it in Simplified Chinese')
  })
})

describe('every prompt that can show a thinking block', () => {
  const guard = thinkingLanguageGuard('zh-CN')

  it('carries the guard in the main run prompt', () => {
    const prompt = buildSystemPrompt({
      root: '/repo',
      topLevel: 'src',
      memory: [],
      profile: null,
      globalProfile: null,
      globalInstructions: [],
      locale: 'zh-CN',
      projectInstructions: [],
      skills: [],
      dynamicTools: [],
      plan: null,
      selfUpdate: false,
    })
    expect(prompt).toContain(guard)
  })

  it('repeats the thinking language at the end of the prompt', () => {
    // 规则在开头，但模型跑到十几步后会漂移；末尾再收一次，位置最靠近下一步。
    const prompt = buildSystemPrompt({
      root: '/repo',
      topLevel: 'src',
      memory: [],
      profile: null,
      globalProfile: null,
      globalInstructions: [],
      locale: 'zh-CN',
      projectInstructions: [],
      skills: [],
      dynamicTools: [],
      plan: null,
      selfUpdate: false,
    })
    expect(prompt.trimEnd().endsWith('this turn\'s thinking stays in Simplified Chinese.')).toBe(true)
  })

  it('carries the guard in the subagent prompt', () => {
    expect(buildSubagentPrompt('explore', '/repo', 'look', undefined, false, 'zh-CN')).toContain(
      guard,
    )
  })

  it('carries the guard in the explore prompt', () => {
    expect(buildExplorePrompt('/repo', 'find tests', undefined, 'zh-CN')).toContain(guard)
  })

  it('carries the guard in the review prompt', () => {
    const prompt = buildReviewSystemPrompt({
      scope: { roots: [{ name: 'primary', path: '/repo' }], sessions: 'workspace' },
      primaryRoot: '/repo',
      topLevel: 'src',
      plan: null,
      locale: 'zh-CN',
    })
    expect(prompt).toContain(guard)
  })
})
