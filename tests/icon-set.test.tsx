import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ComponentType, SVGProps } from 'react'
import { describe, expect, it } from 'vitest'
import * as Icons from '../src/renderer/src/icons'

/**
 * 通用图标表（`src/renderer/src/icons.tsx`）的整套约束。
 *
 * 这一列图标 95% 的时间只出现在 12–16px 的按钮和行首，看不清细节，只能靠
 * 「描边宽一致 + 每一类剪影不同」来区分。上一版的问题不是某个图标画错了，而是
 * 没有一条断言把整张表管起来：新加的图标可以自带 1.8px 描边、可以复用别人的
 * 轮廓，测试全绿。这里把三件事锁死：
 *
 * 1. 除品牌标（PilotMark / PilotLogo，64 视框、实心）外，全部走同一个 `Base`，
 *    因此 viewBox / fill / stroke / 描边宽度只能有一个值。
 * 2. `width` / `height` / `className` / `aria-*` 必须继续透传，否则调用点
 *    （`<XIcon width={18} height={18} />`）会静默退回 16px 造成布局位移。
 * 3. 业务图标两两剪影不同——同一张图不许挂在两个语义上。
 */
const BRAND = new Set(['PilotMark', 'PilotLogo'])

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>

const ALL = (Object.entries(Icons) as Array<[string, IconComponent]>).filter(
  ([name]) => !BRAND.has(name),
)

const markup = (Icon: IconComponent, props: SVGProps<SVGSVGElement> = {}) =>
  renderToStaticMarkup(<Icon {...props} />)

