// 超级 Pilot：Pilot 自己出问题时用来救自己的第二条命。
//
// 它和主引擎的区别只有三点，但这三点决定了它在事故里还能不能用：
//
//   1. **独立数据面**：自己的 userData 子目录、自己的 store、自己的回退点服务。
//      主 store 损坏、主回退点串行门被长任务占满、主副线队列排了三十个任务，
//      都碰不到它。模型通道（endpoint + key）从主 store 复制一份并落盘，
//      所以主 store 读不出来时它仍然能发请求。
//   2. **不排队、不让路**：它不注册到 `BackgroundScheduler`，也不参与回退点维护。
//      用户按下发送就立刻开跑，中间没有「等会话空闲」这一层。
//   3. **全权限**：会话固定「全部自动 + 完全自主档」，读工作区外、写自身配置、
//      联网都不再逐次确认，工作区就是自身源码，改完能直接构建验证。
//
// 它**不能**绕过 JS 单线程：如果主进程事件循环被同步死循环堵住，超级 Pilot 一样卡。
// 那种情况的正确出路是设置页的「运行日志」（看事件循环延迟与副线队列）加上这里的
// `rescue()`（取消所有运行、放掉等待中的审批），以及重启应用。这条边界写在这里，
// 免得后来的人以为它有魔法。
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createEngine, type Engine } from '../core/engine'
import { Store } from './store'
import type { AppLogEntry } from './app-log'
import type { RunEvent } from '../shared/types'
import type {
  SuperPilotMessage,
  SuperPilotRescueResult,
  SuperPilotStatus,
} from '../shared/super'
import {
  AUTONOMY_MIN_STEPS,
  AUTONOMY_MIN_TOKEN_BUDGET,
  autonomyBlockers,
  autonomyPolicy,
} from '../shared/autonomy'

/** 页面轮询与推送共用的一份状态：只含可读字段，不含任何密钥。 */
export type { SuperPilotMessage, SuperPilotRescueResult, SuperPilotStatus }

export interface SuperPilotOptions {
  userDataDir: string
  /** 自身源码目录；拿不到时退回数据面下的空工作区。 */
  selfSource: () => Promise<string>
  /** 主 store：只用来复制模型通道，读失败就跳过。 */
  sourceStore: () => Store | null
  log: (entry: AppLogEntry) => void
  /** 事件出口：只有超级窗口收到，不广播给主窗口与手机。 */
  emit: (event: RunEvent) => void
  packageRoot: string
  /**
   * 主引擎上的抢救动作，由宿主注入。
   *
   * 本模块刻意不 import `app-state`：它必须在主引擎装配失败时也能独立工作，
   * 一旦反向依赖宿主状态，主引擎坏掉就等于它自己也坏掉。所以「取消所有运行」
   * 「放掉待批审批」这类只有宿主拿得到的东西，全部从这里进来。
   */
  hostActions?: () => { label: string; run: () => Promise<string> | string }[]
}

const SESSION_TITLE = '超级 Pilot（应急）'

export class SuperPilot {
  private engine: Engine | null = null
  private booting: Promise<Engine> | null = null
  private sessionId = ''
  private activeRunId: string | null = null
  private lastError = ''
  private startedAt = ''
  private inheritedFromHost = false
  private readonly dataDir: string
  private workspace = ''

  constructor(private readonly options: SuperPilotOptions) {
    this.dataDir = join(options.userDataDir, 'super-pilot')
    this.startedAt = new Date().toISOString()
  }

  /**
   * 装配（或复用）独立引擎。永远不抛：失败把错误记进 `lastError`，
   * 页面照常显示，用户能看到原因并点「重试」——这正是它和主引擎的区别。
   */
  async ensure(): Promise<Engine | null> {
    if (this.engine) return this.engine
    if (this.booting) return this.booting.catch(() => null)
    this.booting = this.boot()
    try {
      return await this.booting
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.options.log({
        area: 'super-pilot',
        event: 'boot.failed',
        level: 'error',
        detail: { message: this.lastError.slice(0, 300) },
      })
      return null
    } finally {
      this.booting = null
    }
  }

