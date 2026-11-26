import { createPortal } from 'react-dom'
import { XIcon } from '../icons'
import { t } from '../i18n'
import { summarizeTool, type ToolView } from '../ui'
import { Markdown } from './Markdown'
import { ProcessTime } from './ProcessTime'
import { partGlyph, toolGlyph, toolKind } from './process-icons'
import { ReasoningDialog, reasoningPeek } from './ReasoningBlock'
import { ToolDetail } from './ToolCard'
import { useEscapeClose } from './useEscapeClose'

/**
 * One step of the execution box that the reader opened.
 *
 * Every step opens in a dialog rather than growing in place. An inline body
 * changes the height of the box on every event (a thought streaming in, a tool
 * result arriving, the next step pushing the previous one out of the window),
 * which is what made the transcript jump while the model worked. A dialog is
 * outside that layout entirely, so nothing in the box moves.
 */
export type StepView =
  | { kind: 'reasoning'; key: string; text: string; at?: string; live: boolean }
  | { kind: 'note'; key: string; text: string; at?: string }
  | { kind: 'tool'; key: string; tool: ToolView }

/** 一段思考 → 它要开的弹框内容。 */
export function reasoningStep(
  part: { key: string; text: string; at?: string },
  live: boolean,
): StepView {
  return { kind: 'reasoning', key: part.key, text: part.text, live, ...(part.at ? { at: part.at } : {}) }
}

/** 一段说明文字 → 它要开的弹框内容。 */
export function noteStep(part: { key: string; text: string; at?: string }): StepView {
  return { kind: 'note', key: part.key, text: part.text, ...(part.at ? { at: part.at } : {}) }
}

/** 一个工具调用 → 它要开的弹框内容。 */
export function toolStep(tool: ToolView): StepView {
  return { kind: 'tool', key: tool.id, tool }
}

/**
 * A folded note step: one row, one line of text, the whole row is the target.
 *
 * It deliberately shares the `.reasoning-block` geometry with a folded thought,
 * so the box reads as one list of steps instead of two kinds of rows. Only the
 * glyph and the label differ, which is what tells the reader at a glance whether
 * the model was thinking or talking.
 */
export function ProcessNoteRow({
  text,
  onOpen,
}: {
  text: string
  /** Open the full note; without it the row is a plain, unclickable line. */
  onOpen?: (() => void) | undefined
}) {
  const peek = reasoningPeek(text)
  const body = (
    <>
      <span className="step-glyph glyph-note">{partGlyph('note')}</span>
      {/* 同上：说明行也用胶囊标签，和工具行的「只读 / 写入」对齐。 */}
      <span className="step-tag tag-note">{t("说明")}</span>
      {peek ? (
        <span className="reasoning-peek" title={peek}>
          {peek}
        </span>
      ) : null}
      {onOpen ? <span className="reasoning-fold-hint">{t("详情")}</span> : null}
    </>
  )
  if (!onOpen) {
    return <div className="reasoning-block process-note-row">{body}</div>
  }
  return (
    <button
      type="button"
      className="reasoning-block process-note-row"
      onClick={onOpen}
      title={t("展开查看完整说明")}
    >
      {body}
    </button>
  )
}

/** The dialog for whichever step the reader clicked. */
export function StepDialog({ step, onClose }: { step: StepView; onClose: () => void }) {
  // Thinking keeps its own dialog: it follows the newest line while the step is
  // still being written, and that logic already lives with the reasoning row.
  if (step.kind === 'reasoning') {
    return (
      <ReasoningDialog
        text={step.text}
        live={step.live}
        {...(step.at ? { at: step.at } : {})}
        onClose={onClose}
      />
    )
  }
  return <DetailDialog step={step} onClose={onClose} />
}

function DetailDialog({
  step,
  onClose,
}: {
  step: Exclude<StepView, { kind: 'reasoning' }>
  onClose: () => void
}) {
  useEscapeClose(onClose)
  const tool = step.kind === 'tool' ? step.tool : null
  const note = step.kind === 'note' ? step : null
  const title = tool ? tool.name : t("说明")
  return createPortal(
    <div className="modal-backdrop step-backdrop" onMouseDown={onClose}>
      <div
        className="modal step-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <h2>
              <span className={`step-modal-glyph glyph-${tool ? toolKind(tool.name) : 'note'}`}>
                {tool ? toolGlyph(tool.name) : partGlyph('note')}
              </span>
              {title}
            </h2>
            {tool ? <p>{summarizeTool(tool)}</p> : null}
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label={t("关闭")}>
            <XIcon width={14} height={14} />
          </button>
        </div>
        <div className="modal-body step-body">
          {tool ? <ToolDetail tool={tool} /> : null}
          {note ? (
            <>
              <ProcessTime at={note.at} />
              <Markdown content={note.text} />
            </>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  )
}
