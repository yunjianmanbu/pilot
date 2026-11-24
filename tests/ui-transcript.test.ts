import { describe, expect, it } from 'vitest'
import type { Plan, StoredMessage } from '../src/shared/types'
import {
  buildTranscript,
  isDeliverableText,
  processParts,
  recentProcessParts,
  runsWithAnswer,
} from '../src/renderer/src/ui'

function plan(): Plan {
  return {
    goal: '修复登录',
    updatedAt: '2026-01-01T00:00:00.000Z',
    items: [
      { id: 'plan-1', text: '定位问题', status: 'done' },
      { id: 'plan-2', text: '补充测试', status: 'pending' },
    ],
  }
}

function assistant(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: 'message-1',
    role: 'assistant',
    content: '已完成。',
    createdAt: '2026-01-01T00:00:00.000Z',
    runId: 'run-1',
    ...overrides,
  }
}

describe('execution process window', () => {
  function longRun(): ReturnType<typeof buildTranscript> {
    const toolCalls = Array.from({ length: 4 }, (_, index) => ({
      id: `call-${index}`,
      name: 'read_file',
      arguments: { path: `f${index}.ts` },
    }))
    return buildTranscript([
      assistant({ id: 'a1', content: '', reasoning: '先看目录', toolCalls: toolCalls.slice(0, 2) }),
      assistant({ id: 'a2', content: '继续读文件', reasoning: '再看实现', toolCalls: toolCalls.slice(2) }),
    ])
  }

  it('keeps reasoning, notes and tool calls in one chronological order', () => {
    const process = longRun().find((block) => block.kind === 'process')
    if (!process || process.kind !== 'process') throw new Error('missing process block')
    expect(processParts(process).map((part) => part.kind)).toEqual([
      'reasoning',
      'tool',
      'tool',
      'reasoning',
      'note',
      'tool',
      'tool',
    ])
  })

  it('collapses to the five newest steps and reports how many were hidden', () => {
    const process = longRun().find((block) => block.kind === 'process')
    if (!process || process.kind !== 'process') throw new Error('missing process block')
    const { parts, hidden } = recentProcessParts(process, 5)
    expect(hidden).toBe(2)
    expect(parts).toHaveLength(5)
    expect(parts.map((part) => part.key)).toEqual(
      processParts(process).slice(-5).map((part) => part.key),
    )
  })

  it('shows everything when the run has fewer steps than the window', () => {
    const blocks = buildTranscript([
      assistant({
        id: 'short',
        content: '',
        toolCalls: [{ id: 'only-call', name: 'git_status', arguments: {} }],
      }),
    ])
    const process = blocks.find((block) => block.kind === 'process')
    if (!process || process.kind !== 'process') throw new Error('missing process block')
    const { parts, hidden } = recentProcessParts(process, 5)
    expect(hidden).toBe(0)
    expect(parts).toHaveLength(1)
  })
})

describe('one run, one execution box', () => {
  function step(id: string, callId: string): StoredMessage {
    return assistant({
      id,
      content: '',
      toolCalls: [{ id: callId, name: 'read_file', arguments: { path: 'a.ts' } }],
    })
  }

  function output(id: string, callId: string): StoredMessage {
    return {
      id,
      role: 'tool',
      content: 'ok',
      createdAt: '2026-01-01T00:00:00.500Z',
      runId: 'run-1',
      toolCallId: callId,
    }
  }

  it('keeps a note written in the middle of a run inside the same box', () => {
    // 一次运行里，模型常在两批工具调用之间插一句「继续看另一处」。那句说在下一批
    // 调用之前，属于这次运行，不是回答；以前它会把一轮拆成两个执行框。
    const blocks = buildTranscript([
      step('s1', 'call-1'),
      output('t1', 'call-1'),
      assistant({ id: 'note', content: '再看另一处' }),
      step('s2', 'call-2'),
      output('t2', 'call-2'),
      assistant({ id: 'answer', content: '改好了', runId: 'run-1' }),
    ])

    const boxes = blocks.filter((block) => block.kind === 'process')
    expect(boxes).toHaveLength(1)
    // 回答仍然独立成块，而且在图最下面。
    expect(blocks.map((block) => block.kind)).toEqual(['process', 'assistant'])
    const box = boxes[0]
    if (!box || box.kind !== 'process') throw new Error('missing process block')
    expect(box.text).toEqual(['再看另一处'])
  })

  it('starts a new box when the next turn runs again', () => {
    // 新一轮的提问把上一轮的框结束掉：两个 run 就是两个框。
    const blocks = buildTranscript([
      assistant({ id: 'u1', role: 'user', content: '第一件事', runId: undefined }),
      step('s1', 'call-1'),
      output('t1', 'call-1'),
      assistant({ id: 'a1', content: '第一件完成', runId: 'run-1' }),
      {
        id: 'u2',
        role: 'user',
        content: '第二件事',
        createdAt: '2026-01-01T00:00:02.000Z',
      },
      assistant({
        id: 's2',
        content: '',
        runId: 'run-2',
        createdAt: '2026-01-01T00:00:03.000Z',
        toolCalls: [{ id: 'call-2', name: 'git_status', arguments: {} }],
      }),
      {
        id: 't2',
        role: 'tool',
        content: 'clean',
        createdAt: '2026-01-01T00:00:03.500Z',
        runId: 'run-2',
        toolCallId: 'call-2',
      },
      assistant({ id: 'a2', content: '第二件完成', runId: 'run-2', createdAt: '2026-01-01T00:00:04.000Z' }),
    ])

    const boxes = blocks.filter((block) => block.kind === 'process')
    expect(boxes).toHaveLength(2)
    expect(boxes.map((block) => (block.kind === 'process' ? block.runId : ''))).toEqual([
      'run-1',
      'run-2',
    ])
  })
})

