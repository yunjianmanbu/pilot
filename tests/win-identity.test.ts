import { describe, expect, it } from 'vitest'
import {
  DEV_APP_ID,
  PACKAGED_APP_ID,
  appUserModelId,
  foreignShortcuts,
  type ShortcutIdentity,
} from '../src/main/win-identity'

const EXE = 'C:\\Users\\me\\AppData\\Local\\Programs\\Pilot\\Pilot.exe'

const shortcut = (
  path: string,
  target: string,
  appUserModelId?: string,
): ShortcutIdentity => ({ path, target, appUserModelId })

describe('appUserModelId', () => {
  it('claims the product AUMID only when packaged', () => {
    expect(appUserModelId(true)).toBe('com.pilot.agent')
    expect(appUserModelId(false)).toBe('com.pilot.agent.dev')
  })

  it('keeps dev out of the product identity', () => {
    expect(appUserModelId(false)).not.toBe(appUserModelId(true))
    expect(DEV_APP_ID.startsWith(PACKAGED_APP_ID)).toBe(true)
  })
})

describe('foreignShortcuts', () => {
  it('drops the Electron.lnk a dev run leaves on the product AUMID', () => {
    const stale = shortcut(
      'C:\\Start Menu\\Electron.lnk',
      'E:\\repo\\pilot\\client\\node_modules\\electron\\dist\\electron.exe',
      PACKAGED_APP_ID,
    )
    expect(foreignShortcuts([stale], EXE)).toEqual([stale])
  })

  it('keeps our own shortcut even though it shares the AUMID', () => {
    const own = shortcut('C:\\Start Menu\\Pilot.lnk', EXE, PACKAGED_APP_ID)
    expect(foreignShortcuts([own], EXE)).toEqual([])
  })

  it('matches the target regardless of case and separators', () => {
    const own = shortcut(
      'C:\\Start Menu\\Pilot.lnk',
      'c:/users/me/appdata/local/programs/pilot/PILOT.EXE',
      PACKAGED_APP_ID,
    )
    expect(foreignShortcuts([own], EXE)).toEqual([])
  })

  it('keeps a shortcut that launches Pilot from another install directory', () => {
    const otherInstall = shortcut(
      'C:\\Start Menu\\Pilot (D).lnk',
      'D:\\Apps\\Pilot\\Pilot.exe',
      PACKAGED_APP_ID,
    )
    expect(foreignShortcuts([otherInstall], EXE)).toEqual([])
  })

  it('ignores shortcuts that belong to another app', () => {
    const other = shortcut('C:\\Start Menu\\Editor.lnk', 'C:\\Editor\\editor.exe', 'com.other.app')
    expect(foreignShortcuts([other], EXE)).toEqual([])
  })

  it('ignores shortcuts with no AUMID at all', () => {
    const plain = shortcut('C:\\Start Menu\\Plain.lnk', 'C:\\Editor\\editor.exe')
    expect(foreignShortcuts([plain], EXE)).toEqual([])
  })

  it('keeps a shortcut whose target Windows could not resolve', () => {
    const broken = shortcut('C:\\Start Menu\\Broken.lnk', '', PACKAGED_APP_ID)
    expect(foreignShortcuts([broken], EXE)).toEqual([])
  })

  it('also cleans shortcuts left under the dev AUMID', () => {
    const devStale = shortcut(
      'C:\\Start Menu\\Electron.lnk',
      'E:\\repo\\pilot\\client\\node_modules\\electron\\dist\\electron.exe',
      DEV_APP_ID,
    )
    expect(foreignShortcuts([devStale], EXE)).toEqual([devStale])
  })

  it('drops a stale shortcut pointing at a deleted install of another app', () => {
    const stale = shortcut('C:\\Start Menu\\Old.lnk', 'C:\\Gone\\other-tool.exe', PACKAGED_APP_ID)
    expect(foreignShortcuts([stale], EXE)).toEqual([stale])
  })

  it('picks only the squatters out of a mixed Start-menu listing', () => {
    const records = [
      shortcut('C:\\Start Menu\\Electron.lnk', 'C:\\old\\electron.exe', PACKAGED_APP_ID),
      shortcut('C:\\Start Menu\\Pilot.lnk', EXE, PACKAGED_APP_ID),
      shortcut('C:\\Start Menu\\Editor.lnk', 'C:\\Editor\\editor.exe', 'com.other.app'),
    ]
    expect(foreignShortcuts(records, EXE).map((record) => record.path)).toEqual([
      'C:\\Start Menu\\Electron.lnk',
    ])
  })
})
