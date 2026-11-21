import type { Session, SessionPage, SessionProcessSummary, StoredMessage } from '../shared/types'

/**
 * Paging for the chat transcript.
 *
 * A stored transcript interleaves two very different things: the dialogue
 * (what the user asked and what Pilot answered) and the execution steps of each
 * run (assistant tool-call turns plus their tool results). The full page mixes
 * both, so scrolling back through an old conversation drags every tool call and
 * its output into the renderer even though the reader only asked for earlier
 * messages.
 *
 * `dialoguePage` pages on dialogue messages only and reports the runs it
 * skipped, so the renderer can show a collapsed placeholder and fetch those
 * steps when the reader actually expands the box.
 */

const MIN_PAGE = 1
const MAX_PAGE = 300

export function pageLimit(limit?: number): number {
  return Math.max(MIN_PAGE, Math.min(MAX_PAGE, Math.round(limit ?? 120) || 120))
}

/** A message the conversation shows on its own, without the execution box. */
export function isDialogueMessage(message: StoredMessage): boolean {
  if (message.role === 'user') {
    return Boolean(message.content.trim()) || Boolean(message.images?.length)
  }
  if (message.role === 'assistant') {
    // A tool-call turn is an execution step even when it carries a short note.
    if (message.toolCalls && message.toolCalls.length > 0) return false
    return Boolean(message.content.trim() || message.reasoning?.trim())
  }
  return false
}

/**
 * Dialogue-only page ending just before `before` (a message id), or at the end
 * of the session. Every execution run inside the returned slice is reported in
 * `processes` instead of being included, so the page stays small.
 */
export function dialoguePage(session: Session, before?: string, limit?: number): SessionPage {
  const safeLimit = pageLimit(limit)
  let end = session.messages.length
  if (before) {
    const index = session.messages.findIndex((message) => message.id === before)
    if (index >= 0) {
      end = index
      // The boundary must not fall inside a run: the steps before it would be
      // half-loaded and the same run would be summarized twice across pages.
      while (end > 0 && !isDialogueMessage(session.messages[end - 1]!)) end -= 1
    }
  }

  let index = end - 1
  let count = 0
  let start = end
  for (; index >= 0; index -= 1) {
    if (!isDialogueMessage(session.messages[index]!)) continue
    if (count >= safeLimit) break
    count += 1
    start = index
  }

  const slice = session.messages.slice(start, end)
  const processes = processesIn(session.messages, start, end)
  return {
    session: {
      ...session,
      messages: slice.filter(isDialogueMessage),
      messageCount: session.messages.length,
    },
    hasMore: session.messages.slice(0, start).some(isDialogueMessage),
    ...(processes.length > 0 ? { processes } : {}),
  }
}

/**
 * Execution runs inside `[start, end)`, each with `afterId` pointing at the
 * dialogue message it follows (absent when the run opens the slice).
 */
export function processesIn(
  messages: StoredMessage[],
  start: number,
  end: number,
): SessionProcessSummary[] {
  const out: SessionProcessSummary[] = []
  let current: SessionProcessSummary | null = null
  let afterId: string | undefined
  for (let index = start; index < end; index += 1) {
    const message = messages[index]!
    if (isDialogueMessage(message)) {
      afterId = message.id
      current = null
      continue
    }
    const runId = message.runId
    if (!runId) continue
    if (!current || current.runId !== runId) {
      current = {
        runId,
        stepCount: 0,
        toolCount: 0,
        failed: 0,
        ...(afterId ? { afterId } : {}),
      }
      out.push(current)
    }
    if (message.role === 'assistant') {
      const calls = message.toolCalls?.length ?? 0
      current.toolCount += calls
      current.stepCount +=
        calls + (message.reasoning?.trim() ? 1 : 0) + (message.content.trim() ? 1 : 0)
    } else if (message.role === 'tool') {
      // Tool calls are counted on the calling turn; a result only adds a step
      // and, when it failed, the failure marker the placeholder shows.
      current.stepCount += 1
      if (message.isError) current.failed += 1
    }
  }
  return out
}

/** Stored messages of one run, oldest first. Capped so one huge run stays bounded. */
export function runMessages(
  messages: StoredMessage[],
  runId: string,
  limit = 600,
): StoredMessage[] {
  const safeLimit = Math.max(1, Math.min(2_000, Math.round(limit) || 600))
  const found = messages.filter((message) => message.runId === runId)
  return found.length > safeLimit ? found.slice(-safeLimit) : found
}
