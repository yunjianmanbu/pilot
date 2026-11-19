import { homedir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  approvalAuditEntry,
  crashEntry,
  describeError,
  runSettledEntry,
  toolAuditEntry,
  toolFailureEntry,
} from '../src/main/app-audit'
import type { RunRecord, RunEvent } from '../src/shared/types'

const base = { sessionId: 's1', runId: 'r1' }

function runRecord(patch: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'r1',
    sessionId: 's1',
    prompt: '不要写进日志的提问正文',
    status: 'completed',
    startedAt: '2026-01-05T10:00:00.000Z',
    finishedAt: '2026-01-05T10:00:30.000Z',
    steps: 7,
    promptTokens: 1200,
    completionTokens: 340,
    totalTokens: 1540,
    toolCalls: 9,
    toolErrors: 2,
    filesChanged: 3,
    ...patch,
  }
}

describe('审计条目的构造', () => {
  it('运行结算带上用量、步数、耗时与工具失败数', () => {
    const entry = runSettledEntry({ sessionId: 's1', status: 'completed', run: runRecord() })
    expect(entry.area).toBe('run')
    expect(entry.event).toBe('run.settled')
    expect(entry.level).toBe('info')
    expect(entry.detail).toMatchObject({
      runId: 'r1',
      steps: 7,
      input: 1200,
      output: 340,
      toolErrors: 2,
      filesChanged: 3,
      durationMs: 30_000,
    })
    // 提问正文永远不进日志：detail 里不许出现 prompt 的值。
    expect(JSON.stringify(entry.detail)).not.toContain('提问正文')
  })

  it('失败的运行记成 warn 并带上错误摘要', () => {
    const entry = runSettledEntry({
      sessionId: 's1',
      status: 'failed',
      run: runRecord({ status: 'failed', error: '模型 401：密钥无效' }),
    })
    expect(entry.level).toBe('warn')
    expect(entry.detail?.['error']).toBe('模型 401：密钥无效')
  })

  it('没有运行记录时也写出 sessionId 与状态', () => {
    const entry = runSettledEntry({ sessionId: 's1', status: 'cancelled' })
    expect(entry.detail).toEqual({ sessionId: 's1', status: 'cancelled' })
  })

  it('只读调用不进审计，write / exec 才记', () => {
    const read: Extract<RunEvent, { type: 'tool.call' }> = {
      type: 'tool.call',
      ...base,
      call: { id: 'c1', name: 'read_file', arguments: {} },
      risk: 'read',
    }
    const exec: Extract<RunEvent, { type: 'tool.call' }> = {
      type: 'tool.call',
      ...base,
      call: { id: 'c2', name: 'run_shell', arguments: { command: 'rm -rf build' } },
      risk: 'exec',
    }
    expect(toolAuditEntry(read)).toBeNull()
    const entry = toolAuditEntry(exec)
    expect(entry?.detail).toMatchObject({ tool: 'run_shell', risk: 'exec', callId: 'c2' })
    // 命令参数不落审计日志，只留「调了什么工具」。
    expect(JSON.stringify(entry?.detail)).not.toContain('rm -rf')
  })

  it('审批条目区分通过/拒绝，并带上是谁决定的', () => {
    const approved = approvalAuditEntry({
      type: 'tool.approval_resolved',
      ...base,
      callId: 'c2',
      approved: true,
      name: 'run_shell',
      risk: 'exec',
      decidedBy: 'user',
    })
    expect(approved.area).toBe('audit')
    expect(approved.level).toBe('info')
    expect(approved.detail).toMatchObject({ approved: true, tool: 'run_shell', decidedBy: 'user' })

    const timedOut = approvalAuditEntry({
      type: 'tool.approval_resolved',
      ...base,
      callId: 'c3',
      approved: false,
      reason: '审批超时（5 分钟），已自动拒绝；可以继续任务后再试。',
      decidedBy: 'timeout',
    })
    expect(timedOut.level).toBe('warn')
    expect(timedOut.detail).toMatchObject({ decidedBy: 'timeout' })
  })

  it('写/执行工具失败只记条目，不写错误正文', () => {
    const failed: Extract<RunEvent, { type: 'tool.result' }> = {
      type: 'tool.result',
      ...base,
      callId: 'c2',
      name: 'run_shell',
      result: { ok: false, output: '', error: 'bash: secret-value: command not found' },
    }
    const entry = toolFailureEntry(failed, 'exec')
    expect(entry?.event).toBe('tool.failed')
    expect(entry?.level).toBe('warn')
    expect(JSON.stringify(entry?.detail)).not.toContain('secret-value')
    expect(entry?.detail).toMatchObject({ callId: 'c2', risk: 'exec', errorChars: 37 })
    // 只读工具与成功的调用都不记。
    expect(toolFailureEntry(failed, 'read')).toBeNull()
    expect(toolFailureEntry({ ...failed, result: { ok: true, output: '' } }, 'exec')).toBeNull()
  })

  it('崩溃条目记下位置与摘要，不抛错', () => {
    const entry = crashEntry({
      event: 'uncaught-exception',
      source: 'main',
      error: new Error('boom'),
    })
    expect(entry.area).toBe('crash')
    expect(entry.level).toBe('error')
    expect(entry.detail).toMatchObject({ source: 'main' })
    expect(String(entry.detail?.['summary'])).toContain('Error: boom')
  })
})

describe('异常摘要', () => {
  it('把用户主目录折叠成 ~', () => {
    const home = homedir()
    if (!home) return
    const summary = describeError(new Error(`打不开 ${home}\\secret\\file.txt`))
    expect(summary).not.toContain(home)
    expect(summary).toContain('~')
  })

  it('非 Error 也能压成一行且限长', () => {
    const summary = describeError({ code: 'EPIPE', 详情: 'x'.repeat(400) })
    expect(summary.length).toBeLessThanOrEqual(240)
    expect(summary).toContain('EPIPE')
  })
})
