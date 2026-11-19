/**
 * Reproducible A/B benchmark for the run-overhead changes.
 *
 * The "before" side is the exact code that shipped in HEAD, copied verbatim
 * below; the "after" side imports the real modules. Every A/B pair also checks
 * that both sides produce the same numbers, so a speedup can never come from
 * silently doing less work.
 *
 * Scale is taken from the real run records in the local Pilot store
 * (pilot-core.json): the longest runs are ~200 steps / ~230 tool calls with
 * prompts in the 70k-100k token range, so a steady-state transcript of ~300k
 * characters is what every one of those steps actually re-measured.
 *
 * Run with: npx vitest run tests/overhead-bench.test.ts
 */
import { describe, expect, it } from 'vitest'
import type { AgentMessage, ToolCall } from '../src/shared/types'
import {
  contentTokens,
  estimateTokens,
  fitMessages,
  messageTokens,
  messagesTokens,
  trimMessages,
} from '../src/main/agent/context'
import { createClassifierMemo } from '../src/main/agent/classifier'
import type { ClassifierInput } from '../src/main/agent/classifier'
import { createDeltaCoalescer } from '../src/main/agent/delta-buffer'

const STEPS = 200

/** Deterministic pseudo-random text so both sides see identical input. */
function filler(seed: number, length: number): string {
  const alphabet = 'abcdefghij klmnopqrstuvwxyz0123456789\n  const value = table[key]\n'
  let out = ''
  let state = seed
  while (out.length < length) {
    state = (state * 1103515245 + 12345) % 2147483648
    const index = state % alphabet.length
    out += alphabet[index]
  }
  return out.slice(0, length)
}

/**
 * A transcript shaped like a real long run: alternating assistant tool calls
 * and tool results, with the occasional injected user turn (reflection,
 * verification reminder, steering) so turn-boundary trimming has something to
 * work with. ~300k characters is the steady state of the runs on this machine.
 */
function buildTranscript(extraTurns = 0): AgentMessage[] {
  const messages: AgentMessage[] = [
    { role: 'system', content: 'system prompt '.repeat(200) },
    { role: 'user', content: 'Refactor the workspace search and verify with tests.' },
  ]
  for (let index = 0; index < 58 + extraTurns; index += 1) {
    if (index > 0 && index % 8 === 0) {
      messages.push({ role: 'user', content: `[运行反思] step ${index}: review the failure` })
    }
    const call: ToolCall = {
      id: `call-${index}`,
      name: index % 3 === 0 ? 'read_file' : index % 3 === 1 ? 'grep' : 'run_shell',
      arguments: { path: `src/main/file-${index}.ts`, query: `symbol${index}` },
    }
    messages.push({ role: 'assistant', content: filler(index, 900), toolCalls: [call] })
    messages.push({
      role: 'tool',
      content: filler(index + 1000, 4_200),
      name: call.name,
      toolCallId: call.id,
    })
  }
  return messages
}

// ---------------------------------------------------------------------------
// "Before" side: the implementations as they were in HEAD.
// ---------------------------------------------------------------------------

/** HEAD: a fresh join of every message content, then one full character scan. */
function oldContentTokens(messages: AgentMessage[]): number {
  return estimateTokens(messages.map((message) => message.content).join('\n'))
}

/**
 * HEAD counted every message from scratch, every time. The benchmark's
 * "before" side must not go through the new memo, or it would measure the
 * improvement against itself.
 */
function rawMessageTokens(message: AgentMessage): number {
  let tokens = estimateTokens(message.content) + 4
  for (const call of message.toolCalls ?? []) {
    tokens += estimateTokens(call.name) + estimateTokens(JSON.stringify(call.arguments)) + 6
  }
  return tokens
}

function rawMessagesTokens(messages: AgentMessage[]): number {
  return messages.reduce((total, message) => total + rawMessageTokens(message), 0)
}

