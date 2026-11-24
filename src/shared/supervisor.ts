/**
 * 自主优化闭环（supervisor）的纯逻辑层：信号分析、评分、护栏选点、指令文本。
 *
 * 设计前提（与 module-check / evolution 的分工）：
 * - `module-check` 回答「源码里有什么结构性问题」，只读、只出清单；
 * - `evolution` 回答「策略提示词该不该换一版」，需要评测样本；
 * - 这里回答「现在最该修的是哪一件事，以及能不能在护栏内自己开一轮会话去修」。
 *
 * 因此本模块不做任何 IO：主进程把运行记录、内视结果、自检风险喂进来，
 * 得到「信号 + 问题清单 + 该不该动手 + 该发什么指令」。所有判断都是确定性的，
 * 同一份输入永远得到同一份输出，便于测试与复盘。
 *
 * 三条硬边界（用户可关，但不能被自动打开）：
 * 1. `enabled` 与 `apply` 都必须是用户显式打开；默认全关。
 * 2. 每 24h 的自动会话数、指令字符数都有上限，用完后只出清单不动手。
 * 3. `manual` 的问题、以及 24h 内已经动过一次的同一问题，永远不进自动队列。
 */
import type { SelfCheckStatus } from './self-check'

export const SUPERVISOR_HISTORY_LIMIT = 20
export const SUPERVISOR_MIN_INTERVAL_MINUTES = 15
export const SUPERVISOR_MAX_INTERVAL_MINUTES = 24 * 60
/** 自动应用的时间窗口：预算与冷却都按它滚动计算。 */
export const SUPERVISOR_WINDOW_MS = 24 * 60 * 60 * 1000
/** 单条自动会话最多带多少字符的指令（预算口径）。 */
export const SUPERVISOR_MAX_PROMPT_CHARS = 6000
/**
 * 反思结论的保鲜期。反思是按天甚至更久才跑一次的，用 24h 窗口会把它的信号
 * 在下一份报告生成前就丢掉；3 天既覆盖「隔天看一次」的节奏，又不至于拿一周前的
 * 结论去改今天的代码。
 */
export const SUPERVISOR_REFLECTION_WINDOW_MS = 3 * 24 * 60 * 60 * 1000
/** 一条反思发现最多带几条观察、多长文本，避免把报告全文塞进自动会话指令。 */
export const SUPERVISOR_REFLECTION_MAX_OBSERVATIONS = 3

export type SupervisorSeverity = 'low' | 'medium' | 'high'

export type SupervisorFindingSource = 'runs' | 'health' | 'module' | 'reflect'

export interface SupervisorFinding {
  /** 稳定 id：`<来源>.<规则>`，用于冷却与去重。 */
  id: string
  source: SupervisorFindingSource
  severity: SupervisorSeverity
  title: string
  detail: string
  suggestion: string
  /** 证据位置或统计口径；不含被扫描文件的内容。 */
  evidence: string[]
  /** 不能自动修改（密钥、依赖、需要人判断的取舍）。 */
  manual: boolean
}

export interface SupervisorSignal {
  id: string
  label: string
  value: string
  level: 'ok' | 'warn' | 'alert'
}

export interface SupervisorBudget {
  /** 24h 内最多自动开几个会话。 */
  sessionsPerDay: number
  /** 24h 内自动会话累计指令字符上限。 */
  charsPerDay: number
}

export interface SupervisorSettings {
  /** 总开关：关闭时定时器不跑，手动也可以跑（只出清单）。 */
  enabled: boolean
  intervalMinutes: number
  /** 是否允许在护栏内自动创建会话去修；默认关闭。 */
  apply: boolean
  budget: SupervisorBudget
}

export const DEFAULT_SUPERVISOR_SETTINGS: SupervisorSettings = {
  enabled: false,
  intervalMinutes: 180,
  apply: false,
  budget: { sessionsPerDay: 2, charsPerDay: 24000 },
}

/** 一次自动动作的记账。 */
export interface SupervisorAction {
  at: string
  findingId: string
  title: string
  status: 'applied' | 'skipped' | 'error'
  sessionId?: string
  /** skipped / error 的原因，直接给人看。 */
  reason?: string
  chars?: number
}

