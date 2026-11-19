#!/usr/bin/env node
// 生成「外观 → 对比度 / 饱和度」的 CSS 覆盖层。
//
// 两端的调色板是按配色与深浅模式分别写死的自定义属性，没法用一条 color-mix
// 同时照顾十几套配色（旧版 WebView 也不一定支持 color-mix）。这里直接读取
// 两端的调色板，按 HSL 计算出每一档的实际色值，再把结果写进带
// `appearance:begin` / `appearance:end` 标记的区块。
//
// 标准档以旧版的「低对比度」和「高饱和度」为基准：低/高档不再从原始调色板
// 出发，而是在标准档上再各走一步，因此三档之间的观感差距比早期版本更均匀。
//
// 对比度只动中性色阶梯与文字，饱和度只动主题色与功能色，两组变量互不重叠，
// 因此两种设置可以同时生效，不受 CSS 规则先后顺序影响。
//
// 用法（仓库根目录）：
//   node pilot/scripts/gen-appearance-css.mjs           # 重新生成
//   node pilot/scripts/gen-appearance-css.mjs --check   # 只检查是否最新，退出码 0/1
//
// 改动任何配色后重跑一次；两端色值始终以 styles.css / App.vue 为准。
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pilotDir = resolve(here, '..')
const CLIENT_CSS = join(pilotDir, 'client', 'src', 'renderer', 'src', 'styles.css')
const APP_VUE = join(pilotDir, 'app', 'App.vue')

const ACCENTS = [
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
  'claude'
]

// 对比度：页面/卡片阶梯（surface）与文字（text）分开计算。
// `--code-border` 是代码块的 1px 描边，跟着代码块底色一起提亮/压暗才不会
// 在某一档里凭空消失（它此前不在任何一张表里，三档都一样）。
const CLIENT_CONTRAST_SURFACE_VARS = [
  '--bg',
  '--page',
  '--bg-elev',
  '--panel',
  '--panel-2',
  '--panel-3',
  '--panel-hover',
  '--surface',
  '--sidebar-bg',
  '--sidebar-bg-2',
  '--code-bg',
  '--code-border'
]

const CLIENT_CONTRAST_TEXT_VARS = [
  '--text',
  '--text-soft',
  '--muted',
  '--faint',
  '--sidebar-text',
  '--sidebar-muted',
  '--code-text'
]

const APP_CONTRAST_SURFACE_VARS = [
  '--bg',
  '--bg-2',
  '--page',
  '--bg-elevated',
  '--surface-float',
  '--bg-soft',
  '--surface',
  '--surface-2',
  '--surface-3',
  '--input-bg'
]

const APP_CONTRAST_TEXT_VARS = ['--text', '--text-strong', '--muted', '--dim']

// 分隔线（--line / --line-strong）是半透明色，不进 contrastColor（它只认
// #rrggbb），否则高对比档里文字与卡片的对比度拉大了、行线却还是 10%，
// 表格与分组框看上去比低对比档还糊。这里按档位单独给透明度。
// 标准档必须与手写调色板里的 0.1 / 0.2 一致，否则默认观感会变。
const LINE_ALPHAS = {
  low: { line: 0.07, strong: 0.14 },
  standard: { line: 0.1, strong: 0.2 },
  high: { line: 0.18, strong: 0.32 }
}

/** 深色用白线、浅色用黑线；同档透明度相同。 */
function lineDeclarations(theme, level) {
  const alpha = LINE_ALPHAS[level]
  const ink = theme === 'dark' ? '255, 255, 255' : '0, 0, 0'
  return [
    `--line: rgba(${ink}, ${alpha.line});`,
    `--line-strong: rgba(${ink}, ${alpha.strong});`
  ]
}

