import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Contrast guard for the browser console's dark palette.
 *
 * The companion is plain CSS (no accent presets), but it shares the same
 * near-black layering problem as the desktop app: once the panel ladder is
 * flattened, cards and muted text disappear. Keep every text tier readable on
 * every surface it can land on.
 */
const CSS = readFileSync(
  fileURLToPath(new URL('../companion/style.css', import.meta.url)),
  'utf8',
)

function darkVars(): Record<string, string> {
  const start = CSS.indexOf(':root {')
  if (start < 0) throw new Error('companion/style.css 里找不到 :root')
  const open = CSS.indexOf('{', start)
  let depth = 0
  let end = -1
  for (let index = open; index < CSS.length; index += 1) {
    if (CSS[index] === '{') depth += 1
    else if (CSS[index] === '}') {
      depth -= 1
      if (depth === 0) {
        end = index
        break
      }
    }
  }
  if (end < 0) throw new Error('companion/style.css 的 :root 没有闭合')
  const vars: Record<string, string> = {}
  for (const match of CSS.slice(open, end).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    vars[match[1] ?? ''] = (match[2] ?? '').trim()
  }
  return vars
}

function channels(value: string): [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(value.trim())
  if (!match) throw new Error(`不是纯色值：${value}`)
  const digits = match[1] ?? ''
  return [
    parseInt(digits.slice(0, 2), 16),
    parseInt(digits.slice(2, 4), 16),
    parseInt(digits.slice(4, 6), 16),
  ]
}

function luminance(value: string): number {
  const [r, g, b] = channels(value).map((channel) => {
    const c = channel / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(foreground: string, background: string): number {
  const a = luminance(foreground)
  const b = luminance(background)
  const [light, dark] = a > b ? [a, b] : [b, a]
  return (light + 0.05) / (dark + 0.05)
}

function channelDistance(left: string, right: string): number {
  const a = channels(left)
  const b = channels(right)
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]))
}

describe('companion dark palette', () => {
  const vars = darkVars()
  const surfaces = ['--bg', '--panel', '--panel-2', '--panel-3']
  const tokens = ['--text', '--text-soft', '--muted', '--faint']

  it('keeps every text tier readable on every surface', () => {
    const failures: string[] = []
    for (const token of tokens) {
      const foreground = vars[token]
      if (!foreground) throw new Error(`缺少 ${token}`)
      for (const surface of surfaces) {
        const background = vars[surface]
        if (!background) throw new Error(`缺少 ${surface}`)
        const ratio = contrast(foreground, background)
        if (ratio < 4.5) {
          failures.push(
            `${token} ${foreground} on ${surface} ${background} = ${ratio.toFixed(2)}:1 (需要 4.5:1)`,
          )
        }
      }
    }
    expect(failures, `\n${failures.join('\n')}\n`).toEqual([])
  })

  it('separates page, card and deepest card', () => {
    expect(channelDistance(vars['--panel'] as string, vars['--bg'] as string)).toBeGreaterThanOrEqual(10)
    expect(
      channelDistance(vars['--panel-3'] as string, vars['--panel'] as string),
    ).toBeGreaterThanOrEqual(10)
  })
})
