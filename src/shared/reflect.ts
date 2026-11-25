/**
 * 反思（reflection）共享定义：问题域目录、配置默认值与纯函数。
 *
 * 这里刻意不引入 Electron 或主进程 API：渲染层要渲染同一份问题域目录，
 * 主进程要按同一份规则判断“到点没有”，两边共用一份实现才不会漂移。
 */

/** 反思要自问的问题域。顺序即界面顺序。 */
export type ReflectionTopicId =
  | 'compaction-drift'
  | 'storage-performance'
  | 'page-design'
  | 'project-structure'
  | 'code-quality'
  | 'execution-efficiency'
  | 'output-quality'
  | 'interaction-experience'

/**
 * 一类证据。问题域只有在对应证据存在时才会交给模型。
 *
 * 没有证据还去问“页面设计是否合理”，模型只能编；把「缺什么」显式写出来，
 * 采集端才能判断本轮该问哪几个域，报告也能说明为什么某个域没被问到。
 */
export type ReflectionEvidenceKind =
  | 'runs'
  | 'timing'
  | 'outcomes'
  | 'compaction'
  | 'storage'
  | 'code'
  | 'ui'

export interface ReflectionEvidenceLabels {
  zh: string
  en: string
}

export const REFLECTION_EVIDENCE_LABELS: Record<ReflectionEvidenceKind, ReflectionEvidenceLabels> = {
  runs: { zh: '运行记录（步数 / token / 失败）', en: 'run records (steps / tokens / failures)' },
  timing: { zh: '阶段耗时与审批等待', en: 'phase timings and approval waits' },
  outcomes: { zh: '用户评分或校验结果', en: 'user ratings or verified outcomes' },
  compaction: { zh: '上下文压缩痕迹', en: 'context compaction traces' },
  storage: { zh: '本地存储体积', en: 'local storage volume' },
  code: { zh: '自检代码事实', en: 'self-check code facts' },
  ui: { zh: '界面事实（组件规模 / 界面反馈）', en: 'UI facts (component size / UI feedback)' },
}

export interface ReflectionTopic {
  id: ReflectionTopicId
  /** 中文标签（内部数据源语言）。 */
  zh: string
  /** English label for the mail body and the English UI. */
  en: string
  /** 交给模型看的一句话问题，两边同义。 */
  question: { zh: string; en: string }
  /** 这个域至少需要哪几类证据。全缺时本轮不问，并在报告里记一条跳过原因。 */
  requires: ReflectionEvidenceKind[]
}

export const REFLECTION_TOPICS: ReflectionTopic[] = [
  {
    id: 'compaction-drift',
    zh: '会话压缩漂移',
    en: 'Compaction drift',
    question: {
      zh: '上下文压缩后，早期约束、路径和结论有没有丢失或被改写？',
      en: 'After context compaction, are early constraints, paths and conclusions lost or rewritten?',
    },
    requires: ['compaction'],
  },
  {
    id: 'storage-performance',
    zh: '存储性能',
    en: 'Storage performance',
    question: {
      zh: '会话分片、检查点、索引的写入量与增长是否失控，有没有可合并或该清理的？',
      en: 'Are session shards, checkpoints and search index writes/growth out of control, and what should be merged or pruned?',
    },
    requires: ['storage'],
  },
  {
    id: 'page-design',
    zh: '页面设计合理性',
    en: 'Page design',
    question: {
      zh: '当前界面的层级、对齐、信息密度和空状态是否合理，哪里容易误操作？',
      en: 'Are hierarchy, alignment, density and empty states sound, and where can a user misclick?',
    },
    requires: ['ui'],
  },
  {
    id: 'project-structure',
    zh: '项目结构合理性',
    en: 'Project structure',
    question: {
      zh: '目录与模块边界是否仍然清晰，有没有该拆或该合的过大文件？',
      en: 'Are directory and module boundaries still clear, and which files grew too large or belong elsewhere?',
    },
    requires: ['code'],
  },
  {
    id: 'code-quality',
    zh: '代码优化',
    en: 'Code quality',
    question: {
      zh: '有没有重复逻辑、隐式耦合或该被抽成纯函数/入选脚本的代码？',
      en: 'Is there duplicated logic, hidden coupling, or code that should become a pure function or a repository script?',
    },
    requires: ['code'],
  },
  {
    id: 'execution-efficiency',
    zh: '执行效率',
    en: 'Execution efficiency',
    question: {
      zh: '步数、工具调用与 token 花在哪里最不值，怎样用更少的步骤得到同样的结果？',
      en: 'Where do steps, tool calls and tokens get wasted, and how can the same result take fewer steps?',
    },
    requires: ['runs'],
  },
  {
    id: 'output-quality',
    zh: '输出质量',
    en: 'Output quality',
    question: {
      zh: '回答是否先给结论、证据是否可核对，有没有把猜测写成事实？',
      en: 'Does the answer lead with the result, is its evidence checkable, and is a guess ever stated as fact?',
    },
    requires: ['outcomes'],
  },
  {
    id: 'interaction-experience',
    zh: '交互体验',
    en: 'Interaction experience',
    question: {
      zh: '审批、长任务、失败重试和手机端操作的反馈是否及时且可打断？',
      en: 'Are approvals, long runs, retries and phone-side actions cancelled and reported promptly?',
    },
    requires: ['timing'],
  },
]

