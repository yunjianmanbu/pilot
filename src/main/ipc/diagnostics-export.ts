// 导出诊断包：把内视报告、最近日志、版本 / 平台 / 沙箱状态收齐，脱敏后压成一个 zip，
// 写到用户自己选的位置。主进程只负责「收集 + 脱敏 + 落盘」，从不外传。
//
// 与工作区导出包（`main/workspace-pack.ts`）的区别：那个包带着用户的会话与文件、
// 目的是恢复工作区；这个包只带排障需要的元数据，必须能安全地发给别人。
import { app, dialog } from 'electron'
import { basename, dirname, join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import JSZip from 'jszip'
import type { IpcContext } from '../ipc-context'
import { collectSelfCheck } from '../diagnostics'
import { sandboxStatus } from '../sandbox'
import { systemInfo } from '../system-info'
import {
  buildDiagnosticsBundle,
  diagnosticsFileName,
  type DiagnosticsEnvironment,
  type DiagnosticsExportResult,
  type DiagnosticsFile,
  type DiagnosticsLogRecord,
  type DiagnosticsSandbox,
} from '../../shared/diagnostics-bundle'

/** 同一次运行里连续导出不再重选目录。 */
let lastDir = ''

/**
 * 最近 N 条日志：够看出「卡在哪一步」，又不至于把包撑到几十兆。
 * `AppLog.recent` 默认 200 条，这里取 500 条跨文件回读，仍然只读、不改日志。
 */
const LOG_LIMIT = 500

export type { DiagnosticsExportResult }

function cancelledResult(): DiagnosticsExportResult {
  return { ok: false, cancelled: true, path: null, files: 0, logLines: 0, bytes: 0, blocked: [] }
}

/**
 * 收集运行时事实。
 *
 * 复用 `systemInfo()` 而不是再调一遍 `os` API：它是「不含主机名 / 用户名 / IP /
 * MAC / 序列号」的那一份实现，两处各写一套早晚会漂移出一处泄漏。
 */
async function collectEnvironment(
  workspacePath: string | undefined,
  locale: string,
): Promise<{ environment: DiagnosticsEnvironment; sandbox: DiagnosticsSandbox | null }> {
  const [info, sandbox] = await Promise.all([
    systemInfo(workspacePath).catch(() => null),
    sandboxStatus().catch(() => null),
  ])

  return {
    environment: {
      version: app.getVersion(),
      platform: info ? `${info.platform} ${info.osRelease}` : `${process.platform} ${process.version}`,
      arch: info?.arch ?? process.arch,
      packaged: app.isPackaged,
      locale,
      electron: info?.electron ?? (process.versions.electron ?? 'unknown'),
      node: info?.node ?? process.versions.node,
      chrome: info?.chrome ?? (process.versions.chrome ?? 'unknown'),
      cpuCount: info?.cpuCount,
      cpuModel: info?.cpuModel,
      memoryFreeBytes: info?.memoryFreeBytes ?? null,
      memoryTotalBytes: info?.memoryTotalBytes ?? null,
    },
    sandbox: sandbox
      ? {
          mode: sandbox.mode,
          available: sandbox.available,
          backend: sandbox.backend,
          detail: sandbox.detail,
          networkIsolation: sandbox.networkIsolation,
        }
      : null,
  }
}

/** 把内存里的文件清单压成一个 zip 缓冲。目录结构就是文件名本身。 */
async function zipFiles(files: readonly DiagnosticsFile[]): Promise<Buffer> {
  const zip = new JSZip()
  for (const file of files) zip.file(file.name, file.text)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

/**
 * 导出动作本体。
 *
 * 顺序：收数据 → 建包 → **脱敏闸门** → 弹保存框 → 写盘。
 * 闸门放在弹框之前：自检没过时不让用户白选一次路径，也不会在磁盘上留下一个
 * 「看起来正常」的包。
 */
export async function exportDiagnosticsBundle(
  ctx: IpcContext,
  workspacePath?: string,
): Promise<DiagnosticsExportResult> {
  const generatedAt = new Date()
  const active = workspacePath?.trim() || ctx.store.activeWorkspace() || ''
  const workspaces = ctx.store.workspaces().map((workspace) => workspace.path)
  const userData = app.getPath('userData')
  const logDir = ctx.appLog?.dir ?? ''

  const [environment, logs, selfCheck] = await Promise.all([
    collectEnvironment(active || undefined, ctx.store.uiLocale()),
    ctx.appLog?.recent(LOG_LIMIT).catch(() => []) ?? Promise.resolve([]),
    collectSelfCheck().catch((error: unknown) => ({
      failed: error instanceof Error ? error.message : String(error),
    })),
  ])

  const selfCheckFailed = 'failed' in selfCheck
  const bundle = buildDiagnosticsBundle({
    generatedAt,
    environment: environment.environment,
    sandbox: environment.sandbox,
    selfCheck: selfCheckFailed ? null : selfCheck,
    ...(selfCheckFailed ? { selfCheckError: selfCheck.failed } : {}),
    logs: logs as DiagnosticsLogRecord[],
    logDir,
    workspaces,
    // home 放在 userData 之后由 build 侧按长度排序，这里只管把该打码的路径交出去。
    // appDir 必须单独给：内视「程序目录」与 super-pilot 日志的 workspace 记的就是它。
    scope: {
      home: app.getPath('home'),
      userData,
      appDir: app.getAppPath(),
      paths: [active, ...workspaces, logDir],
    },
  })

  if (bundle.blocked.length > 0) {
    return {
      ok: false,
      cancelled: false,
      path: null,
      files: bundle.files.length,
      logLines: bundle.logLines,
      bytes: 0,
      blocked: bundle.blocked,
      error: `脱敏自检未通过（${bundle.blocked.join('、')}），已取消导出`,
    }
  }

  const options = {
    title: '导出诊断包',
    defaultPath: join(lastDir || app.getPath('downloads'), diagnosticsFileName(generatedAt)),
    filters: [{ name: 'Pilot 诊断包', extensions: ['zip'] }],
  }
  const picked = ctx.mainWindow
    ? await dialog.showSaveDialog(ctx.mainWindow, options)
    : await dialog.showSaveDialog(options)
  if (picked.canceled || !picked.filePath) return cancelledResult()

  const buffer = await zipFiles(bundle.files)
  await mkdir(dirname(picked.filePath), { recursive: true })
  await writeFile(picked.filePath, buffer)
  lastDir = dirname(picked.filePath)

  // 只记文件名与体积：连用户选的目录都不进日志，否则日志本身成了路径泄漏点。
  ctx.appLog?.write({
    area: 'diagnostics',
    event: 'bundle.exported',
    detail: { file: basename(picked.filePath), files: bundle.files.length, logLines: bundle.logLines, bytes: buffer.byteLength },
  })

  return {
    ok: true,
    cancelled: false,
    path: picked.filePath,
    files: bundle.files.length,
    logLines: bundle.logLines,
    bytes: buffer.byteLength,
    blocked: [],
  }
}
