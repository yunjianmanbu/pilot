/**
 * 邮件通知分发：把运行事件翻成一封「发给自己」的邮件。
 *
 * 与反思报告的区别：反思邮件带完整报告正文，由 `reflect/service.ts` 自己渲染；
 * 这里只处理短通知（任务完成、运行失败、等待审批、配对请求……）。两者共用同一份
 * 邮箱配置（`reflectEmailTo` / `reflectSmtpHost` / 授权码），所以「邮箱配置」只在
 * 设置里出现一次，勾选哪些事件发信属于「通知配置」。
 *
 * 三条硬约束：
 * - 发信永远不阻塞主流程：`handle()` 只入队，真正的 SMTP 会话在串行队列里跑。
 * - 关掉总开关或某个事件就一个字节都不发，也不做「静默降级」。
 * - 同一事件（同 runId / 同 requestId）只发一次，并且有全局限频，避免失败循环
 *   把用户邮箱刷爆。
 */
import type { RunEvent, NoticeTopic } from '../../shared/types'
import {
  NOTIFY_EVENTS,
  normalizeNotifyEmailEvents,
  type NotifyEventId,
} from '../../shared/notify-events'
import {
  parseRecipients,
  sendMail,
  type MailResult,
  type OutgoingMail,
  type SmtpConfig,
} from '../reflect/mail'
import { renderMailHtml, type MailTone } from '../reflect/mail-layout'
import { MAIL_TITLE_LIMIT, clipInstruction } from './instruction-title'

/** 分发器只需要这几项设置，不依赖完整的 PersistedSettings。 */
export interface NotifyMailSettings {
  notifyEmailEnabled: boolean
  notifyEmailEvents: readonly NotifyEventId[]
  reflectEmailTo: string
}

export interface MailNotifierDeps {
  settings: () => NotifyMailSettings
  /** 已保存的 SMTP 配置；缺主机等关键项时返回 null。 */
  smtp: () => SmtpConfig | null
  hasPassword: () => boolean
  /** 会话标题用作正文里的定位信息；找不到就退回「当前任务」。 */
  sessionTitle: (sessionId: string) => string
  /**
   * 本次运行的用户指令原文（未截断）。通知标题取它而不是会话名：
   * 「Pilot · 任务完成 · 新任务」看不出做完了什么，「… · 发布小红书」才看得出。
   */
  instruction?: (sessionId: string, runId?: string) => string
  english: () => boolean
  send?: (config: SmtpConfig, mail: OutgoingMail) => Promise<MailResult>
  now?: () => number
  log?: (entry: {
    area: string
    event: string
    level?: 'info' | 'warn' | 'error'
    detail?: Record<string, unknown>
  }) => void
}

/** 一分钟内最多发这么多封，超出的直接丢弃并记一条日志。 */
export const MAIL_NOTIFY_PER_MINUTE = 6
/** 同一类事件两条之间的最小间隔，防止一次批量失败刷出几十封。 */
export const MAIL_NOTIFY_SAME_EVENT_MS = 20_000
/** 只保留最近这么多条去重键，避免长时间运行后无限增长。 */
const SEEN_LIMIT = 200

/** 事件 → 通知项。纯函数，测试直接照着这张表断言。 */
export function classifyEvent(event: RunEvent): NotifyEventId | null {
  switch (event.type) {
    case 'run.failed':
      return 'run.failed'
    case 'tool.approval_required':
      return 'approval.required'
    case 'run.completed':
      return 'run.completed'
    case 'companion.pair_request':
      return 'companion.pair_request'
    case 'update.changed':
      return event.state.status === 'ready' ? 'update.ready' : null
    case 'quality.changed':
      return event.bell && event.message ? 'quality.better' : null
    case 'notice':
      return event.notifyEvent === null
        ? null
        : (event.notifyEvent ?? classifyNotice(event.level, event.topic))
    default:
      return null
  }
}

