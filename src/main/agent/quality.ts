/**
 * 产出质量闸门（quality gate）。
 *
 * 目标：探索任务不是"做完就算"，而是持续围绕可度量的产出质量。一次评估做四件事：
 *
 * 1. 从运行记录算出确定性指标（通过率、验证覆盖、工具健康、满意度、效率）；
 * 2. 按当前指标集里的权重动态调优（低分维度加权、样本不足降权），并把新指标集
 *    连同版本号和逐条理由存下来，任何一次分数都能解释成"哪版权重、哪些样本"；
 * 3. 请**配置的评估模型**只回答一件事：reviewScore + 一句结论。它不能改写客观指标，
 *    也不能自己决定通过与否；
 * 4. 与现行基线比较：只有总分提升达到阈值、且没有任何单项大幅回退，才判为"更优版本"，
 *    进入 `awaiting_user` 并触发铃铛。用户批准前绝不发布，批准后也只跑白名单里的打包脚本。
 *
 * 因此"自主发布"始终是：模型提案 → 用户授权 → 固定命令，而不是"模型自己决定上线"。
 */
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import type {
  JudgeUsage,
  QualityCandidate,
  QualityCandidateStatus,
  QualityEvidence,
  QualityPublishTarget,
  QualityState,
  RunEvent,
  RunRecord,
} from '../../shared/types'
import {
  QUALITY_PUBLISH_TARGETS,
  compareQuality,
  defaultMetricSet,
  qualityPromptBlock,
  scoreMetrics,
  signalsFromRuns,
  tuneMetricSet,
  type QualityMetricId,
  type QualityMetricSet,
  type QualitySignals,
} from '../../shared/quality'
import { coerceScore, extractJsonObject } from './json'
import { completeWithWatchdog, unparsedResponseReason, addJudgeUsage, emptyJudgeUsage } from './judge-runtime'
import type { ModelClient, ModelRequest } from './loop'
import type { ProfileJudge } from './evolution'
import type { Store } from '../store'

/** 评估结果里唯一来自模型的部分。 */
export interface QualityVerdict {
  reviewScore: number | null
  verdict: string
  /** Which model produced it; empty when no evaluation model answered. */
  model: string
  /** True when the model that scored is the same endpoint+model as the executor. */
  selfReview: boolean
  /** What this one judgement cost; absent only for verdicts built before it was counted. */
  usage?: JudgeUsage
  error?: string
}

export interface PackageRunResult {
  code: number
  output: string
}

export interface QualityServiceOptions {
  store: Store
  /** 配置的评估模型；为空时退回运行模型并标记为自评。 */
  judges: () => ProfileJudge[]
  /** 运行模型客户端，仅在没有任何评估模型时使用。 */
  makeClient: () => ModelClient
  /** pilot/client 目录（打包脚本所在处）。 */
  packageRoot: string
  /** 注入点：测试用它避免真的打包。 */
  runPackage?: (target: QualityPublishTarget, cwd: string) => Promise<PackageRunResult>
  /** 广播事件（铃铛 / 手机端）。 */
  onEvent?: (event: RunEvent) => void
  now?: () => string
  /** 打包超时，默认 20 分钟。 */
  packageTimeoutMs?: number
}

const EVALUATION_SYSTEM = [
  'You are the evaluation model of a coding agent. You receive measurable quality signals from recent runs and must judge how good the agent\'s output quality is right now.',
  'Answer with one JSON object only: {"reviewScore": <0-100 integer>, "verdict": "<one or two sentences>"}.',
  'The numbers you receive are computed from real run records. Do not re-estimate them, contradict them or invent measurements. Your score is your overall judgement of output quality that those numbers cannot capture: correctness of what was produced, whether the user got what they asked for, and whether the work is reusable.',
  'Be strict: 80+ means the outputs were consistently correct and verifiable, 50-79 means usable but with real gaps, below 50 means the outputs needed rework.',
  'Never include passwords, API keys, tokens, cookies or private keys in the verdict.',
].join('\n')

