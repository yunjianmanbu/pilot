// 自主优化闭环（supervisor）：定时采样 → 分析 → 护栏内动作 → 记账。
//
// 这里只做 IO 编排，判定逻辑全在 `src/shared/supervisor.ts`。
// 服务本身**不直接改任何源码**：真要动手时它只能创建一个普通编码会话，
// 改动仍然走那个会话的沙箱、审批策略与检查点，与用户手写任务完全相同。
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunEvent } from '../shared/types'
import type { AppLogEntry } from './app-log'
import {
  DEFAULT_SUPERVISOR_SETTINGS,
  SUPERVISOR_HISTORY_LIMIT,
  analyzeSupervisor,
  buildSupervisorPrompt,
  normalizeSupervisorSettings,
  planSupervisorApply,
  trimSupervisorHistory,
  type SupervisorAction,
  type SupervisorHealthSample,
  type SupervisorModuleRisk,
  type SupervisorReflectionSample,
  type SupervisorRound,
  type SupervisorRunSample,
  type SupervisorSettings,
  type SupervisorState,
} from '../shared/supervisor'

const STATE_VERSION = 1

/**
 * 采集一路信号。同步抛错和 promise reject 都退化成空样本：一路坏掉不该把整轮分析带下去，
 * 否则一个损坏的持久化文件就能让闭环永久停摆。
 */
function sampleSafe<T>(fn: (() => Promise<T[]> | T[]) | undefined): Promise<T[]> {
  if (!fn) return Promise.resolve([])
  try {
    return Promise.resolve(fn()).catch(() => [])
  } catch {
    return Promise.resolve([])
  }
}

export interface SupervisorDeps {
  /** userData 目录：设置与轮次历史落在 `supervisor.json`。 */
  userDataDir: string
  /** 汇总最近的运行样本（主进程跨工作区取，只读）。 */
  sampleRuns: () => Promise<SupervisorRunSample[]> | SupervisorRunSample[]
  /** 内视采样；缺省表示不参与分析。 */
  sampleHealth?: () => Promise<SupervisorHealthSample[]> | SupervisorHealthSample[]
  /** 模块自检最新报告里的风险；没跑过自检时返回空数组。 */
  sampleModuleRisks?: () => Promise<SupervisorModuleRisk[]> | SupervisorModuleRisk[]
  /** 最近几份反思报告拍平后的发现；没跑过反思时返回空数组（不触发一次反思）。 */
  sampleReflections?: () =>
    | Promise<SupervisorReflectionSample[]>
    | SupervisorReflectionSample[]
  /**
   * 自改会话所在的工作区（Pilot 自己的源码根）。
   *
   * 只在真的要动手时调用：准备源码副本可能是一次完整的目录复制，
   * 只出清单的轮次不该付这个代价。
   */
  selfSourceRoot: () => Promise<string>
  /** 创建普通编码会话并投递首条指令；与手动任务同一条路径。 */
  startSession: (
    workspacePath: string,
    prompt: string,
  ) => Promise<{ sessionId: string; queued?: boolean }>
  emit?: (event: RunEvent) => void
  log?: (entry: AppLogEntry) => void
  now?: () => Date
}

/**
 * 自主优化服务。
 *
 * 两类动作的边界：
 * - 只读采样与出清单：随时可以跑，不产生费用、不碰文件；
 * - 自动应用：必须 `enabled && apply` 都为真，且受每日会话数/字符数预算与
 *   同一问题 24h 冷却限制（见 `planSupervisorApply`），每轮最多一项。
 */
export class SupervisorService {
  private readonly deps: SupervisorDeps
  private readonly stateFile: string
  private state: SupervisorState = {
    settings: { ...DEFAULT_SUPERVISOR_SETTINGS },
    history: [],
  }
  private loaded: Promise<void> | null = null
  private timer: NodeJS.Timeout | null = null
  private running = false

  constructor(deps: SupervisorDeps) {
    this.deps = deps
    this.stateFile = join(deps.userDataDir, 'supervisor.json')
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }

  async load(): Promise<void> {
    this.loaded ??= this.readState()
    return this.loaded
  }

