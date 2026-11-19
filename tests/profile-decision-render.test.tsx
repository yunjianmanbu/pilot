import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ProfileDecision, ProfileRuleDiff } from '../src/renderer/src/components/ProfileDecision'
import type { ProfileExplanation, ProfileVersion, RunRecord } from '../src/shared/types'

/**
 * The decision card is the whole point of the explainable upgrade: a user who
 * does not read rule text must be able to answer "what changes", "who checked
 * it" and "is the new version actually better" from this card alone.
 *
 * These tests render the real component to static markup, so they check the
 * copy a user sees rather than the props we passed in.
 */

function explanation(overrides: Partial<ProfileExplanation> = {}): ProfileExplanation {
  return {
    headline: '改完不告诉你验了什么',
    changes: ['每次收尾会写明哪些没有验证。'],
    impact: '你不用再追问到底测没测。',
    risks: ['输出会多一点。'],
    recommend: 'enable',
    reason: '这是纯新增的规则，不改变已有行为。',
    model: 'deepseek-chat',
    at: '2026-11-14T00:00:00.000Z',
    ...overrides,
  }
}

function profile(overrides: Partial<ProfileVersion> = {}): ProfileVersion {
  return {
    id: 'p-14',
    version: 14,
    status: 'draft',
    promptAddendum: '9. 交付前用一句话列出未验证的部分。',
    strategy: {},
    rationale: '运行记录显示收尾缺少验证说明。',
    explanation: explanation(),
    source: 'self',
    scope: 'workspace',
    evidence: {
      runs: 6,
      completed: 5,
      failures: 1,
      avgSteps: 12,
      avgTokens: 4000,
      positive: 1,
      negative: 0,
    },
    createdAt: '2026-11-14T00:00:00.000Z',
    ...overrides,
  }
}

function run(partial: Partial<RunRecord> & { profileVersion: number; status: RunRecord['status'] }): RunRecord {
  return {
    id: `r-${Math.random().toString(36).slice(2)}`,
    sessionId: 's1',
    prompt: 'do something',
    startedAt: '2026-11-14T00:00:00.000Z',
    steps: 10,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    toolCalls: 1,
    toolErrors: 0,
    ...partial,
  }
}

function render(node: Parameters<typeof renderToStaticMarkup>[0]): string {
  return renderToStaticMarkup(node)
}