function clampScore(value: unknown): number | null {
  const score = coerceScore(value)
  if (typeof score !== 'number' || !Number.isFinite(score)) return null
  return Math.min(100, Math.max(0, score))
}

function cleanLine(text: string, limit: number): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, limit)
}

function evidenceLines(runs: RunRecord[]): string {
  const lines: string[] = []
  for (const run of runs.slice(0, 8)) {
    const bits = [
      `status=${run.status}`,
      `steps=${run.steps}`,
      `tools=${run.toolCalls}/${run.toolErrors} err`,
      run.filesChanged ? `files=${run.filesChanged}` : '',
      run.checked ? 'verified=yes' : '',
      run.feedback ? `user=${run.feedback.rating}` : '',
    ].filter(Boolean)
    lines.push(`- ${bits.join(' ')} :: ${cleanLine(run.prompt, 160)}`)
  }
  return lines.length > 0 ? lines.join('\n') : '- (no recorded runs)'
}

/** 只允许白名单内的打包脚本名，杜绝"批准一次 = 执行任意命令"。 */
export function resolvePublishScript(target: QualityPublishTarget): string | null {
  if (!QUALITY_PUBLISH_TARGETS.includes(target) || target === 'none') return null
  if (!/^package:(dir|win|mac|linux)$/.test(target)) return null
  return target
}

/** 打包子进程的环境：去掉所有 Pilot 自身的凭据，避免把密钥带进构建产物。 */
function packageEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) {
    if (/^(PILOT_(API_KEY|SECRET|TOKEN)|OPENAI_API_KEY|ANTHROPIC_API_KEY)$/i.test(key)) {
      delete env[key]
    }
  }
  return env
}

function runScript(
  script: string,
  cwd: string,
  timeoutMs: number,
): Promise<PackageRunResult> {
  return new Promise((resolve) => {
    let output = ''
    const append = (chunk: Buffer | string): void => {
      output += String(chunk)
      if (output.length > 16_000) output = output.slice(-16_000)
    }
    // 用 fixed 参数数组调用包管理器，不经过 shell，脚本名来自白名单枚举。
    const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, ['run', script], {
        cwd,
        env: packageEnv(),
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ code: -1, output: error instanceof Error ? error.message : String(error) })
      return
    }
    let settled = false
    const finish = (result: PackageRunResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // ignore
      }
      finish({ code: -1, output: `${output}\n打包超时（${Math.round(timeoutMs / 1000)}s）` })
    }, timeoutMs)
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    child.on('error', (error) => finish({ code: -1, output: `${output}\n${error.message}` }))
    child.on('close', (code) => finish({ code: code ?? -1, output }))
  })
}

export class QualityService {
  private readonly busy = new Set<string>()

  constructor(private readonly options: QualityServiceOptions) {}

  private get store(): Store {
    return this.options.store
  }

  private now(): string {
    return this.options.now ? this.options.now() : new Date().toISOString()
  }

  state(workspacePath: string): QualityState {
    return this.store.qualityState(workspacePath)
  }

  /** 提示词片段：学习模式据此挑"能提升质量"的任务。 */
  promptBlock(workspacePath: string): string {
    const state = this.state(workspacePath)
    const pending = state.candidates.filter(
      (candidate) => candidate.status === 'awaiting_user' || candidate.status === 'approved',
    ).length
    return qualityPromptBlock(state.metricSet, state.baseline, pending)
  }

