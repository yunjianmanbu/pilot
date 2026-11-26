import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  KIND_SAMPLES,
  TOOL_KINDS,
  partKind,
  toolGlyph,
  toolKind,
} from '../src/renderer/src/components/process-icons'

/**
 * 执行过程里那一列小图标的分类表。
 *
 * 图标只有 14–16px，形状相近的两类（纸张 / 文件夹、放大镜 / 时钟）在灰字里根本
 * 分不出来，所以每一类除了形状还带一个 kind，由样式表上色。这里锁三件事：
 * 常用工具落到对的类别；每个类别都必须有配色规则；同尺寸下两类不许共用轮廓。
 */
const CSS = readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')
/** 内置工具名册（main 侧的常量表），用来看有没有工具漏分类。 */
const SPEC = readFileSync(new URL('../src/main/agent/tools/spec.ts', import.meta.url), 'utf8')

describe('toolKind', () => {
  it('classifies by what the call does, not by its implementation', () => {
    expect(toolKind('run_shell')).toBe('exec')
    expect(toolKind('run_command')).toBe('exec')
    expect(toolKind('write_file')).toBe('write')
    expect(toolKind('apply_patch')).toBe('write')
    expect(toolKind('read_file')).toBe('read')
    expect(toolKind('search_files')).toBe('search')
    expect(toolKind('list_directory')).toBe('list')
    expect(toolKind('git_status')).toBe('git')
    expect(toolKind('fetch_url')).toBe('net')
    expect(toolKind('screenshot')).toBe('image')
    expect(toolKind('app_control')).toBe('drive')
    expect(toolKind('subagent')).toBe('delegate')
    expect(toolKind('update_plan')).toBe('plan')
    expect(toolKind('add_todo')).toBe('todo')
    expect(toolKind('remember')).toBe('memory')
    expect(toolKind('schedule_task')).toBe('schedule')
    expect(toolKind('propose_self_update')).toBe('evolve')
    expect(toolKind('mcp__github__create_issue')).toBe('tool')
  })

  /** 工具管理类（查看 / 注册 / 跑一个工具）本来就该是扳手，不进别的类别。 */
  const TOOL_MANAGEMENT = new Set([
    'list_tools',
    'register_tool',
    'run_tool',
    'rollback_tool',
    'promote_tool',
    'create_mcp_server',
  ])

  it('gives every built-in tool a kind of its own, not the wrench fallback', () => {
    // 内置工具清单从 spec.ts 读：加了一个新工具却忘了分类，这里先红，
    // 而不是等到界面上多出一个不起眼的扳手。
    const names = [
      ...SPEC.matchAll(/^export const [A-Z_0-9]+ = '([a-z_0-9]+)'/gm),
    ].map((match) => match[1]!)
    expect(names.length).toBeGreaterThan(30)
    const unclassified = names.filter(
      (name) => !TOOL_MANAGEMENT.has(name) && toolKind(name) === 'tool',
    )
    expect(unclassified).toEqual([])
  })

  it('falls back to a wrench for a tool nobody has classified yet', () => {
    expect(toolKind('some_future_tool')).toBe('tool')
    expect(toolKind('SOME_FUTURE_TOOL')).toBe('tool')
    // 兜底图标是扳手，不是纸张：纸张会让「未知工具」读起来像「读了文件」。
    expect(renderToStaticMarkup(<>{toolGlyph('some_future_tool')}</>)).toContain('M14.7')
  })

  it('does not confuse a read with a listing', () => {
    expect(toolKind('read_file')).not.toBe(toolKind('list_directory'))
    expect(toolKind('search_files')).not.toBe(toolKind('read_file'))
  })

  it('classifies every sample as the kind it stands for', () => {
    // 样本表是测试与文档的共同来源：某类换了代表工具而不再是那一类，这里先红。
    const wrong = TOOL_KINDS.filter((kind) => toolKind(KIND_SAMPLES[kind]) !== kind).map(
      (kind) => `${KIND_SAMPLES[kind]} → ${toolKind(KIND_SAMPLES[kind])} (expected ${kind})`,
    )
    expect(wrong).toEqual([])
  })

  it('never reuses one icon shape for two kinds', () => {
    // 只换颜色不够：14px 下两张轮廓相同的图仍然一样。每类的 path 必须不同。
    const seen = new Map<string, string>()
    const clashes: string[] = []
    for (const kind of TOOL_KINDS) {
      const markup = renderToStaticMarkup(<>{toolGlyph(KIND_SAMPLES[kind])}</>)
      const previous = seen.get(markup)
      if (previous) clashes.push(`${previous} / ${kind}`)
      else seen.set(markup, kind)
    }
    expect(clashes).toEqual([])
  })

  it('draws a plan differently from a todo list', () => {
    const plan = renderToStaticMarkup(<>{toolGlyph('update_plan')}</>)
    const todo = renderToStaticMarkup(<>{toolGlyph('add_todo')}</>)
    expect(plan).not.toBe(todo)
    // 计划是台阶，不是清单：三行勾选线属于待办。
    expect(plan).toContain('M3 20h5v-5h5v-5h4V5h4')
    expect(plan).not.toContain('M10 6h10M10 12h10M10 18h10')
  })

  it('draws a screenshot as a camera, not a rectangle like the terminal', () => {
    // 旧的图片图标是「带山与太阳的方框」，14px 下和终端、文件卡片同一个轮廓。
    const shot = renderToStaticMarkup(<>{toolGlyph('screenshot')}</>)
    expect(shot).not.toContain('m21 15-4.5-4.5L7 20')
    expect(shot).toContain('M2.6 8.4')
  })

  it('draws driving the app with a filled pointer, apart from files and terminal', () => {
    const drive = renderToStaticMarkup(<>{toolGlyph('app_control')}</>)
    expect(drive).toContain('M6 3.4 18.4 11')
    // 描边三角和铅笔、台阶都是几根斜线；涂实以后它是整列唯一的实心箭头。
    expect(drive).toContain('fill="currentColor"')
    expect(drive).not.toBe(renderToStaticMarkup(<>{toolGlyph('read_file')}</>))
    expect(drive).not.toBe(renderToStaticMarkup(<>{toolGlyph('run_shell')}</>))
  })

  it('draws exec as a bare prompt instead of a third box', () => {
    // 上一版是「圆角矩形里套 > 和横线」：外框在 15px 下占满整个字形，和相机、
    // 文件夹两个方框并排时轮廓完全一样。提示符不许再有外框。
    const exec = renderToStaticMarkup(<>{toolGlyph('run_shell')}</>)
    expect(exec).not.toContain('<rect')
    expect(exec).toContain('M4.4 7.4 9.3 12')
    expect(exec).not.toBe(renderToStaticMarkup(<>{toolGlyph('read_file')}</>))
    expect(exec).not.toBe(renderToStaticMarkup(<>{toolGlyph('update_plan')}</>))
  })

  it('gives the clock bells so it is not a second magnifier', () => {
    // 圆 + 两根指针在 15px 下就是放大镜多画两笔；剪影特色必须落在铃上。
    const schedule = renderToStaticMarkup(<>{toolGlyph('schedule_task')}</>)
    expect(schedule).toContain('M5.3 4.7 3.5 6.7')
    expect(schedule).not.toBe(renderToStaticMarkup(<>{toolGlyph('search_files')}</>))
  })

  it('puts a grabbing arrow inside the network cloud', () => {
    // 只有一朵云时表意停在「这是网络」；这一类真正做的是把外面的东西抓回来。
    const net = renderToStaticMarkup(<>{toolGlyph('fetch_url')}</>)
    expect(net).toContain('M9.7 13.4 12 15.7')
  })

  it('fills the pen tip so writing is not just two thin diagonals', () => {
    const write = renderToStaticMarkup(<>{toolGlyph('write_file')}</>)
    expect(write).toContain('fill="currentColor"')
    expect(write).toContain('M4.2 19.9 5.1 15.7 8.1 18.9Z')
  })

  it('draws every glyph at the same 16px so one kind is not smaller than the next', () => {
    const widths = TOOL_KINDS.map((kind) => {
      const markup = renderToStaticMarkup(<>{toolGlyph(KIND_SAMPLES[kind])}</>)
      return /width="(\d+)"/.exec(markup)?.[1] ?? 'none'
    })
    expect([...new Set(widths)]).toEqual(['16'])
  })

  it('gives thinking and notes kinds of their own', () => {
    expect(partKind('reasoning')).toBe('think')
    expect(partKind('note')).toBe('note')
  })
})