  private async readState(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.stateFile, 'utf8')) as unknown
      this.state = sanitizeSupervisorState(parsed)
    } catch {
      // 首次运行或文件损坏：退回默认设置，不让启动失败。
      this.state = { settings: { ...DEFAULT_SUPERVISOR_SETTINGS }, history: [] }
    }
  }

  private async persist(): Promise<void> {
    const payload = JSON.stringify({ version: STATE_VERSION, ...this.state }, null, 2)
    await writeFile(this.stateFile, payload, 'utf8').catch((error: unknown) => {
      this.deps.log?.({
        area: 'supervisor',
        event: 'state.write-failed',
        level: 'warn',
        detail: { message: error instanceof Error ? error.message : String(error) },
      })
    })
  }

  snapshot(): SupervisorState {
    return JSON.parse(JSON.stringify(this.state)) as SupervisorState
  }

  /** 面板用的轻量状态：不带历史轮次的完整报告。 */
  summary(): {
    settings: SupervisorSettings
    lastRound?: SupervisorRound
    nextRunAt?: string
    rounds: number
  } {
    return {
      settings: { ...this.state.settings },
      ...(this.state.lastRound ? { lastRound: this.state.lastRound } : {}),
      ...(this.state.nextRunAt ? { nextRunAt: this.state.nextRunAt } : {}),
      rounds: this.state.history.length,
    }
  }

  async updateSettings(input: Partial<SupervisorSettings> | undefined): Promise<SupervisorState> {
    await this.load()
    const merged = {
      ...this.state.settings,
      ...(input ?? {}),
      budget: { ...this.state.settings.budget, ...(input?.budget ?? {}) },
    }
    this.state.settings = normalizeSupervisorSettings(merged)
    await this.persist()
    this.restart()
    this.deps.log?.({
      area: 'supervisor',
      event: 'settings.updated',
      detail: {
        enabled: this.state.settings.enabled,
        apply: this.state.settings.apply,
        intervalMinutes: this.state.settings.intervalMinutes,
      },
    })
    return this.snapshot()
  }

  /** 按当前设置重排定时器；关闭时清掉。 */
  restart(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.state.settings.enabled) {
      if (this.state.nextRunAt) {
        delete this.state.nextRunAt
        void this.persist()
      }
      return
    }
    const intervalMs = this.state.settings.intervalMinutes * 60 * 1000
    this.state.nextRunAt = new Date(this.now().getTime() + intervalMs).toISOString()
    this.timer = setTimeout(() => {
      void this.run('schedule')
        .catch((error: unknown) => {
          this.deps.log?.({
            area: 'supervisor',
            event: 'round.failed',
            level: 'warn',
            detail: { message: error instanceof Error ? error.message : String(error) },
          })
        })
        .finally(() => this.restart())
    }, intervalMs)
    // 优化轮次不该阻止应用退出。
    this.timer.unref?.()
  }

  start(): void {
    this.restart()
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /**
   * 跑一轮。重复调用共享同一轮（不排队、不并发），避免手动点两下开两个会话。
   */
  async run(trigger: 'manual' | 'schedule'): Promise<SupervisorRound> {
    await this.load()
    if (this.running) {
      if (this.state.lastRound) return this.state.lastRound
      throw new Error('自主优化正在执行，请稍候')
    }
    this.running = true
    const startedAt = this.now()
    try {
      const [runs, health, moduleRisks, reflections] = await Promise.all([
        sampleSafe(this.deps.sampleRuns),
        sampleSafe(this.deps.sampleHealth),
        sampleSafe(this.deps.sampleModuleRisks),
        sampleSafe(this.deps.sampleReflections),
      ])

      const analysis = analyzeSupervisor({ runs, health, moduleRisks, reflections }, startedAt)
      const plan = planSupervisorApply(analysis.findings, this.state.history, this.state.settings, startedAt)
      const actions: SupervisorAction[] = plan.skipped
        .slice(0, 6)
        .map((skip) => ({
          at: startedAt.toISOString(),
          findingId: skip.findingId,
          title: skip.title,
          status: 'skipped' as const,
          reason: skip.reason,
        }))

      if (plan.pick) {
        actions.unshift(await this.apply(plan.pick, startedAt))
      }

      const round: SupervisorRound = {
        id: `sp_${startedAt.getTime().toString(36)}`,
        trigger,
        startedAt: startedAt.toISOString(),
        finishedAt: this.now().toISOString(),
        signals: analysis.signals,
        findings: analysis.findings,
        actions,
        score: analysis.score,
        note: analysis.note,
      }
      this.state.lastRound = round
      this.state.history = trimSupervisorHistory([round, ...this.state.history])
      await this.persist()
      this.deps.log?.({
        area: 'supervisor',
        event: 'round.completed',
        detail: {
          round: round.id,
          trigger,
          score: round.score,
          findings: round.findings.length,
          applied: actions.filter((action) => action.status === 'applied').length,
        },
      })
      return round
    } finally {
      this.running = false
    }
  }

  /** 把「该动手」变成一次普通会话；失败只记账，不上抛（不能因此让整轮没有报告）。 */
  private async apply(
    item: NonNullable<ReturnType<typeof planSupervisorApply>['pick']>,
    at: Date,
  ): Promise<SupervisorAction> {
    const prompt = buildSupervisorPrompt(item)
    const base = {
      at: at.toISOString(),
      findingId: item.id,
      title: item.title,
      chars: prompt.length,
    }
    try {
      const workspace = await this.deps.selfSourceRoot()
      const created = await this.deps.startSession(workspace, prompt)
      if (created.queued) {
        // 没配模型：指令已经排队，但这一轮并没有真的改动。不占自动预算。
        return {
          ...base,
          status: 'skipped',
          sessionId: created.sessionId,
          reason: '模型未配置，指令已放进会话队列',
        }
      }
      this.deps.emit?.({
        type: 'notice',
        level: 'info',
        topic: 'supervisor',
        notifyEvent: 'supervisor.applied',
        message: `自主优化已开一轮会话：${item.title}（会照常走沙箱与审批）。`,
      })
      return { ...base, status: 'applied', sessionId: created.sessionId }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.deps.log?.({
        area: 'supervisor',
        event: 'apply.failed',
        level: 'warn',
        detail: { findingId: item.id, message },
      })
      return { ...base, status: 'error', reason: message }
    }
  }
}