  /**
   * 跑一次评估。`reason` 只用于日志，便于区分手动触发与探索任务触发。
   */
  async evaluate(workspacePath: string, reason = 'manual'): Promise<QualityState> {
    if (!this.store.settings().qualityGate) {
      throw new Error('产出质量闸门未开启，请先在设置中打开。')
    }
    if (this.busy.has(workspacePath)) throw new Error('该工作区正在评估中，请稍候。')
    this.busy.add(workspacePath)
    try {
      const settings = this.store.settings()
      const state = this.state(workspacePath)
      const runs = this.store.runs(workspacePath)
      const signals = signalsFromRuns(runs)

      if (signals.runs === 0) {
        throw new Error('当前工作区还没有可评估的运行记录。')
      }

      // 1) 指标权重动态调优（每 N 次评估一次；0 表示关闭）。
      let metricSet = state.metricSet
      const evaluations = state.candidates.length + 1
      if (settings.qualityTuneEvery > 0 && evaluations % settings.qualityTuneEvery === 0) {
        const tuned = tuneMetricSet(metricSet, signals, this.now())
        if (tuned.changes.length > 0) {
          metricSet = tuned.set
          await this.store.setQualityMetricSet(metricSet)
        }
      }

      // 2) 评估模型只给 reviewScore + 结论。
      const verdict = await this.askEvaluationModel(signals, runs)

      const values: Partial<Record<QualityMetricId, number | null>> = {
        ...signals.values,
        reviewScore: verdict.reviewScore,
      }
      const score = scoreMetrics(metricSet, values, this.now())
      const baseline = state.baseline
      const comparison = compareQuality(baseline, score)
      const better = baseline === null ? false : comparison.better

      const evidence: QualityEvidence = {
        runs: signals.runs,
        failures: signals.failures,
        source: verdict.model ? `records+${verdict.selfReview ? 'self' : 'judge'}` : 'records',
        samples: signals.samples as QualityEvidence['samples'],
      }

      const log: string[] = [
        `${this.now()} 评估触发（${reason}），样本 ${signals.runs} 次运行 / ${signals.failures} 次失败`,
        `${this.now()} 指标集 v${metricSet.version}，总分 ${score.total}`,
        `${this.now()} ${comparison.reason}`,
      ]
      if (verdict.error) log.push(`${this.now()} 评估模型异常：${verdict.error}`)
      if (!verdict.model) log.push(`${this.now()} 没有可用的评估模型，reviewScore 缺失`)
      if (verdict.selfReview) log.push(`${this.now()} 评审由运行模型自己完成，不构成独立评审`)
      // Cost and scope both go in the log: a review that silently used 1 of N
      // configured judges, or that burned 40k prompt tokens, should not read as
      // "just a check".
      if (verdict.usage) {
        log.push(
          `${this.now()} 评估消耗：输入 ${verdict.usage.input} / 输出 ${verdict.usage.output} / 缓存命中 ${verdict.usage.cacheHit}，共 ${verdict.usage.calls} 次请求`,
        )
      }
      const configuredJudges = this.options.judges().length
      if (configuredJudges > 1) {
        log.push(
          `${this.now()} 已配置 ${configuredJudges} 个评估模型，本次只用第 1 个（${verdict.model}）`,
        )
      }

      const candidate: QualityCandidate = {
        id: randomUUID(),
        workspacePath,
        version: this.store.nextQualityVersion(workspacePath),
        createdAt: this.now(),
        metricVersion: metricSet.version,
        score,
        baseline,
        comparison,
        verdict: verdict.verdict,
        evidence,
        // 只有"更优"才需要用户裁决；等量或更差只留档，不打扰人。
        status: better ? 'awaiting_user' : 'recorded',
        log,
      }

      await this.store.addQualityCandidate(candidate)

      // 首次评估建立基线：以后所有"更优"都是相对它比较。
      if (!baseline) {
        await this.store.setQualityBaseline(score)
        await this.store.updateQualityCandidate(candidate.id, {
          log: [...log, `${this.now()} 建立质量基线 ${score.total} 分`],
        })
      }

      if (better) {
        this.emit(workspacePath, candidate.id, 'awaiting_user', true,
          `发现更优版本候选 #${candidate.version}：质量分 ${baseline?.total ?? 0} → ${score.total}，等待授权${this.publishHint()}`)
      } else {
        this.emit(workspacePath, candidate.id, candidate.status, false, '')
      }

      return this.state(workspacePath)
    } finally {
      this.busy.delete(workspacePath)
    }
  }

