import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Contrast guard for the desktop palette.
 *
 * The stylesheet cascades `:root` (dark) → `[data-theme='light']` →
 * `[data-accent='<name>']` → `[data-theme='light'][data-accent='<name>']`, so a
 * theme is the merge of those blocks in that order. This test rebuilds the
 * merge for every palette and checks text tokens against every surface they
 * can land on.
 *
 * Hover surfaces (`--panel-hover`, `--sidebar-hover`, `--sidebar-field-hover`)
 * are excluded: they only colour interactive rows for the duration of a hover,
 * and holding them to 4.5:1 would leave no room between `--faint` and `--muted`.
 * Gradients, rings and glows are not text and are not checked either.
 */
const CSS = readFileSync(
  fileURLToPath(new URL('../src/renderer/src/styles.css', import.meta.url)),
  'utf8',
)

type Variables = Record<string, string>

/** Collect the custom properties of every top-level rule block. */
function blocks(css: string): Map<string, Variables> {
  const found = new Map<string, Variables>()
  // Comments are stripped first: `[^{}]*` spans newlines, so without this the
  // doc comment above `:root` would be glued onto the selector.
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const pattern = /(?:^|\n)[ \t]*([^@\n{}][^\n{}]*)\{([^}]*)\}/g
  for (const match of source.matchAll(pattern)) {
    const selector = (match[1] ?? '').trim()
    const body = match[2] ?? ''
    const vars: Variables = {}
    for (const declaration of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
      vars[declaration[1] ?? ''] = (declaration[2] ?? '').trim()
    }
    if (Object.keys(vars).length > 0) found.set(selector, vars)
  }
  return found
}

const rules = blocks(CSS)

function rule(selector: string): Variables {
  const vars = rules.get(selector)
  if (!vars) throw new Error(`styles.css 里找不到选择器 ${selector}`)
  return vars
}

const ACCENTS = [
  'graphite',
  'pine',
  'indigo',
  'clay',
  'ocean',
  'moss',
  'plum',
  'rose',
  'sand',
  'orange',
  'celadon',
  'claude',
]

/** Palette for one (mode, accent) pair, merged in cascade order. */
function palette(mode: 'dark' | 'light', accent: string): Variables {
  const merged: Variables = { ...rule(':root') }
  if (mode === 'light') Object.assign(merged, rule(":root[data-theme='light']"))
  const darkAccent = rules.get(`:root[data-accent='${accent}']`)
  if (darkAccent) Object.assign(merged, darkAccent)
  if (mode === 'light') {
    const lightAccent = rules.get(`:root[data-theme='light'][data-accent='${accent}']`)
    if (lightAccent) Object.assign(merged, lightAccent)
  }
  return merged
}

/** `#rgb` or `#rrggbb` to channels. Alpha and `color-mix()` are rejected. */
function channels(value: string): [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(value.trim()) ?? /^#([0-9a-f]{3})$/i.exec(value.trim())
  if (!match) throw new Error(`不是纯色值：${value}`)
  const digits = match[1] ?? ''
  const full =
    digits.length === 3
      ? [...digits].map((c) => c + c).join('')
      : digits
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ]
}

function luminance(value: string): number {
  const [r, g, b] = channels(value).map((channel) => {
    const c = channel / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrast(foreground: string, background: string): number {
  const a = luminance(foreground)
  const b = luminance(background)
  const [light, dark] = a > b ? [a, b] : [b, a]
  return (light + 0.05) / (dark + 0.05)
}

const SURFACES = [
  '--bg',
  '--page',
  '--bg-elev',
  '--panel',
  '--panel-2',
  '--panel-3',
  '--surface',
]

/** Minimum ratio per text token; `--text` is body copy and gets more room. */
const TEXT_TOKENS: Array<{ token: string; min: number }> = [
  { token: '--text', min: 7 },
  { token: '--text-soft', min: 4.5 },
  { token: '--muted', min: 4.5 },
  { token: '--faint', min: 4.5 },
]

describe('desktop palette contrast', () => {
  for (const mode of ['dark', 'light'] as const) {
    for (const accent of ACCENTS) {
      it(`${mode} / ${accent} keeps text readable on every surface`, () => {
        const vars = palette(mode, accent)
        const failures: string[] = []
        for (const { token, min } of TEXT_TOKENS) {
          const foreground = vars[token]
          if (!foreground) throw new Error(`${mode}/${accent} 缺少 ${token}`)
          for (const surface of SURFACES) {
            const background = vars[surface]
            if (!background) throw new Error(`${mode}/${accent} 缺少 ${surface}`)
            const ratio = contrast(foreground, background)
            if (ratio < min) {
              failures.push(
                `${token} ${foreground} on ${surface} ${background} = ${ratio.toFixed(2)}:1 (需要 ${min}:1)`,
              )
            }
          }
        }
        expect(failures, `\n${failures.join('\n')}\n`).toEqual([])
      })
    }
  }
})

/** Alpha of an `rgba(...)` value; `0.06` in `rgba(255, 255, 255, 0.06)`. */
function alpha(value: string): number {
  const match = /rgba?\([^)]*?([01]?\.?\d+)\s*\)/.exec(value.trim())
  if (!match) throw new Error(`不是带透明度的颜色：${value}`)
  const parsed = Number(match[1])
  if (!Number.isFinite(parsed) || parsed > 1) throw new Error(`透明度解析失败：${value}`)
  return parsed
}

/** Largest per-channel difference of two `#rrggbb` colors, on a 0-255 scale. */
function channelDistance(left: string, right: string): number {
  const a = channels(left)
  const b = channels(right)
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]))
}

