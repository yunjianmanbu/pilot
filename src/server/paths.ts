/**
 * Data-directory resolution shared by every headless command.
 *
 * `serve`, `update` and `run` must agree on where the store lives, and the
 * electron shim reads `PILOT_USER_DATA_DIR` on every call, so the value is
 * published to the environment once instead of being recomputed per host.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Same layout the Electron build uses, for a machine with no desktop session. */
export function defaultDataDir(): string {
  const home = homedir()
  if (process.platform === 'win32') {
    return join((process.env['APPDATA'] ?? '').trim() || home, 'Pilot')
  }
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Pilot')
  }
  const xdg = (process.env['XDG_DATA_HOME'] ?? '').trim()
  return join(xdg || join(home, '.local', 'share'), 'pilot')
}

/**
 * Resolve the data directory once and publish it to the electron shim.
 *
 * Precedence: explicit flag, then `PILOT_USER_DATA_DIR`, then the per-platform
 * default. A relative value is left as-is; the store resolves against cwd.
 */
export function applyDataDir(override: string): string {
  const dir =
    override.trim() || (process.env['PILOT_USER_DATA_DIR'] ?? '').trim() || defaultDataDir()
  process.env['PILOT_USER_DATA_DIR'] = dir
  return dir
}
