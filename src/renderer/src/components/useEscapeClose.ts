import { useEffect, useRef } from 'react'

/**
 * Stack of dialogs that currently want the Escape key, bottom first.
 * Only the top entry reacts, so two open layers close one at a time instead of
 * both at once.
 */
const escapeStack: symbol[] = []

/**
 * Close a dialog with Escape, the same way clicking the backdrop does.
 *
 * Every dialog in this app installs its own `keydown` listener; without a stack
 * a nested one (the resources drawer with a confirm on top) would close both
 * layers with a single press. The listener also stops at the dialog that handled
 * it, so editors behind it never see the key.
 *
 * `onClose` is kept in a ref: dialogs pass inline arrows that change on every
 * render, and re-registering would move this dialog back to the top of the stack
 * on each keystroke.
 */
export function useEscapeClose(onClose: () => void, enabled = true): void {
  const handler = useRef(onClose)

  useEffect(() => {
    handler.current = onClose
  }, [onClose])

  useEffect(() => {
    if (!enabled) return
    const token = Symbol('dialog')
    escapeStack.push(token)
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (escapeStack[escapeStack.length - 1] !== token) return
      // A composition or a select still open in the dialog handles Escape first.
      if (event.defaultPrevented || event.isComposing) return
      handler.current()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      const index = escapeStack.indexOf(token)
      if (index >= 0) escapeStack.splice(index, 1)
    }
  }, [enabled])
}
