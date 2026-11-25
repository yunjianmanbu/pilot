// 超级 Pilot 的独立窗口。
//
// 它刻意和主窗口分开：主窗口的渲染进程要读会话列表、跑几十个订阅，一旦主引擎
// 卡住，那个窗口点不动；应急页面只做三件事（看状态、发指令、点抢救），所以即使
// 主窗口白屏，这个窗口还能打开。
//
// 与 `document-window.ts` 同一套安全口径：独立 BrowserWindow、同一份 preload、
// 拒绝一切导航与新窗口、禁止 webview。差别在通道白名单——文档窗口只能读一个文件，
// 这里只能碰超级 Pilot 自己的通道（见 `ipc-context.ts` 的 `SUPER_CHANNELS`）。
import { BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import type { ThemeMode } from '../shared/types'
import { windowIconOption } from './app-icon'

let superWindow: BrowserWindow | null = null

function alive(): BrowserWindow | null {
  return superWindow && !superWindow.isDestroyed() ? superWindow : null
}

/** 这条 IPC 是不是来自超级窗口；主进程据此决定是否放行 `pilot:super-*`。 */
export function isSuperWindowContents(contentsId: number): boolean {
  const window = alive()
  return Boolean(window && window.webContents.id === contentsId)
}

/**
 * 只发给超级窗口的一条推送。
 *
 * 不用 `sendToRenderers`：那会同时打到主窗口和网页服务，而超级 Pilot 的指令与
 * 事件属于「修自己」的场景，不该出现在别的界面上（手机端更没有这个入口）。
 */
export function sendToSuperWindow(channel: string, payload: unknown): void {
  alive()?.webContents.send(channel, payload)
}

export interface OpenSuperWindowOptions {
  theme: ThemeMode
}

/** 打开或聚焦应急窗口。重复调用只聚焦，不会堆出第二个。 */
export function openSuperWindow(options: OpenSuperWindowOptions): BrowserWindow {
  const existing = alive()
  if (existing) {
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    return existing
  }

  const created = new BrowserWindow({
    width: 940,
    height: 760,
    minWidth: 560,
    minHeight: 420,
    show: false,
    title: 'Pilot · 超级 Pilot',
    ...windowIconOption(),
    backgroundColor: options.theme === 'light' ? '#ffffff' : '#191a1c',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  })
  superWindow = created

  created.on('closed', () => {
    if (superWindow === created) superWindow = null
  })
  created.once('ready-to-show', () => created.show())
  created.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  created.webContents.on('will-navigate', (event, url) => {
    // 重载（同一 URL）要留着：应急页面出问题时用户会按 Ctrl+R。
    if (url !== created.webContents.getURL()) event.preventDefault()
  })
  created.webContents.on('will-attach-webview', (event) => event.preventDefault())

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void created.loadURL(`${devUrl.replace(/\/$/, '')}/super.html`)
  } else {
    void created.loadFile(join(__dirname, '../renderer/super.html'))
  }
  return created
}

/** 关掉窗口（清理用，界面不提供这个按钮）。 */
export function closeSuperWindow(): void {
  const window = alive()
  superWindow = null
  window?.destroy()
}
