/**
 * 邮件通知分发：总开关、单事件开关、去重与限频。
 *
 * 守四件事：
 * 1) 总开关关着就一个字节都不发，也不排队；
 * 2) 只发「已勾选」的事件，「没勾」不等于「默认发」；
 * 3) 同一 runId / requestId 只发一封，同类事件有最小间隔；
 * 4) 一分钟内超过上限的邮件直接丢弃并记日志，不会把邮箱刷爆。
 */
import { describe, expect, it } from 'vitest'
import type { RunEvent } from '../src/shared/types'
import type { MailResult, OutgoingMail, SmtpConfig } from '../src/main/reflect/mail'
import {
  MAIL_NOTIFY_PER_MINUTE,
  MAIL_NOTIFY_SAME_EVENT_MS,
  MailNotifier,
  type NotifyMailSettings,
} from '../src/main/notify/mail-notify'
import type { NotifyEventId } from '../src/shared/notify-events'

const CONFIG: SmtpConfig = {
  host: 'smtp.example.com',
  port: 465,
  security: 'tls',
  user: 'me@example.com',
  password: 'secret',
  from: 'me@example.com',
}

function settingsOf(overrides: Partial<NotifyMailSettings> = {}): NotifyMailSettings {
  return {
    notifyEmailEnabled: true,
    notifyEmailEvents: ['run.failed', 'run.completed', 'approval.required'],
    reflectEmailTo: 'me@example.com',
    ...overrides,
  }
}

