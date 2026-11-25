// 设置与外观、模型与余额、工具目录、沙箱与系统信息、日志、模块自检、质量与评审、文件挑送、反馈与引导。
// 由 index.ts 的 registerIpc 机械搬出：只把 handle 换成 ctx.handle，其余语句逐字保留。
import type { IpcContext } from '../ipc-context'
import { app, clipboard, dialog, nativeImage, session, shell } from 'electron'
import { basename } from 'node:path'
import { buildToolCatalog, countToolCalls } from '../../shared/tools-catalog'
import { crashEntry } from '../app-audit'
import { collectDiagnostics } from '../diagnostics'
import { ensureGlobalInstructions, loadProjectInstructions } from '../instructions'
import { fetchBalance } from '../billing'
import { filterLearningTools, pilotTools, RUN_SHELL } from '../agent/tools'
import { loadMcpConfig } from '../agent/mcp'
import {
  createHookRule,
  deleteHookRule,
  loadHookRulesDetailed,
  setHookRuleEnabled,
} from '../agent/hook-rules'
import { loadHookConfig } from '../agent/hooks'
import type {
  HookRuleAction,
  HookRuleEvent,
  HookRuleView,
  HookRulesReport,
} from '../../shared/hook-rules'
import { pluginCatalogTools } from '../plugins/shared'
import { localizeMain } from '../localize'
import { mkdir } from 'node:fs/promises'
import { normalizeEnvFields, FeedbackDraft } from '../../shared/feedback'
import { release } from 'node:os'
import { resolveLearningPolicy } from '../agent/learning'
import { resourceUsage } from '../resource-usage'
import { sandboxStatus } from '../sandbox'
import { sanitizeImages } from '../agent/attachments'
import { systemInfo, feedbackEnvironment } from '../system-info'
import { normalizeFindingStatus } from '../../shared/reflect'
import { testDeepSeekConnection } from '../agent/model'
import { discoverModels } from '../model-catalog'
import { workspaceRoot } from '../workspace'
import type {
  JudgeBalanceInput,
  ModelBalanceState,
  ReviewSessionInput,
  Session,
  SettingsUpdate,
  ThemeMode,
} from '../../shared/types'
import type { ModuleCheckSettings } from '../../shared/module-check'
import type { HostKind } from '../../shared/capabilities'
import type { SupervisorSettings } from '../../shared/supervisor'