describe('report written before the closing cleanup', () => {
  function report(): string {
    const rows = Array.from({ length: 8 }, (_, index) => `| 检查项 ${index + 1} | 实测值 ${index + 1} | 结论正常 |`)
    return [
      '## 结果',
      '',
      '按只读方式完成探查，没有修改任何文件，也没有重启容器。',
      '',
      '### 一、部署现状',
      '',
      '| 项 | 值 | 结论 |',
      '| --- | --- | --- |',
      ...rows,
      '',
      '### 二、待办',
      '',
      '- 提醒任务的异常日志需要补一层上下文',
      '- 支付回调的签名校验只应该做一次',
      '- 前端构建产物需要重新生成',
      '- 部署文档补一节回滚步骤',
      '',
      '```',
      'ssh root@host "docker ps --format {{.Names}}"',
      '```',
      '',
      '以上均为实测结果，本轮未做任何变更。',
    ].join('\n')
  }

  function cleanupStep(): StoredMessage {
    return {
      id: 'cleanup',
      role: 'assistant',
      content: '',
      createdAt: '2026-01-01T00:00:03.000Z',
      runId: 'run-1',
      toolCalls: [{ id: 'call-clean', name: 'run_shell', arguments: { command: 'rm tmp/probe.sh' } }],
    }
  }

  function cleanupOutput(): StoredMessage {
    return {
      id: 'cleanup-output',
      role: 'tool',
      content: 'removed',
      createdAt: '2026-01-01T00:00:03.500Z',
      runId: 'run-1',
      toolCallId: 'call-clean',
    }
  }

  it('shows the report in the dialogue instead of the collapsed box', () => {
    // 真实现场：模型先写完 7KB 结果，然后删临时脚本、给出一句收尾。旧规则按
    // 「这一段后面还有步骤」把报告塞进执行框，正文只剩那句收尾。
    const body = report()
    const blocks = buildTranscript([
      assistant({
        id: 'work',
        content: '',
        toolCalls: [{ id: 'call-1', name: 'run_shell', arguments: { command: 'ssh host ls' } }],
      }),
      {
        id: 'work-output',
        role: 'tool',
        content: 'total 12',
        createdAt: '2026-01-01T00:00:01.500Z',
        runId: 'run-1',
        toolCallId: 'call-1',
      },
      assistant({ id: 'report', content: body }),
      cleanupStep(),
      cleanupOutput(),
      assistant({ id: 'closing', content: '临时脚本已清理。' }),
    ])

    const answer = blocks.find((block) => block.id === 'report')
    expect(answer?.kind).toBe('assistant')
    expect(answer?.kind === 'assistant' ? answer.content : '').toBe(body)
    // 报告之后的那次清理仍是过程：单独一个框，排在报告下面。
    expect(blocks.map((block) => block.kind)).toEqual([
      'process',
      'assistant',
      'process',
      'assistant',
    ])
    const box = blocks[2]
    expect(box?.kind === 'process' ? box.tools.length : 0).toBe(1)
    // 报告不再作为说明出现在任何执行框里。
    for (const block of blocks) {
      if (block.kind !== 'process') continue
      expect(block.text.some((part) => part.length >= body.length)).toBe(false)
    }
  })

  it('keeps a report that shares its message with closing tool calls', () => {
    const body = report()
    const blocks = buildTranscript([
      assistant({
        id: 'report-and-clean',
        content: body,
        toolCalls: [{ id: 'call-clean', name: 'run_shell', arguments: { command: 'rm -f tmp.sh' } }],
      }),
      cleanupOutput(),
      assistant({ id: 'closing', content: '收尾完成。' }),
    ])
    expect(blocks.map((block) => block.kind)).toEqual(['assistant', 'process', 'assistant'])
    expect(blocks[0]?.kind === 'assistant' ? blocks[0].content : '').toBe(body)
  })

  it('keeps a short mid-run sentence inside the box', () => {
    // 回归护栏：长报告之外的说明仍属于过程，不能被提到正文里。
    const blocks = buildTranscript([
      assistant({
        id: 'step-1',
        content: '',
        toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'a.ts' } }],
      }),
      assistant({ id: 'note', content: '## 下一步\n继续看另一处实现。' }),
      assistant({
        id: 'step-2',
        content: '',
        toolCalls: [{ id: 'call-2', name: 'read_file', arguments: { path: 'b.ts' } }],
      }),
      assistant({ id: 'answer', content: '看完了。' }),
    ])
    expect(blocks.map((block) => block.kind)).toEqual(['process', 'assistant'])
    const box = blocks[0]
    expect(box?.kind === 'process' ? box.text : []).toEqual(['## 下一步\n继续看另一处实现。'])
  })

  it('counts a report as the run\'s answer so paging does not add a placeholder', () => {
    // 报告已经是这一轮可见的交付物，分页回看时不需要再加一个「未载入」占位框。
    const messages = [
      assistant({
        id: 'step-1',
        content: '',
        toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'a.ts' } }],
      }),
      assistant({ id: 'report', content: report() }),
      cleanupStep(),
      assistant({ id: 'closing', content: '收尾完成。' }),
    ]
    expect([...runsWithAnswer(messages)]).toEqual(['run-1'])
  })
})

