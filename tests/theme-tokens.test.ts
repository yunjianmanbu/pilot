import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Token hygiene for the desktop stylesheet.
 *
 * `var(--name, <fallback>)` hides a missing token: the property still renders,
 * just with a hardcoded colour that ignores palette, light mode, contrast and
 * saturation. That is exactly how the status badges used to ship Tailwind's
 * saturated greens and oranges in every theme. These tests fail when a token is
 * referenced without being defined, or when a status token reintroduces a
 * literal fallback.
 */
const CSS = readFileSync(
  fileURLToPath(new URL('../src/renderer/src/styles.css', import.meta.url)),
  'utf8',
)

const DEFINED = new Set(
  [...CSS.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((match) => match[1] as string),
)

const USED = [...CSS.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)].map((match) => match[1] as string)

type Variables = Record<string, string>

function block(selector: string): Variables {
  const body = ruleBody(selector)
  const vars: Variables = {}
  for (const match of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    vars[match[1] as string] = (match[2] as string).trim()
  }
  return vars
}

/** Raw declaration body of one rule, for assertions that are not about tokens. */
function ruleBody(selector: string): string {
  const start = CSS.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`styles.css 里找不到选择器 ${selector}`)
  const open = CSS.indexOf('{', start)
  let depth = 0
  for (let index = open; index < CSS.length; index += 1) {
    if (CSS[index] === '{') depth += 1
    else if (CSS[index] === '}') {
      depth -= 1
      if (depth === 0) return CSS.slice(open + 1, index)
    }
  }
  throw new Error(`选择器 ${selector} 的样式块没有闭合`)
}

