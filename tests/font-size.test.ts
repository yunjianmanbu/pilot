import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isFontSizePreference } from '../src/shared/theme'

const CSS = readFileSync(
  fileURLToPath(new URL('../src/renderer/src/styles.css', import.meta.url)),
  'utf8',
)

describe('字号设置', () => {
  it('只接受三档，未知值回落到标准', () => {
    expect(isFontSizePreference('standard')).toBe(true)
    expect(isFontSizePreference('large')).toBe(true)
    expect(isFontSizePreference('xlarge')).toBe(true)
    expect(isFontSizePreference('huge')).toBe(false)
    expect(isFontSizePreference(undefined)).toBe(false)
  })

  it('标准保持原字号，大和特大只改乘数', () => {
    expect(CSS).toMatch(/--font-scale:\s*1;/)
    expect(CSS).toMatch(/:root\[data-font-size='large'\]\s*{\s*--font-scale:\s*1\.12;/)
    expect(CSS).toMatch(/:root\[data-font-size='xlarge'\]\s*{\s*--font-scale:\s*1\.25;/)
  })

  it('所有字体大小都乘 --font-scale，没有漏掉的字号', () => {
    // em / inherit / var() 会从父级或 token 继承，不需要再乘一次。
    const plain = CSS.match(/font-size:\s*[0-9.]+(?:px|rpx)/g) ?? []
    expect(plain).toEqual([])
    const scaled = CSS.match(/font-size:\s*calc\([^;]*var\(--font-scale\)/g) ?? []
    expect(scaled.length).toBeGreaterThan(400)
  })
})
