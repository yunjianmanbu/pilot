import { t } from '../i18n'
import { ProcessTime } from './ProcessTime'

/** Collapsed peek: the first line of the model's reasoning, cut short. */
const PEEK_CHARS = 80

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
 * A folded reasoning block: the summary carries the first line of the thinking
 * so a reader can tell the steps apart without opening every one of them.
 */
export function ReasoningBlock({
  text,
  at,
  className,
}: {
  text: string
  /** Wall-clock moment of the step, shown as the first line when expanded. */
  at?: string | undefined
  className?: string | undefined
}) {
  const peek = reasoningPeek(text)
  return (
    <details className={`reasoning-block${className ? ` ${className}` : ''}`}>
      <summary>
        <span className="reasoning-label">{t("思考过程")}</span>
        {peek ? (
          <span className="reasoning-peek" title={peek}>
            {peek}
          </span>
        ) : null}
      </summary>
      <div className="reasoning-content">
        <ProcessTime at={at} />
        {text}
      </div>
    </details>
  )
}
