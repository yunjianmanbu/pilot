/**
 * 浏览器里的 `window.pilot`。
 *
 * 桌面客户端由 preload 用 `ipcRenderer` 实现同一个 `PilotBridge`；这里把传输
 * 换成 `pilot serve` 的 `WS /bridge`，通道名、参数顺序、事件订阅全部来自
 * `src/shared/bridge.ts`。因此网页版和桌面客户端不是两套界面，而是同一份
 * renderer 代码换了一种传输入口。
 *
 * 这个模块在 `main.tsx` / `doc.tsx` 之前执行（由 `vite.web.config.mjs` 注入到
 * 每个页面的 head 最前面），所以 React 首帧调用 `window.pilot.bootstrap()` 时
 * 对象一定存在——即使 WebSocket 还没连上，请求也只是排队而不是丢失。
 */
import { createBridge, encodeBridgeArgs, BRIDGE_MAX_FRAME_BYTES, type BridgeRpc } from '../../shared/bridge'
import {
  decideTicketPoll,
  parseTicketDeadline,
  type TicketReply,
} from './bridge-ticket'
import { currentMediaOrigin, parseOpenLink, setMediaOrigin } from '../../shared/media'
import { MAX_IMAGE_DATA_URL_CHARS, MAX_UPLOAD_FILES, MAX_UPLOAD_IMAGES } from '../../shared/uploads'
import type { PilotBridge } from '../../shared/types'

/** 一条 RPC 等多久算超时。与桌面端的 IPC 一样，慢调用靠自己的进度事件报告。 */
const REQUEST_TIMEOUT_MS = 60_000
/** 断线后多久重连。回环连接几乎总是立刻可用，退避只为躲开重启窗口。 */
const RECONNECT_DELAY_MS = 800
/** 远端页面等审批时多久看一眼结果；批了就开始连，拒了就提示。 */
const TICKET_POLL_MS = 1_500
/** 凭据在标签页里只活这一次会话：刷新免再审，关掉标签页就失效。 */
const TOKEN_KEY = 'pilot-bridge-token'
/**
 * 凭据被拒后重新申请的次数与观察窗口。短时间反复失败（典型：浏览器打开的
 * 那份服务不是刚弹审批框的那一个）就不能再自动申请，否则用户会一直看到新的
 * 审批框，而每个都点得下去、都不管用。
 */
const CREDENTIAL_FAILURE_LIMIT = 2
const CREDENTIAL_FAILURE_WINDOW_MS = 60_000

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

type Listener = (payload: unknown) => void

/**
 * `WS /bridge` 上的请求/事件复用。
 *
 * 帧格式与 `src/main/companion/handlers/bridge.ts` 一一对应：
 * `{type:'ipc', id, channel, args}` → `{type:'ipc.result', id, ok, data|error}`，
 * 以及 `{type:'event', channel, payload}`。访问级别由服务端按来源地址与配对
 * 凭据判定，浏览器这边不需要自报身份。
 */
class BridgeSocket implements BridgeRpc {
  private socket: WebSocket | null = null
  private seq = 0
  private readonly pending = new Map<string, Pending>()
  private readonly listeners = new Map<string, Set<Listener>>()
  private readonly queued: Array<() => void> = []
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private ticketTimer: ReturnType<typeof setTimeout> | null = null
  private ticketId: string | null = null
  private overlay: HTMLElement | null = null
  private closed = false
  /** 凭据被拒后又重新申请的次数；超限就停下来问人。 */
  private credentialFailures = 0
  private credentialFailureAt = 0

  constructor(private readonly baseUrl: string) {
    this.open()
    window.addEventListener('online', () => this.open())
    // 页面卸载时明确关掉，服务端才能立刻释放这条连接（否则要等心跳超时）。
    window.addEventListener('pagehide', () => this.dispose())
  }

  invoke(channel: string, ...args: unknown[]): Promise<any> {
    const run = (): Promise<unknown> => this.send(channel, args)
    if (this.socket?.readyState === WebSocket.OPEN) return run()
    // 还没连上（页面刚打开、或刚断线重连）：排队等 open，调用方不必感知。
    return new Promise<unknown>((resolve, reject) => {
      this.queued.push(() => {
        run().then(resolve, reject)
      })
    })
  }

  on(channel: string, listener: Listener): () => void {
    let bucket = this.listeners.get(channel)
    if (!bucket) {
      bucket = new Set()
      this.listeners.set(channel, bucket)
    }
    bucket.add(listener)
    return () => {
      bucket.delete(listener)
      if (bucket.size === 0) this.listeners.delete(channel)
    }
  }

