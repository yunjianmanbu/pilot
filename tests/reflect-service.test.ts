import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

let userDataDir = ''

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataDir,
    getLocale: () => 'zh-CN',
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error('not available in tests')
    },
    decryptString: () => {
      throw new Error('not available in tests')
    },
  },
}))

import { Store } from '../src/main/store'
import { ReflectService } from '../src/main/reflect/service'
import type { RunEvent } from '../src/shared/types'

/**
 * 反思服务的端到端用例：真实 HTTP（OpenAI 兼容 SSE）+ 真实 SMTP（明文），
 * 只监听 127.0.0.1 的临时端口，不访问外网。这样「报错触发 → 模型调用 →
 * 报告落库 → 邮件投递」整条链路每次都会被测到，而不是只测纯函数。
 */

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length) {
    const stop = cleanups.pop()
    if (stop) await stop()
  }
})

interface MockModel {
  baseUrl: string
  /** 每次 /chat/completions 的请求体，供断言 prompt 内容。 */
  requests: Array<{ model: string; messages: Array<{ role: string; content: string }> }>
  close: () => Promise<void>
}

async function startModel(reply: unknown = { summary: '缓存陈旧', findings: [] }): Promise<MockModel> {
  const requests: MockModel['requests'] = []
  const server: Server = createServer((req, res) => {
    if (!req.url?.includes('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"error":"not found"}')
      return
    }
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      const parsed = JSON.parse(raw) as { model: string; messages: Array<{ role: string; content: string }> }
      requests.push(parsed)
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const body = {
        id: 'chatcmpl-test',
        object: 'chat.completion.chunk',
        model: parsed.model,
        choices: [{ index: 0, delta: { content: JSON.stringify(reply) }, finish_reason: null }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }
      res.write(`data: ${JSON.stringify(body)}\n\n`)
      res.write(
        `data: ${JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion.chunk',
          model: parsed.model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })}\n\n`,
      )
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

interface MockSmtp {
  port: number
  /** 每次 DATA 阶段的发件人、收件人与正文（base64）。 */
  mails: Array<{ from: string; recipients: string[]; body: string }>
  close: () => Promise<void>
}

async function startSmtp(): Promise<MockSmtp> {
  const mails: MockSmtp['mails'] = []
  const server: TcpServer = createTcpServer((socket) => {
    let buffer = ''
    let inData = false
    let sender = ''
    let recipients: string[] = []
    let data = ''
    socket.on('error', () => undefined)
    socket.write('220 mock-smtp ready\r\n')
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      for (;;) {
        const index = buffer.indexOf('\r\n')
        if (index < 0) return
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        if (inData) {
          if (line === '.') {
            inData = false
            mails.push({ from: sender, recipients: [...recipients], body: data })
            sender = ''
            recipients = []
            data = ''
            socket.write('250 ok queued\r\n')
          } else {
            data += `${line.startsWith('..') ? line.slice(1) : line}\n`
          }
          continue
        }
        const upper = line.toUpperCase()
        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          socket.write('250-mock-smtp\r\n250 AUTH PLAIN LOGIN\r\n')
        } else if (upper.startsWith('AUTH')) {
          socket.write('235 authenticated\r\n')
        } else if (upper.startsWith('MAIL FROM')) {
          sender = /<([^>]+)>/.exec(line)?.[1] ?? ''
          socket.write('250 ok\r\n')
        } else if (upper.startsWith('RCPT TO')) {
          const found = /<([^>]+)>/.exec(line)?.[1]
          if (found) recipients.push(found)
          socket.write('250 ok\r\n')
        } else if (upper === 'DATA') {
          inData = true
          socket.write('354 end with .\r\n')
        } else if (upper === 'QUIT') {
          socket.write('221 bye\r\n')
          socket.end()
        } else {
          socket.write('250 ok\r\n')
        }
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    port,
    mails,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}

/**
 * mail.ts 的正文统一按 base64 编码：单段纯文本直接解，multipart/alternative
 * 时把每个 part 解出来拼起来（通知与报告都带 HTML 版）。
 */
function decodeBase64Body(raw: string): string {
  const boundary = raw.match(/boundary="([^"]+)"/)?.[1]
  if (boundary) {
    return raw
      .split(`--${boundary}`)
      .filter((part) => part.includes('Content-Type:'))
      .map((part) => {
        const separator = part.search(/\r?\n\r?\n/)
        const match = part.slice(separator).match(/^\r?\n\r?\n/)
        const body = match ? part.slice(separator + match[0].length) : part
        return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8')
      })
      .join('\n')
  }
  const separator = raw.search(/\r?\n\r?\n/)
  const body = separator >= 0 ? raw.slice(separator + 2) : raw
  return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8')
}

async function setup(options: {
  model: MockModel
  smtp: MockSmtp
  reflectEnabled?: boolean
  onError?: boolean
  emailEnabled?: boolean
  /** 默认注入空代码事实：证据门控下「一条证据都没有」就不会提问，真实宿主也总会注入。 */
  withCodeFacts?: boolean
}): Promise<{ store: Store; service: ReflectService; notices: RunEvent[] }> {
  const root = await mkdtemp(join(tmpdir(), 'pilot-reflect-service-'))
  cleanups.push(async () => rm(root, { recursive: true, force: true }))
  userDataDir = join(root, 'user-data')
  const store = new Store()
  await store.load()
  await store.updateSettings({
    modelResources: [
      {
        id: 'primary',
        label: 'Mock',
        baseUrl: options.model.baseUrl,
        model: 'mock-reflector',
        enabled: true,
        apiKey: 'mock-key',
      },
    ],
    reflectEnabled: options.reflectEnabled ?? true,
    reflectModelId: 'primary',
    reflectTriggers: { onError: options.onError ?? true, onSchedule: false },
    reflectTopics: ['compaction-drift', 'code-quality'],
    reflectEmailEnabled: options.emailEnabled ?? true,
    // 只有一个邮箱字段：收件人、SMTP 登录名与发件人都是它。
    reflectEmailTo: 'ops@example.com',
    reflectSmtpHost: '127.0.0.1',
    reflectSmtpPort: options.smtp.port,
    reflectSmtpSecurity: 'none',
  })
  const notices: RunEvent[] = []
  const service = new ReflectService(store, (event) => notices.push(event))
  // `main/index.ts` 与 `server/main.ts` 都会调用 useCodeFacts：不注入就等于「这台机器上
  // 从没跑过自检」，证据门控会把所有问题域都跳过。
  if (options.withCodeFacts ?? true) {
    service.useCodeFacts(() => ({ oversized: [], decisions: [], missingDecisions: [], risks: [] }))
  }
  return { store, service, notices }
}

describe('ReflectService error trigger', () => {
  it('runs a reflection on run failure, stores it and mails the report', async () => {
    const model = await startModel({
      summary: '失败集中在压缩后的路径约束。',
      findings: [
        {
          topic: 'compaction-drift',
          severity: 'high',
          observation: '压缩把早期约束丢掉后没有复查。',
          suggestion: '压缩后回读原始请求。',
        },
      ],
    })
    const smtp = await startSmtp()
    cleanups.push(model.close, smtp.close)
    const { store, service, notices } = await setup({ model, smtp })
    // 单字段后邮箱同时是 SMTP 登录名，所以必须同时有授权码，否则会先被「缺授权码」拦住。
    store.setSmtpPassword('mock-auth')

    await service.onRunFailure('ModelError: 401 invalid api key sk-abcdef0123456789')

    const reports = store.reflectionReports()
    expect(reports).toHaveLength(1)
    const report = reports[0]!
    expect(report).toMatchObject({
      trigger: 'error',
      model: 'mock-reflector',
      summary: '失败集中在压缩后的路径约束。',
      email: { sent: true, to: 'ops@example.com' },
    })
    expect(report.findings).toHaveLength(1)

    // 报错原文进了 prompt，但密钥被脱敏掉了。
    const prompt = model.requests[0]!.messages.map((entry) => entry.content).join('\n')
    expect(prompt).toContain('401 invalid api key')
    expect(prompt).not.toContain('sk-abcdef0123456789')

    // 邮件真的投递到了收件人，正文里带摘要。
    expect(smtp.mails).toHaveLength(1)
    const mail = smtp.mails[0]!
    expect(mail.recipients).toEqual(['ops@example.com'])
    expect(decodeBase64Body(mail.body)).toContain('失败集中在压缩后的路径约束。')

    expect(notices.some((event) => event.type === 'notice')).toBe(true)
  })

  it('reflects once inside the cooldown window', async () => {
    const model = await startModel({ summary: '重复失败', findings: [] })
    const smtp = await startSmtp()
    cleanups.push(model.close, smtp.close)
    const { store, service } = await setup({ model, smtp })

    await service.onRunFailure('boom 1')
    await service.onRunFailure('boom 2')

    expect(store.reflectionReports()).toHaveLength(1)
    expect(model.requests).toHaveLength(1)
  })

  it('asks nobody when no topic has usable evidence, and says what is missing', async () => {
    const model = await startModel({ summary: '不应发生', findings: [] })
    const smtp = await startSmtp()
    cleanups.push(model.close, smtp.close)
    const { store, service } = await setup({ model, smtp, withCodeFacts: false })

    await service.onRunFailure('boom')

    // 报告照常落库，但不烧模型额度：没有数字时模型只能写套话，而套话看起来像结论。
    const report = store.reflectionReports()[0]!
    expect(model.requests).toHaveLength(0)
    expect(report.model).toBe('')
    expect(report.summary).toContain('没有向模型提问')
    expect(report.topics).toEqual([])
    expect(report.skipped.map((entry) => entry.topic).sort()).toEqual([
      'code-quality',
      'compaction-drift',
    ])
    // 跳过原因要具体到缺哪类证据，否则用户没法补。
    const compaction = report.skipped.find((entry) => entry.topic === 'compaction-drift')
    expect(compaction?.missing).toEqual(['compaction'])
  })

  it('skips the error trigger when it is disabled', async () => {
    const model = await startModel({ summary: '不应发生', findings: [] })
    const smtp = await startSmtp()
    cleanups.push(model.close, smtp.close)
    const { store, service } = await setup({ model, smtp, onError: false })

    await service.onRunFailure('boom')

    expect(store.reflectionReports()).toHaveLength(0)
    expect(model.requests).toHaveLength(0)
    expect(smtp.mails).toHaveLength(0)
  })

  it('reports a missing SMTP authorization code instead of failing the connection', async () => {
    const model = await startModel({ summary: '未配授权码', findings: [] })
    const smtp = await startSmtp()
    cleanups.push(model.close, smtp.close)
    const { store, service, notices } = await setup({ model, smtp })
    // 只填了邮箱与主机、没有授权码：不该拿着空密码去连服务器。
    await store.updateSettings({ reflectEmailTo: 'nokey@example.com' })

    await service.onRunFailure('boom')

    const report = store.reflectionReports()[0]!
    expect(report.email).toMatchObject({ sent: false, to: 'nokey@example.com' })
    expect(report.email?.error).toContain('授权码')
    expect(smtp.mails).toHaveLength(0)
    // 报告落库但没发出去时，用户必须当场看到原因，而不是只留在报告字段里。
    const warning = notices.find(
      (event) => event.type === 'notice' && event.level === 'warn',
    )
    expect(warning?.type === 'notice' ? warning.message : '').toContain('授权码')
  })

  it('uses the single mailbox as recipient, SMTP user name and sender', async () => {
    const model = await startModel({ summary: '同邮箱收发', findings: [] })
    const smtp = await startSmtp()
    cleanups.push(model.close, smtp.close)
    const { store, service } = await setup({ model, smtp })
    // 设置页只剩一个邮箱栏：收件、SMTP 登录名、发件人都取它。
    await store.updateSettings({ reflectEmailTo: 'same@163.com' })
    store.setSmtpPassword('mock-auth')

    await service.onRunFailure('boom')

    const report = store.reflectionReports()[0]!
    expect(report.email).toMatchObject({ sent: true, to: 'same@163.com' })
    expect(smtp.mails).toHaveLength(1)
    // 信封两端是同一个地址：代码里没有「收发不能用同一邮箱」的限制。
    expect(smtp.mails[0]!.from).toBe('same@163.com')
    expect(smtp.mails[0]!.recipients).toEqual(['same@163.com'])
  })
})
