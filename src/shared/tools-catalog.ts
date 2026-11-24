import type {
  AgentToolDefinition,
  DynamicToolInfo,
  StoredMessage,
  ToolCatalogEntry,
  ToolCatalogSource,
  ToolRisk,
} from './types'

export interface ToolCatalogInput {
  /**
   * Builtin and control tools a run would offer right now. Shell and learning
   * filters are applied by the caller so the catalog matches reality instead of
   * listing every tool that exists in code.
   */
  builtin: AgentToolDefinition[]
  /** Agent-written tools of this workspace, approved or not. */
  dynamic: DynamicToolInfo[]
  /** Server names from `.pilot/mcp.json`; their tools only exist after connect. */
  mcpServers: string[]
  /** MCP is off by default; when off the servers are listed as disabled. */
  mcpEnabled: boolean
  /**
   * Tools of the plugins enabled in this workspace. They are named
   * `plugin__<id>__<tool>`, so they cannot collide with the entries above.
   */
  plugins?: ToolCatalogInputPlugin[]
  /**
   * 工具名 → 当前会话里真正被调用的次数。缺省时全部记 0，
   * 返回值仍然带 calls 字段，面板就能把「还没用过」说清楚。
   */
  calls?: Record<string, number>
}

/** One manifest tool of an enabled plugin, as the tool panel needs it. */
export interface ToolCatalogInputPlugin {
  id: string
  name: string
  tool: string
  fullName: string
  description: string
  risk: ToolRisk
}

/**
 * 工具名 → 一句中文说明。工具定义里的 description 是写给模型看的英文长句，
 * 面板里直接铺出来既看不懂又占地方，所以清单另带一份中文；名字对不上
 * （自写工具、新加的内置工具）时面板回落到原 description，不留空。
 */
export const TOOL_DESCRIPTIONS_ZH: Record<string, string> = {
  // 文件与检索
  list_directory: '列出工作区里的目录与文件，可指定递归深度，先看清结构再读文件。',
  project_map: '一次给出项目全貌：按目录与扩展名的文件统计、清单、入口、关键源码与测试布局。',
  read_file: '读取工作区里的文本文件，可指定行区间；改文件前先读一遍。',
  write_file: '新建文件或整体重写，适合新文件与全文替换。',
  apply_patch: '对已有文件做定点修改，一次可提交多处改动。',
  search_files: '在工作区里搜文本或正则，返回文件名、行号与预览。',
  get_file_info: '查看某个路径的类型、大小与修改时间。',
  // 命令与进程
  run_command: '直接运行一个程序，不经过 shell，不支持管道与重定向。',
  run_shell: '用 shell 跑一行命令，支持管道、重定向、链式与变量。',
  start_process: '启动需要长期运行的进程（开发服务器、桌面应用等），可等它就绪。',
  read_process_output: '读取已启动进程的最新输出与运行状态。',
  stop_process: '停止之前启动的进程及其子进程。',
  list_processes: '列出本次运行启动过的进程与状态。',
  // 界面与设备
  screenshot: '截图某个窗口或整个屏幕，用来核对界面实际显示。',
  list_windows: '列出可以截图的窗口及其稳定 id。',
  app_targets: '列出 Chromium/Electron 应用暴露的调试目标（页面、webview）。',
  app_control: '通过 DevTools 协议驱动应用：执行脚本、点击、输入、等待、截图、读控制台。',
  drive_probe: '先判断应用属于哪类、哪些接口现在可用，再决定用什么方式驱动它。',
  drive_recipes: '查看已保存的驱动步骤（recipe），能复用就不要再写一遍。',
  drive_run: '按步骤或 recipe 驱动应用，某种接口失败时自动换下一种。',
  run_e2e: '跑项目现有的端到端测试（Playwright、Cypress 等）。',
  // 工具与技能
  list_tools: '列出本工作区已写的工具、批准状态与运行统计。',
  register_tool: '校验并注册 `.pilot/tools/<name>/` 下的工具，跑通它的自测。',
  rollback_tool: '把工具回退到之前已批准的版本，并重跑自测。',
  promote_tool: '把工作区工具提升为全局默认工具，之后每个工作区都有。',
  run_tool: '用 JSON 参数运行一个已注册的工作区工具。',
  use_skill: '载入工作区技能（SKILL.md）的完整说明。',
  create_skill: '把可复用的多步流程写成工作区技能。',
  create_mcp_server: '把一个本地命令注册成 MCP 服务器，它的工具随后以 mcp__ 前缀出现。',
  // 版本与历史
  git_status: '查看当前分支与所有未提交改动。',
  git_diff: '查看未提交的补丁，可以只看某个路径。',
  git_log: '查看最近的提交，可以限定到某个文件。',
  // 协作与任务
  explore: '把「哪里用到 X」这类大范围只读调查交给子代理，只回结论与文件行号。',
  subagent: '把一段聚焦的任务交给隔离子代理，它可以读、可以改，并自己跑白名单检查。',
  remember: '记一条长期有效的项目事实，下次会话也能看到。',
  update_plan: '维护当前任务的可见步骤清单。',
  add_todo: '把待办追加到本次会话的待办面板，留到之后的新消息里做。',
  schedule_task: '用对话创建、查看、暂停或删除定时任务，到点后在本会话自动执行。',
  propose_self_update: '生成一份自我改进草稿，需要用户启用才会生效。',
  learning_research: '只读抓取一个白名单来源并存档，用于自主学习取证。',
  learning_log: '记录自主学习任务或阶段成果的裁决。',
  // 自我诊断
  request_system_access: '申请读取 Pilot 自身执行记录与策略的只读权限，由用户批准。',
  read_execution_records: '读取 Pilot 的运行统计与失败样本（需要授权）。',
  read_system_strategy: '读取 Pilot 当前的执行策略：模型限制、审批策略、技能与工具（需要授权）。',
  // 复盘会话
  list_sessions: '列出本次复盘范围内的会话：标题、工作区、时间与消息数。',
  get_session: '分页读取一个会话的消息与工具调用，用 offset/limit 翻页。',
  search_sessions: '在会话消息里全文搜索，找到出问题的位置再读上下文。',
  list_runs: '按时间倒序列出运行记录，可按会话或状态筛选。',
  get_run: '按 id 读取一次运行的详情：提示、状态、用量、错误与用户反馈。',
  record_review: '记录最终的结构化复盘报告，只调用一次。',
}

