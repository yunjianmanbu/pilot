/**
 * One IPC registration path for both front ends.
 *
 * The desktop window registers these handlers once at startup; `pilot serve`
 * registers the very same set and answers them over `WS /bridge`, so the
 * browser console drives the identical main-process code instead of a second
 * reimplementation of every feature.
 */
import { createIpcContext, type IpcContext } from '../ipc-context'
import { registerCompanionIpc } from './companion'
import { registerPersonalIpc } from './personal'
import { registerSessionIpc } from './session'
import { registerSettingsIpc } from './settings'
import { registerWorkIpc } from './work'

export function registerAllIpc(ctx: IpcContext = createIpcContext()): IpcContext {
  registerSessionIpc(ctx)
  registerWorkIpc(ctx)
  registerSettingsIpc(ctx)
  registerCompanionIpc(ctx)
  registerPersonalIpc(ctx)
  return ctx
}