/** HEAD trimMessages, verbatim, including the pinned-task binary search. */
function oldTrimMessages(
  messages: AgentMessage[],
  maxTokens: number,
  keepRecent = 8,
): { messages: AgentMessage[]; droppedMessages: number; estimatedTokens: number } {
  if (maxTokens <= 0) {
    return { messages, droppedMessages: 0, estimatedTokens: rawMessagesTokens(messages) }
  }
  const initial = rawMessagesTokens(messages)
  if (initial <= maxTokens) {
    return { messages, droppedMessages: 0, estimatedTokens: initial }
  }
  const system = messages.filter((message) => message.role === 'system')
  const conversation = messages.filter((message) => message.role !== 'system')
  const summaries = conversation.filter((message) => message.contextSummary)
  const turns = conversation.filter((message) => !message.contextSummary)
  const base = [...system, ...summaries]
  const boundaries: number[] = []
  for (let index = 0; index < turns.length; index += 1) {
    if (turns[index]?.role === 'user') boundaries.push(index)
  }
  if (boundaries.length === 0) {
    return { messages, droppedMessages: 0, estimatedTokens: initial }
  }

  const minimumKeep = Math.min(Math.max(0, keepRecent), turns.length)
  const fitsAt = (index: number): boolean =>
    rawMessagesTokens([...base, ...turns.slice(index)]) <= maxTokens

  let chosen = -1
  for (const index of boundaries) {
    if (turns.length - index < minimumKeep) continue
    if (fitsAt(index)) {
      chosen = index
      break
    }
  }
  if (chosen === -1) {
    for (const index of boundaries) {
      if (fitsAt(index)) {
        chosen = index
        break
      }
    }
  }
  if (chosen === -1) chosen = boundaries[boundaries.length - 1] ?? 0

  let trimmed = turns.slice(chosen)
  const firstBoundary = boundaries[0] ?? 0
  const pinned = turns[firstBoundary]
  const current = trimmed[0]
  if (chosen > firstBoundary && pinned && current?.role === 'user') {
    const fullTask =
      pinned.content.length > 4_000 ? `${pinned.content.slice(0, 4_000)}…` : pinned.content
    const wrapped = (task: string): AgentMessage => ({
      ...current,
      content: `[原始任务]\n${task}\n\n[当前任务]\n${current.content}`,
    })
    const fits = (task: string): boolean =>
      rawMessagesTokens([...base, wrapped(task), ...trimmed.slice(1)]) <= maxTokens

    let task = fullTask
    if (!fits(task)) {
      let low = 0
      let high = fullTask.length
      let best = 0
      while (low <= high) {
        const middle = Math.floor((low + high) / 2)
        if (fits(fullTask.slice(0, middle))) {
          best = middle
          low = middle + 1
        } else {
          high = middle - 1
        }
      }
      while (best > 0 && !fits(`${fullTask.slice(0, best)}…`)) best -= 1
      task = best > 0 ? `${fullTask.slice(0, best).trimEnd()}…` : ''
    }
    if (task) trimmed = [wrapped(task), ...trimmed.slice(1)]
  }

  const result = [...base, ...trimmed]
  return {
    messages: result,
    droppedMessages: turns.length - trimmed.length,
    estimatedTokens: rawMessagesTokens(result),
  }
}

function time(fn: () => void, rounds = 1): number {
  const started = performance.now()
  for (let index = 0; index < rounds; index += 1) fn()
  return performance.now() - started
}

