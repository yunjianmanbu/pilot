/**
 * Where the running shell lives, asked without a static `import 'electron'`.
 *
 * Two bundle lookups depend on this (vendored plugins and vendored tools), and
 * both must also work when there is no Electron at all: unit tests import those
 * modules under plain Node and the headless server loads them too. The dynamic
 * import is what keeps that possible, but in the main process the bundle is
 * CommonJS, so `await import('electron')` hands back a namespace whose only
 * member is `default` — reading `app` off the namespace yields `undefined`,
 * every candidate path disappears and the vendored bundle silently looks
 * missing. Both shapes are accepted here, and a failure to read the app is
 * reported as "not Electron" rather than thrown.
 */
export interface ElectronAppInfo {
  packaged: boolean
  appPath?: string
  resourcesPath?: string
}

interface ElectronApp {
  isPackaged?: boolean
  getAppPath?: () => string
}

function electronAppOf(mod: unknown): ElectronApp | null {
  if (!mod || typeof mod !== 'object') return null
  const bag = mod as { app?: ElectronApp; default?: { app?: ElectronApp } }
  return bag.app ?? bag.default?.app ?? null
}

/** Electron's `app` facts, or an empty record outside Electron. */
export async function electronAppInfo(): Promise<ElectronAppInfo> {
  let app: ElectronApp | null = null
  try {
    app = electronAppOf(await import('electron'))
  } catch {
    // Not an Electron process (server install or test).
  }

  let appPath: string | undefined
  try {
    appPath = app?.getAppPath?.()
  } catch {
    appPath = undefined
  }

  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath
  return {
    packaged: Boolean(app?.isPackaged),
    ...(appPath ? { appPath } : {}),
    ...(resourcesPath ? { resourcesPath } : {}),
  }
}
