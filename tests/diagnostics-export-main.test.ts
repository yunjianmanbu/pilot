import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import JSZip from 'jszip'

/**
 * 主进程侧的导出路径：真的写一个 zip 到磁盘、再解开核对内容。
 *
 * 这里替掉的只有三样东西——系统保存对话框、沙箱探测、内视取样——因为它们都
 * 需要真实桌面环境。脱敏、组包、zip 编码、写盘、日志记录全部走生产代码。
 *
 * 关键断言是「装进 zip 之后再 grep 一次」：打码过的文本经过 JSON 转义与
 * DEFLATE 压缩后若还原出明文，用户发出去的那一刻就已经泄漏了。
 */

const state = vi.hoisted(() => ({
  canceled: false,
  savePath: '',
  failDialog: false,
}))

vi.mock('electron', () => ({
  app: {
    getVersion: () => '1.3.1',
    isPackaged: false,
    // 真实 Electron 有这个 API；漏了它时导出会在取 scope 前就抛，测不出真正的行为。
    getAppPath: () => 'C:\\Users\\alice\\code\\pilot\\pilot',
    getPath: (name: string) => {
      if (name === 'userData') return 'C:\\Users\\alice\\AppData\\Roaming\\pilot-agent'
      if (name === 'home') return 'C:\\Users\\alice'
      return 'C:\\Users\\alice\\Downloads'
    },
  },
  dialog: {
    showSaveDialog: async () => {
      if (state.failDialog) throw new Error('系统保存对话框在服务器模式（无界面）下不可用，请在桌面端使用。')
      if (state.canceled) return { canceled: true, filePath: undefined }
      return { canceled: false, filePath: state.savePath }
    },
  },
}))

vi.mock('../../src/main/diagnostics', () => ({
  collectSelfCheck: async () => ({
    at: Date.parse('2026-11-26T07:00:00.000Z'),
    version: '1.3.1',
    durationMs: 12,
    counts: { ok: 1, warn: 0, off: 0, broken: 0 },
    items: [
      {
        id: 'model.provider',
        title: '模型接入',
        group: 'model',
        status: 'ok',
        detail: '已接入 deepseek',
        facts: ['C:\\Users\\alice\\code\\demo 可读写'],
      },
    ],
  }),
}))

vi.mock('../../src/main/sandbox', () => ({
  sandboxStatus: async () => ({
    mode: 'auto',
    available: true,
    backend: 'bubblewrap',
    detail: '工作区可写',
    networkIsolation: false,
  }),
}))

vi.mock('../../src/main/system-info', () => ({
  systemInfo: async () => ({
    platform: 'win32',
    osRelease: '10.0.26100',
    arch: 'x64',
    cpuCount: 16,
    cpuModel: 'AMD Ryzen 7',
    memoryTotalBytes: 32 * 1024 ** 3,
    memoryFreeBytes: 8 * 1024 ** 3,
    electron: '38.0.0',
    node: '22.0.0',
    chrome: '140.0.0',
    disk: { path: 'C:\\Users\\alice\\code\\demo', freeBytes: 10 ** 12, totalBytes: 2 * 10 ** 12, low: false },
  }),
}))

import { exportDiagnosticsBundle } from '../src/main/ipc/diagnostics-export'
import type { IpcContext } from '../src/main/ipc-context'

const HOME = 'C:\\Users\\alice'
const USER_DATA = 'C:\\Users\\alice\\AppData\\Roaming\\pilot-agent'
const WORKSPACE = 'C:\\Users\\alice\\code\\demo'
const LOG_DIR = 'C:\\Users\\alice\\AppData\\Roaming\\pilot-agent\\logs'

let dir = ''
let entries: Array<{ area: string; event: string; detail?: Record<string, unknown> }> = []

