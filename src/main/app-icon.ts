import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The window icon and the tray icon both come from here.
 *
 * Windows reads a window's `WM_GETICON` for the taskbar, Alt-Tab and the
 * thumbnail preview, so a window created without an explicit icon has none and
 * the shell falls back to a class icon — a blank square under some themes.
 * Every window the app opens therefore passes this path.
 *
 * The file lives outside the asar on purpose: electron-builder copies it to
 * `resources/build` through `extraResources`, and a `<img>`-less shell API
 * cannot read an icon out of an asar archive.
 */
export function appIconPath(): string {
  const names = process.platform === 'win32' ? ['icon.ico', 'icon.png'] : ['icon.png', 'icon.ico']
  const roots = app.isPackaged
    ? [join(process.resourcesPath, 'build'), join(__dirname, '../../build')]
    : [join(__dirname, '../../build')]
  for (const root of roots) {
    for (const name of names) {
      const file = join(root, name)
      if (existsSync(file)) return file
    }
  }
  return ''
}

/** `BrowserWindow` options fragment that adds the icon when the file exists. */
export function windowIconOption(): { icon?: string } {
  const icon = appIconPath()
  return icon ? { icon } : {}
}
