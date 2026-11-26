// 工作区导出包（`.pilotpack.zip`）的导出与导入。
//
// 这里只做三件事：弹对话框拿路径、把主进程的读写拼起来、把握手结果转成
// 界面能直接显示的计数。格式定义在 `shared/workspace-pack.ts`，落盘在
// `main/workspace-pack.ts`，密钥重新加密在 `store.applyWorkspacePack`。
import { app, dialog } from 'electron'
import { hostname } from 'node:os'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import type { IpcContext } from '../ipc-context'
import {
  normalizePackScope,
  packFileName,
  scopeIsEmpty,
  type WorkspacePackImportResult,
  type WorkspacePackScope,
} from '../../shared/workspace-pack'
import { readWorkspacePack, writeWorkspacePack } from '../workspace-pack'

/** 导入时用户在目录选择框点了取消：不是错误，按「取消」返回。 */
class PackImportCancelled extends Error {}

function cancelledImport(): WorkspacePackImportResult {
  return {
    ok: false,
    workspacePath: null,
    workspaceName: null,
    manifest: null,
    sessions: 0,
    messages: 0,
    todos: 0,
    scheduled: 0,
    files: 0,
    fileBytes: 0,
    checkpoints: 0,
    secretsApplied: 0,
    settingsApplied: false,
    cancelled: true,
    warnings: [],
  }
}

/**
 * 把包内相对路径拼到 `root` 下，并确认结果没有跑到 `root` 外面。
 *
 * 读包那一层已经校验过条目名（拒绝绝对路径、盘符与 `..`），这里是第二道闸：
 * 写盘是唯一不可撤销的动作。
 */
function resolveInside(root: string, relative: string): string {
  const base = resolve(root)
  const target = resolve(base, ...relative.split('/'))
  if (target !== base && !target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)) {
    throw new Error(`导出包里的路径越界：${relative}`)
  }
  return target
}