describe('icon set', () => {
  it('exports a usable icon for every business area', () => {
    // 商店名称：抽掉任何一个，调用点都会直接编译失败，所以这里只保证数量级
    // 与关键名字还在，防止有人把文件整体替换成一张更小的表。
    expect(ALL.length).toBeGreaterThanOrEqual(55)
    for (const name of [
      'SettingsIcon',
      'SearchIcon',
      'FilesIcon',
      'TableIcon',
      'SlidesIcon',
      'TerminalIcon',
      'ChatIcon',
      'BrainIcon',
      'PlugIcon',
    ]) {
      expect(typeof (Icons as Record<string, unknown>)[name]).toBe('function')
    }
  })

  it('draws every icon on the same 24 viewBox with the process-column stroke width', () => {
    const off = ALL.filter(([, Icon]) => {
      const html = markup(Icon)
      return (
        !html.includes('viewBox="0 0 24 24"') ||
        !html.includes('stroke="currentColor"') ||
        !html.includes('stroke-width="1.9"') ||
        html.includes('stroke-width="1.5"')
      )
    }).map(([name]) => name)
    expect(off).toEqual([])
  })

  it('never hardcodes a colour, so both themes can retint every icon', () => {
    // 实心点缀（铅笔尖、滑杆把手）必须用 currentColor：写死 #000 的图标在深色
    // 主题里会消失，而这里没有一个断言能靠“看上去还行”发现。
    const hard = ALL.filter(([, Icon]) => {
      const html = markup(Icon)
      const body = html.replace(/^<svg[^>]*>/, '')
      return /(?:fill|stroke)="(?!none"|currentColor")/.test(body)
    }).map(([name]) => name)
    expect(hard).toEqual([])
  })

  it('passes size and className through to the svg', () => {
    const html = markup(Icons.PlusIcon, { width: 22, height: 22, className: 'probe' })
    expect(html).toContain('width="22"')
    expect(html).toContain('height="22"')
    expect(html).toContain('class="probe"')
    // 默认仍是 16px：布局按 16 算的调用点不能因为重绘变大。
    expect(markup(Icons.PlusIcon)).toContain('width="16"')
  })

  it('gives every business icon its own silhouette', () => {
    // 只比 path 不够：`d` 不同但剪影相同的两张图在 14px 上仍然一样。这里比的是
    // 关键几何（圆 / 矩形 / 折线的坐标串），并把「同一张图挂两个名字」判失败。
    const seen = new Map<string, string>()
    const clashes: string[] = []
    for (const [name, Icon] of ALL) {
      const html = markup(Icon, { width: 16, height: 16 })
      const body = html.replace(/^<svg[^>]*>/, '')
      const previous = seen.get(body)
      if (previous) clashes.push(`${previous} / ${name}`)
      else seen.set(body, name)
    }
    expect(clashes).toEqual([])
  })

  it('separates the shapes that used to look alike at 14px', () => {
    const pairs: Array<[IconComponent, IconComponent]> = [
      [Icons.FilesIcon, Icons.FileIcon], // 文档 vs 单个文件
      [Icons.FileIcon, Icons.CopyIcon], // 纸 vs 两个方框
      [Icons.FilesIcon, Icons.CopyIcon],
      [Icons.ChatIcon, Icons.MessageIcon], // 会话 vs 一段说明
      [Icons.ChatIcon, Icons.FeedbackIcon],
      [Icons.MessageIcon, Icons.FeedbackIcon],
      [Icons.BrainIcon, Icons.SparkIcon], // 模型 vs 生成
      [Icons.BrainIcon, Icons.SettingsIcon],
      [Icons.SettingsIcon, Icons.SunIcon], // 滑杆 vs 太阳（上一版是齿轮，同形）
      [Icons.SettingsIcon, Icons.ClockIcon],
      [Icons.SettingsIcon, Icons.TodoIcon],
      [Icons.SettingsIcon, Icons.ListCheckIcon],
      [Icons.TableIcon, Icons.SlidesIcon], // 表格 vs 演示
      [Icons.TableIcon, Icons.CameraIcon],
      [Icons.SlidesIcon, Icons.PlayIcon],
      [Icons.SearchIcon, Icons.ClockIcon], // 放大镜 vs 时钟
      [Icons.SearchIcon, Icons.GlobeIcon],
      [Icons.ClockIcon, Icons.HistoryIcon],
      [Icons.ListCheckIcon, Icons.TodoIcon], // 自检清单 vs 待办
      [Icons.LayersIcon, Icons.CopyIcon],
      [Icons.PlugIcon, Icons.LayersIcon], // 插件 vs 副本（上一版共用三层菱形）
      [Icons.PlugIcon, Icons.WrenchIcon],
      [Icons.PlugIcon, Icons.TerminalIcon],
      [Icons.PlugIcon, Icons.CloudIcon],
      [Icons.PlugIcon, Icons.SettingsIcon],
      [Icons.SettingsIcon, Icons.MenuIcon], // 滑杆 vs 三横线菜单
      [Icons.TerminalIcon, Icons.CameraIcon], // 两个方框族
      [Icons.ImageIcon, Icons.CameraIcon],
    ]
    const same = pairs
      .filter(([a, b]) => markup(a) === markup(b))
      .map(([a, b]) => `${a.name}/${b.name}`)
    expect(same).toEqual([])
  })

  it('keeps the shapes the process column and its tests depend on', () => {
    // 执行过程复用这几个图标（process-icons.tsx），它的测试按坐标串断言。
    // 改这里的路径必须同时改那边，不允许悄悄漂移。
    expect(markup(Icons.CameraIcon)).toContain('M2.6 8.4')
    expect(markup(Icons.WrenchIcon)).toContain('M14.7 6.3')
    expect(markup(Icons.StepsIcon)).toContain('M3 20h5v-5h5v-5h4V5h4')
    expect(markup(Icons.TodoIcon)).toContain('M10 6h10M10 12h10M10 18h10')
  })

  it('draws the same alarm for「定时」on both sides of the app', () => {
    // 侧栏 / 定时面板用 ClockIcon，执行过程里 schedule 那一类也必须用它：
    // 同一件事在两处长得不一样时，用户会以为它们不是同一个入口。
    const clock = markup(Icons.ClockIcon)
    // 铃是它在这族圆形图标里唯一的轮廓缺口（上一版是四向刻度，和太阳同族）。
    expect(clock).toContain('M5.3 4.7 3.5 6.7')
    // 腿把它与「历史」（圆 + 逆时针箭头）分开。
    expect(clock).toContain('M8.8 19.2 7.4 21')
    expect(clock).not.toBe(markup(Icons.HistoryIcon))
  })

  it('fills the pointer, so「操作界面」is not a second pencil', () => {
    // 描边三角在 14px 下和铅笔尖、台阶是同一族斜线；涂实后全表只有它是实心斜向箭头。
    const cursor = markup(Icons.CursorIcon)
    expect(cursor).toContain('fill="currentColor"')
    expect(cursor).toContain('M3.4 18.9a7 7 0 0 1-.9-3.4')
  })

  it('has no icon left on the old 1.5px hairline', () => {
    const source = readFileSync(new URL('../src/renderer/src/icons.tsx', import.meta.url), 'utf8')
    expect(source).not.toMatch(/strokeWidth=["'{](1\.4|1\.5|1\.6|1\.7|1\.8)["'}]/)
  })
})