export function registerSettingsIpc(ctx: IpcContext): void {

  ctx.handle('pilot:bootstrap', () => {
    const workspaces = ctx.store.workspaces()
    const activeWorkspace =
      ctx.store.activeWorkspace() ??
      workspaces[0]?.path ??
      null
    if (activeWorkspace && activeWorkspace !== ctx.store.activeWorkspace()) {
      ctx.store.setActiveWorkspace(activeWorkspace)
    }
    const sessions = activeWorkspace ? ctx.store.sessions(activeWorkspace) : []
    const storedActive = ctx.store.activeSession()
    const activeSession =
      storedActive && sessions.some((entry) => entry.id === storedActive)
        ? storedActive
        : sessions[0]?.id ?? null
    ctx.store.setActiveSession(activeSession)
    return {
      settings: ctx.store.settingsView(),
      workspaces,
      sessions,
      activeWorkspace,
      activeSession,
      version: app.getVersion(),
      platform: process.platform,
      // 桌面端带原生窗口（含右上角三按钮）；`pilot serve` 的 `app` 是 shim，
      // 它自报 `pilotHost: 'server'`，面板据此改用浏览器自己的能力。
      host: (app as unknown as { pilotHost?: HostKind }).pilotHost ?? 'desktop',
    }
  })


  ctx.handle('pilot:settings-update', async (input: SettingsUpdate) => {
    const view = await ctx.store.updateSettings(input)
    if (input.theme) {
      ctx.applyTheme(view.theme)
    }
    // Any key, endpoint or role change can move the primary account, so the
    // cached provider balance must be fetched again.
    if (
      input.apiKey !== undefined ||
      input.baseUrl !== undefined ||
      input.model !== undefined ||
      input.modelResources !== undefined ||
      input.sessionModelId !== undefined ||
      input.evaluationModelIds !== undefined ||
      input.reviewModelId !== undefined ||
      input.judgeProviders !== undefined
    ) {
      ctx.billing.invalidate()
    }
    // Keep the companion's relay rooms in sync when the address is changed
    // through the generic settings channel as well.
    if (input.relayUrl !== undefined && ctx.companion) {
      await ctx.companion.setRelayUrl(input.relayUrl)
    }
    // 「设置 → 网页服务」：开关或端口变了就对齐监听（mode control 会把两次
    // 连着来的保存串行化，端口没变时不重启）。
    if (input.serverMode !== undefined || input.serverPort !== undefined) {
      await ctx.companionMode?.syncFromSettings()
    }
    return view
  })


  ctx.handle('pilot:model-billing', async (refresh?: boolean) => ctx.billing.report(Boolean(refresh)))

  // 反思：手动跑一次、读历史、清空历史、发测试邮件。
  ctx.handle('pilot:reflect-now', async () => {
    const service = ctx.reflect
    if (!service) throw new Error('Reflection service is not running')
    return service.run({ trigger: 'manual' })
  })

  ctx.handle('pilot:reflection-reports', async () => ctx.store.reflectionReports())

  ctx.handle('pilot:reflection-reports-clear', async () => {
    await ctx.store.clearReflectionReports()
  })

  // 结论的处理状态：done 表示代码已改过、dismissed 表示不打算做，两者都会进下一轮的
  // 历史证据，让反思不再重提。
  ctx.handle(
    'pilot:reflection-finding-status',
    async (reportId?: string, findingId?: string, status?: string) => {
      if (!reportId || !findingId) return null
      return ctx.store.setReflectionFindingStatus(
        reportId,
        findingId,
        normalizeFindingStatus(status),
      )
    },
  )

  ctx.handle('pilot:reflection-mail-test', async (to?: string) => {
    const service = ctx.reflect
    if (!service) return { ok: false, error: 'Reflection service is not running' }
    return service.sendTestMail((to ?? '').trim())
  })


  ctx.handle('pilot:judge-balance', async (input?: JudgeBalanceInput): Promise<ModelBalanceState> => {
    const target = input?.providerId ? ctx.store.judgeTarget(input.providerId) : null
    if (input?.providerId && !target) {
      return {
        ok: false,
        available: false,
        entries: [],
        source: '',
        fetchedAt: new Date().toISOString(),
        error: 'missing-key',
        errorDetail: '该模型资源还没有保存可用的密钥。',
      }
    }
    const baseUrl = input?.baseUrl?.trim() || target?.baseUrl || ''
    const model = input?.model?.trim() || target?.model || ''
    if (!baseUrl) {
      return {
        ok: false,
        available: false,
        entries: [],
        source: '',
        fetchedAt: new Date().toISOString(),
        error: 'unsupported',
        errorDetail: '请先填写 Base URL。',
      }
    }
    return fetchBalance({
      apiKey: input?.apiKey?.trim() || target?.apiKey || '',
      baseUrl,
      model,
    })
  })


  ctx.handle(
    'pilot:test-connection',
    async (input?: { apiKey?: string; baseUrl?: string; model?: string; providerId?: string }) => {
      const settings = ctx.store.settingsView()
      // A stored reviewer tests with its own saved key and endpoint.
      const target = input?.providerId ? ctx.store.judgeTarget(input.providerId) : null
      if (input?.providerId && !target) {
        return { ok: false, message: '该模型资源还没有保存可用的密钥。' }
      }
      const key = input?.apiKey?.trim() || target?.apiKey || ctx.store.getApiKey() || ''
      return testDeepSeekConnection({
        apiKey: key,
        baseUrl: input?.baseUrl?.trim() || target?.baseUrl || settings.baseUrl,
        model: input?.model?.trim() || target?.model || settings.model,
      })
    },
  )


  // 「模型」页的模型名下拉：用用户自己的密钥问厂商要最新清单。
  //
  // 三条规矩：拉不到不报错（降级成缓存/内置清单 + note，不能挡住保存），
  // 不把主账号的密钥发给任意地址（只有同一条地址或该资源自己的密钥才用），
  // 以及返回体里永远不带密钥本身。
  ctx.handle(
    'pilot:models-discover',
    async (input?: {
      baseUrl?: string
      apiKey?: string
      current?: string
      providerId?: string
      refresh?: boolean
    }) => {
      const settings = ctx.store.settingsView()
      const target = input?.providerId ? ctx.store.judgeTarget(input.providerId) : null
      const baseUrl = input?.baseUrl?.trim() || target?.baseUrl || settings.baseUrl
      const sameAsPrimary =
        Boolean(baseUrl) &&
        baseUrl.trim().replace(/\/+$/, '').toLowerCase() ===
          (settings.baseUrl ?? '').trim().replace(/\/+$/, '').toLowerCase()
      // 主账号的密钥只在「问的就是主账号那条地址」时兜底，否则用户随便写个
      // 地址就能把主 key 发出去。
      const apiKey =
        input?.apiKey?.trim() || target?.apiKey || (sameAsPrimary ? ctx.store.getApiKey() : '') || ''
      return discoverModels({
        baseUrl,
        apiKey,
        current: input?.current ?? '',
        refresh: input?.refresh === true,
      })
    },
  )


  ctx.handle('pilot:set-theme', async (theme: ThemeMode) => {
    const view = await ctx.store.updateSettings({ theme })
    ctx.applyTheme(view.theme)
  })


  // Settings previews an appearance before saving. Painting the window chrome
  // here keeps the title bar from disagreeing with the content while the user
  // hovers the options; `null` restores the saved theme without persisting.
  ctx.handle('pilot:preview-theme', (input: { theme: ThemeMode } | null) => {
    ctx.applyTheme(input?.theme ?? ctx.store.settingsView().theme)
  })


  ctx.handle('pilot:pick-folder', async (title?: string) => {
    if (!ctx.mainWindow) return null
    const result = await dialog.showOpenDialog(ctx.mainWindow, {
      title: typeof title === 'string' && title ? title : 'Choose a workspace',
      buttonLabel: 'Open workspace',
      properties: ['openDirectory', 'createDirectory'],
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  })


  ctx.handle('pilot:pick-images', async () => {
    if (!ctx.mainWindow) return []
    const english = ctx.store.uiLocale() === 'en'
    const result = await dialog.showOpenDialog(ctx.mainWindow, {
      title: english ? 'Select images' : '选择图片',
      buttonLabel: english ? 'Add' : '添加',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: english ? 'Images' : '图片',
          extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'],
        },
      ],
    })
    if (result.canceled) return []
    const images: string[] = []
    for (const file of result.filePaths.slice(0, 3)) {
      const image = nativeImage.createFromPath(file)
      if (image.isEmpty()) continue
      images.push(ctx.encodeMessageImage(image))
    }
    return sanitizeImages(images)
  })


  /**
   * Copy files the user picked on this computer into the session workspace.
   * The renderer sends the workspace path of its own session, so it is matched
   * against the store instead of being trusted.
   */
  ctx.handle('pilot:pick-files', async (workspacePath: unknown) => {
    if (!ctx.mainWindow) return []
    const requested = typeof workspacePath === 'string' ? workspacePath.trim() : ''
    if (!requested) throw new Error('当前会话没有工作区，无法上传文件')
    const known = ctx.store.workspaces().find((entry) => ctx.pathKey(entry.path) === ctx.pathKey(requested))
    if (!known) throw new Error('文件只能上传到已经打开的工作区')
    const english = ctx.store.uiLocale() === 'en'
    const result = await dialog.showOpenDialog(ctx.mainWindow, {
      title: english ? 'Upload files to the workspace' : '上传文件到工作区',
      buttonLabel: english ? 'Upload' : '上传',
      properties: ['openFile', 'multiSelections'],
    })
    if (result.canceled) return []
    return ctx.importUploadBatch(known.path, { paths: result.filePaths.slice(0, 3), blobs: [] })
  })

  ctx.handle('pilot:tools-catalog', async (sessionId: string) => {
    const session = ctx.store.session(sessionId)
    if (!session) throw new Error('Session not found')
    const settings = ctx.store.settings()
    // Same filters the runner applies, so the panel lists what a run would
    // actually offer instead of every tool that exists in code.
    const builtin = filterLearningTools(
      settings.shellMode
        ? pilotTools
        : pilotTools.filter((tool) => tool.name !== RUN_SHELL),
      resolveLearningPolicy(settings).enabled,
    )
    const servers = await loadMcpConfig(session.workspacePath).catch(() => ({}))
    return buildToolCatalog({
      builtin,
      dynamic: await (await ctx.toolRegistryFor(session.workspacePath)).list().catch(() => []),
      mcpServers: Object.keys(servers),
      mcpEnabled: settings.mcpEnabled === true,
      // Same host the run uses, so a disabled plugin drops its rows too.
      plugins: await pluginCatalogTools(session.workspacePath),
      // 「按调用次数排序」用的就是这次会话的记录，不跨会话累加。
      calls: countToolCalls(session.messages),
    })
  })

  // 左下角「工具」用的是工作区视角：把该工作区所有会话的调用次数合并，
  // 于是同一个工具在任意会话里被用过多少次要一眼看得出来。
  ctx.handle('pilot:tools-catalog-workspace', async (workspacePath: string) => {
    const settings = ctx.store.settings()
    const builtin = filterLearningTools(
      settings.shellMode
        ? pilotTools
        : pilotTools.filter((tool) => tool.name !== RUN_SHELL),
      resolveLearningPolicy(settings).enabled,
    )
    const servers = await loadMcpConfig(workspacePath).catch(() => ({}))
    const calls: Record<string, number> = {}
    for (const session of ctx.store.sessions(workspacePath)) {
      const full = ctx.store.session(session.id)
      if (!full) continue
      for (const [name, count] of Object.entries(countToolCalls(full.messages))) {
        calls[name] = (calls[name] ?? 0) + count
      }
    }
    return buildToolCatalog({
      builtin,
      dynamic: await (await ctx.toolRegistryFor(workspacePath)).list().catch(() => []),
      mcpServers: Object.keys(servers),
      mcpEnabled: settings.mcpEnabled === true,
      plugins: await pluginCatalogTools(workspacePath),
      calls,
    })
  })

  // Writing through the main process avoids the renderer permission prompt
  // and any secure-context restrictions. The renderer still has a browser
  // fallback, but this path is the one that always works in the desktop app.
  ctx.handle('pilot:clipboard-write', (text: unknown): boolean => {
    if (typeof text !== 'string' || text.length === 0) return false
    if (text.length > 50_000_000) throw new Error('要复制的内容过大')
    clipboard.writeText(text)
    return true
  })

  ctx.handle('pilot:review-create', async (input: ReviewSessionInput) => {
    if (!input || typeof input.workspacePath !== 'string' || !input.workspacePath.trim()) {
      throw new Error('复盘需要一个主工作区')
    }
    const primary = await workspaceRoot(input.workspacePath)
    if (!ctx.store.workspaces().some((workspace) => ctx.pathKey(workspace.path) === ctx.pathKey(primary))) {
      throw new Error('请先打开主工作区，再创建复盘会话')
    }
    const roots = await ctx.resolveReviewRoots(primary, input.roots)
    const sessions = ctx.normalizeReviewSessions(input.sessions)
    const objective =
      typeof input.objective === 'string' ? input.objective.trim().slice(0, 4_000) : ''
    const workspace = ctx.store.workspaces().find((entry) => ctx.pathKey(entry.path) === ctx.pathKey(primary))
    const title = objective
      ? `复盘：${objective.replace(/\s+/g, ' ').slice(0, 40)}`
      : `复盘 · ${workspace?.name ?? basename(primary)}`
    return ctx.store.createSession(primary, {
      kind: 'review',
      title,
      review: {
        roots,
        sessions,
        ...(objective ? { objective } : {}),
      },
    })
  })

  ctx.handle('pilot:review-handoff', (sessionId: string) => ctx.runner.handoffReview(sessionId))

  ctx.handle('pilot:module-check-state', async () => {
    await ctx.moduleCheck.load()
    return ctx.moduleCheck.snapshot()
  })

  ctx.handle('pilot:module-check-discover', () => ctx.moduleCheck.discover())

  ctx.handle('pilot:module-check-run', (moduleIds?: string[]) => {
    if (moduleIds !== undefined && !Array.isArray(moduleIds)) {
      throw new Error('模块列表格式不正确')
    }
    return ctx.moduleCheck.run(
      Array.isArray(moduleIds) ? moduleIds.filter((id) => typeof id === 'string') : undefined,
      'manual',
    )
  })

  ctx.handle('pilot:module-check-settings', (input: Partial<ModuleCheckSettings>) =>
    ctx.moduleCheck.updateSettings(input ?? {}),
  )

  ctx.handle(
    'pilot:module-check-accept',
    async (input: { reportId: string; riskIds: string[]; selfModify?: boolean }) => {
      if (!input || typeof input.reportId !== 'string') throw new Error('缺少自检报告 id')
      // 默认只生成提案：只有渲染层显式传 true 才会真的改自身源码。
      return ctx.moduleCheck.accept(input.reportId, input.riskIds, { selfModify: input.selfModify === true })
    },
  )

  // 自主优化闭环。三个通道都只做「读状态 / 跑一轮 / 改设置」，
  // 真正的改动发生在那一轮创建的普通会话里（走沙箱与审批）。
  ctx.handle('pilot:supervisor-state', async () => {
    await ctx.supervisor.load()
    return ctx.supervisor.snapshot()
  })

  ctx.handle('pilot:supervisor-run', async () => {
    await ctx.supervisor.load()
    const round = await ctx.supervisor.run('manual')
    // 设置可能因本轮而变（例如预算用完），统一在轮末重排定时器。
    ctx.supervisor.restart()
    return round
  })

  ctx.handle('pilot:supervisor-settings', (input: Partial<SupervisorSettings>) =>
    ctx.supervisor.updateSettings(input ?? {}),
  )

  ctx.handle('pilot:project-instructions', (workspacePath: string) =>
    loadProjectInstructions(workspacePath).then((files) =>
      files.map(({ name, bytes, truncated }) => ({ name, bytes, truncated })),
    ),
  )

  ctx.handle('pilot:feedback-submit', async (input: FeedbackDraft, workspacePath?: string) => {
    // Environment values are re-read here rather than trusted from the renderer:
    // the dialog only chooses which lines are attached.
    const [info, sandbox] = await Promise.all([systemInfo(workspacePath), sandboxStatus()])
    const context = {
      version: app.getVersion(),
      platform: `${process.platform} ${release()}`,
      locale: ctx.store.uiLocale(),
      environment: feedbackEnvironment(info, sandbox, normalizeEnvFields(input.environment)),
    }
    return ctx.feedback.submit(input, context)
  })

  ctx.handle('pilot:feedback-folder', async () => {
    await mkdir(ctx.feedback.dir, { recursive: true })
    const error = await shell.openPath(ctx.feedback.dir)
    if (error) throw new Error('无法打开反馈文件夹')
  })


  ctx.handle('pilot:sandbox-status', async () => {
    const status = await sandboxStatus()
    return { ...status, detail: localizeMain(status.detail, ctx.store.uiLocale()) }
  })

  // The renderer passes the active workspace so the reported volume is the one
  // builds and installs will actually write to. Nothing identifying is read.
  ctx.handle('pilot:system-info', async (workspacePath?: string) => systemInfo(workspacePath))

  // 顶栏资源条：每次调用会做一次约 120ms 的 CPU 采样，所以由渲染进程按自己的
  // 节奏轮询（窗口隐藏时停），不在渲染期调用。
  ctx.handle('pilot:resource-usage', async (workspacePath?: string) => resourceUsage(workspacePath))

  // 日志读取：诊断面板与 CLI 共用，只返回已脱敏的元数据记录。
  ctx.handle('pilot:logs-recent', async (limit?: number) => (ctx.appLog ? ctx.appLog.recent(limit) : []))

  ctx.handle('pilot:logs-dir', () => ctx.appLog?.dir ?? '')

  // 运行日志面板：一次拿到事件循环健康、副线队列、进行中的运行与日志聚合，
  // 免得渲染进程为了拼一张图连发四个 IPC。
  ctx.handle('pilot:diagnostics-snapshot', async (limit?: number) => collectDiagnostics(limit))

  ctx.handle('pilot:logs-open', async () => {
    if (!ctx.appLog) return
    await mkdir(ctx.appLog.dir, { recursive: true })
    const error = await shell.openPath(ctx.appLog.dir)
    if (error) throw new Error('无法打开日志文件夹')
  })

  // 渲染进程未捕获异常：白屏类问题唯一的现场，转发到主进程落盘。
  ctx.handle(
    'pilot:renderer-error',
    async (input?: { summary?: string; stack?: string; source?: string }) => {
      ctx.log(
        crashEntry({
          event: 'renderer-error',
          source: 'renderer',
          detail: {
            summary: String(input?.summary ?? '').slice(0, 240),
            stack: String(input?.stack ?? '').slice(0, 400),
            origin: String(input?.source ?? '').slice(0, 200),
          },
        }),
      )
    },
  )

  // 质量闸门：评估、裁决、发布、手动调优。全部经同一道 busy 门，避免并发评估
  // 把同一份基线写成两个值。
  ctx.handle('pilot:quality-evaluate', (path: string) => ctx.runner.quality.evaluate(path, 'manual'))

  ctx.handle(
    'pilot:quality-decide',
    (path: string, candidateId: string, decision: 'approve' | 'reject') =>
      ctx.runner.quality.decide(path, candidateId, decision),
  )

  ctx.handle('pilot:quality-publish', (path: string, candidateId: string) =>
    ctx.runner.quality.publish(path, candidateId),
  )

  ctx.handle('pilot:quality-tune', (path: string) => ctx.runner.quality.tune(path))

  ctx.handle(
    'pilot:feedback-set',
    async (sessionId: string, runId: string, rating: 'up' | 'down', note?: string) => {
      const session = ctx.store.session(sessionId)
      if (!session) throw new Error('Session not found')
      const run = await ctx.store.setFeedback(session.workspacePath, runId, {
        rating,
        ...(note ? { note } : {}),
        at: new Date().toISOString(),
      })
      if (!run) throw new Error('Run not found')
      ctx.broadcast({ type: 'session.changed', sessionId })
      if (ctx.store.settings().autoReflect && ctx.store.getApiKey()) {
        void ctx.runner.evolution
          .reflect(session.workspacePath, runId, false)
          .then((entries) => {
            if (entries.length > 0) {
              ctx.broadcast({ type: 'memory.changed', workspacePath: session.workspacePath })
            }
          })
          .catch(() => undefined)
      }
    },
  )

  ctx.handle('pilot:global-instructions-open', async () => {
    const file = await ensureGlobalInstructions(app.getPath('userData'), ctx.store.uiLocale())
    const error = await shell.openPath(file)
    if (error) throw new Error(error)
    return file
  })


  ctx.handle('pilot:tools-list', async (path: string) => (await ctx.toolRegistryFor(path)).list())

  ctx.handle(
    'pilot:tool-enabled',
    async (path: string, source: 'workspace' | 'global', name: string, enabled: boolean) => {
      const tools = await (await ctx.toolRegistryFor(path)).setEnabled(source, name, enabled === true)
      ctx.broadcast({ type: 'tools.changed', workspacePath: path })
      return tools
    },
  )

  ctx.handle('pilot:tool-remove', async (path: string, source: 'workspace' | 'global', name: string) => {
    const tools = await (await ctx.toolRegistryFor(path)).remove(source, name)
    ctx.broadcast({ type: 'tools.changed', workspacePath: path })
    return tools
  })

  ctx.handle('pilot:tool-promote', async (path: string, name: string) => {
    // An explicit user action in the settings panel: the user is the one deciding
    // the tool is generic, so the "ran successfully once" gate does not apply.
    // The hardcoded-workspace-path check still does.
    const tools = await (await ctx.toolRegistryFor(path)).promote(name, { force: true })
    ctx.broadcast({ type: 'tools.changed', workspacePath: path })
    return tools
  })

  // 声明式 hook 规则：`.pilot/hooks/*.md` 与 `.pilot/hooks.json` 命令钩子。
  // 设置页只看、只改开关与内容，不提供「运行规则」的入口——规则本身不能执行命令。
  const hookRulesReport = async (path: string): Promise<HookRulesReport> => {
    const detail = await loadHookRulesDetailed(path).catch(() => ({ rules: [], broken: [] }))
    const config = await loadHookConfig(path).catch(() => ({
      pre_tool: [],
      post_edit: [],
      stop: [],
    }))
    return {
      enabled: ctx.store.settings().hooksEnabled === true,
      rules: detail.rules,
      commands: {
        preTool: config.pre_tool.length,
        postEdit: config.post_edit.length,
        stop: config.stop.length,
      },
      broken: detail.broken,
    }
  }

  ctx.handle('pilot:hook-rules', async (path?: string) => {
    const root = path?.trim() || ctx.store.activeWorkspace()
    if (!root) return { enabled: false, rules: [], commands: { preTool: 0, postEdit: 0, stop: 0 }, broken: [] }
    return hookRulesReport(root)
  })

  ctx.handle(
    'pilot:hook-rule-enabled',
    async (path: string, source: string, enabled: boolean) => {
      await setHookRuleEnabled(path, source, enabled === true)
      return hookRulesReport(path)
    },
  )

  ctx.handle('pilot:hook-rule-delete', async (path: string, source: string) => {
    await deleteHookRule(path, source)
    return hookRulesReport(path)
  })

  ctx.handle(
    'pilot:hook-rule-create',
    async (
      path: string,
      input: {
        name: string
        event: HookRuleEvent
        pattern: string
        action: HookRuleAction
        message: string
      },
    ): Promise<HookRuleView | null> => {
      const rule = await createHookRule(path, input)
      return rule ?? null
    },
  )
}