  private async boot(): Promise<Engine> {
    this.lastError = ''
    await mkdir(this.dataDir, { recursive: true })
    this.workspace = await this.resolveWorkspace()
    const store = new Store(this.dataDir)
    await store.load()
    // 模型通道：主 store 能读就同步一份到自己的盘上；读不出来就用上次同步的。
    // 这一步是它「主引擎坏了还能发请求」的全部秘密，不要在失败时清空自己的配置。
    const source = this.safeSourceStore()
    if (source) {
      try {
        await store.inheritModelChannelFrom(source)
        this.inheritedFromHost = true
      } catch (error) {
        this.inheritedFromHost = false
        this.options.log({
          area: 'super-pilot',
          event: 'channel.inherit_failed',
          level: 'warn',
          detail: { message: (error instanceof Error ? error.message : String(error)).slice(0, 200) },
        })
      }
    } else {
      this.inheritedFromHost = false
    }
    await this.applyRescueSettings(store)
    if (!store.workspaces().some((workspace) => workspace.path === this.workspace)) {
      await store.addWorkspace(this.workspace, { activate: true })
    }
    const engine = createEngine({
      store,
      dataDir: this.dataDir,
      publish: (event) => this.onEvent(event),
      packageRoot: this.options.packageRoot,
      // 不做全树扫描、不装监听：应急引擎的快照必须便宜。
      checkpoint: { watch: false, fastPathMinFiles: 0 },
    })
    this.engine = engine
    this.sessionId = await this.ensureSession(engine)
    this.options.log({
      area: 'super-pilot',
      event: 'boot.ready',
      level: 'info',
      detail: { workspace: this.workspace, inherited: this.inheritedFromHost },
    })
    return engine
  }

  private safeSourceStore(): Store | null {
    try {
      return this.options.sourceStore()
    } catch {
      return null
    }
  }

  private async resolveWorkspace(): Promise<string> {
    try {
      const path = (await this.options.selfSource()).trim()
      if (path) return path
    } catch (error) {
      this.options.log({
        area: 'super-pilot',
        event: 'workspace.self_source_unavailable',
        level: 'warn',
        detail: { message: (error instanceof Error ? error.message : String(error)).slice(0, 200) },
      })
    }
    const fallback = join(this.dataDir, 'workspace')
    await mkdir(fallback, { recursive: true })
    return fallback
  }

  /**
   * 固定档位。用户在主设置里可能选了手动审批、关了完全自主、把步数压到 3，
   * 这些都只描述日常会话；应急通道必须是「能动手」的那一档，否则它连自己
   * 的源码都改不了。写在自己的数据面里，不污染主设置。
   */
  private async applyRescueSettings(store: Store): Promise<void> {
    const settings = store.settings()
    const tokens = Math.max(settings.maxTokens, AUTONOMY_MIN_TOKEN_BUDGET)
    const steps = Math.max(settings.maxSteps, AUTONOMY_MIN_STEPS)
    await store.updateSettings({
      defaultApprovalMode: 'auto',
      fullAutonomy: true,
      maxTokens: tokens,
      maxSteps: steps,
      // 自身配置写入（技能 / 记忆 / 动态工具 / 钩子）走这里。
      selfSourceMode: 'custom',
      selfSourceCustomPath: this.workspace,
    })
  }

  private async ensureSession(engine: Engine): Promise<string> {
    const current = this.sessionId ? engine.store.session(this.sessionId) : undefined
    if (current) return current.id
    const created = await engine.store.createSession(this.workspace, { title: SESSION_TITLE })
    // createSession 不接受审批模式：会话建好后再钉一次，避免继承到默认的手动档。
    await engine.store.updateSession(created.id, { approvalMode: 'auto' })
    return created.id
  }

  private onEvent(event: RunEvent): void {
    if (event.type === 'run.started') this.activeRunId = event.runId
    if (event.type === 'run.completed' || event.type === 'run.failed') {
      if (!event.runId || event.runId === this.activeRunId) this.activeRunId = null
    }
    if (event.type === 'run.failed') this.lastError = event.message
    this.options.emit(event)
  }

  async status(): Promise<SuperPilotStatus> {
    const engine = await this.ensure()
    if (!engine) {
      return {
        state: 'failed',
        dataDir: this.dataDir,
        workspace: this.workspace || this.dataDir,
        model: '',
        baseUrl: '',
        approvalMode: 'auto',
        autonomy: { active: false, blockers: ['engine-unavailable'] },
        inheritedFromHost: this.inheritedFromHost,
        sessionId: '',
        activeRunId: null,
        lastError: this.lastError || '超级 Pilot 未能启动',
        startedAt: this.startedAt,
      }
    }
    const view = engine.store.settingsView()
    const input = {
      fullAutonomy: view.fullAutonomy,
      approvalMode: view.defaultApprovalMode,
      maxTokens: view.maxTokens,
      maxSteps: view.maxSteps,
    }
    const policy = autonomyPolicy(input)
    const blockers = autonomyBlockers(input).map((blocker) => BLOCKER_LABEL[blocker] ?? blocker)
    const running = Boolean(this.activeRunId)
    return {
      state: running ? 'running' : 'ready',
      dataDir: this.dataDir,
      workspace: this.workspace,
      model: view.model,
      baseUrl: view.baseUrl,
      approvalMode: view.defaultApprovalMode,
      autonomy: { active: policy.active, blockers },
      inheritedFromHost: this.inheritedFromHost,
      sessionId: this.sessionId,
      activeRunId: this.activeRunId,
      lastError: this.lastError,
      startedAt: this.startedAt,
    }
  }

