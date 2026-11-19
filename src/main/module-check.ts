import type { Dirent } from 'node:fs'
import { readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunEvent } from '../shared/types'
import type { AppLogEntry } from './app-log'
import {
  DEFAULT_MODULE_CHECK_SETTINGS,
  MODULE_CHECK_HISTORY_LIMIT,
  MODULE_PROPOSAL_LIMIT,
  buildProposal,
  buildReport,
  evaluateModule,
  isGeneratedPath,
  isSourceFile,
  isTestFile,
  sanitizeModuleCheckState,
  type ModuleCheckReport,
  type ModuleCheckSettings,
  type ModuleCheckState,
  type ModuleCheckSummary,
  type ModuleCheckTrigger,
  type ModuleFileFact,
  type ModuleProposal,
  type ModuleRisk,
  type ModuleTarget,
} from '../shared/module-check'

/**
 * 模块自检服务：扫描 → 规则 → 报告 → 用户确认 → 编码会话。
 *
 * 边界：
 * - 只读文件，不写入工作区；唯一会落盘的是 userData 下的 `module-check.json`。
 * - 自检本身不调用模型，因此可以按小时级频率跑而不产生费用。
 * - 自检/内视**从不主动改代码**：它们的产出只有报告与「改造提案」。
 *   只有用户在界面上显式勾选「自改」时，才会创建一个普通会话（沙箱、审批
 *   策略与用户手写任务完全一致）；会话结束后自动重跑一次自检刷新提案。
 */

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'dist-electron',
  'out',
  'build',
  'release',
  'coverage',
  '.build',
  '.turbo',
  '.next',
  '.cache',
  '.archive',
  '.tmp-promo',
  'vendor',
  'tmp',
  'unpackage',
])

const TEXT_FILE =
  /\.(ts|tsx|js|jsx|mjs|cjs|json|md|vue|css|scss|html|yml|yaml|prisma|py|go|rs|sh|ps1|toml|ini|txt)$/i

const MAX_MODULES = 60
const MAX_FILES_PER_MODULE = 4000
const MAX_TEXT_BYTES = 200_000
const MAX_TOTAL_TEXT_BYTES = 12_000_000
const MAX_DEPTH = 8

export interface ModuleCheckDeps {
  /** userData 目录：报告与设置存在这里。 */
  userDataDir: string
  /**
   * 内置源码根目录：自检只扫 Pilot 自带、可自改的那一份源码。
   *
   * 不再跟随「当前活动工作区」，也没有「指定文件夹」这一步：安装版是
   * userData 里的自身源码副本，开发态就是当前源码目录。
   */
  sourceRoot: () => string | Promise<string>
  /** 把事件送到渲染进程与手机端（与定时任务同一通道）。 */
  emit: (event: RunEvent) => void
  /**
   * 创建一个编码会话并发送首条指令。
   *
   * `queued` 表示指令没发出（例如本机还没配 API Key），已经放进会话队列，
   * 用户配好之后直接发即可，不至于丢掉刚刚确认的清单。
   */
  startSession: (
    workspacePath: string,
    prompt: string,
  ) => Promise<{ sessionId: string; queued?: boolean }>
  /** 应用级日志（可选）：只记元数据，不记正文。 */
  log?: (entry: AppLogEntry) => void
}

interface WalkEntry {
  /** 相对工作区根目录，`/` 分隔。 */
  path: string
  bytes: number
}

function toPosix(value: string): string {
  return value.split('\\').join('/')
}

function shouldSkipDir(name: string): boolean {
  if (SKIP_DIRS.has(name)) return true
  // 临时目录与打包残留：`tmp-20250101`、`.tmp-foo` 之类。
  return /^\.?tmp[-.]/i.test(name) || name === '.manbu'
}

/** 有并发上限的 map：发现模块时多个顶层目录可以同时统计。 */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await mapper(items[index] as T)
    }
  })
  await Promise.all(workers)
  return results
}

export class ModuleCheckService {
  private state: ModuleCheckState = {
    settings: { ...DEFAULT_MODULE_CHECK_SETTINGS },
    history: [],
    decisions: [],
    proposals: [],
  }

  private loaded = false
  private running = false
  private timer: NodeJS.Timeout | null = null
  /** 自改会话 id → 提案 id；会话结束后用它把提案重新生成一遍。 */
  private readonly pendingRefresh = new Map<string, string>()
  /** 仅在一次扫描期间生效：自改后自动重扫时用提案当时的源码目录。 */
  private scanWorkspace: string | null = null
  private proposalSeq = 0

