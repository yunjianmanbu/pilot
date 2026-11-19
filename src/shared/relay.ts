const MAX_RELAY_URL_LENGTH = 500

/**
 * Normalize a self-hosted Pilot Link relay address.
 *
 * Returns:
 *   - `''` for an empty value (LAN-only mode),
 *   - a canonical `ws://` / `wss://` URL,
 *   - `null` when the value is not a usable relay endpoint.
 *
 * The relay address is entered by the user after deploying the connector;
 * credentials in the URL are rejected so they never end up in settings files
 * or pairing QR codes.
 */
export function normalizeRelayUrl(value: unknown): string | null {
  if (value === null || value === undefined) return ''
  const text = String(value).trim()
  if (!text) return ''
  if (text.length > MAX_RELAY_URL_LENGTH) return null

  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  if (url.protocol !== 'wss:' && url.protocol !== 'ws:') return null
  if (!url.hostname) return null
  if (url.username || url.password) return null
  url.hash = ''
  return url.toString()
}

/** Download locations for the self-hosted connector packages. */
export const RELAY_DOWNLOADS = {
  version: '0.2.1',
  linux: 'https://download.medpilot.cc/pilot/connector/pilot-connector-0.2.1-linux.tar.gz',
  windows: 'https://download.medpilot.cc/pilot/connector/pilot-connector-0.2.1-windows.zip',
  installScript: 'https://download.medpilot.cc/pilot/connector/install.sh',
} as const
