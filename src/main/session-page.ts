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

/**
 * How much of a run a tail page may swallow when its boundary would cut the
 * run in half. A run longer than this is left to the placeholder, so opening
 * one old conversation still cannot drag an unbounded transcript into the
 * window.
 */
const MAX_TAIL_RUN_EXPAND = 400

/** First index of the run `index` belongs to (itself when it opens the run). */
function runStartIndex(messages: StoredMessage[], index: number): number {
  const runId = messages[index]?.runId
  if (!runId) return index
  let start = index
  while (start > 0 && messages[start - 1]?.runId === runId) start -= 1
  return start
}

/** First index after the run `index` belongs to. */
function runEndIndex(messages: StoredMessage[], index: number): number {
  const runId = messages[index]?.runId
  if (!runId) return index + 1
  let end = index + 1
  while (end < messages.length && messages[end]?.runId === runId) end += 1
  return end
}

/**
 * Move a tail boundary so it never opens in the middle of a run. Half a run
 * renders as a truncated execution box whose earlier steps are unreachable,
 * and re-opening that conversation would show only the second half because
 * the page starts inside it. Prefer the run's first message; when that run is
 * too big to pull in, skip the whole run so it comes back as a placeholder.
 */
export function alignTailStart(
  messages: StoredMessage[],
  start: number,
  end: number,
): number {
  if (start <= 0 || start >= end) return Math.max(0, start)
  const runStart = runStartIndex(messages, start)
  if (runStart === start) return start
  return start - runStart <= MAX_TAIL_RUN_EXPAND
    ? withAnchor(messages, runStart)
    : withAnchor(messages, runEndIndex(messages, start))
}

/**
 * The dialogue message that introduced a run belongs to it: without it the
 * reader sees steps whose question scrolled out of the window, and the
 * placeholder has no anchor to sit after.
 */
function withAnchor(messages: StoredMessage[], index: number): number {
  return index > 0 && !messages[index - 1]?.runId ? index - 1 : index
}

/**
 * How many whole runs the newest page carries. A page bounded only by message
 * count puts a dozen collapsed execution boxes above the reader's own question
 * and makes a long conversation look like nothing but tool calls, so the tail
 * is cut on run boundaries too.
 */
export const TAIL_RUN_LIMIT = 6

/** Move the window start forward until it carries at most `TAIL_RUN_LIMIT` runs. */
function capTailRuns(messages: StoredMessage[], start: number, end: number): number {
  const starts: number[] = []
  const seen = new Set<string>()
  for (let index = start; index < end; index += 1) {
    const runId = messages[index]?.runId
    if (!runId || seen.has(runId)) continue
    seen.add(runId)
    starts.push(index)
  }
  if (starts.length <= TAIL_RUN_LIMIT) return start
  const cut = starts[starts.length - TAIL_RUN_LIMIT]!
  // Keep the question that introduced the oldest run in the window too.
  return withAnchor(messages, cut)
}

/**
 * The newest slice of a transcript, used as the first page when a session is
 * opened. The window holds whole runs only and stops after a few of them, so
 * opening a long conversation never lays out its entire tool history at once.
 * Older turns stay behind "load earlier" and come back in transcript order;
 * the runs a reader actually expanded are restored by the renderer, so no run
 * is reported as a placeholder stacked above the window.
 */
export function sessionPage(session: Session, before?: string, limit = 120): SessionPage {
  let end = session.messages.length
  if (before) {
    const index = session.messages.findIndex((message) => message.id === before)
    if (index >= 0) end = index
  }
  const safeLimit = pageLimit(limit)
  const start = capTailRuns(
    session.messages,
    alignTailStart(session.messages, Math.max(0, end - safeLimit), end),
    end,
  )
  return {
    session: {
      ...session,
      messages: session.messages.slice(start, end),
      messageCount: session.messages.length,
    },
    hasMore: start > 0,
  }
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
