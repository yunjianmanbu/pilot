import { describe, expect, it } from 'vitest'
import {
  collapseCompletedTurns,
  compactToolResults,
  COMPACTED_MARKER,
  declarationSkeleton,
  DEFAULT_COMPACT_ABOVE,
  DIGEST_MAX_CHARS,
  estimateTokens,
  fitMessages,
  messagesTokens,
  stripSummaryFraming,
  summaryMessageContent,
  trimMessages,
  truncateMiddle,
  toolOutputCharsFor,
} from '../src/main/agent/context'
import type { AgentMessage } from '../src/shared/types'

function toolMessage(content: string): AgentMessage {
  return { role: 'tool', content, toolCallId: 'call-1', name: 'read_file' }
}

describe('token estimation', () => {
  it('charges CJK characters more than ASCII', () => {
    expect(estimateTokens('中文'.repeat(100))).toBeGreaterThan(estimateTokens('a'.repeat(100)))
  })

  it('counts tool call arguments', () => {
    const message: AgentMessage = {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'src/index.ts' } }],
    }
    expect(estimateTokens('')).toBe(0)
    expect(messagesTokens([message])).toBeGreaterThan(4)
  })
})

describe('compactToolResults', () => {
  it('keeps recent tool results verbatim and elides older ones', () => {
    const messages = Array.from({ length: 10 }, (_, index) =>
      toolMessage(`result-${index}\n${'x'.repeat(2_000)}`),
    )
    const result = compactToolResults(messages, { keepRecentToolResults: 2 })
    expect(result.compacted).toBe(8)
    expect(result.savedChars).toBeGreaterThan(0)
    const compacted = result.messages[0]!
    expect(compacted.content.startsWith(COMPACTED_MARKER)).toBe(true)
    expect(compacted.content).toContain('result-0')
    expect(result.messages[8]).toBe(messages[8])
    expect(result.messages[9]).toBe(messages[9])
  })

  it('names the source so the model can decide whether to re-read', () => {
    const messages: AgentMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'src/a.ts' } }],
      },
      { ...toolMessage(`old-read\n${'x'.repeat(2_000)}`), toolCallId: 'call-1' },
      ...Array.from({ length: 3 }, (_, index) => toolMessage(`recent-${index}\n${'y'.repeat(2_000)}`)),
    ]
    const result = compactToolResults(messages, { keepRecentToolResults: 1 })
    expect(result.compacted).toBeGreaterThan(0)
    expect(result.messages[1]?.content).toContain('[来源] read_file src/a.ts')
    expect(result.messages[1]?.content).toContain('需要完整内容时请重新读取')
  })

  it('keeps a declaration skeleton so the middle of a file is still nameable', () => {
    const source = [
      '/* licence header */',
      ...Array.from({ length: 40 }, (_, index) => `export function fn${index}(): void { return }`),
    ].join('\n')
    const result = compactToolResults([toolMessage(source), toolMessage('y'.repeat(2_000))], {
      keepRecentToolResults: 1,
    })
    const compacted = result.messages[0]?.content ?? ''
    expect(compacted).toContain('仅保留首尾与声明骨架')
    // fn20 sits in the elided middle: neither head nor tail reaches it, so it
    // can only come from the skeleton.
    expect(compacted).toContain('export function fn20')
    expect(compacted).toContain('export function fn39')
  })

  it('is idempotent for already compacted output', () => {
    const first = compactToolResults(
      Array.from({ length: 4 }, () => toolMessage('y'.repeat(2_000))),
      { keepRecentToolResults: 1 },
    )
    const second = compactToolResults(first.messages, { keepRecentToolResults: 1 })
    expect(second.compacted).toBe(0)
  })
})

describe('declarationSkeleton', () => {
  const file = (count: number): string =>
    Array.from({ length: count }, (_, index) => `export function fn${index}(): void { return }`).join('\n')

  it('lists declarations in file order when they fit the budget', () => {
    const lines = declarationSkeleton(file(4), 10_000)
    expect(lines).toHaveLength(4)
    expect(lines[0]).toContain('fn0')
    expect(lines[3]).toContain('fn3')
  })

  it('samples instead of truncating when the budget is tight, keeping both ends', () => {
    const lines = declarationSkeleton(file(60), 300)
    expect(lines.length).toBeGreaterThan(2)
    expect(lines.length).toBeLessThan(60)
    expect(lines[0]).toContain('fn0')
    expect(lines[lines.length - 1]).toContain('fn59')
    expect(lines.join('\n').length).toBeLessThanOrEqual(300)
  })

  it('returns nothing for content without declarations', () => {
    expect(declarationSkeleton('<html>\n  <body>hi</body>\n</html>', 5_000)).toEqual([])
    expect(declarationSkeleton('2026-01-01 INFO started\n2026-01-01 INFO done', 5_000)).toEqual([])
  })

  it('returns nothing when there is no real structure to summarise', () => {
    expect(declarationSkeleton('export const a = 1\nexport const b = 2', 5_000)).toEqual([])
    expect(declarationSkeleton(file(4), 0)).toEqual([])
  })
})

