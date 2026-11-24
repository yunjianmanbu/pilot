import { hostname } from 'node:os'
import { connect as netConnect, type Socket } from 'node:net'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'

/**
 * 最小 SMTP 发信实现。
 *
 * 只为了把「反思报告」发到用户自己的邮箱，所以不引入 nodemailer：这里覆盖
 * 465 隐式 TLS、587/25 STARTTLS 与明文三种连法，AUTH PLAIN / AUTH LOGIN 两种认证，
 * 正文用 base64 传输（免去 8bit 与点行转义的坑）。任何一步失败都返回错误文本，
 * 由调用方记进报告，而不是抛出到反思流程外。
 */

export interface SmtpConfig {
  host: string
  port: number
  /** `tls` = 465 隐式加密；`starttls` = 先明文再升级；`none` = 不加密。 */
  security: 'tls' | 'starttls' | 'none'
  user: string
  password: string
  from: string
}

export interface OutgoingMail {
  to: string
  subject: string
  /** 纯文本正文：始终发送，HTML 被剥掉或客户端只读文本时仍可读。 */
  text: string
  /**
   * 可选 HTML 正文。给了就发 multipart/alternative（text 在前、html 在后），
   * 由客户端自己挑一份渲染；不给就仍是纯文本单段邮件。
   */
  html?: string
}

export interface MailResult {
  ok: boolean
  error?: string
}

export const SMTP_TIMEOUT_MS = 20_000
const MAX_RESPONSE_BYTES = 64 * 1024

/**
 * 把服务器原始回包翻译成用户能照做的建议。
 *
 * 163 拒认证时回的是 `550 User has no permission`，和「授权码」毫无字面关系，
 * 用户只会看到一句看不懂的英文。这里只做「原样回包 + 一句建议」，不改写原回包，
 * 出了别的问题仍能按服务器文字去查。
 */
export function explainSmtpFailure(raw: string, english = false): string {
  const text = raw.trim()
  const has = (pattern: RegExp) => pattern.test(text)
  if (has(/AUTH/i) || has(/\b(535|550)\b/)) {
    return english
      ? `${text} — The server rejected the login. Check that SMTP is enabled in your mailbox settings and paste the generated app password (not your login password), and that the user name matches that mailbox.`
      : `${text} — 服务器没通过登录：请在邮箱设置里开启 SMTP 服务，粘贴生成的授权码（不是登录密码），并确认用户名就是这个邮箱地址。`
  }
  if (has(/\b553\b/) || has(/sender address/i)) {
    return english
      ? `${text} — The From address must match the mailbox you signed in with.`
      : `${text} — 发件人必须与登录的邮箱地址一致。`
  }
  if (has(/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|getaddrinfo|EHOSTUNREACH|ENETUNREACH/i)) {
    return english
      ? `${text} — The host or port is unreachable; recheck the SMTP server, port and encryption.`
      : `${text} — 连不上这个主机或端口：请核对 SMTP 服务器、端口与加密方式。`
  }
  if (has(/超时|timeout/i)) {
    return english
      ? `${text} — The server did not answer in time; check the port (465 uses implicit TLS) or your network.`
      : `${text} — 服务器没有在限时内应答：请核对端口（465 用隐式 TLS）与网络。`
  }
  if (has(/\b554\b/) || has(/spam|blacklist|rejected/i)) {
    return english
      ? `${text} — The message was refused or filtered as spam; try another subject/body or check the mailbox spam folder.`
      : `${text} — 邮件被拒收或判为垃圾邮件：换个主题/正文试试，并检查邮箱的垃圾箱。`
  }
  return text
}

export function normalizeSmtpSecurity(value: unknown): SmtpConfig['security'] {
  return value === 'tls' || value === 'none' ? value : 'starttls'
}

export function clampSmtpPort(value: unknown): number {
  const port = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : NaN
  if (!Number.isFinite(port) || port < 1 || port > 65_535) return 587
  return port
}

/** 取“名字 <addr@host>”里的地址部分；没有尖括号时整串当地址。 */
export function addressOf(value: string): string {
  const match = /<([^<>\s]+@[^<>\s]+)>/.exec(value)
  return (match?.[1] ?? value).trim()
}

