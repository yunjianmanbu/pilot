import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BenchmarkCard } from '../src/renderer/src/components/EvolutionPanel'
import type { ProfileComparison } from '../src/shared/types'

/**
 * The measured comparison is the answer to "is the new version actually
 * better". These tests render the real card so they check the copy a user sees,
 * including the numbers and the reviewer attribution, not the props passed in.
 */

function comparison(overrides: Partial<ProfileComparison> = {}): ProfileComparison {
  return {
    verdict: 'better',
    tasks: 3,
    wins: 2,
    losses: 0,
    ties: 1,
    current: { successRate: 0.667, avgSteps: 7, avgTokens: 1_200 },
    candidate: { successRate: 1, avgSteps: 5, avgTokens: 900 },
    reasons: ['候选版本在 2 个任务上更好，0 个更差。'],
    at: '2026-11-14T00:00:00.000Z',
    ...overrides,
  }
}

describe('benchmark comparison card', () => {
  it('shows both versions side by side with the win count', () => {
    const html = renderToStaticMarkup(<BenchmarkCard comparison={comparison()} />)
    expect(html).toContain('实测更优')
    expect(html).toContain('67%')
    expect(html).toContain('100%')
    expect(html).toContain('候选 2 胜 / 0 负 / 1 平')
    expect(html).toContain('benchmark-pass')
    // One row per measurement, and the reason the verdict was reached.
    expect(html).toContain('任务通过率')
    expect(html).toContain('平均步数')
    expect(html).toContain('候选版本在 2 个任务上更好')
  })

  it('marks a regression as a failure state instead of hiding it', () => {
    const html = renderToStaticMarkup(
      <BenchmarkCard comparison={comparison({ verdict: 'worse', wins: 0, losses: 2 })} />,
    )
    expect(html).toContain('实测更差')
    expect(html).toContain('benchmark-fail')
  })

  it('does not claim a win when the sample cannot decide', () => {
    const html = renderToStaticMarkup(
      <BenchmarkCard comparison={comparison({ verdict: 'insufficient', tasks: 2 })} />,
    )
    expect(html).toContain('样本不足')
    expect(html).not.toContain('实测更优')
  })

  it('names the third-party reviewers and reports a silent one', () => {
    const html = renderToStaticMarkup(
      <BenchmarkCard
        comparison={comparison({
          judges: ['qwen/qwen-plus', 'glm/glm-4-plus'],
          judgeErrors: ['glm/glm-4-plus: 超过 120 秒未响应'],
          current: { successRate: 0.667, avgSteps: 7, avgTokens: 1_200, avgJudgeScore: 62 },
          candidate: { successRate: 1, avgSteps: 5, avgTokens: 900, avgJudgeScore: 88 },
        })}
      />,
    )
    expect(html).toContain('第三方评分')
    expect(html).toContain('62')
    expect(html).toContain('88')
    expect(html).toContain('qwen/qwen-plus')
    expect(html).toContain('没有给出评分')
  })

  it('warns that the numbers describe a pair that is no longer in force', () => {
    const html = renderToStaticMarkup(<BenchmarkCard comparison={comparison()} stale />)
    expect(html).toContain('当前生效版本已经变了')
    // The numbers stay visible so the user can still see what was measured.
    expect(html).toContain('候选 2 胜 / 0 负 / 1 平')
  })
})
