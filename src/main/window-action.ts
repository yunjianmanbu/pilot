/**
 * What a click on the tray icon does to the main window.
 *
 * Windows removes the taskbar button of a hidden window and creates a fresh one
 * when that window is shown again. A tray click that *hid* a visible window —
 * the previous `toggleMainWindow()` wiring, where `tray.on('click')` and
 * `tray.on('double-click')` both ran it — therefore looked like "the taskbar
 * icon closed and a new one started": the button disappeared on the first
 * click, and the next click brought back what Explorer treats as a new entry
 * (fresh animation, window flashing instead of opening).
 *
 * Clicking the tray is a request to *see* the app, so this only ever brings the
 * window up. Hiding stays on the tray menu item and on the window's close
 * button, where the user asked for it by name.
 */
export type TrayClickAction = 'create' | 'restore' | 'show' | 'focus'

/** The slice of the main window the decision needs. */
export interface MainWindowState {
  /** A window object exists and has not been destroyed. */
  exists: boolean
  visible: boolean
  minimized: boolean
}

/**
 * Pick the smallest action that makes the window visible and in front.
 *
 * `create` covers the case where the window was really closed (tray kept the
 * app alive); `restore` also un-minimises, because a minimised window is
 * "visible" to Electron but not to the user.
 */
export function trayClickAction(state: MainWindowState): TrayClickAction {
  if (!state.exists) return 'create'
  if (state.minimized) return 'restore'
  if (!state.visible) return 'show'
  return 'focus'
}