/**
 * 样式层的无障碍守护。
 *
 * 两件事靠 CSS 完成，而且都会悄悄回退，所以放进测试：
 *
 * 1. `.sr-only` 必须是「视觉隐藏但仍在可访问性树里」。写成 `display: none` 或
 *    `visibility: hidden` 时，live region 就彻底哑了，界面上却看不出任何异样。
 * 2. 每个 `animation: … infinite` 的宿主都必须在「减少动效」块里被显式停掉。
 *    只靠 `animation-duration: 0.001ms` 会把动画瞬间跑完并停在最后一帧：旋转环
 *    停在 360°、呼吸点停在某个偏移，看起来像卡死。新增一个循环动画而忘了登记，
 *    只有用户开了系统开关才会看到，所以这里逐条比对源码。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const CSS_PATH = path.join(__dirname, '..', 'src', 'renderer', 'src', 'styles.css')
const css = fs.readFileSync(CSS_PATH, 'utf8')
const REDUCED_MOTION_HEADER = '@media (prefers-reduced-motion: reduce)'

interface Rule {
  /** 逗号分隔后的选择器集合，已去掉首尾与重复空白。 */
  selectors: string[]
  body: string
  /** 规则所在的 at-rule 链（顶层为空串），用来区分「媒体查询里的」与顶层的。 */
  atRule: string
}

/**
 * 极简 CSS 规则扫描：按大括号配对，取出每条 `selector { body }` 与它所在的 at-rule。
 *
 * 注释先剥掉：注释里出现的 `animation: … infinite` 不是规则。`@keyframes` 里的
 * `from` / `to` 也会被当成一条规则收进来，但它们的 body 不含 `animation`，
 * 对下面的断言没有影响。
 */
function parseRules(source: string): Rule[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules: Rule[] = []
  const stack: { selector: string; atRule: string; body: string }[] = [
    { selector: '', atRule: '', body: '' },
  ]

  for (const ch of text) {
    const top = stack[stack.length - 1] as { selector: string; atRule: string; body: string }
    if (ch === '{') {
      const head = top.body.trim()
      top.body = ''
      const isAtRule = head.startsWith('@')
      const atRule = isAtRule ? `${top.atRule} ${head}`.trim() : top.atRule
      stack.push({ selector: isAtRule ? '' : head, atRule, body: '' })
    } else if (ch === '}') {
      const frame = stack.pop()
      if (!frame) continue
      if (frame.selector) {
        rules.push({
          selectors: frame.selector
            .split(',')
            .map((part) => part.replace(/\s+/g, ' ').trim())
            .filter(Boolean),
          body: frame.body.trim(),
          atRule: frame.atRule,
        })
      }
      const parent = stack[stack.length - 1]
      if (parent) parent.body = ''
    } else {
      top.body += ch
    }
  }
  return rules
}

const allRules = parseRules(css)
const topLevel = allRules.filter((rule) => rule.atRule === '')
const inReducedMotion = allRules.filter((rule) => rule.atRule.includes(REDUCED_MOTION_HEADER))

/** 顶层规则里带 `animation: … infinite` 的选择器。 */
const loopingSelectors = (() => {
  const found = new Set<string>()
  for (const rule of topLevel) {
    if (!/animation\s*:[^;}]*infinite/.test(rule.body)) continue
    for (const selector of rule.selectors) found.add(selector)
  }
  return [...found].sort()
})()

describe('@media (prefers-reduced-motion: reduce)', () => {
  it('parses both sides at all (otherwise every assertion below is vacuous)', () => {
    expect(inReducedMotion.length).toBeGreaterThan(5)
    expect(loopingSelectors.length).toBeGreaterThan(5)
  })

  it('stops every looping animation explicitly', () => {
    const stopped = new Set<string>()
    for (const rule of inReducedMotion) {
      if (!/animation\s*:\s*none/.test(rule.body)) continue
      for (const selector of rule.selectors) stopped.add(selector)
    }
    expect(loopingSelectors.filter((selector) => !stopped.has(selector))).toEqual([])
  })

  it('kills transitions and delays globally', () => {
    const universal = inReducedMotion.find((rule) => rule.selectors.includes('*'))
    expect(universal?.body).toContain('animation-duration: 0.001ms !important')
    expect(universal?.body).toContain('transition-duration: 0.001ms !important')
  })

  it('turns off smooth document scrolling', () => {
    const html = inReducedMotion.find((rule) => rule.selectors.includes('html'))
    expect(html?.body).toContain('scroll-behavior: auto')
  })
})

describe('.sr-only', () => {
  const rule = allRules.find((candidate) => candidate.selectors.includes('.sr-only'))

  it('exists and stays in the accessibility tree', () => {
    expect(rule).toBeDefined()
    expect(rule?.body).not.toContain('display: none')
    expect(rule?.body).not.toContain('visibility: hidden')
    expect(rule?.body).toContain('position: absolute')
    expect(rule?.body).toContain('clip-path: inset(50%)')
  })

  it('is out of flow so it cannot shift the scroll height', () => {
    expect(rule?.body).toContain('width: 1px')
    expect(rule?.body).toContain('overflow: hidden')
  })
})