export const DEFAULT_REFLECTION_TOPICS: ReflectionTopicId[] = REFLECTION_TOPICS.map(
  (topic) => topic.id,
)

const TOPIC_IDS = new Set<string>(DEFAULT_REFLECTION_TOPICS)

export function isReflectionTopicId(value: unknown): value is ReflectionTopicId {
  return typeof value === 'string' && TOPIC_IDS.has(value)
}

/** 去重、按目录顺序排列并丢掉未知项；空数组表示“没有选任何问题域”。 */
export function normalizeReflectionTopics(value: unknown): ReflectionTopicId[] {
  if (!Array.isArray(value)) return [...DEFAULT_REFLECTION_TOPICS]
  const picked = new Set(value.filter(isReflectionTopicId))
  return DEFAULT_REFLECTION_TOPICS.filter((id) => picked.has(id))
}

/** 触发方式：报错触发与固定时间触发可各自独立开关。 */
export interface ReflectionTriggers {
  onError: boolean
  onSchedule: boolean
}

export function normalizeReflectionTriggers(value: unknown): ReflectionTriggers {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  return {
    onError: record['onError'] !== false,
    onSchedule: record['onSchedule'] !== false,
  }
}

/**
 * 自动触发的三种粒度：
 * - `version`：应用版本变化后就反思一次。高速迭代期一版一个行为，反思按版本切分
 *   才看得清「这一版改了什么」；版本不变时按 `REFLECTION_VERSION_FALLBACK_MINUTES`
 *   兜底，长期不升级也不会永远等不到自省。
 * - `interval`：每 N 分钟。
 * - `daily`：每天固定时刻。
 */
export type ReflectionScheduleMode = 'interval' | 'daily' | 'version'

export function normalizeReflectionScheduleMode(value: unknown): ReflectionScheduleMode {
  if (value === 'interval' || value === 'daily') return value
  return 'version'
}

/** 版本模式的兜底静默期：版本没变也要自己看一次，否则不升级的用户永远不反思。 */
export const REFLECTION_VERSION_FALLBACK_MINUTES = 7 * 24 * 60

/**
 * 版本变了但这次反思没成（模型不可用等）时的重试间隔：
 * 不加速度限制就会每分钟重试一次，一天几百封失败通知。
 */
export const REFLECTION_VERSION_RETRY_MINUTES = 10

