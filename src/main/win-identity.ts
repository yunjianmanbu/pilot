/**
 * Windows identity of the app: the AppUserModelID (AUMID) that the taskbar,
 * the Start menu and toast notifications group by.
 *
 * Windows takes the display name and the icon of that group from the first
 * Start-menu shortcut registered under the AUMID. A development run that
 * claims the product AUMID makes Chromium write `Electron.lnk` — launching
 * `node_modules/electron/dist/electron.exe` — under that very AUMID so toasts
 * have a registration, and from then on the *installed* app shows Electron's
 * name and icon on the taskbar even though its window reports our own logo
 * through `WM_GETICON`. Dev therefore runs under its own AUMID, and a packaged
 * start removes any leftover shortcut that squats an AUMID of ours.
 */

/** The product AUMID; also `appId` in electron-builder.yml and the NSIS shortcut. */
export const PACKAGED_APP_ID = 'com.pilot.agent'

/** Development AUMID: keeps `electron-vite dev` out of the product's identity. */
export const DEV_APP_ID = 'com.pilot.agent.dev'

/** Every AUMID this project owns, packaged or not. */
export const OWN_APP_IDS: readonly string[] = [PACKAGED_APP_ID, DEV_APP_ID]

/** Which AUMID the current process must claim. */
export function appUserModelId(isPackaged: boolean): string {
  return isPackaged ? PACKAGED_APP_ID : DEV_APP_ID
}

/** The slice of a Windows shortcut that decides taskbar identity. */
export interface ShortcutIdentity {
  /** Absolute path of the `.lnk` file. */
  path: string
  /** Executable the shortcut launches; empty when Windows cannot resolve it. */
  target: string
  appUserModelId?: string
}

/** Compare launch targets the way a case-insensitive Windows filesystem does. */
function samePath(a: string, b: string): boolean {
  const normalize = (value: string): string =>
    value.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return normalize(a) === normalize(b)
}

/** Last path segment, lowercased; works for either separator. */
function exeName(value: string): string {
  const parts = value.trim().split(/[\\/]/)
  return (parts[parts.length - 1] ?? '').toLowerCase()
}

/**
 * Shortcuts that claim an AUMID of ours but launch something other than a
 * Pilot executable.
 *
 * Those are the ones that hijack the taskbar name and icon: a stale
 * `Electron.lnk` from a dev run (Chromium writes one to enable toasts), or a
 * shortcut left behind by an uninstall that skipped its cleanup. A shortcut
 * that launches a Pilot executable from another install directory is kept —
 * it carries our icon anyway, and deleting it would break that install — and
 * so is a shortcut whose target Windows could not resolve.
 */
export function foreignShortcuts(
  records: readonly ShortcutIdentity[],
  exePath: string,
  ownIds: readonly string[] = OWN_APP_IDS,
): ShortcutIdentity[] {
  const owned = new Set(ownIds.map((id) => id.toLowerCase()))
  const selfName = exeName(exePath)
  return records.filter((record) => {
    const id = (record.appUserModelId ?? '').toLowerCase()
    if (!owned.has(id)) return false
    if (!record.target) return false
    if (exeName(record.target) === selfName) return false
    return !samePath(record.target, exePath)
  })
}
