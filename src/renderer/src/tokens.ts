import type { AgentMessage } from '../../shared/types'

/**
 * Conservative character-based estimate of prompt size, shared with the main
 * process estimator (`src/main/agent/context.ts`). ASCII/code averages ~3.6
 * characters per token; CJK is close to one token per character, so the two
 * classes are counted separately. Pure arithmetic: no tokenizer download and no
 * model request, so it can run on every renderer keystroke.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let ascii = 0
  let wide = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) < 0x80) ascii += 1
    else wide += 1
  }
  return Math.max(1, Math.ceil(ascii / 3.6 + wide * 1.1))
}

/** Prompt cost of one message: content, a small per-message overhead, and its tool calls. */
export function messageTokens(message: AgentMessage): number {
  let tokens = estimateTokens(message.content) + 4
  for (const call of message.toolCalls ?? []) {
    tokens += estimateTokens(call.name) + estimateTokens(JSON.stringify(call.arguments)) + 6
  }
  return tokens
}

export interface TranscriptUsage {
  /** Estimated tokens the next request will carry. */
  tokens: number
  messages: number
}

/**
 * Estimated footprint of the transcript that will be re-sent with the next
 * request, plus whatever the model is currently streaming (that output becomes
 * part of the next prompt).
 */
export function transcriptUsage(
  messages: readonly AgentMessage[],
  liveText = '',
): TranscriptUsage {
  let tokens = 0
  for (const message of messages) tokens += messageTokens(message)
  if (liveText) tokens += estimateTokens(liveText)
  return { tokens, messages: messages.length }
}