export const REFLECTION_INTERVAL_MIN_MINUTES = 30
export const REFLECTION_INTERVAL_MAX_MINUTES = 60 * 24 * 7
export const REFLECTION_INTERVAL_DEFAULT_MINUTES = 12 * 60
export const REFLECTION_DAILY_DEFAULT = '09:00'
/** 报错触发的冷却时间：同一窗口内的连续失败只反思一次。 */
export const REFLECTION_ERROR_COOLDOWN_MS = 10 * 60_000
/** 保留的报告条数。 */
export const MAX_REFLECTION_REPORTS = 30
/** 单次反思最多输出的条目数（硬上限，旧报告也可能有 8 条）。 */
export const MAX_REFLECTION_FINDINGS = 8
/**
 * 提示词里给出的目标条数。
 *
 * 上限写成 8 时模型会当成“写满 8 条”：实测 9 份报告平均 7.33 条、high 占 45%，
 * 分档已经完全不能用来排优先级。给一个明显低于硬上限的目标值，才能让它少写。
 */
export const REFLECTION_FINDING_TARGET = 4

const TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d)$/

export function normalizeReflectionTime(value: unknown): string {
  return typeof value === 'string' && TIME_OF_DAY.test(value.trim())
    ? value.trim()
    : REFLECTION_DAILY_DEFAULT
}

export function clampReflectionInterval(minutes: unknown): number {
  const value = typeof minutes === 'number' && Number.isFinite(minutes) ? Math.round(minutes) : NaN
  if (!Number.isFinite(value)) return REFLECTION_INTERVAL_DEFAULT_MINUTES
  return Math.min(
    REFLECTION_INTERVAL_MAX_MINUTES,
    Math.max(REFLECTION_INTERVAL_MIN_MINUTES, value),
  )
}

/**
 * 自动触发是否到点。`lastRunAt` 是上一次「反思成功」的时间，空表示从没跑过。
 * 从没跑过时按“启用后先跑一次建锦点”处理：每天模式下当天时刻已过就算到点，
 * 间隔与版本模式下直接到点——否则刚切换模式的用户永远等不到第一次自问。
 */
export function reflectionScheduleDue(
  input: {
    mode: ReflectionScheduleMode
    intervalMinutes: number
    dailyTime: string
    lastRunAt: string | null
    /** 上一次排定触发被处理的时间，避免到点后每轮 tick 重复触发。 */
    lastScheduledAt?: string | null
    /** 当前应用版本；`version` 模式下与上次反思的版本比较。 */
    currentVersion?: string
    /** 上一次成功反思时记录的应用版本。 */
    lastVersion?: string
  },
  now: Date,
): boolean {
  const lastRun = parseTime(input.lastRunAt)
  const lastScheduled = parseTime(input.lastScheduledAt ?? null)
  const anchor = Math.max(lastRun ?? 0, lastScheduled ?? 0)
  if (input.mode === 'version') {
    const current = (input.currentVersion ?? '').trim()
    const last = (input.lastVersion ?? '').trim()
    // 从没跑过：立即跑一次，把当前版本落成基线。
    if (anchor === 0) return true
    if (!current) {
      // 宿主报不出当前版本（未注入或启动早期）：版本比较无从判断，退回兜底静默期。
      // 不能走下面的重试窗口，否则拿不到版本的机器会每 10 分钟反思一次，白烧额度。
      return now.getTime() - anchor >= REFLECTION_VERSION_FALLBACK_MINUTES * 60_000
    }
    if (last === current) {
      // 版本没变：只在兜底静默期到点时才再自省一次。
      return now.getTime() - anchor >= REFLECTION_VERSION_FALLBACK_MINUTES * 60_000
    }
    // 版本变了（或旧存档还没基线）：立即反思，但刚失败过先等一个重试窗口，不追着每分钟重试。
    return now.getTime() - anchor >= REFLECTION_VERSION_RETRY_MINUTES * 60_000
  }
  if (input.mode === 'interval') {
    const intervalMs = clampReflectionInterval(input.intervalMinutes) * 60_000
    // 没有任何锦点时先跑一次，把 lastScheduledAt 落盘成为后续间隔的锦点。
    if (anchor === 0) return true
    return now.getTime() - anchor >= intervalMs
  }
  const daily = dailySlot(input.dailyTime, now)
  if (daily === null) return false
  return daily > anchor && now.getTime() >= daily
}