/** 从样式表的一段规则里读出 --kind-<name>: #rrggbb。 */
function kindTokens(block: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const match of block.matchAll(/--kind-([a-z]+):\s*(#[0-9a-fA-F]{6})/g)) {
    out.set(match[1]!, match[2]!.toLowerCase())
  }
  return out
}

function blockOf(selector: string): string {
  const start = CSS.indexOf(selector)
  expect(start, selector).toBeGreaterThan(-1)
  return CSS.slice(start, CSS.indexOf('\n}', start))
}

function hue(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ]
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  if (max === min) return 0
  const d = max - min
  const h =
    max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return (h * 60 + 360) % 360
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

const contrastOn = (hex: string, bg: string): number => {
  const [a, b] = [relativeLuminance(hex), relativeLuminance(bg)].sort((x, y) => y - x) as [
    number,
    number,
  ]
  return (a + 0.05) / (b + 0.05)
}

/**
 * 配色本身也要有断言。
 *
 * 第一版的 16 个色是各自挑的「好看的颜色」，最挤的一对只差 11°（写入/记忆），
 * 14px 并排时仍然是同一个颜色——只看代码读不出来，只有算出色相才看得见。
 * 这里锁两件事：相邻色相至少隔 18°；两套主题在白/深底色上都够看清。
 */
describe('icon colour spacing', () => {
  const dark = kindTokens(blockOf(':root {\n  /* 字号设置'))
  // 开头带换行：文件顶部有一段注释同样写着 `:root[data-theme='light']`，
  // 不带换行会从注释里截，读到的其实是深色那一块。
  const light = kindTokens(blockOf("\n:root[data-theme='light'] {"))

  it('defines a colour for every kind in both themes', () => {
    // 'tool' 不在色相环里：未分类工具保持中性色，不假装属于某一类。
    const want = [...TOOL_KINDS.filter((kind) => kind !== 'tool'), 'think', 'note'].sort()
    expect([...dark.keys()].sort()).toEqual(want)
    expect([...light.keys()].sort()).toEqual(want)
    expect(CSS).toMatch(/\.glyph-tool \{\s*color: var\(--muted\)/)
  })

  it('keeps neighbouring hues far enough apart to read at 14px', () => {
    const hues = [...dark.entries()]
      .map(([kind, hex]) => ({ kind, h: hue(hex) }))
      .sort((a, b) => a.h - b.h)
    const gaps = hues.map((entry, index) => {
      const next = hues[(index + 1) % hues.length]!
      let gap = next.h - entry.h
      if (gap < 0) gap += 360
      return { pair: `${entry.kind}/${next.kind}`, gap }
    })
    const tight = gaps.filter((g) => g.gap < 18).map((g) => `${g.pair} ${g.gap.toFixed(1)}°`)
    expect(tight).toEqual([])
  })

  it('keeps every kind legible on its own background', () => {
    const dim = [...dark.entries()]
      .filter(([, hex]) => contrastOn(hex, '#2a2c31') < 4.5)
      .map(([kind, hex]) => `${kind} ${contrastOn(hex, '#2a2c31').toFixed(2)}`)
    const pale = [...light.entries()]
      .filter(([, hex]) => contrastOn(hex, '#ffffff') < 4.5)
      .map(([kind, hex]) => `${kind} ${contrastOn(hex, '#ffffff').toFixed(2)}`)
    expect(dim).toEqual([])
    expect(pale).toEqual([])
  })
})

describe('icon colour classes', () => {
  it('paints every kind it can report', () => {
    const missing = TOOL_KINDS.filter((kind) => !new RegExp(`\\.glyph-${kind}\\b`).test(CSS))
    expect(missing).toEqual([])
  })

  it('paints the two non-tool kinds as well', () => {
    expect(CSS).toMatch(/\.glyph-think\b/)
    expect(CSS).toMatch(/\.glyph-note\b/)
  })

  it('keeps colour off the risk rules so the kind colour is the one that shows', () => {
    // 卡片底色管「要不要留意」，图标色管「这是哪一类」；risk 规则再设 color 会
    // 把它们压回同一个颜色，两类操作又长得一样了。
    const riskBlocks = CSS.match(/\.tool-card\.risk-\w+ \.tool-glyph \{[^}]*\}/g) ?? []
    expect(riskBlocks.length).toBeGreaterThan(0)
    for (const block of riskBlocks) expect(block).not.toMatch(/(^|[^-])color:/)
  })

  it('leaves the icon containers colourless so the kind colour is not overridden', () => {
    // .tool-glyph / .step-glyph / .step-modal-glyph 与 .glyph-* 同为单类选择器，
    // 写在后面就能把类别压回灰——本文件对应的那次 regression 就是这么来的。
    const containers = ['.tool-glyph', '.step-glyph', '.step-modal-glyph']
    for (const name of containers) {
      const block = CSS.match(new RegExp(`\\n\\${name} \\{[^}]*\\}`))?.[0] ?? ''
      expect(block, name).not.toBe('')
      expect(block, name).not.toMatch(/(^|[^-])color:/)
    }
  })
})
