// IPC 依赖面：registerIpc 与 ipc/ 子模块共享的 getter 集合。
import { appState } from './app-state'
import type { ReviewSessionScope, RunEvent } from '../shared/types'
import { log, benchmarkRows, broadcast, collectSelfCheck, toolRegistryFor } from './diagnostics'
import { isDocumentWindowContents } from './document-window'
import { isSuperWindowContents } from './super-window'
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
import { AsyncLocalStorage } from 'node:async_hooks'
import { ipcMain, session, IpcMainInvokeEvent } from 'electron'

/**
 * Channels a standalone document window may call: read one file, read the
 * palette it should paint with, close itself, and open a link. Everything else
 * stays reserved for the main window, so the preview bundle can never start a
 * run or change a setting. The check is the sender identity, not a filename.
 */
const DOCUMENT_CHANNELS = new Set([
  'pilot:file-preview',
  'pilot:file-open',
  'pilot:doc-state',
  'pilot:doc-close',
  'pilot:open-link',
])

/**
 * 超级 Pilot 窗口能调的通道：它自己的状态、发指令、取消、重开、抢救，外加打开
 * 外链。刻意不包含 `pilot:file-preview` 与任何会话 / 设置通道：应急窗口只能修
 * 自己，不能顺手改用户的业务数据。
 */
const SUPER_CHANNELS = new Set([
  'pilot:super-status',
  'pilot:super-messages',
  'pilot:super-send',
  'pilot:super-cancel',
  'pilot:super-reset',
  'pilot:super-rescue',
  'pilot:super-open',
  'pilot:open-link',
])

/**
 * `pilot serve` 的 `/bridge` 调用：没有窗口，靠事件对象上的标记认来源。
 *
 * 浏览器无法构造它——只有服务器主进程自己的 `invokeIpc()` 会带上这个字段
 * （见 `src/server/main.ts` 的 `bridgeEvent`），因此和桌面端的 sender 身份检查
 * 是同一道门：渲染进程拿不到别的调用入口。
 */
function isServerBridgeCall(event: IpcMainInvokeEvent): boolean {
  return (event as unknown as { pilotBridge?: unknown }).pilotBridge === true
}

function assertTrustedSender(event: IpcMainInvokeEvent, channel: string): void {
  if (isServerBridgeCall(event)) return
  if (appState.mainWindow && !appState.mainWindow.isDestroyed() && event.sender === appState.mainWindow.webContents) return
  if (DOCUMENT_CHANNELS.has(channel) && isDocumentWindowContents(event.sender.id)) return
  if (SUPER_CHANNELS.has(channel) && isSuperWindowContents(event.sender.id)) return
  throw new Error('Rejected IPC call from an unknown page')
}

type PlainHandler = (...args: unknown[]) => unknown

/**
 * 桌面进程里的 handler 表：`ipcMain.handle` 注册的处理器没有公开的调用入口，
 * 而「设置 → 网页服务」开启后，浏览器里的同一套界面必须能调到这三百多个通道。
 * 注册时留一份，`invokeDesktopBridge` 按通道名取出来执行——与窗口里走的是同一
 * 份处理器，不是第二套实现。
 */
const bridgeHandlers = new Map<string, PlainHandler>()

/**
 * 这次调用来自哪个界面：`desktop` 是有原生窗口的客户端，`web` 是浏览器。
 * 只有返回「宿主能力」的通道需要区分（`pilot:bootstrap` 的 host），其余一律
 * 用同一份数据与同一套权限。
 */
const rendererSurface = new AsyncLocalStorage<'desktop' | 'web'>()

/** 当前请求是不是浏览器界面发起的；不在 bridge 作用域里时按桌面窗口处理。 */
export function currentRendererSurface(): 'desktop' | 'web' {
  return rendererSurface.getStore() ?? 'desktop'
}

/** 执行一个已注册的处理器，把主进程的已知错误文案翻译成界面语言。 */
async function runHandler(handler: PlainHandler, args: unknown[]): Promise<unknown> {
  try {
    return await handler(...args)
  } catch (error) {
    // Rejections cross straight into a renderer toast, so translate known
    // main-process copy here. Unknown technical errors pass through.
    const message = error instanceof Error ? error.message : String(error)
    const localized = localizeMain(message, appState.store ? appState.store.uiLocale() : 'zh-CN')
    if (localized !== message) throw new Error(localized)
    throw error
  }
}

/**
 * 浏览器界面通过 `/bridge` 调进来的 IPC 入口。
 *
 * 身份由 companion 的访问级别（本机回环 / 主机用户）先把关，走到这里已经等价于
 * 坐在本机的人，所以不再重复 sender 检查——桌面端那份检查认的是窗口对象，而
 * 浏览器根本没有窗口。
 */
export function invokeDesktopBridge(channel: string, args: unknown[]): Promise<unknown> {
  const handler = bridgeHandlers.get(channel)
  if (!handler) return Promise.reject(new Error(`网页界面没有实现这个功能：${channel}`))
  return rendererSurface.run('web', () => runHandler(handler, args))
}

function handle<Args extends unknown[], Result>(
  channel: string,
  handler: (...args: Args) => Promise<Result> | Result,
): void {
  const plain = handler as unknown as PlainHandler
  bridgeHandlers.set(channel, plain)
  ipcMain.handle(channel, async (event, ...args) => {
    assertTrustedSender(event, channel)
    return runHandler(plain, args as unknown[])
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
    get companionMode() {
      return appState.companionMode
    },
    get rendererSurface() {
      return currentRendererSurface()
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
    get reflect() {
      return appState.reflect
    },
    get supervisor() {
      return appState.supervisor
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