  private send(channel: string, args: unknown[]): Promise<unknown> {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('与这台电脑的连接已断开，请刷新页面'))
    }
    const id = `r${++this.seq}`
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`请求超时：${channel}`))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      try {
        socket.send(JSON.stringify({ type: 'ipc', id, channel, args: encodeBridgeArgs(args) }))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private open(): void {
    if (this.closed) return
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return
    const url = this.currentUrl()
    if (url) {
      this.connect(url)
      return
    }
    // 远端浏览器：`/bridge` 背后是整份主进程 IPC 表，必须先让这台电脑确认
    // 是谁在访问。这一步与手机配对用同一条审批回路，只是凭据换成一条 token。
    void this.ensureTicket()
  }

  /**
   * 这一条连接该连哪里。
   *
   * 回环地址（以及页面 URL 上带了 `token`）不需要申请；其余情况必须先用
   * `POST /bridge/ticket` 拿到本机批准的凭据，否则服务端会直接断开。
   */
  private currentUrl(): string | null {
    if (this.baseUrl.includes('token=')) return this.baseUrl
    if (isLoopbackPage()) return this.baseUrl
    const stored = new URLSearchParams(location.search).get('token') || readStoredToken()
    return stored ? withToken(this.baseUrl, stored) : null
  }

  private async ensureTicket(): Promise<void> {
    if (this.closed || this.ticketTimer || this.ticketId) return
    this.showOverlay('正在请这台电脑确认浏览器访问…', null)
    let payload: TicketReply
    try {
      const response = await fetch('/bridge/ticket', {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
      })
      payload = (await response.json()) as TicketReply
      if (!response.ok || !payload.ok) {
        throw new Error(String(payload.error || `HTTP ${response.status}`))
      }
    } catch (error) {
      this.showOverlay(
        `无法申请访问凭据：${error instanceof Error ? error.message : String(error)}`,
        () => this.retry(),
      )
      return
    }
    if (payload.local) {
      // 服务端按回环地址放行，拿到结果直接连。
      storeToken('')
      this.connect(this.baseUrl)
      return
    }
    if (!payload.id) {
      this.showOverlay('这台电脑没有返回申请编号，请刷新页面重试', () => this.retry())
      return
    }
    // 同一个浏览器地址已经批过：服务端直接把那条 token 再给一次，不再弹审批。
    if (payload.state === 'approved' && payload.token) {
      this.ticketId = null
      storeToken(payload.token)
      this.hideOverlay()
      this.connect(withToken(this.baseUrl, payload.token))
      return
    }
    this.ticketId = payload.id
    this.pollTicket(payload.id, parseTicketDeadline(payload.expiresAt))
  }

  private pollTicket(id: string, deadline: number): void {
    if (this.closed) return
    this.ticketTimer = setTimeout(() => {
      this.ticketTimer = null
      void (async () => {
        if (Date.now() >= deadline) {
          this.ticketId = null
          this.showOverlay('这次申请已经过期，请重新申请。', () => this.retry())
          return
        }
        let reply: TicketReply = {}
        let status = 0
        try {
          const response = await fetch(`/bridge/ticket?id=${encodeURIComponent(id)}`, {
            cache: 'no-store',
            credentials: 'same-origin',
          })
          status = response.status
          reply = (await response.json()) as TicketReply
        } catch {
          // 单次轮询失败（例如进程重启）不该让页面卡死：继续问，直到过期。
          this.pollTicket(id, deadline)
          return
        }
        const decision = decideTicketPoll({ status, reply, now: Date.now(), deadline })
        if (decision.kind === 'stop') {
          // 不会再有结果了（申请不在这台电脑上、服务关了、被拒或过期）：停下来
          // 说清楚原因，而不是让用户对着一个转不停的等待页反复点「允许」。
          this.ticketId = null
          this.showOverlay(decision.message, () => this.retry())
          return
        }
        if (decision.kind === 'connect') {
          this.ticketId = null
          storeToken(decision.token)
          this.hideOverlay()
          this.connect(withToken(this.baseUrl, decision.token))
          return
        }
        this.pollTicket(id, deadline)
      })()
    }, TICKET_POLL_MS)
  }

  private retry(): void {
    this.hideOverlay()
    this.ticketId = null
    this.credentialFailures = 0
    this.credentialFailureAt = 0
    if (this.ticketTimer) {
      clearTimeout(this.ticketTimer)
      this.ticketTimer = null
    }
    void this.ensureTicket()
  }

  private connect(url: string): void {
    if (this.closed) return
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return
    let socket: WebSocket
    try {
      socket = new WebSocket(url)
    } catch {
      this.scheduleReconnect()
      return
    }
    this.socket = socket
    let opened = false
    socket.addEventListener('open', () => {
      opened = true
      this.hideOverlay()
      for (const task of this.queued.splice(0)) task()
    })
    socket.addEventListener('message', (event) => this.receive(event.data))
    socket.addEventListener('close', () => {
      if (this.socket === socket) this.socket = null
      // 在飞的请求不可能再有回包，早点让界面报错而不是等 60 秒超时。
      for (const [id, entry] of this.pending) {
        clearTimeout(entry.timer)
        entry.reject(new Error('与这台电脑的连接已断开，请刷新页面'))
        this.pending.delete(id)
      }
      // 从没连上过：多半是凭据已经失效（这台电脑换了人授权或重启），
      // 丢掉旧 token 重新申请，而不是拿着坏凭据无限重试。但同一条凭据在短时间
      // 内反复被拒（例如浏览器打开的是另一份正在运行的服务）时不能再申请：
      // 那只会让用户看到一个接一个的审批框，每个都点得下去、都不管用。
      if (!opened) {
        const hadToken = readStoredToken() !== ''
        storeToken('')
        if (hadToken && this.noteCredentialFailure()) {
          this.ticketId = null
          this.showOverlay(
            '这台电脑反复拒绝了浏览器的访问凭据：多半是浏览器打开的那份服务不是刚才弹审批框的那一个。请确认电脑上只有一个网页服务在跑，然后刷新页面重新申请。',
            () => this.retry(),
          )
          return
        }
      }
      this.scheduleReconnect()
    })
    socket.addEventListener('error', () => {
      // close 紧随其后，重连在那里安排。
    })
  }

  private showOverlay(message: string, retry: (() => void) | null): void {
    if (typeof document === 'undefined') return
    if (!this.overlay) {
      const box = document.createElement('div')
      box.id = 'pilot-bridge-notice'
      box.setAttribute('role', 'alertdialog')
      box.style.cssText = [
        'position:fixed',
        'inset:0',
        'z-index:2147483000',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'background:color-mix(in srgb, var(--bg, #111) 88%, transparent)',
        'color:var(--fg, #eee)',
        'font:14px/1.7 system-ui, -apple-system, "Segoe UI", sans-serif',
        'padding:24px',
      ].join(';')
      const panel = document.createElement('div')
      panel.style.cssText = [
        'max-width:460px',
        'text-align:center',
        'display:flex',
        'flex-direction:column',
        'gap:14px',
        'align-items:center',
      ].join(';')
      panel.dataset['role'] = 'panel'
      box.appendChild(panel)
      document.body.appendChild(box)
      this.overlay = box
    }
    const panel = this.overlay.firstElementChild as HTMLElement
    panel.textContent = ''
    const text = document.createElement('p')
    text.textContent = message
    text.style.margin = '0'
    panel.appendChild(text)
    if (retry) {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = '重新申请'
      button.style.cssText = [
        'padding:6px 16px',
        'border-radius:6px',
        'border:1px solid currentColor',
        'background:transparent',
        'color:inherit',
        'cursor:pointer',
        'font:inherit',
      ].join(';')
      button.addEventListener('click', retry)
      panel.appendChild(button)
    }
  }

  private hideOverlay(): void {
    this.overlay?.remove()
    this.overlay = null
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.open()
    }, RECONNECT_DELAY_MS)
  }

  /** 记一次「拿着凭据却连不上」；达到上限返回 true，表示该停下来问人了。 */
  private noteCredentialFailure(): boolean {
    const now = Date.now()
    if (now - this.credentialFailureAt > CREDENTIAL_FAILURE_WINDOW_MS) this.credentialFailures = 0
    this.credentialFailureAt = now
    this.credentialFailures += 1
    return this.credentialFailures >= CREDENTIAL_FAILURE_LIMIT
  }

  private receive(raw: unknown): void {
    if (typeof raw !== 'string') return
    let frame: Record<string, unknown>
    try {
      const parsed = JSON.parse(raw) as unknown
      if (!parsed || typeof parsed !== 'object') return
      frame = parsed as Record<string, unknown>
    } catch {
      return
    }
    const type = frame['type']
    if (type === 'ipc.result') {
      const id = typeof frame['id'] === 'string' ? frame['id'] : null
      const entry = id ? this.pending.get(id) : undefined
      if (!id || !entry) return
      this.pending.delete(id)
      clearTimeout(entry.timer)
      if (frame['ok'] === true) entry.resolve(frame['data'])
      else entry.reject(new Error(String(frame['error'] ?? '调用失败')))
      return
    }
    if (type === 'event') {
      const channel = typeof frame['channel'] === 'string' ? frame['channel'] : ''
      const bucket = channel ? this.listeners.get(channel) : undefined
      if (!bucket) return
      for (const listener of bucket) {
        try {
          listener(frame['payload'])
        } catch {
          // 一个监听器抛错不该影响其他订阅者。
        }
      }
    }
  }

  private dispose(): void {
    this.closed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ticketTimer) {
      clearTimeout(this.ticketTimer)
      this.ticketTimer = null
    }
    this.hideOverlay()
    try {
      this.socket?.close()
    } catch {
      // ignore
    }
  }
}