const ADDRESS_PATTERN = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/

export function isValidAddress(value: string): boolean {
  return ADDRESS_PATTERN.test(value.trim())
}

/**
 * 收件人可以是“a@b.c, d@e.f”这样的列表：界面提示允许逗号分隔，发信时逐个 RCPT TO。
 * 空串与纯空白的片段被丢掉，顺序保持不变（便于测试与日志对照）。
 */
export function parseRecipients(value: string): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const chunk of value.split(/[,;]/)) {
    const address = addressOf(chunk)
    if (!address || seen.has(address.toLowerCase())) continue
    seen.add(address.toLowerCase())
    result.push(address)
  }
  return result
}

function headerSafe(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim()
}

/** RFC 2047 B 编码，让中文主题在各类邮件客户端都能正确显示。 */
export function encodeHeaderValue(value: string): string {
  const single = headerSafe(value)
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(single)) return single
  const encoded = Buffer.from(single, 'utf8').toString('base64')
  const chunks = encoded.match(/.{1,60}/g) ?? []
  return chunks.map((chunk) => `=?UTF-8?B?${chunk}?=`).join('\r\n ')
}

const RFC_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const RFC_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

/**
 * RFC 5322 日期头，写成发信机的本地时区（`Tue, 24 Nov 2026 22:47:53 +0800`）。
 *
 * 不用 `toUTCString()`：它输出 GMT，一部分邮件客户端（国内网页邮箱尤其常见）
 * 不做时区换算、直接显示字符串里的钟点，于是「刚发的邮件」看起来早了或晚了 8 小时。
 * 带上显式偏移，客户端换算与不换算得到的都是同一个本地钟点。
 */
export function formatMailDate(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  // getTimezoneOffset 给的是「UTC − 本地」的分钟数，东八区是 -480，取反才是标准写法。
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMinutes)
  const zone = `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`
  return (
    `${RFC_DAYS[date.getDay()]}, ${pad(date.getDate())} ${RFC_MONTHS[date.getMonth()]} ` +
    `${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${zone}`
  )
}

function base64Lines(text: string): string {
  const encoded = Buffer.from(text, 'utf8').toString('base64')
  return (encoded.match(/.{1,76}/g) ?? ['']).join('\r\n')
}

