import { describe, expect, it } from 'vitest'
import {
  filterPalette,
  movePaletteCursor,
  type PaletteEntry,
} from '../src/renderer/src/components/command-palette-search'

const COMMANDS: PaletteEntry[] = [
  { id: 'new-session', title: '新建任务', group: '操作', keywords: ['new', 'task'] },
  { id: 'open-settings', title: '打开设置', group: '操作', keywords: ['settings', 'config'] },
  { id: 'view-models', title: '模型', group: '视图', keywords: ['model', 'cost'] },
  { id: 'export-pack', title: '导出工作区包', group: '操作', keywords: ['pack', 'export'] },
]

describe('命令面板检索', () => {
  it('空查询按原顺序返回全部命令', () => {
    expect(filterPalette(COMMANDS, '')).toEqual(COMMANDS)
    expect(filterPalette(COMMANDS, '   ')).toEqual(COMMANDS)
  })

  it('按标题匹配，保留原顺序而不是按相关度重排', () => {
    // 两条都含「工作区」：顺序必须与传入顺序一致，否则光标会在输入过程中跳走。
    const hits = filterPalette(COMMANDS, '工作区')
    expect(hits.map((item) => item.id)).toEqual(['export-pack'])
  })

  it('能搜到只写在别名里的英文单词', () => {
    expect(filterPalette(COMMANDS, 'settings').map((item) => item.id)).toEqual(['open-settings'])
    expect(filterPalette(COMMANDS, 'cost').map((item) => item.id)).toEqual(['view-models'])
  })

  it('大小写与分组名都参与匹配', () => {
    expect(filterPalette(COMMANDS, 'NEW').map((item) => item.id)).toEqual(['new-session'])
    expect(filterPalette(COMMANDS, '视图').map((item) => item.id)).toEqual(['view-models'])
  })

  it('多个关键词是「全部命中」，不是「命中任一」', () => {
    // export 只属于导出包，model 只属于模型页：两个词同时命中才返回空。
    expect(filterPalette(COMMANDS, 'pack export').map((item) => item.id)).toEqual(['export-pack'])
    expect(filterPalette(COMMANDS, 'pack model')).toEqual([])
  })

  it('没有命中时返回空数组，交给面板显示空态', () => {
    expect(filterPalette(COMMANDS, '不存在的命令')).toEqual([])
  })
})

describe('命令面板光标', () => {
  it('向下在末条之后回到第一条，向上在首条之前到末条', () => {
    expect(movePaletteCursor(0, 1, 3)).toBe(1)
    expect(movePaletteCursor(2, 1, 3)).toBe(0)
    expect(movePaletteCursor(0, -1, 3)).toBe(2)
  })

  it('光标落在列表外时按方向给合理起点', () => {
    expect(movePaletteCursor(-1, 1, 3)).toBe(0)
    expect(movePaletteCursor(9, 1, 3)).toBe(0)
    expect(movePaletteCursor(-1, -1, 3)).toBe(2)
  })

  it('列表为空时不返回任何位置', () => {
    expect(movePaletteCursor(0, 1, 0)).toBe(-1)
    expect(movePaletteCursor(0, -1, 0)).toBe(-1)
  })
})
