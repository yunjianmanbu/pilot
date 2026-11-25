import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REFLECTION_TOPICS,
  MAX_REFLECTION_FINDINGS,
  REFLECTION_INTERVAL_DEFAULT_MINUTES,
  REFLECTION_INTERVAL_MAX_MINUTES,
  REFLECTION_INTERVAL_MIN_MINUTES,
  REFLECTION_TOPICS,
  clampReflectionInterval,
  dailySlot,
  normalizeReflectionScheduleMode,
  normalizeReflectionTime,
  normalizeReflectionTopics,
  normalizeReflectionTriggers,
  reflectionScheduleDue,
  reflectionTopicLabel,
  reflectionTriggerLabel,
  sanitizeReflectionFinding,
  sanitizeReflectionReport,
  type ReflectionReport,
} from '../src/shared/reflect'
import { parseReflectionOutput, renderReportText } from '../src/main/reflect/prompt'
import { addressOf, clampSmtpPort, normalizeSmtpSecurity, parseRecipients } from '../src/main/reflect/mail'

/** 本地时间构造，避免用例受时区影响。 */
function local(y: number, m: number, d: number, h = 0, min = 0): Date {
  return new Date(y, m - 1, d, h, min, 0, 0)
}

describe('reflection topic catalog', () => {
  it('covers the eight default domains in a stable order', () => {
    expect(REFLECTION_TOPICS).toHaveLength(8)
    expect(DEFAULT_REFLECTION_TOPICS).toEqual(REFLECTION_TOPICS.map((topic) => topic.id))
    expect(DEFAULT_REFLECTION_TOPICS[0]).toBe('compaction-drift')
    expect(DEFAULT_REFLECTION_TOPICS).toContain('interaction-experience')
  })

  it('labels topics and triggers in both languages', () => {
    expect(reflectionTopicLabel('storage-performance', false)).toBe(
      REFLECTION_TOPICS[1]!.zh,
    )
    expect(reflectionTopicLabel('storage-performance', true)).toBe(
      REFLECTION_TOPICS[1]!.en,
    )
    expect(reflectionTriggerLabel('schedule', false)).toBe('定时触发')
    expect(reflectionTriggerLabel('error', true)).toBe('error trigger')
    expect(reflectionTriggerLabel('manual', false)).toBe('手动触发')
  })
})

describe('reflection settings normalization', () => {
  it('drops unknown topics, de-duplicates and keeps catalog order', () => {
    expect(
      normalizeReflectionTopics(['interaction-experience', 'nope', 'code-quality', 'code-quality']),
    ).toEqual(['code-quality', 'interaction-experience'])
  })

  it('falls back to every topic when the value is not a list', () => {
    expect(normalizeReflectionTopics(undefined)).toEqual(DEFAULT_REFLECTION_TOPICS)
    expect(normalizeReflectionTopics('code-quality')).toEqual(DEFAULT_REFLECTION_TOPICS)
    // 空数组是合法输入：用户取消全部勾选由界面拦下，这里保持原样。
    expect(normalizeReflectionTopics([])).toEqual([])
  })

  it('defaults both triggers on and honours an explicit false', () => {
    expect(normalizeReflectionTriggers(undefined)).toEqual({ onError: true, onSchedule: true })
    expect(normalizeReflectionTriggers({ onError: false })).toEqual({
      onError: false,
      onSchedule: true,
    })
    expect(normalizeReflectionTriggers({ onSchedule: false, onError: false })).toEqual({
      onError: false,
      onSchedule: false,
    })
  })

  it('normalizes schedule mode and daily time', () => {
    expect(normalizeReflectionScheduleMode('interval')).toBe('interval')
    expect(normalizeReflectionScheduleMode('version')).toBe('version')
    // 认不出来的值（含旧客户端可能发的旧默认 'weekly'）落到当前默认：按版本。
    expect(normalizeReflectionScheduleMode('weekly')).toBe('version')
    expect(normalizeReflectionTime(' 07:05 ')).toBe('07:05')
    expect(normalizeReflectionTime('24:00')).toBe('09:00')
    expect(normalizeReflectionTime(7)).toBe('09:00')
  })

  it('clamps the interval into the supported window', () => {
    expect(clampReflectionInterval(5)).toBe(REFLECTION_INTERVAL_MIN_MINUTES)
    expect(clampReflectionInterval(10_000_000)).toBe(REFLECTION_INTERVAL_MAX_MINUTES)
    expect(clampReflectionInterval(180)).toBe(180)
    expect(clampReflectionInterval('180')).toBe(REFLECTION_INTERVAL_DEFAULT_MINUTES)
  })
})