/**
 * 后台任务的通知事件带 `topic`，这里按「来源 + 级别」映射。
 * 没有 topic 的 notice 是运行过程提示（MCP 连接、压缩、审批超时等），不发信：
 * 它们量大且已经在界面里，真出事会以 `run.failed` 收尾。
 */
function classifyNotice(level: 'info' | 'warn' | 'error', topic?: NoticeTopic): NotifyEventId | null {
  switch (topic) {
    case 'reflect':
      return level === 'error' ? 'reflect.failed' : null
    case 'schedule':
      // 定时任务是「成功开始」发 info、「没能开始/执行失败」发 warn，两者共用 topic。
      return level === 'info' ? 'schedule.started' : 'schedule.failed'
    case 'module-check':
      // 自检也会发提案/自改进展的 info，那些不是「本轮扫描完成」，由调用方显式声明。
      return 'module-check.completed'
    case 'supervisor':
      return 'supervisor.applied'
    case 'quality':
      return 'quality.better'
    default:
      return null
  }
}

/** 去重键：同一件事只发一封。 */
function dedupeKey(event: RunEvent): string {
  switch (event.type) {
    case 'run.failed':
    case 'run.completed':
    case 'tool.approval_required':
      return `${event.type}:${event.runId}`
    case 'companion.pair_request':
      return `pair:${event.request.requestId}`
    case 'update.changed':
      return `update:${event.state.release?.version ?? ''}`
    case 'quality.changed':
      return `quality:${event.candidateId ?? event.workspacePath}`
    case 'notice':
      return `notice:${event.notifyEvent === null ? '' : (event.notifyEvent ?? event.topic ?? '')}:${event.message.slice(0, 80)}`
    default:
      return event.type
  }
}