export function registerPackIpc(ctx: IpcContext): void {
  /**
   * 导出：范围由界面勾选后传入，缺省按 `DEFAULT_PACK_SCOPE`。
   *
   * 密钥在这一步被解成明文写进 zip（见 `store.workspacePackSnapshot`），
   * 所以返回结果只报条数，不回传任何值与路径以外的信息。
   */
  ctx.handle(
    'pilot:pack-export',
    async (workspacePath: string, rawScope?: Partial<WorkspacePackScope>) => {
      const detail = ctx.store.workspaceDetail(workspacePath)
      const scope = normalizePackScope(rawScope)
      if (scopeIsEmpty(scope)) throw new Error('至少需要勾选一项导出内容')

      const options = {
        title: '导出工作区',
        defaultPath: join(app.getPath('documents'), packFileName(detail.workspace.name)),
        filters: [{ name: 'Pilot 工作区包', extensions: ['zip'] }],
      }
      const picked = ctx.mainWindow
        ? await dialog.showSaveDialog(ctx.mainWindow, options)
        : await dialog.showSaveDialog(options)
      if (picked.canceled || !picked.filePath) {
        return { path: null, manifest: null, secretCount: 0 }
      }

      const snapshot = ctx.store.workspacePackSnapshot(workspacePath, scope)
      const written = await writeWorkspacePack({
        snapshot,
        scope,
        manifest: {
          createdAt: new Date().toISOString(),
          appVersion: app.getVersion(),
          platform: process.platform,
          workspace: { name: detail.workspace.name, path: workspacePath },
          origin: hostname(),
        },
        workspacePath,
        checkpointRoot: join(app.getPath('userData'), 'checkpoints'),
        target: picked.filePath,
      })
      return {
        path: picked.filePath,
        manifest: written.manifest,
        secretCount: written.secretCount,
      }
    },
  )

  /**
   * 导入：选包 → （可选）选目标目录 → 落文件 → 合并进本机。
   *
   * 目标目录在读到 manifest 之后才问，这样对话框标题能带上包里的工作区名与
   * 是否含密钥，用户勾选时就知道会覆盖什么。任何失败都返回 `ok:false`，
   * 界面据此保留对话框并显示原因。
   */
  ctx.handle('pilot:pack-import', async (targetPath?: string) => {
    const picked = ctx.mainWindow
      ? await dialog.showOpenDialog(ctx.mainWindow, {
          title: '导入 Pilot 工作区包',
          properties: ['openFile'],
          filters: [{ name: 'Pilot 工作区包', extensions: ['zip'] }],
        })
      : await dialog.showOpenDialog({
          title: '导入 Pilot 工作区包',
          properties: ['openFile'],
          filters: [{ name: 'Pilot 工作区包', extensions: ['zip'] }],
        })
    if (picked.canceled || !picked.filePaths[0]) return cancelledImport()

    let target = targetPath ? resolve(targetPath) : ''
    let manifest: WorkspacePackImportResult['manifest'] = null
    try {
      const read = await readWorkspacePack(picked.filePaths[0], {
        onManifest: async (incoming) => {
          manifest = incoming
          if (target) return
          const title = incoming.includesSecrets
            ? `导入「${incoming.workspace.name}」到…（此包含密钥）`
            : `导入「${incoming.workspace.name}」到…`
          const chosen = ctx.mainWindow
            ? await dialog.showOpenDialog(ctx.mainWindow, {
                title,
                defaultPath: app.getPath('documents'),
                properties: ['openDirectory', 'createDirectory'],
              })
            : await dialog.showOpenDialog({
                title,
                defaultPath: app.getPath('documents'),
                properties: ['openDirectory', 'createDirectory'],
              })
          if (chosen.canceled || !chosen.filePaths[0]) throw new PackImportCancelled()
          target = resolve(chosen.filePaths[0])
        },
        writeWorkspaceFile: async (relative, data) => {
          const file = resolveInside(target, relative)
          await mkdir(dirname(file), { recursive: true })
          await writeFile(file, data)
        },
        writeCheckpointFile: async (relative, data) => {
          const file = resolveInside(join(app.getPath('userData'), 'checkpoints'), relative)
          await mkdir(dirname(file), { recursive: true })
          await writeFile(file, data)
        },
      })
      if (!target) throw new PackImportCancelled()
      await mkdir(target, { recursive: true })
      const workspaceName = basename(target)
      const applied = await ctx.store.applyWorkspacePack({
        manifest: read.manifest,
        core: read.core,
        sessions: read.sessions,
        secrets: read.secrets,
        workspacePath: target,
        workspaceName,
      })
      ctx.broadcast({ type: 'workspace.changed', workspacePath: target })
      const warnings = [...applied.warnings]
      if (read.skipped.length) warnings.push(`跳过了 ${read.skipped.length} 个无法读取的条目`)
      if (read.manifest.includesSecrets && !read.secrets) {
        warnings.push('包标记含密钥，但没有读到密钥文件')
      }
      return {
        ok: true,
        workspacePath: target,
        workspaceName,
        manifest: read.manifest,
        sessions: applied.sessions,
        messages: read.manifest.counts.messages,
        todos: read.manifest.counts.todos,
        scheduled: applied.scheduled,
        files: read.filesWritten,
        fileBytes: read.manifest.counts.fileBytes,
        checkpoints: read.checkpointFilesWritten,
        secretsApplied: applied.secretsApplied,
        settingsApplied: applied.settingsApplied,
        cancelled: false,
        warnings,
      } satisfies WorkspacePackImportResult
    } catch (error) {
      if (error instanceof PackImportCancelled) return cancelledImport()
      const message = error instanceof Error ? error.message : String(error)
      return {
        ...cancelledImport(),
        ok: false,
        cancelled: false,
        workspacePath: target || null,
        workspaceName: target ? basename(target) : null,
        manifest,
        error: message,
      } satisfies WorkspacePackImportResult
    }
  })
}