/**
 * Layering guard for the three background tiers.
 *
 * `--page` is the canvas the app paints first, `--surface` is anything that
 * floats above the cards (modal, drawer, toast, menu) and `--hover` is the
 * translucent wash interactive rows get. If a later edit flattens any tier the
 * UI still renders, it just stops being legible as a hierarchy, which is why
 * this is asserted instead of eyeballed.
 */
describe('desktop background tiers', () => {
  const REQUIRED = [
    '--page',
    '--surface',
    '--surface-border',
    '--float-shadow',
    '--scrim',
    '--hover',
    '--hover-strong',
  ]

  for (const mode of ['dark', 'light'] as const) {
    for (const accent of ACCENTS) {
      it(`${mode} / ${accent} defines every background tier`, () => {
        const vars = palette(mode, accent)
        const missing = REQUIRED.filter((token) => !vars[token])
        expect(missing, `${mode}/${accent} 缺少 ${missing.join('、')}`).toEqual([])
      })

      it(`${mode} / ${accent} separates page, card and floating surface`, () => {
        const vars = palette(mode, accent)
        // 用通道差（0-255）而不是感知亮度：这几档色值都挤在近黑/近白端，
        // 线性亮度会把 #0d0d0d 与 #131313 的差别抹成 0.00x，断言失去意义。
        const page = channelDistance(vars['--page'] as string, vars['--panel'] as string)
        const floatFromPage = channelDistance(vars['--surface'] as string, vars['--page'] as string)
        const floatFromCard = channelDistance(
          vars['--surface'] as string,
          vars['--panel-2'] as string,
        )

        // 页面底色不能和卡片同色：浅色下就是白卡压白底，卡片整个消失。
        // 深色端要求更宽：近黑背景里 6 级通道差肉眼几乎分不出层级。
        const layerMin = mode === 'dark' ? 14 : 6
        expect(page, `${mode}/${accent} 的 --page 与 --panel 太接近（${vars['--page']}）`)
          .toBeGreaterThanOrEqual(layerMin)
        // 弹窗必须能从画布里跳出来，否则只靠阴影在浅色下几乎看不见。
        expect(
          floatFromPage,
          `${mode}/${accent} 的 --surface 与 --page 太接近，弹窗没有边界`,
        ).toBeGreaterThanOrEqual(layerMin)
        // 弹窗内部的输入框/行不能和弹窗同色，否则没有层次。
        expect(
          floatFromCard,
          `${mode}/${accent} 的 --surface 与 --panel-2 同色，弹窗内部没有层次`,
        ).toBeGreaterThanOrEqual(2)

        // 卡片、面板和按钮不再画边线，层级只靠底色差；边框 token 保持透明，
        // 输入框的焦点环仍由 accent 单独绘制。
        for (const token of ['--border', '--border-strong', '--surface-border']) {
          expect(
            vars[token],
            `${mode}/${accent} 的 ${token} 应保持透明，卡片和按钮改用色差分层`,
          ).toBe('transparent')
        }
      })

      it(`${mode} / ${accent} keeps hover subtle but visible`, () => {
        const vars = palette(mode, accent)
        const base = alpha(vars['--hover'] as string)
        const strong = alpha(vars['--hover-strong'] as string)
        expect(base, `${mode}/${accent} --hover 太淡`).toBeGreaterThanOrEqual(0.03)
        expect(base, `${mode}/${accent} --hover 太重`).toBeLessThanOrEqual(0.1)
        expect(strong, `${mode}/${accent} --hover-strong 需要比 --hover 明显`).toBeGreaterThan(
          base,
        )
        expect(strong, `${mode}/${accent} --hover-strong 太重`).toBeLessThanOrEqual(0.14)
      })
    }
  }
})
