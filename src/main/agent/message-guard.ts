import type { AgentMessage } from '../../shared/types'

/**
 * A model turn that produced only reasoning ends up as an assistant message with
 * no content and no tool calls. No provider accepts that form: sent as
 * `content: null` DeepSeek rejects the whole request with
 *
 *   Invalid assistant message: content, tool_calls or reasoning_content must be set
 *
 * and because the message is persisted, every later turn of that session fails
 * the same way (including the replay after the user says "continue"). Such a
 * message must never be produced, persisted or replayed.
 */
export function isEmptyAssistant(
  message: Pick<AgentMessage, 'role' | 'content' | 'toolCalls'>,
): boolean {
  return (
    message.role === 'assistant' &&
    !message.content.trim() &&
    (message.toolCalls?.length ?? 0) === 0
  )
}

/**
 * What the model is told when a call has no recorded result.
 *
 * It is an error, not a neutral placeholder: a fabricated success would invite
 * the model to build on work that never happened, and a silent drop is what
 * produced the original 400 in the first place.
 */
export const MISSING_TOOL_RESULT_TEXT =
  'ERROR: no result was recorded for this tool call — the run was interrupted before it returned, or the transcript was compacted. The tool did not report success. Re-run it if you still need its output.'

/**
 * Make the transcript acceptable to a provider before it is sent.
 *
 * Providers require every `assistant.tool_calls[i].id` to have exactly one
 * matching `role: "tool"` message, and reject the whole request otherwise:
 *
 *   400 — "An assistant message with 'tool_calls' must be followed by tool
 *   messages responding to each 'tool_call_id'"
 *
 * Our own history can violate that in two places, both of which rewrite or cut
 * the message array while a run is in flight:
 *
 *   - an interrupted run persists the assistant turn that requested the calls
 *     but never records results for the calls that had not run yet;
 *   - compaction and trimming drop tool results, and the once-only pairing
 *     guard in the trimmer only protects the *start* of the retained tail.
 *
 * Once written, the session fails on every later turn — including the replay
 * after "continue" — so the request is repaired here, at the one place every
 * caller passes through, instead of hoping each producer is correct.
 *
 * The requirement is positional, not merely existential: the results must
 * *follow* the assistant turn, with nothing else in between. A result that
 * survived compaction but ended up after a later user message still provokes the
 * same 400, so it is moved back in front of the blocking message and its content
 * is kept rather than replaced by the synthetic error.
 *
 * The input is never mutated, and when nothing needs repairing the same array
 * reference is returned so the common path costs one pass and no allocation.
 */
export function pairToolResults(messages: AgentMessage[]): {
  messages: AgentMessage[]
  patched: number
  dropped: number
} {
  // Fast path: walk the transcript once as a state machine. Every tool call must
  // be answered before anything other than a tool message may follow it.
  let pendingCalls: string[] | null = null
  let needsRepair = false
  for (const message of messages) {
    if (message.role === 'tool') {
      if (!pendingCalls || !message.toolCallId) {
        needsRepair = true
        break
      }
      const index = pendingCalls.indexOf(message.toolCallId)
      if (index < 0) {
        needsRepair = true
        break
      }
      pendingCalls.splice(index, 1)
      if (pendingCalls.length === 0) pendingCalls = null
      continue
    }
    if (pendingCalls) {
      needsRepair = true
      break
    }
    if (isEmptyAssistant(message)) {
      needsRepair = true
      break
    }
    if (message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0) {
      pendingCalls = (message.toolCalls ?? []).map((call) => call.id).filter(Boolean)
      if (pendingCalls.length === 0) pendingCalls = null
    }
  }
  if (!needsRepair && !pendingCalls) return { messages, patched: 0, dropped: 0 }

  // Repair path. Results are looked up by id instead of being trusted in place,
  // so a misplaced result is re-attached where the provider requires it.
  const results = new Map<string, AgentMessage[]>()
  let dropped = 0
  for (const message of messages) {
    if (message.role !== 'tool') continue
    if (!message.toolCallId) {
      dropped += 1
      continue
    }
    const queue = results.get(message.toolCallId)
    if (queue) queue.push(message)
    else results.set(message.toolCallId, [message])
  }

  const patched = new Set<string>()
  const used = new Set<AgentMessage>()
  const result: AgentMessage[] = []
  for (const message of messages) {
    if (message.role === 'tool') continue
    if (isEmptyAssistant(message)) continue
    result.push(message)
    if (message.role !== 'assistant' || (message.toolCalls?.length ?? 0) === 0) continue
    for (const call of message.toolCalls ?? []) {
      if (!call.id) continue
      const queue = results.get(call.id)
      const answer = queue?.shift()
      if (answer) {
        used.add(answer)
        result.push(answer)
        continue
      }
      if (patched.has(call.id)) continue
      patched.add(call.id)
      result.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: MISSING_TOOL_RESULT_TEXT,
        isError: true,
      })
    }
  }

  // Whatever is left had no call to answer: an orphan, or a duplicate answer.
  for (const queue of results.values()) dropped += queue.length

  return { messages: result, patched: patched.size, dropped }
}