/** 邮件里的时间用本地时区，用户点开就知道「多久以前」。 */
function localTime(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

interface RenderedMail {
  subject: string
  text: string
  html: string
}

interface MailDraft {
  kind: string
  tone: MailTone
  /** 主题里的定位信息：优先本次指令，没有指令才退会话名。 */
  headline: string
  /** 本次指令原文（未截断）：HTML 标题放不下时整条进正文，不丢信息。 */
  instruction?: string
  at: string
  rows: Array<[string, string]>
  paragraphs?: string[]
  blocks?: Array<{ tone?: MailTone; heading: string; lines: string[] }>
  english: boolean
}

/** HTML 标题在 600px 卡片里大约两行；更长的指令在正文里补一段完整的。 */
export const MAIL_HTML_TITLE_LIMIT = 90

/** 一份草稿同时出纯文本与 HTML：两版字段来自同一个 rows，不会各说各话。 */
function compose(draft: MailDraft): RenderedMail {
  const english = draft.english
  const subject = draft.headline
    ? `Pilot · ${draft.kind} · ${draft.headline}`
    : `Pilot · ${draft.kind}`
  const lines = [draft.kind]
  if (draft.instruction) lines.push(draft.instruction)
  lines.push('', `${english ? 'Time' : '时间'}: ${draft.at}`)
  for (const [label, value] of draft.rows) {
    if (!value) continue
    lines.push(`${label}: ${value}`)
  }
  for (const paragraph of draft.paragraphs ?? []) {
    if (paragraph) lines.push('', paragraph)
  }
  for (const block of draft.blocks ?? []) {
    lines.push('', block.heading)
    for (const line of block.lines) lines.push(line)
  }
  lines.push('', english ? 'Open Pilot to see the full run.' : '打开 Pilot 可以看到完整过程。')
  // 标题用指令，事件名退到徒标：用户扫一眼就知道「什么做完了」，而不是又看到一个「任务完成」。
  const htmlTitle = draft.instruction
    ? clipInstruction(draft.instruction, MAIL_HTML_TITLE_LIMIT)
    : draft.headline || draft.kind
  const overlength = draft.instruction
    ? Array.from(draft.instruction).length > MAIL_HTML_TITLE_LIMIT
    : false
  return {
    subject,
    text: lines.join('\n'),
    html: renderMailHtml({
      title: htmlTitle,
      eyebrow: english ? 'Activity' : '事件通知',
      badge: htmlTitle === draft.kind ? undefined : { text: draft.kind, tone: draft.tone },
      at: draft.at,
      rows: draft.rows.map(([label, value]) => ({ label, value })),
      paragraphs: draft.paragraphs,
      blocks: [
        ...(overlength && draft.instruction
          ? [
              {
                tone: 'info' as MailTone,
                heading: english ? 'Full task' : '完整指令',
                lines: [draft.instruction],
              },
            ]
          : []),
        ...(draft.blocks ?? []),
      ],
      footnote: english ? 'Open Pilot to see the full run.' : '打开 Pilot 可以看到完整过程。',
      english,
    }),
  }
}

/**
 * 会话名与指令说的是同一件事时只列一次：标题是模型按首句起的，常常就是
 * 指令的截断版，两行并排等于一句话说两遍。
 */
function sameTopic(a: string, b: string): boolean {
  const normalize = (value: string): string =>
    value.replace(/[\s,，。.、:：;；!！?？—\-…"'“”‘’()（）【】\[\]]/g, '')
  const left = normalize(a)
  const right = normalize(b)
  if (!left || !right) return false
  if (left === right) return true
  const shorter = left.length <= right.length ? left : right
  const longer = shorter === left ? right : left
  return shorter.length >= 6 && longer.startsWith(shorter)
}

/**
 * 标题与正文：主题里放本次指令，正文放事实。
 * `instruction` 是用户这一次说的话；拿不到时才退回顾会话标题。
 */
export function renderEventMail(
  event: RunEvent,
  english: boolean,
  sessionTitle: string,
  instruction = '',
  at = new Date(),
): RenderedMail | null {
  const time = localTime(at)
  const fallbackTask = english ? 'Current task' : '当前任务'
  const session = sessionTitle || fallbackTask
  const headline = instruction ? clipInstruction(instruction, MAIL_TITLE_LIMIT) : session
  // 标题就是指令，会话名只在不重复时保留一行，用来定位是哪条会话。
  const taskRows: Array<[string, string]> =
    instruction && !sameTopic(instruction, sessionTitle)
      ? [[english ? 'Session' : '会话', session]]
      : []
  const base = { english, at: time, headline, instruction }
  switch (event.type) {
    case 'run.failed': {
      const kind = english ? 'Run failed' : '运行失败'
      return compose({
        ...base,
        kind,
        tone: 'danger',
        rows: [
          ...taskRows,
          [english ? 'Error code' : '错误码', event.code],
          [english ? 'Message' : '错误信息', event.message],
        ],
      })
    }
    case 'tool.approval_required': {
      const kind = english ? 'Approval needed' : '等待审批'
      return compose({
        ...base,
        headline: instruction ? headline : event.call.name,
        kind,
        tone: 'warning',
        rows: [
          ...taskRows,
          [english ? 'Tool' : '工具', event.call.name],
          [english ? 'Risk' : '风险', event.risk],
          ...(event.reason
            ? ([[english ? 'Reason' : '原因', event.reason]] as Array<[string, string]>)
            : []),
        ],
      })
    }
    case 'run.completed': {
      const finished = event.status === 'completed'
      const kind = finished
        ? english
          ? 'Task finished'
          : '任务完成'
        : english
          ? 'Run ended early'
          : '运行提前结束'
      return compose({
        ...base,
        kind,
        tone: finished ? 'success' : 'warning',
        rows: [
          ...taskRows,
          [english ? 'Status' : '状态', event.status],
          [english ? 'Steps' : '步数', String(event.steps)],
          [english ? 'Duration' : '耗时', `${Math.max(1, Math.round(event.durationMs / 1000))}s`],
        ],
      })
    }
    case 'companion.pair_request': {
      const kind = english ? 'Pairing request' : '手机配对请求'
      return compose({
        ...base,
        headline: event.request.name,
        instruction: '',
        kind,
        tone: 'warning',
        rows: [
          [english ? 'Device' : '设备', `${event.request.name}（${event.request.platform}）`],
          [english ? 'Address' : '地址', event.request.address ?? '-'],
          [english ? 'Path' : '路径', event.request.via],
        ],
      })
    }
    case 'update.changed': {
      if (event.state.status !== 'ready') return null
      const kind = english ? 'Update ready' : '新版本已就绪'
      return compose({
        ...base,
        headline: event.state.release?.version ?? '',
        instruction: '',
        kind,
        tone: 'info',
        rows: [
          [english ? 'Current' : '当前版本', event.state.currentVersion],
          [english ? 'New version' : '新版本', event.state.release?.version ?? '-'],
          [english ? 'Channel' : '通道', event.state.release?.channel ?? '-'],
        ],
      })
    }
    case 'quality.changed': {
      if (!event.bell || !event.message) return null
      const kind = english ? 'Better candidate found' : '发现更优版本'
      return compose({
        ...base,
        headline: '',
        instruction: '',
        kind,
        tone: 'success',
        rows: [],
        paragraphs: [event.message],
      })
    }
    case 'notice': {
      const id =
        event.notifyEvent === null
          ? null
          : (event.notifyEvent ?? classifyNotice(event.level, event.topic))
      if (!id) return null
      const kind = noticeTitle(id, english)
      return compose({
        ...base,
        headline: '',
        instruction: '',
        kind,
        tone: event.level === 'error' ? 'danger' : event.level === 'warn' ? 'warning' : 'info',
        rows: [],
        paragraphs: [event.message],
      })
    }
    default:
      return null
  }
}

function noticeTitle(id: NotifyEventId, english: boolean): string {
  const entry = NOTIFY_EVENTS.find((candidate) => candidate.id === id)
  if (!entry) return 'Pilot'
  return english ? entry.en : entry.zh
}

export class MailNotifier {
  private readonly deps: MailNotifierDeps
  private readonly send: (config: SmtpConfig, mail: OutgoingMail) => Promise<MailResult>
  private readonly now: () => number
  private queue: Array<{ event: RunEvent; id: NotifyEventId }> = []
  private running = false
  private sentAt: number[] = []
  private lastByEvent = new Map<NotifyEventId, number>()
  private seen: string[] = []
  /** 已记过日志的缺失项：同一原因只报一次，免得刷满 app 日志。 */
  private loggedSkips = new Set<string>()

  constructor(deps: MailNotifierDeps) {
    this.deps = deps
    this.send = deps.send ?? sendMail
    this.now = deps.now ?? Date.now
  }

  /** 事件入口：不加 await，任何异常都只进日志。 */
  handle(event: RunEvent): void {
    try {
      const id = classifyEvent(event)
      if (!id) return
      const settings = this.deps.settings()
      if (!settings.notifyEmailEnabled) return
      const enabled = normalizeNotifyEmailEvents(settings.notifyEmailEvents)
      if (!enabled.includes(id)) return
      // 缺项以前是静默 return：用户只看到「没收到邮件」，日志里一片安静，
      // 没法判断是没配置还是 SMTP 挂了。现在留一条带原因的日志。
      const missing = this.missingForMail(settings)
      if (missing) {
        this.logSkip(id, missing)
        return
      }
      const key = dedupeKey(event)
      if (this.seen.includes(key)) return
      const last = this.lastByEvent.get(id) ?? 0
      if (this.now() - last < MAIL_NOTIFY_SAME_EVENT_MS) return
      this.remember(key)
      this.lastByEvent.set(id, this.now())
      this.dropOldSends()
      if (this.sentAt.length >= MAIL_NOTIFY_PER_MINUTE) {
        this.deps.log?.({
          area: 'mail-notify',
          event: 'rate.limited',
          level: 'warn',
          detail: { id, skipped: 1 },
        })
        return
      }
      this.sentAt.push(this.now())
      this.queue.push({ event, id })
      void this.drain()
    } catch (error) {
      this.deps.log?.({
        area: 'mail-notify',
        event: 'handle.failed',
        level: 'warn',
        detail: { message: error instanceof Error ? error.message : String(error) },
      })
    }
  }

  /** 队列里还剩多少封（测试用，也方便日志里报积压）。 */
  pending(): number {
    return this.queue.length + (this.running ? 1 : 0)
  }

  /** 邮箱是否具备发信条件：地址、主机、授权码三项都齐。 */
  mailReady(settings: NotifyMailSettings): boolean {
    return this.missingForMail(settings) === null
  }

  /**
   * 缺哪一项。名字直接进日志，所以按「读者该去设置页补哪一栏」来写：
   * `no-recipient` = 邮箱地址空，`no-smtp-host` = SMTP 主机空，`no-password` = 授权码空。
   */
  private missingForMail(settings: NotifyMailSettings): string | null {
    if (!parseRecipients(settings.reflectEmailTo)[0]) return 'no-recipient'
    if (!this.deps.smtp()) return 'no-smtp-host'
    if (!this.deps.hasPassword()) return 'no-password'
    return null
  }

  /** 同一原因只记一次：每封被跳过的信都写一行，反而会把真正的线索淹掉。 */
  private logSkip(id: NotifyEventId, reason: string): void {
    if (this.loggedSkips.has(reason)) return
    this.loggedSkips.add(reason)
    this.deps.log?.({
      area: 'mail-notify',
      event: 'skipped',
      level: 'warn',
      detail: { id, reason },
    })
  }

  private remember(key: string): void {
    this.seen.push(key)
    if (this.seen.length > SEEN_LIMIT) this.seen.splice(0, this.seen.length - SEEN_LIMIT)
  }

  private dropOldSends(): void {
    const cutoff = this.now() - 60_000
    this.sentAt = this.sentAt.filter((at) => at >= cutoff)
  }

  /** 串行发送：SMTP 一次一个连接，并发只会互相拖到超时。 */
  /** @background-isolated 见 tests/background-isolation.test.ts：异常在本方法内收口。 */
  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.queue.length > 0) {
        const job = this.queue.shift()
        if (!job) break
        try {
          const config = this.deps.smtp()
          const settings = this.deps.settings()
          const to = parseRecipients(settings.reflectEmailTo).join(', ')
          if (!config || !to) continue
          const sessionTitle =
            'sessionId' in job.event ? this.deps.sessionTitle(job.event.sessionId) : ''
          const instruction =
            this.deps.instruction && 'sessionId' in job.event
              ? this.deps.instruction(
                  job.event.sessionId,
                  'runId' in job.event ? job.event.runId : undefined,
                )
              : ''
          const rendered = renderEventMail(
            job.event,
            this.deps.english(),
            sessionTitle,
            instruction,
            new Date(this.now()),
          )
          if (!rendered) continue
          const result = await this.send(config, { to, ...rendered })
          // 发出去就说明配置齐了：清掉「缺项」记忆，下次再缺时能重新报警。
          if (result.ok) this.loggedSkips.clear()
          this.deps.log?.({
            area: 'mail-notify',
            event: result.ok ? 'sent' : 'failed',
            level: result.ok ? 'info' : 'warn',
            detail: { id: job.id, ...(result.ok ? {} : { message: result.error ?? '' }) },
          })
        } catch (error) {
          this.deps.log?.({
            area: 'mail-notify',
            event: 'send.failed',
            level: 'warn',
            detail: {
              id: job.id,
              message: error instanceof Error ? error.message : String(error),
            },
          })
        }
      }
    } catch (error) {
      // 排空队列是副线：单封邮件遇到任何意外都不能变成只会沉进全局日志的 rejection，
      // 否则这轮队列后面的通知就静默丢了。
      this.deps.log?.({
        area: 'mail-notify',
        event: 'queue.failed',
        level: 'warn',
        detail: { message: error instanceof Error ? error.message : String(error) },
      })
    } finally {
      this.running = false
    }
  }
}
