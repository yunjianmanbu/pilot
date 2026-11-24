import {
  countSelfCheck,
  type SelfCheckCounts,
  type SelfCheckGroup,
  type SelfCheckItem,
  type SelfCheckReport,
  type SelfCheckStatus,
} from '../shared/self-check'
import { DISK_LOW_BYTES, formatBytes } from '../shared/system-info'
import type {
  DynamicToolInfo,
  ModelResource,
  PluginOverview,
  SandboxStatus,
  ScheduledTask,
  SettingsView,
  SystemInfo,
  UpdateState,
  WorkspaceSummary,
} from '../shared/types'
import { OVERSIZED_MEDIUM, type ModuleCheckState } from '../shared/module-check'
import {
  SPLIT_DECISIONS,
  normalizeSplitPath,
  splitDecisionIndex,
  splitDecisionKindLabel,
  splitScanCounts,
  splitScanIndex,
} from '../shared/split-decisions'
import { ignoredAutoAllowRules } from './agent/permissions'

/**
 * 内视的取样与判定。
 *
 * 这里不碰文件系统，也不接受工作区路径参数：所有素材由调用方（主进程）从
 * 正在运行的服务实例里取，取不到的来源记在 `errors` 里，判定阶段据此报
 * 「异常 + 原因」，而不是当成正常。这样同一份逻辑可以在单测里用假数据跑。
 */

export interface SelfCheckContext {
  version: string
  packaged: boolean
  appPath: string
  userDataPath: string
  /** 当前打开的工作区；只有「按工作区存放」的模块才看它。 */
  currentWorkspace: string | null
  settings: SettingsView | null
  workspaces: WorkspaceSummary[]
  modelResources: ModelResource[]
  scheduled: ScheduledTask[]
  moduleCheck: ModuleCheckState | null
  sandbox: SandboxStatus | null
  update: UpdateState | null
  systemInfo: SystemInfo | null
  feedback: { dir: string; pending: number | null }
  dynamicTools: DynamicToolInfo[]
  plugins: PluginOverview | null
  mcpServers: Record<string, unknown> | null
  /** 采集阶段失败的来源：id → 原因。 */
  errors: Record<string, string>
  /** 取样时间，测试可固定。 */
  now: number
}

interface ProbeResult {
  status: SelfCheckStatus
  detail: string
  facts: string[]
  hint?: string
}