describe('scheduled trigger', () => {
  it('fires interval mode once when no anchor exists yet', () => {
    // 刚启用间隔模式时没有任何锦点：必须能跑第一次，否则永远不会触发。
    expect(
      reflectionScheduleDue(
        {
          mode: 'interval',
          intervalMinutes: 60,
          dailyTime: '09:00',
          lastRunAt: null,
        },
        local(2026, 5, 1, 12),
      ),
    ).toBe(true)
  })

  it('fires interval mode once the window has elapsed', () => {
    const lastRunAt = local(2026, 5, 1, 10).toISOString()
    const base = {
      mode: 'interval' as const,
      intervalMinutes: 60,
      dailyTime: '09:00',
      lastRunAt,
    }
    expect(reflectionScheduleDue(base, local(2026, 5, 1, 10, 59))).toBe(false)
    expect(reflectionScheduleDue(base, local(2026, 5, 1, 11, 1))).toBe(true)
  })

  it('fires daily mode when the slot has passed and was not handled yet', () => {
    const lastRunAt = local(2026, 5, 1, 9, 0).toISOString()
    const base = {
      mode: 'daily' as const,
      intervalMinutes: 60,
      dailyTime: '09:00',
      lastRunAt,
    }
    // 当天槽位早于上次运行 → 今天已经跑过。
    expect(reflectionScheduleDue(base, local(2026, 5, 1, 18))).toBe(false)
    // 第二天的槽位未到。
    expect(reflectionScheduleDue(base, local(2026, 5, 2, 8, 59))).toBe(false)
    // 第二天的槽位已到。
    expect(reflectionScheduleDue(base, local(2026, 5, 2, 9, 1))).toBe(true)
  })

  it('does not re-fire the same daily slot after it was scheduled once', () => {
    const scheduled = local(2026, 5, 2, 9, 0).toISOString()
    expect(
      reflectionScheduleDue(
        {
          mode: 'daily',
          intervalMinutes: 60,
          dailyTime: '09:00',
          lastRunAt: local(2026, 5, 1, 9).toISOString(),
          lastScheduledAt: scheduled,
        },
        local(2026, 5, 2, 9, 30),
      ),
    ).toBe(false)
  })

  it('computes the slot in local time and rejects bad input', () => {
    expect(dailySlot('09:30', local(2026, 5, 1, 18))).toBe(local(2026, 5, 1, 9, 30).getTime())
    expect(dailySlot('bad', local(2026, 5, 1, 18))).toBe(local(2026, 5, 1, 9, 0).getTime())
  })
})

describe('version trigger', () => {
  const base = {
    mode: 'version' as const,
    intervalMinutes: 720,
    dailyTime: '09:00',
    lastRunAt: null,
    currentVersion: '1.2.4',
  }

  it('treats the first run as building the baseline', () => {
    // 旧存档没有版本基线：必须马上跑一次把它落盘，否则永远等不到首次自问。
    expect(reflectionScheduleDue(base, local(2026, 5, 1, 12))).toBe(true)
  })

  it('fires once the app version differs from the last reflected version', () => {
    const anchored = {
      ...base,
      lastRunAt: local(2026, 5, 1, 10).toISOString(),
      lastVersion: '1.2.3',
    }
    // 同一版本、刚跑过：不重复触发。
    expect(
      reflectionScheduleDue({ ...anchored, lastVersion: '1.2.4' }, local(2026, 5, 1, 10, 30)),
    ).toBe(false)
    // 升级到 1.2.4：立刻反思这一版。
    expect(reflectionScheduleDue(anchored, local(2026, 5, 1, 10, 30))).toBe(true)
  })

  it('waits one retry window before firing again after a failed run', () => {
    const changed = {
      ...base,
      lastRunAt: local(2026, 5, 1, 10).toISOString(),
      lastVersion: '1.2.3',
    }
    // 版本变了但 10 分钟内刚试过一次（失败）：不追着每分钟重试。
    expect(reflectionScheduleDue(changed, local(2026, 5, 1, 10, 5))).toBe(false)
    expect(reflectionScheduleDue(changed, local(2026, 5, 1, 10, 11))).toBe(true)
  })

  it('falls back to a weekly self-check when the version never changes', () => {
    const same = { ...base, lastVersion: '1.2.4' }
    const lastRunAt = local(2026, 5, 1, 10).toISOString()
    // 6 天 23 小时：不到兜底静默期。
    expect(reflectionScheduleDue({ ...same, lastRunAt }, local(2026, 5, 8, 9, 59))).toBe(false)
    // 满 7 天：不升级的用户也要自省一次。
    expect(reflectionScheduleDue({ ...same, lastRunAt }, local(2026, 5, 8, 10, 1))).toBe(true)
  })

  it('does not fire when the host could not report a version', () => {
    // 版本拿不到时不能退化成「每 10 分钟反思一次」，只保留 7 天的兜底自省。
    const anchored = { ...base, currentVersion: '', lastVersion: '1.2.3' }
    const lastRunAt = local(2026, 5, 1, 10).toISOString()
    expect(reflectionScheduleDue({ ...anchored, lastRunAt }, local(2026, 5, 1, 10, 11))).toBe(false)
    expect(reflectionScheduleDue({ ...anchored, lastRunAt }, local(2026, 5, 2, 10))).toBe(false)
    expect(reflectionScheduleDue({ ...anchored, lastRunAt }, local(2026, 5, 8, 10, 1))).toBe(true)
  })
})

