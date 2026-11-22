// 会话、消息、运行控制、搜索、文件与文档、记忆、知识与检查点。
// 由 index.ts 的 registerIpc 机械搬出：只把 handle 换成 ctx.handle，其余语句逐字保留。
import type { IpcContext } from '../ipc-context'
import { app, BrowserWindow, nativeImage, session, shell } from 'electron'
import { collectSessionArtifacts } from '../agent/artifacts'
import { collectSessionLinks } from '../../shared/session-links'
import { dialoguePage, runMessages } from '../session-page'
import { isDocumentWindowContents, openDocumentWindow } from '../document-window'
import { join } from 'node:path'
import { knowledgePairsFor } from '../search'
import { listDirectory, MAX_UPLOAD_BYTES, previewFile, resolveExisting } from '../workspace'
import { listSessionChanges, revertSessionFile } from '../changes'
import { localizeChanges, localizeMain } from '../localize'
import { parseUploadBatch } from '../../shared/uploads'
import type {
  ApprovalMode,
  CheckpointRestoreMode,
  MessageDelivery,
  MessageOptions,
  MessageSearchFilter,
  Session,
  SessionPage,
  SessionPageOptions,
  StoredMessage,
} from '../../shared/types'

export function registerSessionIpc(ctx: IpcContext): void {


  /**
   * 拖拽或粘贴来的文件。渲染进程能拿到磁盘路径的（拖拽、资源管理器复制）
   * 只传路径，主进程自己复制；拿不到路径的（剪贴板里的虚拟文件）才传字节。
   */
  ctx.handle('pilot:upload-files', async (workspacePath: unknown, input: unknown) => {
    const requested = typeof workspacePath === 'string' ? workspacePath.trim() : ''
    if (!requested) throw new Error('当前会话没有工作区，无法上传文件')
    const known = ctx.store.workspaces().find((entry) => ctx.pathKey(entry.path) === ctx.pathKey(requested))
    if (!known) throw new Error('文件只能上传到已经打开的工作区')
    return ctx.importUploadBatch(known.path, parseUploadBatch(input))
  })


  /**
   * 粘贴进来的图片没有磁盘文件：先解成位图，再走和「图片」按钮同一套压缩，
   * 这样两条链路的体积上限与失败文案不会分叉。
   */
  ctx.handle('pilot:paste-image', async (input: unknown) => {
    const record = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
    const data = record.data
    if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) {
      throw new Error('剪贴板里没有可用的图片')
    }
    const bytes = ctx.uploadBytes(data as ArrayBuffer | Uint8Array)
    if (bytes.length === 0) throw new Error('剪贴板里没有可用的图片')
    if (bytes.length > MAX_UPLOAD_BYTES) throw new Error('图片太大，请压缩后再添加')
    const image = nativeImage.createFromBuffer(bytes)
    if (image.isEmpty()) throw new Error('无法识别剪贴板里的图片')
    return ctx.encodeMessageImage(image)
  })


  ctx.handle('pilot:session-model', async (sessionId: string, modelId: string) => {
    const updated = await ctx.store.setSessionModel(sessionId, modelId)
    // 只影响下一次请求；运行中的任务保持已经开始的这一轮。
    ctx.broadcast({ type: 'session.changed', sessionId })
    return updated
  })


  ctx.handle('pilot:sessions-list', (workspacePath: string) => ctx.store.sessions(workspacePath))

  ctx.handle('pilot:session-get', (sessionId: string) => ctx.store.session(sessionId))

  ctx.handle(
    'pilot:session-page',
    (
      sessionId: string,
      before?: string,
      limit?: number,
      options?: SessionPageOptions,
    ): SessionPage | null => {
      const session = ctx.store.session(sessionId)
      if (!session) return null
      // A dialogue page leaves execution steps out; the reader loads a run on
      // demand instead of dragging every old tool call into the window.
      return options?.dialogue ? dialoguePage(session, before, limit) : ctx.sessionPage(session, before, limit)
    },
  )

  ctx.handle(
    'pilot:session-process',
    (sessionId: string, runId: string, limit?: number): StoredMessage[] => {
      const session = ctx.store.session(sessionId)
      if (!session) return []
      return runMessages(session.messages, runId, limit)
    },
  )

  ctx.handle(
    'pilot:session-around',
    (sessionId: string, messageId: string, limit?: number): SessionPage | null => {
      const session = ctx.store.session(sessionId)
      return session ? ctx.sessionPageAround(session, messageId, limit) : null
    },
  )

  ctx.handle(
    'pilot:search',
    (query: string, limit?: number, filter?: MessageSearchFilter) =>
      ctx.store.searchSessions(query, limit, filter),
  )

  ctx.handle('pilot:knowledge-pairs', (sessionId: string, query?: string, limit?: number) => {
    const session = ctx.store.session(sessionId)
    if (!session) throw new Error('Session not found')
    return knowledgePairsFor(session.messages, typeof query === 'string' ? query : '', limit)
  })

  ctx.handle('pilot:session-links', (sessionId: string) => {
    const session = ctx.store.session(sessionId)
    if (!session) throw new Error('Session not found')
    return collectSessionLinks(session.messages)
  })

  ctx.handle('pilot:session-transcript', (sessionId: string): string => {
    const session = ctx.store.session(sessionId)
    if (!session) throw new Error('Session not found')
    return ctx.transcriptText(session.messages)
  })

  ctx.handle('pilot:session-create', async (workspacePath: string) => {
    const created = await ctx.store.createSession(workspacePath)
    return created
  })

  ctx.handle('pilot:session-delete', async (sessionId: string) => {
    if (ctx.runner.isRunning(sessionId)) await ctx.runner.cancelRun(sessionId)
    await ctx.store.deleteSession(sessionId)
    await ctx.checkpoints.removeSession(sessionId)
  })

  ctx.handle(
    'pilot:session-update',
    async (sessionId: string, input: { title?: string; approvalMode?: ApprovalMode }) => {
      const updated = await ctx.store.updateSession(sessionId, input)
      if (input.approvalMode) ctx.runner.setApprovalMode(sessionId, updated.approvalMode)
      return updated
    },
  )


  ctx.handle(
    'pilot:message-send',
    (sessionId: string, content: string, delivery: MessageDelivery, options?: MessageOptions) =>
      ctx.runner.sendMessage(sessionId, content, delivery, options),
  )

  ctx.handle('pilot:run-cancel', (sessionId: string) => ctx.runner.cancelRun(sessionId))

  ctx.handle('pilot:run-pause', (sessionId: string) => ctx.runner.pauseRun(sessionId))

  ctx.handle('pilot:run-continue', (sessionId: string) => ctx.runner.continueRun(sessionId))

  ctx.handle('pilot:message-edit', (sessionId: string, messageId: string, content: string) =>
    ctx.runner.editMessage(sessionId, messageId, content),
  )

  ctx.handle('pilot:message-delete', (sessionId: string, messageId: string) =>
    ctx.runner.deleteMessage(sessionId, messageId),
  )

  ctx.handle('pilot:run-regenerate', (sessionId: string) => ctx.runner.regenerate(sessionId))

  ctx.handle('pilot:run-retry', (sessionId: string) => ctx.runner.retryRun(sessionId))

  ctx.handle(
    'pilot:approval-decide',
    (callId: string, approved: boolean, reason?: string, remember?: boolean) =>
      ctx.runner.decideApproval(callId, approved, reason, remember === true),
  )


  ctx.handle('pilot:session-fork', async (sessionId: string) => {
    if (ctx.runner.isRunning(sessionId)) {
      throw new Error('请先等待当前任务结束（或暂停）再创建副本')
    }
    return ctx.store.forkSession(sessionId)
  })

  ctx.handle('pilot:session-artifacts', (sessionId: string) => {
    const session = ctx.store.session(sessionId)
    if (!session) throw new Error('Session not found')
    return collectSessionArtifacts(session.messages)
  })

  ctx.handle('pilot:changes-list', async (sessionId: string) => {
    const session = ctx.store.session(sessionId)
    if (!session) throw new Error('Session not found')
    return localizeChanges(await listSessionChanges(session, ctx.checkpoints), ctx.store.uiLocale())
  })

  ctx.handle('pilot:change-revert', async (sessionId: string, path: string) => {
    const session = ctx.store.session(sessionId)
    if (!session) throw new Error('Session not found')
    if (ctx.runner.isRunning(sessionId)) throw new Error('请先等待当前任务结束或暂停后再撤销')
    const result = await revertSessionFile(session, ctx.checkpoints, path)
    ctx.broadcast({ type: 'session.changed', sessionId })
    return result
  })

  ctx.handle('pilot:checkpoints-list', async (sessionId: string) => {
    const list = await ctx.checkpoints.list(sessionId)
    const locale = ctx.store.uiLocale()
    return list.map((checkpoint) => ({
      ...checkpoint,
      label: localizeMain(checkpoint.label, locale),
    }))
  })

  ctx.handle('pilot:checkpoint-create', async (sessionId: string, label?: string) => {
    const session = ctx.store.session(sessionId)
    if (!session) throw new Error('Session not found')
    if (ctx.runner.isRunning(sessionId)) throw new Error('请先等待当前任务结束或暂停后再创建回退点')
    const english = ctx.store.uiLocale() === 'en'
    return ctx.checkpoints.create({
      sessionId,
      workspacePath: session.workspacePath,
      label:
        label?.trim() ||
        (english
          ? `Manual snapshot ${new Date().toLocaleString('en-US')}`
          : `手动快照 ${new Date().toLocaleString('zh-CN')}`),
      messageCount: session.messages.length,
      trigger: 'manual',
      retention: ctx.store.settings().checkpointRetention,
      maxBytes: ctx.store.settings().checkpointMaxBytes,
      ignore: ctx.store.settings().checkpointIgnore,
    })
  })

  ctx.handle(
    'pilot:checkpoint-restore',
    async (sessionId: string, checkpointId: string, mode: CheckpointRestoreMode) => {
      if (ctx.runner.isRunning(sessionId)) {
        throw new Error('请先等待当前任务结束或暂停后再回退')
      }
      const result = await ctx.checkpoints.restore(sessionId, checkpointId, mode)
      ctx.broadcast({ type: 'session.changed', sessionId })
      return result
    },
  )

  ctx.handle('pilot:memory-add', async (path: string, content: string) => {
    const entry = await ctx.store.addMemory(path, content, 'user')
    ctx.broadcast({ type: 'memory.changed', workspacePath: path })
    return entry
  })

  ctx.handle('pilot:memory-delete', async (path: string, memoryId: string) => {
    await ctx.store.deleteMemory(path, memoryId)
    ctx.broadcast({ type: 'memory.changed', workspacePath: path })
  })

  ctx.handle('pilot:run-reflect', async (sessionId: string, runId: string) => {
    const session = ctx.store.session(sessionId)
    if (!session) throw new Error('Session not found')
    const entries = await ctx.runner.evolution.reflect(session.workspacePath, runId, true)
    if (entries.length > 0) {
      ctx.broadcast({ type: 'memory.changed', workspacePath: session.workspacePath })
    }
    return entries
  })


  ctx.handle('pilot:files-list', async (path: string, directory: string) => {
    await resolveExisting(path, '.')
    return listDirectory(path, directory || '.')
  })

  ctx.handle('pilot:file-preview', async (path: string, file: string) => {
    await resolveExisting(path, '.')
    return previewFile(path, file)
  })

  ctx.handle('pilot:file-reveal', async (path: string, file: string) => {
    const target = await resolveExisting(path, file)
    shell.showItemInFolder(target)
  })


  /**
   * Open one file in its own window. The workspace still has to be one the user
   * opened, and the path is resolved (and jail-checked) before a window exists.
   */
  ctx.handle('pilot:doc-open', async (workspace: string, file: string) => {
    const root = await resolveExisting(workspace, '.')
    await resolveExisting(root, file)
    openDocumentWindow({
      workspace: root,
      relativePath: file,
      preload: join(__dirname, '../preload/index.js'),
      theme: ctx.store.settingsView().theme,
    })
  })

  /** What a standalone document window needs to paint itself like the app. */
  ctx.handle('pilot:doc-state', () => {
    const settings = ctx.store.settingsView()
    return {
      theme: settings.theme,
      contrast: settings.contrast,
      saturation: settings.saturation,
      fontSize: settings.fontSize,
      locale: ctx.store.uiLocale(),
      version: app.getVersion(),
      platform: process.platform,
    }
  })

  ctx.handle('pilot:doc-close', () => {
    const focused = BrowserWindow.getFocusedWindow()
    if (focused && isDocumentWindowContents(focused.webContents.id)) focused.close()
  })
}