interface Probe {
  id: string
  group: SelfCheckGroup
  title: string
  run: (context: SelfCheckContext) => ProbeResult
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 权限规则有多种写法，只数数组型字段，坏形状不会让内视崩掉。 */
function ruleCount(rules: unknown): number {
  if (!rules || typeof rules !== 'object') return 0
  let total = 0
  for (const value of Object.values(rules as Record<string, unknown>)) {
    if (Array.isArray(value)) total += value.length
  }
  return total
}

const NO_WORKSPACE: ProbeResult = {
  status: 'off',
  detail: '未打开工作区',
  facts: ['这个模块按工作区存放，打开一个工作区后再内视即可读到。'],
}

const PROBES: Probe[] = [
  {
    id: 'runtime',
    group: 'runtime',
    title: '运行时',
    run: (context) => {
      const versions = process.versions
      const node = versions.node ?? '—'
      return {
        status: 'ok',
        detail: `Electron ${versions.electron ?? '—'} · Node ${node}`,
        facts: [
          `应用版本 ${context.version}`,
          `Electron ${versions.electron ?? '—'}`,
          `Node ${node}（模块 ABI ${versions.modules ?? '—'}）`,
          `Chromium ${versions.chrome ?? '—'}`,
          `平台 ${process.platform}/${process.arch}`,
          `安装形态 ${context.packaged ? '打包版' : '源码运行'}`,
          `程序目录 ${context.appPath}`,
        ],
      }
    },
  },
  {
    id: 'system',
    group: 'runtime',
    title: '系统资源',
    run: (context) => {
      const info = context.systemInfo
      if (!info) {
        return {
          status: 'broken',
          detail: '没有读到系统信息',
          facts: [],
          hint: '重新内视一次；仍然失败说明资源采集本身出了问题。',
        }
      }
      const disk = info.disk
      const low =
        disk !== null &&
        (disk.low || (disk.freeBytes !== null && disk.freeBytes < DISK_LOW_BYTES))
      return {
        status: low ? 'warn' : 'ok',
        detail: low
          ? '剩余磁盘低于 2 GB，安装依赖或构建可能因 ENOSPC 失败'
          : `内存 ${formatBytes(info.memoryFreeBytes)} 可用`,
        facts: [
          `系统 ${info.platform} ${info.osRelease}（${info.arch}）`,
          `CPU ${info.cpuModel} × ${info.cpuCount}`,
          `内存 ${formatBytes(info.memoryFreeBytes)} / ${formatBytes(info.memoryTotalBytes)} 可用`,
          disk
            ? `磁盘 ${formatBytes(disk.freeBytes)} / ${formatBytes(disk.totalBytes)} 可用（${disk.path}）`
            : '磁盘 未读到',
        ],
        ...(low ? { hint: '先清理磁盘再跑构建或安装；命令执行前也会自动提示一次。' } : {}),
      }
    },
  },
  {
    id: 'model',
    group: 'model',
    title: '模型接入',
    run: (context) => {
      const resources = context.modelResources
      const usable = resources.filter((resource) => resource.enabled && resource.hasKey)
      const selected = context.settings?.model?.trim() || context.settings?.baseUrl?.trim() || ''
      const facts = [
        `端点 ${resources.length} 个，可调用 ${usable.length} 个`,
        `会话模型 ${selected || '未选择'}`,
        ...resources.slice(0, 6).map((resource) => {
          const state = [
            resource.enabled ? '启用' : '停用',
            resource.hasKey ? '有密钥' : '缺密钥',
          ].join(' · ')
          return `${resource.label || resource.id} · ${resource.model || '未填模型'} · ${state}`
        }),
      ]
      if (usable.length > 0) {
        return { status: 'ok', detail: `${usable.length} 个端点可调用`, facts }
      }
      return {
        status: resources.length > 0 ? 'warn' : 'off',
        detail: resources.length > 0 ? '端点都不可调用（停用或缺密钥）' : '还没有配置模型端点',
        facts,
        hint: '在设置 → 模型里填 Base URL、模型名与密钥，然后点“测试连接”。',
      }
    },
  },
  {
    id: 'approval',
    group: 'model',
    title: '审批与权限',
    run: (context) => {
      const settings = context.settings
      if (!settings) {
        return { status: 'broken', detail: '没有读到设置', facts: [] }
      }
      const rules = settings.permissionRules
      const ignored = ignoredAutoAllowRules(rules)
      const facts = [
        `默认模式 ${settings.defaultApprovalMode}`,
        `权限规则 ${ruleCount(rules)} 条`,
        `信任命令 ${settings.trustedCommands.length} 条`,
        `沙箱模式 ${settings.sandboxMode ?? '—'}`,
        ...ignored.slice(0, 5).map((rule) => `匹配不到命令的放行规则 ${rule}`),
      ]
      return {
        status: ignored.length > 0 ? 'warn' : 'ok',
        detail:
          ignored.length > 0
            ? `${ignored.length} 条放行规则匹配不到命令`
            : `${settings.defaultApprovalMode} · ${ruleCount(rules)} 条规则`,
        facts,
        ...(ignored.length > 0
          ? { hint: '这些规则永不生效，等于你以为放行了、其实每次都要点允许；删掉或改写它们。' }
          : {}),
      }
    },
  },
  {
    id: 'sandbox',
    group: 'exec',
    title: '沙箱',
    run: (context) => {
      const sandbox = context.sandbox
      if (!sandbox) {
        return { status: 'broken', detail: '没有读到沙箱状态', facts: [] }
      }
      return {
        status: sandbox.available ? 'ok' : 'warn',
        detail: `${sandbox.backend} · ${sandbox.mode}${sandbox.available ? '' : '（不可用）'}`,
        facts: [
          `模式 ${sandbox.mode}`,
          `后端 ${sandbox.backend}`,
          `可阻断出网 ${sandbox.networkIsolation ? '是' : '否'}`,
          `说明 ${sandbox.detail || '—'}`,
        ],
        ...(sandbox.available
          ? {}
          : { hint: '命令仍能执行，但没有沙箱隔离；设置页的沙箱行会给出具体原因。' }),
      }
    },
  },
  {
    id: 'shell',
    group: 'exec',
    title: '命令执行',
    run: (context) => {
      const settings = context.settings
      if (!settings) {
        return { status: 'broken', detail: '没有读到设置', facts: [] }
      }
      return {
        status: settings.shellMode ? 'ok' : 'off',
        detail: settings.shellMode
          ? `内联命令已开启（${settings.shellInterpreter}）`
          : '内联命令未开启，只能用 run_command 逐条执行',
        facts: [
          `内联命令 ${settings.shellMode ? '开启' : '关闭'}`,
          `解释器 ${settings.shellInterpreter}`,
        ],
      }
    },
  },
  {
    id: 'dynamicTools',
    group: 'ext',
    title: '自写工具',
    run: (context) => {
      if (!context.currentWorkspace) return NO_WORKSPACE
      const tools = context.dynamicTools
      const approved = tools.filter((tool) => tool.approved).length
      const failing = tools.filter((tool) => tool.failureCount > 0 && Boolean(tool.lastError))
      const facts = tools
        .slice(0, 6)
        .map(
          (tool) =>
            `${tool.name} v${tool.version} · ${tool.approved ? '已批准' : '待批准'} · 成功 ${tool.successCount} / 失败 ${tool.failureCount}${tool.lastError ? ` · 最近错误 ${tool.lastError}` : ''}`,
        )
      if (tools.length === 0) {
        return {
          status: 'off',
          detail: '这个工作区还没有自写工具',
          facts: ['自写工具由模型生成、经你批准后才会被调用。'],
        }
      }
      return {
        status: failing.length > 0 ? 'warn' : 'ok',
        detail: `${tools.length} 个工具 · ${approved} 已批准 · ${tools.length - approved} 待批准`,
        facts,
        ...(approved < tools.length
          ? { hint: '未批准的工具不会被调用；在工具面板里审阅后批准。' }
          : {}),
      }
    },
  },
  {
    id: 'mcp',
    group: 'ext',
    title: 'MCP 服务',
    run: (context) => {
      if (!context.currentWorkspace) return NO_WORKSPACE
      const servers = context.mcpServers ?? {}
      const names = Object.keys(servers)
      return {
        status: names.length > 0 ? 'ok' : 'off',
        detail: names.length > 0 ? `${names.length} 个服务已配置` : '没有配置 MCP 服务',
        facts:
          names.length > 0
            ? names.map((name) => `服务 ${name}`)
            : ['工作区的 .pilot/mcp.json 里没有服务定义'],
        ...(names.length > 0
          ? { hint: '这里只读配置文件；实际连接在每次运行时建立。' }
          : {}),
      }
    },
  },
  {
    id: 'plugins',
    group: 'ext',
    title: '插件',
    run: (context) => {
      if (!context.currentWorkspace) return NO_WORKSPACE
      const overview = context.plugins
      if (!overview) {
        return { status: 'broken', detail: '没有读到插件列表', facts: [] }
      }
      const enabled = overview.plugins.filter((plugin) => plugin.enabled).length
      const valid = overview.plugins.map(
        (plugin) => `${plugin.id} v${plugin.version} · ${plugin.enabled ? '已授权' : '未授权'}`,
      )
      return {
        status: overview.invalid.length > 0 ? 'warn' : enabled > 0 ? 'ok' : 'off',
        detail: `${overview.plugins.length} 个插件 · ${enabled} 个已授权`,
        facts: [
          `插件目录 ${overview.pluginsDir}`,
          `数量上限 ${overview.maxPlugins}`,
          ...valid.slice(0, 6),
          ...overview.invalid.slice(0, 5).map((entry) => `无法加载 ${entry.id}：${entry.error}`),
        ],
        ...(overview.invalid.length > 0
          ? { hint: '这些目录的 plugin.json 没通过校验，修好或移走。' }
          : {}),
      }
    },
  },
  {
    id: 'store',
    group: 'data',
    title: '数据存储',
    run: (context) => ({
      status: context.settings ? 'ok' : 'warn',
      detail: `${context.workspaces.length} 个工作区 · ${
        context.settings ? '设置已加载' : '设置未加载'
      }`,
      facts: [
        `数据目录 ${context.userDataPath}`,
        `工作区 ${context.workspaces.length} 个`,
        `模型端点 ${context.modelResources.length} 个`,
        `当前工作区 ${context.currentWorkspace || '未打开'}`,
      ],
      ...(context.settings ? {} : { hint: '设置文件没有读出来，改动可能不会被保存。' }),
    }),
  },
  {
    id: 'scheduler',
    group: 'data',
    title: '定时任务',
    run: (context) => {
      const tasks = context.scheduled
      const due = tasks.filter((task) => {
        const at = Date.parse(task.nextRunAt)
        return Number.isFinite(at) && at <= context.now
      }).length
      return {
        status: due > 0 ? 'warn' : tasks.length > 0 ? 'ok' : 'off',
        detail:
          tasks.length > 0
            ? `${tasks.length} 个任务${due > 0 ? `（${due} 个已到期）` : ''}`
            : '没有定时任务',
        facts: tasks.slice(0, 5).map((task) => `下次执行 ${task.nextRunAt}`),
        ...(due > 0 ? { hint: '到期任务应被调度器接手；长期不到期不执行说明调度没在跑。' } : {}),
      }
    },
  },
  {
    id: 'feedback',
    group: 'data',
    title: '反馈',
    run: (context) => {
      const pending = context.feedback.pending
      if (pending === null) {
        return {
          status: 'warn',
          detail: '读不到反馈目录',
          facts: [`目录 ${context.feedback.dir}`],
          hint: '反馈写入会失败；检查这个目录的权限。',
        }
      }
      return {
        status: 'ok',
        detail: `${pending} 份反馈已存档`,
        facts: [`目录 ${context.feedback.dir}`],
      }
    },
  },
  {
    id: 'update',
    group: 'data',
    title: '更新',
    run: (context) => {
      const update = context.update
      if (!update) {
        return { status: 'broken', detail: '没有读到更新状态', facts: [] }
      }
      const next = update.release?.version
      const broken = update.status === 'error'
      return {
        status: update.status === 'disabled' ? 'off' : broken ? 'warn' : 'ok',
        detail:
          update.status === 'disabled'
            ? '更新已关闭'
            : `当前 ${update.currentVersion}${next ? ` · 可用 ${next}` : ''}`,
        facts: [
          `状态 ${update.status}`,
          `当前版本 ${update.currentVersion}`,
          `最近检查 ${update.checkedAt ?? '—'}`,
          `可直接安装 ${update.canInstall ? '是' : '否'}`,
          ...(update.message ? [`消息 ${update.message}`] : []),
        ],
      }
    },
  },
  {
    id: 'moduleCheck',
    group: 'data',
    title: '工作区体检',
    run: (context) => {
      const state = context.moduleCheck
      if (!state) {
        return { status: 'off', detail: '体检服务未启用', facts: [] }
      }
      const report = state.lastReport
      const risks = report?.risks.length ?? 0
      const pending = state.proposals.filter((item) => !item.refreshedAt).length
      const large = report?.largeFiles ?? []
      // `decided` 是后加的字段：旧报告里缺它就会读成 false。用决策表兑底，
      // 免得已决策的文件在内视里又被列成“待决策”。
      const scannedDecisions = report?.decisions ?? []
      const decisions = scannedDecisions.length > 0 ? scannedDecisions : SPLIT_DECISIONS
      const decisionIndex = splitDecisionIndex(decisions)
      const isDecided = (path: string, flag: boolean | undefined): boolean =>
        flag === true || decisionIndex.has(normalizeSplitPath(path))
      const undecided = large.filter((file) => !isDecided(file.path, file.decided))
      // 判据码是量出来的事实：报告里带了就直接用，没带（旧报告）就查实测表。
      const scanIndex = splitScanIndex()
      const verdictOf = (path: string): string | undefined =>
        large.find((file) => file.path === path && file.verdict)?.verdict ?? scanIndex.get(path)?.verdict
      const measured = undecided.filter((file) => verdictOf(file.path))
      const unmeasured = undecided.filter((file) => !verdictOf(file.path))
      const distribution = splitScanCounts()
        .map((entry) => `${entry.code}=${entry.count}`)
        .join(' ')
      return {
        status: !report ? 'off' : risks > 0 ? 'warn' : 'ok',
        detail: report
          ? `${risks} 条风险（${state.lastRunAt ?? '—'}）`
          : '还没有跑过工作区体检',
        facts: [
          `定期检查 ${state.settings.enabled ? `开启，每 ${state.settings.intervalHours} 小时` : '关闭'}`,
          `历史报告 ${state.history.length} 份`,
          // 内视只读：这里只说提案有几份，不会因此改任何文件。
          `改造提案 ${state.proposals.length} 份${pending > 0 ? `（${pending} 份待审阅）` : ''}`,
          // 行数只用于发现“值得量化一次”的目标，不是拆分结论；内视把两者分开写。
          // 全部已决策时不再写“0 个待决策（0 个…）”，那串零只会让读者以为没查过。
          `超过 ${OVERSIZED_MEDIUM} 行的文件 ${large.length} 个：${
            undecided.length > 0
              ? `${undecided.length} 个待决策（${measured.length} 个已有判据、${unmeasured.length} 个还没量过），`
              : ''
          }${large.length - undecided.length} 个已有拆分决策`,
          // 判据口径写一行，读者才知道为什么这里不再直接建议拆。
          '行数只用来发现需要量化的目标；拆不拆看判据码与 split-decisions.ts 里已记录的决策',
          // 判据分布说明「大多数大文件量出来是什么码」，避免把行数读成结论。
          ...(distribution ? [`split-candidates.mjs 实测判据分布：${distribution}`] : []),
          ...(measured.length > 0
            ? [
                `只差决策的：${measured
                  .slice(0, 4)
                  .map((file) => `${file.path} ${verdictOf(file.path)}`)
                  .join('；')}`,
              ]
            : []),
          ...(unmeasured.length > 0
            ? [
                `还没量过的：${unmeasured
                  .slice(0, 4)
                  .map((file) => `${file.path}（${file.lines} 行）`)
                  .join('；')}，先跑 node pilot/scripts/split-candidates.mjs <文件>`,
              ]
            : []),
          // 决策是仓库级事实：即便这次扫描没命中任何一个，也不该显示成「0 条」。
          ...(decisions.length > 0
            ? [
                `已记录拆分决策 ${decisions.length} 条（${scannedDecisions.length > 0 ? '本次扫描命中' : '仓库记录'}）：${decisions
                  .slice(0, 4)
                  .map((decision) => `${decision.path} ${splitDecisionKindLabel(decision.kind)}`)
                  .join('；')}`,
              ]
            : []),
        ],
      }
    },
  },
]

/** 待内视的模块 id，顺序即展示顺序。 */
export const SELF_CHECK_PROBE_IDS: readonly string[] = PROBES.map((probe) => probe.id)

export function buildSelfCheckReport(context: SelfCheckContext): SelfCheckReport {
  const started = Date.now()
  const items: SelfCheckItem[] = PROBES.map((probe) => {
    const probeStarted = Date.now()
    const sourceError = context.errors[probe.id]
    if (sourceError) {
      return {
        id: probe.id,
        group: probe.group,
        title: probe.title,
        status: 'broken',
        detail: '取样失败',
        facts: [sourceError],
        durationMs: 0,
      }
    }
    try {
      const result = probe.run(context)
      return {
        id: probe.id,
        group: probe.group,
        title: probe.title,
        ...result,
        durationMs: Math.max(0, Date.now() - probeStarted),
      }
    } catch (error) {
      return {
        id: probe.id,
        group: probe.group,
        title: probe.title,
        status: 'broken',
        detail: '判定时出错',
        facts: [messageOf(error)],
        durationMs: Math.max(0, Date.now() - probeStarted),
      }
    }
  })
  return {
    at: context.now,
    version: context.version,
    durationMs: Math.max(0, Date.now() - started),
    counts: countSelfCheck(items),
    items,
  }
}

export interface SelfCheckDeps {
  version: string
  packaged: boolean
  appPath: string
  userDataPath: string
  currentWorkspace: string | null
  settings: () => SettingsView
  workspaces: () => WorkspaceSummary[]
  modelResources: () => ModelResource[]
  scheduled: () => ScheduledTask[]
  moduleCheck: () => ModuleCheckState
  sandbox: () => Promise<SandboxStatus>
  update: () => UpdateState
  systemInfo: () => Promise<SystemInfo>
  feedback: { dir: string; list: (limit?: number) => Promise<string[]> }
  dynamicTools: () => Promise<DynamicToolInfo[]>
  plugins: (workspace: string) => Promise<PluginOverview>
  mcpServers: (workspace: string) => Promise<Record<string, unknown>>
  now?: () => number
}

/**
 * 采集 + 判定。每个来源独立失败：一个模块取不到不影响其余模块的结论。
 */
export async function runSelfCheck(deps: SelfCheckDeps): Promise<SelfCheckReport> {
  const now = deps.now?.() ?? Date.now()
  const errors: Record<string, string> = {}
  const workspace = deps.currentWorkspace

  const capture = async <T>(id: string, run: () => Promise<T>): Promise<T | null> => {
    try {
      return await run()
    } catch (error) {
      errors[id] = messageOf(error)
      return null
    }
  }
  const sync = <T>(id: string, run: () => T): T | null => {
    try {
      return run()
    } catch (error) {
      errors[id] = messageOf(error)
      return null
    }
  }

  const [systemInfo, sandbox, feedbackFiles, dynamicTools, plugins, mcpServers] = await Promise.all([
    capture('system', deps.systemInfo),
    capture('sandbox', deps.sandbox),
    capture('feedback', () => deps.feedback.list()),
    capture('dynamicTools', deps.dynamicTools),
    workspace ? capture('plugins', () => deps.plugins(workspace)) : Promise.resolve(null),
    workspace ? capture('mcp', () => deps.mcpServers(workspace)) : Promise.resolve(null),
  ])

  const settings = sync('store', deps.settings)
  const workspaces = sync('store', deps.workspaces) ?? []
  const modelResources = sync('model', deps.modelResources) ?? []
  const scheduled = sync('scheduler', deps.scheduled) ?? []
  const moduleCheck = sync('moduleCheck', deps.moduleCheck)
  const update = sync('update', deps.update)

  const context: SelfCheckContext = {
    version: deps.version,
    packaged: deps.packaged,
    appPath: deps.appPath,
    userDataPath: deps.userDataPath,
    currentWorkspace: workspace,
    settings,
    workspaces,
    modelResources,
    scheduled,
    moduleCheck,
    sandbox,
    update,
    systemInfo,
    feedback: { dir: deps.feedback.dir, pending: feedbackFiles ? feedbackFiles.length : null },
    dynamicTools: dynamicTools ?? [],
    plugins,
    mcpServers,
    errors,
    now,
  }
  return buildSelfCheckReport(context)
}

export type { SelfCheckCounts }