describe('trimMessages', () => {
  it('cuts only at user boundaries and carries the earlier task as finished background', () => {
    const messages: AgentMessage[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'A'.repeat(4_000) },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'B'.repeat(1_000) },
      { role: 'assistant', content: 'second answer' },
    ]
    const result = trimMessages(messages, 800, 1)
    expect(result.droppedMessages).toBe(2)
    expect(result.messages[0]?.role).toBe('system')
    expect(result.messages[1]?.role).toBe('user')
    // The dropped first message must not read as the task any more: in a long
    // session that framing pulled the run back to work that already finished.
    expect(result.messages[1]?.content).toContain('[更早的任务 · 已完成，除非用户重提否则忽略]')
    expect(result.messages[1]?.content).toContain('[当前任务]')
    expect(result.messages[1]?.content).not.toContain('[原始任务]')
    expect(result.estimatedTokens).toBeLessThanOrEqual(800)
  })

  it('does not treat a loop-injected reminder as the newer task', () => {
    // The only thing after the head is a reminder the loop wrote itself. That
    // does not close the head, so the head stays the live task instead of being
    // demoted to finished work and the reminder becoming "the current task".
    const messages: AgentMessage[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'A'.repeat(4_000) },
      { role: 'assistant', content: 'working' },
      { role: 'user', content: '[运行反思] pause and review', internal: true },
      { role: 'assistant', content: 'reviewed' },
    ]
    const result = trimMessages(messages, 800, 3)
    // The head stays the live task instead of being demoted to closed work, and
    // the reminder is never relabelled as "the current task". A head that alone
    // exceeds the budget is now clipped to fit rather than replayed whole.
    const head = result.messages.find((message) => message.content.includes('A'.repeat(100)))
    expect(head?.content).not.toContain('[更早的任务')
    const currentTasks = result.messages.filter((message) =>
      message.content.includes('[当前任务]'),
    )
    expect(currentTasks).toHaveLength(1)
    expect(currentTasks[0]?.content).toContain('A'.repeat(100))
    expect(result.estimatedTokens).toBeLessThanOrEqual(800)
  })

  it('does not stack the earlier-task label when re-trimmed', () => {
    const messages: AgentMessage[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'A'.repeat(4_000) },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'B'.repeat(1_000) },
      { role: 'assistant', content: 'second answer' },
    ]
    const once = trimMessages(messages, 800, 1)
    const twice = trimMessages(once.messages, 800, 1)
    // A second trim must not wrap the already-wrapped head again: the label is
    // repeated in the prompt but the transcript keeps growing otherwise.
    expect(twice.messages[1]?.content.match(/更早的任务/g)).toHaveLength(1)
    expect(twice.messages[1]?.content).toContain('A'.repeat(100))
  })

  it('labels the head as finished work when the cut lands on a loop reminder', () => {
    const messages: AgentMessage[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'A'.repeat(4_000) },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: '修复' },
      { role: 'assistant', content: 'working on it' },
      // The loop pushes its own reminders as role 'user'.
      { role: 'user', content: '[运行反思] 复盘一下', internal: true },
      { role: 'assistant', content: 'again'.repeat(400) },
    ]
    const result = trimMessages(messages, 800, 1)
    const text = result.messages.map((message) => message.content).join('\n')
    // The head is the session's first request, so it must read as closed work
    // even though the retained tail starts with a system-written reminder.
    expect(text).toContain('[更早的任务 · 已完成，除非用户重提否则忽略]')
    // And the instruction this run is working on survives the cut.
    expect(text).toContain('修复')
  })

  it('leaves a transcript below budget untouched', () => {
    const messages: AgentMessage[] = [{ role: 'user', content: 'hello' }]
    const result = trimMessages(messages, 10_000)
    expect(result.messages).toBe(messages)
    expect(result.droppedMessages).toBe(0)
  })

  it('trims a single long task that owns the whole transcript', () => {
    // One open task with no second user turn and no reminder: the old code
    // pinned the cut to that task's own boundary, so nothing was ever dropped
    // and a long run kept paying for the same history on every step.
    const messages: AgentMessage[] = [{ role: 'system', content: 'sys' }]
    messages.push({ role: 'user', content: '补齐五项 UI 改造' })
    for (let index = 0; index < 60; index += 1) {
      messages.push(toolMessage(`output-${index}\n${'z'.repeat(3_000)}`))
      messages.push({ role: 'assistant', content: `step ${index}` })
    }
    const before = messagesTokens(messages)
    const budget = Math.floor(before / 4)
    const result = trimMessages(messages, budget)
    expect(result.estimatedTokens).toBeLessThanOrEqual(budget)
    expect(result.droppedMessages).toBeGreaterThan(0)
    // The task the run is working on survives at the head of the kept turns.
    const text = result.messages.map((message) => message.content).join('\n')
    expect(text).toContain('补齐五项 UI 改造')
    expect(text).toContain('[当前任务]')
  })

  it('keeps a single long task and its newest steps inside a tight budget', () => {
    const messages: AgentMessage[] = [{ role: 'system', content: 'sys' }]
    messages.push({ role: 'user', content: 'A'.repeat(20_000) })
    for (let index = 0; index < 40; index += 1) {
      messages.push({ role: 'assistant', content: `answer ${index} ${'y'.repeat(500)}` })
    }
    const result = trimMessages(messages, 9_000)
    // The head alone is bigger than the budget, so only its prefix can survive;
    // what must not happen is returning the whole oversized transcript.
    expect(result.estimatedTokens).toBeLessThan(20_000)
    expect(result.droppedMessages).toBeGreaterThan(0)
    expect(result.messages.some((message) => message.role === 'user')).toBe(true)
  })
})

