import { describe, expect, it } from 'vitest'
import { trayClickAction, type MainWindowState } from '../src/main/window-action'

const state = (patch: Partial<MainWindowState> = {}): MainWindowState => ({
  exists: true,
  visible: true,
  minimized: false,
  ...patch,
})

describe('trayClickAction', () => {
  it('creates the window when the tray outlived it', () => {
    expect(trayClickAction(state({ exists: false, visible: false }))).toBe('create')
  })

  it('restores a minimised window', () => {
    // Minimised windows still report isVisible() === true, so this branch has to
    // come before the visibility check or the window stays in the taskbar.
    expect(trayClickAction(state({ minimized: true }))).toBe('restore')
  })

  it('shows a window hidden to the tray', () => {
    expect(trayClickAction(state({ visible: false }))).toBe('show')
  })

  it('only focuses a window that is already in front', () => {
    expect(trayClickAction(state())).toBe('focus')
  })

  it('never hides a visible window', () => {
    // Regression guard: the tray click used to toggle, so clicking it while the
    // window was open called hide(). Windows then dropped the taskbar button and
    // recreated it on the next click — "the taskbar icon closed and started a new
    // one". No state may map to a hiding action.
    const actions = new Set(
      [
        state(),
        state({ exists: false }),
        state({ visible: false }),
        state({ minimized: true }),
        state({ visible: false, minimized: true }),
      ].map((s) => trayClickAction(s)),
    )
    expect([...actions].sort()).toEqual(['create', 'focus', 'restore', 'show'])
    expect([...actions]).not.toContain('hide')
  })
})