// 饱和度：主题色、功能色以及它们的半透明叠色。半透明色保留 alpha，
// 只改 RGB 的饱和度，所以背景/描边的透明度关系不会被破坏。
const CLIENT_SATURATION_VARS = [
  '--accent',
  '--accent-strong',
  '--sidebar-primary-from',
  '--sidebar-primary-to',
  '--blue',
  '--blue-soft',
  '--amber',
  '--amber-soft',
  '--red',
  '--red-soft',
  '--green',
  '--green-soft',
  '--violet',
  '--violet-soft',
  '--knowledge',
  '--knowledge-soft'
]

const APP_SATURATION_VARS = [
  '--accent',
  '--accent-soft',
  '--accent-gradient',
  '--accent-wash-strong',
  '--accent-wash',
  '--accent-wash-soft',
  '--accent-line',
  '--accent-line-soft',
  '--accent-glow',
  '--ok',
  '--ok-soft',
  '--warn',
  '--danger',
  '--knowledge',
  '--knowledge-soft',
  '--file',
  '--file-soft',
  '--pause',
  '--pause-soft',
  '--pause-line',
  '--stop',
  '--stop-soft',
  '--stop-line',
  '--resume',
  '--resume-soft',
  '--review',
  '--review-soft'
]

function blockOf(css, selector) {
  const start = css.indexOf(selector)
  if (start < 0) throw new Error(`找不到选择器 ${selector}`)
  const open = css.indexOf('{', start)
  let depth = 0
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1
    else if (css[index] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(open + 1, index)
    }
  }
  throw new Error(`选择器 ${selector} 的样式块没有闭合`)
}

function variables(block) {
  const found = {}
  for (const match of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    found[match[1]] = match[2].trim()
  }
  return found
}

function rgbOf(hex) {
  const match = /^#([0-9a-f]{6})$/i.exec(String(hex).trim())
  if (!match) throw new Error(`只支持 #rrggbb：${hex}`)
  return [0, 2, 4].map((index) => parseInt(match[1].slice(index, index + 2), 16))
}

function hexOf(rgb) {
  return `#${rgb
    .map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0'))
    .join('')}`
}

function rgbToHsl([r, g, b]) {
  const red = r / 255
  const green = g / 255
  const blue = b / 255
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  const lightness = (max + min) / 2
  if (max === min) return [0, 0, lightness]
  const delta = max - min
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min)
  let hue
  if (max === red) hue = (green - blue) / delta + (green < blue ? 6 : 0)
  else if (max === green) hue = (blue - red) / delta + 2
  else hue = (red - green) / delta + 4
  return [hue / 6, saturation, lightness]
}

function hslToRgb([hue, saturation, lightness]) {
  if (saturation === 0) {
    const value = lightness * 255
    return [value, value, value]
  }
  const q =
    lightness < 0.5
      ? lightness * (1 + saturation)
      : lightness + saturation - lightness * saturation
  const p = 2 * lightness - q
  const channel = (input) => {
    let value = input
    if (value < 0) value += 1
    if (value > 1) value -= 1
    if (value < 1 / 6) return p + (q - p) * 6 * value
    if (value < 1 / 2) return q
    if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6
    return p
  }
  return [channel(hue + 1 / 3) * 255, channel(hue) * 255, channel(hue - 1 / 3) * 255]
}

/**
 * 对比度只改亮度，三档都以「旧低对比度」为基准：
 * - 标准档：深色卡片稍微抬离纯黑、文字压到 93%；浅色卡片压到 98.5%、
 *   文字向底色靠拢。
 * - 低档：在标准档上再走一次同样的低对比变换，整体更柔和。
 * - 高档：以标准档为起点做高对比变换，深色压暗、浅色提亮，文字反向拉开。
 */
/**
 * 浅色低对比会抬高文字亮度；次级文字本身已接近 4.5:1，这里按变量给出
 * 不同的抬升幅度，避免弱化文字掉到可读性以下。
 */