function parseTime(value: string | null): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** 今天（按本地时区）的固定触发时刻；无效时间返回 null。 */
export function dailySlot(timeOfDay: string, now: Date): number | null {
  const match = TIME_OF_DAY.exec(normalizeReflectionTime(timeOfDay))
  if (!match) return null
  const slot = new Date(now)
  slot.setHours(Number(match[1]), Number(match[2]), 0, 0)
  return slot.getTime()
}

export type ReflectionTrigger = 'manual' | 'error' | 'schedule'

export type ReflectionSeverity = 'high' | 'medium' | 'low'

export interface ReflectionFinding {
  /** 稳定标识：界面上标记「已处理 / 忽略」、转成待办都靠它。旧数据缺失时由报告 id 派生。 */
  id: string
  topic: ReflectionTopicId
  severity: ReflectionSeverity
  /** 观察到的事实，必须能在证据里找到依据。 */
  observation: string
  /** 一条可执行建议。 */
  suggestion: string
  /**
   * 结论指向的代码位置（仓库相对路径 + 可选行号）。
   * 有它才能把一句判断变成可核对的事实；运行时只保留证据里真出现过的路径。
   */
  refs?: ReflectionFindingRef[]
  /** 发现的处理状态；缺省视为 open。 */
  status?: ReflectionFindingStatus
}

/** 一条可核对的代码位置。 */
export interface ReflectionFindingRef {
  path: string
  line?: number
}

/** 发现的处理状态：待处理 / 已处理 / 不打算做。 */
export type ReflectionFindingStatus = 'open' | 'done' | 'dismissed'

export function normalizeFindingStatus(value: unknown): ReflectionFindingStatus {
  return value === 'done' || value === 'dismissed' ? value : 'open'
}

export interface ReflectionEmailState {
  sent: boolean
  to: string
  error?: string
}

export interface ReflectionReport {
  id: string
  createdAt: string
  trigger: ReflectionTrigger
  /** 这次反思对应的应用版本；`version` 模式据此判断下一次何时到点。 */
  version?: string
  /** 实际使用的模型名（资源里的 model 字段）。 */
  model: string
  topics: ReflectionTopicId[]
  /** 本轮因证据不足而没有交给模型的问题域。 */
  skipped: { topic: ReflectionTopicId; missing: ReflectionEvidenceKind[] }[]
  summary: string
  findings: ReflectionFinding[]
  /** 输入证据的摘要（前 2000 字），便于事后判断结论有没有依据。 */
  evidence: string
  /** 完整证据的字符数：比 `evidence` 长就说明预览被截断了。 */
  evidenceChars?: number
  /** 完整证据落在 userData/reflect-evidence/<id>.txt 时的文件名。 */
  evidenceFile?: string
  durationMs: number
  /** 这次反思本身失败了（模型报错 / 超时 / 未配置），报告仍保留以便用户看到。 */
  error?: string
  /** 模型没有按 JSON 返回，摘要退化成原文。 */
  degraded?: boolean
  email: ReflectionEmailState | null
}

export function normalizeReflectionSeverity(value: unknown): ReflectionSeverity {
  return value === 'high' || value === 'low' ? value : 'medium'
}

function cleanText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : ''
}

export function sanitizeReflectionFinding(value: unknown): ReflectionFinding | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const topic = isReflectionTopicId(record['topic'])
    ? record['topic']
    : isReflectionTopicId(record['domain'])
      ? (record['domain'] as ReflectionTopicId)
      : null
  const observation = cleanText(record['observation'] ?? record['finding'], 600)
  if (!topic || !observation) return null
  const refs = sanitizeFindingRefs(record['refs'] ?? record['files'])
  return {
    id: cleanText(record['id'], 80),
    topic,
    severity: normalizeReflectionSeverity(record['severity']),
    observation,
    suggestion: cleanText(record['suggestion'] ?? record['advice'], 600),
    ...(refs.length > 0 ? { refs } : {}),
    ...(record['status'] === 'done' || record['status'] === 'dismissed'
      ? { status: normalizeFindingStatus(record['status']) }
      : {}),
  }
}

