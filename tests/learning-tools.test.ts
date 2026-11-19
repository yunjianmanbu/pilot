import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executePilotTool, filterLearningTools, LEARNING_LOG, LEARNING_RESEARCH, pilotTools, type ToolHost } from '../src/main/agent/tools'
import { resolveLearningPolicy, summarizeLearning } from '../src/main/agent/learning'

const dirs: string[] = []

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pilot-learning-tool-'))
  dirs.push(root)
  return root
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

const signal = new AbortController().signal

function host(root: string, learning: boolean): ToolHost {
  const policy = resolveLearningPolicy({ learningMode: learning })
  return {
    root,
    sandbox: null,
    remember: async () => ({ id: 'mem-1' }),
    updatePlan: () => undefined,
    proposeSelfUpdate: async () => ({ version: 1 }),
    ...(learning
      ? {
          learning: {
            policy,
            research: async (url: string) => ({
              id: 'source-abc123abc123',
              url,
              host: new URL(url).hostname,
              path: '.pilot/learning/sources/abc123abc123.txt',
              bytes: 42,
              truncated: false,
              contentType: 'text/html',
              excerpt: '摘录内容',
              fetchedAt: '2026-01-01T00:00:00.000Z',
            }),
            log: async (entry) => {
              const tasks = entry.kind === 'task' ? 1 : 0
              return summarizeLearning(
                tasks > 0 ? [{ at: '2026-01-01T00:00:00.000Z', kind: 'task', id: 'task-1' }] : [],
              )
            },
          },
        }
      : {}),
  }
}

describe('learning tools', () => {
  it('are invisible to the model until the user turns learning mode on', () => {
    const names = (enabled: boolean) =>
      filterLearningTools(pilotTools, enabled).map((tool) => tool.name)
    expect(names(true)).toContain(LEARNING_RESEARCH)
    expect(names(true)).toContain(LEARNING_LOG)
    expect(names(false)).not.toContain(LEARNING_RESEARCH)
    expect(names(false)).not.toContain(LEARNING_LOG)
    // 只掉两个学习工具，其余工具一个不能少。
    expect(names(false)).toHaveLength(pilotTools.length - 2)
  })

  it('declares research as read-only so it never needs a write approval', () => {
    const research = pilotTools.find((tool) => tool.name === LEARNING_RESEARCH)
    const log = pilotTools.find((tool) => tool.name === LEARNING_LOG)
    expect(research?.risk).toBe('read')
    expect(log?.risk).toBe('control')
  })
  it('refuses to run when learning mode is off', async () => {
    const root = await workspace()
    await expect(
      executePilotTool(LEARNING_RESEARCH, { url: 'https://nodejs.org/api' }, host(root, false), signal),
    ).rejects.toThrow(/学习探索未开启/)
    await expect(
      executePilotTool(LEARNING_LOG, { kind: 'task', title: 'A' }, host(root, false), signal),
    ).rejects.toThrow(/学习探索未开启/)
  })

  it('refuses an allowlisted-but-blocked egress before touching the network', async () => {
    const root = await workspace()
    const enabled = host(root, true)
    await expect(
      executePilotTool(LEARNING_RESEARCH, { url: 'http://127.0.0.1:8080/api' }, enabled, signal),
    ).rejects.toThrow(/出域守门拒绝/)
    await expect(
      executePilotTool(LEARNING_RESEARCH, { url: 'https://evil.example/x' }, enabled, signal),
    ).rejects.toThrow(/白名单/)
    await expect(
      executePilotTool(LEARNING_RESEARCH, { url: 'https://nodejs.org/x', method: 'POST' }, enabled, signal),
    ).resolves.toBeTruthy()
  })

  it('reports the stored path and source id for a read', async () => {
    const root = await workspace()
    const result = await executePilotTool(
      LEARNING_RESEARCH,
      { url: 'https://nodejs.org/api/fs.html' },
      host(root, true),
      signal,
    )
    expect(result.ok).toBe(true)
    expect(result.output).toContain('.pilot/learning/sources/abc123abc123.txt')
    expect(result.output).toContain('source-abc123abc123')
    expect(result.output).toContain('摘录内容')
  })

  it('validates ledger arguments instead of writing a half-empty record', async () => {
    const root = await workspace()
    const enabled = host(root, true)
    await expect(
      executePilotTool(LEARNING_LOG, { kind: 'task' }, enabled, signal),
    ).rejects.toThrow(/title 或 goal/)
    await expect(
      executePilotTool(LEARNING_LOG, { kind: 'outcome' }, enabled, signal),
    ).rejects.toThrow(/taskId/)
    const ok = await executePilotTool(
      LEARNING_LOG,
      { kind: 'task', title: '整理 fs 异步 API', goal: '对照表' },
      enabled,
      signal,
    )
    expect(ok.ok).toBe(true)
    expect(ok.output).toContain('任务 1 个')
  })
})
