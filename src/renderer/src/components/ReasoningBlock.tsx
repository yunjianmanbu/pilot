import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { t } from '../i18n'
import { ProcessTime } from './ProcessTime'

/** Collapsed peek: the first line of the model's reasoning, cut short. */
const PEEK_CHARS = 80

/** While a block is live, stay glued to the newest line until the reader scrolls up. */
const STICK_THRESHOLD_PX = 24

/**
 * First non-empty line of a reasoning text, whitespace flattened, clipped.
 * The summary line must stay one line, so the newline is dropped here instead
 * of relying on CSS (which cannot shorten an arbitrary long first line well).
 */
export function reasoningPeek(value: string, max = PEEK_CHARS): string {
  const first = value
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .find((line) => line.length > 0)
  if (!first) return ''
  return first.length <= max ? first : `${first.slice(0, max)}…`
}

/**
 * Last non-empty line, flattened and clipped. A block that is still streaming
 * shows its newest line instead of its first one, so the folded title keeps
 * changing while the model thinks — the same signal the phone client gives by
 * appending the thinking inline.
 */
export function reasoningTail(value: string, max = PEEK_CHARS): string {
  const lines = value
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0)
  const last = lines.at(-1) ?? ''
  if (!last) return ''
  return last.length <= max ? last : `${last.slice(0, max)}…`
}

/**
 * The one line that sits next to the title of a folded block.
 *
 * Folded, it carries a line of the thinking so the steps stay tellable apart
 * without opening every one of them. Expanded it returns nothing: the text is
 * right underneath, and repeating its first line in the title reads as clutter
 * (and is the first thing the eye lands on while scanning the real content).
 */
export function reasoningSummary(
  value: string,
  { live = false, open = false }: { live?: boolean; open?: boolean } = {},
  max = PEEK_CHARS,
): string {
  if (open) return ''
  return live ? reasoningTail(value, max) : reasoningPeek(value, max)
}

/**
 * A folded reasoning block.
 *
 * Folded is the default, streaming or not: the thinking is background, so it
 * never takes over the transcript by itself. `live` only changes what the one
 * folded line says — the newest line instead of the first one, so a long think
 * visibly moves forward — and adds a pulsing dot next to the title.
 *
 * Once opened, the block follows the newest text while `live`, so the reader
 * can watch the step write; a finished block opens at its top instead, which is
 * how it is read. Scrolling inside the block stops the following.
 */
export function ReasoningBlock({
  text,
  at,
  className,
  live = false,
  onEngage,
}: {
  text: string
  /** Wall-clock moment of the step, shown as the first line when expanded. */
  at?: string | undefined
  className?: string | undefined
  /** True while this step's thinking is still being written. */
  live?: boolean
  /** The reader touched this block: the transcript must stop auto-scrolling. */
  onEngage?: (() => void) | undefined
}) {
  /**
   * `null` means «the reader has not decided»: folded, like every block. A
   * click pins their own choice so the next token does not re-fold or re-open
   * what they are looking at.
   */
  const [manualOpen, setManualOpen] = useState<boolean | null>(null)
  const open = manualOpen === true
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const stickRef = useRef(true)
  /** True while a pin-to-bottom scroll we issued is still being reported. */
  const pinningRef = useRef(false)
  const peek = reasoningSummary(text, { live, open })

  const pin = useCallback(() => {
    const node = bodyRef.current
    if (!node || !stickRef.current) return
    const bottom = node.scrollHeight - node.clientHeight
    if (Math.abs(node.scrollTop - bottom) < 1) return
    pinningRef.current = true
    node.scrollTop = bottom
  }, [])

  // The moment the block opens: still being written → the newest line, so the
  // reader watches it arrive; already finished → the top, where reading starts.
  useLayoutEffect(() => {
    const node = bodyRef.current
    if (!open || !node) return
    if (stickRef.current) pin()
    else node.scrollTop = 0
  }, [open, pin])

  // Same commit that appends the new text, before the browser reports the
  // scroll its own anchoring caused.
  useLayoutEffect(() => {
    if (open) pin()
  }, [text, open, pin])

  const handleScroll = () => {
    const node = bodyRef.current
    if (!node) return
    // The scroll event our own pinning produced: keep following.
    if (pinningRef.current) {
      pinningRef.current = false
      return
    }
    stickRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < STICK_THRESHOLD_PX
  }

  // A gesture from the reader always wins over a pending pin.
  const releasePin = (event: { deltaY?: number }) => {
    pinningRef.current = false
    const node = bodyRef.current
    if (!node) return
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < STICK_THRESHOLD_PX
    if ((event.deltaY ?? 0) < 0 || !atBottom) stickRef.current = false
  }

  const toggle = (event: { preventDefault: () => void }) => {
    // The details element is controlled: without this the browser flips `open`
    // itself and React immediately writes the old value back.
    event.preventDefault()
    const next = !open
    setManualOpen(next)
    // Opening a live block keeps following the newest line; a finished block
    // starts from its first line instead of jumping to the end.
    if (next) stickRef.current = live
    onEngage?.()
  }

  return (
    <details className={`reasoning-block${className ? ` ${className}` : ''}`} open={open}>
      <summary onClick={toggle}>
        <span className="reasoning-label">{t("思考过程")}</span>
        {live ? <i className="live-dot reasoning-live" /> : null}
        {peek ? (
          <span className="reasoning-peek" title={peek}>
            {peek}
          </span>
        ) : null}
        {/* 展开后标题行只剩标题：正文就在下面，重复首行只是噪音。 */}
        {open ? <span className="reasoning-fold-hint">{t("收起")}</span> : null}
      </summary>
      <div
        className="reasoning-content"
        ref={bodyRef}
        onScroll={handleScroll}
        onWheel={releasePin}
        onTouchMove={() => releasePin({})}
      >
        <ProcessTime at={at} />
        {text}
      </div>
    </details>
  )
}
