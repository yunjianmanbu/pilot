/**
 * Real-workspace scan benchmark for the checkpoint ignore list.
 *
 * Off by default: it needs a large real repository, so point it at one and it
 * measures real `create()` calls through the real service (walk + hash +
 * manifest write), not a replica of the walk.
 *
 *   PILOT_BENCH_WORKSPACE=E:/code/agent/manbu-agent-workspace \
 *   PILOT_BENCH_IGNORE=".build,tmp,claude" \
 *     npx vitest run tests/checkpoint-scan-bench.test.ts
 *
 * Each configuration gets a fresh store, so both pay a cold index and a real
 * hash pass — that is the situation a first snapshot in a new session hits.
 * For the walk alone, use `tmp/bench-snapshot.mjs` in the repo root.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it, vi } from 'vitest'

let userDataDir = ''

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir, getLocale: () => 'zh-CN' },
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

import { CheckpointService } from '../src/main/checkpoints'
import { Store } from '../src/main/store'

const workspace = process.env['PILOT_BENCH_WORKSPACE'] ?? ''
const ignore = (process.env['PILOT_BENCH_IGNORE'] ?? '').split(',').filter(Boolean)
const roots: string[] = []

afterAll(async () => {
  while (roots.length) {
    const dir = roots.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

/** Cold + warm snapshot of `workspace` with `patterns`, in a throwaway store. */
async function measure(label: string, patterns: string[]): Promise<number[]> {
  const root = await mkdtemp(join(tmpdir(), 'pilot-scan-bench-'))
  roots.push(root)
  userDataDir = join(root, 'user-data')
  const store = new Store()
  await store.load()
  const added = await store.addWorkspace(workspace)
  const session = await store.createSession(added.path)
  const service = new CheckpointService(userDataDir, store)
  const timings: number[] = []
  try {
    // Two snapshots: the first pays the cold index and a full hash pass, the
    // second is what every later shell snapshot in the same session costs.
    for (const pass of ['first', 'second']) {
      const started = Date.now()
      const checkpoint = await service.create({
        sessionId: session.id,
        workspacePath: added.path,
        label: pass,
        messageCount: 0,
        trigger: 'prompt',
        retention: 20,
        ignore: patterns,
      })
      const elapsed = Date.now() - started
      timings.push(elapsed)
      console.log(
        `[bench] ${label} (${pass}): ${checkpoint.files} files / ` +
          `${Math.round(checkpoint.bytes / 1024)} KiB / complete=${checkpoint.complete} ` +
          `in ${elapsed}ms (ignore=${JSON.stringify(patterns)})`,
      )
      expect(checkpoint.files).toBeGreaterThan(0)
    }
    // What a `beforeShell` snapshot costs when nothing changed since the last
    // one: the repeat of a long run, which is the case this bench exists for.
    for (let index = 0; index < 3; index += 1) {
      const started = Date.now()
      const checkpoint = await service.create({
        sessionId: session.id,
        workspacePath: added.path,
        label: `shell ${index}`,
        messageCount: index,
        trigger: 'shell',
        retention: 20,
        ignore: patterns,
      })
      const elapsed = Date.now() - started
      console.log(`[bench] ${label} (shell ${index}): reused=${checkpoint.id} in ${elapsed}ms`)
      timings.push(elapsed)
    }
    return timings
  } finally {
    service.dispose()
  }
}

it.skipIf(!workspace)('snapshots a real workspace with an ignore list', async () => {
  // Both configurations run in this one test so the comparison shares the OS
  // file cache; the ignore list is the only difference.
  const before = await measure('no ignore list', [])
  const after = await measure('with ignore list', ignore)
  const ratio = (a: number, b: number): string => `${(a / b).toFixed(1)}x`
  const first = `${before[0]}ms -> ${after[0]}ms (${ratio(before[0] ?? 1, after[0] ?? 1)})`
  const second = `${before[1]}ms -> ${after[1]}ms (${ratio(before[1] ?? 1, after[1] ?? 1)})`
  const shell = `${before[2]}ms -> ${after[2]}ms (${ratio(before[2] ?? 1, after[2] ?? 1)})`
  console.log(`[bench] first snapshot ${first}, second snapshot ${second}`)
  console.log(`[bench] unchanged shell snapshot ${shell}`)
}, 600_000)
