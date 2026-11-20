const MAX_RELAY_URL_LENGTH = 500
// `#k=id:secret`. The id lets one device be revoked without touching the rest;
// the secret is what the relay actually checks.
const ACCESS_CODE_RE = /^[A-Za-z0-9_-]{1,32}:[A-Za-z0-9_-]{16,128}$/

export interface RelayEndpoint {
  /** Canonical `ws(s)://host/path` without the admission fragment. */
  url: string
  /** Admission code from `#k=`, or `''` when the connector is open. */
  access: string
}

/**
 * Split a connection string into its endpoint and admission code.
 *
 * The whole thing is what the connector installer prints in one line:
 * `wss://relay.example.com/c/9f3a…#k=home:7d1c…`. The fragment carries the L1
 * admission code, so it is *not* dropped any more — but only the exact `k=`
 * form is accepted; any other fragment still means "not a relay address".
 *
 * Returns `{ url: '', access: '' }` for an empty value (LAN-only mode) and
 * `null` when the value is not a usable endpoint.
 */
export function parseRelayEndpoint(value: unknown): RelayEndpoint | null {
  if (value === null || value === undefined) return { url: '', access: '' }
  const text = String(value).trim()
  if (!text) return { url: '', access: '' }
  if (text.length > MAX_RELAY_URL_LENGTH) return null

  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  if (url.protocol !== 'wss:' && url.protocol !== 'ws:') return null
  if (!url.hostname) return null
  // Real credentials (userinfo) stay rejected: they would end up in logs and
  // error messages, and the relay has no use for them.
  if (url.username || url.password) return null

  const fragment = url.hash.replace(/^#/, '')
  let access = ''
  if (fragment) {
    if (!fragment.startsWith('k=')) return null
    access = fragment.slice(2)
    if (!ACCESS_CODE_RE.test(access)) return null
  }
  url.hash = ''
  return { url: url.toString(), access }
}

/**
 * Normalize a self-hosted Pilot Link relay address, keeping its admission code.
 *
 * Returns:
 *   - `''` for an empty value (LAN-only mode),
 *   - a canonical `ws://` / `wss://` URL, plus `#k=<code>` when one is present,
 *   - `null` when the value is not a usable relay endpoint.
 */
export function normalizeRelayUrl(value: unknown): string | null {
  const endpoint = parseRelayEndpoint(value)
  if (!endpoint) return null
  if (!endpoint.url) return ''
  return endpoint.access ? `${endpoint.url}#k=${endpoint.access}` : endpoint.url
}

/** Endpoint and code of a stored connection string. */
export function splitRelayUrl(value: unknown): RelayEndpoint {
  return parseRelayEndpoint(value) ?? { url: '', access: '' }
}

/**
 * What may be shown in the UI and copied into a screenshot: the endpoint only.
 * The admission code stays in settings.
 */
export function maskRelayUrl(value: unknown): string {
  return splitRelayUrl(value).url
}

/** Download locations for the self-hosted connector packages. */
export const RELAY_DOWNLOADS = {
  version: '0.2.3',
  linux: 'https://download.medpilot.cc/pilot/connector/pilot-connector-0.2.3-linux.tar.gz',
  windows: 'https://download.medpilot.cc/pilot/connector/pilot-connector-0.2.3-windows.zip',
  installScript: 'https://download.medpilot.cc/pilot/connector/install.sh',
} as const
