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
