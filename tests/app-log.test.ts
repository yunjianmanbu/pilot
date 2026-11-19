import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appLogFileName,
  createAppLog,
  redactDetailValue,
  serializeEntry,
} from '../src/main/app-log'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pilot-app-log-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('应用级日志', () => {
  it('按天切分文件名', () => {
    expect(appLogFileName(new Date(2026, 0, 5))).toBe('app-2026-01-05.jsonl')
  })

  it('凭据形状的内容写盘前被替换，敏感字段名整段抹掉', () => {
    const value = redactDetailValue({
      apiKey: 'sk-abcdefghijklmnopqrstuvwxyz123456',
      note: 'token sk-abcdefghijklmnopqrstuvwxyz123456 泄漏',
      nested: { prompt: '用户原文不该落盘' },
      count: 3,
    }) as Record<string, unknown>

    expect(value['apiKey']).toBe('<redacted>')
    expect(value['note']).toBe('token <redacted> 泄漏')
    expect((value['nested'] as Record<string, unknown>)['prompt']).toBe('<redacted>')
    expect(value['count']).toBe(3)
  })

  it('长字符串被截断，坏值退成 null', () => {
    const long = 'a'.repeat(500)
    expect(String(redactDetailValue(long)).length).toBe(240)
    expect(redactDetailValue(Number.NaN)).toBeNull()
    expect(redactDetailValue(undefined)).toBeNull()
  })

  it('序列化成单行 JSON，带时间与级别', () => {
    const line = serializeEntry({ area: 'module-check', event: 'scan.completed', level: 'warn' }, new Date('2026-11-16T00:00:00.000Z'))
    expect(line.endsWith('\n')).toBe(true)
    const record = JSON.parse(line.trim()) as Record<string, unknown>
    expect(record['at']).toBe('2026-11-16T00:00:00.000Z')
    expect(record['area']).toBe('module-check')
    expect(record['level']).toBe('warn')
  })

  it('写进去的记录能按时间顺序读回来，且落在 userData 的日志文件里', async () => {
    const log = createAppLog({ dir: join(root, 'logs') })
    log.write({ area: 'self-check', event: 'run.started' })
    log.write({ area: 'self-modify', event: 'proposal.refreshed', detail: { riskId: 'client:debug-logging' } })
    const recent = await log.recent(10)
    expect(recent.map((item) => item.event)).toEqual(['run.started', 'proposal.refreshed'])
    expect(recent[1]?.detail?.['riskId']).toBe('client:debug-logging')

    const file = await readFile(join(root, 'logs', appLogFileName(new Date())), 'utf8')
    expect(file.trim().split('\n')).toHaveLength(2)
  })

  it('保留策略删掉超过 30 天的按天文件', async () => {
    const dir = join(root, 'logs')
    const old = createAppLog({ dir, now: () => new Date(2026, 0, 1, 12) })
    old.write({ area: 'run', event: 'run.settled' })
    await new Promise((r) => setTimeout(r, 50))
    const fresh = createAppLog({ dir, now: () => new Date(2026, 5, 1, 12) })
    await fresh.prune()
    const { readdir } = await import('node:fs/promises')
    const names = await readdir(dir)
    expect(names).not.toContain('app-2026-01-01.jsonl')
  })

  it('日志目录不可写时不抛错，只是读不到内容', async () => {
    const log = createAppLog({ dir: join(root, 'missing', '\u0000bad') })
    expect(() => log.write({ area: 'run', event: 'run.settled' })).not.toThrow()
    await expect(log.recent(5)).resolves.toEqual([])
  })
})