function channels(value: string): [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(value.trim())
  if (!match) throw new Error(`不是纯色值：${value}`)
  const digits = match[1] as string
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

function ratio(foreground: string, background: string): number {
  const a = luminance(foreground)
  const b = luminance(background)
  const [light, dark] = a > b ? [a, b] : [b, a]
  return (light + 0.05) / (dark + 0.05)
}

/** 引用时必须已经定义的 token；新增状态色、行色、语法色都靠这条守。 */
const ALIAS_TOKENS = [
  '--ok',
  '--warn',
  '--bad',
  '--font-mono',
  '--syn-comment',
  '--syn-string',
  '--syn-number',
  '--syn-keyword',
  '--syn-function',
]

/** 带字面值的 token 必须两种模式各定一次，否则浅色会继承深色的白线。 */
const PER_MODE_TOKENS = ['--line', '--line-strong']

describe('stylesheet tokens', () => {
  it('never references an undefined custom property', () => {
    const missing = [...new Set(USED.filter((name) => !DEFINED.has(name)))].sort()
    expect(missing, `未定义的 token：${missing.join('、')}`).toEqual([])
  })

  it('defines every status, line and syntax token', () => {
    const dark = block(':root')
    const light = block(":root[data-theme='light']")
    // 别名型 token 只在 :root 定义一次，浅色靠继承拿到重新定义过的
    // --green/--amber/--red，所以不必（也不应该）写两遍。
    for (const token of ALIAS_TOKENS) {
      expect(dark[token], `浅色缺少 ${token}`).toBeTruthy()
    }
    for (const token of PER_MODE_TOKENS) {
      expect(dark[token], `深色缺少 ${token}`).toBeTruthy()
      expect(light[token], `浅色缺少 ${token}`).toBeTruthy()
    }
  })

  it('points status tokens at the real function colours instead of literals', () => {
    const dark = block(':root')
    // 别把写死的 hex 塞回来：值只在 --green/--amber/--red 上定义一次。
    expect(dark['--ok']).toBe('var(--green)')
    expect(dark['--warn']).toBe('var(--amber)')
    expect(dark['--bad']).toBe('var(--red)')
  })

  it('keeps the separator line visible in both modes', () => {
    // --border 从设计上就是透明（卡片改用色阶分层），分隔线必须走 --line；
    // 这两档任何一边掉成 transparent，hr、表格行、顶栏分隔线就全消失了。
    for (const selector of [':root', ":root[data-theme='light']"]) {
      const vars = block(selector)
      for (const token of ['--line', '--line-strong']) {
        expect(vars[token], `${selector} 的 ${token} 不能透明`).not.toBe('transparent')
        expect(vars[token], `${selector} 的 ${token} 不能为空`).toBeTruthy()
      }
    }
  })

  it('draws separators with --line instead of the always-transparent --border', () => {
    // --border 在所有调色板里都是 transparent（卡片靠色阶分层，不靠描边），
    // 所以「只画一边的边框」和虚线占位框一旦用 --border，就等于什么都不画：
    // 顶栏底线、页头、表格行、抽屉页脚、空态虚线框会整段消失。分隔线走 --line。
    const offenders = [
      ...CSS.matchAll(
        /border-(?:top|bottom|left|right)\s*:\s*[\d.]+px\s+(?:[a-z]+\s+)?solid\s+var\(\s*--border\s*\)/gi,
      ),
      ...CSS.matchAll(/border\s*:\s*[\d.]+px\s+(?:dashed|dotted)\s+var\(\s*--border\s*\)/gi),
    ].map((match) => match[0].replace(/\s+/g, ' '))
    expect(
      offenders,
      `分隔线不该用 --border：${[...new Set(offenders)].slice(0, 6).join(' / ')}`,
    ).toEqual([])
  })

  it('keeps the separator tokens in use', () => {
    // 反向守一手：全换成 --border 时上面那条会过，这条不行。
    const separators = [...CSS.matchAll(/var\(\s*--line(?:-strong)?\s*\)/g)].length
    expect(separators).toBeGreaterThan(40)
  })

  it('never references --border-strong, which is just as transparent as --border', () => {
    // 这个名字看着比 --border 重，值却一样是 transparent。历史上它被当成
    // 「更明显的线」用了一整片：滚动条滑块（background）、下拉边线、5 个虚线
    // 空态框、输入框/搜索框/知识库卡片的边、hover 与 focus 的描边、删除线。
    // 每一处都等于什么都没画。要画线一律走 --line / --line-strong。
    const offenders = [...CSS.matchAll(/var\(\s*--border-strong\s*\)/gi)].map((match) => match[0])
    expect(
      offenders,
      `--border-strong 恒透明，不能用来画线（共 ${offenders.length} 处）`,
    ).toEqual([])
  })

  it('never paints a background with an always-transparent token', () => {
    // 用 background 画 1px 线的写法最容易漏：滚动条滑块、两端分隔线。
    const offenders = [
      ...CSS.matchAll(/background(?:-color)?\s*:\s*var\(\s*--border(?:-strong)?\s*\)/gi),
    ].map((match) => match[0])
    expect(offenders, `背景不能用透明 token：${offenders.join(' ')}`).toEqual([])
  })

  it('leaves no hardcoded fallback behind for the old status names', () => {
    const offenders = [
      ...CSS.matchAll(/var\(\s*--(?:success|warning|danger|yellow|orange|ok|warn|bad)\s*,/g),
    ].map((match) => match[0])
    expect(offenders, `仍有写死兜底：${offenders.join(' ')}`).toEqual([])
  })
})

describe('status colours on their own cards', () => {
  // 状态徽标画在卡片（--panel）与页面（--bg）上。更深的 --panel-3 不在此断言：
  // 那档要把功能色整体提亮才够 4.5:1，会破坏「状态色保持低饱和」的既有设计
  // （见 styles.css 顶部 Palette rules）。
  const SURFACES = ['--bg', '--panel']

  for (const mode of ['dark', 'light'] as const) {
    it(`${mode}: ok / warn / bad stay readable on cards`, () => {
      const vars = { ...block(':root') }
      if (mode === 'light') Object.assign(vars, block(":root[data-theme='light']"))
      const failures: string[] = []
      for (const token of ['--green', '--amber', '--red']) {
        const foreground = vars[token] as string
        for (const surface of SURFACES) {
          const background = vars[surface] as string
          const value = ratio(foreground, background)
          if (value < 4.5) {
            failures.push(
              `${token} ${foreground} on ${surface} ${background} = ${value.toFixed(2)}:1`,
            )
          }
        }
      }
      expect(failures, `\n${failures.join('\n')}\n`).toEqual([])
    })
  }
})

/**
 * 桌面端己移除对比度/饱和度设置，代码块语法色只剩手写调色板这一层，
 * 暗、浅两套主题各算一遍。
 */
function resolved(selectors: string[]): Variables {
  return Object.assign({}, ...selectors.map((selector) => block(selector)))
}

/** 顺着 `var(--x)` 链拿到最终字面值；`--syn-*` 都是指向功能色的别名。 */
function resolveValue(vars: Variables, name: string, depth = 0): string {
  const raw = vars[name]
  if (raw === undefined) throw new Error(`没有定义 ${name}`)
  const alias = /^var\(\s*(--[a-z0-9-]+)\s*\)$/i.exec(raw.trim())
  if (!alias) return raw.trim()
  if (depth > 5) throw new Error(`${name} 的 var 链太深`)
  return resolveValue(vars, alias[1] as string, depth + 1)
}

describe('user message action buttons', () => {
  /**
   * 「编辑」「复制」曾经是 opacity: 0 + `.user-message:hover` 才显示，等于不悬停
   * 就找不到这两个按钮。这里守住两件事：默认不靠 hover 就可见，且基准色
   * 在气泡底色（--panel-3 → --panel-2 渐变）上仍达到 4.5:1。
   */
  it('stay visible without hovering the message', () => {
    const body = ruleBody('.user-copy')
    expect(/opacity\s*:\s*0\s*;/.test(body), '.user-copy 默认不透明度不能是 0').toBe(false)
    expect(body, '.user-copy 需要一个不依赖 hover 的前景色').toMatch(
      /color\s*:\s*var\(\s*--(?:muted|text-soft|text)\s*\)/,
    )
  })

  for (const mode of ['dark', 'light'] as const) {
    it(`${mode}: the resting colour is readable on the user bubble`, () => {
      const vars = { ...block(':root') }
      if (mode === 'light') Object.assign(vars, block(":root[data-theme='light']"))
      const foreground = resolveValue(vars, '--muted')
      const failures: string[] = []
      for (const surface of ['--panel-3', '--panel-2']) {
        const value = ratio(foreground, resolveValue(vars, surface))
        if (value < 4.5) failures.push(`--muted ${foreground} on ${surface} = ${value.toFixed(2)}:1`)
      }
      expect(failures, `\n${failures.join('\n')}\n`).toEqual([])
    })
  }
})

describe('syntax colours inside code blocks', () => {
  // 代码块底色是 --code-bg，不是在 --panel 上。五档语法色都必须能在那上面读。
  const SYN = ['--syn-comment', '--syn-string', '--syn-number', '--syn-keyword', '--syn-function']

  for (const mode of ['dark', 'light'] as const) {
    it(`${mode}: syntax colours stay readable on the code block`, () => {
      const base = mode === 'light' ? [':root', ":root[data-theme='light']"] : [':root']
      const failures: string[] = []
      const vars = resolved(base)
      const background = resolveValue(vars, '--code-bg')
      for (const token of SYN) {
        const foreground = resolveValue(vars, token)
        const value = ratio(foreground, background)
        if (value < 4.5) {
          failures.push(`${token} ${foreground} on ${background} = ${value.toFixed(2)}:1`)
        }
      }
      expect(failures, `\n${failures.slice(0, 12).join('\n')}\n`).toEqual([])
    })
  }
})
