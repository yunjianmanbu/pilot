// 工作区与文件：workspaces / files（含分块上传）。
// 由 server.ts 的 handleRequest switch 按域拆出；协议文案与错误提示保持原样。
import { randomUUID } from 'node:crypto'
import type { FileNode, FilePreview } from '../../../shared/types'
import { collectSessionArtifacts } from '../../agent/artifacts'
import { abortWorkspaceUpload, appendWorkspaceUpload, beginWorkspaceUpload, finishWorkspaceUpload, listDirectory, MAX_UPLOAD_BYTES, MAX_UPLOAD_CHUNK_BYTES, previewFile, readFileChunk } from '../../workspace'
import { MAX_PENDING_UPLOADS, MAX_UPLOAD_CHUNK_BASE64 } from '../constants'
import { requireString } from '../helpers'
import type { CompanionServer } from '../server'
import type { StoredPhone } from '../types'

export async function handleWorkspaceRequest(
  host: CompanionServer,
  method: string,
  params: Record<string, unknown>,
  _phone: StoredPhone,
): Promise<unknown> {
  switch (method) {
    case 'workspaces.list':
      return {
        workspaces: host.options.store.workspaces(),
        // 手机端只能在这些电脑端授权的目录里新建工作区。
        roots: host.options.store.phoneRoots(),
      }
    case 'workspaces.create':
      return host.createWorkspace(params)
    case 'workspaces.browse':
      return host.browseWorkspace(params)
    case 'workspaces.open':
      return host.openWorkspace(params)
    case 'workspaces.remove':
      return host.removeWorkspace(params)
    case 'files.list': {
      const workspacePath = requireString(params['workspacePath'], '工作区', 2_000)
      host.assertWorkspace(workspacePath)
      const directory =
        typeof params['directory'] === 'string' && params['directory']
          ? params['directory'].slice(0, 2_000)
          : '.'
      const nodes: FileNode[] = await listDirectory(workspacePath, directory)
      return { path: workspacePath, directory, nodes }
    }
    case 'files.read': {
      const workspacePath = requireString(params['workspacePath'], '工作区', 2_000)
      host.assertWorkspace(workspacePath)
      const file = requireString(params['file'], '文件', 2_000)
      // A phone preview of a binary file (image/PDF/Office) asks for numbered
      // chunks; a plain read keeps returning the text preview shape.
      if (params['offset'] !== undefined || params['length'] !== undefined) {
        const offset =
          typeof params['offset'] === 'number' && Number.isFinite(params['offset'])
            ? params['offset']
            : 0
        const length =
          typeof params['length'] === 'number' && Number.isFinite(params['length'])
            ? params['length']
            : undefined
        return readFileChunk(workspacePath, file, offset, length)
      }
      const preview: FilePreview = await previewFile(workspacePath, file)
      return preview
    }
    case 'files.upload.begin': {
      host.pruneUploads()
      if (host.pendingUploads.size >= MAX_PENDING_UPLOADS) {
        throw new Error('同时上传的文件太多，请稍后再试')
      }
      const workspacePath = requireString(params['workspacePath'], '工作区', 2_000)
      host.assertWorkspace(workspacePath)
      const directory =
        typeof params['directory'] === 'string' && params['directory'].trim()
          ? params['directory']
          : 'uploads'
      const name = requireString(params['name'], '文件名', 180)
      const sizeValue = params['size']
      if (typeof sizeValue !== 'number' || !Number.isFinite(sizeValue) || sizeValue < 0) {
        throw new Error('文件大小不正确')
      }
      const size = Math.floor(sizeValue)
      if (size > MAX_UPLOAD_BYTES) {
        throw new Error(
          `单个文件不能超过 ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB`,
        )
      }
      const uploadId = randomUUID().replace(/-/g, '')
      const plan = await beginWorkspaceUpload(workspacePath, directory, name, size, uploadId)
      host.pendingUploads.set(uploadId, {
        uploadId,
        workspacePath,
        tempPath: plan.tempPath,
        name,
        size,
        received: 0,
        createdAt: Date.now(),
      })
      return { uploadId, path: plan.path, name: plan.name, size }
    }
    case 'files.upload.chunk': {
      const uploadId = requireString(params['uploadId'], '上传编号', 80)
      const upload = host.pendingUploads.get(uploadId)
      if (!upload) throw new Error('上传已过期，请重新选择文件')
      host.assertUploadFresh(upload)
      const offsetValue = params['offset']
      if (
        typeof offsetValue !== 'number' ||
        !Number.isInteger(offsetValue) ||
        offsetValue < 0
      ) {
        throw new Error('上传分块位置不正确')
      }
      if (offsetValue !== upload.received) {
        throw new Error('上传分块顺序不正确，请重新上传')
      }
      const data = params['data']
      if (typeof data !== 'string' || !data.trim()) throw new Error('上传分块为空')
      const clean = data.replace(/\s+/g, '')
      if (clean.length > MAX_UPLOAD_CHUNK_BASE64) throw new Error('上传分块太大')
      if (clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) {
        throw new Error('上传分块格式不正确')
      }
      const buffer = Buffer.from(clean, 'base64')
      if (!buffer.length) throw new Error('上传分块为空')
      if (buffer.length > MAX_UPLOAD_CHUNK_BYTES) throw new Error('上传分块太大')
      if (upload.received + buffer.length > upload.size) {
        throw new Error('上传数据超过了文件大小')
      }
      await appendWorkspaceUpload(upload.tempPath, buffer)
      upload.received += buffer.length
      return { received: upload.received, size: upload.size }
    }
    case 'files.upload.finish': {
      const uploadId = requireString(params['uploadId'], '上传编号', 80)
      const upload = host.pendingUploads.get(uploadId)
      if (!upload) throw new Error('上传已过期，请重新选择文件')
      host.assertUploadFresh(upload)
      if (upload.received !== upload.size) {
        throw new Error('文件还没有上传完整，请继续上传')
      }
      const finished = await finishWorkspaceUpload(
        upload.workspacePath,
        upload.tempPath,
        upload.name,
        upload.size,
      )
      host.pendingUploads.delete(uploadId)
      return finished
    }
    case 'files.upload.cancel': {
      const uploadId = requireString(params['uploadId'], '上传编号', 80)
      const upload = host.pendingUploads.get(uploadId)
      if (upload) {
        host.pendingUploads.delete(uploadId)
        await abortWorkspaceUpload(upload.tempPath).catch(() => undefined)
      }
      return { ok: true }
    }
    case 'files.session': {
      const sessionId = requireString(params['sessionId'], '会话', 80)
      const session = host.options.store.session(sessionId)
      if (!session) throw new Error('会话不存在')
      // Only paths the agent actually wrote are listed; reading any of them
      // still goes through files.read and its workspace jail.
      return { artifacts: collectSessionArtifacts(session.messages) }
    }
    default:
      throw new Error(`手机端不支持该操作：${method}`)
  }
}