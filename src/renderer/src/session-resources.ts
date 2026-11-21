/**
 * Pure helpers behind the「会话资源」panel.
 *
 * Kept outside the component so the URL breakdown and the one-line excerpts can
 * be unit tested: the panel itself never fetches anything, it only shows what
 * the session already recorded.
 */

/** The five kinds of resource one session can expose. */
export type ResourceTab = 'files' | 'links' | 'tools' | 'knowledge' | 'artifacts'

export const RESOURCE_TABS: ResourceTab[] = ['files', 'links', 'tools', 'knowledge', 'artifacts']

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

