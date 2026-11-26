import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { t } from '../i18n'
import { XIcon } from '../icons'
import { partGlyph } from './process-icons'
import { ProcessTime } from './ProcessTime'
import { useEscapeClose } from './useEscapeClose'

/** Collapsed peek: the first line of the model's reasoning, cut short. */
const PEEK_CHARS = 80

/** While a dialog is live, stay glued to the newest line until the reader scrolls up. */
const STICK_THRESHOLD_PX = 24

/**
 * First non-empty line of a reasoning text, whitespace flattened, clipped.
 *
 * This is the only thing a folded step shows, and it is deliberately the *first*
 * line rather than the newest one: a title that tracked the tail re-flowed on
 * every token, and a block whose title keeps changing height makes the whole
 * transcript jump while the model thinks.
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
 * One folded step of thinking: a single row inside the execution box.
 *
 * The row never expands in place. Opening the full text into a dialog instead is
 * what keeps the transcript still: an inline body grows and shrinks as thinking
 * streams in and as the next step replaces it, which is exactly the jumping the
 * reader complained about. The row itself is a button so the whole line is the
 * target.
 */
export function ReasoningBlock({
  text,
  className,
  live = false,
  onOpen,
}: {
  text: string
  className?: string | undefined
  /** True while this step's thinking is still being written. */
  live?: boolean
  /** Open the full text; without it the row is a plain, unclickable line. */
  onOpen?: (() => void) | undefined
}) {
  const peek = reasoningPeek(text)
  const body = (
    <>
      <span className="step-glyph glyph-think">{partGlyph('reasoning')}</span>
      {/* 行内标签与工具行的「只读 / 写入」同一套胶囊：只有这里短到两个字，
          一眼就能分出这一行是模型在思考而不是在调工具；完整说法留在弹框标题里。 */}
      <span className="step-tag tag-think">{t("思考")}</span>
      {live ? <i className="live-dot reasoning-live" /> : null}
      {peek ? (
        <span className="reasoning-peek" title={peek}>
          {peek}
        </span>
      ) : null}
      {onOpen ? <span className="reasoning-fold-hint">{t("详情")}</span> : null}
    </>
  )
  if (!onOpen) {
    return <div className={`reasoning-block${className ? ` ${className}` : ''}`}>{body}</div>
  }
  return (
    <button
      type="button"
      className={`reasoning-block${className ? ` ${className}` : ''}`}
      onClick={onOpen}
      title={t("展开查看完整思考")}
    >
      {body}
    </button>
  )
}

/**
 * The full thinking of one step, in a dialog.
 *
 * The dialog belongs to whoever opened it, not to the step: it stays until the
 * reader closes it. That is the second half of the fix — the old inline body
 * vanished the moment the step settled into the transcript, so the text the
 * reader had just opened disappeared on its own.
 *
 * While the step is still being written the body follows the newest line; the
 * reader scrolling up stops the following, exactly like the transcript does.
 */
export function ReasoningDialog({
  text,
  at,
  live = false,
  onClose,
}: {
  text: string
  /** Wall-clock moment of the step, shown as the first line. */
  at?: string | undefined
  /** Still being written: keep following the newest line. */
  live?: boolean
  onClose: () => void
}) {
  useEscapeClose(onClose)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const stickRef = useRef(true)
  /** True while a pin-to-bottom scroll we issued is still being reported. */
  const pinningRef = useRef(false)

  const pin = useCallback(() => {
    const node = bodyRef.current
    if (!node || !stickRef.current) return
    const bottom = node.scrollHeight - node.clientHeight
    if (Math.abs(node.scrollTop - bottom) < 1) return
    pinningRef.current = true
    node.scrollTop = bottom
  }, [])

  // Same commit that appends the new text, before the browser reports the
  // scroll its own anchoring caused.
  useLayoutEffect(() => {
    pin()
  }, [text, pin])

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

  const dialog = (
    <div className="modal-backdrop reasoning-backdrop" onMouseDown={onClose}>
      <div
        className="modal reasoning-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("思考过程")}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <h2>
              <span className="step-modal-glyph glyph-think">
                {partGlyph('reasoning')}
              </span>
              {t("思考过程")}
              {live ? <i className="live-dot reasoning-live" /> : null}
            </h2>
            <p>{live ? t("正在思考，内容会继续追加。") : t("这段思考已经结束。")}</p>
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label={t("关闭")}>
            <XIcon width={14} height={14} />
          </button>
        </div>
        <div
          className="modal-body reasoning-content"
          ref={bodyRef}
          onScroll={handleScroll}
          onWheel={releasePin}
          onTouchMove={() => releasePin({})}
        >
          <ProcessTime at={at} />
          {text}
        </div>
      </div>
    </div>
  )
  return createPortal(dialog, document.body)
}

/**
 * A folded step plus the dialog it opens, for the places that own one thinking
 * block and nothing else (a stored answer that carries its own reasoning).
 *
 * The execution box does not use this: it holds several steps at once and has to
 * survive a step being folded away, so it keeps the open key itself.
 */
export function ReasoningSection({
  text,
  at,
  className,
  live = false,
  onEngage,
}: {
  text: string
  at?: string | undefined
  className?: string | undefined
  live?: boolean
  onEngage?: (() => void) | undefined
}) {
  const [open, setOpen] = useState(false)
  // A block that stops streaming keeps its dialog: only the reader closes it.
  const [frozen, setFrozen] = useState('')
  useEffect(() => {
    if (open) setFrozen(text)
  }, [open, text])
  return (
    <>
      <ReasoningBlock
        text={text}
        className={className}
        live={live}
        onOpen={() => {
          setOpen(true)
          onEngage?.()
        }}
      />
      {open ? (
        <ReasoningDialog text={frozen || text} at={at} live={live} onClose={() => setOpen(false)} />
      ) : null}
    </>
  )
}
