// 反思（自问）：手机上读写同一份配置、手动触发一次自问、发测试邮件、清空报告。
// SMTP 授权码只写不读——回给手机的永远只有 hasPassword 布尔，密码本身不出主进程。
import {
  MAX_REFLECTION_FINDINGS,
  clampReflectionInterval,
  normalizeFindingStatus,
  normalizeReflectionScheduleMode,
  normalizeReflectionTime,
  normalizeReflectionTopics,
  normalizeReflectionTriggers,
  type ReflectionReport,
} from '../../../shared/reflect'
import type { ReflectionSmtpSecurity, SettingsUpdate } from '../../../shared/types'
import {
  NOTIFY_EVENTS,
  normalizeNotifyEmailEvents,
  type NotifyEventId,
} from '../../../shared/notify-events'
import { clampSmtpPort, normalizeSmtpSecurity } from '../../reflect/mail'
import type { ReflectService } from '../../reflect/service'
import type { Store } from '../../store'
import { asRecord, requireString } from '../helpers'
import type { AccessLevel } from '../access-level'
import type { CompanionServer } from '../server'
import type {
  CompanionOptions,
  PhoneReflectReport,
  PhoneReflectState,
  PhoneReflectSummary,
  StoredPhone,
} from '../types'

/** 手机只留最近这些份概要；详情用 reflect.report 单取，避免消息帧过大。 */
const PHONE_REFLECT_REPORT_LIMIT = 12
const PHONE_REFLECT_SUMMARY_CHARS = 200
const PHONE_REFLECT_FINDING_CHARS = 400
const PHONE_REFLECT_EVIDENCE_CHARS = 1_200

export async function handleReflectRequest(
  host: CompanionServer,
  method: string,
  params: Record<string, unknown>,
  _phone: StoredPhone,
  // 整个 reflect.* 已在 access-level.ts 列为本机专属（含 SMTP 凭据与模型开销）。
  _access: AccessLevel = 'paired',
): Promise<unknown> {
  switch (method) {
    case 'reflect.state':
      return host.requireReflect().state()
    case 'reflect.report': {
      const reportId = requireString(params['reportId'], '反思报告', 120)
      const report = host.options.store
        .reflectionReports()
        .find((entry) => entry.id === reportId)
      if (!report) throw new Error('反思报告不存在')
      return { report: phoneReflectReport(report) }
    }
    case 'reflect.settings': {
      const input = reflectSettingsInput(params['settings'])
      if (Object.keys(input).length === 0) throw new Error('没有需要保存的反思设置')
      const state = await host.requireReflect().update(input)
      // Keep an open desktop settings window in step with the phone.
      host.options.onEvent?.({
        type: 'settings.changed',
        settings: host.options.store.settingsView(),
      })
      return state
    }
    case 'reflect.now': {
      const service = host.requireReflect()
      const before = service.state()
      // 一次反思要调用模型，可能跑几十秒。请求立刻返回，完成后推 settings.changed
      // 让手机端刷新报告列表——挂住请求只会让手机端先超时、再收到一次也无从判断的状态。
      if (!before.running) {
        void service
          .run()
          .catch((error: unknown) => {
            host.notify({
              type: 'notice',
              level: 'error',
              message: error instanceof Error ? error.message : String(error),
            })
          })
          .finally(() => {
            host.notify({
              type: 'settings.changed',
              settings: host.options.store.settingsView(),
            })
          })
      }
      return { started: !before.running, state: before }
    }
    case 'reflect.mail.test': {
      const to = typeof params['to'] === 'string' ? params['to'].trim().slice(0, 320) : ''
      return host.requireReflect().testMail(to)
    }
    case 'reflect.reports.clear':
      return host.requireReflect().clearReports()
    case 'reflect.finding': {
      // 结论三态：手机看完成结论可以直接标「已处理 / 不打算做」，
      // 下一次反思就把这条当作已决策的信号，不再重复提。
      const reportId = requireString(params['reportId'], '反思报告', 120)
      const findingId = requireString(params['findingId'], '结论', 120)
      const status = normalizeFindingStatus(params['status'])
      return { report: await host.requireReflect().setFindingStatus(reportId, findingId, status) }
    }
    default:
      throw new Error(`手机端不支持该操作：${method}`)
  }
}

