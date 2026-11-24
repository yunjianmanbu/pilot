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
 * The input is never mutated, and when nothing needs repairing the same array
 * reference is returned so the common path costs one pass and no allocation.
 */
export function pairToolResults(messages: AgentMessage[]): {
  messages: AgentMessage[]
  patched: number
  dropped: number
} {
  const callIds = new Set<string>()
  const answeredIds = new Set<string>()
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      if (call.id) callIds.add(call.id)
    }
    if (message.role === 'tool' && message.toolCallId) answeredIds.add(message.toolCallId)
  }

  const patched = new Set<string>()
  let dropped = 0
  let changed = false
  const result: AgentMessage[] = []
  for (const message of messages) {
    // A tool result whose call is no longer in the request, or which has no id
    // at all, is an orphan the provider rejects.
    if (message.role === 'tool') {
      if (!message.toolCallId || !callIds.has(message.toolCallId)) {
        dropped += 1
        changed = true
        continue
      }
      result.push(message)
      continue
    }
    if (isEmptyAssistant(message)) {
      changed = true
      continue
    }
    result.push(message)
    if (message.role !== 'assistant' || (message.toolCalls?.length ?? 0) === 0) continue
    for (const call of message.toolCalls ?? []) {
      if (!call.id || answeredIds.has(call.id) || patched.has(call.id)) continue
      patched.add(call.id)
      changed = true
      result.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: MISSING_TOOL_RESULT_TEXT,
        isError: true,
      })
    }
  }

  if (!changed) return { messages, patched: 0, dropped: 0 }
  return { messages: result, patched: patched.size, dropped }
}