function ctx(): IpcContext {
  return {
    store: {
      activeWorkspace: () => WORKSPACE,
      workspaces: () => [{ path: WORKSPACE }],
      uiLocale: () => 'zh-CN',
    },
    appLog: {
      dir: LOG_DIR,
      write: (entry: { area: string; event: string; detail?: Record<string, unknown> }) => entries.push(entry),
      recent: async () => [
        {
          at: '2026-11-26T07:00:00.000Z',
          area: 'run',
          event: 'model.error',
          level: 'error',
          // 用两种真实形状：URL 查询串里的 key，以及 JSON 里的键值对。
          detail: { message: `401 from https://api.example.com/v1?apiKey=sk-live-abc123456 & path=${WORKSPACE}`, password: 'hunter2' },
        },
      ],
      prune: async () => {},
    },
    mainWindow: null,
  } as unknown as IpcContext
}

beforeEach(async () => {
  entries = []
  state.canceled = false
  state.failDialog = false
  dir = await mkdtemp(join(tmpdir(), 'pilot-diag-export-'))
  state.savePath = join(dir, 'Pilot-diagnostics.zip')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function bundleTexts(): Promise<Record<string, string>> {
  const zip = await JSZip.loadAsync(await readFile(state.savePath))
  const out: Record<string, string> = {}
  for (const name of Object.keys(zip.files)) out[name] = await zip.file(name)!.async('string')
  return out
}

describe('exportDiagnosticsBundle', () => {
  it('写出 zip，包内路径已换成占位符', async () => {
    const result = await exportDiagnosticsBundle(ctx())

    expect(result.ok).toBe(true)
    expect(result.cancelled).toBe(false)
    expect(result.path).toBe(state.savePath)
    expect(result.bytes).toBeGreaterThan(0)
    expect(result.logLines).toBe(1)
    expect(result.blocked).toEqual([])

    const texts = await bundleTexts()
    expect(Object.keys(texts).sort()).toEqual([
      'README.txt',
      'environment.json',
      'runtime-log.jsonl',
      'self-check.json',
      'self-check.txt',
      'summary.txt',
    ])

    const all = Object.values(texts).join('\n')
    expect(all).toContain('<home>')
    expect(all).toContain('<workspace>')
    // 原始用户目录、工作区、日志目录都不该出现在包里。
    for (const secret of [HOME, USER_DATA, WORKSPACE, LOG_DIR]) {
      expect(all, secret).not.toContain(secret)
    }
  })

  it('解包后依然搜不到 sk- / apiKey / password', async () => {
    await exportDiagnosticsBundle(ctx())
    const texts = await bundleTexts()

    for (const [name, text] of Object.entries(texts)) {
      expect(text, name).not.toMatch(/sk-[A-Za-z0-9]/)
      expect(text.toLowerCase(), name).not.toContain('apikey')
      expect(text.toLowerCase(), name).not.toContain('password')
      expect(text, name).not.toContain('hunter2')
    }

    // 日志确实带上了那条 error，说明不是「因为没收到日志所以搜不到」。
    expect(texts['runtime-log.jsonl']).toContain('model.error')
    expect(texts['runtime-log.jsonl']).toContain('401')
  })

  it('取消时不留文件、不写导出日志', async () => {
    state.canceled = true
    const result = await exportDiagnosticsBundle(ctx())

    expect(result).toEqual({
      ok: false,
      cancelled: true,
      path: null,
      files: 0,
      logLines: 0,
      bytes: 0,
      blocked: [],
    })
    expect(await readdir(dir)).toEqual([])
    expect(entries.filter((entry) => entry.event === 'bundle.exported')).toEqual([])
  })

  it('成功写盘后记一条 bundle.exported，只带文件名不带目录', async () => {
    await exportDiagnosticsBundle(ctx())

    const written = entries.find((entry) => entry.event === 'bundle.exported')
    expect(written?.area).toBe('diagnostics')
    expect(written?.detail?.files).toBe(6)
    expect(written?.detail?.logLines).toBe(1)
    // 只记文件名：别让日志本身变成路径泄漏点。
    expect(written?.detail?.file).toBe('Pilot-diagnostics.zip')
    expect(JSON.stringify(written)).not.toContain(dir)
  })

  it('没有系统保存对话框时抛出，交给 IPC 层转成 ok:false', async () => {
    state.failDialog = true
    await expect(exportDiagnosticsBundle(ctx())).rejects.toThrow('服务器模式')
  })
})