/** 本机浏览器直连就够了，不需要走审批（服务端也按回环地址放行）。 */
function isLoopbackPage(): boolean {
  const host = location.hostname.replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '::1' || host.startsWith('127.')
}

function readStoredToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? ''
  } catch {
    return ''
  }
}

function storeToken(token: string): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token)
    else sessionStorage.removeItem(TOKEN_KEY)
  } catch {
    // 隐私模式下 sessionStorage 可能被禁；凭据只差一次重新审批，功能不降级。
  }
}

/** 把凭据拼到 `/bridge` 上；已有 `token=` 时替换掉旧值。 */
function withToken(base: string, token: string): string {
  const url = new URL(base)
  url.searchParams.set('token', token)
  return url.toString()
}

/** `/bridge` 的地址：同源 WebSocket，远端访问时把配对凭据带在查询串上。 */
function bridgeUrl(): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  // 配对照录会跳到 `#p=...`；token 若出现在查询串上，连接时继续带上。
  const token = new URLSearchParams(location.search).get('token') ?? ''
  const query = token ? `?token=${encodeURIComponent(token)}` : ''
  return `${scheme}://${location.host}/bridge${query}`
}

/**
 * 浏览器上传要挤进一条 WS 帧：base64 使体积涨到 4/3，剩下 8 KB 留给通道名、
 * 文件名和 JSON 外壳。桌面客户端走 IPC，没有这个限制。
 */
