import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// 应急通道的全部价值在于「主引擎坏掉时它还能用」，所以这里刻意把 electron 的
// safeStorage 设成不可用：key 走明文 base64 分支，才能在测试里读回真正的密钥。
vi.mock('electron', () => ({
  app: { getPath: () => '', getLocale: () => 'zh-CN', isPackaged: false },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error('not available in tests')
    },
    decryptString: () => {
      throw new Error('not available in tests')
    },
  },
}))

import { SuperPilot } from '../src/main/super-pilot'
import { Store } from '../src/main/store'
import type { AppLogEntry } from '../src/main/app-log'

const cleanups: string[] = []
const pilots: SuperPilot[] = []

afterEach(async () => {
  while (pilots.length) await pilots.pop()?.dispose()
  while (cleanups.length) {
    const dir = cleanups.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(dir)
  return dir
}

async function hostStore(apiKey = ''): Promise<Store> {
  const dir = await tempDir('pilot-host-')
  const store = new Store(dir)
  await store.load()
  if (apiKey) store.setApiKey(apiKey)
  return store
}

async function makePilot(
  userDataDir: string,
  sourceStore: () => Store | null,
  logs: AppLogEntry[] = [],
): Promise<SuperPilot> {
  const pilot = new SuperPilot({
    userDataDir,
    selfSource: async () => tempDir('pilot-super-src-'),
    sourceStore,
    log: (entry) => logs.push(entry),
    emit: () => undefined,
    packageRoot: userDataDir,
  })
  pilots.push(pilot)
  return pilot
}

/** 读应急数据面自己的 store 文件，确认通道真的落在它自己的盘上。 */
async function ownChannel(userDataDir: string): Promise<{ model: string; key: string }> {
  const raw = await readFile(join(userDataDir, 'super-pilot', 'pilot-core.json'), 'utf8')
  const state = JSON.parse(raw) as {
    settings: {
      model: string
      modelResources: { id: string; model?: string; keyCipher: string | null; keyPlain: boolean }[]
      sessionModelId: string
    }
  }
  const settings = state.settings
  const resource =
    settings.modelResources.find((entry) => entry.id === settings.sessionModelId) ??
    settings.modelResources[0]
  if (!resource?.keyCipher) return { model: settings.model, key: '' }
  const decoded = Buffer.from(resource.keyCipher, 'base64')
  return { model: resource.model ?? settings.model, key: decoded.toString('utf8') }
}

describe('super pilot emergency channel', () => {
  it('boots on its own data plane when the host store cannot be read at all', async () => {
    const userDataDir = await tempDir('pilot-super-ud-')
    const logs: AppLogEntry[] = []
    const pilot = await makePilot(userDataDir, () => {
      throw new Error('pilot-core.json is not valid JSON')
    }, logs)

    const status = await pilot.status()

    expect(status.state).toBe('ready')
    expect(status.dataDir).toBe(join(userDataDir, 'super-pilot'))
    expect(status.inheritedFromHost).toBe(false)
    expect(status.sessionId).not.toBe('')
    // 全权限档位是它自己的，不依赖主设置。
    expect(status.approvalMode).toBe('auto')
    expect(status.autonomy.active).toBe(true)
    expect(status.autonomy.blockers).toEqual([])
    expect(logs.map((entry) => entry.event)).toContain('boot.ready')
  })

  it('keeps the last inherited model channel after the host store goes away', async () => {
    const userDataDir = await tempDir('pilot-super-ud-')
    const host = await hostStore('sk-host-key-1234')

    const first = await makePilot(userDataDir, () => host)
    const firstStatus = await first.status()
    expect(firstStatus.inheritedFromHost).toBe(true)
    expect(await ownChannel(userDataDir)).toMatchObject({ key: 'sk-host-key-1234' })
    await first.dispose()
    pilots.splice(pilots.indexOf(first), 1)

    // 主 store 损坏：这一次读不出来，但上一次同步到应急盘上的通道必须还在。
    let reads = 0
    const second = await makePilot(userDataDir, () => {
      reads += 1
      throw new Error('core.json corrupted')
    })
    const status = await second.status()

    expect(reads).toBe(1)
    expect(status.state).toBe('ready')
    expect(status.inheritedFromHost).toBe(false)
    expect(await ownChannel(userDataDir)).toMatchObject({ key: 'sk-host-key-1234' })
  })

  it('forces the autonomous profile even when the host settings are conservative', async () => {
    const userDataDir = await tempDir('pilot-super-ud-')
    const host = await hostStore('sk-host-key-1234')
    await host.updateSettings({ defaultApprovalMode: 'manual', fullAutonomy: false, maxSteps: 3 })

    const pilot = await makePilot(userDataDir, () => host)
    const status = await pilot.status()

    expect(status.approvalMode).toBe('auto')
    expect(status.autonomy.active).toBe(true)
    // 主设置的 3 步不该把应急通道压成只能走三步。
    expect(status.autonomy.blockers).toEqual([])
  })

  it('records every rescue action and keeps going when one of them throws', async () => {
    const userDataDir = await tempDir('pilot-super-ud-')
    const pilot = await makePilot(userDataDir, () => null)
    const options = (
      pilot as unknown as { options: { hostActions?: () => { label: string; run: () => string }[] } }
    ).options
    options.hostActions = () => [
      {
        label: '取消主引擎所有运行',
        run: () => {
          throw new Error('main runner already gone')
        },
      },
      { label: '放掉等待中的审批', run: () => '没有待批请求' },
    ]

    const result = await pilot.rescue()

    expect(result.actions.map((action) => action.label)).toEqual([
      '取消主引擎所有运行',
      '放掉等待中的审批',
      '停止超级 Pilot 自己的运行',
    ])
    expect(result.actions[0]).toMatchObject({ ok: false, detail: 'main runner already gone' })
    expect(result.actions[1]).toMatchObject({ ok: true, detail: '没有待批请求' })
    expect(result.actions[2]).toMatchObject({ ok: true })
  })

  it('reports a readable error instead of throwing when the prompt is empty', async () => {
    const userDataDir = await tempDir('pilot-super-ud-')
    const pilot = await makePilot(userDataDir, () => null)

    await expect(pilot.send('   ')).resolves.toEqual({ ok: false, error: '指令为空' })
  })

  it('reports a readable error instead of throwing when the data plane is unusable', async () => {
    const userDataDir = await tempDir('pilot-super-ud-')
    // 把 userDataDir 指向一个普通文件：mkdir 必然失败，模拟「连应急盘都建不出来」。
    const blocker = join(userDataDir, 'not-a-dir')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(blocker, 'x')
    const logs: AppLogEntry[] = []
    const pilot = await makePilot(blocker, () => null, logs)

    const status = await pilot.status()

    expect(status.state).toBe('failed')
    expect(status.lastError).not.toBe('')
    expect(status.autonomy.active).toBe(false)
    expect(logs.map((entry) => entry.event)).toContain('boot.failed')
  })
})