/**
 * 状态文件解析：任何一层不合法都退回默认值。
 *
 * 历史轮次只保留结构正确的字段，避免旧版本或手改出来的文件把面板搞崩。
 */
export function sanitizeSupervisorState(value: unknown): SupervisorState {
  if (!value || typeof value !== 'object') {
    return { settings: { ...DEFAULT_SUPERVISOR_SETTINGS }, history: [] }
  }
  const record = value as Record<string, unknown>
  const settings = normalizeSupervisorSettings(record['settings'])
  const history = Array.isArray(record['history'])
    ? record['history']
        .map(sanitizeSupervisorRound)
        .filter((round): round is SupervisorRound => round !== null)
        .slice(0, SUPERVISOR_HISTORY_LIMIT)
    : []
  const lastRound = sanitizeSupervisorRound(record['lastRound']) ?? history[0]
  const nextRunAt = typeof record['nextRunAt'] === 'string' ? record['nextRunAt'] : undefined
  return {
    settings,
    history,
    ...(lastRound ? { lastRound } : {}),
    ...(nextRunAt ? { nextRunAt } : {}),
  }
}

function sanitizeSupervisorRound(value: unknown): SupervisorRound | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const id = typeof record['id'] === 'string' ? record['id'] : ''
  const startedAt = typeof record['startedAt'] === 'string' ? record['startedAt'] : ''
  if (!id || !startedAt) return null
  const findings = Array.isArray(record['findings'])
    ? record['findings']
        .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
        .map((item) => ({
          id: String(item['id'] ?? ''),
          source: (item['source'] === 'health' ||
          item['source'] === 'module' ||
          item['source'] === 'reflect'
            ? item['source']
            : 'runs') as 'runs' | 'health' | 'module' | 'reflect',
          severity: (item['severity'] === 'high' || item['severity'] === 'medium'
            ? item['severity']
            : 'low') as 'low' | 'medium' | 'high',
          title: String(item['title'] ?? ''),
          detail: String(item['detail'] ?? ''),
          suggestion: String(item['suggestion'] ?? ''),
          evidence: Array.isArray(item['evidence'])
            ? item['evidence'].filter((entry): entry is string => typeof entry === 'string').slice(0, 8)
            : [],
          manual: item['manual'] === true,
        }))
        .filter((item) => item.id !== '' && item.title !== '')
    : []
  const actions = Array.isArray(record['actions'])
    ? record['actions']
        .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
        .map((item) => ({
          at: typeof item['at'] === 'string' ? item['at'] : startedAt,
          findingId: String(item['findingId'] ?? ''),
          title: String(item['title'] ?? ''),
          status: (item['status'] === 'applied' || item['status'] === 'error'
            ? item['status']
            : 'skipped') as 'applied' | 'skipped' | 'error',
          ...(typeof item['sessionId'] === 'string' ? { sessionId: item['sessionId'] } : {}),
          ...(typeof item['reason'] === 'string' ? { reason: item['reason'] } : {}),
          ...(typeof item['chars'] === 'number' ? { chars: item['chars'] } : {}),
        }))
    : []
  const signals = Array.isArray(record['signals'])
    ? record['signals']
        .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
        .map((item) => ({
          id: String(item['id'] ?? ''),
          label: String(item['label'] ?? ''),
          value: String(item['value'] ?? ''),
          level: (item['level'] === 'warn' || item['level'] === 'alert' ? item['level'] : 'ok') as
            | 'ok'
            | 'warn'
            | 'alert',
        }))
    : []
  return {
    id,
    trigger: record['trigger'] === 'schedule' ? 'schedule' : 'manual',
    startedAt,
    finishedAt: typeof record['finishedAt'] === 'string' ? record['finishedAt'] : startedAt,
    signals,
    findings,
    actions,
    score: typeof record['score'] === 'number' ? Math.max(0, Math.min(100, Math.round(record['score']))) : 100,
    note: typeof record['note'] === 'string' ? record['note'] : '',
  }
}
