import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
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

import type { Store } from '../src/main/store'
import { CompanionServer } from '../src/main/companion/server'
import type { CompanionState } from '../src/main/companion/types'

/**
 * `companion.json` 的写盘路径（`handlers/runtime.ts` 的 `saveNow`）。
 *
 * 连接页面曾经报 `ENOENT: rename 'companion.json.<pid>.tmp' -> 'companion.json'`：
 * 临时文件名只带 pid，同进程里任何两次重叠的保存都会抢同一个文件——先完成的
 * rename 把它搬走，后一次就只剩 ENOENT，而两次 writeFile 交错还可能留下半份
 * JSON。这里不复现旧实现，而是把三条约束锁住：并发保存必须全部成功、被合并的
 * 保存必须落盘最后一次状态、任何路径失败后都不能把 `.tmp` 留在用户目录里。
 */
const stops: Array<() => Promise<unknown> | unknown> = []
const dirsToRemove: string[] = []

const storeStub = () =>
  ({
    settingsView: () => ({ model: 'deepseek-chat', theme: 'dark', relayUrl: '' }),
    workspaces: () => [],
    sessions: () => [],
    activeWorkspace: () => '',
    todos: () => [],
  }) as unknown as Store

async function createServer(dataDir?: string): Promise<{
  server: CompanionServer
  dataDir: string
}> {
  const dir = dataDir ?? (await mkdtemp(join(tmpdir(), 'pilot-companion-save-')))
  const ownsDir = !dataDir
  const server = new CompanionServer({
    store: storeStub(),
    runner: {} as never,
    dataDir: dir,
    assetsDir: fileURLToPath(new URL('../companion', import.meta.url)),
    deviceName: 'Test Desktop',
    appVersion: '0.1.0-test',
    billing: { report: () => Promise.reject(new Error('billing is not stubbed in this test')) },
    relayUrl: '',
    appUrl: '',
    onStatus: () => undefined,
  })
  // 停服自己也会落一次盘（`stop()` 尾部 `await saveNow()`），所以必须先停掉**所有**
  // 实例、再删目录：两个实例共用一个 dataDir 时，第二个 stop 会把第一个刚删掉的
  // 目录 mkdir 回来，留下一个空目录。
  stops.push(() => server.stop())
  if (ownsDir) dirsToRemove.push(dir)
  await server.init()
  return { server, dataDir: dir }
}

const readState = async (dataDir: string): Promise<CompanionState> =>
  JSON.parse(await readFile(join(dataDir, 'companion.json'), 'utf8')) as CompanionState

const tempLeftovers = async (dataDir: string): Promise<string[]> =>
  (await readdir(dataDir)).filter((name) => name.endsWith('.tmp'))

afterEach(async () => {
  for (const stop of stops) await stop()
  stops.length = 0
  for (const dir of dirsToRemove) await rm(dir, { recursive: true, force: true })
  dirsToRemove.length = 0
})

describe('companion.json save', () => {
  it('lets overlapping saves all succeed and leaves no temp files behind', async () => {
    const { server, dataDir } = await createServer()
    server.state.port = 47831

    // 真实入口确实会重叠：握手 / 配对的 `await saveNow()`、`blankSave()` 的
    // 300ms 防抖（不 await）、停服收尾，都可能落在同一次写盘窗口里。
    await Promise.all(Array.from({ length: 24 }, () => server.saveNow()))

    expect(server.lastError).toBeNull()
    expect((await readState(dataDir)).port).toBe(47831)
    expect(await tempLeftovers(dataDir)).toEqual([])
  })

  it('writes the final state even when saves are coalesced', async () => {
    const { server, dataDir } = await createServer()

    const pending: Array<Promise<void>> = []
    for (let index = 0; index < 20; index += 1) {
      server.state.port = 47000 + index
      pending.push(server.saveNow())
    }
    await Promise.all(pending)

    // 队列把 20 次压成 2 次写盘，但最后一次调用之后的状态必须落盘（dirty 轮）。
    expect((await readState(dataDir)).port).toBe(47019)
    expect(await tempLeftovers(dataDir)).toEqual([])
  })

  it('keeps two servers on one data dir from colliding on the temp name', async () => {
    const first = await createServer()
    const second = await createServer(first.dataDir)
    first.server.state.port = 47001
    second.server.state.port = 47002

    // 两个实例各有自己的队列：只有唯一临时名能保证它们不互相抢文件。
    await Promise.all([
      ...Array.from({ length: 8 }, () => first.server.saveNow()),
      ...Array.from({ length: 8 }, () => second.server.saveNow()),
    ])

    expect(first.server.lastError).toBeNull()
    expect(second.server.lastError).toBeNull()
    expect(await tempLeftovers(first.dataDir)).toEqual([])
    // 落盘的一定是其中一份完整状态，不能是两次写入交错的半份。
    expect([47001, 47002]).toContain((await readState(first.dataDir)).port)
  })

  it('clears the reported error once a later save lands', async () => {
    const { server, dataDir } = await createServer()

    // 数据目录被一个同名文件占住：写盘必然失败，页面会收到 status.error。
    await rm(dataDir, { recursive: true, force: true })
    await writeFile(dataDir, 'occupied')
    await server.saveNow()
    expect(server.lastError).toBeTruthy()

    // 恢复目录后下一次保存成功，那条红字要跟着消失，不能一直钉在连接页面上。
    await rm(dataDir, { force: true })
    await server.saveNow()
    expect(server.lastError).toBeNull()
    expect(server.status().error).toBeNull()
    expect(await tempLeftovers(dataDir)).toEqual([])
  })
})