export interface SupervisorRound {
  id: string
  trigger: 'manual' | 'schedule'
  startedAt: string
  finishedAt: string
  signals: SupervisorSignal[]
  findings: SupervisorFinding[]
  actions: SupervisorAction[]
  /** 0-100，越高越健康。 */
  score: number
  /** 本轮的一句话总结。 */
  note: string
}

export interface SupervisorState {
  settings: SupervisorSettings
  lastRound?: SupervisorRound
  history: SupervisorRound[]
  nextRunAt?: string
}

export interface SupervisorRunSample {
  id: string
  status: string
  steps: number
  toolCalls: number
  toolErrors: number
  totalTokens: number
  delegations?: number
  /** 时间戳，用于按窗口过滤。 */
  startedAt: string
}

export interface SupervisorHealthSample {
  id: string
  label: string
  status: SelfCheckStatus
  detail?: string
}

export interface SupervisorModuleRisk {
  id: string
  moduleName: string
  severity: SupervisorSeverity
  title: string
  recommendation: string
  evidence: string[]
  /** 这条风险建立在什么事实上（阈值 / 判据码 / 规则口径），原样来自自检报告。 */
  basis?: string
  manual: boolean
}

/**
 * 反思报告里的单条发现（主进程按 topic 拍平后传入）。
 *
 * 刻意只带结论文本，不带报告全文与证据摘要：自动会话需要的是「要修什么」，
 * 而不是把上一轮反思的整份推理再喂一遍。
 */
export interface SupervisorReflectionSample {
  reportId: string
  createdAt: string
  /** ReflectionTopicId；未知值按人工处理，不丢。 */
  topic: string
  /** 该问题域的中文标签，用于标题与证据。 */
  topicLabel: string
  severity: SupervisorSeverity
  observation: string
  suggestion: string
}

export interface SupervisorAnalysisInput {
  runs: SupervisorRunSample[]
  health?: SupervisorHealthSample[]
  moduleRisks?: SupervisorModuleRisk[]
  reflections?: SupervisorReflectionSample[]
}

export interface SupervisorAnalysis {
  signals: SupervisorSignal[]
  findings: SupervisorFinding[]
  score: number
  note: string
}

const FINISHED_STATUSES = new Set(['completed', 'failed', 'interrupted', 'max_steps'])
const FAILED_STATUSES = new Set(['failed', 'interrupted'])

const SEVERITY_PENALTY: Record<SupervisorSeverity, number> = { low: 4, medium: 9, high: 18 }
const SEVERITY_WEIGHT: Record<SupervisorSeverity, number> = { low: 1, medium: 2, high: 3 }

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.round(value)))
}

