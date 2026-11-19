interface CopyTextarea {
  value: string
  style: Record<string, string>
  parentNode: unknown
  setAttribute(name: string, value: string): void
  select(): void
  setSelectionRange(start: number, end: number): void
}

interface CopyDocument {
  body: {
    appendChild(node: unknown): void
    removeChild(node: unknown): void
  }
  createElement(tag: string): CopyTextarea
  execCommand(command: string): boolean
}

interface CopyBridge {
  writeClipboard?: (text: string) => Promise<boolean>
}

interface ClipboardApi {
  clipboard?: { writeText?(text: string): Promise<void> }
}

function globals(): {
  pilot?: CopyBridge
  navigator?: ClipboardApi
  document?: CopyDocument
} {
  return globalThis as unknown as {
    pilot?: CopyBridge
    navigator?: ClipboardApi
    document?: CopyDocument
  }
}

/**
 * Copy text to the clipboard and report whether it actually worked.
 *
 * The desktop renderer writes through the main process. The Clipboard API
 * needs a permission that used to be denied for every request, and it can
 * silently fail outside a user gesture; the main-process path has neither
 * problem. Browser fallbacks keep this helper usable in previews and tests.
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false
  const env = globals()

  try {
    const bridge = env.pilot
    if (bridge && typeof bridge.writeClipboard === 'function') {
      if (await bridge.writeClipboard(text)) return true
    }
  } catch {
    // Fall through to the browser implementations.
  }

  try {
    if (env.navigator?.clipboard?.writeText) {
      await env.navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Fall through to execCommand.
  }

  const doc = env.document
  if (!doc) return false
  try {
    const area = doc.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style['position'] = 'fixed'
    area.style['top'] = '0'
    area.style['left'] = '-9999px'
    area.style['opacity'] = '0'
    doc.body.appendChild(area)
    area.select()
    area.setSelectionRange(0, area.value.length)
    const ok = doc.execCommand('copy')
    doc.body.removeChild(area)
    return ok
  } catch {
    return false
  }
}