  /**
   * 主引擎装配失败时由宿主记一笔。
   *
   * 不改状态机：应急引擎可能还没 boot，用户点开发送时才真正去起。这里只保证
   * 「状态页 / 应急窗口能看见启动是哪一步炸的」，而不是只剩一个白屏的主界面。
   */
  noteHostFailure(message: string): void {
    this.lastError = message
    this.options.log({
      area: 'super-pilot',
      event: 'host.startup_failed',
      level: 'error',
      detail: { message: message.slice(0, 300) },
    })
  }

  async messages(): Promise<SuperPilotMessage[]> {
    const engine = await this.ensure()
    if (!engine || !this.sessionId) return []
    const session = engine.store.session(this.sessionId)
    if (!session) return []
    return session.messages
      .filter((message) => message.role !== 'system' && !message.internal)
      .map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content.slice(0, 8_000),
        createdAt: message.createdAt,
        ...(message.isError ? { isError: true } : {}),
        ...(message.name ? { name: message.name } : {}),
      }))
  }

  /** 发送一条指令。失败一律返回错误串，绝不抛给 IPC 之外的调用方。 */
  async send(prompt: string): Promise<{ ok: boolean; error?: string }> {
    const text = prompt.trim()
    if (!text) return { ok: false, error: '指令为空' }
    const engine = await this.ensure()
    if (!engine) return { ok: false, error: this.lastError || '超级 Pilot 未就绪' }
    try {
      this.sessionId = await this.ensureSession(engine)
      await engine.runner.sendMessage(this.sessionId, text, 'queue')
      return { ok: true }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.options.log({
        area: 'super-pilot',
        event: 'send.failed',
        level: 'error',
        detail: { message: this.lastError.slice(0, 300) },
      })
      return { ok: false, error: this.lastError }
    }
  }

  async cancel(): Promise<void> {
    if (!this.engine || !this.sessionId) return
    try {
      await this.engine.runner.cancelRun(this.sessionId)
    } catch (error) {
      this.options.log({
        area: 'super-pilot',
        event: 'cancel.failed',
        level: 'warn',
        detail: { message: (error instanceof Error ? error.message : String(error)).slice(0, 200) },
      })
    }
    this.activeRunId = null
  }

  /** 开一个新会话：上一轮真的卡死时，这是最省事的「脱身」按钮。 */
  async reset(): Promise<string> {
    const engine = await this.ensure()
    if (!engine) return ''
    await this.cancel().catch(() => undefined)
    const created = await engine.store.createSession(this.workspace, { title: SESSION_TITLE })
    await engine.store.updateSession(created.id, { approvalMode: 'auto' })
    this.sessionId = created.id
    this.lastError = ''
    return created.id
  }

  /**
   * 一键抢救：只做「放开卡住的东西」，不改用户的业务数据。
   *
   * 每条动作单独记账，一条失败不影响下一条 —— 抢救时最怕的就是第一个动作抛错、
   * 后面更重要的动作没跑到。
   */
  async rescue(): Promise<SuperPilotRescueResult> {
    const actions: SuperPilotRescueResult['actions'] = []
    const record = async (label: string, task: () => Promise<string> | string): Promise<void> => {
      try {
        actions.push({ label, ok: true, detail: await task() })
      } catch (error) {
        actions.push({
          label,
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        })
      }
    }

    // 宿主动作先跑：取消主引擎的运行是抢救的核心，超级 Pilot 自己的运行最后停。
    for (const action of this.options.hostActions?.() ?? []) {
      await record(action.label, action.run)
    }

    await record('停止超级 Pilot 自己的运行', async () => {
      await this.cancel()
      return '已停止'
    })

    return { at: new Date().toISOString(), actions }
  }

  async dispose(): Promise<void> {
    await this.cancel().catch(() => undefined)
    this.engine?.checkpoints.dispose()
    this.engine = null
    this.sessionId = ''
  }
}

/** 未满足条件的可读版本；页面直接把这几行显示给用户。 */
const BLOCKER_LABEL: Record<string, string> = {
  disabled: '完全自主档未开启',
  'manual-mode': '审批模式不是「全部自动」',
  'token-budget': `token 预算低于 ${AUTONOMY_MIN_TOKEN_BUDGET.toLocaleString()}`,
  'step-cap': `最大步数低于 ${AUTONOMY_MIN_STEPS}`,
  'engine-unavailable': '独立引擎未能启动',
}