  private publishHint(): string {
    const target = this.store.settings().qualityPublishTarget
    return target === 'none'
      ? '（未配置打包目标，批准后不会自动打包）'
      : `（批准后用 pnpm ${target} 打包）`
  }

  /** 请评估模型打分；任何失败都不拦评估，只是让 reviewScore 缺失。 */
  private async askEvaluationModel(
    signals: QualitySignals,
    runs: RunRecord[],
  ): Promise<QualityVerdict> {
    const judges = this.options.judges()
    const judge = judges[0]
    const model = judge ? `${judge.label}/${judge.model}` : this.store.settings().model
    const client: ModelClient = judge ? judge.client : this.options.makeClient()
    const selfReview = judge ? !judge.external : true
    const usage = emptyJudgeUsage()

    const request: ModelRequest = {
      messages: [
        { role: 'system', content: EVALUATION_SYSTEM },
        {
          role: 'user',
          content: [
            `运行样本：${signals.runs} 次（失败 ${signals.failures} 次）`,
            `指标（0-100）：${Object.entries(signals.values)
              .map(([key, value]) => `${key}=${typeof value === 'number' ? Math.round(value) : 'n/a'}`)
              .join('，')}`,
            '最近运行：',
            evidenceLines(runs),
          ].join('\n'),
        },
      ],
      tools: [],
    }

    try {
      const response = await completeWithWatchdog(client, request)
      addJudgeUsage(usage, response.usage)
      const parsed = extractJsonObject(response.content)
      if (!parsed) {
        return { reviewScore: null, verdict: '', model, selfReview, usage, error: unparsedResponseReason(response) }
      }
      return {
        reviewScore: clampScore(parsed['reviewScore']),
        verdict: typeof parsed['verdict'] === 'string' ? cleanLine(parsed['verdict'], 600) : '',
        model,
        selfReview,
        usage,
      }
    } catch (error) {
      return {
        reviewScore: null,
        verdict: '',
        model,
        selfReview,
        ...(usage.calls > 0 ? { usage } : {}),
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /** 用户裁决。批准 = 认可新基线 + 授权打包；拒绝 = 不动基线。 */
  async decide(
    workspacePath: string,
    candidateId: string,
    decision: 'approve' | 'reject',
  ): Promise<QualityState> {
    const candidate = this.findCandidate(workspacePath, candidateId)
    if (candidate.status !== 'awaiting_user') {
      throw new Error(`该候选当前状态为 ${candidate.status}，不需要裁决。`)
    }
    const decidedAt = this.now()
    if (decision === 'reject') {
      await this.store.updateQualityCandidate(candidateId, {
        status: 'rejected',
        decidedAt,
        log: [...candidate.log, `${decidedAt} 用户拒绝，基线保持 ${candidate.baseline?.total ?? '(无)'} 分`],
      })
      this.emit(workspacePath, candidateId, 'rejected', false, '')
      return this.state(workspacePath)
    }

    const log = [
      ...candidate.log,
      `${decidedAt} 用户批准，基线更新为 ${candidate.score.total} 分`,
    ]
    await this.store.setQualityBaseline(candidate.score)
    await this.store.updateQualityCandidate(candidateId, {
      status: 'approved',
      decidedAt,
      log,
    })
    this.emit(workspacePath, candidateId, 'approved', false, '')

    // 授权后按设置直接打包；目标为 none 时只停留在"已批准"。
    if (this.store.settings().qualityPublishTarget !== 'none') {
      return this.publish(workspacePath, candidateId)
    }
    return this.state(workspacePath)
  }

  /**
   * 打包发布。三重前置：候选已批准、确实更优、目标在白名单内。
   * 任一条不满足就拒绝，绝不"先打了再问"。
   */
  async publish(workspacePath: string, candidateId: string): Promise<QualityState> {
    const candidate = this.findCandidate(workspacePath, candidateId)
    if (candidate.status !== 'approved') {
      throw new Error('只有已批准的质量候选才能打包发布。')
    }
    if (!candidate.comparison.better) {
      throw new Error('该候选未被判定为更优版本，不能发布。')
    }
    const target = this.store.settings().qualityPublishTarget
    const script = resolvePublishScript(target)
    if (!script) {
      throw new Error('未配置打包目标，请先在设置里选择打包脚本（package:win / package:mac / package:linux / package:dir）。')
    }
    if (this.busy.has(workspacePath)) throw new Error('该工作区正在评估或打包中，请稍候。')
    this.busy.add(workspacePath)

    const startedAt = this.now()
    await this.store.updateQualityCandidate(candidateId, {
      status: 'publishing',
      publishTarget: script,
      log: [...candidate.log, `${startedAt} 开始打包 pnpm ${script}`],
    })
    this.emit(workspacePath, candidateId, 'publishing', false, '')

    try {
      const runner = this.options.runPackage ?? runScript
      const result = this.options.runPackage
        ? await this.options.runPackage(target, this.options.packageRoot)
        : await runScript(
            script,
            this.options.packageRoot,
            this.options.packageTimeoutMs ?? 20 * 60 * 1000,
          )
      const finishedAt = this.now()
      const tail = result.output.trim().split(/\r?\n/).slice(-6).join('\n')
      if (result.code !== 0) {
        await this.store.updateQualityCandidate(candidateId, {
          status: 'failed',
          failure: `打包退出码 ${result.code}`,
          log: [...(this.findCandidate(workspacePath, candidateId).log), `${finishedAt} 打包失败 ${tail}`],
        })
        this.emit(workspacePath, candidateId, 'failed', true,
          `候选 #${candidate.version} 打包失败（退出码 ${result.code}），已保留原版本`)
        return this.state(workspacePath)
      }
      await this.store.updateQualityCandidate(candidateId, {
        status: 'published',
        publishedAt: finishedAt,
        log: [...(this.findCandidate(workspacePath, candidateId).log), `${finishedAt} 打包完成：pnpm ${script}`],
      })
      this.emit(workspacePath, candidateId, 'published', true,
        `候选 #${candidate.version} 已打包完成（pnpm ${script}）`)
      return this.state(workspacePath)
    } finally {
      this.busy.delete(workspacePath)
    }
  }

  /** 手动重调权重（设置里点"立即调优"）。 */
  async tune(workspacePath: string): Promise<QualityState> {
    const state = this.state(workspacePath)
    const signals = signalsFromRuns(this.store.runs(workspacePath))
    const tuned = tuneMetricSet(state.metricSet, signals, this.now())
    if (tuned.changes.length === 0) {
      throw new Error('当前各指标都在合理区间，权重无需调整。')
    }
    await this.store.setQualityMetricSet(tuned.set)
    this.emit(workspacePath, '', undefined, false, '')
    return this.state(workspacePath)
  }

  /** 重置为默认权重（用户手动回退调优结果）。 */
  async resetMetrics(): Promise<QualityState> {
    await this.store.setQualityMetricSet(defaultMetricSet())
    const workspace = this.store.activeWorkspace() ?? ''
    return this.state(workspace)
  }

  private findCandidate(workspacePath: string, candidateId: string): QualityCandidate {
    const candidate = this.state(workspacePath).candidates.find((entry) => entry.id === candidateId)
    if (!candidate) throw new Error('质量候选不存在')
    return candidate
  }

  private emit(
    workspacePath: string,
    candidateId: string,
    status: QualityCandidateStatus | undefined,
    bell: boolean,
    message: string,
  ): void {
    const event: RunEvent = {
      type: 'quality.changed',
      workspacePath,
      ...(candidateId ? { candidateId } : {}),
      ...(status ? { status } : {}),
      ...(message ? { message: message.slice(0, 300) } : {}),
      bell,
    }
    this.options.onEvent?.(event)
  }
}
