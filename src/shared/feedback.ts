/**
 * Feedback composition shared by the renderer, the preload bridge and the main
 * process.
 *
 * A report is always one of three kinds — a problem, a request or a suggestion —
 * plus a short title and a body. Normalization lives here so the dialog, the IPC
 * boundary and the record on disk agree on trimming and on the length limits.
 */

export const FEEDBACK_KINDS = ['bug', 'feature', 'suggestion'] as const

export type FeedbackKind = (typeof FEEDBACK_KINDS)[number]

export const FEEDBACK_TITLE_MAX = 80
export const FEEDBACK_BODY_MAX = 4_000
export const FEEDBACK_CONTACT_MAX = 120

/**
 * Optional environment lines a report can carry.
 *
 * Every field describes how Pilot runs, not who runs it: no host name, user
 * name, MAC address, IP or serial number is ever collected.
 */
export const FEEDBACK_ENV_FIELDS = ['os', 'cpu', 'memory', 'disk', 'runtime', 'sandbox'] as const

export type FeedbackEnvField = (typeof FEEDBACK_ENV_FIELDS)[number]

/** One collected line: a stable key plus text already rendered for the reader. */
export interface FeedbackEnvLine {
  key: FeedbackEnvField
  label: string
  value: string
}

export function isFeedbackEnvField(value: unknown): value is FeedbackEnvField {
  return typeof value === 'string' && (FEEDBACK_ENV_FIELDS as readonly string[]).includes(value)
}

/** Keep only known keys, no duplicates, in the canonical order. */
export function normalizeEnvFields(value: unknown): FeedbackEnvField[] {
  const picked = Array.isArray(value) ? value.filter(isFeedbackEnvField) : []
  return FEEDBACK_ENV_FIELDS.filter((field) => picked.includes(field))
}

export interface FeedbackDraft {
  kind: FeedbackKind
  title: string
  body: string
  /** Optional way to reach the reporter; empty when not given. */
  contact: string
  /** Environment lines the reporter left checked; empty when none. */
  environment?: FeedbackEnvField[]
}

/** Environment captured in the main process, never trusted from the renderer. */
export interface FeedbackContext {
  version: string
  platform: string
  locale: string
  /** Rendered lines for the fields the reporter opted into, in canonical order. */
  environment?: FeedbackEnvLine[]
}

export interface FeedbackRecord extends FeedbackDraft {
  id: string
  createdAt: string
  context: FeedbackContext
}

export function isFeedbackKind(value: unknown): value is FeedbackKind {
  return typeof value === 'string' && (FEEDBACK_KINDS as readonly string[]).includes(value)
}

function readText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readEnvironment(input: unknown): unknown {
  return typeof input === 'object' && input !== null
    ? (input as { environment?: unknown }).environment
    : undefined
}

/** Which input check failed, so the UI can localize the message itself. */
export type FeedbackProblem =
  | 'kind'
  | 'title'
  | 'titleTooLong'
  | 'body'
  | 'bodyTooLong'
  | 'contactTooLong'

export class FeedbackInputError extends Error {
  constructor(
    readonly problem: FeedbackProblem,
    message: string,
  ) {
    super(message)
    this.name = 'FeedbackInputError'
  }
}

/**
 * Validate and trim one draft. Throws a FeedbackInputError carrying both a
 * Chinese fallback message (what the main process would report) and the
 * machine-readable problem the dialog uses to pick translated copy.
 */
export function normalizeFeedback(input: unknown): FeedbackDraft {
  const raw: Record<string, unknown> = input && typeof input === 'object' ? { ...input } : {}
  const kind = raw.kind
  if (!isFeedbackKind(kind)) throw new FeedbackInputError('kind', '请选择反馈类型')
  const title = readText(raw.title)
  const body = readText(raw.body)
  const contact = readText(raw.contact)
  if (!title) throw new FeedbackInputError('title', '请填写一句话概括')
  if (title.length > FEEDBACK_TITLE_MAX) {
    throw new FeedbackInputError(
      'titleTooLong',
      `概括请控制在 ${FEEDBACK_TITLE_MAX} 个字符以内`,
    )
  }
  if (!body) throw new FeedbackInputError('body', '请填写具体内容')
  if (body.length > FEEDBACK_BODY_MAX) {
    throw new FeedbackInputError('bodyTooLong', `内容请控制在 ${FEEDBACK_BODY_MAX} 个字符以内`)
  }
  if (contact.length > FEEDBACK_CONTACT_MAX) {
    throw new FeedbackInputError(
      'contactTooLong',
      `联系方式请控制在 ${FEEDBACK_CONTACT_MAX} 个字符以内`,
    )
  }
  const env = normalizeEnvFields(readEnvironment(raw))
  return {
    kind,
    title,
    body,
    contact,
    // Omitted when empty so a report without environment lines stores exactly
    // the same shape it did before this field existed.
    ...(env.length ? { environment: env } : {}),
  }
}

const KIND_LABELS: Record<FeedbackKind, string> = {
  bug: '反馈问题',
  feature: '提需求',
  suggestion: '提建议',
}

export function feedbackKindLabel(kind: FeedbackKind): string {
  return KIND_LABELS[kind]
}

/** Local `YYYY-MM-DD HH:mm`, matching what the phone app shows. */
export function formatLocalTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}

/** One plain-text report, used for the clipboard and for the stored record. */
export function formatFeedback(record: FeedbackRecord): string {
  const lines = [
    `【${feedbackKindLabel(record.kind)}】${record.title}`,
    '',
    record.body,
  ]
  if (record.contact) lines.push('', `联系方式：${record.contact}`)
  lines.push(
    '',
    '—',
    `版本：Pilot ${record.context.version || '未知'} · ${record.context.platform} · ${record.context.locale}`,
  )
  for (const line of record.context.environment ?? []) {
    lines.push(`${line.label}：${line.value}`)
  }
  lines.push(`时间：${formatLocalTime(record.createdAt)}`, `编号：${record.id}`)
  return lines.join('\n')
}
