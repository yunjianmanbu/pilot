import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyText } from '../src/renderer/src/clipboard'

function fakeDocument(execResult: boolean) {
  const area = {
    value: '',
    style: {} as Record<string, string>,
    parentNode: null as unknown,
    setAttribute: () => undefined,
    select: () => undefined,
    setSelectionRange: () => undefined,
  }
  const body = {
    appendChild(node: unknown) {
      ;(node as typeof area).parentNode = body
    },
    removeChild(node: unknown) {
      ;(node as typeof area).parentNode = null
    },
  }
  return {
    body,
    createElement: () => area,
    execCommand: (command: string) => {
      expect(command).toBe('copy')
      return execResult
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('renderer copyText', () => {
  it('prefers the main-process bridge', async () => {
    const writeClipboard = vi.fn(async () => true)
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('pilot', { writeClipboard })
    vi.stubGlobal('navigator', { clipboard: { writeText } })

    await expect(copyText('完整对话')).resolves.toBe(true)
    expect(writeClipboard).toHaveBeenCalledWith('完整对话')
    expect(writeText).not.toHaveBeenCalled()
  })

  it('falls back to the Clipboard API when the bridge declines', async () => {
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('pilot', { writeClipboard: async () => false })
    vi.stubGlobal('navigator', { clipboard: { writeText } })

    await expect(copyText('消息')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('消息')
  })

  it('falls back to execCommand when the Clipboard API rejects', async () => {
    vi.stubGlobal('pilot', {})
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: async () => {
          throw new Error('denied')
        },
      },
    })
    vi.stubGlobal('document', fakeDocument(true))

    await expect(copyText('代码')).resolves.toBe(true)
  })

  it('reports failure instead of pretending the copy worked', async () => {
    vi.stubGlobal('pilot', {})
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('document', fakeDocument(false))

    await expect(copyText('消息')).resolves.toBe(false)
  })

  it('does not touch the clipboard for empty text', async () => {
    const writeClipboard = vi.fn(async () => true)
    vi.stubGlobal('pilot', { writeClipboard })

    await expect(copyText('')).resolves.toBe(false)
    expect(writeClipboard).not.toHaveBeenCalled()
  })
})
