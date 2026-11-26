// 最小 LSP 客户端：newline-free 的 Content-Length 分帧、request/notify、超时、清理。
//
// 为什么自己写而不是装 `vscode-jsonrpc`：Pilot 的依赖面刻意保持很小（安装包体积 +
// 供应链），而 LSP 的 stdio 传输只需要「Content-Length 头 + JSON 体」这一件事，约 200 行
// 且可以被 tests/lsp-client.test.ts 里一个假 server 完整覆盖。
//
// 边界：本文件只管协议传输，不做任何语言判断，也不碰文件系统。
import { spawn, type ChildProcess } from 'node:child_process'
import type { Writable } from 'node:stream'

export interface LspLaunch {
  file: string
  args: string[]
  /**
   * 已拼好的命令行，不要再让 Node 按 MSVCRT 规则转义一遍。
   * `cmd.exe /c "\"C:\x.cmd\" \"--stdio\""` 只有在 verbatim 下才成立，否则引号会被
   * 再转义一次，cmd 把整串当作程序名并报「不是内部或外部命令」。
   */
  verbatim?: boolean
}

export interface LspClientOptions {
  /** Server working directory: the workspace root. */
  cwd: string
  /** initialize 的超时。冷启动的 JDT LS 可能要几十秒。 */
  initTimeoutMs?: number
  /** 单次查询超时。 */
  requestTimeoutMs?: number
  /** 额外环境变量（jdtls 需要 JAVA_HOME 之类时由调用方给）。 */
  env?: NodeJS.ProcessEnv
}

export interface LspPosition {
  /** Zero-based. */
  line: number
  /** Zero-based, UTF-16 code units (same as JS string indices). */
  character: number
}

export interface LspRange {
  start: LspPosition
  end: LspPosition
}

export interface LspLocation {
  uri: string
  range: LspRange
}

export interface LspDiagnostic {
  range: LspRange
  severity?: number
  code?: number | string
  source?: string
  message: string
}

export interface LspSymbol {
  name: string
  kind: number
  location?: LspLocation
  range?: LspRange
  containerName?: string
  children?: LspSymbol[]
}

/** JSON-RPC / LSP error object. */
export class LspError extends Error {
  readonly code: number

  constructor(code: number, message: string) {
    super(message)
    this.name = 'LspError'
    this.code = code
  }
}

