import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { buildSessionReport, formatDuration, type ReportMessage } from '../src/main/agent/session-report'
import { SessionReportView } from '../src/renderer/src/components/SessionReportDialog'
import { setLocale } from '../src/renderer/src/i18n'
import type { RunRecord, ToolCall } from '../src/shared/types'

setLocale('zh-CN')

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run-1',
    sessionId: 'session-1',
    prompt: '给设置页加一个开关',
    status: 'completed',
    startedAt: '2026-01-01T10:00:00.000Z',
    finishedAt: '2026-01-01T10:02:30.000Z',
    steps: 12,
    promptTokens: 8000,
    completionTokens: 1200,
    totalTokens: 9200,
    toolCalls: 9,
    toolErrors: 0,
    ...overrides,
  }
}

function call(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, name, arguments: args }
}

/** 一条 assistant 工具调用 + 它的结果，成对写入，贴近真实消息序列。 */
function pair(
  callId: string,
  name: string,
  args: Record<string, unknown>,
  result: { content: string; isError?: boolean },
): ReportMessage[] {
  return [
    { role: 'assistant', content: '', toolCalls: [call(callId, name, args)] },
    {
      role: 'tool',
      content: result.content,
      toolCallId: callId,
      name,
      ...(result.isError ? { isError: true } : {}),
    },
  ]
}

describe('formatDuration', () => {
  it('keeps sub-minute, minute and hour scales apart', () => {
    expect(formatDuration(0)).toBe('0 秒')
    expect(formatDuration(42_000)).toBe('42 秒')
    expect(formatDuration(90_000)).toBe('1 分 30 秒')
    expect(formatDuration(120_000)).toBe('2 分')
    expect(formatDuration(3_720_000)).toBe('1 小时 2 分')
  })
})

describe('buildSessionReport', () => {
  it('lists changed files and marks the last verification as passed', () => {
    const messages = [
      ...pair('c1', 'write_file', { path: 'src/a.ts' }, { content: 'ok' }),
      ...pair('c2', 'apply_patch', { path: 'src/b.ts' }, { content: 'ok' }),
      ...pair('c3', 'run_command', { command: 'node', args: ['x', 'typecheck'] }, { content: 'clean' }),
    ]
    const report = buildSessionReport({ run: run(), messages, sessionTitle: '设置页开关' })

    expect(report.title).toBe('设置页开关')
    expect(report.changedFiles).toEqual(['src/a.ts', 'src/b.ts'])
    expect(report.verified).toBe(true)
    expect(report.failures).toEqual([])
    expect(report.markdown).toContain('## 改了什么')
    expect(report.markdown).toContain('`src/a.ts`')
    expect(report.markdown).toContain('通过')
    expect(report.markdown).toContain('2 分 30 秒')
    // 写了又验证过，不该再出现「先跑一次检查」这类下一步建议。
    expect(report.markdown).not.toContain('## 下一步')
  })

  it('reports a failed verification and asks for a narrower check', () => {
    const messages = [
      ...pair('c1', 'write_file', { path: 'src/a.ts' }, { content: 'ok' }),
      ...pair('c2', 'run_shell', { command: 'npm test' }, { content: '3 failed', isError: true }),
    ]
    const report = buildSessionReport({ run: run({ status: 'failed' }), messages })

    expect(report.verified).toBe(false)
    expect(report.failures).toHaveLength(1)
    expect(report.failures[0]).toContain('run_shell')
    expect(report.markdown).toContain('失败')
    expect(report.markdown).toContain('## 失败与卡点')
    expect(report.markdown).toContain('## 下一步')
    expect(report.markdown).toContain('先跑一次最窄的检查')
  })

  it('caps the failure list and says how many were dropped', () => {
    const messages: ReportMessage[] = []
    for (let index = 0; index < 12; index += 1) {
      messages.push(
        ...pair(`c${index}`, 'read_file', { path: `src/${index}.ts` }, { content: 'missing', isError: true }),
      )
    }
    const report = buildSessionReport({ run: run({ toolErrors: 12 }), messages })

    expect(report.failures).toHaveLength(8)
    expect(report.markdown).toContain('这里只列了前 8 条')
  })

  it('says plainly that nothing was written when no write tool ran', () => {
    const messages = pair('c1', 'read_file', { path: 'src/a.ts' }, { content: 'text' })
    const report = buildSessionReport({ run: run(), messages })

    expect(report.changedFiles).toEqual([])
    expect(report.markdown).toContain('- 这一轮没有写文件')
    expect(report.markdown).toContain('- 没有跑验证命令')
  })

  it('flags a run that hit the step cap', () => {
    const report = buildSessionReport({
      run: run({ status: 'max_steps', finishedAt: undefined }),
      messages: [],
    })
    expect(report.markdown).toContain('达到步数上限')
    expect(report.markdown).toContain('撞到步数上限')
    expect(report.markdown).toContain('未记录（这一轮还没有结束时间）')
  })

  it('never leaks a tool result body verbatim into the failure line', () => {
    const longText = `${'x'.repeat(400)}SECRET-TAIL`
    const messages = pair('c1', 'read_file', { path: 'src/a.ts' }, { content: longText, isError: true })
    const report = buildSessionReport({ run: run({ status: 'failed' }), messages })
    expect(JSON.stringify(report)).not.toContain('SECRET-TAIL')
  })
})

describe('SessionReportView', () => {
  it('shows the loading hint before the report arrives', () => {
    expect(renderToStaticMarkup(<SessionReportView report={null} loading />)).toContain('正在汇总这一轮')
  })

  it('says so when the session has no finished run', () => {
    expect(renderToStaticMarkup(<SessionReportView report={null} loading={false} />)).toContain(
      '这一轮还没有可报告的运行',
    )
  })

  it('renders the facts pills and the markdown body', () => {
    const html = renderToStaticMarkup(
      <SessionReportView
        loading={false}
        report={{
          title: '设置页开关',
          markdown: '## 结论\n\n- 状态：完成',
          changedFiles: ['src/a.ts', 'src/b.ts'],
          verified: true,
          failures: ['run_shell：3 failed'],
        }}
      />,
    )
    expect(html).toContain('已验证')
    expect(html).toContain('改了 2 个文件')
    expect(html).toContain('1 次失败')
    expect(html).toContain('状态：完成')
    expect(html).not.toContain('未验证')
  })
})