describe('isDeliverableText', () => {
  it('separates a report from a line of narration', () => {
    // 同一个判据在流式阶段也生效：报告不滑进执行框。
    expect(isDeliverableText('## 结果\n\n已完成探查，没有改动任何文件。')).toBe(false)
    expect(
      isDeliverableText(
        `## 结果\n\n${'按只读方式完成探查，未做任何变更。'.repeat(20)}\n\n### 一、现状`,
      ),
    ).toBe(true)
    expect(isDeliverableText('再看另一处实现。')).toBe(false)
    const table = ['| 项 | 值 |', '| --- | --- |', '| a | 1 |', `| b | ${'x'.repeat(320)} |`]
    expect(isDeliverableText(table.join('\n'))).toBe(true)
    expect(isDeliverableText(`看完了，${'没有其它发现。'.repeat(60)}`)).toBe(false)
  })
})

describe('buildTranscript plan snapshots', () => {
  it('carries the turn plan through to the rendered assistant answer', () => {
    const blocks = buildTranscript([assistant({ plan: plan() })])
    expect(blocks).toHaveLength(1)
    const block = blocks[0]
    expect(block?.kind).toBe('assistant')
    expect(block?.kind === 'assistant' ? block.plan?.goal : undefined).toBe('修复登录')
  })

  it('leaves answers without a plan unchanged', () => {
    const blocks = buildTranscript([assistant()])
    expect(blocks[0]?.kind).toBe('assistant')
    expect(blocks[0]?.kind === 'assistant' ? blocks[0].plan : null).toBeUndefined()
  })

  it('does not attach the plan to the collapsed process block', () => {
    const blocks = buildTranscript([
      assistant({
        id: 'tool-turn',
        content: '',
        toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'a.ts' } }],
        plan: plan(),
      }),
      assistant({ id: 'answer', content: '完成', plan: plan() }),
    ])
    const process = blocks.find((block) => block.kind === 'process')
    const answer = blocks.find((block) => block.kind === 'assistant')
    expect(process ? Object.hasOwn(process, 'plan') : false).toBe(false)
    expect(answer?.kind === 'assistant' ? answer.plan?.items.length : undefined).toBe(2)
  })
})
