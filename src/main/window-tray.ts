// 窗口与托盘：主窗口创建、主题应用、显示置前与托盘菜单。
import { appState } from './app-state'
import type { RunEvent, ThemeMode, ContrastPreference, UpdateState } from '../shared/types'
import { appIconPath } from './app-icon'
import { localizeUpdateState } from './localize'
import { trayClickAction } from './window-action'
import { windowPalette } from './window-platform'
import {
  app,
  BrowserWindow,
  clipboard,
  Menu,
  nativeImage,
  Notification,
  session,
  shell,
  Tray,
} from 'electron'
import { join } from 'node:path'

function focusWindow(sessionId: string): void {
  if (!focusMainWindow()) return
  appState.mainWindow?.webContents.send('pilot:focus-session', sessionId)
}

/** Bring Pilot to the front without navigating anywhere. */
export function focusMainWindow(): boolean {
  if (!appState.mainWindow || appState.mainWindow.isDestroyed()) return false
  if (appState.mainWindow.isMinimized()) appState.mainWindow.restore()
  if (!appState.mainWindow.isVisible()) appState.mainWindow.show()
  appState.mainWindow.focus()
  return true
}

/**
 * Desktop notifications are opt-out, only fire while Pilot is not focused,
 * and never carry message contents — just the session title and event.
 */
export function notifyEvent(event: RunEvent): void {
  // 质量闸门只在需要人做决定时发系统通知（bell=true）；一次例行复测不弹窗。
  if (event.type === 'quality.changed') {
    if (!event.bell || !event.message) return
    if (!appState.store.settings().notifyDesktop) return
    if (!Notification.isSupported()) return
    if (BrowserWindow.getFocusedWindow()) return
    const notification = new Notification({
      title: appState.store.uiLocale() === 'en' ? 'Pilot · Better version found' : 'Pilot · 发现更优版本',
      body: event.message.slice(0, 240),
    })
    notification.on('click', () => {
      if (!focusMainWindow()) return
      appState.mainWindow?.webContents.send('pilot:focus-quality', event.workspacePath)
    })
    notification.show()
    return
  }
  if (
    event.type !== 'tool.approval_required' &&
    event.type !== 'run.failed' &&
    event.type !== 'run.completed'
  ) {
    return
  }
  if (!appState.store.settings().notifyDesktop) return
  if (!Notification.isSupported()) return
  if (BrowserWindow.getFocusedWindow()) return
  const english = appState.store.uiLocale() === 'en'
  const currentTask = english ? 'Current task' : '当前任务'
  let sessionId = ''
  let title = 'Pilot'
  let body = ''
  if (event.type === 'tool.approval_required') {
    sessionId = event.sessionId
    title = english ? 'Pilot · Approval needed' : 'Pilot · 需要确认'
    const session = appState.store.session(sessionId)
    body = english
      ? `${session?.title ?? currentTask}\nRequests to run ${event.call.name} and is waiting for your approval.`
      : `${session?.title ?? currentTask}\n请求执行 ${event.call.name}，等待你的批准。`
  } else if (event.type === 'run.failed') {
    sessionId = event.sessionId
    title = english ? 'Pilot · Run failed' : 'Pilot · 运行失败'
    const session = appState.store.session(sessionId)
    body = `${session?.title ?? currentTask}\n${event.message.slice(0, 160)}`
  } else if (event.type === 'run.completed' && event.status === 'completed') {
    sessionId = event.sessionId
    title = english ? 'Pilot · Task complete' : 'Pilot · 任务完成'
    const session = appState.store.session(sessionId)
    const seconds = Math.max(1, Math.round(event.durationMs / 1000))
    body = english
      ? `${session?.title ?? currentTask}\nFinished in ${seconds}s.`
      : `${session?.title ?? currentTask}\n已完成，用时 ${seconds} 秒。`
  } else {
    return
  }
  const notification = new Notification({ title, body })
  notification.on('click', () => focusWindow(sessionId))
  notification.show()
}

export function broadcastUpdate(state: UpdateState): void {
  const localized = localizeUpdateState(state, appState.store.uiLocale())
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('pilot:update-state', localized)
  }
  // Paired phones show the same progress; they may also have started it.
  appState.companion?.publish({ type: 'update.changed', state: localized })
}

export function applyTheme(theme: ThemeMode, contrast: ContrastPreference): void {
  if (!appState.mainWindow || appState.mainWindow.isDestroyed()) return
  const palette = windowPalette(theme, contrast)
  appState.mainWindow.setBackgroundColor(palette.color)
  if (process.platform === 'win32' || process.platform === 'linux') {
    try {
      appState.mainWindow.setTitleBarOverlay({ ...palette, height: 38 })
    } catch {
      // Older window managers may not support the overlay.
    }
  }
}