const UPLOAD_BUDGET_BYTES = Math.floor((BRIDGE_MAX_FRAME_BYTES - 8 * 1024) * 0.75)

/** 焦点兜底拿到空结果后，再等多久给迟到的 `change` 一次机会。 */
const FILE_PICK_GRACE_MS = 1200

/**
 * 浏览器里没有原生文件框：用一个隐藏 input，选中后把字节交给同一条上传通道。
 *
 * 三种收尾方式各覆一种情况：`change` 是选中文件，`cancel` 是用户点了取消，
 * 而旧浏览器两者都不发，只能用「页面重新获得焦点」兜底。焦点兜底不能一拿到
 * 空值就收尾：那时 `change` 可能还在路上（实测在 CDP 驱动下必然如此），会让
 * 用户选了文件却拿到空数组。所以空结果先等一拍再判。
 */
function chooseFiles(options: { accept?: string; multiple?: boolean }): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    if (options.accept) input.accept = options.accept
    input.multiple = options.multiple === true
    input.style.position = 'fixed'
    input.style.left = '-10000px'
    const read = (): File[] => Array.from(input.files ?? [])
    let done = false
    let grace: ReturnType<typeof setTimeout> | null = null
    const finish = (files: File[]): void => {
      if (done) return
      done = true
      if (grace !== null) clearTimeout(grace)
      input.remove()
      resolve(files)
    }
    const settle = (): void => {
      const files = read()
      if (files.length > 0) {
        finish(files)
        return
      }
      if (grace !== null) return
      grace = setTimeout(() => finish(read()), FILE_PICK_GRACE_MS)
    }
    input.addEventListener('change', () => finish(read()))
    input.addEventListener('cancel', () => finish([]))
    window.addEventListener('focus', () => setTimeout(settle, 400), { once: true })
    document.body.appendChild(input)
    input.click()
  })
}

/** 把选中的图片压成 jpeg data URL；尺寸与质量阶梯和主进程 `encodeMessageImage` 一致。 */
function renderJpeg(bitmap: ImageBitmap, edge: number, quality: number): string {
  const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height, 1))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('这个浏览器无法压缩图片')
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', quality / 100)
}

