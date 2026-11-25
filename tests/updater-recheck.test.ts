import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateRelease, UpdateState } from '../src/shared/types'

/**
 * 场景：用户当前 1.2.0，已经下载 1.2.1 但没重启，这期间上游又发了 1.2.2。
 * 旧逻辑把 `ready` 当终态：check() 直接返回、下载入口不再出现，用户永远停在 1.2.1。
 * 这里固定两件事：ready 状态下仍会查远端；查到更新的版本就改指向它。
 */

let manifest: Record<string, unknown> = {}
let failNetwork = false

vi.mock('electron', () => ({
  app: { getVersion: () => '1.2.0', isPackaged: true, quit: () => undefined },
  net: {
    fetch: async () => {
      if (failNetwork) throw new Error('network down')
      return {
        ok: true,
        status: 200,
        url: 'https://download.medpilot.cc/pilot/desktop/latest.json',
        headers: { get: () => null },
        text: async () => JSON.stringify(manifest),
      }
    },
  },
}))

const { UpdaterService } = await import('../src/main/updater')

function release(version: string): UpdateRelease {
  return {
    version,
    channel: 'stable',
    platform: 'Windows 10 / 11 · x64',
    date: '2026-11-20',
    size: 1_000_000,
    sha256: 'a'.repeat(64),
    notes: '',
    url: `https://download.medpilot.cc/pilot/Pilot-${version}-x64-setup.exe`,
  }
}

describe('updater re-check while an update is already downloaded', () => {
  let root = ''

  beforeEach(() => {
    failNetwork = false
    manifest = { ...release('1.2.1') }
  })

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined)
  })

  /** 构造一个「已下载 1.2.1、等重启」的 updater。 */
  async function readyService(): Promise<{
    service: InstanceType<typeof UpdaterService>
    installer: string
  }> {
    root = await mkdtemp(join(tmpdir(), 'pilot-updater-recheck-'))
    const installerDir = join(root, 'updates')
    await mkdir(installerDir, { recursive: true })
    const installer = join(installerDir, 'Pilot-1.2.1-x64-setup.exe')
    await writeFile(installer, 'installer payload')

    const service = new UpdaterService({
      currentVersion: '1.2.0',
      userDataDir: root,
      isPackaged: true,
      onState: () => undefined,
      supported: true,
    })
    const pending = release('1.2.1')
    const state: UpdateState = {
      ...service.stateSnapshot(),
      status: 'ready',
      release: pending,
      progress: 1,
      transferred: pending.size,
      total: pending.size,
      message: '更新已下载，重启后安装。',
    }
    ;(service as unknown as { state: UpdateState }).state = state
    ;(service as unknown as { installerPath: string }).installerPath = installer
    return { service, installer }
  }

  it('points at a newer release published after the download', async () => {
    const { service } = await readyService()
    manifest = { ...release('1.2.2') }

    const state = await service.check()

    expect(state.status).toBe('available')
    expect(state.release?.version).toBe('1.2.2')
    // 旧安装包不再是被点「安装」的对象，避免把 1.2.1 装上去。
    expect((service as unknown as { installerPath: string | null }).installerPath).toBeNull()
  })

  it('keeps the downloaded update when the remote has nothing newer', async () => {
    const { service, installer } = await readyService()

    const state = await service.check()

    expect(state.status).toBe('ready')
    expect(state.release?.version).toBe('1.2.1')
    expect((service as unknown as { installerPath: string | null }).installerPath).toBe(installer)
  })

  it('keeps the downloaded update when the check fails', async () => {
    const { service } = await readyService()
    failNetwork = true

    const state = await service.check()

    expect(state.status).toBe('ready')
    expect(state.release?.version).toBe('1.2.1')
    expect(state.message).toContain('本次检查更新失败')
  })
})