describe('profile decision card', () => {
  it('shows the plain-language summary first, without rule text above it', () => {
    const html = render(
      <ProfileDecision
        profile={profile()}
        baseline={null}
        scope="workspace"
        busy={false}
        onExplain={() => {}}
      />,
    )
    expect(html).toContain('改完不告诉你验了什么')
    expect(html).toContain('你不用再追问到底测没测')
    expect(html).toContain('建议启用')
    // Rule text belongs to the technical appendix rendered by the panel, not here.
    expect(html).not.toContain('9. 交付前')
  })

  it('lets a failed check override a summary that said to enable', () => {
    const html = render(
      <ProfileDecision
        profile={profile({
          review: {
            score: 62,
            pass: false,
            notes: '与第 3 条重复。',
            risks: ['可能与第 3 条冲突'],
            at: '2026-11-14T00:00:00.000Z',
            model: 'glm-5.3',
            independent: true,
          },
        })}
        baseline={null}
        scope="workspace"
        busy={false}
        onExplain={() => {}}
      />,
    )
    expect(html).toContain('建议先别启用，继续观察')
    expect(html).not.toContain('建议启用</span>')
    // The note already ends with a period; the join must not print two.
    expect(html).toContain('与第 3 条重复。下面仍保留原本的说明')
    expect(html).not.toContain('。。')
  })

  it('names the independent reviewers when separate models did the check', () => {
    const html = render(
      <ProfileDecision
        profile={profile({
          review: {
            score: 88,
            pass: true,
            notes: '规则清晰。',
            risks: [],
            at: '2026-11-14T00:00:00.000Z',
            model: 'glm-5.3',
            independent: true,
            judges: [
              {
                id: 'glm',
                label: '智谱 GLM-5.3',
                model: 'glm-5.3',
                external: true,
                score: 88,
                pass: true,
                notes: '规则清晰。',
                risks: [],
              },
              {
                id: 'qwen',
                label: '通义千问 Qwen3.8-Max',
                model: 'qwen3.8-max',
                external: true,
                score: 90,
                pass: true,
                notes: '可以启用。',
                risks: [],
              },
            ],
          },
        })}
        baseline={null}
        scope="workspace"
        busy={false}
        onExplain={() => {}}
      />,
    )
    expect(html).toContain('谁检查过')
    expect(html).toContain('2 个独立的模型')
    expect(html).toContain('智谱 GLM-5.3')
    expect(html).toContain('通义千问 Qwen3.8-Max')
  })

  it('says plainly when only the writing model checked itself', () => {
    const html = render(
      <ProfileDecision
        profile={profile({
          review: {
            score: 80,
            pass: true,
            notes: '看起来没问题。',
            risks: [],
            at: '2026-11-14T00:00:00.000Z',
            model: 'deepseek-chat',
            independent: false,
          },
        })}
        baseline={null}
        scope="workspace"
        busy={false}
        onExplain={() => {}}
      />,
    )
    expect(html).toContain('只有当前模型自己检查')
    expect(html).toContain('在设置的评估模型里选择另一个模型后才会真正独立')
  })

  it('keeps a reviewer that is not independent visible as weak evidence', () => {
    const html = render(
      <ProfileDecision
        profile={profile({
          review: {
            score: 80,
            pass: true,
            notes: 'ok',
            risks: [],
            at: '2026-11-14T00:00:00.000Z',
            model: 'deepseek-chat',
            independent: false,
            judges: [
              {
                id: 'glm',
                label: '智谱 GLM-5.3',
                model: 'glm-5.3',
                external: true,
                score: 84,
                pass: true,
                notes: 'ok',
                risks: [],
              },
              {
                id: 'glm-dup',
                label: '同一模型',
                model: 'deepseek-chat',
                external: false,
                score: 76,
                pass: true,
                notes: 'ok',
                risks: [],
              },
            ],
          },
        })}
        baseline={null}
        scope="workspace"
        busy={false}
        onExplain={() => {}}
      />,
    )
    expect(html).toContain('部分模型独立检查过')
    expect(html).toContain('decision-row-weak')
  })

  it('compares measured behaviour instead of claiming an improvement', () => {
    const runs: RunRecord[] = [
      run({ profileVersion: 13, status: 'completed', steps: 10 }),
      run({ profileVersion: 13, status: 'failed', steps: 40 }),
      run({ profileVersion: 13, status: 'completed', steps: 12 }),
    ]
    const html = render(
      <ProfileDecision
        profile={profile({ version: 14 })}
        baseline={profile({ id: 'p-13', version: 13, status: 'active' })}
        scope="workspace"
        busy={false}
        runs={runs}
        onExplain={() => {}}
      />,
    )
    expect(html).toContain('实测对比：现在用的 v13 和这一版 v14')
    // Two completed of three finished runs on the baseline, nothing on the draft.
    expect(html).toContain('67%')
    expect(html).toMatch(/新版还没真正跑过|还看不出谁更强|差别/)
  })

  it('shows added, rewritten and removed counts above the fold', () => {
    const baseline = profile({
      id: 'p-13',
      version: 13,
      status: 'active',
      promptAddendum: '1. 旧规则甲\n2. 旧规则乙',
    })
    const html = render(
      <ProfileDecision
        profile={profile({ promptAddendum: '1. 旧规则乙\n2. 新规则丙' })}
        baseline={baseline}
        scope="workspace"
        busy={false}
        onExplain={() => {}}
      />,
    )
    expect(html).toContain('相比正在使用的 v13')
    expect(html).toContain('新增 1 条 · 改写 0 条 · 删去 1 条')
  })

  it('prints the reviewer reason beside every deleted rule', () => {
    const baseline = profile({
      id: 'p-13',
      version: 13,
      status: 'active',
      promptAddendum: '1. 旧规则甲\n2. 旧规则乙',
    })
    const html = render(
      <ProfileRuleDiff
        profile={profile({
          promptAddendum: '1. 旧规则乙',
          review: {
            score: 88,
            pass: true,
            notes: 'ok',
            risks: [],
            at: '2026-11-14T00:00:00.000Z',
            model: 'reviewer',
            removals: [
              {
                rule: '旧规则甲',
                justified: true,
                reason: '与安全规则重复，已由工具层强制。',
                judges: ['智谱 GLM-5.3'],
              },
            ],
          },
        })}
        baseline={baseline}
      />,
    )
    expect(html).toContain('删去（1）')
    expect(html).toContain('评审理由：与安全规则重复，已由工具层强制。')
  })

  it('warns when a deleted rule has no reviewer reason', () => {
    const baseline = profile({
      id: 'p-13',
      version: 13,
      status: 'active',
      promptAddendum: '1. 旧规则甲\n2. 旧规则乙',
    })
    const html = render(
      <ProfileRuleDiff
        profile={profile({
          promptAddendum: '1. 旧规则乙',
          review: {
            score: 88,
            pass: true,
            notes: 'ok',
            risks: [],
            at: '2026-11-14T00:00:00.000Z',
            model: 'reviewer',
          },
        })}
        baseline={baseline}
      />,
    )
    expect(html).toContain('评审没有为这条删除给出可用理由')
  })

  it('offers to write an explanation when the store has none', () => {
    const html = render(
      <ProfileDecision
        profile={profile({ explanation: undefined })}
        baseline={null}
        scope="workspace"
        busy={false}
        onExplain={() => {}}
      />,
    )
    expect(html).toContain('这次改了什么还没翻译成日常说法')
    expect(html).toContain('用大白话解释这次改动')
  })
})