export function createWindow(): void {
  const theme = appState.store.settingsView().theme
  const palette = windowPalette(theme, appState.store.settingsView().contrast)

  const iconPath = appIconPath()
  appState.mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: palette.color,
    title: 'Pilot',
    // Windows takes the icon from the window (WM_GETICON); the installed
    // build also keeps a shortcut icon, but only one of the two is reliable
    // across themes, so both are set.
    ...(iconPath ? { icon: iconPath } : {}),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform !== 'darwin'
      ? { titleBarOverlay: { ...palette, height: 38 } }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: true,
    },
  })

  // ready-to-show 与 did-finish-load 都会调到这里，以 isVisible 为准做幂等和有限重试。
  let showAttempts = 0
  const showWindow = (): void => {
    if (!appState.mainWindow || appState.mainWindow.isDestroyed()) return
    if (appState.mainWindow.isVisible()) {
      refreshTrayMenu()
      return
    }
    appState.mainWindow.show()
    if (appState.mainWindow.isVisible()) {
      refreshTrayMenu()
      return
    }
    // Windows 上首帧之前调 show() 会被丢弃：窗口对象不报错、`show` 事件也发了，
    // 但 IsWindowVisible 仍是 false，结果进程在跑、窗口永远不出现。重试到真的可见为止。
    if (showAttempts >= 20) {
      console.error('[pilot] window never became visible')
      return
    }
    showAttempts += 1
    setTimeout(showWindow, 300)
  }
  appState.mainWindow.once('ready-to-show', () => {
    showWindow()
  })
  appState.mainWindow.on('hide', () => refreshTrayMenu())
  appState.mainWindow.on('show', () => refreshTrayMenu())
  // 加载完成后也试一次：极少数情况下首帧被推迟，ready-to-show 不来。
  appState.mainWindow.webContents.once('did-finish-load', () => setTimeout(showWindow, 200))

  // 关闭按钮收起窗口而不是退出：任务继续跑，托盘图标留着恢复。真退出走
  // 托盘菜单（或更新器的重启），它们会先置 `quitting`。托盘没建成时退回
  // 「关闭即退出」，否则窗口会藏起来而无处恢复。
  appState.mainWindow.on('close', (event) => {
    if (appState.quitting || !appState.tray) return
    event.preventDefault()
    appState.mainWindow?.hide()
    notifyTrayHint()
  })

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    // The renderer uses the Clipboard API for code blocks and fallbacks. A
    // blanket denial made every copy button fail; allow the write-only
    // permission and keep everything else denied.
    callback(permission === 'clipboard-sanitized-write')
  })
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    return permission === 'clipboard-sanitized-write'
  })

  appState.mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  appState.mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = appState.mainWindow?.webContents.getURL()
    if (current && url !== current) event.preventDefault()
  })
  appState.mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault())

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (rendererUrl) {
    void appState.mainWindow.loadURL(rendererUrl)
  } else {
    void appState.mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  appState.mainWindow.on('closed', () => {
    appState.mainWindow = null
    refreshTrayMenu()
  })
}

/** 首次收起窗口时告诉用户去哪儿找它，之后不再打扰。 */
function notifyTrayHint(): void {
  if (appState.trayHintShown || !appState.tray) return
  appState.trayHintShown = true
  const english = appState.store.uiLocale() === 'en'
  const title = english ? 'Pilot is still running' : 'Pilot 仍在后台运行'
  const body = english
    ? 'The window is hidden in the tray. Click the tray icon to reopen it, or quit from the tray menu.'
    : '窗口已隐藏到托盘。点击托盘图标重新打开，或从托盘菜单退出。'
  if (process.platform === 'win32') {
    try {
      appState.tray.displayBalloon({ title, content: body })
      return
    } catch {
      // 部分外壳不支持气泡通知，托盘菜单本身就是入口。
    }
  }
  if (!Notification.isSupported()) return
  const notification = new Notification({ title, body })
  notification.on('click', () => focusMainWindow())
  notification.show()
}

/**
 * 托盘图标的单击/双击：只负责把窗口叫回来，从不隐藏。
 *
 * 以前这里是 toggle —— 窗口可见时点击就 hide，Windows 随即移除任务栏按钮，
 * 下次点击又生成一个新的按钮，用户看到的就是「任务栏图标关掉又重启一个」。
 * 而且 Windows 的双击会先发 click 再发 double-click，原来的 click=hide、
 * double-click=focus 组合在双击时必然闪一下。隐藏改由托盘菜单项与窗口关闭
 * 按钮负责，那是用户明确要求的动作。
 */
export function revealMainWindow(): void {
  const action = trayClickAction({
    exists: Boolean(appState.mainWindow && !appState.mainWindow.isDestroyed()),
    visible: appState.mainWindow?.isVisible() ?? false,
    minimized: appState.mainWindow?.isMinimized() ?? false,
  })
  if (action === 'create') {
    createWindow()
    return
  }
  focusMainWindow()
}

function refreshTrayMenu(): void {
  if (!appState.tray) return
  const english = appState.store.uiLocale() === 'en'
  const open = Boolean(appState.mainWindow && !appState.mainWindow.isDestroyed() && appState.mainWindow.isVisible() && !appState.mainWindow.isMinimized())
  appState.tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: english
          ? open
            ? 'Hide Pilot'
            : 'Show Pilot'
          : open
            ? '隐藏 Pilot'
            : '显示 Pilot',
        click: () => {
          const current = appState.mainWindow
          if (open && current && !current.isDestroyed()) {
            current.hide()
            return
          }
          revealMainWindow()
        },
      },
      { type: 'separator' },
      {
        label: english ? 'Quit Pilot' : '退出 Pilot',
        click: () => {
          appState.quitting = true
          app.quit()
        },
      },
    ]),
  )
}

/**
 * 托盘常驻：关窗后仍有入口，所以这里必须真的建成，否则「关闭 = 隐藏」就会让
 * 应用失去唯一的恢复路径。图标缺失时宁可不建托盘并退回关窗即退出。
 */
export function createTray(): void {
  if (appState.tray) return
  const iconPath = appIconPath()
  if (!iconPath) return
  const image = nativeImage.createFromPath(iconPath)
  if (image.isEmpty()) return
  appState.tray = new Tray(process.platform === 'win32' ? image : image.resize({ width: 22, height: 22 }))
  appState.tray.setToolTip('Pilot')
  refreshTrayMenu()
  // Windows 上双击会连发一次 click，两个回调都收敛到同一条幂等的「显示并置前」，
  // 所以双击不会再先隐藏再显示。
  appState.tray.on('click', () => revealMainWindow())
  appState.tray.on('double-click', () => revealMainWindow())
}