describe('reflection report sanitizing', () => {
  it('rejects findings without a known topic or usable text', () => {
    expect(sanitizeReflectionFinding({ topic: 'nope', observation: 'x', suggestion: 'y' })).toBe(
      null,
    )
    expect(
      sanitizeReflectionFinding({ topic: 'code-quality', observation: '  ', suggestion: 'y' }),
    ).toBe(null)
    expect(
      sanitizeReflectionFinding({
        topic: 'code-quality',
        severity: 'weird',
        observation: '  many retries ',
        suggestion: ' raise maxSteps ',
      }),
    ).toEqual({
      id: '',
      topic: 'code-quality',
      severity: 'medium',
      observation: 'many retries',
      suggestion: 'raise maxSteps',
    })
  })

  it('保留代码位置与处理状态，绝对路径与自然语言引用被丢掉', () => {
    const finding = sanitizeReflectionFinding({
      id: 'f1',
      topic: 'code-quality',
      observation: 'service.ts 里的超时没有清掉',
      suggestion: '把 clearTimeout 放进 finally',
      refs: ['src/main/reflect/service.ts:202', { path: 'src/main/x.ts' }, '/abs/path.ts', 'C:/tmp/a.ts', 'service.ts 第 118 行'],
      status: 'done',
    })
    expect(finding?.refs).toEqual([
      { path: 'src/main/reflect/service.ts', line: 202 },
      { path: 'src/main/x.ts' },
    ])
    expect(finding?.status).toBe('done')
  })

  it('caps stored findings and keeps a valid report', () => {
    const findings = Array.from({ length: MAX_REFLECTION_FINDINGS + 4 }, () => ({
      topic: 'code-quality',
      severity: 'high',
      observation: 'obs',
      suggestion: 'fix',
    }))
    const report = sanitizeReflectionReport({
      id: 'r1',
      createdAt: local(2026, 5, 1, 9).toISOString(),
      trigger: 'schedule',
      model: 'deepseek-chat',
      topics: ['code-quality', 'nope'],
      summary: '  compacted twice  ',
      findings,
      evidence: 'runs: 3',
      durationMs: 1234.6,
      email: { sent: false, to: 'a@b.c', error: 'auth failed' },
    })
    expect(report).not.toBeNull()
    expect(report!.summary).toBe('compacted twice')
    expect(report!.topics).toEqual(['code-quality'])
    expect(report!.findings).toHaveLength(MAX_REFLECTION_FINDINGS)
    expect(report!.durationMs).toBe(1235)
    expect(report!.email).toEqual({ sent: false, to: 'a@b.c', error: 'auth failed' })
  })

  it('rejects reports without id or a parseable timestamp', () => {
    expect(sanitizeReflectionReport(null)).toBe(null)
    expect(sanitizeReflectionReport({ id: '', createdAt: 'now' })).toBe(null)
    expect(sanitizeReflectionReport({ id: 'r2', createdAt: 'not-a-date' })).toBe(null)
  })

  it('defaults unknown triggers to manual', () => {
    const report = sanitizeReflectionReport({
      id: 'r3',
      createdAt: local(2026, 5, 1, 9).toISOString(),
      trigger: 'mystery',
    }) as ReflectionReport
    expect(report.trigger).toBe('manual')
    expect(report.findings).toEqual([])
    expect(report.email).toBe(null)
  })
})