/** 每次 send 都记下来，测试结束按顺序断言寄出了哪几封。 */
function harness(
  settings: NotifyMailSettings = settingsOf(),
  now = () => 1_000_000,
  instruction: () => string = () => '把侧栏底部的模型连接标志删掉',
) {
  const sent: OutgoingMail[] = []
  const logs: Array<{ area: string; event: string; reason?: string }> = []
  let clock = now()
  const notifier = new MailNotifier({
    settings: () => settings,
    smtp: () => CONFIG,
    hasPassword: () => true,
    sessionTitle: () => '构建任务',
    instruction,
    english: () => false,
    send: async (_config: SmtpConfig, mail: OutgoingMail): Promise<MailResult> => {
      sent.push(mail)
      return { ok: true }
    },
    now: () => clock,
    log: (entry) => {
      const reason = entry.detail?.['reason']
      logs.push({
        area: entry.area,
        event: entry.event,
        ...(typeof reason === 'string' ? { reason } : {}),
      })
    },
  })
  return {
    notifier,
    sent,
    logs,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

function failed(runId: string): RunEvent {
  return {
    type: 'run.failed',
    sessionId: 'session-1',
    runId,
    code: 'model-denied',
    message: '模型拒绝了这次请求',
  }
}

function completed(runId: string): RunEvent {
  return {
    type: 'run.completed',
    sessionId: 'session-1',
    runId,
    status: 'completed',
    steps: 7,
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    durationMs: 4_000,
  } as RunEvent
}

/** 队列是异步 drain 的，让出几轮事件循环再断言。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('MailNotifier', () => {
  it('sends nothing while the master switch is off', async () => {
    const { notifier, sent } = harness(settingsOf({ notifyEmailEnabled: false }))
    notifier.handle(failed('run-1'))
    await settle()
    expect(sent).toHaveLength(0)
    expect(notifier.pending()).toBe(0)
  })

  it('sends nothing for an event that is not selected', async () => {
    const { notifier, sent } = harness(settingsOf({ notifyEmailEvents: ['run.completed'] }))
    notifier.handle(failed('run-1'))
    await settle()
    expect(sent).toHaveLength(0)
  })

  it('puts the user instruction, not the session title, in the subject', async () => {
    const { notifier, sent } = harness(settingsOf({ notifyEmailEvents: ['run.failed'] }))
    notifier.handle(failed('run-1'))
    await settle()
    expect(sent).toHaveLength(1)
    expect(sent[0]?.to).toBe('me@example.com')
    expect(sent[0]?.subject).toContain('把侧栏底部的模型连接标志删掉')
    expect(sent[0]?.subject).not.toContain('构建任务')
    // 会话名退到正文，仍能定位是哪条会话。
    expect(sent[0]?.text).toContain('构建任务')
    expect(sent[0]?.text).toContain('模型拒绝了这次请求')
    expect(sent[0]?.html).toContain('<!doctype html>')
    expect(sent[0]?.html).toContain('把侧栏底部的模型连接标志删掉')
  })

  it('falls back to the session title when no instruction is available', async () => {
    const { notifier, sent } = harness(
      settingsOf({ notifyEmailEvents: ['run.failed'] }),
      () => 1_000_000,
      () => '',
    )
    notifier.handle(failed('run-1'))
    await settle()
    expect(sent[0]?.subject).toContain('构建任务')
  })

  it('deduplicates the same run and rate-limits the same event kind', async () => {
    const { notifier, sent, advance } = harness(settingsOf({ notifyEmailEvents: ['run.failed'] }))
    notifier.handle(failed('run-1'))
    await settle()
    // 同一次运行重放同一个事件：不重复发。
    notifier.handle(failed('run-1'))
    await settle()
    expect(sent).toHaveLength(1)

    // 另一条运行但离上一封太近：同类事件最小间隔还没到。
    advance(MAIL_NOTIFY_SAME_EVENT_MS - 1)
    notifier.handle(failed('run-2'))
    await settle()
    expect(sent).toHaveLength(1)

    advance(2)
    notifier.handle(failed('run-3'))
    await settle()
    expect(sent).toHaveLength(2)
  })

  it('drops mail beyond the per-minute cap and logs it', async () => {
    // 限频是「一分钟内最多 N 封」，所以要用不同事件在同一时刻排队才能触发；
    // 同类事件另有 20 秒的最小间隔，混在一起测不清楚。
    const all: NotifyEventId[] = [
      'run.failed',
      'run.completed',
      'approval.required',
      'companion.pair_request',
      'schedule.started',
      'module-check.completed',
      'supervisor.applied',
      'reflect.report',
      'quality.better',
    ]
    const { notifier, sent, logs } = harness(settingsOf({ notifyEmailEvents: all }))
    const batch: RunEvent[] = [
      failed('run-1'),
      completed('run-2'),
      { type: 'tool.approval_required', sessionId: 'session-1', runId: 'run-3', call: { id: 'call-1', name: 'run_command', arguments: {} }, risk: 'exec' } as RunEvent,
      { type: 'companion.pair_request', request: { requestId: 'pair-1', name: 'Pixel', platform: 'android', via: 'relay', address: '10.0.0.2' } } as RunEvent,
      { type: 'notice', level: 'info', message: '定时任务已开始', topic: 'schedule' } as RunEvent,
      { type: 'notice', level: 'info', message: '自检完成', topic: 'module-check' } as RunEvent,
      { type: 'notice', level: 'info', message: '自改进已应用', topic: 'supervisor' } as RunEvent,
      { type: 'notice', level: 'info', message: '反思完成', topic: 'reflect', notifyEvent: 'reflect.report' } as RunEvent,
      { type: 'quality.changed', workspacePath: 'ws', bell: true, message: '发现更优版本' } as RunEvent,
    ]
    for (const event of batch) notifier.handle(event)
    await settle()
    expect(sent.length).toBe(MAIL_NOTIFY_PER_MINUTE)
    expect(logs.filter((entry) => entry.event === 'rate.limited')).toHaveLength(
      batch.length - MAIL_NOTIFY_PER_MINUTE,
    )
  })

  it('stays silent when the mailbox is incomplete, and says which field is missing', async () => {
    for (const settings of [settingsOf({ reflectEmailTo: '' }), settingsOf({ reflectEmailTo: ' , ' })]) {
      const { notifier, sent, logs } = harness(settings)
      notifier.handle(failed('run-1'))
      await settle()
      expect(sent).toHaveLength(0)
      // 静默跳过是那次「没收到邮件却查不到原因」的直接原因：now 至少留下一行。
      expect(logs.filter((entry) => entry.event === 'skipped')).toHaveLength(1)
    }
  })

  it('names the missing piece once, then clears the memory after a successful send', async () => {
    // 只留「地址」这一项缺失，smtp 与授权码固定为可用。
    const sent: OutgoingMail[] = []
    const reasons: string[] = []
    let to = ''
    let clock = 1_000_000
    const notifier = new MailNotifier({
      settings: () => settingsOf({ reflectEmailTo: to }),
      smtp: () => CONFIG,
      hasPassword: () => true,
      sessionTitle: () => '',
      english: () => false,
      send: async (_config: SmtpConfig, mail: OutgoingMail): Promise<MailResult> => {
        sent.push(mail)
        return { ok: true }
      },
      now: () => clock,
      log: (entry) => {
        const reason = entry.detail?.['reason']
        if (entry.event === 'skipped' && typeof reason === 'string') reasons.push(reason)
      },
    })
    notifier.handle(failed('run-1'))
    clock += 30_000
    notifier.handle(completed('run-2'))
    await settle()
    // 同一缺失项只报一次，别把每一封信的跳过都写进 app 日志。
    expect(reasons).toEqual(['no-recipient'])
    expect(sent).toHaveLength(0)
    // 补上地址后能发出信，报警记忆被清掉，下次再缺会重新报。
    to = 'me@example.com'
    clock += 30_000
    notifier.handle(completed('run-3'))
    await settle()
    expect(sent).toHaveLength(1)
    to = ''
    clock += 30_000
    notifier.handle(completed('run-4'))
    await settle()
    expect(reasons).toEqual(['no-recipient', 'no-recipient'])
  })

  it('reports a missing SMTP host or password instead of staying silent', async () => {
    const reasons: string[] = []
    const notifier = new MailNotifier({
      settings: () => settingsOf(),
      smtp: () => null,
      hasPassword: () => false,
      sessionTitle: () => '',
      english: () => false,
      send: async () => ({ ok: true }),
      now: () => 1_000_000,
      log: (entry) => {
        const reason = entry.detail?.['reason']
        if (entry.event === 'skipped' && typeof reason === 'string') reasons.push(reason)
      },
    })
    notifier.handle(failed('run-1'))
    await settle()
    expect(reasons).toEqual(['no-smtp-host'])
  })
})