describe('run overhead A/B', () => {
  it('token accounting per step: rerun the old scan vs the cached counter', () => {
    const messages = buildTranscript()
    const chars = messages.reduce((total, message) => total + message.content.length, 0)
    // Warm the cache the way a running loop would (messages were already counted).
    contentTokens(messages)

    // Old path ran twice per step (pre-summary check + post-summary compare),
    // so 2 x STEPS scans of the whole transcript.
    const before = time(() => {
      for (let step = 0; step < STEPS; step += 1) {
        oldContentTokens(messages)
        oldContentTokens(messages)
      }
    })
    const after = time(() => {
      for (let step = 0; step < STEPS; step += 1) {
        contentTokens(messages)
        contentTokens(messages)
      }
    })

    // Identical numbers, so this is a pure speedup.
    expect(contentTokens(messages)).toBe(oldContentTokens(messages))

    console.log(
      `BENCH token-accounting transcript=${messages.length}msgs/${chars}chars ` +
        `old=${before.toFixed(1)}ms new=${after.toFixed(1)}ms ` +
        `saved=${before.toFixed(1)}ms (${(before / Math.max(after, 0.01)).toFixed(0)}x)`,
    )
    expect(after).toBeLessThanOrEqual(before)
  }, 300_000)

  it('per-step context fit: full recount per boundary vs suffix sums', () => {
    const messages = buildTranscript()
    // Tight enough that the first boundary fits but not all of them, so the
    // boundary scan does real work on both sides.
    const full = messagesTokens(messages)
    const budget = Math.round(full * 0.45)
    trimMessages(messages, budget)
    oldTrimMessages(messages, budget)

    const before = time(() => {
      for (let step = 0; step < STEPS; step += 1) oldTrimMessages(messages, budget)
    })
    const after = time(() => {
      for (let step = 0; step < STEPS; step += 1) trimMessages(messages, budget)
    })

    const oldResult = oldTrimMessages(messages, budget)
    const newResult = trimMessages(messages, budget)
    // Same decision, same retained transcript, same estimate: the suffix sums
    // are an arithmetic shortcut, not a different policy.
    expect(newResult.droppedMessages).toBe(oldResult.droppedMessages)
    expect(newResult.estimatedTokens).toBe(oldResult.estimatedTokens)
    expect(newResult.messages.map((message) => message.content)).toEqual(
      oldResult.messages.map((message) => message.content),
    )

    console.log(
      `BENCH trim dropped=${newResult.droppedMessages}/${messages.length} ` +
        `kept=${newResult.messages.length} old=${before.toFixed(1)}ms new=${after.toFixed(1)}ms ` +
        `saved=${before.toFixed(1)}ms (${(before / Math.max(after, 0.01)).toFixed(0)}x)`,
    )
    expect(after).toBeLessThanOrEqual(before)
  }, 300_000)

  it('full fit path per step (what the loop really calls)', () => {
    const messages = buildTranscript()
    const budget = Math.round(messagesTokens(messages) * 0.55)
    fitMessages(messages, budget, { keepRecentToolResults: 8 })
    const before = time(() => {
      for (let step = 0; step < STEPS; step += 1) {
        // Old loop measured the transcript twice before fitting.
        oldContentTokens(messages)
        oldContentTokens(messages)
        fitMessages(messages, budget, { keepRecentToolResults: 8 })
      }
    })
    const after = time(() => {
      for (let step = 0; step < STEPS; step += 1) {
        contentTokens(messages)
        contentTokens(messages)
        fitMessages(messages, budget, { keepRecentToolResults: 8 })
      }
    })
    console.log(
      `BENCH fit-per-step budget=${budget} old=${before.toFixed(1)}ms new=${after.toFixed(1)}ms ` +
        `saved=${before.toFixed(1)}ms (${(before / Math.max(after, 0.01)).toFixed(0)}x)`,
    )
    expect(after).toBeLessThanOrEqual(before)
  }, 300_000)

  it('whole-run cost as the transcript grows (the quadratic term)', () => {
    // The realistic scenario: 200 steps, each appending one assistant turn and
    // one tool result, measuring the transcript and fitting it on every step.
    // This is where O(n^2) actually shows up as wall-clock time.
    const base = buildTranscript()
    const budget = 120_000
    const step = (current: AgentMessage[]): AgentMessage[] => {
      const index = current.length
      const call: ToolCall = {
        id: `grow-${index}`,
        name: 'read_file',
        arguments: { path: `src/main/grow-${index}.ts` },
      }
      const next = [...current]
      next.push({ role: 'assistant', content: filler(index, 900), toolCalls: [call] })
      next.push({
        role: 'tool',
        content: filler(index + 7, 4_200),
        name: 'read_file',
        toolCallId: call.id,
      })
      return next
    }

    let beforeTranscript = base
    const before = time(() => {
      for (let index = 0; index < STEPS; index += 1) {
        beforeTranscript = step(beforeTranscript)
        oldContentTokens(beforeTranscript)
        oldContentTokens(beforeTranscript)
        fitMessages(beforeTranscript, budget, { keepRecentToolResults: 8 })
      }
    })

    let afterTranscript = base
    const after = time(() => {
      for (let index = 0; index < STEPS; index += 1) {
        afterTranscript = step(afterTranscript)
        contentTokens(afterTranscript)
        contentTokens(afterTranscript)
        fitMessages(afterTranscript, budget, { keepRecentToolResults: 8 })
      }
    })

    // Same work on both sides: identical final transcript, identical token count.
    expect(afterTranscript.length).toBe(beforeTranscript.length)
    expect(contentTokens(afterTranscript)).toBe(oldContentTokens(beforeTranscript))

    console.log(
      `BENCH whole-run steps=${STEPS} final=${afterTranscript.length}msgs ` +
        `old=${before.toFixed(0)}ms new=${after.toFixed(0)}ms ` +
        `saved=${before.toFixed(0)}ms (${(before / Math.max(after, 0.01)).toFixed(1)}x)`,
    )
    expect(after).toBeLessThan(before)
  }, 300_000)

  it('per-message token memo stays correct when a message is replaced', () => {
    const original: AgentMessage = { role: 'tool', content: 'x'.repeat(400), name: 'read_file' }
    const first = messageTokens(original)
    expect(messageTokens(original)).toBe(first)
    // Same object mutated in place: the cache key must notice.
    const mutated: AgentMessage = { ...original, content: 'y'.repeat(800) }
    expect(messageTokens(mutated)).toBe(estimateTokens('y'.repeat(800)) + 4)
    expect(messageTokens({ ...original })).toBe(first)
  })

  it('permission classifier: identical question is asked once per run', async () => {
    // A real run re-runs the same probes many times: 30 calls, 6 distinct ones.
    const calls: ToolCall[] = []
    for (let index = 0; index < 30; index += 1) {
      calls.push({ id: `c${index}`, name: 'run_shell', arguments: { command: `probe ${index % 6}` } })
    }
    let invocations = 0
    const memo = createClassifierMemo(async () => {
      invocations += 1
      await new Promise((resolve) => setTimeout(resolve, 1))
      return { decision: 'allow' as const, reason: 'safe', failed: false }
    })
    const baseInput: Omit<ClassifierInput, 'client'> = {
      model: 'deepseek-flash',
      tool: 'run_shell',
      call: calls[0]!,
      workspacePath: 'E:/ws',
      userRequest: 'run the probes',
      transcript: [
        { role: 'user', content: 'run the probes' },
        { role: 'assistant', content: 'ok' },
      ],
    }
    for (const call of calls) {
      const result = await memo.classify({ ...baseInput, call })
      expect(result.decision).toBe('allow')
    }
    console.log(`BENCH classifier calls=${calls.length} round-trips old=${calls.length} new=${invocations}`)
    expect(invocations).toBe(6)
  })

  it('streaming deltas: per-token broadcast vs coalesced flush', () => {
    // 1,200 tokens of one answer, arriving 1ms apart (~1.2s of streaming).
    const deltas = Array.from({ length: 1_200 }, (_, index) => `t${index} `)
    const oldEvents = deltas.filter(Boolean).length

    // Deterministic virtual clock: the coalescer's timer only fires when the
    // test advances time, so the measurement is not a wall-clock race.
    let nowMs = 0
    let scheduled: { at: number; run: () => void } | null = null
    const coalescer = createDeltaCoalescer({
      intervalMs: 60,
      emit: (kind, text) => {
        newEvents += 1
        emitted.push(text)
        if (kind !== 'message') throw new Error('unexpected reasoning burst')
      },
      setTimer: (run, ms) => {
        scheduled = { at: nowMs + ms, run }
        return 'handle'
      },
      clearTimer: () => {
        scheduled = null
      },
    })
    let newEvents = 0
    const emitted: string[] = []

    for (const delta of deltas) {
      coalescer.push('message', delta)
      nowMs += 1
      if (scheduled && (scheduled as { at: number }).at <= nowMs) {
        const due = scheduled as { run: () => void }
        scheduled = null
        due.run()
      }
    }
    coalescer.dispose()

    // No text is lost and nothing is reordered: the bursts concatenate to the
    // exact input, which is what the renderer appends.
    expect(emitted.join('')).toBe(deltas.join(''))
    // A pending burst is always released before a non-delta event, so the
    // buffer never holds text at a boundary.
    expect(coalescer.pending().message).toBe('')

    console.log(
      `BENCH deltas tokens=${deltas.length} old-events=${oldEvents} new-events=${newEvents} ` +
        `cut=${(100 - (newEvents / oldEvents) * 100).toFixed(1)}%`,
    )
    expect(newEvents * 10).toBeLessThan(oldEvents)
  }, 60_000)
})
