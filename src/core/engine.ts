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
import { mkdir } from 'node:fs/promises'
import { AgentRunner } from '../main/agent/runner'
import { BillingService } from '../main/billing'
import { listSessionChanges, revertSessionFile } from '../main/changes'
import { CheckpointService } from '../main/checkpoints'
import type { CompanionOptions } from '../main/companion/server'
import { ReflectService } from '../main/reflect/service'
import { AgentScheduler } from '../main/scheduler'
import { Store } from '../main/store'
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
  reflect: ReflectService
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
  // Reflection is created after the runner but has to see its failures. The
  // wrapper only forwards the event; the service is wired below.
  let reflect: ReflectService | null = null
  const publishToReflect = (event: RunEvent): void => {
    if (event.type === 'run.failed') void reflect?.onRunFailure(event.message)
    publish(event)
  }
  const runner = new AgentRunner(
    store,
    publishToReflect,
    checkpoints,
    dataDir,
    options.getWindow ?? null,
    options.packageRoot ?? '',
  )
  const scheduler = new AgentScheduler(store, runner, publish)
  // Reflection reads local evidence only and never calls a tool, so it can run
  // on a timer without asking for approval or touching the workspace.
  reflect = new ReflectService(store, publish)
  return { store, billing, checkpoints, runner, scheduler, reflect }
}

/** 客户机用户专用的第二套数据面。 */
export interface GuestEngineOptions {
  /** Host engine: only its model channel (endpoints + keys) is inherited. */
  source: Store
  /** Root the guest store, checkpoints and runner all write under. */
  dataDir: string
  /** Directory handed to client users as their own workspace (created if absent). */
  workspaceDir: string
  /** Fan-out for guest events: they must only reach client-user sockets. */
  publish: (event: RunEvent) => void
  packageRoot?: string
}

/**
 * Build the client-user engine: same classes, different data.
 *
 * A client user must never share the host's store (sessions, memory, settings,
 * billing) or the host's runner (approvals would surface in the owner's window).
 * Giving them a store rooted at their own directory and a runner over it is
 * what makes “independent user” true rather than cosmetic.
 *
 * The model channel is the one thing inherited from the host: without an
 * endpoint and a key the guest store could not run a single turn. Approval
 * policy, trusted commands and memory are deliberately *not* inherited — those
 * are host data.
 *
 * The guest workspace is created and registered here because client users are
 * refused the local-only workspace commands (`workspaces.create` / `browse`):
 * they pick files freely inside this directory, not on the host's disk.
 */
export async function createGuestEngine(options: GuestEngineOptions): Promise<Engine> {
  await mkdir(options.workspaceDir, { recursive: true })
  const store = new Store(options.dataDir)
  await store.load()
  await store.inheritModelChannelFrom(options.source)
  if (!store.workspaces().some((workspace) => workspace.path === options.workspaceDir)) {
    await store.addWorkspace(options.workspaceDir, { activate: store.activeWorkspace() === null })
  }
  return createEngine({
    store,
    dataDir: options.dataDir,
    publish: options.publish,
    ...(options.packageRoot ? { packageRoot: options.packageRoot } : {}),
  })
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
