/**
 * Minimal Electron stand-in used only by the headless server bundle.
 *
 * `vite.server.config.mjs` aliases the `electron` specifier to this module, so
 * the desktop main-process code (store, runner, companion server) can run in
 * plain Node. The three APIs that matter are real:
 *
 * - `app.getPath('userData')` resolves `PILOT_USER_DATA_DIR` (set by the CLI);
 * - `app.getLocale()` reads the POSIX locale;
 * - `safeStorage` seals secrets with an AES-256-GCM key file in the data
 *   directory, because a server has no OS keychain.
 *
 * Everything tied to a desktop session (screen capture, updater networking)
 * throws a readable error instead of crashing on a missing module.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SEAL_MAGIC = 'pilot-ns1:'
const KEY_FILE = 'secure-storage.key'

function unavailable(feature: string): never {
  throw new Error(`${feature}在服务器模式（无界面）下不可用，请在桌面端使用。`)
}

function dataDir(): string {
  const dir = (process.env['PILOT_USER_DATA_DIR'] ?? '').trim()
  if (dir) return dir
  // The CLI always sets this; the fallback keeps a stray import from writing
  // into the repository root.
  return join(process.cwd(), '.pilot-data')
}

function hostLocale(): string {
  const raw = (process.env['LC_ALL'] ?? process.env['LC_MESSAGES'] ?? process.env['LANG'] ?? '').trim()
  const base = raw.split('.')[0] ?? ''
  // POSIX locales are `ll_CC`; resolveLocale expects BCP-47 (`ll-CC`).
  if (base) return base.replace('_', '-')
  // Windows defines no POSIX locale variables, so a console started by
  // double-clicking has none of them: falling straight back to English made
  // `pilot serve` report "系统语言：en-US" on a Chinese Windows and render the
  // browser console in English even with the language set to follow the system.
  // Node ships full ICU on Windows, so its resolved locale is the OS region.
  try {
    const icu = new Intl.DateTimeFormat().resolvedOptions().locale.trim()
    if (icu) return icu
  } catch {
    // A runtime built without full ICU has nothing better to offer.
  }
  return 'en-US'
}

export const app = {
  /**
   * `pilot serve` 没有窗口。面板要用浏览器原生的能力（全屏、无窗口按钮的
   * 顶栏留白）之前得先知道这一点 —— 两个宿主报的 `process.platform` 一样，
   * 只看平台名分不出来。桌面端的 `electron` 上没有这个字段。
   */
  pilotHost: 'server' as const,
  getPath(name: string): string {
    if (name === 'userData') return dataDir()
    if (name === 'logs') return join(dataDir(), 'logs')
    return dataDir()
  },
  getLocale(): string {
    return hostLocale()
  },
  getVersion(): string {
    return String(process.env['PILOT_VERSION'] ?? '0.0.0')
  },
  getAppPath(): string {
    return String(process.env['PILOT_PACKAGE_ROOT'] ?? process.cwd())
  },
  isPackaged: false,
  on(): void {},
  once(): void {},
  whenReady(): Promise<void> {
    return Promise.resolve()
  },
  quit(): void {
    process.exit(0)
  },
}

// Electron 给主进程注入 `process.resourcesPath`；纯 Node 下它是 `undefined`，
// 而主进程代码（个人分支、自身源码比对、安装包图标）会无条件把它拼进路径，
// `join(undefined, 'source')` 直接抛 TypeError —— 进化页于是整体打不开。
// 指向包根目录：那里没有 `source/`，于是自然落到「开发态」分支。
if (!process.resourcesPath) {
  ;(process as unknown as { resourcesPath: string }).resourcesPath =
    String(process.env['PILOT_PACKAGE_ROOT'] ?? process.cwd())
}

let cachedKey: Buffer | null = null
let keyFailed = false

function loadKey(): Buffer | null {
  if (cachedKey) return cachedKey
  if (keyFailed) return null
  try {
    const dir = dataDir()
    mkdirSync(dir, { recursive: true })
    const file = join(dir, KEY_FILE)
    if (existsSync(file)) {
      const parsed = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64')
      if (parsed.length === 32) {
        cachedKey = parsed
        return cachedKey
      }
    }
    const created = randomBytes(32)
    writeFileSync(file, created.toString('base64'), { encoding: 'utf8', mode: 0o600 })
    try {
      chmodSync(file, 0o600)
    } catch {
      // Windows ignores POSIX modes; the file still sits in the data directory.
    }
    cachedKey = created
    return cachedKey
  } catch {
    keyFailed = true
    return null
  }
}

export const safeStorage = {
  isEncryptionAvailable(): boolean {
    return loadKey() !== null
  },
  encryptString(value: string): Buffer {
    const key = loadKey()
    if (!key) throw new Error('服务器模式的本机密钥不可用')
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const sealed = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return Buffer.concat([Buffer.from(SEAL_MAGIC, 'utf8'), iv, cipher.getAuthTag(), sealed])
  },
  decryptString(value: Buffer): string {
    const magic = Buffer.from(SEAL_MAGIC, 'utf8')
    if (!value.subarray(0, magic.length).equals(magic)) {
      // Ciphertext from the desktop build is sealed by the OS keychain and
      // cannot be opened here; the store treats this as "no key".
      throw new Error('该密钥由桌面端系统钥匙串加密，服务器模式无法解密，请重新填写 API Key。')
    }
    const key = loadKey()
    if (!key) throw new Error('服务器模式的本机密钥不可用')
    const body = value.subarray(magic.length)
    const decipher = createDecipheriv('aes-256-gcm', key, body.subarray(0, 12))
    decipher.setAuthTag(body.subarray(12, 28))
    return Buffer.concat([decipher.update(body.subarray(28)), decipher.final()]).toString('utf8')
  },
}