  constructor(private readonly deps: ModuleCheckDeps) {}

  private file(): string {
    return join(this.deps.userDataDir, 'module-check.json')
  }

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = await readFile(this.file(), 'utf8')
      this.state = sanitizeModuleCheckState(JSON.parse(raw))
    } catch {
      this.state = sanitizeModuleCheckState(null)
    }
  }

  /** 返回给渲染进程的完整状态。深拷贝，避免调用方改到内部对象。 */
  snapshot(): ModuleCheckState {
    return JSON.parse(JSON.stringify(this.state)) as ModuleCheckState
  }

  /**
   * 手机端用的轻量状态：不复制 history 里的历史报告。
   *
   * `snapshot()` 会把最多 20 份完整报告一起序列化，报告里又带着风险证据；
   * 手机端只显示最新一份，深拷贝整份历史只会让状态读取变慢。这里只把
   * 需要的字段按引用交出去，调用方只读、不修改。
   */
  summary(): ModuleCheckSummary {
    const state = this.state
    return {
      settings: state.settings,
      ...(state.lastRunAt ? { lastRunAt: state.lastRunAt } : {}),
      ...(state.nextRunAt ? { nextRunAt: state.nextRunAt } : {}),
      ...(state.lastReport ? { lastReport: state.lastReport } : {}),
      historyCount: state.history.length,
      decisions: state.decisions,
      proposals: state.proposals,
    }
  }

  private async persist(): Promise<void> {
    const payload = JSON.stringify(this.state, null, 2)
    const file = this.file()
    const temp = `${file}.tmp`
    await writeFile(temp, payload, 'utf8')
    await rename(temp, file)
  }

  async updateSettings(input: Partial<ModuleCheckSettings>): Promise<ModuleCheckState> {
    await this.load()
    const next = sanitizeModuleCheckState({
      ...this.state,
      settings: { ...this.state.settings, ...input },
    })
    this.state = next
    await this.persist()
    this.restart()
    return this.snapshot()
  }

  /** 扫描根目录：一次扫描期间固定为当时的内置源码目录。 */
  private async scanRoot(): Promise<string> {
    return this.scanWorkspace ?? (await this.deps.sourceRoot())
  }

  /**
   * 发现可勾选的模块：内置源码的顶层目录（外加根目录下直接放源码时的 `root`）。
   *
   * 只按顶层划分是刻意的：模块粒度太细（如 `client/src/main`）会让列表里出现
   * 十几个互相包含的条目，勾选变得难以理解；而具体问题位置已经在每条风险的
   * 证据里给到文件与行号。
   */
  async discover(): Promise<ModuleTarget[]> {
    const workspace = await this.scanRoot()
    const out: ModuleTarget[] = []
    let entries: Dirent[]
    try {
      entries = await readdir(workspace, { withFileTypes: true })
    } catch {
      return []
    }
    const rootFiles = entries.filter((entry) => entry.isFile())
    if (rootFiles.some((entry) => isSourceFile(entry.name))) {
      const root = await this.measure(workspace, '', false)
      if (root) out.push(root)
    }
    // 顶层目录并行统计，最多同时走 8 个；超过上限的目录先截断，避免为
    // 了给 60 个模块排序而把成千上万个无关目录都遍历一遍。
    const dirs = entries
      .filter((entry) => entry.isDirectory() && !shouldSkipDir(entry.name))
      .slice(0, MAX_MODULES * 2)
    const measured = await mapLimit(dirs, 8, (entry) =>
      this.measure(join(workspace, entry.name), entry.name, true),
    )
    for (const target of measured) {
      if (target) out.push(target)
    }
    return out
      .filter((target) => target.files > 0)
      .sort((left, right) => right.sourceFiles - left.sourceFiles)
      .slice(0, MAX_MODULES)
  }

  /** 只统计、不读取文本，用于模块列表的体积展示。 */
  private async measure(
    abs: string,
    relDir: string,
    recursive: boolean,
  ): Promise<ModuleTarget | null> {
    const files = await this.walk(abs, relDir, { readText: false, shallow: !recursive })
    if (files.length === 0) return null
    const sources = files.filter((file) => isSourceFile(file.path))
    const tests = files.filter((file) => isTestFile(file.path))
    return {
      id: this.moduleId(relDir),
      name: relDir || '/',
      path: relDir,
      files: files.length,
      sourceFiles: sources.length,
      testFiles: tests.length,
      lines: 0,
    }
  }

  private moduleId(relDir: string): string {
    return relDir ? relDir.split('/').join(':') : 'root'
  }

  private async walk(
    abs: string,
    relDir: string,
    options: { readText: boolean; shallow?: boolean; budget?: { text: number } },
  ): Promise<ModuleFileFact[]> {
    const out: ModuleFileFact[] = []
    let textBudget = options.budget?.text ?? MAX_TOTAL_TEXT_BYTES
    const visit = async (dirAbs: string, dirRel: string, depth: number): Promise<void> => {
      if (out.length >= MAX_FILES_PER_MODULE || depth > MAX_DEPTH) return
      let entries: Dirent[]
      try {
        entries = await readdir(dirAbs, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (out.length >= MAX_FILES_PER_MODULE) return
        const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name
        const childAbs = join(dirAbs, entry.name)
        if (entry.isDirectory()) {
          if (shouldSkipDir(entry.name) || options.shallow) continue
          await visit(childAbs, rel, depth + 1)
          continue
        }
        if (!entry.isFile()) continue
        // 发现模块时只统计文件数，不需要对每个文件做 stat；大工程里这能省掉
        // 成千上万次串行系统调用，模块列表可以立刻出来。
        let bytes = 0
        if (options.readText) {
          try {
            bytes = (await stat(childAbs)).size
          } catch {
            continue
          }
        }
        const fact: ModuleFileFact = { path: toPosix(rel), lines: 0, bytes }
        const readable =
          options.readText &&
          textBudget > 0 &&
          !isGeneratedPath(toPosix(rel)) &&
          bytes <= MAX_TEXT_BYTES &&
          (TEXT_FILE.test(entry.name) || isSourceFile(entry.name) || entry.name === 'package.json')
        if (readable) {
          try {
            const text = await readFile(childAbs, 'utf8')
            fact.text = text
            fact.lines = text.split(/\r?\n/).length
            textBudget -= Buffer.byteLength(text, 'utf8')
          } catch {
            // 读不了的二进制/锁文件按无文本处理。
          }
        }
        out.push(fact)
      }
    }
    await visit(abs, relDir, 0)
    return out
  }

  private moduleTargets(): Promise<ModuleTarget[]> {
    return this.discover()
  }

  async run(
    moduleIds?: string[],
    trigger: ModuleCheckTrigger = 'manual',
    options: { workspace?: string } = {},
  ): Promise<ModuleCheckReport> {
    await this.load()
    if (this.running) throw new Error('自检正在进行中，请等待本次扫描结束')
    const workspace = options.workspace ?? (await this.scanRoot())
    this.running = true
    this.scanWorkspace = workspace
    const startedAt = new Date().toISOString()
    try {
      const targets = await this.moduleTargets()
      const requested =
        moduleIds && moduleIds.length > 0
          ? targets.filter((target) => moduleIds.includes(target.id))
          : targets
      if (requested.length === 0) throw new Error('内置源码里没有发现可自检的模块')

      const risks: ModuleRisk[] = []
      const scannedTargets: ModuleTarget[] = []
      let scannedFiles = 0
      let scannedLines = 0
      const budget = { text: MAX_TOTAL_TEXT_BYTES }
      for (const target of requested) {
        const files = await this.walk(join(workspace, target.path), target.path, {
          readText: true,
          budget,
        })
        const lines = files.reduce((total, file) => total + file.lines, 0)
        scannedFiles += files.length
        scannedLines += lines
        scannedTargets.push({ ...target, files: files.length, lines })
        risks.push(...evaluateModule({ id: target.id, name: target.name, files }))
      }

      const report = buildReport({
        id: `mc_${Date.now().toString(36)}`,
        trigger,
        workspace,
        startedAt,
        finishedAt: new Date().toISOString(),
        targets: scannedTargets,
        risks,
        scannedFiles,
        scannedLines,
      })

      this.state.lastReport = report
      this.state.lastRunAt = report.finishedAt
      this.state.history = [report, ...this.state.history].slice(0, MODULE_CHECK_HISTORY_LIMIT)
      this.state.settings = { ...this.state.settings, modules: requested.map((target) => target.id) }
      await this.persist()
      this.restart()

      const high = report.risks.filter((risk) => risk.severity === 'high').length
      this.deps.log?.({
        area: 'module-check',
        event: 'scan.completed',
        detail: {
          reportId: report.id,
          trigger,
          workspace,
          files: report.scannedFiles,
          risks: report.risks.length,
          high,
          score: report.score,
        },
      })
      this.deps.emit({
        type: 'notice',
        level: high > 0 ? 'warn' : 'info',
        message:
          high > 0
            ? `模块自检完成：${report.risks.length} 个风险点，其中 ${high} 个高优先级，得分 ${report.score}/100`
            : `模块自检完成：${report.risks.length} 个风险点，得分 ${report.score}/100`,
      })
      return report
    } finally {
      this.running = false
      this.scanWorkspace = null
    }
  }

  /**
   * 用户审核后确认：**只生成改造提案**，除非显式勾选 `selfModify`。
   *
   * - `selfModify !== true`：落一份提案（可阅读的清单 + 指令文本）并返回，
   *   不创建会话、不碰任何文件。内视与自检都走这条路。
   * - `selfModify === true`：提案 + 普通编码会话，改动仍走该会话的沙箱与审批；
   *   会话结束后由 `noteRunSettled()` 自动重跑自检刷新提案。
   */
  async accept(
    reportId: string,
    riskIds: string[],
    options: { selfModify?: boolean } = {},
  ): Promise<{
    sessionId?: string
    prompt: string
    queued: boolean
    selfModify: boolean
    proposalId: string
  }> {
    await this.load()
    const report = this.state.history.find((item) => item.id === reportId) ?? this.state.lastReport
    if (!report) throw new Error('找不到对应的自检报告')
    if (!Array.isArray(riskIds) || riskIds.length === 0) throw new Error('请先勾选要优化的风险点')
    const risks = report.risks.filter((risk) => riskIds.includes(risk.id))
    if (risks.length === 0) throw new Error('勾选的风险点已不在报告里，请重新自检')
    if (risks.every((risk) => risk.manual)) {
      throw new Error('选中的问题都需要人工处理，自检不会自动修改它们')
    }
    // 报告里记的是扫描时的内置源码目录；旧报告没有该字段时退回当前源码根。
    const workspace = report.workspace || (await this.scanRoot())
    const selfModify = options.selfModify === true
    const at = new Date().toISOString()
    const proposal = buildProposal({
      id: this.nextProposalId(),
      report,
      risks,
      createdAt: at,
      selfModify,
    })

    if (!selfModify) {
      this.recordProposal(proposal, at)
      await this.persist()
      this.deps.log?.({
        area: 'module-check',
        event: 'proposal.created',
        detail: {
          proposalId: proposal.id,
          reportId: report.id,
          risks: proposal.riskIds.length,
          workspace,
          selfModify: false,
        },
      })
      this.deps.emit({
        type: 'notice',
        level: 'info',
        message: `已生成改造提案（${proposal.riskIds.length} 项），未修改任何文件；勾选「自改」后才会真正执行。`,
      })
      return { prompt: proposal.prompt, queued: false, selfModify: false, proposalId: proposal.id }
    }

    const created = await this.deps.startSession(workspace, proposal.prompt)
    proposal.sessionId = created.sessionId
    this.recordProposal(proposal, at)
    await this.persist()
    // 同一份内置源码：用户主动发起改造后，结束时自动重跑自检刷新提案。
    this.pendingRefresh.set(created.sessionId, proposal.id)
    this.deps.log?.({
      area: 'self-modify',
      event: 'proposal.accepted',
      detail: {
        proposalId: proposal.id,
        reportId: report.id,
        risks: proposal.riskIds.length,
        sessionId: created.sessionId,
        workspace,
        selfModify: true,
      },
    })
    return {
      sessionId: created.sessionId,
      prompt: proposal.prompt,
      queued: created.queued === true,
      selfModify: true,
      proposalId: proposal.id,
    }
  }

  /**
   * 自改会话结束时调用：自动重跑一次自检，用新报告刷新提案。
   *
   * 重扫是只读的，因此不会被当成「自检主动触发自改」；它只是把同一份内置源码
   * 的新状态重新收拢成一份新提案，让用户看到改完之后还剩什么问题。
   */
  async noteRunSettled(sessionId: string): Promise<ModuleCheckReport | null> {
    let proposalId = this.pendingRefresh.get(sessionId)
    if (!proposalId) {
      // 进程重启后内存映射会丢，此时从已落盘的决策里找回待刷新的提案。
      await this.load()
      proposalId = this.pendingProposalFor(sessionId)
      if (!proposalId) return null
    }
    this.pendingRefresh.delete(sessionId)
    await this.load()
    const riskIds = this.state.proposals.find((item) => item.id === proposalId)?.riskIds ?? []
    const sourcePath = this.state.proposals.find((item) => item.id === proposalId)?.workspace
    try {
      const report = await this.run(undefined, 'self-modify', {
        ...(sourcePath ? { workspace: sourcePath } : {}),
      })
      await this.refreshProposal(proposalId, report, riskIds)
      return report
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.deps.log?.({
        area: 'self-modify',
        event: 'refresh.failed',
        level: 'warn',
        detail: { sessionId, proposalId, error: message },
      })
      this.deps.emit({
        type: 'notice',
        level: 'warn',
        message: `自改已结束，但自动重跑自检失败：${message}`,
      })
      return null
    }
  }

  private pendingProposalFor(sessionId: string): string | undefined {
    const decision = this.state.decisions.find(
      (item) => item.sessionId === sessionId && item.selfModify && item.proposalId,
    )
    if (!decision?.proposalId) return undefined
    const proposal = this.state.proposals.find((item) => item.id === decision.proposalId)
    return proposal && !proposal.refreshedAt ? proposal.id : undefined
  }

  private recordProposal(proposal: ModuleProposal, at: string): void {
    this.state.proposals = [proposal, ...this.state.proposals].slice(0, MODULE_PROPOSAL_LIMIT)
    this.state.decisions = [
      {
        reportId: proposal.reportId,
        riskIds: proposal.riskIds,
        at,
        selfModify: proposal.selfModify,
        proposalId: proposal.id,
        ...(proposal.sessionId ? { sessionId: proposal.sessionId } : {}),
      },
      ...this.state.decisions,
    ].slice(0, MODULE_CHECK_HISTORY_LIMIT)
    this.deps.log?.({
      area: 'module-check',
      event: 'proposal.recorded',
      detail: { proposalId: proposal.id, selfModify: proposal.selfModify, risks: proposal.riskIds.length },
    })
  }

  /** 用新报告把旧提案标为已刷新，并生成一份、针对同样问题的新提案。 */
  private async refreshProposal(
    proposalId: string,
    report: ModuleCheckReport,
    riskIds: string[],
  ): Promise<void> {
    const at = new Date().toISOString()
    const previous = this.state.proposals.find((item) => item.id === proposalId)
    if (previous) previous.refreshedAt = at
    // 优先保留用户原本勾选且仍然存在的问题；全部消失时改用新报告里的可自动处理项。
    const kept = report.risks.filter((risk) => riskIds.includes(risk.id) && !risk.manual)
    const risks = kept.length > 0 ? kept : report.risks.filter((risk) => !risk.manual).slice(0, 8)
    let refreshed: ModuleProposal | null = null
    if (risks.length > 0) {
      refreshed = buildProposal({
        id: this.nextProposalId(),
        report,
        risks,
        createdAt: at,
        selfModify: false,
      })
      this.state.proposals = [refreshed, ...this.state.proposals].slice(0, MODULE_PROPOSAL_LIMIT)
    }
    await this.persist()
    this.deps.log?.({
      area: 'self-modify',
      event: 'proposal.refreshed',
      detail: {
        previousProposalId: proposalId,
        proposalId: refreshed?.id ?? null,
        reportId: report.id,
        remaining: report.risks.length,
        risks: refreshed?.riskIds.length ?? 0,
        score: report.score,
      },
    })
    this.deps.emit({
      type: 'notice',
      level: 'info',
      message:
        risks.length > 0
          ? `自改已结束，已重跑自检并刷新提案：还剩 ${report.risks.length} 个风险点（得分 ${report.score}/100）。`
          : `自改已结束，已重跑自检：原本勾选的问题已全部消失（得分 ${report.score}/100）。`,
    })
  }

  private nextProposalId(): string {
    this.proposalSeq += 1
    return `mp_${Date.now().toString(36)}_${this.proposalSeq}`
  }

  /** 启动定期自检。关闭时不挂定时器，避免无意义的唤醒。 */
  start(): void {
    this.restart()
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private restart(): void {
    this.stop()
    const { enabled, intervalHours } = this.state.settings
    if (!enabled) {
      if (this.state.nextRunAt) {
        delete this.state.nextRunAt
        void this.persist().catch(() => undefined)
      }
      return
    }
    const intervalMs = Math.max(1, intervalHours) * 60 * 60 * 1000
    const next = new Date(Date.now() + intervalMs)
    this.state.nextRunAt = next.toISOString()
    void this.persist().catch(() => undefined)
    this.timer = setTimeout(() => {
      void this.run(undefined, 'schedule')
        .catch((error: unknown) => {
          this.deps.emit({
            type: 'notice',
            level: 'warn',
            message: `定期自检失败：${error instanceof Error ? error.message : String(error)}`,
          })
        })
        .finally(() => {
          this.restart()
        })
    }, intervalMs)
    // 自检不该阻止应用退出。
    this.timer.unref?.()
  }
}