/** 面板用的中文说明；没有对应条目时返回 undefined，由调用方回落原文。 */
export function toolDescriptionZh(name: string): string | undefined {
  return TOOL_DESCRIPTIONS_ZH[name]
}

/**
 * 统计一段会话里每个工具被调用的次数。MCP 工具在运行时叫
 * `mcp__<server>__<tool>`，而清单里只列 server 名，所以这里把这两层都记：
 * 精确工具名一份，`mcp__<server>` 前缀累加一份。
 */
export function countToolCalls(messages: StoredMessage[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const message of messages) {
    if (!message.toolCalls) continue
    for (const call of message.toolCalls) {
      const name = call.name
      if (!name) continue
      counts[name] = (counts[name] ?? 0) + 1
      const mcp = /^mcp__([^_]+(?:_[^_]+)*)__/.exec(name)
      if (mcp?.[1]) {
        const key = `mcp__${mcp[1]}`
        counts[key] = (counts[key] ?? 0) + 1
      }
    }
  }
  return counts
}

/** 一个清单条目的调用次数：自写/内置用名字，MCP 用服务器前缀。 */
function callsFor(
  entry: Pick<ToolCatalogEntry, 'source' | 'name' | 'server'>,
  calls: Record<string, number>,
): number {
  if (entry.source === 'mcp') return calls[`mcp__${entry.server ?? entry.name}`] ?? 0
  // Plugin entries already carry the runtime name, so they need no prefix rule.
  return calls[entry.name] ?? 0
}

/**
 * One flat list for the "available tools" preview: builtin, control, MCP and
 * agent-written tools in a single shape. Nothing here reads a secret — MCP env
 * vars never leave the main process, only the server name does.
 */
export function buildToolCatalog(input: ToolCatalogInput): ToolCatalogEntry[] {
  const entries: ToolCatalogEntry[] = []
  for (const tool of input.builtin) {
    const source: ToolCatalogSource = tool.source === 'control' ? 'control' : 'builtin'
    entries.push({
      name: tool.name,
      description: tool.description,
      descriptionZh: toolDescriptionZh(tool.name),
      risk: tool.risk,
      source,
    })
  }
  for (const server of input.mcpServers) {
    entries.push({
      name: server,
      // The per-tool list only exists after the server connects, so the catalog
      // names the server instead of pretending to know its tools.
      description: input.mcpEnabled
        ? 'MCP server: its own tools are added after the server connects at run start.'
        : 'MCP server: skipped because MCP is turned off in Settings.',
      descriptionZh: input.mcpEnabled
        ? 'MCP 服务器：运行开始连上之后，才会列出它自己的工具。'
        : 'MCP 服务器：设置里关闭了 MCP，运行时跳过它。',
      risk: 'exec',
      source: 'mcp',
      server,
      enabled: input.mcpEnabled,
    })
  }
  for (const tool of input.dynamic) {
    entries.push({
      name: tool.name,
      description: tool.description,
      // 自写工具的说明由 Agent 自己写，没有单独的译文，面板回落原 description。
      descriptionZh: toolDescriptionZh(tool.name),
      risk: tool.risk,
      source: 'dynamic',
      enabled: tool.enabled,
      approved: tool.approved,
      version: tool.version,
      targets: tool.targets,
      inputSchema: tool.inputSchema,
    })
  }
  for (const tool of input.plugins ?? []) {
    entries.push({
      name: tool.fullName,
      // The manifest description is written for the model; the panel prefixes
      // it with the plugin name so two plugins with a "status" tool differ.
      description: `[plugin ${tool.id}] ${tool.description}`,
      descriptionZh: `插件「${tool.name}」：${tool.description}`,
      risk: tool.risk,
      source: 'plugin',
      enabled: true,
      plugin: tool.id,
      pluginName: tool.name,
    })
  }
  const calls = input.calls ?? {}
  // 调用多在前，没调用过的按名字排在后面；面板直接按这个顺序渲染。
  return entries
    .map((entry) => ({ ...entry, calls: callsFor(entry, calls) }))
    .sort(
      (a, b) =>
        (b.calls ?? 0) - (a.calls ?? 0) ||
        a.name.localeCompare(b.name) ||
        a.source.localeCompare(b.source),
    )
}