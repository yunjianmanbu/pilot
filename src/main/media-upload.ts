// 图片压缩与上传批次落盘：桌面端把渲染进程发来的图片/附件写进工作区。
import { UPLOAD_DIRECTORY, UploadBatch } from '../shared/uploads'
import { MAX_IMAGE_DATA_URL_CHARS } from './agent/attachments'
import { importWorkspaceBytes, importWorkspaceFile, MAX_UPLOAD_BYTES } from './workspace'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
/**
 * 把一张图片压进一条消息能承受的体积：图片还会经 512 KB 的加密中继发到手机上，
 * 所以逐级降质量、降尺寸，直到塞进上限为止，而不是让整次选择失败。
 */
export function encodeMessageImage(image: Electron.NativeImage): string {
  const size = image.getSize()
  // 下限钳到 320：小截图（比如 240×120 的粘贴图）本身已经比这个还小，
  // 如果不钳，while 一次都不会跑，dataUrl 为空直接报「图片太大」。
  let edge = Math.min(1600, Math.max(320, Math.max(size.width, size.height)))
  let dataUrl = ''
  while (edge >= 320) {
    for (const quality of [82, 72, 62, 52]) {
      const scale = Math.min(1, edge / Math.max(size.width, size.height))
      const resized =
        scale < 1
          ? image.resize({
              width: Math.max(1, Math.round(size.width * scale)),
              height: Math.max(1, Math.round(size.height * scale)),
              quality: 'good',
            })
          : image
      dataUrl = `data:image/jpeg;base64,${resized.toJPEG(quality).toString('base64')}`
      if (dataUrl.length <= MAX_IMAGE_DATA_URL_CHARS) break
    }
    if (dataUrl && dataUrl.length <= MAX_IMAGE_DATA_URL_CHARS) break
    edge = Math.round(edge * 0.75)
  }
  if (!dataUrl || dataUrl.length > MAX_IMAGE_DATA_URL_CHARS) {
    throw new Error('图片太大，请压缩后再添加')
  }
  return dataUrl
}

/**
 * 上传合流点：磁盘路径和内存字节在这里进入同一个工作区目录，
 * 走同一套校验，失败时整批拒绝而不是留下一半文件。
 */
export function uploadBytes(data: ArrayBuffer | Uint8Array): Buffer {
  return ArrayBuffer.isView(data)
    ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    : Buffer.from(new Uint8Array(data))
}

export async function importUploadBatch(workspacePath: string, batch: UploadBatch) {
  // Check every size before the first write so a rejected batch does not leave
  // a half-imported set behind.
  for (const file of batch.paths) {
    const info = await stat(file).catch(() => null)
    if (!info) throw new Error(`找不到要上传的文件：${basename(file)}`)
    if (!info.isFile()) throw new Error(`不能上传文件夹或特殊文件：${basename(file)}`)
    if (info.size > MAX_UPLOAD_BYTES) {
      throw new Error(
        `「${basename(file)}」超过 ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB`,
      )
    }
  }
  const uploaded: Array<{ path: string; name: string; size: number }> = []
  for (const file of batch.paths) {
    uploaded.push(await importWorkspaceFile(workspacePath, UPLOAD_DIRECTORY, file))
  }
  for (const blob of batch.blobs) {
    uploaded.push(
      await importWorkspaceBytes(workspacePath, UPLOAD_DIRECTORY, blob.name, uploadBytes(blob.data)),
    )
  }
  return uploaded
}
