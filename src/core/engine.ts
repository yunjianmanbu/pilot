/**
 * Shared engine assembly.
 *
 * The desktop app (`src/main/index.ts`, Electron) and the headless server
 * (`src/server/main.ts`, `pilot serve`) run the same engine: one store, one
 * checkpoint service, one runner, one scheduler, one companion server. Only the
 * host differs, and only in where events go and which desktop-only features
 * exist.
 *
 * Both hosts used to build that chain themselves and copy the two companion
 * adapters verbatim, so a change made for one host could silently miss the
 * other. Everything both hosts share lives here now; the hosts keep only what
 * is genuinely host-specific (the window, the updater, the event fan-out).
 */
import type { BrowserWindow } from 'electron'
import { AgentRunner } from '../main/agent/runner'
import { BillingService } from '../main/billing'
import { listSessionChanges, revertSessionFile } from '../main/changes'
import { CheckpointService } from '../main/checkpoints'
import type { CompanionOptions } from '../main/companion/server'
import { AgentScheduler } from '../main/scheduler'
import type { Store } from '../main/store'
import type { RunEvent } from '../shared/types'

/** What a host must supply to run the engine. Kept deliberately small. */
export interface EngineHostOptions {
  store: Store
  /** Directory the store, checkpoints and the runner all write under. */
  dataDir: string
  /**
   * Fan-out for engine events. The desktop host mirrors them into the window,
   * the OS notifier and the companion socket; the server host only has the
   * companion socket.
   */
  publish: (event: RunEvent) => void
  /** Desktop hosts pass theirs so tools can show or restore the window. */
  getWindow?: () => BrowserWindow | null
  /** Root of the bundled quality baseline; empty when the host ships none. */
  packageRoot?: string
}

export interface Engine {
  store: Store
  billing: BillingService
  checkpoints: CheckpointService
  runner: AgentRunner
  scheduler: AgentScheduler
}

/**
 * Build the engine the same way in every host. Order matters: checkpoints
 * before the runner (the runner snapshots through them), the runner before the
 * scheduler (the scheduler drives it). `scheduler.start()` stays with the host,
 * because the host decides when the process is ready to take work.
 */
export function createEngine(options: EngineHostOptions): Engine {
  const { store, dataDir, publish } = options
  const billing = new BillingService({ store })
  const checkpoints = new CheckpointService(dataDir, store)
  const runner = new AgentRunner(
    store,
    publish,
    checkpoints,
    dataDir,
    options.getWindow ?? null,
    options.packageRoot ?? '',
  )
  const scheduler = new AgentScheduler(store, runner, publish)
  return { store, billing, checkpoints, runner, scheduler }
}

type EngineSlice = Pick<Engine, 'store' | 'checkpoints'>

/**
 * Checkpoint controls the panel drives (list, manual snapshot, restore). This
 * block existed twice, character for character, before this file existed.
 */
export function checkpointBridge(
  engine: EngineSlice,
): NonNullable<CompanionOptions['checkpoints']> {
  const { store, checkpoints } = engine
  return {
    removeSession: (sessionId) => checkpoints.removeSession(sessionId),
    list: (sessionId) => checkpoints.list(sessionId),
    create: async (sessionId, label) => {
      const session = store.session(sessionId)
      if (!session) throw new Error('Session not found')
      const english = store.uiLocale() === 'en'
      return checkpoints.create({
        sessionId,
        workspacePath: session.workspacePath,
        label:
          label?.trim() ||
          (english
            ? `Manual snapshot ${new Date().toLocaleString('en-US')}`
            : `手动快照 ${new Date().toLocaleString('zh-CN')}`),
        messageCount: session.messages.length,
        trigger: 'manual',
        retention: store.settings().checkpointRetention,
        maxBytes: store.settings().checkpointMaxBytes,
        ignore: store.settings().checkpointIgnore,
      })
    },
    restore: (sessionId, checkpointId, mode) =>
      checkpoints.restore(sessionId, checkpointId, mode),
  }
}

/** Per-file change list and revert behind the panel's diff view. */
export function changesBridge(
  engine: EngineSlice,
): NonNullable<CompanionOptions['changes']> {
  const { store, checkpoints } = engine
  return {
    list: async (sessionId) => {
      const session = store.session(sessionId)
      if (!session) throw new Error('Session not found')
      return listSessionChanges(session, checkpoints)
    },
    revert: async (sessionId, path) => {
      const session = store.session(sessionId)
      if (!session) throw new Error('Session not found')
      return revertSessionFile(session, checkpoints, path)
    },
  }
}