function ratio(part: number, total: number): number {
  return total > 0 ? part / total : 0
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`
}

/**
 * 宽容解析：任何字段坏掉都退回默认值，而不是让整份设置作废。
 * `apply` 只有在 `enabled` 打开时才生效——避免出现「总关但会自动动手」的歧义状态。
 */
export function normalizeSupervisorSettings(value: unknown): SupervisorSettings {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const budget =
    record['budget'] && typeof record['budget'] === 'object'
      ? (record['budget'] as Record<string, unknown>)
      : {}
  const enabled = record['enabled'] === true
  const interval = Number(record['intervalMinutes'])
  const sessionsPerDay = Number(budget['sessionsPerDay'])
  const charsPerDay = Number(budget['charsPerDay'])
  return {
    enabled,
    intervalMinutes: clamp(
      Number.isFinite(interval) ? interval : DEFAULT_SUPERVISOR_SETTINGS.intervalMinutes,
      SUPERVISOR_MIN_INTERVAL_MINUTES,
      SUPERVISOR_MAX_INTERVAL_MINUTES,
    ),
    apply: enabled && record['apply'] === true,
    budget: {
      sessionsPerDay: clamp(
        Number.isFinite(sessionsPerDay) ? sessionsPerDay : DEFAULT_SUPERVISOR_SETTINGS.budget.sessionsPerDay,
        0,
        10,
      ),
      charsPerDay: clamp(
        Number.isFinite(charsPerDay) ? charsPerDay : DEFAULT_SUPERVISOR_SETTINGS.budget.charsPerDay,
        0,
        200000,
      ),
    },
  }
}

function finding(
  input: Omit<SupervisorFinding, 'manual'> & { manual?: boolean },
): SupervisorFinding {
  return { ...input, manual: input.manual === true }
}

/**
 * 运行记录的健康分析。只看已完成（含失败）的 run：还在跑的不该影响结论。
 *
 * 阈值刻意写得保守——自主优化最怕「为了指标而改代码」，所以每条规则都要求
 * 足够样本量，样本不足时宁可不报。
 */
function analyzeRunFindings(runs: SupervisorRunSample[]): {
  findings: SupervisorFinding[]
  signals: SupervisorSignal[]
} {
  const finished = runs.filter((run) => FINISHED_STATUSES.has(run.status))
  const findings: SupervisorFinding[] = []
  const signals: SupervisorSignal[] = []

  if (finished.length === 0) {
    signals.push({ id: 'runs.sample', label: '可用运行样本', value: '0', level: 'warn' })
    return { findings, signals }
  }

  const completed = finished.filter((run) => run.status === 'completed')
  const failed = finished.filter((run) => FAILED_STATUSES.has(run.status))
  const maxSteps = finished.filter((run) => run.status === 'max_steps')
  const failureRatio = ratio(failed.length, finished.length)
  const maxStepsRatio = ratio(maxSteps.length, finished.length)
  const toolCalls = finished.reduce((sum, run) => sum + Math.max(0, run.toolCalls), 0)
  const toolErrors = finished.reduce((sum, run) => sum + Math.max(0, run.toolErrors), 0)
  const toolErrorRatio = ratio(toolErrors, toolCalls)
  const avgSteps = finished.reduce((sum, run) => sum + Math.max(0, run.steps), 0) / finished.length
  const successRatio = ratio(completed.length, finished.length)

  signals.push({
    id: 'runs.success',
    label: '运行成功率',
    value: `${percent(successRatio)} · ${completed.length}/${finished.length}`,
    level: successRatio >= 0.7 ? 'ok' : successRatio >= 0.4 ? 'warn' : 'alert',
  })
  signals.push({
    id: 'runs.steps',
    label: '平均步数',
    value: avgSteps.toFixed(1),
    level: avgSteps <= 30 ? 'ok' : avgSteps <= 45 ? 'warn' : 'alert',
  })
  signals.push({
    id: 'runs.tool-errors',
    label: '工具错误率',
    value: `${percent(toolErrorRatio)} · ${toolErrors}/${toolCalls}`,
    level: toolErrorRatio <= 0.06 ? 'ok' : toolErrorRatio <= 0.15 ? 'warn' : 'alert',
  })

  if (finished.length >= 4 && failureRatio >= 0.25) {
    findings.push(
      finding({
        id: 'runs.failure-rate',
        source: 'runs',
        severity: failureRatio >= 0.5 ? 'high' : 'medium',
        title: '运行失败率偏高',
        detail: `最近 ${finished.length} 次已完成运行里有 ${failed.length} 次失败（${percent(failureRatio)}）。`,
        suggestion:
          '先看失败样本的错误类型：连续同类错误通常指向工具/权限/上下文构造，而不是模型能力。修之前先补一条能复现的用例。',
        evidence: [
          `失败运行：${failed
            .slice(0, 5)
            .map((run) => `${run.id}(${run.status})`)
            .join('、')}`,
        ],
      }),
    )
  }

  if (finished.length >= 4 && maxStepsRatio >= 0.15) {
    findings.push(
      finding({
        id: 'runs.max-steps',
        source: 'runs',
        severity: maxSteps.length >= 3 ? 'medium' : 'low',
        title: '有运行把步数预算用满',
        detail: `${maxSteps.length}/${finished.length} 次运行以 max_steps 结束，说明任务范围或工具回环有浪费。`,
        suggestion:
          '检查这些运行里重复出现的同一工具调用（同一文件反复读、同一命令反复失败），优先修「失败后不换策略」的循环。',
        evidence: maxSteps.slice(0, 5).map((run) => `${run.id} · ${run.steps} 步`),
      }),
    )
  }

  if (toolCalls >= 20 && toolErrorRatio >= 0.12) {
    findings.push(
      finding({
        id: 'runs.tool-errors',
        source: 'runs',
        severity: toolErrorRatio >= 0.25 ? 'high' : 'medium',
        title: '工具调用错误率偏高',
        detail: `${toolCalls} 次工具调用里有 ${toolErrors} 次报错（${percent(toolErrorRatio)}）。`,
        suggestion:
          '按工具名聚合错误，先修参数校验与错误文案：工具报错信息越明确，模型第二步自我纠正的概率越高。',
        evidence: [`窗口内工具调用 ${toolCalls} 次、错误 ${toolErrors} 次`],
      }),
    )
  }

  if (finished.length >= 4 && avgSteps >= 45) {
    findings.push(
      finding({
        id: 'runs.long-runs',
        source: 'runs',
        severity: 'low',
        title: '平均步数偏高',
        detail: `平均 ${avgSteps.toFixed(1)} 步，样本 ${finished.length} 次。`,
        suggestion:
          '先确认是不是每次都重新发现同样的信息：可复用的结论应该沉淀成技能或记忆，而不是每一步重新调研。',
        evidence: [`平均步数 ${avgSteps.toFixed(1)}，样本 ${finished.length}`],
      }),
    )
  }

  const unverified = completed.filter((run) => run.status === 'completed' && run.toolErrors === 0)
  if (completed.length >= 4 && ratio(unverified.length, completed.length) >= 0.5) {
    findings.push(
      finding({
        id: 'runs.unverified',
        source: 'runs',
        severity: 'low',
        title: '完成的运行里验证证据偏少',
        detail: `${unverified.length}/${completed.length} 次完成运行没有留下工具错误，但这不等于验证过。`,
        suggestion:
          '把「改完必须跑一次窄验证」写成更明确的收尾要求，并在运行记录里保留验证命令与结果。',
        evidence: [`完成运行 ${completed.length} 次`],
      }),
    )
  }

  return { findings, signals }
}

function analyzeHealthFindings(health: SupervisorHealthSample[]): {
  findings: SupervisorFinding[]
  signals: SupervisorSignal[]
} {
  const findings: SupervisorFinding[] = []
  const signals: SupervisorSignal[] = []
  if (health.length === 0) return { findings, signals }

  const broken = health.filter((item) => item.status === 'broken')
  const warn = health.filter((item) => item.status === 'warn')
  const off = health.filter((item) => item.status === 'off')
  const total = health.length

  signals.push({
    id: 'health.state',
    label: '内视异常',
    value: broken.length > 0 ? `${broken.length} 项异常` : `${warn.length} 项告警`,
    level: broken.length > 0 ? 'alert' : warn.length >= 3 ? 'warn' : 'ok',
  })

  if (broken.length > 0) {
    findings.push(
      finding({
        id: 'health.broken',
        source: 'health',
        severity: 'high',
        title: '内视有功能处于异常状态',
        detail: broken.map((item) => item.label).join('、'),
        suggestion: '这些项多半是配置或依赖缺失，先把它们补齐；自动改代码不能替代缺依赖。',
        evidence: broken.slice(0, 8).map((item) => `${item.label}${item.detail ? `：${item.detail}` : ''}`),
        // 环境类问题（缺 API Key、缺依赖、沙箱不可用）不该由模型改源码。
        manual: true,
      }),
    )
  }

  if (warn.length >= Math.max(3, Math.ceil(total * 0.3))) {
    findings.push(
      finding({
        id: 'health.warn',
        source: 'health',
        severity: 'low',
        title: '内视告警项偏多',
        detail: `${warn.length}/${total} 项处于告警状态，另有 ${off.length} 项关闭。`,
        suggestion: '逐项确认这些告警里哪些是用户主动关闭的，避免把「关着」当成「坏了」。',
        evidence: warn.slice(0, 8).map((item) => `${item.label}${item.detail ? `：${item.detail}` : ''}`),
        manual: true,
      }),
    )
  }

  return { findings, signals }
}

function analyzeModuleFindings(risks: SupervisorModuleRisk[]): {
  findings: SupervisorFinding[]
  signals: SupervisorSignal[]
} {
  const findings: SupervisorFinding[] = []
  const signals: SupervisorSignal[] = []
  if (risks.length === 0) {
    signals.push({ id: 'module.risks', label: '源码风险', value: '0', level: 'ok' })
    return { findings, signals }
  }

  const high = risks.filter((risk) => risk.severity === 'high')
  const autoFixable = risks.filter((risk) => !risk.manual && risk.severity !== 'low')
  signals.push({
    id: 'module.risks',
    label: '源码风险',
    value: `${risks.length} 项 · 高 ${high.length}`,
    level: high.length > 0 ? 'warn' : 'ok',
  })

  for (const risk of [...high, ...autoFixable.filter((risk) => risk.severity === 'medium')].slice(0, 4)) {
    findings.push(
      finding({
        id: `module.${risk.id}`,
        source: 'module',
        severity: risk.severity,
        title: risk.title,
        detail: `[${risk.moduleName}] ${risk.title}`,
        suggestion: risk.recommendation,
        // 依据随证据一起走：自动会话看到的是「为什么」，而不是一句主观判断。
        evidence: [...risk.evidence.slice(0, 5), ...(risk.basis ? [`依据：${risk.basis}`] : [])],
        manual: risk.manual,
      }),
    )
  }

  return { findings, signals }
}

/**
 * 汇总分析。顺序固定（运行 → 内视 → 源码），这样同一份输入的报告可以逐字比较。
 */
export function analyzeSupervisor(
  input: SupervisorAnalysisInput,
  now: Date = new Date(),
): SupervisorAnalysis {
  const runs = analyzeRunFindings(input.runs ?? [])
  const health = analyzeHealthFindings(input.health ?? [])
  const module = analyzeModuleFindings(input.moduleRisks ?? [])
  const reflect = analyzeReflectionFindings(input.reflections ?? [], now)

  const findings = [
    ...runs.findings,
    ...health.findings,
    ...module.findings,
    ...reflect.findings,
  ].sort((a, b) => SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity])
  const penalty = findings.reduce((sum, item) => sum + SEVERITY_PENALTY[item.severity], 0)
  const score = Math.max(0, Math.min(100, 100 - penalty))
  const high = findings.filter((item) => item.severity === 'high').length
  const note =
    findings.length === 0
      ? '没有发现需要处理的信号。'
      : `发现 ${findings.length} 项信号（高 ${high} 项），得分 ${score}/100。`

  return {
    signals: [...runs.signals, ...health.signals, ...module.signals, ...reflect.signals],
    findings,
    score,
    note,
  }
}

export interface SupervisorSkip {
  findingId: string
  title: string
  reason: string
}

export interface SupervisorPlan {
  pick?: SupervisorFinding
  skipped: SupervisorSkip[]
  /** 24h 窗口内已用掉的预算。 */
  used: { sessions: number; chars: number }
}

function windowStart(now: Date): number {
  return now.getTime() - SUPERVISOR_WINDOW_MS
}

/** 24h 内真正执行过的动作（skipped 不占预算）。 */
function appliedInWindow(history: SupervisorRound[], now: Date): SupervisorAction[] {
  const from = windowStart(now)
  const out: SupervisorAction[] = []
  for (const round of history) {
    for (const action of round.actions) {
      if (action.status !== 'applied') continue
      const at = Date.parse(action.at)
      if (Number.isFinite(at) && at >= from) out.push(action)
    }
  }
  return out
}

/**
 * 护栏选点：决定这一轮到底要不要动手、动哪一个。
 *
 * 返回 `pick` 之外的候选都会带上跳过理由，让人能回答「为什么没修这条」。
 */
export function planSupervisorApply(
  findings: SupervisorFinding[],
  history: SupervisorRound[],
  settings: SupervisorSettings,
  now: Date = new Date(),
): SupervisorPlan {
  const applied = appliedInWindow(history, now)
  const used = {
    sessions: applied.length,
    chars: applied.reduce((sum, action) => sum + (action.chars ?? 0), 0),
  }
  const recentIds = new Set(applied.map((action) => action.findingId))
  const skipped: SupervisorSkip[] = []

  const candidates = findings.filter((item) => !item.manual)
  for (const item of findings) {
    if (item.manual) skipped.push({ findingId: item.id, title: item.title, reason: '需要人工确认' })
  }

  if (!settings.enabled) {
    return {
      skipped: findings.map((item) => ({
        findingId: item.id,
        title: item.title,
        reason: '总开关未打开',
      })),
      used,
    }
  }
  if (!settings.apply) {
    return {
      skipped: findings.map((item) => ({
        findingId: item.id,
        title: item.title,
        reason: '未允许自动应用，只出清单',
      })),
      used,
    }
  }

  const eligible = candidates.filter((item) => {
    if (recentIds.has(item.id)) {
      skipped.push({ findingId: item.id, title: item.title, reason: '24 小时内已处理过一次' })
      return false
    }
    return true
  })

  if (used.sessions >= settings.budget.sessionsPerDay) {
    return {
      skipped: [
        ...skipped,
        ...eligible.map((item) => ({
          findingId: item.id,
          title: item.title,
          reason: `每日自动会话预算已用完（${settings.budget.sessionsPerDay} 次）`,
        })),
      ],
      used,
    }
  }
  if (used.chars >= settings.budget.charsPerDay) {
    return {
      skipped: [
        ...skipped,
        ...eligible.map((item) => ({
          findingId: item.id,
          title: item.title,
          reason: `每日指令预算已用完（${settings.budget.charsPerDay} 字符）`,
        })),
      ],
      used,
    }
  }

  const [pick, ...rest] = eligible
  for (const item of rest) {
    skipped.push({ findingId: item.id, title: item.title, reason: '本轮只处理优先级最高的一项' })
  }
  return { pick, skipped, used }
}

/**
 * 允许自动会话处理的问题域。
 *
 * 剩下四个（页面设计、项目结构、输出质量、交互体验）都是取舍类问题：改哪里、
 * 改成什么样需要人判断，自动动手最容易「为了指标而重构」。它们仍然会出现在清单里，
 * 只是永远带 `manual` 标记，不占自动预算。
 */
const REFLECTION_AUTO_TOPICS = new Set([
  'compaction-drift',
  'storage-performance',
  'code-quality',
  'execution-efficiency',
])

/** 取组内最高严重度，用于把同一问题域的多条观察压成一项。 */
function maxSeverity(items: SupervisorReflectionSample[]): SupervisorSeverity {
  return items.some((item) => item.severity === 'high')
    ? 'high'
    : items.some((item) => item.severity === 'medium')
      ? 'medium'
      : 'low'
}

/**
 * 反思报告的健康分析。
 *
 * 与其它三源的区别：这里输入的是模型对自身的结论，不是可复算的统计量。因此
 * 1. 只收 medium 及以上——反思里最常见的 low 观察多半是风格意见；
 * 2. 同一 topic 只出一项，避免一份报告把清单塞满；
 * 3. 取舍类问题域一律标 manual。
 */
function analyzeReflectionFindings(
  reflections: SupervisorReflectionSample[],
  now: Date = new Date(),
): {
  findings: SupervisorFinding[]
  signals: SupervisorSignal[]
} {
  const findings: SupervisorFinding[] = []
  const signals: SupervisorSignal[] = []
  const from = now.getTime() - SUPERVISOR_REFLECTION_WINDOW_MS
  const fresh = reflections.filter((item) => {
    const at = Date.parse(item.createdAt)
    return Number.isFinite(at) && at >= from
  })

  const usable = fresh.filter((item) => item.severity !== 'low' && item.observation.trim() !== '')
  if (usable.length === 0) {
    signals.push({
      id: 'reflect.findings',
      label: '反思发现',
      value: fresh.length === 0 ? '无近期报告' : '0',
      level: 'ok',
    })
    return { findings, signals }
  }

  const grouped = new Map<string, SupervisorReflectionSample[]>()
  for (const item of usable) {
    const bucket = grouped.get(item.topic)
    if (bucket) bucket.push(item)
    else grouped.set(item.topic, [item])
  }

  const severityRank: Record<SupervisorSeverity, number> = { high: 3, medium: 2, low: 1 }
  const entries = [...grouped.entries()].sort((a, b) =>
    severityRank[maxSeverity(b[1])] - severityRank[maxSeverity(a[1])],
  )
  const high = entries.filter(([, items]) => maxSeverity(items) === 'high').length

  signals.push({
    id: 'reflect.findings',
    label: '反思发现',
    value: `${entries.length} 项 · 高 ${high}`,
    level: high > 0 ? 'warn' : 'ok',
  })

  for (const [topic, items] of entries) {
    const severity = maxSeverity(items)
    const label = items[0]?.topicLabel || topic
    // 同一 topic 下优先保留更严重的观察与它的建议。
    const ordered = [...items].sort((a, b) => severityRank[b.severity] - severityRank[a.severity])
    const observations = [...new Set(ordered.map((item) => item.observation.trim()))].slice(
      0,
      SUPERVISOR_REFLECTION_MAX_OBSERVATIONS,
    )
    const suggestion =
      ordered.find((item) => item.suggestion.trim() !== '')?.suggestion.trim() ||
      '先核对反思报告里的证据，再决定是否改代码。'
    findings.push(
      finding({
        id: `reflect.${topic}`,
        source: 'reflect',
        severity,
        title: `反思：${label}`,
        detail: observations.join(' / '),
        suggestion,
        evidence: [
          `${items.length} 条观察 · 报告 ${[...new Set(items.map((item) => item.reportId))].join('、')}`,
        ],
        manual: !REFLECTION_AUTO_TOPICS.has(topic),
      }),
    )
  }

  return { findings, signals }
}

/**
 * 自动会话的首条指令。
 *
 * 刻意写成「一次只修一件事 + 必须先复现再改 + 必须给验证命令」：自主优化最容易
 * 出的事故是顺手重构，所以边界写在第一段，而不是附在最后。
 */
export function buildSupervisorPrompt(item: SupervisorFinding): string {
  const lines = [
    '你在执行 Pilot 的自主优化闭环里本轮唯一被授权的一件事。',
    '',
    '边界（先读，再动手）：',
    '- 只改与下面这一项直接相关的代码；不要顺手重构、不要改无关文件。',
    '- 不得修改审批策略、沙箱设置、权限规则、密钥与签名相关逻辑。',
    '- 先给出能复现问题的证据（日志、测试或最小用例），再改，最后跑一次窄验证。',
    '- 如果发现根因不在代码里（缺依赖、缺配置、外部服务不可用），停下来说明，不要硬改。',
  ]
  if (item.source === 'reflect') {
    // 反思结论是模型自评，不是可复算的测量值：不加这一条，自动会话容易为了「满足建议」而重构。
    lines.push(
      '- 这一项来自反思结论，是推论而非测量：先用日志、测试或源码证据核实，核实不成立就停下并说明。',
    )
  }
  lines.push(
    '',
    `问题：${item.title}`,
    `现状：${item.detail}`,
    `建议方向：${item.suggestion}`,
  )
  if (item.evidence.length > 0) {
    lines.push('', '证据：', ...item.evidence.map((entry) => `- ${entry}`))
  }
  lines.push(
    '',
    '收尾要求：',
    '1. 说明改了哪个文件、哪一处，为什么不会影响其它行为；',
    '2. 给出实际跑过的验证命令与结果（类型检查 / 单测 / 构建，取最窄的一条）；',
    '3. 如果这一项其实不该由代码解决，直接说清楚并停下。',
  )
  const text = lines.join('\n')
  // 证据列表可能很长；超出预算就截断并明确标注，避免指令本身吃掉上下文。
  if (text.length <= SUPERVISOR_MAX_PROMPT_CHARS) return text
  return `${text.slice(0, SUPERVISOR_MAX_PROMPT_CHARS)}\n…（指令已按预算截断）`
}

/** 状态里只保留最近若干轮，避免逐轮累积把 supervisor.json 撑大。 */
export function trimSupervisorHistory(history: SupervisorRound[]): SupervisorRound[] {
  return [...history].slice(0, SUPERVISOR_HISTORY_LIMIT)
}