export function createReflectControls(
  store: Store,
  service: ReflectService,
): NonNullable<CompanionOptions['reflect']> {
  const state = (): PhoneReflectState => phoneReflectState(store, service.running)
  return {
    state,
    async update(input) {
      await store.updateSettings(input)
      return state()
    },
    run: () => service.run({ trigger: 'manual' }),
    testMail: (to) => service.sendTestMail(to),
    async clearReports() {
      await store.clearReflectionReports()
      return state()
    },
    async setFindingStatus(reportId, findingId, status) {
      const report = await store.setReflectionFindingStatus(reportId, findingId, status)
      if (!report) throw new Error('反思报告或结论不存在')
      return phoneReflectReport(report)
    },
  }
}

/** 手机侧视图：设置（密码只留布尔）+ 最近报告概要 + 是否正在反思。 */
export function phoneReflectState(store: Store, running: boolean): PhoneReflectState {
  const view = store.settingsView()
  const reports = store.reflectionReports()
  return {
    settings: {
      enabled: view.reflectEnabled,
      modelId: view.reflectModelId,
      triggers: { ...view.reflectTriggers },
      scheduleMode: view.reflectScheduleMode,
      intervalMinutes: view.reflectIntervalMinutes,
      dailyTime: view.reflectDailyTime,
      topics: [...view.reflectTopics],
      lastRunAt: view.reflectLastRunAt,
      lastVersion: view.reflectLastVersion,
      emailEnabled: view.reflectEmailEnabled,
      emailTo: view.reflectEmailTo,
      smtpHost: view.reflectSmtpHost,
      smtpPort: view.reflectSmtpPort,
      smtpSecurity: view.reflectSmtpSecurity,
      hasPassword: view.hasSmtpPassword,
      notifyEmailEnabled: view.notifyEmailEnabled,
      notifyEmailEvents: [...view.notifyEmailEvents],
      // 事件目录从电脑端下发：手机端不再自带一份常量，两边顺序与文案不会漂移。
      notifyCatalog: NOTIFY_EVENTS.map((entry) => ({ ...entry })),
    },
    running,
    reportTotal: reports.length,
    reports: reports.slice(0, PHONE_REFLECT_REPORT_LIMIT).map(phoneReflectSummary),
  }
}

function phoneReflectSummary(report: ReflectionReport): PhoneReflectSummary {
  const severity = { high: 0, medium: 0, low: 0 }
  for (const finding of report.findings) severity[finding.severity] += 1
  return {
    id: report.id,
    createdAt: report.createdAt,
    trigger: report.trigger,
    model: report.model,
    topics: [...report.topics],
    summary: clip(report.summary, PHONE_REFLECT_SUMMARY_CHARS),
    findings: report.findings.length,
    severity,
    email: report.email ? { ...report.email } : null,
  }
}

