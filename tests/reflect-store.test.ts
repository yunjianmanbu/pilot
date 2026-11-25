import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReflectionReport } from '../src/shared/reflect'
import { collectEvidence } from '../src/main/reflect/evidence'

let userDataDir = ''

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataDir,
    getLocale: () => 'zh-CN',
  },
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

import { Store } from '../src/main/store'

const cleanups: string[] = []

afterEach(async () => {
  while (cleanups.length) {
    const dir = cleanups.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

async function setup(): Promise<Store> {
  const root = await mkdtemp(join(tmpdir(), 'pilot-reflect-store-'))
  cleanups.push(root)
  userDataDir = join(root, 'user-data')
  const store = new Store()
  await store.load()
  return store
}

function report(): ReflectionReport {
  return {
    id: 'reflect-1',
    createdAt: '2026-11-22T00:00:00.000Z',
    trigger: 'manual',
    model: 'mock-reflector',
    topics: ['compaction-drift', 'code-quality'],
    skipped: [],
    summary: '压缩后约束漂移。',
    findings: [
      {
        id: 'f1',
        topic: 'compaction-drift',
        severity: 'high',
        observation: '压缩后没有复查早期约束。',
        suggestion: '压缩后回读原始请求。',
      },
    ],
    evidence: 'workspaces=1 sessions=2',
    durationMs: 1200,
    email: { sent: true, to: 'ops@example.com' },
  }
}

describe('Store reflection reports', () => {
  it('persists reflection reports and the schedule anchor across reloads', async () => {
    const store = await setup()
    await store.addReflectionReport(report())
    await store.noteReflectionScheduled('2026-11-22T00:05:00.000Z')

    // 同一个 userData 目录重新加载，等价于关掉应用再启动。
    const reloaded = new Store()
    await reloaded.load()

    expect(reloaded.reflectionReports()).toHaveLength(1)
    expect(reloaded.reflectionReports()[0]).toMatchObject({
      id: 'reflect-1',
      trigger: 'manual',
      model: 'mock-reflector',
      summary: '压缩后约束漂移。',
      email: { sent: true, to: 'ops@example.com' },
    })
    expect(reloaded.reflectLastScheduledAt()).toBe('2026-11-22T00:05:00.000Z')
    // 反思时间锚点也要跟报告一起落盘，否则重启后定时判定会重复触发。
    expect(reloaded.settings().reflectLastRunAt).toBe('2026-11-22T00:00:00.000Z')
  })

  it('records the reflected app version as the next comparison baseline', async () => {
    const store = await setup()
    expect(store.settings().reflectLastVersion).toBe('')

    await store.addReflectionReport({ ...report(), version: '1.2.4' })
    expect(store.settings().reflectLastVersion).toBe('1.2.4')

    // 重启后仍拿得到基线，否则 version 模式会把同一版反复当新版本触发。
    const reloaded = new Store()
    await reloaded.load()
    expect(reloaded.settings().reflectLastVersion).toBe('1.2.4')

    // 旧报告没有 version 字段：不能把已有基线抹成空。
    await reloaded.addReflectionReport({ ...report(), id: 'reflect-2' })
    expect(reloaded.settings().reflectLastVersion).toBe('1.2.4')
  })

  it('clears stored reports', async () => {
    const store = await setup()
    await store.addReflectionReport(report())
    await store.clearReflectionReports()

    const reloaded = new Store()
    await reloaded.load()
    expect(reloaded.reflectionReports()).toEqual([])
  })

  it('marks a finding done or dismissed and keeps it across reloads', async () => {
    const store = await setup()
    await store.addReflectionReport(report())

    const updated = await store.setReflectionFindingStatus('reflect-1', 'f1', 'done')
    expect(updated?.findings[0]?.status).toBe('done')

    const reloaded = new Store()
    await reloaded.load()
    expect(reloaded.reflectionReports()[0]?.findings[0]?.status).toBe('done')

    // open 回到待处理：用删字段表示，旧数据里不会多一个与默认值同义的字段。
    await reloaded.setReflectionFindingStatus('reflect-1', 'f1', 'open')
    expect(reloaded.reflectionReports()[0]?.findings[0]).not.toHaveProperty('status')

    // 找不到报告或结论时返回 null，不改别的条目，也不抛错。
    expect(await reloaded.setReflectionFindingStatus('nope', 'f1', 'done')).toBeNull()
    expect(await reloaded.setReflectionFindingStatus('reflect-1', 'nope', 'done')).toBeNull()
    expect(reloaded.reflectionReports()[0]?.findings[0]).not.toHaveProperty('status')
  })

  it('drops dismissed findings from the history handed to the next round', async () => {
    const store = await setup()
    const base = report()
    await store.addReflectionReport({
      ...base,
      findings: [
        { ...base.findings[0]!, id: 'kept', status: 'done' },
        {
          ...base.findings[0]!,
          id: 'dropped',
          observation: '这条明确不打算做。',
          status: 'dismissed',
        },
      ],
    })

    const history = collectEvidence(store).history ?? []
    expect(history.map((entry) => entry.observation)).toEqual(['压缩后没有复查早期约束。'])
    expect(history[0]?.status).toBe('done')
  })
})
