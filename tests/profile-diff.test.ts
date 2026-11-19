import { describe, expect, it } from 'vitest'
import {
  describeStrategyChanges,
  diffAddendum,
  fallbackExplanation,
  splitRules,
} from '../src/shared/profile-diff'

const BEFORE = [
  '1. 根目录读取失败时，先列出目录再定位子项目。',
  '2. 每次改动后运行最相关的测试，再报告结果。',
  '3. 纯分析类请求不要修改文件。',
].join('\n')

describe('splitRules', () => {
  it('splits numbered, dashed and bullet rules', () => {
    expect(splitRules('1. a\n2) b\n- c\n* d\n• e')).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('splits rules that share one line', () => {
    expect(splitRules('1. first 2. second 3. third')).toEqual(['first', 'second', 'third'])
  })

  it('drops duplicates and blank input', () => {
    expect(splitRules('1. same\n2. same')).toEqual(['same'])
    expect(splitRules('')).toEqual([])
    expect(splitRules('   ')).toEqual([])
  })
})

describe('diffAddendum', () => {
  it('reports nothing when the rule text is identical', () => {
    const diff = diffAddendum(BEFORE, BEFORE)
    expect(diff.unchanged).toBe(true)
    expect(diff.added).toHaveLength(0)
    expect(diff.removed).toHaveLength(0)
    expect(diff.changed).toHaveLength(0)
    expect(diff.kept).toHaveLength(3)
  })

  it('marks a new rule as added without touching the kept ones', () => {
    const diff = diffAddendum(BEFORE, `${BEFORE}\n4. 大改动分三批推进，每批验证一次。`)
    expect(diff.added).toEqual(['大改动分三批推进，每批验证一次。'])
    expect(diff.removed).toHaveLength(0)
    expect(diff.kept).toHaveLength(3)
    expect(diff.unchanged).toBe(false)
  })

  it('marks a deleted rule as removed', () => {
    const after = BEFORE.split('\n').slice(0, 2).join('\n')
    const diff = diffAddendum(BEFORE, after)
    expect(diff.removed).toEqual(['纯分析类请求不要修改文件。'])
    expect(diff.added).toHaveLength(0)
    expect(diff.kept).toHaveLength(2)
  })

  it('pairs a rewritten rule instead of reporting add plus remove', () => {
    const after = BEFORE.replace(
      '每次改动后运行最相关的测试，再报告结果。',
      '每次改动后运行最相关的测试，再报告结果与未验证项。',
    )
    const diff = diffAddendum(BEFORE, after)
    expect(diff.changed).toHaveLength(1)
    expect(diff.changed[0]?.after).toContain('未验证项')
    expect(diff.added).toHaveLength(0)
    expect(diff.removed).toHaveLength(0)
  })

  it('treats an unrelated rule as a replacement, not a rewrite', () => {
    const diff = diffAddendum('1. 提交前跑测试。', '1. 打包用 pnpm build 并检查产物体积。')
    expect(diff.changed).toHaveLength(0)
    expect(diff.added).toHaveLength(1)
    expect(diff.removed).toHaveLength(1)
  })

  it('does not mistake a reorder for a rewrite', () => {
    const after = BEFORE.split('\n').reverse().join('\n')
    const diff = diffAddendum(BEFORE, after)
    expect(diff.added).toHaveLength(0)
    expect(diff.removed).toHaveLength(0)
    expect(diff.changed).toHaveLength(0)
    expect(diff.kept).toHaveLength(3)
    expect(diff.unchanged).toBe(true)
  })
})

describe('describeStrategyChanges', () => {
  it('explains only the settings that changed', () => {
    const changes = describeStrategyChanges({ maxSteps: 200, temperature: 0.2 }, { maxSteps: 300, temperature: 0.2 })
    expect(changes).toHaveLength(1)
    expect(changes[0]?.field).toBe('maxSteps')
    expect(changes[0]?.from).toBe('200')
    expect(changes[0]?.to).toBe('300')
    expect(changes[0]?.plain).toContain('步')
  })

  it('describes an unset value as the default', () => {
    const changes = describeStrategyChanges(undefined, { temperature: 0.3 })
    expect(changes).toHaveLength(1)
    expect(changes[0]?.from).toBe('默认')
    expect(changes[0]?.to).toBe('0.3')
  })

  it('returns nothing when both sides match', () => {
    expect(describeStrategyChanges({ maxSteps: 200 }, { maxSteps: 200 })).toEqual([])
    expect(describeStrategyChanges(undefined, undefined)).toEqual([])
  })
})

describe('fallbackExplanation', () => {
  const diff = diffAddendum(BEFORE, `${BEFORE}\n4. 大改动分三批推进。`)

  it('counts what changed and never recommends enabling', () => {
    const explanation = fallbackExplanation(
      { evidence: { runs: 12, failures: 7 } },
      9,
      diff,
      [],
    )
    expect(explanation.headline).toContain('相对正在使用的 v9')
    expect(explanation.headline).toContain('新增 1 条')
    expect(explanation.changes[0]).toContain('大改动分三批推进')
    expect(explanation.recommend).toBe('observe')
    expect(explanation.risks.length).toBeGreaterThan(0)
    expect(explanation.model).toBeUndefined()
  })

  it('passes reviewer risks through when they exist', () => {
    const explanation = fallbackExplanation(
      { review: { pass: false, risks: ['第 3 条会把凭据带进上下文'] } },
      undefined,
      diff,
      [],
    )
    expect(explanation.risks).toEqual(['第 3 条会把凭据带进上下文'])
    expect(explanation.headline).toContain('相对 Pilot 的初始设置')
  })

  it('says so when nothing moved', () => {
    const explanation = fallbackExplanation({}, 4, diffAddendum(BEFORE, BEFORE), [])
    expect(explanation.headline).toContain('没有改变任何规则')
    expect(explanation.changes).toHaveLength(0)
  })
})