/** 单条结论最多引用几个位置：多了就变成罗列文件，反而不可核对。 */
export const MAX_FINDING_REFS = 4

/**
 * 清洗一个代码引用。拒绝绝对路径与 URL：反思读的是仓库内的代码，
 * 绝对路径既不可移植，也容易把用户机器的目录结构写进报告。
 */
export function sanitizeFindingRef(value: unknown): ReflectionFindingRef | null {
  if (typeof value === 'string') {
    const text = value.trim().replace(/^`+|`+$/g, '')
    const match = /^(.*?):(\d{1,7})$/.exec(text)
    return buildFindingRef(match?.[1] ?? text, match ? Number(match[2]) : undefined)
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const path = typeof record['path'] === 'string' ? record['path'] : ''
    const line =
      typeof record['line'] === 'number' && Number.isFinite(record['line'])
        ? Math.round(record['line'])
        : undefined
    return buildFindingRef(path, line)
  }
  return null
}

function buildFindingRef(rawPath: string, line: number | undefined): ReflectionFindingRef | null {
  const path = rawPath
    .trim()
    .replace(/^`+|`+$/g, '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
  if (path.length < 3 || path.length > 200) return null
  // 绝对路径、盘符、URL、带空格的自然语言（“service.ts 第 118 行”）都不是可核对的位置。
  if (/^[A-Za-z]:/.test(path) || path.startsWith('/') || path.includes('://')) return null
  if (/\s/.test(path) || !path.includes('.')) return null
  const safeLine = typeof line === 'number' && line >= 1 && line <= 1_000_000 ? line : undefined
  return safeLine ? { path, line: safeLine } : { path }
}

/** 去重并截断；坏引用静默丢弃，不能因为模型多写一个文件路径就让整次反思失败。 */
export function sanitizeFindingRefs(value: unknown): ReflectionFindingRef[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  const seen = new Set<string>()
  const refs: ReflectionFindingRef[] = []
  for (const entry of list) {
    const ref = sanitizeFindingRef(entry)
    if (!ref) continue
    const key = ref.line ? `${ref.path}:${ref.line}` : ref.path
    if (seen.has(key)) continue
    seen.add(key)
    refs.push(ref)
    if (refs.length >= MAX_FINDING_REFS) break
  }
  return refs
}

/** 引用在文本里的写法，界面与邮件共用，避免两边格式漂移。 */
export function reflectionRefLabel(ref: ReflectionFindingRef): string {
  return ref.line ? `${ref.path}:${ref.line}` : ref.path
}

export function sanitizeReflectionReport(value: unknown): ReflectionReport | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const id = typeof record['id'] === 'string' && record['id'].trim() ? record['id'].trim() : ''
  const createdAt = typeof record['createdAt'] === 'string' ? record['createdAt'] : ''
  if (!id || !Number.isFinite(Date.parse(createdAt))) return null
  const trigger: ReflectionTrigger =
    record['trigger'] === 'error' || record['trigger'] === 'schedule' ? record['trigger'] : 'manual'
  const findings = (
    Array.isArray(record['findings']) ? (record['findings'] as unknown[]) : []
  )
    .map(sanitizeReflectionFinding)
    .filter((item): item is ReflectionFinding => Boolean(item))
    .slice(0, MAX_REFLECTION_FINDINGS)
    // 旧报告没有 finding id：用报告 id + 位置派生一个稳定值，状态才能标得上去。
    .map((finding, index) => ({ ...finding, id: finding.id || `${id}#${index + 1}` }))
  const skipped = (
    Array.isArray(record['skipped']) ? (record['skipped'] as unknown[]) : []
  )
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null
      const item = entry as Record<string, unknown>
      if (!isReflectionTopicId(item['topic'])) return null
      const missing = Array.isArray(item['missing'])
        ? (item['missing'] as unknown[]).filter((kind): kind is string => typeof kind === 'string').slice(0, 7)
        : []
      return { topic: item['topic'] as ReflectionTopicId, missing }
    })
    .filter((item): item is ReflectionReport['skipped'][number] => Boolean(item))
  return {
    id,
    createdAt,
    trigger,
    model: cleanText(record['model'], 200),
    ...(typeof record['version'] === 'string' && record['version'].trim()
      ? { version: cleanText(record['version'], 40) }
      : {}),
    topics: normalizeReflectionTopics(record['topics']),
    skipped,
    summary: cleanText(record['summary'], 800),
    findings,
    evidence: cleanText(record['evidence'], 2_000),
    ...(typeof record['evidenceChars'] === 'number' && Number.isFinite(record['evidenceChars'])
      ? { evidenceChars: Math.max(0, Math.round(record['evidenceChars'])) }
      : {}),
    ...(typeof record['evidenceFile'] === 'string' && record['evidenceFile'].trim()
      ? { evidenceFile: cleanText(record['evidenceFile'], 200) }
      : {}),
    durationMs:
      typeof record['durationMs'] === 'number' && Number.isFinite(record['durationMs'])
        ? Math.max(0, Math.round(record['durationMs']))
        : 0,
    ...(typeof record['error'] === 'string' && record['error']
      ? { error: cleanText(record['error'], 500) }
      : {}),
    ...(record['degraded'] === true ? { degraded: true } : {}),
    email: sanitizeEmailState(record['email']),
  }
}

