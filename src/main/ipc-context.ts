// IPC 依赖面：registerIpc 与 ipc/ 子模块共享的 getter 集合。
import { appState } from './app-state'
import type { ReviewSessionScope, RunEvent } from '../shared/types'
import { log, benchmarkRows, broadcast, collectSelfCheck, toolRegistryFor } from './diagnostics'
import { isDocumentWindowContents } from './document-window'
import { localizeMain } from './localize'
import { encodeMessageImage, uploadBytes, importUploadBatch } from './media-upload'
import { personalService, resolveSelfSourceCached, forgetPersonalService, selfSourceContext, contributionEvidence } from './personal-branch'
import {
  pathKey,
  resolveReviewRoots,
  transcriptText,
  sessionPage,
  sessionPageAround,
} from './session-view'
import { applyTheme } from './window-tray'
import { ipcMain, session, IpcMainInvokeEvent } from 'electron'

/**
 * Channels a standalone document window may call: read one file, read the
 * palette it should paint with, close itself, and open a link. Everything else
 * stays reserved for the main window, so the preview bundle can never start a
 * run or change a setting. The check is the sender identity, not a filename.
 */
const DOCUMENT_CHANNELS = new Set([
  'pilot:file-preview',
  'pilot:doc-state',
  'pilot:doc-close',
  'pilot:open-link',
])

function assertTrustedSender(event: IpcMainInvokeEvent, channel: string): void {
  if (appState.mainWindow && !appState.mainWindow.isDestroyed() && event.sender === appState.mainWindow.webContents) return
  if (DOCUMENT_CHANNELS.has(channel) && isDocumentWindowContents(event.sender.id)) return
  throw new Error('Rejected IPC call from an unknown page')
}

function handle<Args extends unknown[], Result>(
  channel: string,
  handler: (...args: Args) => Promise<Result> | Result,
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    assertTrustedSender(event, channel)
    try {
      return await handler(...(args as Args))
    } catch (error) {
      // Rejections cross straight into a renderer toast, so translate known
      // main-process copy here. Unknown technical errors pass through.
      const message = error instanceof Error ? error.message : String(error)
      const localized = localizeMain(message, appState.store ? appState.store.uiLocale() : 'zh-CN')
      if (localized !== message) throw new Error(localized)
      throw error
    }
  })
}

function normalizeReviewSessions(input: unknown): ReviewSessionScope {
  if (input === 'all') return 'all'
  if (!Array.isArray(input)) return 'workspace'
  const ids = [
    ...new Set(
      input.filter((item): item is string => typeof item === 'string' && item.trim().length > 0),
    ),
  ].slice(0, 50)
  for (const id of ids) {
    if (!appState.store.session(id)) throw new Error(`复盘范围内的会话不存在：${id}`)
  }
  return ids.length > 0 ? ids : 'workspace'
}

  const emitScheduled = (sessionId: string): void => {
    const event: RunEvent = { type: 'scheduled.changed', sessionId }
    broadcast(event)
    appState.companion?.publish(event)
  }

  const emitTodos = (sessionId: string): void => {
    const todos = appState.store.todos(sessionId)
    broadcast({ type: 'todos.changed', sessionId, todos })
    appState.companion?.publish({ type: 'todos.changed', sessionId, todos })
    broadcast({ type: 'session.changed', sessionId })
  }

  const broadcastGlobalProfileChanged = () =>
    broadcast({ type: 'profile.changed', workspacePath: appState.store.activeWorkspace() ?? '' })

export function createIpcContext() {
  return {
    get appLog() {
      return appState.appLog
    },
    get applyTheme() {
      return applyTheme
    },
    get benchmarkRows() {
      return benchmarkRows
    },
    get billing() {
      return appState.billing
    },
    get broadcast() {
      return broadcast
    },
    get broadcastGlobalProfileChanged() {
      return broadcastGlobalProfileChanged
    },
    get checkpoints() {
      return appState.checkpoints
    },
    get collectSelfCheck() {
      return collectSelfCheck
    },
    get companion() {
      return appState.companion
    },
    get contributionEvidence() {
      return contributionEvidence
    },
    get emitScheduled() {
      return emitScheduled
    },
    get emitTodos() {
      return emitTodos
    },
    get encodeMessageImage() {
      return encodeMessageImage
    },
    get feedback() {
      return appState.feedback
    },
    get forgetPersonalService() {
      return forgetPersonalService
    },
    get handle() {
      return handle
    },
    get importUploadBatch() {
      return importUploadBatch
    },
    get log() {
      return log
    },
    get mainWindow() {
      return appState.mainWindow
    },
    get moduleCheck() {
      return appState.moduleCheck
    },
    get normalizeReviewSessions() {
      return normalizeReviewSessions
    },
    get pathKey() {
      return pathKey
    },
    get personalService() {
      return personalService
    },
    get resolveReviewRoots() {
      return resolveReviewRoots
    },
    get resolveSelfSourceCached() {
      return resolveSelfSourceCached
    },
    get runner() {
      return appState.runner
    },
    get selfSourceContext() {
      return selfSourceContext
    },
    get sessionPage() {
      return sessionPage
    },
    get sessionPageAround() {
      return sessionPageAround
    },
    get store() {
      return appState.store
    },
    get toolRegistryFor() {
      return toolRegistryFor
    },
    get transcriptText() {
      return transcriptText
    },
    get updater() {
      return appState.updater
    },
    get uploadBytes() {
      return uploadBytes
    },
  }
}

/** registerIpc 与 ipc/ 子模块共享的依赖面；全部走 getter，闭包读到的始终是模块级最新引用。 */
export type IpcContext = ReturnType<typeof createIpcContext>