/** The server answered MethodNotFound: the capability is not implemented. */
export function isMethodNotFound(error: unknown): boolean {
  return error instanceof LspError && error.code === -32601
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface NotificationHandler {
  method: string
  handler: (params: unknown) => void
}

export class LspClient {
  private readonly child: ChildProcess
  private readonly options: Required<Pick<LspClientOptions, 'initTimeoutMs' | 'requestTimeoutMs'>>
  private buffer: Buffer = Buffer.alloc(0)
  private readonly pending = new Map<number, Pending>()
  private readonly notificationHandlers: NotificationHandler[] = []
  private nextId = 1
  private disposed = false
  private exited = false
  private exitInfo = ''
  private stderrTail = ''

  constructor(launch: LspLaunch, options: LspClientOptions) {
    this.options = {
      initTimeoutMs: options.initTimeoutMs ?? 30_000,
      requestTimeoutMs: options.requestTimeoutMs ?? 15_000,
    }
    this.child = spawn(launch.file, launch.args, {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      ...(launch.verbatim ? { windowsVerbatimArguments: true } : {}),
      ...(options.env ? { env: options.env } : {}),
    })

    this.child.stdout?.on('data', (chunk: Buffer) => this.onData(chunk))
    this.child.stderr?.on('data', (chunk: Buffer) => {
      // 保留尾部即可：server 崩了要给用户一句人话，不是整个日志。
      this.stderrTail = `${this.stderrTail}${chunk.toString('utf8')}`.slice(-2_000)
    })
    // 子进程退出后再写 stdin 会异步 emit EPIPE；不接住就是一个 unhandled 'error'
    // 把整个 Electron 主进程带下去。
    this.child.stdin?.on('error', () => undefined)
    this.child.stdout?.on('error', () => undefined)
    this.child.stderr?.on('error', () => undefined)
    this.child.on('error', (error) => {
      this.exited = true
      this.exitInfo = error.message
      this.failAll(new Error(`language server failed to start: ${error.message}`))
    })
    this.child.on('exit', (code, signal) => {
      this.exited = true
      this.exitInfo = this.exitInfo || `exited (code ${code ?? 'null'}${signal ? `, ${signal}` : ''})${this.stderrTail ? `: ${this.stderrTail.trim().split('\n').slice(-3).join(' | ')}` : ''}`
      this.failAll(new Error(`language server ${this.exitInfo}`))
    })
  }

  get stdin(): Writable | null {
    return this.child.stdin
  }

  get alive(): boolean {
    return !this.exited && !this.disposed
  }

  /** Why the process is gone, for user-facing messages. */
  get exitReason(): string {
    return this.exitInfo
  }

  private failAll(error: Error): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
      this.pending.delete(id)
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      const header = this.buffer.subarray(0, headerEnd).toString('ascii')
      const match = /Content-Length:\s*(\d+)/i.exec(header)
      const start = headerEnd + 4
      if (!match) {
        // 无法识别的头：丢掉这一段，避免死循环。
        this.buffer = this.buffer.subarray(start)
        continue
      }
      const length = Number(match[1])
      if (!Number.isFinite(length) || length < 0) {
        this.buffer = this.buffer.subarray(start)
        continue
      }
      if (this.buffer.length < start + length) return
      const body = this.buffer.subarray(start, start + length).toString('utf8')
      this.buffer = this.buffer.subarray(start + length)
      let message: unknown
      try {
        message = JSON.parse(body)
      } catch {
        continue
      }
      this.dispatch(message as Record<string, unknown>)
    }
  }

  private dispatch(message: Record<string, unknown>): void {
    const id = message['id']
    if (typeof id === 'number' && ('result' in message || 'error' in message)) {
      const entry = this.pending.get(id)
      if (!entry) return
      clearTimeout(entry.timer)
      this.pending.delete(id)
      if ('error' in message && message['error']) {
        const error = message['error'] as { code?: number; message?: string }
        entry.reject(new LspError(error.code ?? -32603, error.message ?? 'language server error'))
      } else {
        entry.resolve(message['result'])
      }
      return
    }
    if (typeof id === 'number' && 'method' in message) {
      // server → client 的请求（client/registerCapability 等）。一律回空结果，
      // 否则 server 会一直等。
      this.write({ jsonrpc: '2.0', id, result: null })
      return
    }
    const method = typeof message['method'] === 'string' ? message['method'] : ''
    if (!method) return
    for (const entry of this.notificationHandlers) {
      if (entry.method === method) entry.handler(message['params'])
    }
  }

  onNotification(method: string, handler: (params: unknown) => void): void {
    this.notificationHandlers.push({ method, handler })
  }

  private write(message: Record<string, unknown>): void {
    const payload = JSON.stringify(message)
    const body = Buffer.from(payload, 'utf8')
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii')
    try {
      this.child.stdin?.write(Buffer.concat([header, body]))
    } catch (error) {
      this.failAll(error instanceof Error ? error : new Error(String(error)))
    }
  }

  notify(method: string, params: unknown): void {
    if (this.disposed) return
    this.write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })
  }

  request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('language server client is disposed'))
    if (this.exited) {
      return Promise.reject(new Error(`language server ${this.exitInfo || 'is not running'}`))
    }
    const id = this.nextId++
    const limit = timeoutMs ?? this.options.requestTimeoutMs
    return new Promise<T>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rejectPromise(new Error(`language server did not answer ${method} within ${limit}ms`))
      }, limit)
      this.pending.set(id, {
        resolve: (value) => resolvePromise(value as T),
        reject: rejectPromise,
        timer,
      })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  /**
   * LSP 握手。
   *
   * capabilities 只声明本客户端真正实现的：定义、引用、文档符号、工作区符号，
   * 以及 3.17 的 pull diagnostics（server 不支持时由调用方退回 push 模式）。
   */
  async initialize(rootUri: string, rootName: string): Promise<void> {
    await this.request(
      'initialize',
      {
        processId: process.pid,
        clientInfo: { name: 'Pilot', version: '1' },
        rootUri,
        rootPath: rootUri,
        workspaceFolders: [{ uri: rootUri, name: rootName }],
        capabilities: {
          workspace: {
            symbol: { dynamicRegistration: false },
            workspaceFolders: true,
            configuration: true,
          },
          textDocument: {
            synchronization: { dynamicRegistration: false, didSave: false },
            definition: { linkSupport: true },
            references: { dynamicRegistration: false },
            documentSymbol: {
              dynamicRegistration: false,
              hierarchicalDocumentSymbolSupport: true,
              symbolKind: { valueSet: Array.from({ length: 26 }, (_, i) => i + 1) },
            },
            publishDiagnostics: { relatedInformation: true, versionSupport: false },
            diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
          },
          window: { workDoneProgress: false },
        },
        initializationOptions: {},
      },
      this.options.initTimeoutMs,
    )
    this.notify('initialized', {})
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    // shutdown 必须在置位之前发出去：request() 见到 disposed 就直接拒绝，
    // 那样 server 会挂在一个永远不来的 shutdown 上，只能等 SIGKILL。
    if (!this.exited) {
      try {
        await this.request('shutdown', null, 2_000)
      } catch {
        // server 可能已经退出；exit 通知照发。
      }
    }
    this.disposed = true
    this.failAll(new Error('language server client was disposed'))
    this.write({ jsonrpc: '2.0', method: 'exit' })
    const child = this.child
    if (!this.exited) {
      // 给它 1.2s 正常退出，然后强杀。
      await new Promise<void>((resolvePromise) => {
        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            // ignore
          }
          resolvePromise()
        }, 1_200)
        child.once('exit', () => {
          clearTimeout(timer)
          resolvePromise()
        })
      })
    }
    child.stdout?.removeAllListeners()
    child.stderr?.removeAllListeners()
    child.stdin?.removeAllListeners()
    child.stdin?.end()
  }
}
