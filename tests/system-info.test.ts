import { describe, expect, it } from 'vitest'
import {
  diskSpace,
  diskWarning,
  feedbackEnvironment,
  systemInfo,
} from '../src/main/system-info'
import { DISK_LOW_BYTES, formatBytes } from '../src/shared/system-info'
import { normalizeEnvFields } from '../src/shared/feedback'
import type { SystemInfo } from '../src/shared/types'

const sample: SystemInfo = {
  platform: 'win32',
  osRelease: '10.0.26100',
  arch: 'x64',
  cpuCount: 16,
  cpuModel: 'AMD Ryzen 7',
  memoryTotalBytes: 32 * 1024 ** 3,
  memoryFreeBytes: 8 * 1024 ** 3,
  electron: '44.9.0',
  node: '22.12.0',
  chrome: '140.0.0',
  disk: { path: 'C:\\work', freeBytes: 1024 ** 3, totalBytes: 512 * 1024 ** 3, low: true },
}

describe('formatBytes', () => {
  it('scales to a readable unit and hides unknown readings', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(2 * 1024 ** 3)).toBe('2.0 GB')
    expect(formatBytes(null)).toBe('—')
    expect(formatBytes(-1)).toBe('—')
  })
})

describe('diskSpace', () => {
  it('reports the volume holding an existing directory', async () => {
    const disk = await diskSpace(process.cwd())
    expect(disk.path).toBe(process.cwd())
    expect(disk.freeBytes === null || disk.freeBytes > 0).toBe(true)
    expect(typeof disk.low).toBe('boolean')
  })

  it('returns nulls instead of throwing on a missing path', async () => {
    const disk = await diskSpace('Z:\\pilot-no-such-volume\\nope')
    expect(disk.freeBytes).toBeNull()
    expect(disk.low).toBe(false)
  })
})

describe('systemInfo', () => {
  it('never throws and always fills the runtime versions', async () => {
    const info = await systemInfo(process.cwd())
    expect(info.cpuCount).toBeGreaterThan(0)
    expect(info.memoryTotalBytes).toBeGreaterThan(0)
    expect(info.node).not.toBe('')
    expect(info.disk).not.toBeNull()
  })
})

describe('diskWarning', () => {
  it('warns only when free space is under the threshold', () => {
    expect(diskWarning({ path: '.', freeBytes: 1024, totalBytes: 2048, low: true })).toContain(
      '1.0 KB',
    )
    expect(
      diskWarning({ path: '.', freeBytes: DISK_LOW_BYTES * 2, totalBytes: 1e12, low: false }),
    ).toBeNull()
    expect(diskWarning(null)).toBeNull()
  })
})

describe('formatFeedback', () => {
  it('lists the environment lines a report carries', async () => {
    const { formatFeedback } = await import('../src/shared/feedback')
    const text = formatFeedback({
      id: 'abc',
      createdAt: '2026-01-02T03:04:05.000Z',
      kind: 'bug',
      title: '构建失败',
      body: 'pnpm build 报错',
      contact: '',
      environment: ['os', 'disk'],
      context: {
        version: '0.1.58',
        platform: 'win32 10.0.26200',
        locale: 'zh-CN',
        environment: feedbackEnvironment(sample, null, ['os', 'disk']),
      },
    })
    expect(text).toContain('系统：win32 10.0.26100 (x64)')
    expect(text).toContain('磁盘：剩余 1.0 GB / 512 GB')
    expect(text).not.toContain('沙箱')
  })
})

describe('runCommand disk pre-check', () => {
  it('reports free space alongside the command result', async () => {
    const { runCommand } = await import('../src/main/workspace')
    const result = await runCommand(
      process.cwd(),
      { command: 'node', args: ['-e', 'console.log("ok")'] },
      new AbortController().signal,
    )
    expect(result.ok).toBe(true)
    expect(typeof result.metadata['diskFreeBytes']).toBe('number')
    // A healthy disk must not add noise to the output the model reads.
    expect(result.output).not.toContain('[pilot]')
  })
})

describe('feedbackEnvironment', () => {
  it('renders only the ticked fields, in canonical order', () => {
    const lines = feedbackEnvironment(
      sample,
      { backend: 'wsl-bwrap', available: true },
      normalizeEnvFields(['sandbox', 'os', 'sandbox', 'bogus']),
    )
    expect(lines.map((line) => line.key)).toEqual(['os', 'sandbox'])
    expect(lines[1]?.value).toBe('wsl-bwrap')
  })

  it('degrades to unknown text instead of a broken line', () => {
    const lines = feedbackEnvironment(
      { ...sample, disk: null },
      null,
      normalizeEnvFields(['disk', 'sandbox']),
    )
    expect(lines.map((line) => line.value)).toEqual(['未知', '未知'])
  })
})
