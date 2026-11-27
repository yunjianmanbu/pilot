/**
 * 动效降级判定的唯一入口。
 *
 * CSS 侧的 `@media (prefers-reduced-motion: reduce)` 管不到 JS 里的
 * `scrollTo({ behavior: 'smooth' })`，所以这里补上 JS 侧的判定，并用假
 * `window` 覆盖「读不到 matchMedia」的降级路径（SSR / 老环境）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  REDUCED_MOTION_QUERY,
  motionScrollBehavior,
  prefersReducedMotion,
  scrollBehaviorNow,
} from '../src/renderer/src/a11y/reduced-motion'

const g = globalThis as { window?: unknown }

function fakeWindow(matches: boolean | null): void {
  g.window = {
    matchMedia: (query: string) => ({
      matches: query === REDUCED_MOTION_QUERY && matches === true,
      media: query,
    }),
  }
}

afterEach(() => {
  delete g.window
})

describe('prefersReducedMotion', () => {
  it('is false without a window (server render, plain node test)', () => {
    expect(prefersReducedMotion()).toBe(false)
  })

  it('is false when matchMedia is missing', () => {
    g.window = {}
    expect(prefersReducedMotion()).toBe(false)
  })

  it('reads the media query it is asked about', () => {
    fakeWindow(true)
    expect(prefersReducedMotion()).toBe(true)
    fakeWindow(false)
    expect(prefersReducedMotion()).toBe(false)
  })
})

describe('scroll behaviour', () => {
  it('downgrades smooth scrolling to a jump', () => {
    expect(motionScrollBehavior(true)).toBe('auto')
    expect(motionScrollBehavior(false)).toBe('smooth')
  })

  it('scrollBehaviorNow follows the live preference', () => {
    fakeWindow(true)
    expect(scrollBehaviorNow()).toBe('auto')
    fakeWindow(false)
    expect(scrollBehaviorNow()).toBe('smooth')
  })

  it('keeps the platform query string in one place', () => {
    expect(REDUCED_MOTION_QUERY).toBe('(prefers-reduced-motion: reduce)')
  })
})