export const nativeImage = {
  createFromBuffer(): never {
    return unavailable('屏幕截图')
  },
  createFromPath(): never {
    return unavailable('屏幕截图')
  },
  createEmpty(): { isEmpty: () => boolean } {
    return { isEmpty: () => true }
  },
}

export const desktopCapturer = {
  async getSources(): Promise<never> {
    return unavailable('屏幕捕获')
  },
}

export const net = {
  request(): never {
    return unavailable('应用内更新检查')
  },
}

export const shell = {
  openExternal(): never {
    return unavailable('打开外部程序')
  },
  async openPath(): Promise<string> {
    return '服务器模式没有图形界面，无法打开文件夹'
  },
  showItemInFolder(): never {
    return unavailable('定位到文件夹')
  },
}

export const dialog = {
  showOpenDialog(): never {
    return unavailable('系统文件选择框')
  },
  async showOpenDialogOrFiles(): Promise<never> {
    return unavailable('系统文件选择框')
  },
  async showSaveDialog(): Promise<never> {
    return unavailable('系统保存对话框')
  },
  async showMessageBox(): Promise<never> {
    return unavailable('系统提示框')
  },
}

/**
 * Recorded IPC handlers.
 *
 * The desktop `src/main/ipc/*` modules call `ipcMain.handle` when they are
 * registered; the server keeps those handlers in a table instead of talking to
 * a renderer process, so the browser console can drive exactly the same code
 * over `WS /bridge` (see `console.ts`). Nothing here can be reached from the
 * machine's own renderer, because a server build has no renderer.
 */
type IpcHandler = (event: unknown, ...args: unknown[]) => unknown

const ipcHandlers = new Map<string, IpcHandler>()

export const ipcMain = {
  handle(channel: string, handler: IpcHandler): void {
    ipcHandlers.set(channel, handler)
  },
  removeHandler(channel: string): void {
    ipcHandlers.delete(channel)
  },
  on(): void {},
}

/** Channels registered by the main-process modules, in registration order. */
export function ipcChannels(): string[] {
  return [...ipcHandlers.keys()]
}

/** Run one recorded handler. Throws a readable error for an unknown channel. */
export async function invokeIpc(
  channel: string,
  event: unknown,
  args: unknown[],
): Promise<unknown> {
  const handler = ipcHandlers.get(channel)
  if (!handler) throw new Error(`服务器模式没有实现这个功能：${channel}`)
  return await handler(event, ...args)
}

/**
 * Event sink for main-process pushes.
 *
 * Desktop code calls `BrowserWindow.getAllWindows()[i].webContents.send(...)`
 * and `appState.mainWindow.webContents.send(...)`. With a sink installed the
 * console window below is the only window, so every push lands in one place
 * and the bridge forwards it to the browser tabs.
 */
type EventSink = (channel: string, payload: unknown) => void

let eventSink: EventSink | null = null

export function setWebContentsSink(sink: EventSink | null): void {
  eventSink = sink
}

/** Stands in for `webContents` of the fake console window. */
export const consoleSender = {
  id: 0,
  isDestroyed(): boolean {
    return false
  },
  send(channel: string, ...payload: unknown[]): void {
    eventSink?.(channel, payload[0])
  },
  executeJavaScript(): Promise<unknown> {
    return Promise.resolve(undefined)
  },
}

class ConsoleWindow {
  readonly webContents = consoleSender
  readonly id = 0
  isDestroyed(): boolean {
    return false
  }
  isMinimized(): boolean {
    return false
  }
  close(): void {}
  focus(): void {}
  show(): void {}
  restore(): void {}
}

/** The single window a headless server pretends to have. */
export const consoleWindow = new ConsoleWindow()

export const BrowserWindow = {
  getAllWindows: (): ConsoleWindow[] => (eventSink ? [consoleWindow] : []),
  getFocusedWindow: (): ConsoleWindow | null => null,
  fromWebContents: (): ConsoleWindow | null => null,
  fromId: (): ConsoleWindow | null => null,
}

export const Menu = {
  buildFromTemplate: (): Record<string, never> => ({}),
  setApplicationMenu(): void {},
  getApplicationMenu: (): null => null,
}

class NoopTray {
  setToolTip(): void {}
  setContextMenu(): void {}
  on(): void {}
  destroy(): void {}
  popUpContextMenu(): void {}
}

export const Tray = NoopTray

export const Notification = {
  isSupported(): boolean {
    return false
  },
}

export const protocol = {
  registerSchemesAsPrivileged(): void {},
  handle(): void {},
  isProtocolHandled(): boolean {
    return false
  },
}

/** Server side clipboard: the browser tab owns the real clipboard. */
export const clipboard = {
  writeText(): void {},
  readText(): string {
    return ''
  },
  writeImage(): void {},
}

const noopWebRequest = {
  on(): void {},
  onBeforeSendHeaders(): void {},
}

const noopSession = {
  webRequest: noopWebRequest,
  clearCache(): Promise<void> {
    return Promise.resolve()
  },
  setPermissionRequestHandler(): void {},
}

export const session = {
  defaultSession: noopSession,
  fromPartition: (): typeof noopSession => noopSession,
  fromPath: (): typeof noopSession => noopSession,
}

export const webUtils = {
  getPathForFile(): string {
    return ''
  },
}

export const screen = {
  getPrimaryDisplay: () => ({ workAreaSize: { width: 1280, height: 800 }, scaleFactor: 1 }),
  getAllDisplays: () => [],
}
