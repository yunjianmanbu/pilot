import { t } from '../../i18n'

const INPUT_HISTORY_KEY = 'pilot.input-history.v1'
const INPUT_HISTORY_LIMIT = 40

export function readInputHistory(): string[] {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(INPUT_HISTORY_KEY) ?? '[]')
    if (!Array.isArray(raw)) return []
    return raw
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .slice(0, INPUT_HISTORY_LIMIT)
  } catch {
    return []
  }
}

export function rememberInput(text: string): void {
  try {
    const previous = readInputHistory().filter((entry) => entry !== text)
    window.localStorage.setItem(
      INPUT_HISTORY_KEY,
      JSON.stringify([text, ...previous].slice(0, INPUT_HISTORY_LIMIT)),
    )
  } catch {
    // History is a convenience; sending must still work without storage.
  }
}

export interface ComposerDraftState {
  text: string
  images: string[]
  references: string[]
}

// Drafts live outside the component so switching to another view (which
// unmounts ChatView) or another session does not throw away what the user
// already typed; each session gets its own slot for the app's lifetime. The
// empty-state composer (no session yet) keeps its own slot as well.
const NO_SESSION_DRAFT_KEY = 'no-session'
const composerDrafts = new Map<string, ComposerDraftState>()

function draftKeyOf(sessionId: string | null | undefined): string {
  return sessionId ?? NO_SESSION_DRAFT_KEY
}

export function readComposerDraft(sessionId: string | null | undefined): ComposerDraftState {
  const saved = composerDrafts.get(draftKeyOf(sessionId))
  return saved
    ? { text: saved.text, images: [...saved.images], references: [...saved.references] }
    : { text: '', images: [], references: [] }
}

export function saveComposerDraft(sessionId: string | null, next: ComposerDraftState): void {
  const key = draftKeyOf(sessionId)
  if (!next.text && next.images.length === 0 && next.references.length === 0) {
    composerDrafts.delete(key)
    return
  }
  composerDrafts.set(key, {
    text: next.text,
    images: [...next.images],
    references: [...next.references],
  })
}

export const QUICK_PROMPTS = [
  t("先梳理一下这个项目的结构、技术栈和启动方式"),
  t("运行项目测试，定位并修复所有失败项"),
  t("阅读 README 和核心代码，指出三个最值得改进的地方"),
  t("为这个项目添加一个实用的新功能，先给出计划再实施"),
]

export const APPROVAL_LABELS: Record<string, string> = {
  auto: t("全部自动"),
  manual: t("只读自动"),
  ask: t("逐条审批"),
  acceptEdits: t("全部自动"),
  plan: t("只读自动"),
  dontAsk: t("只读自动"),
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