describe('fitMessages', () => {
  it('compacts before dropping turns', () => {
    const messages: AgentMessage[] = [{ role: 'system', content: 'sys' }]
    messages.push({ role: 'user', content: 'task' })
    for (let index = 0; index < 12; index += 1) {
      messages.push(toolMessage(`output-${index}\n${'z'.repeat(3_000)}`))
    }
    messages.push({ role: 'user', content: 'follow up' })
    const before = messagesTokens(messages)
    const fitted = fitMessages(messages, Math.floor(before / 2))
    expect(fitted.compacted).toBeGreaterThan(0)
    expect(fitted.estimatedTokens).toBeLessThanOrEqual(Math.floor(before / 2))
  })

  it('leaves a transcript that already fits verbatim so the prefix keeps hitting', () => {
    const messages: AgentMessage[] = [{ role: 'system', content: 'sys' }]
    messages.push({ role: 'user', content: 'task' })
    for (let index = 0; index < 12; index += 1) {
      messages.push(toolMessage(`output-${index}\n${'z'.repeat(3_000)}`))
    }
    const fitted = fitMessages(messages, messagesTokens(messages) * 2)
    expect(fitted.compacted).toBe(0)
    expect(fitted.messages).toBe(messages)
    expect(fitted.droppedMessages).toBe(0)
  })

  it('treats compactAbove: 0 as the old compact-on-every-step behaviour', () => {
    const messages: AgentMessage[] = [{ role: 'system', content: 'sys' }]
    messages.push({ role: 'user', content: 'task' })
    for (let index = 0; index < 12; index += 1) {
      messages.push(toolMessage(`output-${index}\n${'z'.repeat(3_000)}`))
    }
    const fitted = fitMessages(messages, messagesTokens(messages) * 2, { compactAbove: 0 })
    expect(fitted.compacted).toBeGreaterThan(0)
  })

  // The gate stays at 0.7 on purpose: raising it to 0.8 was measured and did not
  // reduce the number of rewrites (steady state fires about once per growing
  // step either way) while pushing more steps into the aggressive pass. Pinned
  // on both sides so a future edit cannot move it silently.
  it('defaults to compacting only once the transcript is past 70% of the budget', () => {
    expect(DEFAULT_COMPACT_ABOVE).toBe(0.7)
    const messages: AgentMessage[] = [{ role: 'system', content: 'sys' }]
    messages.push({ role: 'user', content: 'task' })
    for (let index = 0; index < 12; index += 1) {
      messages.push(toolMessage(`output-${index}\n${'z'.repeat(3_000)}`))
    }
    const used = messagesTokens(messages)
    // Budget sized so the transcript sits at ~65% of it: below the gate, so the
    // cached prefix must survive.
    const under = fitMessages(messages, Math.ceil(used / 0.65))
    expect(under.compacted).toBe(0)
    expect(under.messages).toBe(messages)
    // ~75% of the budget: past the gate, so the rewrite must happen.
    const over = fitMessages(messages, Math.ceil(used / 0.75))
    expect(over.compacted).toBeGreaterThan(0)
  })
})