const DARK_LOW_TEXT_FACTORS = {
  '--text': 0.93,
  '--text-strong': 0.93,
  '--text-soft': 0.95,
  '--muted': 0.97,
  '--faint': 1,
  '--dim': 1,
  '--sidebar-text': 0.93,
  '--sidebar-muted': 0.97,
  '--code-text': 0.95
}

const LIGHT_LOW_TEXT_FACTORS = {
  '--text': 0.08,
  '--text-strong': 0.08,
  '--text-soft': 0.06,
  '--muted': 0.03,
  '--faint': 0,
  '--dim': 0,
  '--sidebar-text': 0.08,
  '--sidebar-muted': 0.03,
  '--code-text': 0.06
}

/** 低对比的一步；标准档就是原始亮度走这一步后的结果。 */
function lowStep(lightness, theme, role, factor) {
  if (role === 'surface') {
    return theme === 'dark' ? lightness + (1 - lightness) * 0.02 : lightness * 0.985
  }
  return theme === 'dark' ? lightness * factor : lightness + (1 - lightness) * factor
}

/** 高对比的一步；在标准档上再走这一步得到高档。 */
function highStep(lightness, theme, role) {
  if (role === 'surface') {
    return theme === 'dark' ? lightness * 0.85 : lightness + (1 - lightness) * 0.5
  }
  return theme === 'dark' ? lightness + (1 - lightness) * 0.45 : lightness * 0.55
}