/** 把一封纯文本邮件拼成 DATA 阶段要发送的整段内容（不含结尾的 `.`）。 */
export function buildMimeMessage(
  mail: OutgoingMail,
  options: {
    from: string
    date?: Date
    messageId?: string
    clientName?: string
    /** multipart/alternative 的分界串；测试里注入固定值，默认带时间戳避免撞车。 */
    boundary?: string
  },
): string {
  const from = options.from || 'pilot@localhost'
  const date = options.date ?? new Date()
  const domain = addressOf(from).split('@')[1] || 'pilot.local'
  const messageId = options.messageId ?? `<${date.getTime()}.${process.pid}@${domain}>`
  const html = mail.html?.trim() ? mail.html : undefined
  const boundary = options.boundary ?? `pilot-${date.getTime()}-${process.pid}`
  const headers = [
    `From: ${encodeHeaderValue(from)}`,
    `To: ${encodeHeaderValue(mail.to)}`,
    `Subject: ${encodeHeaderValue(mail.subject)}`,
    `Date: ${formatMailDate(date)}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    ...(html
      ? [`Content-Type: multipart/alternative; boundary="${boundary}"`]
      : ['Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64']),
    `X-Mailer: ${encodeHeaderValue(options.clientName ?? 'Pilot')}`,
  ]
  const headerBlock = headers.join('\r\n')
  if (!html) return `${headerBlock}\r\n\r\n${base64Lines(mail.text)}`
  // 两段都用 base64 传输：中文正文不需要 8bit 协商，也不会有以 `.` 开头的行。
  const body = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(mail.text),
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(html),
    `--${boundary}--`,
  ].join('\r\n')
  return `${headerBlock}\r\n\r\n${body}`
}

/** DATA 阶段的点行转义：正文里以 `.` 开头的行要写成两个点。 */
export function dotStuff(message: string): string {
  return message.replace(/(^|\r\n)\./g, '$1..')
}

type SmtpSocket = Socket | TLSSocket

interface Reading {
  code: number
  lines: string[]
}

const FAILED: Reading = { code: -1, lines: [] }

/**
 * 一行一行读 SMTP 应答：`NNN-` 是续行，`NNN ` 是结束行。
 * 兼容只发裸 `\n` 的服务器。
 */
class SmtpSession {
  private buffer = ''
  private partial: Reading | null = null
  private waiter: ((value: Reading) => void) | null = null
  private readonly queued: Reading[] = []
  private failure: Reading | null = null

  constructor(
    private socket: SmtpSocket,
    private readonly tlsHost: string,
  ) {
    this.attach()
  }

  private attach(): void {
    const socket = this.socket
    socket.setEncoding('utf8')
    socket.setTimeout(SMTP_TIMEOUT_MS, () => {
      this.fail(new Error(`SMTP 超时（${SMTP_TIMEOUT_MS / 1000}s 无响应）`))
      socket.destroy()
    })
    socket.on('data', (chunk: string) => this.onData(chunk))
    socket.on('error', (error: Error) => this.fail(error))
    socket.on('close', () => this.fail(new Error('SMTP 连接被服务器关闭')))
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    if (this.buffer.length > MAX_RESPONSE_BYTES) {
      this.fail(new Error('SMTP 响应过长'))
      this.socket.destroy()
      return
    }
    for (;;) {
      const index = this.buffer.indexOf('\n')
      if (index < 0) return
      const line = this.buffer.slice(0, index).replace(/\r$/, '')
      this.buffer = this.buffer.slice(index + 1)
      const match = /^(\d{3})([ -])(.*)$/.exec(line)
      if (!match) continue
      const code = Number(match[1])
      if (!this.partial) this.partial = { code, lines: [] }
      this.partial.lines.push(match[3] ?? '')
      if (match[2] === ' ') {
        const done = this.partial
        this.partial = null
        this.deliver(done)
      }
    }
  }

  private deliver(reading: Reading): void {
    if (this.waiter) {
      const waiter = this.waiter
      this.waiter = null
      waiter(reading)
      return
    }
    this.queued.push(reading)
  }

  private fail(error: Error): void {
    if (!this.failure) this.failure = { code: -1, lines: [error.message] }
    const waiter = this.waiter
    this.waiter = null
    if (waiter) waiter(this.failure)
  }

  read(): Promise<Reading> {
    const queued = this.queued.shift()
    if (queued) return Promise.resolve(queued)
    if (this.failure) return Promise.resolve(this.failure)
    return new Promise<Reading>((resolve) => {
      this.waiter = resolve
    })
  }

  write(data: string): void {
    this.socket.write(data)
  }

  async command(line: string, expect: number[]): Promise<Reading> {
    this.socket.write(`${line}\r\n`)
    const reading = await this.read()
    if (reading.code < 0) throw new Error(reading.lines[0] ?? 'SMTP 连接失败')
    if (!expect.includes(reading.code)) {
      const command = line.split(' ')[0] ?? ''
      throw new Error(`SMTP ${command} 失败：${reading.code} ${reading.lines.join(' ')}`)
    }
    return reading
  }

  /** STARTTLS：在现有 socket 上做 TLS 握手，返回新的会话对象。 */
  async upgrade(): Promise<SmtpSession> {
    const secure = tlsConnect({ socket: this.socket, servername: this.tlsHost })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('STARTTLS 握手超时')), SMTP_TIMEOUT_MS)
      secure.once('secureConnect', () => {
        clearTimeout(timer)
        resolve()
      })
      secure.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })
    return new SmtpSession(secure, this.tlsHost)
  }

  async close(): Promise<void> {
    try {
      this.socket.write('QUIT\r\n')
    } catch {
      // 连接已经断了就不必礼貌告别。
    }
    this.socket.end()
  }

  destroy(): void {
    this.socket.destroy()
  }
}

function openSocket(config: SmtpConfig): Promise<SmtpSocket> {
  return new Promise((resolve, reject) => {
    const socket =
      config.security === 'tls'
        ? tlsConnect({ host: config.host, port: config.port, servername: config.host })
        : netConnect({ host: config.host, port: config.port })
    const event = config.security === 'tls' ? 'secureConnect' : 'connect'
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`连接 ${config.host}:${config.port} 超时`))
    }, SMTP_TIMEOUT_MS)
    socket.once(event, () => {
      clearTimeout(timer)
      socket.setTimeout(0)
      resolve(socket)
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

function authMode(capabilities: string): 'plain' | 'login' | null {
  const upper = capabilities.toUpperCase()
  if (/\bPLAIN\b/.test(upper)) return 'plain'
  if (/\bLOGIN\b/.test(upper)) return 'login'
  return upper.includes('AUTH') ? 'login' : null
}

/** 发一封纯文本邮件；不抛异常，失败原因放在返回值里。 */
export async function sendMail(config: SmtpConfig, mail: OutgoingMail): Promise<MailResult> {
  const host = config.host.trim()
  const recipients = parseRecipients(mail.to)
  if (!host) return { ok: false, error: '未填写 SMTP 服务器地址' }
  if (recipients.length === 0) {
    return { ok: false, error: `收件人地址无效：${mail.to || '(空)'}` }
  }
  const invalid = recipients.find((entry) => !isValidAddress(entry))
  if (invalid) return { ok: false, error: `收件人地址无效：${invalid}` }
  const from = config.from.trim() || config.user.trim()
  if (!isValidAddress(addressOf(from))) {
    return { ok: false, error: `发件人地址无效：${from || '(空)'}` }
  }
  let socket: SmtpSocket | null = null
  let session: SmtpSession | null = null
  /** QUIT 已发出、服务器已确认，连接由对方关闭；此时再 destroy 会把 FIN 变成 RST。 */
  let quitCleanly = false
  try {
    socket = await openSocket({ ...config, host })
    const greeting = await (session = new SmtpSession(socket, host)).read()
    if (greeting.code !== 220) {
      return { ok: false, error: `服务器未就绪：${greeting.code} ${greeting.lines.join(' ')}` }
    }
    const ehloHost = (hostname() || 'pilot').replace(/[^A-Za-z0-9.-]/g, '') || 'pilot'
    let capabilities = (await session.command(`EHLO ${ehloHost}`, [250])).lines.join(' ')
    if (config.security === 'starttls') {
      await session.command('STARTTLS', [220])
      const secured = await session.upgrade()
      session.destroy()
      session = secured
      capabilities = (await session.command(`EHLO ${ehloHost}`, [250])).lines.join(' ')
    }
    const user = config.user.trim()
    if (user) {
      if (!config.password) return { ok: false, error: '未填写 SMTP 密码或授权码' }
      const mode = authMode(capabilities)
      if (!mode) return { ok: false, error: '服务器不支持 AUTH PLAIN / AUTH LOGIN 认证' }
      if (mode === 'plain') {
        const token = Buffer.from(`\0${user}\0${config.password}`, 'utf8').toString('base64')
        await session.command(`AUTH PLAIN ${token}`, [235])
      } else {
        await session.command('AUTH LOGIN', [334])
        await session.command(Buffer.from(user, 'utf8').toString('base64'), [334])
        await session.command(Buffer.from(config.password, 'utf8').toString('base64'), [235])
      }
    }
    await session.command(`MAIL FROM:<${addressOf(from)}>`, [250])
    for (const recipient of recipients) {
      await session.command(`RCPT TO:<${recipient}>`, [250, 251])
    }
    await session.command('DATA', [354])
    session.write(`${dotStuff(buildMimeMessage(mail, { from }))}\r\n.\r\n`)
    const accepted = await session.read()
    if (accepted.code !== 250) {
      return { ok: false, error: `邮件未被接收：${accepted.code} ${accepted.lines.join(' ')}` }
    }
    await session.close()
    quitCleanly = true
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    if (!quitCleanly) {
      session?.destroy()
      socket?.destroy()
    }
  }
}
