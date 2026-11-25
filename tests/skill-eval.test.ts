import { describe, expect, it } from 'vitest'
import { evaluateSkill, formatSkillEval } from '../src/main/agent/skill-eval'

const GOOD_BODY = [
  '## 什么时候用',
  '渲染层改了可见 UI 之后需要亲眼确认。',
  '',
  '## 步骤',
  '1. 用 `start_process` 启动应用，等 ready 信号。',
  '2. 用 `screenshot` 抓窗口，确认改动可见。',
  '3. 出现回归时先看 `app_control` 的 console 输出。',
  '',
  '## 验证',
  '截图里能看到目标元素，且 console 没有报错，才算做完。',
  '',
  '## 边界',
  '不要用它验证原生对话框；这类窗口截图抓不到。',
].join('\n')

function good() {
  return {
    name: 'visual-check',
    description: '启动应用并截图确认界面改动实际可见，而不是只看代码。',
    whenToUse: '当需要证明一次前端改动在界面上真的生效时。',
    body: GOOD_BODY,
    resources: [],
  }
}

describe('evaluateSkill', () => {
  it('scores a complete skill as usable with no suggestions', () => {
    const report = evaluateSkill(good())
    expect(report.score).toBe(100)
    expect(report.verdict).toBe('usable')
    expect(report.suggestions).toEqual([])
    expect(report.checks.every((check) => check.level === 'ok')).toBe(true)
  })

  it('penalises a missing trigger and missing verification separately', () => {
    const report = evaluateSkill({ ...good(), whenToUse: undefined, body: '1. 跑一下\n\n随便看看。' })
    const ids = report.checks.filter((check) => check.level !== 'ok').map((check) => check.id)
    expect(ids).toContain('when-to-use')
    expect(ids).toContain('verification')
    expect(report.verdict).toBe('needs-work')
  })

  it('treats a non-conforming name, empty body and long description as errors', () => {
    const report = evaluateSkill({
      name: 'bad name!',
      description: 'x'.repeat(400),
      whenToUse: '当需要证明某件事时。',
      body: '   ',
    })
    const errors = report.checks.filter((check) => check.level === 'error').map((check) => check.id)
    expect(errors).toEqual(expect.arrayContaining(['name', 'description', 'body']))
    expect(report.score).toBeLessThanOrEqual(50)
    expect(report.verdict).toBe('needs-work')
  })

  it('flags a description that is just the skill name', () => {
    const report = evaluateSkill({ ...good(), description: 'visual-check' })
    expect(report.checks.find((check) => check.id === 'description')?.level).toBe('warn')
  })

  it('asks for resource files when a long body is one blob', () => {
    const body = `${GOOD_BODY}\n${'细节说明凑长度。\n'.repeat(900)}`
    expect(body.length).toBeGreaterThan(8000)
    const report = evaluateSkill({ ...good(), body })
    expect(report.checks.find((check) => check.id === 'resources')?.level).toBe('warn')
    const withFile = evaluateSkill({ ...good(), body, resources: ['checklist.md'] })
    expect(withFile.checks.find((check) => check.id === 'resources')?.level).toBe('ok')
  })

  it('reports a suspected secret by line number and never echoes its value', () => {
    const fence = '`'.repeat(3)
    const fakeSecret = ['sk', 'live', 'abcdef123456'].join('-')
    const body = [GOOD_BODY, '', fence, `api_key = ${fakeSecret}`, fence, ''].join('\n')
    const report = evaluateSkill({ ...good(), body })
    const secret = report.checks.find((check) => check.id === 'secrets')
    expect(secret?.level).toBe('error')
    expect(JSON.stringify(report)).not.toContain(fakeSecret)
    expect(secret?.detail).toContain('行')
  })

  it('ignores the frontmatter when the raw SKILL.md is passed in', () => {
    const source = ['---', 'name: x', 'description: y', '---', '', '## 步骤', '1. 做一件事', '2. 验证一下', ''].join('\n')
    const report = evaluateSkill(
      { name: 'x', description: 'y', whenToUse: undefined, body: '' },
      source,
    )
    const bodyCheck = report.checks.find((check) => check.id === 'body')
    expect(bodyCheck?.level).toBe('warn')
    expect(bodyCheck?.detail).toContain('字符')
  })
})

describe('formatSkillEval', () => {
  it('prints the score plus at most three suggestions', () => {
    const report = evaluateSkill({
      name: 'rough',
      description: '生成东西',
      whenToUse: undefined,
      body: '随便写写。',
    })
    const text = formatSkillEval(report)
    expect(text).toContain(`${report.score}/100`)
    expect(text.split('\n').filter((line) => line.startsWith('- ')).length).toBeLessThanOrEqual(4)
  })

  it('says nothing extra when the skill is clean', () => {
    expect(formatSkillEval(evaluateSkill(good()))).toBe('技能自检 100/100（可用）')
  })
})
