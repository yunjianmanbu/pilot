import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NoticeTopic, RunEvent } from '../../shared/types'
import {
  REFLECTION_ERROR_COOLDOWN_MS,
  reflectionScheduleDue,
  reflectionTopicsWithEvidence,
  sanitizeReflectionReport,
  type ReflectionEmailState,
  type ReflectionFinding,
  type ReflectionReport,
  type ReflectionTrigger,
} from '../../shared/reflect'
import { DeepSeekClient } from '../agent/model'
import { redactSecrets, scrub } from '../agent/evolution/evidence'
import type { Store } from '../store'
import {
  collectEvidence,
  evidenceAvailability,
  renderEvidence,
  type ReflectionCodeFacts,
} from './evidence'
import { sendMail, explainSmtpFailure, parseRecipients, type SmtpConfig } from './mail'
import {
  buildReflectionSystemPrompt,
  buildReflectionUserPrompt,
  parseReflectionOutput,
  renderReportText,
} from './prompt'

const TICK_MS = 60_000
/** 反思是后台自省，不该长时间占着模型额度。 */
const REFLECTION_TIMEOUT_MS = 180_000
const MAX_ERROR_CHARS = 1_200
/** 落库的报告只留这么一段证据摘要；全文另存，报告体积和存储体积都不要被它撑大。 */
const EVIDENCE_PREVIEW_CHARS = 2_000
/** 证据全文保留的份数：够回查最近几轮的推导，又不至于把磁盘堆成垃圾场。 */
const MAX_EVIDENCE_FILES = 20

export interface ReflectOptions {
  trigger: ReflectionTrigger
  /** 报错触发时的错误原文。 */
  error?: string
  /** 版本变化触发时的上一版与当前版。 */
  versionChange?: { from: string; to: string }
}

/**
 * 摘掉证据里没出现过的引用。
 *
 * 模型偶尔会写一个「看上去很像」的路径（例如把 `src/main/reflect/service.ts`
 * 写成 `src/main/service.ts`）。这种引用比没有引用更糟：用户点进去对不上，
 * 就会连真话一起不信。所以只保留能在本轮证据文本里逐字找到的路径。
 */
function withEvidenceRefs(
  findings: readonly ReflectionFinding[],
  evidenceText: string,
): ReflectionFinding[] {
  const haystack = evidenceText.replace(/\\/g, '/')
  return findings.map((finding) => {
    const refs = (finding.refs ?? []).filter((ref) => haystack.includes(ref.path))
    if (refs.length === (finding.refs ?? []).length) return finding
    const trimmed: ReflectionFinding = { ...finding }
    delete trimmed.refs
    if (refs.length > 0) trimmed.refs = refs
    return trimmed
  })
}

/**
 * 反思服务：把「Pilot 自问」做成一个可以手动、报错后、或按固定时间触发的动作。
 *
 * 三条硬约束：
 * 1. 只读本地统计证据 + 一次模型调用，不调用任何工具，因此不会弹审批、不会改文件，
 *    也不会因为沙箱或路径规则把一次自省变成一次失败运行。
 * 2. 与用户任务互不干扰：模型不可用、SMTP 不可用时只把错误写进报告/通知，
 *    绝不让后台触发把主流程拖住。
 * 3. 单飞行（single-flight）：定时与报错同时到点也只跑一次，避免并发烧 token。
 */
export class ReflectService {
  private timer: NodeJS.Timeout | null = null
  private inFlight: Promise<ReflectionReport> | null = null
  private lastErrorRunAt = 0
  /** 宿主注入的代码事实来源：与自检报告、拆分决策同源，避免两套结论打架。 */
  private codeFactsProvider: (() => ReflectionCodeFacts | null) | null = null
  /** 宿主注入的应用版本：`version` 模式拿它和上次反思的版本比较。 */
  private versionProvider: (() => string) | null = null

  constructor(
    private readonly store: Store,
    private readonly emit: (event: RunEvent) => void,
  ) {}

  /**
   * 注入代码事实。自检服务由宿主在引擎之后创建，所以不能在构造函数里直接传。
   * 没有注入时反思只谈运行数据，不会凭空给出结构建议。
   */
  useCodeFacts(provider: () => ReflectionCodeFacts | null): void {
    this.codeFactsProvider = provider
  }

  /**
   * 注入应用版本。没有注入时反思只按定时/报错触发，版本模式拿不到锚点就不会因升级而跑。
   */
  useAppVersion(provider: () => string): void {
    this.versionProvider = provider
  }