function sanitizeEmailState(value: unknown): ReflectionEmailState | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  return {
    sent: record['sent'] === true,
    to: cleanText(record['to'], 320),
    ...(typeof record['error'] === 'string' && record['error']
      ? { error: cleanText(record['error'], 400) }
      : {}),
  }
}

export function reflectionTopicLabel(id: ReflectionTopicId, english: boolean): string {
  const topic = REFLECTION_TOPICS.find((entry) => entry.id === id)
  if (!topic) return id
  return english ? topic.en : topic.zh
}

export function reflectionEvidenceLabel(kind: ReflectionEvidenceKind, english: boolean): string {
  const entry = REFLECTION_EVIDENCE_LABELS[kind]
  return english ? entry.en : entry.zh
}

/**
 * 把用户选的问题域拆成「本轮能问的」和「缺证据跳过的」。
 *
 * 以前是把这个判断交给模型（提示词第 4 条），实测它会为凑数硬写：
 * `page-design` 只产出 1 条而 `interaction-experience` 产出 10 条，差别就是有没有真数字。
 * 判断放在这里，报告才能逐条说明“为什么这个域没被问到”。
 */
export function reflectionTopicsWithEvidence(
  topics: readonly ReflectionTopicId[],
  available: readonly ReflectionEvidenceKind[],
): {
  usable: ReflectionTopic[]
  skipped: { topic: ReflectionTopicId; missing: ReflectionEvidenceKind[] }[]
} {
  const have = new Set(available)
  const usable: ReflectionTopic[] = []
  const skipped: { topic: ReflectionTopicId; missing: ReflectionEvidenceKind[] }[] = []
  for (const id of topics) {
    const topic = REFLECTION_TOPICS.find((entry) => entry.id === id)
    if (!topic) continue
    const missing = topic.requires.filter((kind) => !have.has(kind))
    if (missing.length === 0) usable.push(topic)
    else skipped.push({ topic: id, missing })
  }
  return { usable, skipped }
}

export function reflectionTriggerLabel(trigger: ReflectionTrigger, english: boolean): string {
  if (english) {
    return trigger === 'error' ? 'error trigger' : trigger === 'schedule' ? 'scheduled' : 'manual'
  }
  return trigger === 'error' ? '报错触发' : trigger === 'schedule' ? '定时触发' : '手动触发'
}