describe('collapseCompletedTurns', () => {
  const turn = (index: number): AgentMessage[] => [
    { role: 'user', content: `request ${index}` },
    { role: 'assistant', content: `answer ${index}` },
  ]

  it('keeps the newest two turns verbatim and folds the rest into one digest', () => {
    const messages: AgentMessage[] = [...turn(1), ...turn(2), ...turn(3)]
    const result = collapseCompletedTurns(messages)
    expect(result.collapsedTurns).toBe(1)
    const [digest, ...rest] = result.messages
    // Flagged internal: later compaction passes must not re-frame this digest
    // and strip its "closed work" label.
    expect(digest?.earlierWork).toBe(true)
    expect(digest?.content).toContain('[更早的任务 · 已完成，除非用户重提否则忽略]')
    expect(digest?.content).toContain('请求：request 1')
    // The tail is replayed unchanged so the live turn keeps its tool pairs.
    expect(rest).toEqual([...turn(2), ...turn(3)])
    // The finished turn survives only as a request/conclusion pair.
    expect(result.messages.filter((message) => message.content === 'answer 1')).toHaveLength(0)
    expect(digest?.content).toContain('结论：answer 1')
  })

  it('keeps the turns that just closed when the digest cap is tight', () => {
    const messages: AgentMessage[] = []
    for (let index = 1; index <= 30; index += 1) messages.push(...turn(index))
    const result = collapseCompletedTurns(messages, 2, 400)
    const digest = result.messages[0]?.content ?? ''
    // A cap filled oldest-first spent itself on requests 1-3 and dropped the
    // turns that had just ended, so a long session's digest opened with the
    // task the model was already being pulled back to.
    expect(digest).toContain('请求：request 28')
    expect(digest).toContain('结论：answer 28')
    expect(digest).not.toContain('结论：answer 1\n')
    expect(digest).toContain('越早越先省略')
    // Replayed tail is still the live turns, unchanged.
    expect(result.messages.slice(1)).toEqual([...turn(29), ...turn(30)])
  })

  it('leaves a session with two turns or fewer untouched', () => {
    const messages: AgentMessage[] = [...turn(1), ...turn(2)]
    const result = collapseCompletedTurns(messages)
    expect(result.messages).toBe(messages)
    expect(result.collapsedTurns).toBe(0)
  })

  it('drops tool traffic from the digest, keeping the request and the conclusion', () => {
    const messages: AgentMessage[] = [
      { role: 'user', content: 'give me the theme plan' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'styles.css' } }],
      },
      { role: 'tool', content: 'x'.repeat(5_000), toolCallId: 'c1', name: 'read_file' },
      { role: 'assistant', content: 'theme plan delivered' },
      ...turn(2),
      ...turn(3),
    ]
    const result = collapseCompletedTurns(messages)
    const digest = result.messages[0]?.content ?? ''
    expect(digest).toContain('give me the theme plan')
    expect(digest).toContain('theme plan delivered')
    expect(digest).not.toContain('x'.repeat(5_000))
    expect(result.savedChars).toBeGreaterThan(4_000)
  })

  it('keeps a pinned model summary instead of compressing it twice', () => {
    const summary: AgentMessage = {
      role: 'user',
      content: summaryMessageContent('Goal: old task\nFacts: durable fact'),
      contextSummary: true,
    }
    const messages: AgentMessage[] = [
      { role: 'user', content: 'first task' },
      summary,
      ...turn(2),
      ...turn(3),
    ]
    const result = collapseCompletedTurns(messages)
    expect(result.messages[1]).toBe(summary)
    expect(result.messages[0]?.content).toContain('first task')
  })

  it('keeps a long first instruction from competing with the newest request', () => {
    // Reproduces the session shape that made a run answer an older task: the
    // first user message was the largest instruction in the prompt and every
    // later turn replayed it verbatim.
    const messages: AgentMessage[] = [
      { role: 'user', content: `给出 pilot 的主题优化方案 ${'T'.repeat(4_000)}` },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 't1', name: 'read_file', arguments: { path: 'styles.css' } }],
      },
      { role: 'tool', content: 'x'.repeat(8_000), toolCallId: 't1', name: 'read_file' },
      { role: 'assistant', content: `主题方案：${'P'.repeat(4_000)}` },
      { role: 'user', content: '指令编辑后 保存并重新生成没有生效' },
      { role: 'assistant', content: '先看 regenerate 的调用链' },
      { role: 'user', content: '修复' },
    ]
    const result = collapseCompletedTurns(messages)
    const prompt = result.messages.map((message) => message.content).join('\n')
    // The newest instructions survive; the old task survives only as a short,
    // explicitly closed line.
    expect(prompt).toContain('修复')
    expect(prompt).toContain('指令编辑后 保存并重新生成没有生效')
    expect(prompt).not.toContain('T'.repeat(1_000))
    expect(prompt).not.toContain('P'.repeat(1_000))
    expect(result.messages[0]?.content).toContain('已完成，除非用户重提否则忽略')
    expect(prompt.length).toBeLessThan(2_000)
  })

  it('keeps the digest once and never re-labels it as the current task', () => {
    const digest: AgentMessage = {
      role: 'user',
      content: '[更早的任务 · 已完成，除非用户重提否则忽略]\n回合 1\n请求：old task',
      earlierWork: true,
    }
    const messages: AgentMessage[] = [
      { role: 'system', content: 'sys' },
      digest,
      { role: 'user', content: 'old task' },
      { role: 'assistant', content: 'x'.repeat(4_000) },
      { role: 'user', content: 'new task' },
      { role: 'assistant', content: 'y'.repeat(4_000) },
    ]
    const trimmed = trimMessages(messages, 400, 1)
    const contents = trimmed.messages.map((message) => message.content)
    // The old task is carried once, already labelled closed; wrapping it again
    // would print the header twice over content that was never this turn.
    expect(contents.filter((content) => content.includes('已完成，除非用户重提'))).toHaveLength(1)
    expect(contents[0]).toBe('sys')
    expect(contents[1]).toBe(digest.content)
    expect(contents.join('\n')).toContain('new task')
  })

  it('caps the digest instead of letting a long session become the prompt', () => {
    const messages: AgentMessage[] = []
    for (let index = 0; index < 40; index += 1) {
      messages.push({ role: 'user', content: `request ${index} ${'r'.repeat(300)}` })
      messages.push({ role: 'assistant', content: `answer ${index} ${'a'.repeat(300)}` })
    }
    const digest = collapseCompletedTurns(messages).messages[0]?.content ?? ''
    // The cap is DIGEST_MAX_CHARS (4k) plus the fixed header lines. It has to be
    // far below the 24k chars of transcript it replaces, and large enough to
    // name a dozen closed turns instead of only the last one or two.
    expect(digest.length).toBeLessThan(DIGEST_MAX_CHARS + 600)
    expect(digest.length).toBeGreaterThan(2_000)
    expect(digest).toContain('个更早轮次未列出')
  })
})