describe('reflection output parsing', () => {
  it('reads summary and findings out of a JSON reply, including fences', () => {
    const parsed = parseReflectionOutput(
      '```json\n{"summary":"storage is fine","findings":[{"topic":"storage-performance","severity":"low","observation":"db 12MB","suggestion":"vacuum"}]}\n```',
    )
    expect(parsed.summary).toBe('storage is fine')
    expect(parsed.findings).toHaveLength(1)
    expect(parsed.findings[0]!.topic).toBe('storage-performance')
  })

  it('accepts the items alias and drops invalid entries', () => {
    const parsed = parseReflectionOutput(
      JSON.stringify({
        summary: 'ok',
        items: [
          { topic: 'unknown', observation: 'a', suggestion: 'b' },
          { topic: 'output-quality', observation: 'verbose', suggestion: 'trim' },
        ],
      }),
    )
    expect(parsed.findings).toHaveLength(1)
    expect(parsed.findings[0]!.topic).toBe('output-quality')
  })

  it('falls back to the raw text when the reply is not JSON', () => {
    expect(parseReflectionOutput('  plain text answer  ')).toEqual({
      summary: 'plain text answer',
      findings: [],
    })
    expect(parseReflectionOutput('')).toEqual({ summary: '', findings: [] })
  })
})

describe('reflection mail rendering', () => {
  it('renders a Chinese report with severity and topic labels', () => {
    const rendered = renderReportText({
      createdAt: '2026-05-01T09:00:00.000Z',
      trigger: '定时触发',
      model: 'deepseek-chat',
      summary: '整体健康',
      findings: [
        {
          id: 'f1',
          topic: 'execution-efficiency',
          severity: 'high',
          observation: '平均 41 步',
          suggestion: '收紧读文件范围',
          refs: [{ path: 'src/main/reflect/service.ts', line: 189 }],
        },
      ],
      english: false,
    })
    expect(rendered.subject).toContain('Pilot 反思')
    expect(rendered.subject).toContain('1 条')
    expect(rendered.body).toContain('整体健康')
    expect(rendered.body).toContain('[高]')
    expect(rendered.body).toContain('收紧读文件范围')
    // 结论要能回溯到具体一行：没有代码位置的反思报告没法核对。
    expect(rendered.body).toContain('代码位置')
    expect(rendered.body).toContain('src/main/reflect/service.ts:189')
  })

  it('renders an English report and marks an empty round', () => {
    const rendered = renderReportText({
      createdAt: '2026-05-01T09:00:00.000Z',
      trigger: 'scheduled',
      model: '',
      summary: '',
      findings: [],
      english: true,
    })
    expect(rendered.subject).toContain('0 findings')
    expect(rendered.body).toContain('No actionable finding this round.')
    expect(rendered.body).not.toContain('Model')
  })
})

describe('smtp helpers', () => {
  it('clamps ports and security modes', () => {
    expect(clampSmtpPort(465)).toBe(465)
    expect(clampSmtpPort(0)).toBe(587)
    expect(clampSmtpPort(70_000)).toBe(587)
    expect(clampSmtpPort('587')).toBe(587)
    expect(normalizeSmtpSecurity('tls')).toBe('tls')
    expect(normalizeSmtpSecurity('none')).toBe('none')
    expect(normalizeSmtpSecurity('ssl')).toBe('starttls')
  })

  it('extracts the address out of a display name', () => {
    expect(addressOf('Pilot <pilot@example.com>')).toBe('pilot@example.com')
    expect(addressOf('pilot@example.com')).toBe('pilot@example.com')
  })

  it('splits a comma separated recipient list and drops blanks', () => {
    expect(parseRecipients('ops@example.com')).toEqual(['ops@example.com'])
    expect(parseRecipients(' a@b.com , Pilot <c@d.org>;, ,a@b.com ')).toEqual([
      'a@b.com',
      'c@d.org',
    ])
    expect(parseRecipients('')).toEqual([])
    expect(parseRecipients('  ,  ')).toEqual([])
  })
})
