// 平台相关的窗口辅助：原生窗口配色、开始菜单根目录与 Windows 快捷方式自愈。
import type { ThemeMode } from '../shared/types'
import { appUserModelId, foreignShortcuts, ShortcutIdentity } from './win-identity'
import { app, Menu, shell } from 'electron'
import { existsSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
/** 日志里的 URL 去掉查询串与 hash：凭据常藏在 query 里，路径本身对排错有用。 */
export function safeUrl(raw: string): string {
  try {
    const url = new URL(raw)
    return `${url.origin}${url.pathname}`
  } catch {
    return ''
  }
}

/**
 * Window chrome colours, kept in step with the Islands ladder in styles.css:
 * `#191A1C` dark canvas, `#ffffff` light canvas. They paint the first frame
 * before the renderer boots, so an exact match avoids a flash of the wrong
 * colour on theme switch.
 */
export function windowPalette(theme: ThemeMode): { color: string; symbolColor: string } {
  if (theme === 'light') return { color: '#ffffff', symbolColor: '#191a1c' }
  return { color: '#191a1c', symbolColor: '#e3e5e8' }
}

/**
 * Start-menu folders that can register an AppUserModelID for the current user.
 */
function startMenuRoots(): string[] {
  return [
    join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    join(
      process.env.ProgramData ?? 'C:\\ProgramData',
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
    ),
  ]
}

/**
 * Windows reads the taskbar name and icon of an AppUserModelID from the first
 * Start-menu shortcut that registers it. A stale shortcut that claims an AUMID
 * of ours but launches another executable (the `Electron.lnk` a dev run leaves
 * behind, or one from an install into an older directory) therefore wins over
 * the icon our window reports. Drop those before the first window is created.
 *
 * Guarded twice: packaged builds only, and never the shortcut that launches
 * this executable. An unreadable shortcut is left alone rather than guessed at.
 */
export function healWindowsShortcuts(): void {
  if (process.platform !== 'win32' || !app.isPackaged) return
  const records: ShortcutIdentity[] = []
  for (const root of startMenuRoots()) {
    if (!existsSync(root)) continue
    let names: string[]
    try {
      names = readdirSync(root, { recursive: true, encoding: 'utf8' })
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.toLowerCase().endsWith('.lnk')) continue
      const file = join(root, name)
      try {
        const link = shell.readShortcutLink(file)
        records.push({ path: file, target: link.target, appUserModelId: link.appUserModelId })
      } catch {
        // Not a shortcut Windows can read: not ours to judge.
      }
    }
  }
  for (const stale of foreignShortcuts(records, process.execPath)) {
    try {
      unlinkSync(stale.path)
      console.warn(`[pilot] 已删除占用本应用 AppUserModelID 的陈旧快捷方式: ${stale.path}`)
    } catch {
      // Locked by Explorer; the next install rewrites the shortcut anyway.
    }
  }
}
