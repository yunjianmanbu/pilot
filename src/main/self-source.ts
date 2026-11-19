import { access, cp, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

export interface SelfSourceOptions {
  /** True when running from an installed build instead of the source tree. */
  packaged: boolean
  /** Directory that contains the running app: the client dir in dev. */
  appPath: string
  /** Electron's resources directory; holds the embedded source when packaged. */
  resourcesPath: string
  /** Electron userData directory; writable and outside the install location. */
  userDataPath: string
}

export interface SelfSourceResult {
  /** Workspace root that the renderer should open. */
  path: string
  /** True when the embedded source was copied into userData by this call. */
  copied: boolean
  /** True when the returned path is a userData copy instead of the live repo. */
  packaged: boolean
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Source root inside the app bundle, or the live client directory in dev. */
export function selfSourceRoot(options: Pick<SelfSourceOptions, 'packaged' | 'appPath' | 'resourcesPath'>): string {
  return options.packaged ? join(options.resourcesPath, 'source') : options.appPath
}

/**
 * Resolve a workspace that contains Pilot's own desktop source.
 *
 * Development runs use the live repository so edits are picked up by the next
 * build. Installed builds carry a read-only copy under resources/source; the
 * first call copies it to userData so the agent can edit it without touching
 * Program Files (and so the copy survives reinstalls).
 */
export async function prepareSelfSource(options: SelfSourceOptions): Promise<SelfSourceResult> {
  const root = selfSourceRoot(options)
  if (!(await exists(join(root, 'package.json'))) || !(await exists(join(root, 'src')))) {
    throw new Error(
      options.packaged
        ? '当前安装包没有内置源码。请安装包含源码的版本，或在源码仓库中直接运行。'
        : '找不到当前源码目录，无法打开自身源码工作区。',
    )
  }
  if (!options.packaged) {
    return { path: root, copied: false, packaged: false }
  }

  const target = join(options.userDataPath, 'self-src')
  if (await exists(join(target, 'package.json'))) {
    return { path: target, copied: false, packaged: true }
  }
  await mkdir(options.userDataPath, { recursive: true })
  await cp(root, target, { recursive: true, force: true })
  return { path: target, copied: true, packaged: true }
}