function contrastColor(hex, theme, level, role, factor = 0.08) {
  if (!/^#[0-9a-f]{6}$/i.test(String(hex).trim())) return hex
  const [hue, saturation, lightness] = rgbToHsl(rgbOf(hex))
  const standard = lowStep(lightness, theme, role, factor)
  const next =
    level === 'standard'
      ? standard
      : level === 'high'
        ? highStep(standard, theme, role)
        : lowStep(standard, theme, role, factor)
  return hexOf(hslToRgb([hue, saturation, next]))
}

// 标准档沿用旧版的「高饱和度」（×1.3），低/高档以它为中心各走一步。
const SATURATION_FACTORS = { low: 0.65, standard: 1.3, high: 1.69 }

function saturateHex(hex, level) {
  const factor = SATURATION_FACTORS[level]
  if (!factor) return hex
  const [hue, saturation, lightness] = rgbToHsl(rgbOf(hex))
  return hexOf(hslToRgb([hue, Math.min(1, saturation * factor), lightness]))
}

/** 一段值里可能同时有 #rrggbb、rgba(...)（渐变最多两个色标）。 */
function saturateValue(value, level) {
  const factor = SATURATION_FACTORS[level]
  if (!factor) return value
  return String(value)
    .replace(/#[0-9a-f]{6}\b/gi, (match) => saturateHex(match, level))
    .replace(/rgba?\(([^)]+)\)/gi, (match, body) => {
      const parts = body
        .split(',')
        .map((part) => part.trim())
      if (parts.length < 3 || parts.length > 4) return match
      const channels = parts.slice(0, 3).map((part) => Number(part))
      if (channels.some((channel) => !Number.isFinite(channel))) return match
      const alpha = parts[3]
      const [hue, saturation, lightness] = rgbToHsl(channels)
      const [r, g, b] = hslToRgb([hue, Math.min(1, saturation * factor), lightness])
      const rgb = [r, g, b]
        .map((channel) => Math.max(0, Math.min(255, Math.round(channel))))
        .join(', ')
      return alpha === undefined ? `rgb(${rgb})` : `rgba(${rgb}, ${alpha})`
    })
}

function relativeLuminance(hex) {
  const rgb = rgbOf(hex)
  return rgb
    .map((value) => value / 255)
    .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
}

function contrastRatio(foreground, background) {
  const [light, dark] = [relativeLuminance(foreground), relativeLuminance(background)].sort(
    (left, right) => right - left
  )
  return (light + 0.05) / (dark + 0.05)
}

/**
 * 高饱和会把强调色推亮或推暗，原配色里选好的 accent-ink 可能掉到 4.5:1 以下。
 * 只有真的低于底线时才换成黑白里对比度更高的那个，标准档和低档保持原配色。
 */
function accentInkOverride(palette, level) {
  const accent = palette['--accent']
  const baseInk = palette['--accent-ink']
  if (!accent || !baseInk) return null
  const next = saturateHex(accent, level)
  if (next === accent || contrastRatio(next, baseInk) >= 4.5) return null
  return contrastRatio(next, '#ffffff') >= contrastRatio(next, '#000000') ? '#ffffff' : '#000000'
}

function indentLines(lines, pad) {
  return lines.map((line) => (line ? pad + line : line)).join('\n')
}

function declarationLines(names, palette, transform) {
  return names
    .filter((name) => palette[name] !== undefined)
    .map((name) => `${name}: ${transform(palette[name], name)};`)
}

function clientPalettes(css) {
  const darkBase = variables(blockOf(css, ':root {'))
  const lightBase = variables(blockOf(css, ":root[data-theme='light'] {"))
  const list = [{ accent: '', dark: darkBase, light: lightBase }]
  for (const name of ACCENTS) {
    list.push({
      accent: name,
      dark: { ...darkBase, ...variables(blockOf(css, `:root[data-accent='${name}']`)) },
      light: {
        ...lightBase,
        ...variables(blockOf(css, `:root[data-theme='light'][data-accent='${name}']`))
      }
    })
  }
  return list
}

function appPalettes(css) {
  const darkBase = variables(blockOf(css, 'page,\n:root {'))
  const lightBase = variables(blockOf(css, '\n.theme-light {'))
  const list = [{ accent: '', dark: darkBase, light: lightBase }]
  for (const name of ACCENTS) {
    list.push({
      accent: name,
      dark: { ...darkBase, ...variables(blockOf(css, `\n.accent-${name} {`)) },
      light: { ...lightBase, ...variables(blockOf(css, `\n.theme-light.accent-${name} {`)) }
    })
  }
  return list
}

/** 对比度规则：深色/浅色各一档，配色变体按需覆盖对应阶梯。 */
function clientContrastRules(css, level) {
  const rules = []
  for (const palette of clientPalettes(css)) {
    const attr = palette.accent ? `[data-accent='${palette.accent}']` : ''
    const dark = indentLines(
      [
        ...declarationLines(CLIENT_CONTRAST_SURFACE_VARS, palette.dark, (value) =>
          contrastColor(value, 'dark', level, 'surface')
        ),
        ...declarationLines(CLIENT_CONTRAST_TEXT_VARS, palette.dark, (value, name) =>
          contrastColor(value, 'dark', level, 'text', DARK_LOW_TEXT_FACTORS[name] ?? 0.93)
        ),
        ...lineDeclarations('dark', level)
      ],
      '  '
    )
    const light = indentLines(
      [
        ...declarationLines(CLIENT_CONTRAST_SURFACE_VARS, palette.light, (value) =>
          contrastColor(value, 'light', level, 'surface')
        ),
        ...declarationLines(CLIENT_CONTRAST_TEXT_VARS, palette.light, (value, name) =>
          contrastColor(value, 'light', level, 'text', LIGHT_LOW_TEXT_FACTORS[name] ?? 0.08)
        ),
        ...lineDeclarations('light', level)
      ],
      '  '
    )
    rules.push(`:root[data-contrast='${level}']${attr} {\n${dark}\n}`)
    rules.push(`:root[data-theme='light'][data-contrast='${level}']${attr} {\n${light}\n}`)
  }
  return rules.join('\n\n')
}

function appContrastRules(css, level) {
  const rules = []
  for (const palette of appPalettes(css)) {
    const suffix = palette.accent ? `.accent-${palette.accent}` : ''
    const dark = indentLines(
      [
        ...declarationLines(APP_CONTRAST_SURFACE_VARS, palette.dark, (value) =>
          contrastColor(value, 'dark', level, 'surface')
        ),
        ...declarationLines(APP_CONTRAST_TEXT_VARS, palette.dark, (value, name) =>
          contrastColor(value, 'dark', level, 'text', DARK_LOW_TEXT_FACTORS[name] ?? 0.93)
        ),
        ...lineDeclarations('dark', level)
      ],
      '  '
    )
    const light = indentLines(
      [
        ...declarationLines(APP_CONTRAST_SURFACE_VARS, palette.light, (value) =>
          contrastColor(value, 'light', level, 'surface')
        ),
        ...declarationLines(APP_CONTRAST_TEXT_VARS, palette.light, (value, name) =>
          contrastColor(value, 'light', level, 'text', LIGHT_LOW_TEXT_FACTORS[name] ?? 0.08)
        ),
        ...lineDeclarations('light', level)
      ],
      '  '
    )
    rules.push(`.contrast-${level}${suffix} {\n${dark}\n}`)
    rules.push(`.theme-light.contrast-${level}${suffix} {\n${light}\n}`)
  }
  return rules.join('\n\n')
}

function clientSaturationRules(css, level) {
  const rules = []
  for (const palette of clientPalettes(css)) {
    const attr = palette.accent ? `[data-accent='${palette.accent}']` : ''
    const dark = indentLines(
      [
        ...declarationLines(CLIENT_SATURATION_VARS, palette.dark, (value) =>
          saturateValue(value, level)
        ),
        ...inkLine(palette.dark, level)
      ],
      '  '
    )
    const light = indentLines(
      [
        ...declarationLines(CLIENT_SATURATION_VARS, palette.light, (value) =>
          saturateValue(value, level)
        ),
        ...inkLine(palette.light, level)
      ],
      '  '
    )
    rules.push(`:root[data-saturation='${level}']${attr} {\n${dark}\n}`)
    rules.push(`:root[data-theme='light'][data-saturation='${level}']${attr} {\n${light}\n}`)
  }
  return rules.join('\n\n')
}

function appSaturationRules(css, level) {
  const rules = []
  for (const palette of appPalettes(css)) {
    const suffix = palette.accent ? `.accent-${palette.accent}` : ''
    const dark = indentLines(
      [
        ...declarationLines(APP_SATURATION_VARS, palette.dark, (value) =>
          saturateValue(value, level)
        ),
        ...inkLine(palette.dark, level)
      ],
      '  '
    )
    const light = indentLines(
      [
        ...declarationLines(APP_SATURATION_VARS, palette.light, (value) =>
          saturateValue(value, level)
        ),
        ...inkLine(palette.light, level)
      ],
      '  '
    )
    rules.push(`.saturation-${level}${suffix} {\n${dark}\n}`)
    rules.push(`.theme-light.saturation-${level}${suffix} {\n${light}\n}`)
  }
  return rules.join('\n\n')
}

function inkLine(palette, level) {
  const ink = accentInkOverride(palette, level)
  return ink ? [`--accent-ink: ${ink};`] : []
}

const BEGIN = '/* appearance:begin */'
const END = '/* appearance:end */'

/** 早期版本生成过「明暗三档」区块，连同注释头一起移除。 */
function stripLegacyTone(source) {
  const legacyBegin = '/* tone:begin */'
  const legacyEnd = '/* tone:end */'
  const begin = source.indexOf(legacyBegin)
  const end = source.indexOf(legacyEnd)
  if (begin < 0 && end < 0) return source
  if (begin < 0 || end < begin) throw new Error('历史 tone 标记不成对')
  const headerAt = source.lastIndexOf('/* 明暗三档', begin)
  const cutStart = headerAt >= 0 && begin - headerAt < 200 ? headerAt : begin
  return `${source.slice(0, cutStart)}${source.slice(end + legacyEnd.length)}`.replace(
    /\n{3,}/g,
    '\n\n'
  )
}

/**
 * 把生成块写进文件。
 *
 * `insertBefore` 用于 App.vue：生成的 CSS 必须落在 `<style>` 里，否则整段规则
 * 会被当成标签外文本忽略。标记若已存在但在锚点之后，就连同生成注释一起剪走
 * 再插到锚点前。
 */
function replaceSection(source, content, title, insertBefore) {
  const header = `/* ${title}（由 pilot/scripts/gen-appearance-css.mjs 生成，勿手改） */`
  const section = `${header}\n${BEGIN}\n${content}\n${END}`
  const begin = source.indexOf(BEGIN)
  const end = source.indexOf(END)
  if (begin >= 0 && end > begin) {
    const anchor = insertBefore ? source.indexOf(insertBefore) : -1
    const misplaced = anchor >= 0 && begin > anchor
    if (!misplaced) {
      return (
        source.slice(0, begin) +
        `${BEGIN}\n${content}\n${END}` +
        source.slice(end + END.length)
      )
    }
    const headerAt = source.lastIndexOf(header, begin)
    const cutStart = headerAt >= 0 && headerAt < begin ? headerAt : begin
    const without = `${(source.slice(0, cutStart) + source.slice(end + END.length)).replace(/\s+$/, '')}\n`
    const newAnchor = without.indexOf(insertBefore)
    return `${without.slice(0, newAnchor)}${section}\n\n${without.slice(newAnchor)}`
  }
  if (source.includes(BEGIN) || source.includes(END)) {
    throw new Error(`${title} 里的 appearance 标记不成对`)
  }
  const anchor = insertBefore ? source.indexOf(insertBefore) : -1
  if (anchor >= 0) {
    const before = source.slice(0, anchor).replace(/\s+$/, '')
    return `${before}\n\n${section}\n\n${source.slice(anchor)}`
  }
  return `${source.replace(/\s+$/, '')}\n\n${section}\n`
}

const clientSource = stripLegacyTone(readFileSync(CLIENT_CSS, 'utf8'))
const appSource = stripLegacyTone(readFileSync(APP_VUE, 'utf8'))

const LEVELS = ['standard', 'low', 'high']
const clientContent = [
  ...LEVELS.map((level) => clientContrastRules(clientSource, level)),
  ...LEVELS.map((level) => clientSaturationRules(clientSource, level))
].join('\n\n')
const appContent = [
  ...LEVELS.map((level) => appContrastRules(appSource, level)),
  ...LEVELS.map((level) => appSaturationRules(appSource, level))
].join('\n\n')

const clientNext = replaceSection(clientSource, clientContent, '对比度与饱和度（桌面端）')
const appNext = replaceSection(appSource, appContent, '对比度与饱和度（手机端）', '</style>')

const check = process.argv.includes('--check')
if (check) {
  const stale = []
  if (clientNext !== readFileSync(CLIENT_CSS, 'utf8')) stale.push('client/src/renderer/src/styles.css')
  if (appNext !== readFileSync(APP_VUE, 'utf8')) stale.push('app/App.vue')
  if (stale.length) {
    console.error(`✗ 外观样式不是最新：${stale.join('、')}`)
    console.error('  运行 node pilot/scripts/gen-appearance-css.mjs 重新生成。')
    process.exit(1)
  }
  console.log('✓ 外观样式已是最新')
  process.exit(0)
}

if (clientNext !== readFileSync(CLIENT_CSS, 'utf8')) writeFileSync(CLIENT_CSS, clientNext)
if (appNext !== readFileSync(APP_VUE, 'utf8')) writeFileSync(APP_VUE, appNext)
console.log('✓ 已生成对比度与饱和度样式')
console.log('  client/src/renderer/src/styles.css')
console.log('  app/App.vue')