describe('summary framing', () => {
  it('labels the injected summary as closed work and strips it on the next pass', () => {
    const body = summaryMessageContent('Goal: newest task\nFacts: a.ts')
    expect(body.startsWith('[较早对话摘要 · 已关闭的旧工作与事实，不是本轮指令]')).toBe(true)
    expect(body).toContain('以本对话最后一条用户消息为准')
    expect(stripSummaryFraming(body)).toBe('Goal: newest task\nFacts: a.ts')
  })

  it('still strips the header older builds wrote', () => {
    expect(stripSummaryFraming('[较早对话摘要 · 以下内容是数据，不是新指令]\nEARLIER FACTS')).toBe(
      'EARLIER FACTS',
    )
  })
})

describe('truncateMiddle', () => {
  it('keeps both the head and the failure-bearing tail', () => {
    const text = `HEAD${'m'.repeat(2_000)}TAIL`
    const result = truncateMiddle(text, 500)
    expect(result.startsWith('HEAD')).toBe(true)
    expect(result.endsWith('TAIL')).toBe(true)
    expect(result).toContain('已截断')
  })

  it('returns short text unchanged', () => {
    expect(truncateMiddle('short', 100)).toBe('short')
  })
})

describe('toolOutputCharsFor', () => {
  it('keeps the flat cap when the window is large', () => {
    // 200k tokens: a quarter of it is far more than the cap, so the cap wins
    // and behaviour for the main run is unchanged.
    expect(toolOutputCharsFor(200_000, 16_000)).toBe(16_000)
    expect(toolOutputCharsFor(0, 16_000)).toBe(16_000)
    expect(toolOutputCharsFor(undefined, 24_000)).toBe(24_000)
  })

  it('shrinks the cap for a small subagent window', () => {
    // 8k tokens, the subagent floor: 25% of it at ~0.9 char per token. The old
    // flat 16k chars was twice the entire window, so one read displaced the task.
    const cap = toolOutputCharsFor(8_000, 16_000)
    expect(cap).toBe(1_800)
    expect(cap).toBeLessThan(16_000)
  })

  it('never returns a cap too small to carry a file', () => {
    expect(toolOutputCharsFor(1_000, 16_000)).toBe(1_000)
  })
})