async function encodePickedImage(source: Blob): Promise<string> {
  const bitmap = await createImageBitmap(source).catch(() => null)
  if (!bitmap) throw new Error('无法识别这张图片')
  try {
    let edge = Math.min(1600, Math.max(320, Math.max(bitmap.width, bitmap.height)))
    while (edge >= 320) {
      for (const quality of [82, 72, 62, 52]) {
        const dataUrl = renderJpeg(bitmap, edge, quality)
        if (dataUrl.length <= MAX_IMAGE_DATA_URL_CHARS) return dataUrl
      }
      edge = Math.round(edge * 0.75)
    }
    throw new Error('图片太大，请压缩后再添加')
  } finally {
    bitmap.close()
  }
}

/**
 * 桌面端由主进程做的事，在浏览器里得自己找替身：文件框换成隐藏 input，
 * 文档预览换成新标签页，`shell.openExternal` 换成 `window.open`。
 *
 * 这些只有宿主能力差异，界面代码一行不用改；其它通道照旧走 `/bridge`。
 */
function adaptToBrowser(bridge: PilotBridge, invoke: BridgeRpc['invoke']): void {
  bridge.pickFolder = async (title?: string) => {
    const typed = window.prompt(
      title || '输入这台电脑上的工作区绝对路径',
      '',
    )
    const path = typed?.trim() ?? ''
    return path || null
  }

  bridge.pickFiles = async (workspacePath: string) => {
    const files = (await chooseFiles({ multiple: true })).slice(0, MAX_UPLOAD_FILES)
    const blobs: Array<{ name: string; data: ArrayBuffer }> = []
    let total = 0
    for (const file of files) {
      if (!file.size) continue
      total += file.size
      if (total > UPLOAD_BUDGET_BYTES) {
        const mb = (UPLOAD_BUDGET_BYTES / (1024 * 1024)).toFixed(1)
        throw new Error(
          `浏览器里一次上传的附件合计不能超过 ${mb} MB（网页版走单条 WebSocket 帧），请分批添加或用桌面客户端`,
        )
      }
      blobs.push({
        name: file.name || `upload-${blobs.length + 1}`,
        data: await file.arrayBuffer(),
      })
    }
    if (blobs.length === 0) return []
    return invoke('pilot:upload-files', workspacePath, { paths: [], blobs })
  }

  bridge.pickImages = async () => {
    const files = (await chooseFiles({
      accept: 'image/png,image/jpeg,image/webp,image/gif,image/bmp',
      multiple: true,
    })).slice(0, MAX_UPLOAD_IMAGES)
    const images: string[] = []
    for (const file of files) {
      if (!file.size) continue
      images.push(await encodePickedImage(file))
    }
    return images
  }

  // 服务器模式的 `nativeImage` 是空的（`server/electron-shim.ts` 直接拒绝），
  // 所以剪贴板/上传的图片字节在浏览器里自己用 canvas 压缩，目标上限与桌面端一致。
  bridge.pasteImage = async (input) => {
    const data = input?.data
    if (!data || data.byteLength === 0) throw new Error('剪贴板里没有可用的图片')
    return encodePickedImage(new Blob([data]))
  }

  bridge.openDocument = async (workspace: string, file: string) => {
    const url = new URL('/doc.html', location.origin)
    url.searchParams.set('workspace', workspace)
    url.searchParams.set('path', file)
    const opened = window.open(url.toString(), '_blank')
    if (!opened) throw new Error('浏览器拦截了新标签页，请允许弹窗后重试')
  }

  bridge.openLink = async (url: string) => {
    const target = parseOpenLink(url)
    if (!target) throw new Error('只能打开网页链接、邮件链接与工作区文件')
    const origin = currentMediaOrigin()
    const href =
      target.kind === 'media' && origin
        ? target.url.replace(/^pilot-media:\/\/local\//, `${origin}/`)
        : target.url
    const opened = window.open(href, '_blank', 'noopener,noreferrer')
    if (!opened) throw new Error('浏览器拦截了新标签页，请允许弹窗后重试')
  }
}

/**
 * 安装浏览器版桥。桌面端 preload 已经放了 `window.pilot` 时直接返回，
 * 这样同一份 renderer 代码在两种宿主里都能跑。
 */
export function installBrowserBridge(): PilotBridge | null {
  if (window.pilot) return window.pilot
  // 浏览器标签页注册不了 `pilot-media:`，图片/预览改走 HTTP 路由。
  setMediaOrigin(`${location.origin}/media`)
  const rpc = new BridgeSocket(bridgeUrl())
  const bridge = createBridge(rpc)
  adaptToBrowser(bridge, rpc.invoke.bind(rpc))
  window.pilot = bridge
  return bridge
}

installBrowserBridge()
