// 会话、消息、运行控制、搜索、文件与文档、记忆、知识与检查点。
// 由 index.ts 的 registerIpc 机械搬出：只把 handle 换成 ctx.handle，其余语句逐字保留。
import type { IpcContext } from '../ipc-context'
import { app, BrowserWindow, dialog, nativeImage, session, shell } from 'electron'
import { writeFile } from 'node:fs/promises'
import { collectSessionArtifacts } from '../agent/artifacts'
import { collectSessionLinks } from '../../shared/session-links'
import { buildSessionReport } from '../agent/session-report'
import { dialoguePage, runMessages } from '../session-page'
import { isDocumentWindowContents, openDocumentWindow } from '../document-window'
import { join } from 'node:path'
import { knowledgePairsFor } from '../search'
import { listDirectory, MAX_UPLOAD_BYTES, previewFile, resolveExisting } from '../workspace'
import { renderDocumentPdf } from '../office-render'
import { listSessionChanges, revertSessionFile } from '../changes'
import { localizeChanges, localizeMain } from '../localize'
import { parseUploadBatch } from '../../shared/uploads'
import { normalizeCheckpointScope } from '../../shared/checkpoint-ignore'
import type {
  ApprovalMode,
  CheckpointRestoreMode,
  CheckpointScope,
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
    // Desktop and the local browser console both read this over IPC/loopback:
    // no relay frame budget, so return the replies whole instead of the 3.2k
    // clipped copy the phone page gets.
    return knowledgePairsFor(session.messages, typeof query === 'string' ? query : '', limit, {
      clip: false,
    })
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

  /**
   * 会话报告：拿最新一轮 run 的统计 + 这一轮的消息，拼成人读的 Markdown。
   * 没有 run 记录时返回 null，界面显示「这一轮还没有可报告的运行」而不是编一份。
   */
  const sessionReportOf = (sessionId: string) => {
    const target = ctx.store.session(sessionId)
    if (!target) throw new Error('Session not found')
    const runs = ctx.store
      .runs(target.workspacePath)
      .filter((run) => run.sessionId === sessionId)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    const run = runs[runs.length - 1]
    if (!run) return null
    // 只取这一轮的消息：更早的轮次会混进别人的写文件记录。
    const messages = target.messages.filter((message) => message.runId === run.id)
    return buildSessionReport({
      run,
      messages,
      ...(target.title ? { sessionTitle: target.title } : {}),
    })
  }

  ctx.handle('pilot:session-report', (sessionId: string) => sessionReportOf(sessionId))

  /**
   * 把报告存成 Markdown 文件。默认落在工作区根、文件名取报告标题；
   * 用户取消或没有可报告的运行都返回 null，界面据此不提示成功。
   */
  ctx.handle('pilot:session-report-save', async (sessionId: string) => {
    const target = ctx.store.session(sessionId)
    if (!target) throw new Error('Session not found')
    const report = sessionReportOf(sessionId)
    if (!report) return null
    const base = report.title.replace(/[\\/:*?"<>|\r\n]+/g, '-').trim().slice(0, 80) || 'session-report'
    const picked = await dialog.showSaveDialog({
      title: 'Save session report',
      defaultPath: join(target.workspacePath, `${base}.md`),
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    })
    if (picked.canceled || !picked.filePath) return null
    await writeFile(picked.filePath, report.markdown, 'utf8')
    return picked.filePath
  })

  ctx.handle('pilot:session-activate', async (sessionId: string) => {
    if (!ctx.store.session(sessionId)) return
    ctx.store.setActiveSession(sessionId)
    await ctx.store.save()
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

  ctx.handle(
    'pilot:checkpoint-preview',
    async (
      workspacePath: string,
      // 设置页拿还没保存的草稿来算「切到仅源码会少存多少」，所以这两项可以从
      // 调用方来；省略时用已保存的设置，其它调用方（打开工作区提示）不变。
      options?: { ignore?: readonly string[]; scope?: CheckpointScope },
    ) => {
      if (!ctx.store.workspaces().some((entry) => entry.path === workspacePath)) {
        throw new Error('Workspace not found')
      }
      const stored = ctx.store.settings()
      const ignore = Array.isArray(options?.ignore)
        ? options.ignore.filter((entry): entry is string => typeof entry === 'string')
        : stored.checkpointIgnore
      return ctx.checkpoints.preview({
        workspacePath,
        ignore,
        scope: normalizeCheckpointScope(options?.scope ?? stored.checkpointScope),
      })
    },
  )

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
      scope: ctx.store.settings().checkpointScope,
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
   * Hand one workspace file to the system application: the escape hatch for a
   * document the in-app preview cannot draw (.doc, .xls, an encrypted PDF, a
   * 64 MB scan). The path is resolved inside the open workspace first, so the
   * OS never receives a path the file browser could not have reached.
   */
  ctx.handle('pilot:file-open', async (path: string, file: string) => {
    const target = await resolveExisting(path, file)
    const error = await shell.openPath(target)
    if (error) throw new Error(error)
  })

  /**
   * Draw an Office document the way its own application draws it.
   *
   * The in-app parsers recover text and nothing else, which is not enough to
   * judge a layout before editing it. This channel converts the file with the
   * office suite installed on this machine (WPS → Office → LibreOffice) and
   * returns the PDF bytes; the renderer paints them with the PDF pager it
   * already uses, so no new protocol or web preferences are involved.
   *
   * File access stays behind `resolveExisting`, exactly like `pilot:file-open`:
   * only a path the workspace jail allows can reach an office application.
   */
  ctx.handle('pilot:file-render', async (path: string, file: string) => {
    const target = await resolveExisting(path, file)
    return renderDocumentPdf(target)
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