  /** 当前应用版本；宿主没注入时返回空串。 */
  currentVersion(): string {
    try {
      return (this.versionProvider?.() ?? '').trim()
    } catch {
      return ''
    }
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.tick()
    }, TICK_MS)
    // 后台自省不该让进程退出。
    this.timer.unref?.()
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  /** 是否已有一次反思在跑；手机端据此禁用重复触发。 */
  get running(): boolean {
    return Boolean(this.inFlight)
  }

  private get english(): boolean {
    return this.store.uiLocale() === 'en'
  }

  /** 定时触发的入口，由 interval 调用；一分钟一次，命中判定交给共享纯函数。 */
  /** @background-isolated 见 tests/background-isolation.test.ts：异常在本方法内收口。 */
  async tick(now = new Date()): Promise<void> {
    try {
      const settings = this.store.settings()
      if (!settings.reflectEnabled || !settings.reflectTriggers.onSchedule) return
      const due = reflectionScheduleDue(
        {
          mode: settings.reflectScheduleMode,
          intervalMinutes: settings.reflectIntervalMinutes,
          dailyTime: settings.reflectDailyTime,
          lastRunAt: settings.reflectLastRunAt || null,
          lastScheduledAt: this.store.reflectLastScheduledAt(),
          currentVersion: this.currentVersion(),
          lastVersion: settings.reflectLastVersion,
        },
        now,
      )
      if (!due) return
      // 版本变化触发时把前后版本带进提示词：模型该看的是「这一版改坏了什么」，
      // 而不是把历史遗留问题重新罗列一遍。
      const current = this.currentVersion()
      const previous = settings.reflectLastVersion.trim()
      const versionChange =
        settings.reflectScheduleMode === 'version' && previous && current && previous !== current
          ? { from: previous, to: current }
          : undefined
      // 先记下这次排定，即使随后反思失败也不会在同一分钟内反复重试。
      await this.store.noteReflectionScheduled(now.toISOString())
      await this.run({ trigger: 'schedule', ...(versionChange ? { versionChange } : {}) })
    } catch (error) {
      // 后台触发不能上抛（未处理的 rejection 会掀掉主进程），但也不能静默：用户需要知道这次反思没跑成。
      this.notifyFailure(error)
    }
  }

  /** 一次运行失败后的钩子。冷却窗口内的连续失败只反思一次。 */
  async onRunFailure(error: string | undefined): Promise<void> {
    const settings = this.store.settings()
    if (!settings.reflectEnabled || !settings.reflectTriggers.onError) return
    const now = Date.now()
    if (now - this.lastErrorRunAt < REFLECTION_ERROR_COOLDOWN_MS) return
    this.lastErrorRunAt = now
    try {
      await this.run({ trigger: 'error', error })
    } catch (caught) {
      // 同上：失败已在上层的通知里出现，这里不再上抛。
      this.notifyFailure(caught)
    }
  }

  /**
   * 真正的反思动作：采集证据 → 一次模型调用 → 落库 → 按配置发信。
   * 并发调用会共享同一次运行，避免两条触发路径各烧一次 token。
   */
  async run(options: ReflectOptions): Promise<ReflectionReport> {
    if (this.inFlight) return this.inFlight
    const task = this.execute(options).finally(() => {
      this.inFlight = null
    })
    this.inFlight = task
    return task
  }

  private async execute(options: ReflectOptions): Promise<ReflectionReport> {
    const settings = this.store.settings()
    const english = this.english
    const target = this.store.reflectModelTarget()
    if (!target) {
      throw new Error(
        english
          ? 'No API key is configured for the reflection model. Open Settings and add one.'
          : '反思模型还没有可用的 API Key，请到设置里配置。',
      )
    }
    const startedAt = Date.now()
    const codeFacts = this.codeFactsProvider?.() ?? null
    const evidence = collectEvidence(this.store, new Date(), codeFacts)
    const evidenceText = renderEvidence(evidence, english)
    // 门控：没有证据的问题域不进提示词，跳过的域连同「缺什么」一起落进报告。
    const gated = reflectionTopicsWithEvidence(settings.reflectTopics, evidenceAvailability(evidence))
    const errorText = options.error ? scrub(options.error, MAX_ERROR_CHARS) : ''

    let summary = ''
    let findings: ReflectionFinding[] = []
    if (gated.usable.length === 0) {
      // 没有可用证据就不问了：让模型在没有数字的情况下作答，产出的只能是套话，
      // 而套话最大的害处是看起来像结论（用户会照着它改代码）。
      summary = english
        ? 'No topic had usable evidence this round, so the model was not asked. Missing evidence is listed below.'
        : '本轮没有任何问题域拿到可用证据，因此没有向模型提问；缺什么列在下面。'
    } else {
      const client = new DeepSeekClient({
        apiKey: target.apiKey,
        baseUrl: target.baseUrl,
        model: target.model,
        // 报告是结构化短文本，但推理型模型会先花 token 思考；给足额度避免截断。
        maxOutputTokens: 8_000,
        temperature: 0.2,
      })
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), REFLECTION_TIMEOUT_MS)
      let content = ''
      try {
        const response = await client.complete({
          messages: [
            { role: 'system', content: buildReflectionSystemPrompt(english) },
            {
              role: 'user',
              content: buildReflectionUserPrompt({
                trigger: options.trigger,
                // 只问拿到证据的域：传全套再靠提示词“请自己跳过”，实测会凑数。
                topics: gated.usable.map((topic) => topic.id),
                evidence: evidenceText,
                errorText: errorText || undefined,
                versionChange: options.versionChange,
                english,
              }),
            },
          ],
          tools: [],
          signal: controller.signal,
        })
        content = response.content ?? ''
      } finally {
        clearTimeout(timeout)
      }
      const parsed = parseReflectionOutput(content)
      summary = parsed.summary
      // 引用必须能在证据里找到：模型写的路径常常“看上去对、其实不存在”，
      // 这种引用比没有引用更糟——用户点进去对不上，就再也不信这份报告了。
      findings = withEvidenceRefs(parsed.findings, evidenceText)
    }

    const createdAt = new Date().toISOString()
    const id = randomUUID()
    // 本轮反思对应的应用版本：既是报告的可核对标记，也是 version 模式的锚点。
    const version = this.currentVersion()
    // 落库的只是 2k 预览；这一轮真正喂给模型的全文另存，回查时才知道它是看着什么下结论的。
    const saved = this.writeEvidence(id, redactSecrets(evidenceText))
    const draft: ReflectionReport = {
      id,
      createdAt,
      trigger: options.trigger,
      model: gated.usable.length === 0 ? '' : target.model,
      ...(version ? { version } : {}),
      topics: gated.usable.map((topic) => topic.id),
      skipped: gated.skipped,
      summary,
      findings,
      evidence: scrub(evidenceText, EVIDENCE_PREVIEW_CHARS),
      evidenceChars: saved.chars,
      ...(saved.file ? { evidenceFile: saved.file } : {}),
      durationMs: Date.now() - startedAt,
      email: null,
    }
    draft.email = await this.deliverMail(draft, english)
    const stored = sanitizeReflectionReport(draft) ?? draft
    await this.store.addReflectionReport(stored)
    if (gated.usable.length === 0) {
      this.notify(
        'info',
        english
          ? 'Reflection skipped: no usable evidence for the selected topics.'
          : '反思已记录：所选问题域都没有可用证据，本次没有提问。',
      )
    } else if (english) {
      const count = stored.findings.length
      this.notify('info', `Reflection finished · ${count} finding${count === 1 ? '' : 's'}.`)
    } else {
      this.notify('info', `反思完成 · ${stored.findings.length} 条发现。`)
    }
    // 邮件没发出去必须当场说清原因：报告已经落库，但用户邮箱里什么都没有，
    // 只把错误写在报告字段里等于让用户去猜（最常见的是没存 SMTP 授权码）。
    if (stored.email && !stored.email.sent) {
      const reason = stored.email.error?.trim()
      this.notify(
        'warn',
        english
          ? `Reflection saved, but the report was not emailed${reason ? `: ${reason}` : '.'}`
          : `反思已记录，但报告没有发到邮箱${reason ? `：${reason}` : '。'}`,
      )
    }
    return stored
  }

  /** 把这一轮真正喂给模型的证据全文落盘，报告里只留文件名与字符数。 */
  private writeEvidence(id: string, text: string): { chars: number; file?: string } {
    const chars = text.length
    try {
      const dir = join(this.store.dataDir(), 'reflect-evidence')
      mkdirSync(dir, { recursive: true })
      const file = `${id}.txt`
      writeFileSync(join(dir, file), text, 'utf8')
      this.pruneEvidence(dir)
      return { chars, file }
    } catch {
      // 写不了盘不能把整次反思废掉：报告里的 2k 预览仍然可用。
      return { chars }
    }
  }

  /** 只留最近几份证据；按 mtime 而不是文件名（uuid 里没有时间信息）。 */
  private pruneEvidence(dir: string): void {
    try {
      const files = readdirSync(dir)
        .filter((name) => name.endsWith('.txt'))
        .map((name) => ({ name, at: statSync(join(dir, name)).mtimeMs }))
        .sort((left, right) => right.at - left.at)
      for (const entry of files.slice(MAX_EVIDENCE_FILES)) {
        try {
          unlinkSync(join(dir, entry.name))
        } catch {
          // 已被别处删掉：不影响本轮。
        }
      }
    } catch {
      // 目录不存在或读不了：没有需要清理的东西。
    }
  }

  /**
   * 报告邮件是否该发：由「通知配置」里的 `reflect.report` 事件决定，总开关关掉
   * 就一封都不发。旧字段 `reflectEmailEnabled` 只作为读不到事件表时的兼容依据。
   */
  private mailWanted(settings: { notifyEmailEnabled?: boolean; notifyEmailEvents?: readonly string[]; reflectEmailEnabled?: boolean }): boolean {
    if (settings.notifyEmailEnabled === false) return false
    const events = settings.notifyEmailEvents
    if (Array.isArray(events)) return events.includes('reflect.report')
    return settings.reflectEmailEnabled === true
  }

  /** 按配置发信；没配或发失败都只体现在报告里，不抛出。 */
  private async deliverMail(
    report: ReflectionReport,
    english: boolean,
  ): Promise<ReflectionEmailState | null> {
    const settings = this.store.settings()
    if (!this.mailWanted(settings)) return null
    const to = settings.reflectEmailTo.trim()
    if (!to) {
      return {
        sent: false,
        to: '',
        error: english ? 'No mailbox configured.' : '还没有填写邮箱地址。',
      }
    }
    const config = this.smtpConfig()
    if (!config) {
      return {
        sent: false,
        to,
        error: english ? 'SMTP host and port are required.' : 'SMTP 服务器和端口还没填。',
      }
    }
    // 有邮箱却没授权码：163/QQ 这类服务器会直接 535 拒发，先在这里说清楚，
    // 不把一次报告卡在必然失败的 TCP 连接上。
    if (config.user && !config.password) {
      return {
        sent: false,
        to,
        error: english
          ? 'SMTP authorization code is not saved yet.'
          : '还没有填写 SMTP 授权码。',
      }
    }
    const rendered = renderReportText({
      createdAt: report.createdAt,
      trigger: english
        ? report.trigger === 'error'
          ? 'error trigger'
          : report.trigger === 'schedule'
            ? 'scheduled'
            : 'manual'
        : report.trigger === 'error'
          ? '报错触发'
          : report.trigger === 'schedule'
            ? '定时触发'
            : '手动触发',
      model: report.model,
      summary: report.summary,
      findings: report.findings,
      english,
    })
    const result = await sendMail(config, {
      to,
      subject: rendered.subject,
      text: rendered.body,
      html: rendered.html,
    })
    return { sent: result.ok, to, ...(result.ok ? {} : { error: explainSmtpFailure(result.error ?? '', english) }) }
  }

  /** 已保存的 SMTP 配置；缺关键字段时返回 null。 */
  smtpConfig(): SmtpConfig | null {
    const settings = this.store.settings()
    const host = settings.reflectSmtpHost.trim()
    if (!host) return null
    // 只有一个邮箱字段：登录名与发件人都是它的第一个地址。多收件人时
    // 也只有第一个能用来登录（SMTP 只接受单个账号），其余只当收件人。
    const mailbox = parseRecipients(settings.reflectEmailTo)[0] ?? ''
    const password = this.store.getSmtpPassword() ?? ''
    return {
      host,
      port: settings.reflectSmtpPort,
      security: settings.reflectSmtpSecurity,
      user: mailbox,
      password,
      from: mailbox,
    }
  }

  /** 发一封测试邮件，让用户当场确认主机/端口/授权码可用。 */
  async sendTestMail(to: string): Promise<{ ok: boolean; error?: string }> {
    const recipient = to.trim() || this.store.settings().reflectEmailTo.trim()
    if (!recipient) {
      return {
        ok: false,
        error: this.english ? 'Enter the email address first.' : '请先填写邮箱地址。',
      }
    }
    const config = this.smtpConfig()
    if (!config) {
      return {
        ok: false,
        error: this.english ? 'SMTP host is required.' : '请先填写 SMTP 服务器。',
      }
    }
    if (config.user && !config.password) {
      return {
        ok: false,
        error: this.english
          ? 'Save the SMTP authorization code first.'
          : '请先填写并保存 SMTP 授权码。',
      }
    }
    const rendered = renderReportText({
      createdAt: new Date().toISOString(),
      trigger: this.english ? 'manual' : '手动触发',
      model: '',
      summary: this.english
        ? 'This is a test message from Pilot reflection settings.'
        : '这是 Pilot 反思设置里的测试邮件。',
      findings: [],
      english: this.english,
    })
    const result = await sendMail(config, {
      to: recipient,
      subject: this.english ? 'Pilot reflection test' : 'Pilot 反思测试',
      text: rendered.body,
      html: rendered.html,
    })
    return result.ok ? result : { ok: false, error: explainSmtpFailure(result.error ?? '', this.english) }
  }

  /** 后台触发失败时的唯一出口：一次通知，说明这次反思为什么没跑成。 */
  private notifyFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    this.notify(
      'error',
      this.english ? `Reflection did not finish: ${message}` : `反思没有完成：${message}`,
    )
  }

  private notify(level: 'info' | 'warn' | 'error', message: string, topic: NoticeTopic = 'reflect'): void {
    this.emit({ type: 'notice', level, message, topic })
  }
}
