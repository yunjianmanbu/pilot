/**
 * Coalesces a token-by-token stream into periodic bursts.
 *
 * Models stream one or a few characters per SSE event. Each event used to
 * become a separate IPC message to the renderer, a React state update and a
 * WebSocket frame per companion device, so a single answer cost thousands of
 * round trips for no visible benefit. Text is accumulated here and released
 * every `intervalMs`; `flush()` releases immediately and is what callers use
 * before anything that is not raw text, so ordering stays exact.
 */
export interface DeltaCoalescer {
  /** Append text for `kind`; schedules a flush if none is pending. */
  push: (kind: 'message' | 'reasoning', text: string) => void
  /** Emit everything buffered right now. */
  flush: () => void
  /** Emit everything buffered, cancel the timer and clear the buffer. */
  dispose: () => void
  /** Exact text still waiting to be emitted; used by tests and shutdown. */
  pending: () => { message: string; reasoning: string }
}

export interface DeltaCoalescerOptions {
  intervalMs: number
  emit: (kind: 'message' | 'reasoning', text: string) => void
  /** Injectable for tests; defaults to setTimeout/clearTimeout. */
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export function createDeltaCoalescer(options: DeltaCoalescerOptions): DeltaCoalescer {
  const setTimer =
    options.setTimer ??
    ((run: () => void, ms: number): unknown => {
      const handle = setTimeout(run, ms)
      handle.unref?.()
      return handle
    })
  const clearTimer = options.clearTimer ?? ((handle: unknown): void => clearTimeout(handle as never))
  let message = ''
  let reasoning = ''
  let timer: unknown = null

  const emitBuffered = (): void => {
    if (message) {
      const text = message
      message = ''
      options.emit('message', text)
    }
    if (reasoning) {
      const text = reasoning
      reasoning = ''
      options.emit('reasoning', text)
    }
  }

  const cancel = (): void => {
    if (timer === null) return
    clearTimer(timer)
    timer = null
  }

  const flush = (): void => {
    cancel()
    emitBuffered()
  }

  return {
    push: (kind, text) => {
      if (!text) return
      if (kind === 'message') message += text
      else reasoning += text
      if (timer !== null) return
      timer = setTimer(() => {
        timer = null
        emitBuffered()
      }, options.intervalMs)
    },
    flush,
    dispose: () => {
      flush()
    },
    pending: () => ({ message, reasoning }),
  }
}