/** 单份报告详情：保留发现与依据，但按手机屏幕的长度截断。 */
function phoneReflectReport(report: ReflectionReport): PhoneReflectReport {
  return {
    id: report.id,
    createdAt: report.createdAt,
    trigger: report.trigger,
    model: report.model,
    topics: [...report.topics],
    // 证据不足而没问的域：不带下去，手机端只能列了问题域却不知为何没结果。
    // 旧报告可能没有这个字段，缺省当空数组。
    skipped: (Array.isArray(report.skipped) ? report.skipped : []).map((entry) => ({
      topic: entry.topic,
      missing: [...entry.missing],
    })),
    summary: report.summary,
    findings: report.findings.slice(0, MAX_REFLECTION_FINDINGS).map((finding) => ({
      id: finding.id,
      topic: finding.topic,
      severity: finding.severity,
      observation: clip(finding.observation, PHONE_REFLECT_FINDING_CHARS),
      suggestion: clip(finding.suggestion, PHONE_REFLECT_FINDING_CHARS),
      // 代码位置与处理状态跟着下发：手机端也要能核对结论指向哪一行。
      ...(finding.refs && finding.refs.length > 0
        ? { refs: finding.refs.map((ref) => ({ ...ref })) }
        : {}),
      ...(finding.status ? { status: finding.status } : {}),
    })),
    evidence: clip(report.evidence, PHONE_REFLECT_EVIDENCE_CHARS),
    durationMs: report.durationMs,
    email: report.email ? { ...report.email } : null,
  }
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/**
 * 手机提交的反思设置。字段名与 `SettingsUpdate` 一致（去掉 reflect 前缀会让协议
 * 和桌面代码各说一套），空字符串保留原密码、null 清除，与桌面设置弹框同义。
 */
function reflectSettingsInput(value: unknown): SettingsUpdate {
  const record = asRecord(value)
  const input: SettingsUpdate = {}
  if (typeof record['enabled'] === 'boolean') input.reflectEnabled = record['enabled']
  if (record['modelId'] !== undefined) {
    input.reflectModelId =
      typeof record['modelId'] === 'string' ? record['modelId'].trim().slice(0, 120) : ''
  }
  if (record['triggers'] !== undefined) {
    input.reflectTriggers = normalizeReflectionTriggers(record['triggers'])
  }
  if (record['scheduleMode'] !== undefined) {
    input.reflectScheduleMode = normalizeReflectionScheduleMode(record['scheduleMode'])
  }
  if (record['intervalMinutes'] !== undefined) {
    input.reflectIntervalMinutes = clampReflectionInterval(record['intervalMinutes'])
  }
  if (record['dailyTime'] !== undefined) {
    input.reflectDailyTime = normalizeReflectionTime(record['dailyTime'])
  }
  if (record['topics'] !== undefined) {
    if (!Array.isArray(record['topics'])) throw new Error('反思问题域格式不正确')
    input.reflectTopics = normalizeReflectionTopics(record['topics'])
  }
  if (typeof record['emailEnabled'] === 'boolean') {
    input.reflectEmailEnabled = record['emailEnabled']
  }
  // 通知总开关与事件表：手机端与桌面写的是同一套字段，事件 id 会在 settings-update
  // 里再按目录归一化，这里只做最基础的类型检查。
  if (typeof record['notifyEmailEnabled'] === 'boolean') {
    input.notifyEmailEnabled = record['notifyEmailEnabled']
  }
  if (record['notifyEmailEvents'] !== undefined) {
    if (!Array.isArray(record['notifyEmailEvents'])) throw new Error('通知项格式不正确')
    input.notifyEmailEvents = normalizeNotifyEmailEvents(
      record['notifyEmailEvents'],
    ) as NotifyEventId[]
  }
  // 空字符串 = 保持原值（旧手机端把没同步好的空表单原样提交，那不是用户要清空），
  // null = 清除；与授权码同一套语义。
  if (record['emailTo'] === null) input.reflectEmailTo = null
  else assignText(record, input, 'emailTo', 'reflectEmailTo', 320)
  // 只剩一个邮箱字段。旧版手机端还会提交 smtpUser / emailFrom，只当同一个字段的
  // 兑底值（emailTo 为空或未传时才有意义），否则旧端一次保存会把邮箱清成空。
  if (input.reflectEmailTo === undefined || input.reflectEmailTo === '') {
    assignText(record, input, 'smtpUser', 'reflectEmailTo', 320)
    if (input.reflectEmailTo === undefined || input.reflectEmailTo === '') {
      assignText(record, input, 'emailFrom', 'reflectEmailTo', 320)
    }
  }
  if (record['smtpHost'] === null) input.reflectSmtpHost = null
  else assignText(record, input, 'smtpHost', 'reflectSmtpHost', 253)
  if (record['smtpPort'] !== undefined) {
    input.reflectSmtpPort = clampSmtpPort(record['smtpPort'])
  }
  if (record['smtpSecurity'] !== undefined) {
    input.reflectSmtpSecurity = normalizeSmtpSecurity(
      record['smtpSecurity'],
    ) as ReflectionSmtpSecurity
  }
  if (record['smtpPassword'] !== undefined) {
    if (record['smtpPassword'] === null) {
      input.reflectSmtpPassword = null
    } else if (typeof record['smtpPassword'] === 'string') {
      const password = record['smtpPassword'].trim()
      // 空串表示「不要改动已保存的授权码」；只传空就清掉会把用户已有的凭据静默删掉。
      if (password) input.reflectSmtpPassword = password.slice(0, 400)
    }
  }
  return input
}

function assignText(
  record: Record<string, unknown>,
  input: SettingsUpdate,
  from: string,
  to: keyof SettingsUpdate,
  max: number,
): void {
  if (record[from] === undefined) return
  const value = typeof record[from] === 'string' ? (record[from] as string).trim().slice(0, max) : ''
  ;(input as Record<string, unknown>)[to] = value
}
