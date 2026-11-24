/**
 * Pure helpers behind the「会话资源」panel.
 *
 * Kept outside the component so the URL breakdown and the one-line excerpts can
 * be unit tested: the panel itself never fetches anything, it only shows what
 * the session already recorded.
 */

/** The kinds of resource one session can expose. */
export type ResourceTab =
  | 'files'
  | 'links'
  | 'tools'
  | 'knowledge'
  | 'memory'
  | 'artifacts'

export const RESOURCE_TABS: ResourceTab[] = [
  'files',
  'links',
  'tools',
  'knowledge',
  'memory',
  'artifacts',
]

export interface LinkParts {
  scheme: string
  host: string
  path: string
  query: string
  hash: string
}

/**
 * Split a URL into the parts worth showing in a preview pane. A link the
 * transcript mangled still renders (everything lands in `path`) instead of
 * throwing: the panel is a viewer, not a validator.
 */
export function describeLink(url: string): LinkParts {
  try {
    const parsed = new URL(url)
    return {
      scheme: parsed.protocol.replace(/:$/, ''),
      host: parsed.host.replace(/^www\./, ''),
      path: parsed.pathname === '/' ? '' : parsed.pathname,
      query: parsed.search.replace(/^\?/, ''),
      hash: parsed.hash.replace(/^#/, ''),
    }
  } catch {
    return { scheme: '', host: '', path: url, query: '', hash: '' }
  }
}

/** Decoded `key=value` pairs; a bare `key` keeps an empty value. */
export function queryPairs(query: string): Array<{ key: string; value: string }> {
  const trimmed = query.replace(/^\?/, '')
  if (!trimmed) return []
  return trimmed.split('&').flatMap((part) => {
    if (!part) return []
    const at = part.indexOf('=')
    const rawKey = at < 0 ? part : part.slice(0, at)
    const rawValue = at < 0 ? '' : part.slice(at + 1)
    return [{ key: decodePart(rawKey), value: decodePart(rawValue) }]
  })
}

function decodePart(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '))
  } catch {
    return value
  }
}

/**
 * One readable line for a list row: newlines and repeated spaces collapse,
 * markdown noise stays because it usually carries the meaning.
 */
export function excerpt(text: string, limit = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= limit) return flat
  return `${flat.slice(0, limit)}…`
}

/** Where the drawer remembers「展开到整个界面」between openings. */
export const RESOURCES_EXPANDED_KEY = 'pilot.resources.expanded'

/** The little bit of `localStorage` this module needs; kept narrow so tests
 * can hand in a fake instead of a browser. */
export interface ResourcePrefsStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function defaultStorage(): ResourcePrefsStorage | null {
  try {
    return (globalThis as { localStorage?: ResourcePrefsStorage }).localStorage ?? null
  } catch {
    // 禁用了本地存储的沙箱会直接抛在属性访问上。
    return null
  }
}

/**
 * Was the drawer left expanded last time? A missing or unreadable store means
 *「没记住」, and the panel then falls back to its 920px default.
 */
export function readResourcesExpanded(
  store: ResourcePrefsStorage | null = defaultStorage(),
): boolean {
  try {
    return store?.getItem(RESOURCES_EXPANDED_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * Persist the width the user picked. A refused write (private mode, quota) only
 * loses the memory, never the toggle that just happened.
 */
export function writeResourcesExpanded(
  value: boolean,
  store: ResourcePrefsStorage | null = defaultStorage(),
): void {
  try {
    store?.setItem(RESOURCES_EXPANDED_KEY, value ? '1' : '0')
  } catch {
    /* 记不住就算了，面板本身已经切过去了 */
  }
}

/**
 * 「会话记忆」选条目的规则住在 shared/memory.ts：手机端的会话资源页要用
 * 同一套规则，而渲染进程的这份模块带着 UI 依赖，手机端拿不到。
 */
export { sessionMemories, type SessionMemoryRow } from '../../shared/memory'

