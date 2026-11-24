import { describe, expect, it } from 'vitest'
import {
  PROTECTED_APP_NAMES,
  parseProcessList,
  selectKillTargets,
  windowsKillArgs,
  type ProcessNode,
} from '../src/main/workspace/process-tree'

const node = (pid: number, parentPid: number, name: string): ProcessNode => ({
  pid,
  parentPid,
  name,
})

describe('parseProcessList', () => {
  it('reads pid,parentPid,name and ignores the blank tail', () => {
    const nodes = parseProcessList('100,1,node.exe\n200,100,bash.exe\n\n')
    expect(nodes).toEqual([node(100, 1, 'node.exe'), node(200, 100, 'bash.exe')])
  })

  it('keeps commas that belong to the name column', () => {
    expect(parseProcessList('7,1,a,b.exe')).toEqual([node(7, 1, 'a,b.exe')])
  })

  it('drops lines that are not a process row', () => {
    expect(parseProcessList('ProcessId,ParentProcessId,Name\nx,1,y.exe\n0,0,z.exe')).toEqual([])
  })
})

describe('selectKillTargets', () => {
  it('kills the whole tree when nothing is protected', () => {
    const nodes = [
      node(10, 1, 'cmd.exe'),
      node(11, 10, 'node.exe'),
      node(12, 11, 'vitest.exe'),
      node(13, 1, 'explorer.exe'),
    ]
    const { kill, spared } = selectKillTargets(10, nodes)
    expect(kill.sort((a, b) => a - b)).toEqual([10, 11, 12])
    expect(spared).toEqual([])
  })

  it('spares an Office window opened by the command, and its children', () => {
    const nodes = [
      node(20, 1, 'powershell.exe'),
      node(21, 20, 'WINWORD.EXE'),
      node(22, 21, 'WINWORD.EXE'),
      node(23, 20, 'conhost.exe'),
    ]
    const { kill, spared } = selectKillTargets(20, nodes)
    expect(kill.sort((a, b) => a - b)).toEqual([20, 23])
    expect(spared.map((entry) => entry.pid)).toEqual([21])
  })

  it('still kills the root when the command itself is a protected app', () => {
    const { kill, spared } = selectKillTargets(30, [node(30, 1, 'winword.exe')])
    expect(kill).toEqual([30])
    expect(spared).toEqual([])
  })

  it('lists children before their parents so pipes close early', () => {
    const nodes = [node(40, 1, 'cmd.exe'), node(41, 40, 'node.exe')]
    expect(selectKillTargets(40, nodes).kill).toEqual([41, 40])
  })

  it('covers the WPS suite as well', () => {
    const names = PROTECTED_APP_NAMES.join(' ')
    expect(names).toContain('wps.exe')
    expect(names).toContain('et.exe')
  })
})

describe('windowsKillArgs', () => {
  it('never emits /T, even without a snapshot', () => {
    const { batches, spared } = windowsKillArgs(42, null)
    expect(batches).toEqual([['/pid', '42', '/F']])
    expect(batches.flat()).not.toContain('/T')
    expect(spared).toEqual([])
  })

  it('kills the root first and leaves the Office window out of the second batch', () => {
    const nodes = [
      node(50, 1, 'powershell.exe'),
      node(51, 50, 'WINWORD.EXE'),
      node(52, 50, 'conhost.exe'),
    ]
    const { batches, spared } = windowsKillArgs(50, nodes)
    expect(batches).toEqual([
      ['/pid', '50', '/F'],
      ['/pid', '52', '/F'],
    ])
    expect(batches.flat()).not.toContain('/T')
    expect(spared.map((entry) => entry.pid)).toEqual([51])
  })

  it('does not kill the root twice', () => {
    const nodes = [node(60, 1, 'cmd.exe'), node(61, 60, 'node.exe')]
    const { batches } = windowsKillArgs(60, nodes)
    expect(batches).toEqual([
      ['/pid', '60', '/F'],
      ['/pid', '61', '/F'],
    ])
  })
})
