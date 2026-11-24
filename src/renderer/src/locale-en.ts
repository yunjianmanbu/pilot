/**
 * English UI copy, keyed by the Chinese source text.
 *
 * Keys are the exact strings passed to `t()`. Dynamic copy uses `{name}`
 * placeholders that match the variables passed to `t()`.
 */
export const en: Record<string, string> = {
  " · 含思考": " · includes thinking",
  " · 已截断": " · truncated",
  " · 有项目记忆": " · has project memory",
  " 先在设置中配置 API Key。": " Set an API key in Settings first.",
  " 继续完成几个任务即可。": " Complete a few more tasks to continue.",
  "0 = 稳定，2 = 发散": "0 = stable, 2 = creative",
  "1 分钟": "1 minute",
  "10 分钟": "10 minutes",
  "3 分钟": "3 minutes",
  "30 分钟": "30 minutes",
  "5 分钟": "5 minutes",
  "Ctrl+Enter 保存 · 敏感信息（Key、Token）不会被保存":
    "Ctrl+Enter to save · secrets (keys, tokens) are not saved",
  "Enter 发送 · Shift+Enter 换行 · 可附图/参照":
    "Enter to send · Shift+Enter for a new line · attach images/references",
  "Linux 版": "Linux",
  "MCP 服务器": "MCP servers",
  "OS 沙箱": "OS sandbox",
  "Pilot 不会上传会话或 API Key；连接器只负责转发端到端加密后的密文。":
    "Pilot never uploads sessions or API keys; the connector only forwards end-to-end encrypted ciphertext.",
  "Pilot 不在前台时，任务完成、运行失败或等待审批会发一条系统通知。点击通知可回到对应会话。":
    "When Pilot is in the background, finished runs, failures and pending approvals send a system notification. Click it to return to the session.",
  "Pilot 从真实运行中反思，提出行为改进；每个版本都要经过独立模型评审，通过后才会生效，并且随时可回滚。":
    "Pilot reflects on real runs and proposes behavior improvements. Every version is reviewed by an independent model before it can take effect, and you can roll back at any time.",
  "Pilot 会在你的本地工作区中阅读、修改和运行代码。每个工作区拥有独立记忆，并能在真实运行中持续优化自己的行为。":
    "Pilot reads, edits and runs code in your local workspace. Each workspace keeps its own memory and keeps improving its behavior from real runs.",
  "Pilot 会在失败运行、工具报错、负反馈或长时间探查后自动复盘，也可以在上面的输入框里直接写入长期偏好。":
    "Pilot automatically reflects after failed runs, tool errors, negative feedback or a long exploration; you can also write long-term preferences in the box above.",
  "Pilot 写入工作区文件后，这里会显示相对会话起点的差异。":
    "Files Pilot writes in the workspace are shown here as a diff against the session start.",
  "Pilot 只在被授权的工作区内读写文件、执行命令。":
    "Pilot only reads, writes and runs commands inside the workspace you authorize.",
  "Pilot 回复": "Pilot",
  "Pilot 官方不提供公共中继服务。手机与电脑不在同一网络时，需要部署你自己的 Pilot Link 中继器；它只按房间转发端到端加密的密文，不保存会话。":
    "Pilot does not run a public relay. When the phone and desktop are not on the same network, deploy your own Pilot Link relay; it forwards end-to-end encrypted ciphertext per room and stores no sessions.",
  "Pilot 成功写入或修改的文件会自动收集到这里。":
    "Files Pilot successfully writes or modifies are collected here automatically.",
  "Pilot 手机 App": "Pilot mobile app",
  "Pilot 手机 App 下载二维码": "Pilot mobile app download QR code",
  "Pilot 手机连接": "Pilot mobile link",
  "Pilot 手机连接配对二维码": "Pilot mobile pairing QR code",
  "Pilot 提出": "Pilot proposal",
  "Pilot 无法启动": "Pilot could not start",
  "Pilot 是一个本地运行的自主智能体。授权一个文件夹，它就能理解代码、执行命令、修改文件，并把每次经验留在这个工作区。":
    "Pilot is a local autonomous agent. Authorize a folder and it can understand the code, run commands, edit files and keep what it learns in that workspace.",
  "Pilot 的进化提案只基于这些真实运行记录。":
    "Pilot's evolution proposals are based only on these real runs.",
  "Pilot 记录": "Pilot",
  "Pilot 资源": "Pilot resources",
  "基线": "Baseline",
  "对比修改与单文件回退都以这个点为基准":
    "Change review and single-file revert compare against this point.",
  "回退前": "Before restore",
  "已回退。回退前的工作区已存为「回退前」快照，可再回退一次撤销。":
    "Restored. The workspace as it was before is saved as a \"Before restore\" snapshot, so you can undo by restoring it.",
  "Shell 前": "Before shell",
  "完整 shell 不受工作区路径限制，当前会话不是「全部自动」，所以需要你确认。经常无人值守时，可把本会话改为全部自动。":
    "A full shell is not limited to the workspace, and this session is not in Full auto, so it needs your confirmation. If you are often away, switch this session to Full auto.",
  "计划模式只允许只读命令；需要执行时请先退出计划模式。":
    "Plan mode allows read-only commands only; leave plan mode before running anything else.",
  "这是 Agent 读取 Pilot 自身运行记录与执行策略的系统级授权：只读、绑定本次运行、到期自动失效。批准后它只能通过 read_execution_records / read_system_strategy 读取所选范围，不能修改设置或提升权限；优化建议会先成为草稿，仍需你审核后启用。":
    "This grants the agent read-only access to Pilot's own run records and execution strategy. The grant is limited to this run and expires automatically. After approval it can only read the selected scope through read_execution_records / read_system_strategy; it cannot change settings or raise its permissions. Optimization proposals become drafts that you still review and enable.",
  "本会话之后的所有工具调用都不再逐次确认；工作区路径限制、受保护路径和拒绝规则仍然生效。":
    "Later tool calls in this session will not ask again; the workspace path jail, protected paths and deny rules still apply.",
  "改为全部自动并允许": "Switch to Full auto and allow",
  "允许无人值守的个人构建": "Allow unattended personal builds",
  "完全自主（放开全部限制）": "Full autonomy (lift all limits)",
  "开启后不再逐次询问：可访问任意网络，可在工作区外读取任意资源、数据与日志，并可在工作区外的目录执行命令与长驻进程，可修改 Pilot 自身源码与 .pilot 配置（写入仍限于工作区和自身源码目录），可在无人值守时构建，并自动获得内视与自检权限。只在本会话为「全部自动」且 token 与步数上限都达标时生效；凭据、密钥、浏览器会话等隐私路径仍永远拒绝，每次越界都会写审计日志。":
    "No more per-call prompts: any network host, reading any resource, data or log outside the workspace, running commands and long-lived processes in directories outside the workspace, editing Pilot's own source and .pilot config (writes stay inside the workspace and Pilot's own source directory), unattended builds, plus automatic introspection and self-check access. It only takes effect when the session is in Fully automatic mode and both the token and step budgets are set high enough; credential, key and browser-session paths are still always refused, and every boundary crossing is written to the audit log.",
  "完全自主暂未生效：{v1}。补齐后自动生效，无需重新开启。":
    "Full autonomy is not active yet: {v1}. It turns on by itself once that is fixed; no need to toggle it again.",
  "默认审批模式不是「全部自动」":
    "the default approval mode is not Fully automatic (a session can still switch to it)",
  "token 总量上限低于 100000": "the token cap is below 100000",
  "步数上限低于 20": "the step cap is below 20",
  "；": "; ",
  "自主探索学习": "Autonomous learning",
  "允许智能体从白名单公开站点只读搜集资料、自己决定做什么任务，并把来源、任务与阶段成果记在工作区的 .pilot/learning 账本里。开启后请求仍只允许 GET/HEAD：抓到的内容只落在工作区，任何上传、提交、发布、推送类命令都会被拒绝；每个阶段成果都要你点头才算完成。":
    "Let the agent read allowlisted public sites (GET/HEAD only), pick its own tasks, and record sources, tasks and stage results in the .pilot/learning ledger inside the workspace. Fetched content stays in the workspace, and any upload, submit, publish or push command is refused; every stage result still needs your approval.",
  "学习来源白名单": "Learning source allowlist",
  "学习探索期间让 shell 断网": "Cut shell network while learning is on",
  "默认关闭：学习的白名单只约束 learning_research，任务会话照你用下面的「沙箱网络」设置联网，安装依赖、访问接口都不受影响。开启后，学习探索开启期间 shell 沙箱拿不到网络，作为文本匹配之外的兜底。":
    "Off by default: the allowlist constrains learning_research only, while task sessions keep networking under your sandbox-network setting, so installing dependencies and calling APIs still work. Turn it on to give the shell no network whenever learning is enabled, as a second guard beyond command matching.",
  "一行一个主机名，子域自动包含（写 example.com 也涵盖 docs.example.com）。留空使用内置默认的公开文档站点。本机、内网与云元数据地址永远不在允许范围内。":
    "One hostname per line; subdomains are included (example.com also covers docs.example.com). Leave empty to use the built-in public documentation hosts. Localhost, private networks and cloud metadata addresses are never allowed.",
  "开启后，全部自动模式的会话在构建个人实验版（self-build、package:*、electron-builder）时不再逐次确认。构建会把可修改的源码变成可执行文件，只在你确实会离开电脑时开启；只读自动和逐条审批模式仍然需要确认。":
    "When enabled, Full auto sessions build a personal experimental build (self-build, package:*, electron-builder) without asking each time. A build turns editable source into a runnable program, so enable this only when you will actually be away; Read-only auto and Approve-each-call still ask.",
  "Shell 执行前创建回退点": "Create a checkpoint before shell commands",
  "Shell 解释器": "Shell interpreter",
  "Shell 运行模式": "Shell mode",
  "Token 预算已用尽，任务已停止。": "The token budget is exhausted; the task stopped.",
  "WSL 中的 bash": "bash in WSL",
  "Windows 下 run_shell 使用的解释器": "Interpreter used by run_shell on Windows",
  "Windows 版": "Windows",
  "tokens，超出部分会被自动收敛。": " tokens; anything beyond is trimmed automatically.",
  "· 需要 Node.js 22+ · 含部署示例": "· requires Node.js 22+ · includes deployment examples",
  "。连续 7 天未使用会自动失效。": ". Expires automatically after 7 days without use.",
  "一次": "once",
  "一次复盘最多读取 8 个目录。": "A review reads at most 8 directories.",
  "三级知识库": "Three-level knowledge base",
  "上下文预算": "Context budget",
  "token 总量上限": "Token budget per task",
  "单次任务累计；不限制则跑满步数为止": "Counted across one task; unlimited runs to the step cap",
  "不限制": "No limit",
  "20 万": "200K",
  "60 万": "600K",
  "200 万": "2M",
  "token 总量上限需要是 0 或正整数（0 = 不限制）。": "The token budget must be 0 or a positive whole number (0 = no limit).",
  "上次任务没有正常结束": "The previous task did not finish cleanly",
  "上次运行停在：第 {v1} 步": "The last run stopped at step {v1}",
  "计划已完成 {v1}/{v2} 项": "{v1}/{v2} plan items done",
  "在设置里换一个有效的 API Key，然后继续。":
    "Replace the API key in Settings, then continue.",
  "账户余额不足，充值后再继续；重试不会改变结果。":
    "The account is out of balance. Top it up before continuing; retrying cannot fix it.",
  "账号无权使用这个模型，在设置里换模型或申请权限后再继续。":
    "This account may not use that model. Pick another model or request access, then continue.",
  "检查模型名称、API Key 与账户余额，改好后再继续。":
    "Check the model name, API key and account balance, then continue.",
  "已完成的部分已保留在工作区，继续会接着计划往下走。":
    "Finished work is kept in the workspace; continuing picks up the remaining plan.",
  "已修复，继续": "Fixed, continue",
  "模型或账号配置需要处理": "The model or account settings need attention",
  "网络或服务端中断": "Network or server interruption",
  "重试通常即可恢复；继续前 Pilot 会先检查工作区现状。":
    "A retry usually recovers; Pilot checks the workspace first to avoid repeating finished steps.",
  "下载中": "Downloading",
  "下载中…": "Downloading…",
  "下载更新": "Download update",
  "不会修改当前生效版本，中文草稿需重新评审。":
    "The active version is unchanged; the Chinese draft needs a new review.",
  "不可用": "Unavailable",
  "不完整快照不能安全地回退文件": "An incomplete snapshot cannot safely restore files",
  "不完整：跳过": "Incomplete: skipped",
  "不自动拒绝": "Never auto-reject",
  "个任务执行中。安装会退出 Pilot，请等任务完成或停止后再重启安装。":
    " tasks are running. Installation quits Pilot; wait for them to finish or stop them before retrying.",
  "个会话": " sessions",
  "个会话 ·": " sessions ·",
  "个过大或超出预算的文件": " files that were too large or over budget",
  "个工作区": " workspaces",
  "个工具": " tools",
  "个文件": " files",
  "本轮改动 {v1} 个文件": "{v1} files changed this turn",
  "本轮改动 1 个文件": "1 file changed this turn",
  "查看更多": "View all",
  "中": "medium",
  "中断": "interrupted",
  "中继器连接中": "Connecting to relay",
  "中继地址": "Relay URL",
  "为这个项目添加一个实用的新功能，先给出计划再实施":
    "Add a useful new feature to this project; plan first, then implement",
  "主项目": "Main project",
  "也可以从左上角切换工作区": "You can also switch workspaces from the top left",
  "事实": "fact",
  "二维码已过期": "QR code expired",
  "云服务器一键安装": "One-click cloud install",
  "交接修复": "Hand off fix",
  "仅在中途失败、达到步数上限或计划未完成时触发":
    "Only after a mid-run failure, step limit or unfinished plan",
  "仅对话": "Chat only",
  "仅局域网": "LAN only",
  "仅文件": "Files only",
  "仍然启用": "still enable",
  "从上方选择一个会话，或打开一个会话后点击顶部的知识库按钮。":
    "Pick a session above, or open one and click the knowledge button in its top bar.",
  "从上次中断的地方继续，Pilot 会先检查工作区现状，避免重复已完成步骤。":
    "Continue from the interruption; Pilot checks the workspace first to avoid repeating finished steps.",
  "从中断处继续任务": "Resume task",
  "以下内容不会自动改变行为。记忆仅作参考；进化草稿需要在“进化”面板中审核并启用。":
    "The following does not change behavior automatically. Memory is reference only; evolution drafts must be reviewed and enabled in the Evolution panel.",
  "任务": "Task",
  "任务已停止。": "Task stopped.",
  "任务已暂停": "Task paused",
  "任务已暂停，可继续": "Task paused; can resume",
  "任务已暂停，可随时从断点继续。": "Task paused; resume anytime from the checkpoint.",
  "任务执行中，完成后才能重启安装": "A task is running; install after it finishes",
  "任务执行中，结束后可编辑": "A task is running; edit after it finishes",
  "任务未完成时，自动从中断处继续，直到完成或达到上面的次数上限。手动暂停的会话不会自动继续。":
    "When a task stops before finishing, continue automatically from the interruption until it completes or reaches the limit above. Manually paused sessions are never resumed automatically.",
  "任务结束后可参照其他项目": "References can be added after the task finishes",
  "任务结束后可添加图片": "Images can be added after the task finishes",
  "任务结束后可添加文件": "Files can be added after the task finishes",
  "份全局候选": " global candidates",
  "份草稿": " drafts",
  "优先级最高，不能被允许规则覆盖": "Highest priority; allow rules cannot override it",
  "会话": "Session",
  "会话不存在，可能已被删除": "Session not found; it may have been deleted",
  "会话已删除。": "Session deleted.",
  "会话排序": "Session order",
  "会话操作": "Session actions",
  "更多会话操作": "More session actions",
  "会话知识库": "Session knowledge",
  "低": "Low",
  "你写入": "You",
  "例如：评估 2026-11-10 的发布流程，重点检查版本号、签名和下载清单是否一致。":
    "e.g. review the 2026-11-10 release: version, signature and download manifest consistency.",
  "保存": "Save",
  "保存后会从这条消息重新生成，之后的回复会被丢弃。":
    "Saving regenerates from this message and discards later replies.",
  "保存后将清除 Key": "Saving will clear the key",
  "保存并重新生成": "Save and regenerate",
  "保存当前快照": "Save current snapshot",
  "保存设置": "Save settings",
  "修改": "Modified",
  "候选版本": "Candidate version",
  "候选版本已删除。": "Candidate version deleted.",
  "停止当前任务（不会自动继续）": "Stop the current task (no auto-continue)",
  "允许一次": "Allow once",
  "始终允许这条命令（仅完全匹配时）": "Always allow this exact command",
  "允许智能体执行带管道、重定向和变量的完整 shell 命令。每次调用都必须由你单独批准，即使会话已设为自动允许；shell 可以访问工作区之外的内容，请只对可信命令授权。关闭后，子智能体也不能自己跑白名单校验（run_check），改动会交回主智能体验证。":
    "Let the agent run full shell commands with pipes, redirects and variables. Every call needs your approval, even in auto mode; the shell can reach outside the workspace, so only authorize trusted commands. When this is off, subagents also lose their whitelisted checks (run_check) and hand verification back to the parent agent.",
  "允许沙箱内网络": "Allow network in sandbox",
  "允许规则": "Allow rules",
  "已记住的命令": "Remembered commands",
  "在审批中选择「始终允许」后，只有完全匹配的命令会自动放行。":
    "Commands you mark “Always allow” are auto-approved only when the command line matches exactly.",
  "还没有已记住的命令。": "No remembered commands yet.",
  "全部清除": "Clear all",
  "允许读取的目录": "Readable directories",
  "先从侧边栏选择一个本地文件夹。": "Pick a local folder in the sidebar first.",
  "先和 Pilot 完成一轮问答，再来查看。": "Finish one Q&A round with Pilot, then come back.",
  "先在左上角选择一个工作区，再查看它的项目知识库。":
    "Pick a workspace in the top left to view its project knowledge.",
  "先完成评估并生成报告": "Finish the review and generate a report first",
  "先梳理一下这个项目的结构、技术栈和启动方式":
    "First outline this project's structure, stack and startup steps",
  "先选择一个工作区": "Pick a workspace first",
  "先选择一个工作区。": "Pick a workspace first.",
  "先选择一个工作区，再新建复盘评估。": "Pick a workspace before starting a review.",
  "先配置 API Key": "Set an API key first",
  "全局": "Global",
  "全局候选版本已删除。": "Global candidate deleted.",
  "全局历史版本 ·": "Global history ·",
  "全局指令文件": "Global instructions file",
  "全局生效中": "Active globally",
  "全局画像": "Global profile",
  "全局知识库": "Global knowledge",
  "全部": "All",
  "全部发送（": "Send all (",
  "全部发送这 {v1} 条待办？": "Send all {v1} todos?",
  "全部工作区": "All workspaces",
  "全部时间": "All time",
  "全部自动": "Full auto",
  "全部自动 · 本地工作区": "Full auto · local workspace",
  "共": "Total",
  "关闭": "Close",
  "关闭提示": "Dismiss",
  "关闭时使用网络命名空间隔离。打开后无法阻止沙箱内程序外联，安全性会降低；需要联网安装依赖时再打开。":
    "Isolate with a network namespace when off. Turning it on lets sandboxed programs reach the network, which is less safe; enable it when installing dependencies.",
  "关闭更新面板": "Close update panel",
  "写入": "Write",
  "写入一条长期记忆，例如：这个项目使用 pnpm，不要用 npm；提交前必须运行 pnpm typecheck。":
    "Add a long-term memory, e.g. this project uses pnpm, not npm; run pnpm typecheck before committing.",
  "写入记忆": "Add memory",
  "写文件": "Write files",
  "分析中…": "Analyzing…",
  "切换到浅色模式": "Switch to light mode",
  "切换到深色模式": "Switch to dark mode",
  "刚刚": "just now",
  "创建中…": "Creating…",
  "创建副本": "Duplicate",
  "创建时间": "Created",
  "删除": "Delete",
  "删除会话": "Delete session",
  "删除定时任务": "Delete scheduled task",
  "删除待办": "Delete todo",
  "删除这条还没有回复的指令？": "Delete this unanswered instruction?",
  "删除这条待办？": "Delete this todo?",
  "删除草稿": "Delete draft",
  "删除记忆": "Delete memory",
  "删除这条项目记忆？Pilot 之后不会再使用它。":
    "Delete this project memory? Pilot will stop using it.",
  "别名": "Alias",
  "刷新": "Refresh",
  "刷新会话列表": "Refresh sessions",
  "加载中…": "Loading…",
  "加载更早消息": "Load earlier messages",
  "单次输出上限": "Max output tokens",
  "即将开始": "Starting soon",
  "即将自动拒绝": "Auto-rejecting soon",
  "历史版本 ·": "History ·",
  "参数": "Parameters",
  "参照": "Reference",
  "参照其他项目": "Reference other projects",
  "反思与提案": "Reflection and proposals",
  "反思结果按内容去重；同一条被反复推导出来时会累加复现次数，排名靠前。":
    "Reflections are deduplicated by content; every time the same lesson is re-derived its repeat count goes up and it ranks higher.",
  "反馈": "Feedback",
  "发送": "Send",
  "发送到当前会话": "Send to current session",
  "发送这条待办？": "Send this todo?",
  "发送前": "Before sending",
  "指令已删除。": "Instruction deleted.",
  "取消": "Cancel",
  "变更": "Changes",
  "变更审阅": "Change review",
  "变更审阅：比较并撤销本次会话修改的文件":
    "Change review: compare and undo files changed in this session",
  "另一个模型会话按 100 分制审查，≥ 75 分才自动启用。":
    "Another model session reviews on a 100-point scale; 75+ auto-enables it.",
  "只对": "Only for",
  "只汇总本次会话成功写入的文件 · 只读预览":
    "Only files successfully written in this session · read-only preview",
  "只看当前工作区": "Only current workspace",
  "只看当前工作区的历史会话，适合查阅这个项目自己的方案与约定。":
    "Only this workspace's history, for this project's own plans and conventions.",
  "只看执行中的会话": "Only running sessions",
  "只读": "Read-only",
  "只读复盘 ·": "Read-only review ·",
  "只读审查会话与代码，产出带分值的报告":
    "Read-only examination of sessions and code that ends in a scored report",
  "只读复盘 · 不写入、不执行命令": "Read-only review · no writes, no commands",
  "只读复盘评估": "Read-only review",
  "只读当前项目下的会话，范围最窄。":
    "Only sessions in the current project; the narrowest scope.",
  "只读自动": "Read-only auto",
  "只读预览 · 修改请通过对话完成":
    "Read-only preview · make changes through the conversation",
  "可回滚": "Rollback available",
  "可检索的会话": "Searchable sessions",
  "可读目录：": "Readable directories:",
  "可选。写清要评估的任务、时间范围或关注点，复盘会更聚焦。":
    "Optional. Describe the task, time range or focus to keep the review sharp.",
  "可选：给这次快照起个名字": "Optional: name this snapshot",
  "台": " phone(s)",
  "台手机是通过自建中继器配对的，但电脑当前没有填写中继地址， 这些手机会一直停在“正在连接”。填写地址后手机会自动恢复。":
    " phones were paired through your relay, but no relay URL is set on this desktop, so they stay on “connecting”. Set the URL and they recover automatically.",
  "台手机通过自建中继器配对；清空地址后它们将无法跨网络连接。":
    " phones are paired through your relay; clearing the URL cuts their cross-network access.",
  "启动安装程序并退出 Pilot": "Run the installer and quit Pilot",
  "启用": "Enable",
  "启用后从 .pilot/mcp.json 启动 stdio MCP 服务器，并把它们的工具提供给智能体。每个 MCP 工具调用仍然逐次审批；只在你信任该配置时开启。":
    "Start stdio MCP servers from .pilot/mcp.json and expose their tools to the agent. Every MCP tool call still needs approval; enable only for configs you trust.",
  "启用后运行 .pilot/hooks.json 中定义的 pre_tool / post_edit / stop 命令。Hook 使用参数数组执行、不经过 shell，但仍会以你的用户权限运行；只在你信任该工作区时开启。":
    "Run pre_tool / post_edit / stop commands from .pilot/hooks.json. Hooks run as argument arrays without a shell, but still with your user permissions; enable only for workspaces you trust.",
  "启用此全局版本": "Enable this global version",
  "启用此版本": "Enable this version",
  "命中": "Hits",
  "命中后总是人工确认": "Always ask before matching",
  "命令": "Command",
  "命令已经被 OS 沙箱限制时，不再逐次询问。显式询问/拒绝规则仍然优先。":
    "Commands already confined by the OS sandbox are not asked about again. Explicit ask/deny rules still win.",
  "回到最新": "Back to latest",
  "回复中": "Replying",
  "回滚全局版本": "Roll back global version",
  "回滚到上一个全局版本？当前全局版本会退役，但不会被删除；所有工作区都会受到影响。":
    "Roll back to the previous global version? The current one is retired, not deleted; every workspace is affected.",
  "回滚到上一个已启用的版本？当前版本会退役，但不会被删除。":
    "Roll back to the previously enabled version? The current one is retired, not deleted.",
  "回滚到上一版本": "Roll back one version",
  "回退会覆盖工作区文件；未在快照中的文件会移到回退点目录，不会直接删除。":
    "A rollback overwrites workspace files; files missing from the snapshot move to the checkpoint folder instead of being deleted.",
  "回退点": "Checkpoint",
  "回退点保留数量": "Checkpoints kept",
  "回退点保留数量需要在 5 到 100 之间。":
    "Checkpoints kept must be between 5 and 100.",
  "回退点总空间上限": "Total checkpoint budget",
  "回退点总空间上限需要在 512 MB 到 20,480 MB 之间。":
    "The total checkpoint budget must be between 512 MB and 20,480 MB.",
  "快照跳过的路径": "Paths snapshots skip",
  "每行一条，只影响回退点：这些路径不会被扫描或保存，但仍可在文件树里查看和修改。构建缓存、临时目录、日志等生成物应写在这里。支持 * 通配（如 build-*），带 / 的路径从工作区根算起。tmp、.build、unpackage、logs、checkpoints 等常见生成目录已默认跳过；助手新建的目录若看起来是生成物，也会自动加进来。":
    "One per line, snapshots only: these paths are neither walked nor saved, but stay visible and editable in the file tree. Put generated output here (build caches, scratch directories, logs). * is a glob within one segment (build-*), and a path containing / starts at the workspace root. Common generated directories (tmp, .build, unpackage, logs, checkpoints) are skipped by default, and a directory the agent creates that looks generated is added automatically.",
  "回退点：恢复文件或对话": "Checkpoints: restore files or conversation",
  "图片": "Images",
  "在下一步将消息插入当前任务": "Insert the message into the current task on its next step",
  "在手机上打开链接并确认配对。二维码包含一次性密钥，过期后需要重新生成。":
    "Open the link on your phone and confirm pairing. The QR code holds a one-time key; regenerate it after expiry.",
  "在手机上继续会话、查看执行过程并审批工具调用。消息端到端加密。":
    "Continue sessions, watch execution and approve tool calls from your phone. Messages are end-to-end encrypted.",
  "在文件夹中显示": "Show in folder",
  "在每次 run_shell 执行前快照工作区文件，便于回退脚本造成的修改。快照排除 .git、node_modules 等大型目录。":
    "Snapshot workspace files before each run_shell so script changes can be rolled back. .git, node_modules and other large directories are excluded.",
  "在线": "Online",
  "地址由 PILOT_RELAY_URL 环境变量指定，界面中的修改不会生效。":
    "The URL comes from PILOT_RELAY_URL; changes in the UI have no effect.",
  "域名": "Domain",
  "域名需已解析到这台服务器，并开放 80/443 端口。安装完成后把脚本输出的整条 wss:// 连接串（含 #k= 准入码）填到上方；准入码未强制时脚本会提示何时切换成强制。只想手动部署时，可下载 Linux 包按包内 README 操作。":
    "The domain must resolve to this server with ports 80/443 open. After installation, paste the whole wss:// connection string printed by the script (including the #k= admission code) above; while the code is not enforced, the script tells you when to switch it on. For a manual setup, download the Linux package and follow its README.",
  "· 已带准入码（#k=，不会显示在界面上）": "· Admission code present (#k=, never shown here)",
  "复制": "Copy",
  "复制环境": "Copy environment",
  "复制日志": "Copy logs",
  "打开日志": "Open logs",
  "还没有日志记录": "No log entries yet",
  "复制代码": "Copy code",
  "复制命令": "Copy command",
  "复制失败，请稍后重试。": "Copy failed; try again later.",
  "复制失败": "Copy failed",
  "剪贴板不可用": "Clipboard is unavailable",
  "运行环境": "Runtime environment",
  "运行命令": "Run commands",
  "系统": "System",
  "内存": "Memory",
  "磁盘": "Disk",
  "本机资源使用": "Local resource usage",
  "CPU 占用：暂时读不到": "CPU usage: unavailable right now",
  "CPU 占用 {v1}%": "CPU usage {v1}%",
  "内存占用：暂时读不到": "Memory usage: unavailable right now",
  "内存 {v1} 已用 / {v2}，占 {v3}%": "Memory {v1} used of {v2} ({v3}%)",
  "工作区所在卷占用：暂时读不到":
    "Workspace volume usage: unavailable right now",
  "工作区所在卷 {v1} 已用 / {v2}，占 {v3}%":
    "Workspace volume {v1} used of {v2} ({v3}%)",
  "运行时": "Runtime",
  "CPU": "CPU",
  "无法读取运行环境": "Could not read the runtime environment",
  "工作区所在卷剩余空间不足 {v1}，安装依赖或构建可能因 ENOSPC 失败。":
    "Less than {v1} free on the workspace volume; installing dependencies or building may fail with ENOSPC.",
  "复制对话": "Copy chat",
  "已复制对话": "Chat copied",
  "复制相对路径": "Copy relative path",
  "复制这条消息": "Copy this message",
  "复制链接": "Copy link",
  "复盘": "Review",
  "复盘中": "Reviewing",
  "复盘会话不注册写入、命令、MCP 或记忆工具。结论只保存为记忆参考和未激活的进化草稿； 需要修改代码时，再用“交接修复”新建普通编码会话，按常规审批执行。":
    "Review sessions get no write, command, MCP or memory tools. Findings are stored only as memory reference and inactive evolution drafts; to change code, use “Hand off fix” to start a normal coding session under the usual approvals.",
  "复盘会话只注册读取工具：它读你选定范围内的会话记录、运行记录和代码，给出一份带分值的报告。结论只保存为记忆参考和未激活的进化草稿，不会自行改动行为；需要改代码时，再用“交接修复”新建普通会话。":
    "A review session gets read tools only: it reads sessions, run records and code within the scope you picked, then writes a scored report. Findings are kept as memory reference and an inactive evolution draft and never change behaviour on their own; to change code, use “Hand off fix” to start a normal session.",
  "复盘评估": "Review",
  "复盘会话已创建：只读读取源码和会话，不写入、不执行命令。":
    "Review session created: reads source and sessions only, no writes or commands.",
  "复盘只能读取这里选择范围内的会话记录和运行记录。":
    "A review can only read sessions and runs within the selected scope.",
  "复盘完成，没有新的可复用经验。":
    "Review finished; no new reusable lessons.",
  "复盘工具只能在这些目录内读取；第一个是主项目，也是文件工具的默认根目录。":
    "Review tools may read only inside these directories; the first is the main project and the default root for file tools.",
  "复盘报告": "Review report",
  "复盘模型": "Review model",
  "复盘还没有生成结构化报告，先完成评估再交接修复。":
    "The review has no structured report yet; finish it before handing off a fix.",
  "失败": "Failed",
  "失败、工具报错和负反馈后，结合具体报错自动复盘，把可复用经验写入项目记忆。":
    "After failures, tool errors or negative feedback, reflect on the actual error and write reusable lessons to project memory.",
  "字符": "characters",
  "安全": "Safe",
  "安全说明": "Security notes",
  "安装中": "Installing",
  "安装更新会退出 Pilot，当前界面会关闭并在安装完成后自动重新启动。确定继续吗？":
    "Installing the update quits Pilot; this window closes and reopens after installation. Continue?",
  "Pilot 安装在需要管理员权限的目录，安装时 Windows 会弹出授权框，请点「是」。想以后免确认，可把 Pilot 重装到当前用户目录。":
    "Pilot is installed in a folder that needs administrator rights, so Windows will ask for permission during install; click “Yes”. To avoid that, reinstall Pilot for the current user.",
  "这次安装会把 Pilot 迁移到当前用户目录，不再需要管理员授权；配对、会话和设置都会保留。旧的 Program Files 副本可以之后在「应用和功能」里手动卸载。":
    "This install moves Pilot to your user folder, so no administrator permission is needed. Pairing, sessions and settings are kept. You can uninstall the old Program Files copy later from Apps & features.",
  "完成": "Done",
  "完成更多真实任务后，Pilot 才能总结出可靠的改进。":
    "Complete more real tasks before Pilot can draw reliable conclusions.",
  "完成至少 3 次真实任务后，Pilot 才能提出第一份进化草稿。":
    "Pilot can propose its first evolution draft after at least 3 real tasks.",
  "定时任务": "Scheduled tasks",
  "审批超时": "Approval timeout",
  "审批超时需要在 0 到 3,600 秒之间。":
    "The approval timeout must be between 0 and 3,600 seconds.",
  "对比基线：本会话最早的保留快照 · 撤销按文件进行":
    "Baseline: the session's earliest kept snapshot · undo is per file",
  "尚未启用全局画像": "No global profile enabled yet",
  "尚未确认": "Not confirmed",
  "尚未连接": "Not connected",
  "尚未配置 API Key，点击设置后即可开始。":
    "No API key yet; open Settings to get started.",
  "局域网直连": "Direct LAN",
  "展开": "Expand",
  "工作区": "Workspace",
  "工作区 Hooks": "Workspace hooks",
  "工作区已移除。": "Workspace removed.",
  "工作区文件": "Workspace files",
  "工作区状态": "Workspace status",
  "工作区画像运行稳定后，可以点击“提升为全局候选”，让跨项目仍然成立的经验在所有工作区生效。":
    "Once the workspace profile is stable, click “Promote to global candidate” so lessons that hold across projects apply everywhere.",
  "已中断": "Interrupted",
  "已保存，下次配对生效。": "Saved; applies to the next pairing.",
  "已创建副本，可以从这里分叉尝试别的做法。":
    "Copy created; fork from here to try another approach.",
  "已创建普通编码会话，会先复核每条问题再修改。":
    "A normal coding session was created; each finding is verified before changes.",
  "已加入队列，当前任务结束后自动开始。":
    "Queued; starts when the current task finishes.",
  "已参照": "Referenced",
  "已发送": "Sent",
  "已加待办": "Added to todos",
  "已取消": "Cancelled",
  "已启用": "Enabled",
  "已回退。检查工作区状态后继续任务。":
    "Rolled back. Check the workspace before continuing.",
  "已复制": "Copied",
  "已把选中内容加入待办。": "Selection added to todos.",
  "选中内容": "Selected text",
  "已恢复": "Restored",
  "已截断": "Truncated",
  "已把定时任务转为待办。": "Scheduled task moved to todos.",
  "已把待办转为定时任务。": "Todo converted to a scheduled task.",
  "已把排队任务转为待办。": "Queued message moved to todos.",
  "已拒绝": "Denied",
  "已是最新": "Up to date",
  "已暂停": "Paused",
  "已暂存改动": "Staged changes",
  "已沉淀的草稿": "Saved drafts",
  "已移入回收目录": "Moved to the recycle folder",
  "已记录正反馈。": "Positive feedback recorded.",
  "已记录负反馈，Pilot 会复盘这次运行。":
    "Negative feedback recorded; Pilot will review this run.",
  "已退役": "Retired",
  "已配对设备": "Paired devices",
  "已配置": "Configured",
  "平均 tokens": "Avg tokens",
  "平均步数": "Avg steps",
  "建议已加入待办。": "Suggestion added to todos.",
  "建议：": "Suggestions:",
  "开发模式下不会执行安装": "Install is skipped in development mode",
  "开发模式下只验证下载与校验流程，不执行安装。":
    "In development mode only download and verification run; nothing is installed.",
  "开启后 Pilot 会在本机启动配对服务。同一局域网可直接连接，跨网络需先配置自建中继器。":
    "Enabling starts the pairing service on this machine. The same LAN connects directly; cross-network needs a relay.",
  "开启后即可配对": "Enable to start pairing",
  "开启手机连接": "Enable mobile link",
  "开始复盘": "Start review",
  "开始这个任务": "Start this task",
  "当前": "Current",
  "当前 v": "Current v",
  "当前任务": "Current task",
  "当前任务结束后自动开始": "Starts after the current task finishes",
  "当前会话的执行模式": "Execution mode for this session",
  "当前会话还没有可复制的内容。": "This session has nothing to copy yet.",
  "当前使用": "In use",
  "当前工作区": "Current workspace",
  "当前工作区尚未启用画像": "No profile enabled for this workspace",
  "当前工作区画像": "Current workspace profile",
  "当前有": "Currently",
  "当前版本": "Current version",
  "当前运行画像": "Current run profile",
  "当前通过自建中继器跨网络配对。":
    "Currently paired across networks through your relay.",
  "当前项目：": "Current project:",
  "待办": "Todos",
  "待办已加入队列，当前任务结束后自动开始。":
    "Todo queued; starts after the current task finishes.",
  "待办已发送。": "Todo sent.",
  "待发送图片": "Pending images",
  "待安装": "Ready to install",
  "思考过程": "Reasoning",
  "恢复": "Restore",
  "我": "Me",
  "我的提问": "My questions",
  "所有会话的快照合计上限（MB）；超过后按时间淘汰最旧的回退点，每个会话至少保留一个":
    "Total snapshot budget (MB) across sessions; past it, the oldest checkpoints are evicted, keeping at least one per session",
  "所有工作区": "All workspaces",
  "所有工作区的新运行都会使用这个版本。":
    "New runs in every workspace use this version.",
  "所有工作区都会读取；编辑后新运行生效。项目专属规则仍写在各工作区的 PILOT.md / AGENTS.md。":
    "Read by every workspace; edits apply to new runs. Project rules still live in each workspace's PILOT.md / AGENTS.md.",
  "所有数据保存在本机，不需要账号或登录。":
    "All data stays on this machine. No account or login required.",
  "手动": "Manual",
  "手机与电脑之间使用 ECDH P-256 + HKDF + AES-256-GCM 端到端加密。中继器只转发密文， 无法读取会话、命令或 API Key；配对凭证保存在电脑用户数据目录，可随时在这里解除。":
    "Phone and desktop use ECDH P-256 + HKDF + AES-256-GCM end-to-end encryption. The relay forwards ciphertext only and cannot read sessions, commands or API keys; pairing credentials stay in the desktop user data directory and can be removed here anytime.",
  "手机与电脑可以不在同一网络。自建中继器只转发端到端加密的密文；关闭电脑或退出 Pilot 后会断开。":
    "Phone and desktop can be on different networks. Your relay forwards end-to-end encrypted ciphertext only; closing the desktop or quitting Pilot disconnects them.",
  "手机与电脑需要连接同一个局域网。关闭电脑或退出 Pilot 后会自动断开。":
    "Phone and desktop must share a LAN. Closing the desktop or quitting Pilot disconnects them.",
  "手机可创建的工作区": "Workspaces the phone may create",
  "手机端默认只能在电脑已打开的工作区里新建会话。把目录授权在这里后， 手机可以在这些目录下新建子文件夹作为工作区；访问范围仍然限制在新工作区内。":
    "By default the phone can only start sessions in workspaces already open on the desktop. Authorize directories here and the phone may create subfolders there as workspaces; access stays confined to the new workspace.",
  "手机连接": "Mobile link",
  "手机连接已关闭": "Mobile link is off",
  "手机连接已开启": "Mobile link is on",
  "手机页面": "Mobile page",
  "打开": "Open",
  "打开会话": "Open session",
  "打开文件…": "Open file…",
  "打开文件夹": "Open folder",
  "打开本地工作区": "Open a local workspace",
  "打开目录": "Open directory",
  "执行中": "Running",
  "执行前创建。 快照排除": "Created before running. Snapshots exclude",
  "执行完成": "Completed",
  "执行模式 + 显式规则 + OS 沙箱。规则由程序强制执行，按“拒绝 → 询问 → 允许”匹配，拒绝规则和受保护路径在任何模式下都不能被覆盖。":
    "Execution mode + explicit rules + OS sandbox. The harness enforces deny → ask → allow; deny rules and protected paths cannot be overridden in any mode.",
  "执行过程": "Execution",
  "执行时间 {v1}": "Ran at {v1}",
  "扫描二维码配对": "Scan a QR code to pair",
  "手机请求连接这台电脑": "A phone wants to connect to this computer",
  "浏览器请求访问这台电脑": "A browser wants to access this computer",
  "确认之后这台浏览器才能打开工作台。":
    "This browser gets the workbench only after you confirm.",
  "浏览器": "Browser",
  "主机": "Host",
  "客户机": "Client",
  "身份": "Identity",
  "主机用户": "Host user",
  "浏览器页面必须与本机共用同一份会话、工作区与设置，因此浏览器访问固定为主机用户。":
    "A browser page has to share this computer's sessions, workspaces and settings, so browser access is always a host user.",
  "只给本人使用的浏览器放行。若你没有在别的设备上打开过这个地址，请选拒绝。":
    "Allow only a browser you opened yourself. If you did not open this address on another device, deny it.",
  "你可以随时在电脑上解除这次授权。":
    "You can revoke this access from the computer at any time.",
  "扫码不会自动配对：确认之后，这台手机才能读取会话、查看文件并驱动 Agent。":
    "Scanning does not pair on its own. Only after you confirm can this phone read sessions, view files and drive the agent.",
  "只在你本人刚刚扫描了电脑上的二维码时允许。若你没有拿出手机扫码，请选拒绝；拒绝后手机需要重新扫码。":
    "Allow only when you just scanned the QR code on this computer yourself. If you did not take out your phone, deny it; the phone then has to scan again.",
  "这台手机还可以随时在电脑上解除授权。":
    "You can revoke this phone from the computer at any time.",
  "这个配对请求已失效，请让手机重新扫码。":
    "That pairing request is no longer valid; scan the QR code again on the phone.",
  "允许连接": "Allow connection",
  "允许访问": "Allow access",
  "云端中继": "Cloud relay",
  "局域网": "Local network",
  "未知地址": "Unknown address",
  "未命名复盘": "Untitled review",
  "还没有复盘会话。新建一次后会出现在这里。":
    "No review sessions yet; start one and it shows up here.",
  "{v1} 秒后自动拒绝": "Auto-deny in {v1}s",
  "{v1} 秒": "{v1}s",
  "已超时": "Timed out",
  "已超时，将自动拒绝": "Timed out; the request will be denied",
  "扫码下载安卓 App。安装后打开 App，用里面的「扫一扫」扫描下方配对二维码；也可以直接用浏览器打开网页版。":
    "Scan to download the Android app. After installing, use its scanner on the pairing QR code below, or open the web version in a browser.",
  "把其他项目空间作为只读参照加入下一条消息，模型需要时会读取其中的文件。":
    "Add other projects as read-only references for the next message; the model reads their files when needed.",
  "把当前会话整理成「我的指令 → Pilot 回复」的轮次，支持检索并跳回原始消息。":
    "Turns this session into instruction → Pilot reply rounds, with search and jump-back.",
  "把想法交给 Pilot": "Hand the idea to Pilot",
  "拒绝": "Deny",
  "拒绝规则": "Deny rules",
  "按工作区筛选": "Filter by workspace",
  "按角色筛选": "Filter by role",
  "按时间筛选": "Filter by time",
  "换一个关键词，或清空搜索查看全部轮次。":
    "Try another keyword, or clear the search to see every round.",
  "换一个关键词，或者放宽工作区、角色和时间筛选。":
    "Try another keyword, or loosen the workspace, role and time filters.",
  "排队": "Queued",
  "排队中的任务": "Queued tasks",
  "控制": "Control",
  "控制设备": "Control device",
  "描述任务，Pilot 会读取工作区并自主执行…":
    "Describe a task; Pilot reads the workspace and works on its own…",
  "提升为全局候选": "Promote to global candidate",
  "提示词增补": "Prompt additions",
  "提示：记忆不是聊天记录。它应当简短、可复用，并且只描述跨任务仍然成立的偏好或约束。":
    "Tip: memory is not a chat log. Keep it short, reusable, and limited to preferences or constraints that hold across tasks.",
  "插入": "Insert",
  "插入当前任务": "Insert into current task",
  "插入当前任务，在下一步生效": "Insert into the current task, effective on its next step",
  "搜索会话、工作区或消息": "Search sessions, workspaces or messages",
  "搜索当前项目的历史会话…": "Search this project's history…",
  "搜索所有会话，例如：登录超时、部署脚本、鉴权方案":
    "Search all sessions, e.g. login timeout, deploy script, auth design",
  "搜索这个会话的提问与回复…": "Search this session's questions and replies…",
  "撤销此文件": "Undo this file",
  "撤销清除": "Undo clear",
  "收起": "Collapse",
  "效率": "Efficiency",
  "文件": "Files",
  "文件 + 对话": "Files + chat",
  "文件快照保存在工作区之外；对话和文件可以分别回退。":
    "File snapshots live outside the workspace; conversation and files roll back independently.",
  "新会话默认执行模式": "Default mode for new sessions",
  "新增": "New",
  "新建": "New",
  "新建任务": "New task",
  "新建任务并完成对话后，消息会自动进入知识库。":
    "Start a task and finish one exchange; messages enter the knowledge base automatically.",
  "新建复盘评估": "New review",
  "新建普通编码会话处理报告中的问题":
    "Start a normal coding session to fix the reported issues",
  "无法读取更新状态，请稍后重试。": "Could not read the update state; try again later.",
  "无法预览": "Preview unavailable",
  "无需登录": "No login required",
  "旧版本保留为历史；效果变差可以一键退回。":
    "Older versions stay in history; roll back with one click if quality drops.",
  "时间": "Time",
  "显示": "Show",
  "显示全部会话": "Show all sessions",
  "暂停": "Pause",
  "暂停当前任务，可随时继续": "Pause the current task; resume anytime",
  "暂停当前任务？暂停后可随时点「继续」接着执行。":
    "Pause the current task? You can resume anytime with “Continue”.",
  "停止当前任务？停止后不会自动继续，需要重新发送。":
    "Stop the current task? It will not resume automatically; send a new message to continue.",
  "更新包通过 HTTPS 下载，并与清单中的 SHA-256 校验一致后才会提供安装入口。下载在后台进行， 不会中断当前会话；安装需要你手动确认。":
    "Updates download over HTTPS and only offer install after matching the manifest SHA-256. Downloads run in the background without interrupting the session; install needs your confirmation.",
  "支持增量更新时只下载变化的数据块；首次更新或服务器不支持时仍下载完整安装包。":
    "Incremental updates transfer only the blocks that changed; the first update, or a server without Range support, still downloads the full installer.",
  "更新可用": "Update available",
  "更新已下载，点击查看安装": "Update downloaded; click to install",
  "更早的 {v1} 项执行过程 · 展开": "{v1} earlier execution steps · expand",
  "最多参照 8 个项目": "Up to 8 projects",
  "最多附图 {v1} 张": "Up to {v1} images",
  "一次最多上传 {v1} 个文件": "Up to {v1} files per upload",
  "松开即可附件：图片随消息发送，其它文件上传到工作区":
    "Drop to attach: images travel with the message, other files go into the workspace",
  "最大步数": "Max steps",
  "最大步数需要在 1 到 1,000 之间。": "Max steps must be between 1 and 1,000.",
  "最近 30 天": "Last 30 days",
  "最近 7 天": "Last 7 days",
  "最近会话": "Recent sessions",
  "最近活动": "Recent",
  "有": "Yes",
  "未命名会话": "Untitled session",
  "未授权任何目录。手机端只能在电脑已打开的工作区里新建会话。":
    "No directories authorized. The phone can only start sessions in workspaces already open on the desktop.",
  "未暂存改动": "Unstaged changes",
  "未检查": "Not checked",
  "未知": "Unknown",
  "未知模型": "Unknown model",
  "未选择": "Not selected",
  "未选择会话": "No session selected",
  "未选择工作区": "No workspace selected",
  "未配置": "Not configured",
  "未配置中继地址；手机与电脑只能在同一局域网内连接。手机端要求 wss://。":
    "No relay URL; phone and desktop can only connect over the same LAN. The phone requires wss://.",
  "本地优先 · 自我进化": "Local-first · self-evolving",
  "本地加密保存，不注册、不登录，配置后即可开始。":
    "Stored locally and encrypted. No sign-up or login; configure and start.",
  "本地文件": "Local files",
  "本工作区的新运行会使用这个版本的提示词与策略。":
    "New runs in this workspace use this version's prompt and strategy.",
  "本机预览": "Local preview",
  "本次命令使用的 Shell 解释器": "Shell interpreter used for this command",
  "本轮任务": "This task",
  "本轮计划": "This plan",
  "计划 {v1}/{v2} 完成": "Plan {v1}/{v2} done",
  "权限与沙箱": "Permissions and sandbox",
  "条命中": " hits",
  "条消息": " messages",
  "条消息前": " messages earlier",
  "条记录": " records",
  "条记忆": " memories",
  "查看": "View",
  "查看全局提示词增补": "View global prompt additions",
  "查看当前会话": "View current session",
  "查看报告": "View report",
  "查看提示词增补": "View prompt additions",
  "根因：": "Root cause:",
  "桌面通知": "Desktop notifications",
  "检查中": "Checking",
  "检查中…": "Checking…",
  "检查失败": "Check failed",
  "检查更新": "Check for updates",
  "检索所有工作区里的历史会话，找到结论、决策和原始消息并直接跳回。":
    "Search history across all workspaces; find conclusions, decisions and original messages, and jump straight back.",
  "网页服务": "Web service",
  "打开后，浏览器访问下面这个端口看到的就是当前窗口这套界面（会话、知识库、设置都一样），操作与 `pilot serve` 启动的网页服务完全相同。服务只在本机与局域网内监听；关掉开关即停止。":
    "Once enabled, opening the port below in a browser shows exactly this window's interface (sessions, knowledge and settings included) and behaves like the web service `pilot serve` starts. It listens on this machine and the LAN only; switching it off stops it.",
  "开启网页服务": "Enable web service",
  "任一应用内的电脑都能用浏览器打开。若不打开这个开关，浏览器访问只能看到手机配对面板。":
    "Any computer on the same network can open it in a browser. With the switch off, a browser only finds the phone pairing panel.",
  "{v1} – {v2}，默认 {v3}": "{v1} – {v2}, default {v3}",
  "端口需要是 {v1} 到 {v2} 之间的整数。": "The port must be a whole number between {v1} and {v2}.",
  "访问地址": "Address",
  "保存后如果端口变了，旧地址会失效。": "If the port changes after saving, the old address stops working.",
  "保存设置后开始监听。": "Listening starts once you save the settings.",
  "已授权的网页": "Authorized pages",
  "浏览器每次申请并被允许访问都会留一条记录；关掉上面的开关会全部撤销，刷新页面需要重新申请。":
    "Every browser you approve leaves one record here. Switching the service off revokes all of them, so a refresh has to ask again.",
  "授权时间 {v1}": "Granted {v1}",
  "还没有网页授权记录。": "No authorized page yet.",
  "撤销": "Revoke",
  "模型": "Model",
  "标签": "Tag",
  "最多四个字，如“个人”“公司A”": "Up to four characters, e.g. “Personal” or “Acme”.",
  "不超过四字": "Four characters max",
  "这个任务使用的会话模型": "Session model used by this task",
  "会话模型只影响这个任务，不会改统一设置":
    "The session model affects only this task; shared settings stay unchanged",
  "这个任务将使用「{v1}」": "This task now uses “{v1}”.",
  "这个任务已跟随全局会话模型":
    "This task follows the global session model again.",
  "跟随全局（{v1}）": "Follow global ({v1})",
  "跟随全局": "Follow global",
  "看差异": "View diff",
  "跟随全局会话模型": "Follow the global session model",
  "模型基于证据提出提示词增补和策略调整，而不是随意改写代码。":
    "The model proposes prompt additions and strategy changes from evidence, not arbitrary code rewrites.",
  "模型没有返回可见内容。": "The model returned no visible content.",
  "模型资源": "Model resources",
  "所有模型都从这里统一配置。会话、复盘和评估只引用资源；密钥仅保存在本机并加密。":
    "Configure every model here. Session, review and evaluation roles only reference resources; keys stay on this device and are encrypted.",
  "添加模型资源": "Add model resource",
  "已配置密钥": "Key configured",
  "缺少密钥": "Missing key",
  "会话模型": "Session model",
  "会话与复盘": "Chat and review",
  "会话模型用于普通对话与工具调用；复盘模型只在评审会话里使用。":
    "The chat model handles normal dialogue and tool calls; the review model is only used in review sessions.",
  "普通会话、分析和工具调用使用这个资源。":
    "Chats, analysis and tool calls use this resource.",
  "复盘会话使用；跟随会话模型时不需要单独配置。":
    "Used for review sessions; no separate setup is needed when following the session model.",
  "跟随会话模型": "Follow session model",
  "评估模型": "Evaluation models",
  "推荐两个独立模型": "Two independent models recommended",
  "默认第一评估和第二评估；可增加更多，也可减少到一个。未选择时由会话模型自评，不算独立评审。":
    "Defaults to a first and second evaluator; add more or reduce to one. With no selection the session model reviews itself, which does not count as independent review.",
  "选择模型资源": "Select a model resource",
  "添加评估模型": "Add evaluation model",
  "第一评估": "First evaluator",
  "第二评估": "Second evaluator",
  "第三评估": "Third evaluator",
  "第四评估": "Fourth evaluator",
  "第五评估": "Fifth evaluator",
  "第六评估": "Sixth evaluator",
  "未命名模型": "Unnamed model",
  "至少保留一个模型资源。": "Keep at least one model resource.",
  "至少启用一个模型资源。": "Keep at least one model resource enabled.",
  "会话模型不能使用已停用的模型资源。":
    "The session model cannot use a disabled model resource.",
  "每个模型资源都要填写接口地址和模型名。":
    "Every model resource needs an endpoint and model name.",
  "模型资源的接口地址必须是 http:// 或 https:// 地址：{v1}":
    "A model resource endpoint must be an http:// or https:// address: {v1}",
  "同一个模型资源不能重复作为评估模型。":
    "The same model resource cannot be used as an evaluator twice.",
  "次完成": " completed",
  "次异常": " errors",
  "次运行": " runs",
  "正反馈": "Positive",
  "正在启动…": "Starting…",
  "正在执行": "Running",
  "正在检测运行环境…": "Detecting the runtime…",
  "正在检索…": "Searching…",
  "正在比较文件…": "Comparing files…",
  "正在理解任务": "Understanding the task",
  "正在读取回退点…": "Reading checkpoints…",
  "正在读取更新状态…": "Reading update state…",
  "正在载入…": "Loading…",
  "正确性": "Correctness",
  "步 ·": " steps ·",
  "步数": "Steps",
  "步数上限": "Step limit",
  "每个会话最多保留多少个文件快照": "File snapshots kept per session",
  "每个工作区独立保存会话、项目记忆和运行画像。移除工作区只清除 Pilot 的本地数据，不会删除文件夹。":
    "Each workspace keeps its own sessions, project memory and run profile. Removing one clears Pilot's local data only; the folder stays.",
  "每个目录都需要一个别名。": "Every directory needs an alias.",
  "每天": "Daily",
  "每天固定时间": "Daily at a fixed time",
  "每次任务记录步数、工具错误、tokens 和你的反馈。":
    "Every task records steps, tool errors, tokens and your feedback.",
  "每次运行按类别配额挑选最有价值的记忆，而不是简单取最新几条。":
    "Each run picks the most valuable memories per category quota instead of simply taking the newest ones.",
  "每次运行按类别配额注入最多 {v1} 条（{v2} 条真的被用过），单条超过 {v3} 字符会被截断，磁盘上限 {v4} 条。":
    "Each run injects at most {v1} entries on a per-category quota ({v2} have actually been used); an entry longer than {v3} characters is truncated, and the workspace keeps up to {v4}.",
  "每次运行前，项目记忆被放入系统提示。":
    "Project memory is injected into the system prompt before each run.",
  "按进化机制的节奏自动完成提案、独立评审和启用；失败率明显上升时自动回滚。":
    "Runs proposal, independent review and activation on the evolution mechanism's cadence; a clear failure-rate regression rolls back automatically.",
  "自动运行系统进化": "Run system evolution automatically",
  "每行一条，例如 Bash(npm test:*) 或 Edit(src/**)":
    "One per line, e.g. Bash(npm test:*) or Edit(src/**)",
  "每隔一段时间": "Every interval",
  "沙箱不可用：命令以普通权限运行，未沙箱化的 shell 始终逐次确认":
    "Sandbox unavailable: commands run with normal permissions, and unsandboxed shell always asks",
  "沙箱内命令自动放行": "Auto-approve commands in the sandbox",
  "没有匹配的会话。": "No matching sessions.",
  "没有发现需要处理的问题。": "No issues to fix.",
  "没有变化": "No changes",
  "没有可回滚的历史全局版本。": "No earlier global version to roll back to.",
  "没有可回滚的历史版本。": "No earlier version to roll back to.",
  "没有可显示的文本差异。": "No text diff to show.",
  "没有可用的基线快照，无法撤销": "No baseline snapshot; cannot undo",
  "没有待处理的候选版本": "No candidate versions pending",
  "没有打开的工作区": "No workspace open",
  "没有找到相关内容": "Nothing found",
  "没有找到相关对话": "No matching conversations",
  "没有输出": "No output",
  "测试中…": "Testing…",
  "测试连接": "Test connection",
  "消息命中": "Message hits",
  "消息投递方式": "Delivery",
  "添加图片": "Add images",
  "添加待办": "Add todo",
  "添加待办，Enter 保存": "Add a todo, Enter to save",
  "添加目录": "Add directory",
  "清空搜索": "Clear search",
  "清除": "Clear",
  "清除已发送": "Clear sent",
  "温度": "Temperature",
  "温度需要在 0 到 1 之间。": "Temperature must be between 0 and 1.",
  "点击“生成新版本”，Pilot 会分析近期运行并提出一份改进草稿。":
    "Click “Generate new version” and Pilot analyzes recent runs to propose an improvement draft.",
  "点击编辑": "Click to edit",
  "点击编辑排队内容": "Click to edit the queued message",
  "点击重命名": "Click to rename",
  "版本未知": "Version unknown",
  "状态": "Status",
  "独立只读评估：读取源码和会话记录，不改文件、不运行命令、不联网。":
    "Independent read-only review: reads source and sessions, changes nothing, runs nothing, no network.",
  "独立评审": "Independent review",
  "独立评审通过": "Independent review passed",
  "生成中文版": "Generate Chinese version",
  "生成二维码": "Generate QR code",
  "生成二维码后，用手机扫描即可打开 Pilot Link。":
    "Once generated, scan the QR code with your phone to open Pilot Link.",
  "生成新版本": "Generate new version",
  "生效。画像按工作区保存，切换工作区会看到各自的版本。":
    " takes effect. Profiles are stored per workspace; switching shows each one's version.",
  "生效中": "Active",
  "用会话最早的快照恢复这个文件": "Restore this file from the session's earliest snapshot",
  "用户创建": "Created by you",
  "用户发送的图片": "Images you sent",
  "用手机相机或浏览器扫描，会打开 Pilot Link 并确认配对。":
    "Scan with your phone camera or browser to open Pilot Link and confirm pairing.",
  "由工作区提升": "Promoted from a workspace",
  "电脑标识": "Desktop ID",
  "外观": "Appearance",
  "暗色与浅色两套主题，只有一处主题色标记选中、焦点和进度，长时间使用也不刺眼。":
    "Two themes, dark and light; a single accent marks selection, focus and progress, so it stays calm over long sessions.",
  "主题模式": "Theme mode",
  "深色": "Dark",
  "浅色": "Light",
  "字号": "Text size",
  "标准": "Standard",
  "大": "Large",
  "特大": "Extra large",
  "只放大文字，按钮和间距保持不变；标准就是原来的字号。":
    "Text only; buttons and spacing stay the same. Standard is the original size.",
  "任务完成、运行失败或等待审批时提醒你；桌面通知与邮件通知都在这里。":
    "Get a reminder when a run finishes, fails or waits for approval; desktop and email notifications both live here.",
  "Pilot 在前台时也会显示；点击通知可回到对应会话。":
    "Shown even while Pilot is in the foreground; click a notification to jump back to its session.",
  "界面语言": "Interface language",
  "界面语言。默认跟随系统；智能体始终使用你提问的语言回复。":
    "Interface language. Follows the system by default; the agent always replies in the language you write in.",
  "的窗口为": " has a context window of",
  "目录别名": "Directory alias",
  "目录别名不能重复，工具靠它区分根目录。":
    "Directory aliases must be unique; tools use them to identify roots.",
  "真实运行": "Real runs",
  "知识库": "Knowledge",
  "知识库层级": "Knowledge levels",
  "移到待办，确认后手动发送": "Move to todos; send manually after confirming",
  "移除": "Remove",
  "移除参照": "Remove reference",
  "移除图片": "Remove image",
  "移除工作区": "Remove workspace",
  "移除授权": "Remove authorization",
  "移除这个目录": "Remove this directory",
  "稍后一次": "Later once",
  "第": "Round ",
  "等大型目录，也不追踪工作区外的副作用。":
    " and other large directories, and does not track side effects outside the workspace.",
  "等待批准": "Waiting for approval",
  "最近的复盘会话": "Recent review sessions",
  "系统语言：{locale}": "System language: {locale}",
  "继续": "Continue",
  "继续补充任务；可排队，或插入当前任务在下一步生效…":
    "Add another task; queue it, or insert it into the current task for its next step…",
  "综合分": "Overall score",
  "编辑": "Edit",
  "编辑并重新生成": "Edit and regenerate",
  "编辑这条消息": "Edit this message",
  "置信度": "Confidence",
  "自动与学习": "Automation and learning",
  "自动复盘": "Auto review",
  "自动复盘、自动进化、探索学习与质量闸门":
    "Auto review, auto evolution, autonomous learning and the quality gate",
  "自动快照在每次发送任务前创建；开启后也会在":
    "Checkpoints are created before each task; when enabled, also before",
  "自动继续次数上限": "Auto-continue limit",
  "自动继续次数需要在 1 到 10 之间。":
    "The auto-continue limit must be between 1 and 10.",
  "自动（优先 Git Bash，其次 WSL，最后 cmd）":
    "Auto (Git Bash, then WSL, then cmd)",
  "自动（可用时启用）": "Auto (enabled when available)",
  "自学习循环": "Self-learning loop",
  "自建中继器": "Self-hosted relay",
  "自建中继器已连接": "Self-hosted relay connected",
  "自建中继器待命": "Self-hosted relay ready",
  "自我进化": "Evolution",
  "自我进化版本已更新。": "Evolution version updated.",
  "至少保留一个可读取的目录。": "Keep at least one readable directory.",
  "至少需要 3 次运行记录": "At least 3 runs required",
  "草稿不会影响运行，除非通过评审或被你手动启用。":
    "Drafts do not affect runs unless reviewed or manually enabled.",
  "角色": "Role",
  "解除配对": "Unpair",
  "计划": "Plan",
  "让 Pilot 基于近期运行提出改进": "Ask Pilot to propose improvements from recent runs",
  "让 Pilot 复盘这次运行，提炼可复用的经验":
    "Ask Pilot to review this run and extract reusable lessons",
  "让 Pilot 重新生成这条回答": "Ask Pilot to regenerate this answer",
  "记录下一步，稍后一键发送": "Capture the next step; send it later in one click",
  "记忆": "Memory",
  "会话记忆": "Session memory",
  "选择会话后，这里会列出这轮任务用到的项目记忆。":
    "Pick a session to list the project memory that task used.",
  "没有匹配的记忆": "No matching memory",
  "这个会话还没有记忆": "This session has no memory yet",
  "换一个关键词，或清空搜索查看全部条目。":
    "Try another keyword, or clear the search to see every entry.",
  "运行会把工作区里相关的记忆写进提示词，Pilot 也可以用 remember 记录新事实。":
    "Runs feed relevant workspace memory into the prompt; Pilot can also record new facts with remember.",
  "本会话写入": "Written in this session",
  "没有匹配的记忆，清空搜索可查看这个会话的全部记忆。":
    "No matching memory; clear the search to see all of this session's memory.",
  "从左侧选择一条记忆查看内容。": "Pick a memory on the left to read it.",
  "本轮提示词已注入": "Injected into this run's prompt",
  "删除这条记忆": "Delete this memory",
  "删除这条记忆？Pilot 之后不会再使用它。":
    "Delete this memory? Pilot will stop using it.",
  "提示词注入 {v1} 次 · 复现 {v2} 次":
    "Injected {v1} times · reinforced {v2} times",
  "你写入的长期偏好": "Your stored preference",
  "运行复盘产生": "From a run review",
  "Pilot 运行时记录": "Recorded by Pilot at runtime",
  "打开项目记忆": "Open project memory",
  "项目记忆按工作区共享 · 这里只列出本会话用到的条目":
    "Project memory is shared per workspace; only entries this session used are listed here",
  "搜索本会话的记忆": "Search this session's memory",
  "不变量": "Invariant",
  "验证路径": "Verification",
  "走不通的路": "Dead ends",
  "代码事实": "Code facts",
  "环境约束": "Environment",
  "用户偏好": "User preference",
  "废弃方案": "Abandoned",
  "记忆如何工作": "How memory works",
  "设置": "Settings",
  "打开设置": "Open settings",
  "双击顶栏切换全屏": "Double-click the title bar to toggle full screen",
  "设置已保存。": "Settings saved.",
  "证据": "Evidence",
  "证据受阻": "Evidence blocked",
  "评估中，尚未生成报告": "Review in progress; no report yet",
  "评估目标": "Review objective",
  "询问规则": "Ask rules",
  "语言": "Language",
  "请开始复盘评估。先核对可读目录与会话证据，再按报告协议输出结构化结论。":
    "Start the review. Check the readable directories and session evidence first, then output structured findings per the report protocol.",
  "读取中…": "Reading…",
  "调用工具": "Tool calls",
  "负反馈": "Negative",
  "超时后自动拒绝；0 表示一直等待":
    "Auto-reject after the timeout; 0 waits indefinitely",
  "跟随系统": "Follow system",
  "跨所有工作区生效。由工作区画像提升而来，评审通过后仍需你手动启用，避免一个项目的经验影响所有项目。":
    "Applies to every workspace. Promoted from a workspace profile; even after review you must enable it manually so one project's lessons do not affect all.",
  "跨项目对比同类问题的历史会话。只读取，不修改。":
    "Compare similar past sessions across projects. Read-only.",
  "跳到原始消息": "Jump to original message",
  "转为定时任务": "Convert to scheduled task",
  "转待办": "Convert to todo",
  "轮": " rounds",
  "轮对话": " rounds",
  "软件更新": "Software update",
  "载入中…": "Loading…",
  "载入会话…": "Loading session…",
  "载入执行过程": "Load execution steps",
  "这一轮的执行过程尚未载入，展开即可查看。":
    "This run's execution steps are not loaded yet; expand to fetch them.",
  "正在载入执行过程…": "Loading execution steps…",
  "这一轮的执行过程已经不在会话记录里了。":
    "This run's execution steps are no longer in the session record.",
  "未加载": "Not loaded",
  "{v1} 项步骤": "{v1} steps",
  "输出": "Output",
  "边界：": "Boundaries:",
  "达到步数上限": "Step limit reached",
  "达到步数上限，任务已暂停。": "Step limit reached; the task is paused.",
  "运行中": "Running",
  "运行中遇到工具报错会先即时反思并调整方案；失败、工具报错或负反馈后还会结合报错细节自动复盘。":
    "Tool errors during a run trigger immediate reflection and a plan adjustment; failures, tool errors and negative feedback also trigger a review with the actual error details.",
  "运行参数": "Run parameters",
  "运行复盘": "Run review",
  "运行失败": "Run failed",
  "运行样本": "Run samples",
  "运行画像": "Run profile",
  "运行证据": "Run evidence",
  "运行项目测试，定位并修复所有失败项":
    "Run the project tests, find and fix every failure",
  "返回": "Back",
  "还差一个 API Key": "One API key needed",
  "还没有会话。点击「新建任务」开始。": "No sessions yet. Click “New task” to start.",
  "还没有其他项目。先在侧栏打开另一个工作区，再回来添加参照。":
    "No other projects yet. Open another workspace in the sidebar, then come back to add references.",
  "还没有可检索的会话": "No searchable sessions yet",
  "还没有启用的运行画像。Pilot 会在累计运行后提出候选版本，经独立评审后再启用。":
    "No run profile enabled yet. Pilot proposes candidates after enough runs; they enable after independent review.",
  "还没有回退点。发送一次任务或手动保存一个快照。":
    "No checkpoints yet. Send a task or save a snapshot manually.",
  "还没有工作区": "No workspaces yet",
  "还没有工作区。点击上方的文件夹按钮打开一个本地项目。":
    "No workspace yet. Click the folder button above to open a local project.",
  "还没有手机完成配对。": "No phone paired yet.",
  "还没有运行记录": "No runs yet",
  "还没有选中的会话": "No session selected yet",
  "还没有选择会话": "No session selected yet",
  "还没有选择工作区": "No workspace selected yet",
  "还没有项目记忆": "No project memory yet",
  "这个会话没有可审阅的文件变更": "No reviewable file changes in this session",
  "这个会话还没有产出文件": "This session has not produced files",
  "这个会话还没有可检索的对话": "This session has no searchable conversation",
  "这个工作区还没有会话": "This workspace has no sessions yet",
  "这个工作区还没有自己的运行画像；画像按工作区保存，其他工作区的版本不会显示在这里。 累计至少 3 次真实任务后，可以手动生成第一份候选版本。":
    "This workspace has no run profile yet; profiles are per workspace, so others do not appear here. After at least 3 real tasks you can generate the first candidate manually.",
  "这个文件夹是空的": "This folder is empty",
  "这次回答不够好": "This answer was not good enough",
  "这次回答有帮助": "This answer was helpful",
  "进化": "Evolution",
  "进化草稿": "Evolution draft",
  "适用于 Ubuntu / Debian 云服务器。填写域名与邮箱后复制命令，在服务器上以 root 执行；脚本会安装 Node.js、中继器、systemd 与 nginx，并申请 HTTPS 证书。":
    "For Ubuntu / Debian cloud servers. Enter the domain and email, copy the command and run it as root; the script installs Node.js, the relay, systemd and nginx, and obtains an HTTPS certificate.",
  "选择一个会话后，这里会列出 Pilot 写入或修改过的文件。":
    "Select a session to list files Pilot wrote or modified.",
  "选择一个工作区后，Pilot 会为它维护独立的项目记忆。":
    "Select a workspace and Pilot keeps its own project memory.",
  "选择一个本地文件夹，Pilot 才能开始工作。":
    "Select a local folder before Pilot can start.",
  "选择会话": "Select session",
  "选择工作区文件夹": "Select workspace folder",
  "选择手机可创建的工作区目录": "Choose directories the phone may use",
  "选择文件夹": "Select folder",
  "逐条审批": "Ask each time",
  "通知": "Notifications",
  "通过": "Pass",
  "邮箱": "Email",
  "配置 API Key 后发送任意消息即可开始评估。":
    "Set an API key, then send any message to start the review.",
  "重启并安装": "Restart and install",
  "重新启用": "Re-enable",
  "重新检查更新": "Check for updates again",
  "重新生成": "Regenerate",
  "重试": "Retry",
  "错误": "Error",
  "长任务自动继续": "Auto-continue long tasks",
  "截图视觉反馈": "Screenshot vision feedback",
  "智能体截图后，把压缩图片作为观察结果发给模型检查界面。若模型端点拒绝图片输入会自动退回文字；关闭后只保存截图，不发送图片。":
    "After a screenshot, send the compressed image to the model as an observation so it can check the UI. Endpoints that reject image input fall back to text automatically; when off, screenshots are only saved to disk.",
  "长期上下文": "Long-term context",
  "问题与建议 ·": "Issues and suggestions ·",
  "间隔": "Interval",
  "阅读 README 和核心代码，指出三个最值得改进的地方":
    "Read the README and core code, and point out the three most worthwhile improvements",
  "需要你的确认": "Needs your confirmation",
  "需要先配置 API Key": "Set an API key first",
  "需要处理": "Needs attention",
  "项目": "Project",
  "项目指令 ·": "Project instructions ·",
  "项目知识库": "Project knowledge",
  "项目记忆": "Project memory",
  "项目记忆已更新。": "Project memory updated.",
  "频率": "Frequency",
  "高": "High",
  "默认值适合大多数任务；增大上下文会消耗更多 tokens。当前模型":
    "Defaults suit most tasks; a larger context costs more tokens. The current model",
  "（未指定）": "(not specified)",
  "（这一轮还没有回复）": "(no reply in this round yet)",
  " · {v1} 处修改": " · {v1} edits",
  " · 目标：{v1}": " · Objective: {v1}",
  " · 显示最近 {v1} 轮": " · showing the latest {v1} rounds",
  " 上次检查：{v1}。": " Last checked: {v1}.",
  "，{v1} 台在线": ", {v1} online",
  "（参照项目：{v1}）": "(references: {v1})",
  "（附带 {v1} 张图片）": "({v1} images attached)",
  "{v1}\n\n这个操作只处理这一个文件。": "{v1}\n\nThis only affects this file.",
  "{v1} · {v2}{v3}": "{v1} · {v2}{v3}",
  "{v1} · 本地工作区": "{v1} · local workspace",
  "{v1} · 本地智能体": "{v1} · local agent",
  "{v1} · 点击管理工作区": "{v1} · click to manage workspaces",
  "{v1} {v2} 轮{v3}": "{v1} {v2} rounds{v3}",
  "{v1} 分钟前": "{v1} minutes ago",
  "{v1} 分钟后": "in {v1} minutes",
  "{v1} 个工具失败": "{v1} tools failed",
  "委派 {v1} 次 / {v2} 步": "delegated {v1}× / {v2} steps",
  "模型 {v1}s / 工具 {v2}s / 快照 {v3}s": "model {v1}s / tools {v2}s / checkpoints {v3}s",
  "{v1} 个会话": "{v1} sessions",
  "{v1} 个指定会话": "{v1} selected sessions",
  "{v1} 没有可撤销的内容。": "{v1} has nothing to undo.",
  "{v1} 天前": "{v1} days ago",
  "{v1} 条消息": "{v1} messages",
  "{v1} 项待发送": "{v1} pending",
  "{v1} 项已发送": "{v1} sent",
  "{v1} 小时前": "{v1} hours ago",
  "{v1}:{v2} 后过期": "expires in {v1}:{v2}",
  "{v1}（留空保持不变）": "{v1} (leave empty to keep)",
  "{v1}{v2}": "{v1}{v2}",
  "## 我\n{v1}": "## Me\n{v1}",
  "> {v1} {v2}\n{v3}": "> {v1} {v2}\n{v3}",
  "> 调用 {v1} {v2}": "> Call {v1} {v2}",
  "安装更新失败：{v1}": "Install failed: {v1}",
  "把工作区画像 v{v1} 提升为全局候选？\n\nPilot 会把项目专属规则泛化成跨项目规则，生成一份全局草稿；它仍需独立评审和你的手动启用。":
    "Promote workspace profile v{v1} to a global candidate?\n\nPilot generalizes project-specific rules into cross-project rules and creates a global draft; it still needs an independent review and your manual enable.",
  "版本 v{v1} 已启用。": "Version v{v1} enabled.",
  "撤销后 {v1} 会被移到回退点的回收目录，而不是直接删除。继续？":
    "Undoing moves {v1} to the checkpoint recycle folder instead of deleting it. Continue?",
  "单次输出上限需要在 512 到 {v1} 之间。":
    "Max output tokens must be between 512 and {v1}.",
  "发现新版本 v{v1}，点击查看": "New version v{v1}; click to view",
  "发现新版本 v{v1}，点击左下角版本号查看。":
    "New version v{v1}; click the version in the bottom left.",
  "复盘完成，新增 {v1} 条项目记忆。": "Review complete; {v1} new project memories.",
  "复现 {v1} 次": "Seen {v1}×",
  "复制失败：{v1}": "Copy failed: {v1}",
  "检查更新失败：{v1}": "Update check failed: {v1}",
  "简体中文": "Simplified Chinese",
  "解除 {v1} 的配对": "Unpair {v1}",
  "进度停在：{v1}{v2}": "Stopped at: {v1}{v2}",
  "每 {v1} 分钟": "Every {v1} minutes",
  "每天 {v1}": "Daily at {v1}",
  "命中 {v1} 条 · 来自 {v2} 个会话": "{v1} hits · from {v2} sessions",
  "评审通过（{v1} 分），版本 v{v2} 已自动启用。":
    "Review passed ({v1} points); version v{v2} auto-enabled.",
  "评审通过（非独立评审）": "Review passed (not independent)",
  "评审未通过": "Review failed",
  "外部模型": "External model",
  "本机同款模型": "Same local model",
  "它的理由": "Its reasoning",
  "这是第一个版本，没有旧版本可以对比。":
    "This is the first version, so there is nothing to compare it against.",
  "跑过几次": "Runs finished",
  "完成比例": "Completed",
  "撞步数上限": "Hit step cap",
  "每次命令报错": "Tool errors per run",
  "收尾前做过验证": "Verified before finishing",
  "你的评价（好评 / 差评）": "Your ratings (up / down)",
  "实测对比：现在用的 v{v1} 和这一版 v{v2}":
    "Measured comparison: v{v1} in use now vs v{v2}",
  "看什么": "What we measure",
  "v{v1}（现在）": "v{v1} (now)",
  "v{v1}（新版）": "v{v1} (new)",
  "新版还没真正跑过，所以现在无法比较强弱。启用后它会自动记录上面的数字，两个版本一放就能看出差别。":
    "The new version has not run yet, so there is nothing to compare. Once it runs, the numbers above fill in and the two versions can be set side by side.",
  "两边的跑次都还不到 {v1} 次，数字波动大，先别据此下结论。":
    "Neither side has reached {v1} finished runs, so the numbers are still noisy — don't read a winner into them yet.",
  "两版在这些指标上差别不明显，看不出谁更强。":
    "No clear difference on these measures, so neither version looks stronger.",
  "这次评审只有运行模型自己参与，属于自评。到 设置 → 模型资源 → 评估模型 里选择一个别的厂商的模型，再重新评审，就是三方独立评审。":
    "Only the model that made this change reviewed it, so this is self-review. Select a model from another vendor under Settings → Model resources → Evaluation models and review again to get an independent third-party review.",
  "未通过": "Failed",
  "尚未评审。启用前必须先通过评审（配好评审模型才是独立评审）；即使通过，也需要你手动启用。":
    "Not reviewed yet. It must pass a review before it can be enabled (only with reviewer models configured is that independent); even then you enable it manually.",
  "尚未评审。启用前必须先通过评审（配好评审模型才是独立评审），分数 ≥ 75 才会自动启用。":
    "Not reviewed yet. It must pass a review (independent only when reviewer models are configured) with a score of at least 75 before it auto-enables.",
  "查询余额": "Check balance",
  "查询中…": "Checking…",
  "余额：{v1}": "Balance: {v1}",
  "名称": "Name",
  "只在本机显示": "Shown only on this machine",
  "例如 通义千问": "for example Qwen",
  "OpenAI 兼容接口地址": "OpenAI-compatible endpoint",
  "仅保存在本机并加密": "Stored on this machine, encrypted",
  "评审未通过（{v1} 分）。\n\n{v2}": "Review failed ({v1} points).\n\n{v2}",
  "全局画像 v{v1} 已启用。": "Global profile v{v1} enabled.",
  "全局评审通过（{v1} 分）。\n\n全局规则影响所有工作区，不会自动启用；请确认后手动启用 v{v2}。":
    "Global review passed ({v1} points).\n\nGlobal rules affect every workspace and do not auto-enable; confirm to manually enable v{v2}.",
  "全局评审未通过（{v1} 分）。\n\n{v2}": "Global review failed ({v1} points).\n\n{v2}",
  "确定要回退到「{v1}」吗？\n\n{v2}。这不会撤销已经在工作区外发生的外部副作用。":
    "Roll back to “{v1}”?\n\n{v2}. This does not undo external side effects outside the workspace.",
  "沙箱可用：{v1}": "Sandbox available: {v1}",
  "删除定时任务「{v1}」？": "Delete scheduled task “{v1}”?",
  "删除候选版本 v{v1}？": "Delete candidate version v{v1}?",
  "删除会话「{v1}」": "Delete session “{v1}”",
  "删除会话「{v1}」？\n\n聊天记录会从本机删除，项目记忆和进化版本不受影响。":
    "Delete session “{v1}”?\n\nThe chat is removed from this machine; project memory and evolution versions stay.",
  "删除全局候选版本 v{v1}？": "Delete global candidate v{v1}?",
  "按对话内容估算的上下文用量 · {v1} 条消息":
    "Context estimated from this conversation · {v1} messages",
  "上下文 ≈ {v1} tokens": "Context ≈ {v1} tokens",
  "上下文已压缩：整理 {v1} 条旧工具输出，移除 {v2} 条早期消息（约 {v3} tokens）。":
    "Context compacted: {v1} old tool outputs reorganized, {v2} early messages removed (~{v3} tokens).",
  "上下文预算需要在 8,000 到 {v1} 之间。":
    "Context budget must be between 8,000 and {v1}.",
  "剩余 {v1}": "{v1} left",
  "搜索{v1}": "Search {v1}",
  "为 v{v1} 生成中文版本？\n\nPilot 会生成一份新的中文草稿，不会修改或停用当前版本；草稿仍需独立评审后才能启用。命令、路径、工具名和代码标识会保持原样。":
    "Generate a Chinese version of v{v1}?\n\nPilot creates a new Chinese draft without changing or disabling the current version; the draft still needs an independent review. Commands, paths, tool names and code identifiers stay as-is.",
  "温度 {v1}": "Temperature {v1}",
  "下次 {v1}": "Next {v1}",
  "下载更新失败：{v1}": "Download failed: {v1}",
  "移除 {v1} 的授权": "Remove authorization for {v1}",
  "移除工作区「{v1}」？\n\n会话、项目记忆和自我进化版本将一并从此设备删除，不会删除磁盘上的文件夹。":
    "Remove workspace “{v1}”?\n\nSessions, project memory and evolution versions are deleted from this device; the folder on disk is kept.",
  "已撤销 {v1}：{v2}。": "Undid {v1}: {v2}.",
  "已发送 {v1} 项，{v2} 项失败。": "Sent {v1}; {v2} failed.",
  "已发送 {v1} 项待办。": "Sent {v1} todos.",
  "已回滚到版本 v{v1}。": "Rolled back to version v{v1}.",
  "已回滚到全局画像 v{v1}。": "Rolled back to global profile v{v1}.",
  "已生成候选版本 v{v1}，请进行独立评审。":
    "Candidate version v{v1} generated; please review it.",
  "已生成全局候选 v{v1}，请独立评审后手动启用。":
    "Global candidate v{v1} generated; review it, then enable manually.",
  "已生成全局候选 v{v1}。请先做独立评审，再手动启用。":
    "Global candidate v{v1} generated. Review it first, then enable manually.",
  "已生成中文版本 v{v1}，请评审后再启用。":
    "Chinese version v{v1} generated; review it before enabling.",
  "已生成中文版本 v{v1}（草稿）。它不会自动启用。":
    "Chinese version v{v1} generated (draft). It will not auto-enable.",
  "已选择 {v1} 个项目": "{v1} projects selected",
  "已运行 {v1}": "Running for {v1}",
  "已运行 {v1} · 仍在执行": "Running for {v1} · still working",
  "任务执行中，仍在工作": "Task running, still working",
  "第 {v1} 步": "Step {v1}",
  "已验证交付": "Verified",
  "以风险自担方式启用 v{v1}？\n\n独立评审未通过或尚未通过时，强制启用可能让后续运行退化。你随时可以回滚。":
    "Enable v{v1} at your own risk?\n\nWith a failed or missing independent review, forcing it on may degrade later runs. You can roll back anytime.",
  "以风险自担方式启用全局画像 v{v1}？\n\n它会应用到所有工作区；评审未通过时可能让多个项目一起退化。你随时可以回滚。":
    "Enable global profile v{v1} at your own risk?\n\nIt applies to every workspace; a failed review may degrade several projects at once. You can roll back anytime.",
  "用会话最早的快照覆盖 {v1}？当前内容会被替换。":
    "Overwrite {v1} with the session's earliest snapshot? The current content is replaced.",
  "在「{v1}」新建任务": "New task in “{v1}”",
  "这些内容会在每次运行「{v1}」时注入系统提示，帮助 Pilot 记住你的偏好和踩过的坑。":
    "This is injected into the system prompt on every run in “{v1}” so Pilot remembers your preferences and past pitfalls.",
  "正在后台下载更新 {v1}%，不影响当前会话":
    "Downloading update in the background: {v1}% (does not interrupt this session)",
  "正在执行第 {v1} 步": "Running step {v1}",
  "只读探索：{v1}": "Read-only exploration: {v1}",
  "最多 {v1} 步": "Up to {v1} steps",
  "最后活动 {v1}": "Last active {v1}",
  "最近 {v1} 条提交": "Last {v1} commits",
  "常用指令": "Quick commands",
  "管理常用指令": "Manage quick commands",
  "这些指令显示在空会话的欢迎页，点一下就会把它们作为任务发给 Pilot。":
    "These commands appear on the empty-chat welcome screen; clicking one sends it to Pilot as a task.",
  "还没有常用指令。添加几条常用的任务，点一下就能开始。":
    "No quick commands yet. Add a few common tasks and start one with a click.",
  "还没有常用指令。添加一条，或恢复推荐指令。":
    "No quick commands yet. Add one, or restore the recommended set.",
  "例如：运行测试并修复所有失败项": "e.g. run the tests and fix every failure",
  "删除这条指令": "Delete this command",
  "添加一条": "Add one",
  "恢复推荐": "Restore recommended",
  "保存中…": "Saving…",
  "正在读取…": "Loading…",
  "{v1}/{v2}": "{v1}/{v2}",
  "源码级进化（实验室）": "Source-level evolution (lab)",
  "Pilot 可以在自己的源码工作区里修改代码、运行测试并构建实验版。实验版独立运行，不影响当前安装；工作区快照和旧构建目录都可以回退。":
    "Pilot can edit its own source workspace, run tests and build an experimental version. The experimental build runs independently and never touches the current install; workspace snapshots and older build folders remain available for rollback.",
  "需要 Node 22.12+ 与 pnpm": "Requires Node 22.12+ and pnpm",
  "打开自身源码工作区": "Open Pilot's source workspace",
  "修改源码": "Edit the source",
  "按 SELF.md 的说明修改代码，先给出计划。":
    "Follow SELF.md, and present a plan before changing code.",
  "测试与构建": "Test and build",
  "运行 node scripts/self-build.mjs；测试或构建失败就停下。":
    "Run node scripts/self-build.mjs; stop if tests or the build fail.",
  "运行实验版": "Run the experimental build",
  "实验版在独立目录运行；建议先退出当前版本，避免两个实例同时写本地数据。":
    "The experimental build runs from its own folder; quit the current version first so two instances do not write local data at the same time.",
  "回退": "Roll back",
  "旧实验版目录保留，随时切回。": "Older experimental folders are kept, so switching back is one launch.",
  "已准备好自身源码工作区，可以开始修改 Pilot。":
    "Pilot's source workspace is ready. You can start editing Pilot.",
  "已打开自身源码工作区。": "Pilot's source workspace is open.",
  "进化机制已更新到 v{v1}。": "The evolution mechanism was updated to v{v1}.",
  "当前进化机制无需调整。": "The evolution mechanism needs no adjustment.",
  "已回滚到进化机制 v{v1}。": "Rolled back the evolution mechanism to v{v1}.",
  "没有可回滚的进化机制版本。": "No earlier evolution-mechanism version to roll back to.",
  "已开启系统级自动进化。": "System-level auto-evolution is on.",
  "已关闭系统级自动进化。": "System-level auto-evolution is off.",
  "收集证据": "Gather evidence",
  "提出改进": "Propose changes",
  "应用或保留": "Apply or keep",
  "回归观察": "Regression watch",
  "本轮完成": "Cycle complete",
  "本轮未采用": "Cycle not applied",
  "本轮失败": "Cycle failed",
  "手动触发": "Manual",
  "自动触发": "Automatic",
  "流程自进化": "Flow self-evolution",
  "回归保护": "Regression guard",
  "评审 {v1} 分": "Review {v1} / 100",
  "让 Pilot 调整自己的进化流程？\n\n它会根据历史轮次提出新的节奏与阈值，交给独立模型评审，通过后自动启用。所有数值都有硬上限，你随时可以回滚。":
    "Let Pilot adjust its own evolution flow?\n\nIt proposes new cadence and thresholds from past cycles, submits them to an independent model review, and enables them on a pass. Every value has a hard bound, and you can roll back at any time.",
  "回滚到上一个进化机制版本？当前版本的节奏和阈值会退役，但不会被删除。":
    "Roll back to the previous evolution-mechanism version? The current cadence and thresholds retire, but are not deleted.",
  "系统级自动进化": "System-level auto-evolution",
  "不需要写代码。Pilot 自动收集近期任务、提出改进、交给独立模型评审；通过后自动启用，失败率明显上升时自动回滚。":
    "No coding required. Pilot gathers recent runs, proposes improvements and submits them to an independent model review; passing changes are enabled automatically, and a clear failure-rate regression rolls them back.",
  "自动运行已开启": "Auto-run on",
  "自动运行已关闭": "Auto-run off",
  "至少需要 {v1} 次运行记录": "At least {v1} completed runs are required",
  "立即运行一轮系统进化": "Run one system-evolution cycle now",
  "进化中…": "Evolving…",
  "立即进化": "Evolve now",
  "还没有运行过系统进化": "No system-evolution cycle has run yet",
  "完成至少 {v1} 次任务后，可以点“立即进化”，或开启自动运行让 Pilot 自己开始。":
    "After at least {v1} tasks, click “Evolve now”, or turn on auto-run and let Pilot start on its own.",
  "内置默认": "Built-in default",
  "进化机制": "Evolution mechanism",
  "每 {v1} 次运行 · 评审 ≥ {v2} 分 · 观察 {v3} 次":
    "Every {v1} runs · review ≥ {v2} · watch {v3} runs",
  "评审通过后自动启用": "Enable automatically after a passing review",
  "评审通过后手动启用": "Enable manually after a passing review",
  "证据窗口 {v1} 次": "Evidence window: {v1} runs",
  "失败率上升 {v1} 个百分点即回滚":
    "Roll back when the failure rate rises by {v1} points",
  "每 {v1} 轮自检一次流程": "Review the flow every {v1} cycles",
  "当前进化重点：{v1}": "Current evolution focus: {v1}",
  "流程评审": "Flow review",
  "查看本次流程调整理由": "View the rationale for this flow change",
  "让 Pilot 根据历史轮次调整自己的阈值与节奏":
    "Let Pilot tune its own thresholds and cadence from past cycles",
  "需要先打开工作区": "Open a workspace first",
  "调整中…": "Adjusting…",
  "改进进化机制": "Improve the evolution mechanism",
  "回滚进化机制": "Roll back the evolution mechanism",
  "阈值和节奏可以被进化，但独立评审、证据要求和回滚不会被关闭。":
    "Thresholds and cadence can evolve, but independent review, evidence requirements and rollback cannot be disabled.",
  "新增 {v1} · 修改 {v2} · 删除 {v3}":
    "{v1} added · {v2} modified · {v3} deleted",
  "已提交": "Submitted",
  "上传失败": "Upload failed",
  "上传文件到工作区，作为参照发送；也可以直接拖进来或粘贴":
    "Upload files into the workspace and send them as references, or just drag and paste them in",
  "当前会话没有工作区，无法上传文件":
    "This conversation has no workspace, so files cannot be uploaded.",
  "待发送": "Ready to send",
  "给这个个人版本起个名字": "Name this personal version",
  "我的版本 {v1}": "My version {v1}",
  "说明你希望这个版本改进什么（可留空）":
    "Describe what you wanted this version to improve (optional)",
  "已保存版本“{v1}”，共 {v2} 个文件改动；已关联最新实验版。":
    "Saved “{v1}” with {v2} changed files; linked to the newest experimental build.",
  "已保存版本“{v1}”，共 {v2} 个文件改动。让 Pilot 构建个人版后会关联新的实验版。":
    "Saved “{v1}” with {v2} changed files. Once Pilot builds the personal version, the new experimental build is linked.",
  "把源码恢复到这个版本？\n\n只回写该版本记录的 {v1} 个文件；之后新增的其他改动会保留。":
    "Restore the source to this version?\n\nOnly the {v1} files recorded in this version are written back; newer unrelated edits are kept.",
  "已恢复到“{v1}”。": "Restored “{v1}”.",
  "向官方说明这个改动的价值（会附在贡献包里）":
    "Explain to the maintainers why this change matters (attached to the contribution)",
  "把这个版本的源码改动、提交说明和进化摘要上传到官方？\n\n不会上传工作区文件、会话或 API Key。上传后仍由维护者决定是否采纳。":
    "Upload this version's source changes, submission note and evolution summary to the official project?\n\nWorkspace files, conversations and API keys are not uploaded. Maintainers still decide whether to accept it.",
  "已提交官方。贡献包编号：{v1}":
    "Submitted to the official project. Contribution ID: {v1}",
  "上传失败：{v1}\n\n贡献包已保存在：{v2}\n可以打开所在位置后手动发送。":
    "Upload failed: {v1}\n\nThe contribution is saved at: {v2}\nOpen its location and send it manually.",
  "未知错误": "Unknown error",
  "贡献包已生成：{v1}\n\n当前没有配置官方上传通道，可以打开所在位置后通过官方渠道发送。":
    "Contribution created: {v1}\n\nNo official upload channel is configured. Open its location and send it through the official channel.",
  "个人版本与官方贡献": "Personal versions and official contributions",
  "不会写代码也能拥有自己的 Pilot：用聊天告诉它你想改进什么，它会修改自身源码、跑测试并构建个人版。满意后保存版本；特别有价值的改动可以打包提交官方，采纳后会合并进正式发行版。":
    "You do not need to write code to own your Pilot: tell it in chat what to improve, and it edits its own source, runs tests and builds a personal version. Save versions you like; especially valuable changes can be packaged and submitted officially, then merged into a future release if accepted.",
  "把当前源码改动保存为一个可回退的个人版本":
    "Save the current source changes as a restorable personal version",
  "请先打开自身源码工作区": "Open Pilot's source workspace first",
  "保存当前版本": "Save current version",
  "正在读取个人版本…": "Loading personal versions…",
  "还没有个人源码工作区": "No personal source workspace yet",
  "先打开自身源码工作区。之后你在聊天里提出的改进，Pilot 会直接写进这份个人源码。":
    "Open Pilot's source workspace first. Improvements you request in chat are then written directly into this personal copy.",
  "个人分支 {v1}": "Personal fork {v1}",
  "官方基线 v{v1}": "Official baseline v{v1}",
  "闭环": "Closed loop",
  "未闭环": "Loop open",
  "已闭环": "Closed loop",
  "基线提交 {v1}": "Baseline commit {v1}",
  "基线未绑定提交": "baseline not pinned to a commit",
  "源码来源与进化闭环": "Source provenance and the evolution loop",
  "只读：这些设置只决定进化闭环拿哪份源码当官方基线，不会改动任何源码文件。":
    "Read-only: these settings only decide which source counts as the official baseline. No source file is modified.",
  "正在读取源码来源…": "Reading source provenance…",
  "内置源码（官方 git）": "Built-in source (official git)",
  "自定义源码目录": "Custom source directory",
  "安装版默认留空：不填时基线就是安装包内的源码快照；填仓库根地址后，内置源码会与这个仓库的提交比较。":
    "Leave it empty in an installed build: the baseline is then the source snapshot inside the installer. Once filled, the built-in source is compared against commits from that repository.",
  "官方仓库": "Official repositories",
  "Pilot 桌面端": "Pilot desktop",
  "主仓库：桌面端、中继与官网都在这里": "Main repository: desktop app, relay and website live here",
  "移动控制端": "Mobile controller",
  "手机控制电脑的 uni-app 端": "uni-app client that drives the computer from a phone",
  "手机被控端": "Mobile target",
  "电脑控制手机的反控端": "reverse-control client that lets the computer drive the phone",
  "中继器": "Relay",
  "自建中继，用来跨网络连接": "Self-hosted relay for connections across networks",
  "在浏览器打开 {v1}": "Open {v1} in the browser",
  "用作官方 git": "Use as official git",
  "已填入地址，点「保存并检查」后生效。":
    "Address filled in; it takes effect after Save and check.",
  "官方 git 地址": "Official git URL",
  "分支或标签": "Branch or tag",
  "仓库内路径": "Path inside the repository",
  "填源码在仓库里的相对目录，例如 pilot/pilot；留空表示仓库根就是客户端源码。":
    "Relative directory of this client inside the repository, for example pilot/pilot. Empty means the repository root is the client source.",
  "源码目录": "Source directory",
  "选择你自己的源码仓库（需含 .git）；个人版本会以该分支当前提交为基线。":
    "Pick your own checkout (it must contain .git); personal versions use that branch's current commit as the baseline.",
  "保存并检查": "Save and check",
  "重建基线": "Rebuild baseline",
  "同步官方基线": "Sync official baseline",
  "本机没有可用的 git": "git is not available on this machine",
  "基线类型": "Baseline kind",
  "基线提交": "Baseline commit",
  "提交时间": "Committed",
  "落后官方": "Behind official",
  "落后 {v1} 个提交": "{v1} commits behind",
  "上次核对": "Last checked",
  "提交说明": "Commit message",
  "官方基线": "Official baseline",
  "官方 git 提交": "official git commit",
  "自定义仓库提交": "custom repository commit",
  "安装包内置快照": "snapshot bundled with the installer",
  "git HEAD": "git HEAD",
  "未建立": "not established",
  "读取源码来源失败": "Could not read source provenance",
  "已保存，基线已按新设置重新解析。": "Saved; the baseline was re-resolved from the new settings.",
  "基线已按当前分支提交重建。": "Baseline rebuilt from the current branch commit.",
  "同步完成，基线已指向最新官方提交。": "Sync finished; the baseline now points at the newest official commit.",
  "官方上传通道已配置": "Official upload channel configured",
  "仅生成贡献包": "Contribution export only",
  "还没有保存过个人版本": "No personal versions saved yet",
  "先在聊天里让 Pilot 改进自己，然后回来点“保存当前版本”。版本会记录改了哪些文件，之后可以恢复。":
    "First ask Pilot in chat to improve itself, then come back and click “Save current version”. The version records which files changed and can be restored later.",
  "已构建": "Built",
  "待构建": "Not built yet",
  "实验版：{v1}": "Experimental build: {v1}",
  "恢复此版本": "Restore this version",
  "提交官方": "Submit officially",
  "提交前会检查密钥和危险路径；贡献包只包含这个版本记录的改动。":
    "Secrets and unsafe paths are checked before submission; the contribution only contains changes recorded in this version.",
  "另有 {v1} 个较早版本已保留在本地。":
    "{v1} older versions are also kept locally.",
  "贡献包": "Contributions",
  "打开位置": "Show location",
  "和 Pilot 聊源码改造": "Chat with Pilot about source changes",
  "打开内置源码并新建对话，用聊天告诉 Pilot 你想怎么改造自己":
    "Open the built-in source in a new chat and tell Pilot how you want to customize it",
  "我想改造自己的 Pilot。请先读 SELF.md，了解源码结构和构建方式，然后用简短的话说明可以定制哪些地方，并问我最想改什么。先不要改代码，等我确认。":
    "I want to customize my own Pilot. Read SELF.md first to understand the source layout and build process, then briefly explain what can be customized and ask what I want to change most. Do not modify code yet; wait for my confirmation.",
  "已准备好自身源码工作区，可以开始告诉 Pilot 你想改什么。":
    "Pilot's source workspace is ready. Tell Pilot what you want to change.",
  "已打开自身源码工作区，可以开始告诉 Pilot 你想改什么。":
    "Pilot's source workspace is open. Tell Pilot what you want to change.",
  "让 Pilot 构建": "Let Pilot build",
  "切换到聊天，让 Pilot 按 SELF.md 运行测试并构建个人版":
    "Switch to chat and ask Pilot to run tests and build your personal version following SELF.md",
  "请按 SELF.md 的流程构建我的个人版：先检查当前改动，特别确认官方更新和我的改动在跨文件调用上是否一致（例如某个方法、类型或参数被改后，所有调用方是否同步），然后运行 pnpm typecheck、pnpm test 和 node scripts/self-build.mjs；失败就修到通过，最后告诉我实验版目录和改了什么。":
    "Build my personal version following the process in SELF.md: review the current changes, and in particular check that official updates and my edits agree across files (for example, when a method, type or parameter changes, every caller must be updated), then run pnpm typecheck, pnpm test and node scripts/self-build.mjs; fix any failures until they pass, then tell me the experimental build directory and what changed.",
  "官方已升级到 v{v1}": "Official version upgraded to v{v1}",
  "你的个人版本基于 v{v1}，但升级前的官方基线没有保存。可以让 Pilot 对照新版官方源码手动迁移，个人改动不会丢失。":
    "Your personal version is based on v{v1}, but the pre-upgrade official baseline was not saved. Pilot can migrate your changes by comparing them with the new official source; nothing you changed is lost.",
  "你的个人版本基于 v{v1}。合并后会同时包含官方更新和你自己的改动；冲突会标出来交给 Pilot 处理。":
    "Your personal version is based on v{v1}. Merging keeps both the official updates and your own changes; conflicts are marked for Pilot to resolve.",
  "合并中…": "Merging…",
  "让 Pilot 迁移": "Let Pilot migrate",
  "合并官方更新": "Merge official update",
  "官方已经升级到 v{v1}，但找不到升级前保存的官方基线，无法自动合并。\n\n新版官方源码会复制到 .pilot-upgrade/official，然后让 Pilot 对照迁移，并保留你的改动。继续？":
    "The official version is now v{v1}, but the saved pre-upgrade baseline is missing, so an automatic merge is not possible.\n\nThe new official source will be copied to .pilot-upgrade/official, then Pilot will migrate your changes by comparing them. Continue?",
  "把官方 v{v1} 合并进你的个人源码：\n\n官方更新 {v2} 个文件，保留你的改动 {v3} 个，自动合并 {v4} 个，冲突 {v5} 个。\n\n合并前会自动备份当前个人源码。继续？":
    "Merge official v{v1} into your personal source:\n\n{v2} files updated officially, {v3} of your changes kept, {v4} merged automatically, {v5} conflicts.\n\nYour current personal source is backed up before merging. Continue?",
  "已合并官方 v{v1}：写入 {v2} 个文件，自动合并 {v3} 个，冲突 {v4} 个。\n\n合并前的个人源码备份在：{v5}":
    "Merged official v{v1}: {v2} files written, {v3} merged automatically, {v4} conflicts.\n\nThe pre-merge personal source backup is at: {v5}",
  "有 {v1} 个文件还留着冲突标记。现在让 Pilot 合并它们？":
    "{v1} files still contain conflict markers. Let Pilot resolve them now?",
  "官方已经升级到 v{v1}，但找不到升级前的官方基线，无法自动合并。新版官方源码已复制到 {v2}，我当前的个人源码在工作区根目录。请逐文件对比，把官方更新迁移进来，同时保留我的改动，并检查跨文件调用是否同步（例如方法、类型或参数变了，所有调用方都要一起改）。完成后运行 pnpm typecheck 和 pnpm test，全部通过后运行 node scripts/self-build.mjs 构建个人版。":
    "The official version is now v{v1}, but the pre-upgrade baseline is missing, so an automatic merge is not possible. The new official source has been copied to {v2}; my current personal source is at the workspace root. Compare the files, migrate the official updates in while keeping my changes, and check that calls agree across files (for example, when a method, type or parameter changes, every caller must be updated). Then run pnpm typecheck and pnpm test. Once everything passes, run node scripts/self-build.mjs to build my personal version.",
  "官方已经合并到 v{v1}，以下文件还留着冲突标记（<<<<<<< 我的版本 / >>>>>>> 官方 v{v1}）：\n{v2}\n\n请逐个解决冲突，既保留我的意图也吸收官方更新，并检查跨文件调用是否同步（例如方法、类型或参数变了，所有调用方都要一起改）。然后运行 pnpm typecheck 和 pnpm test，全部通过后运行 node scripts/self-build.mjs 构建个人版，并告诉我改了什么。":
    "Official v{v1} has been merged, but these files still contain conflict markers (<<<<<<< 我的版本 / >>>>>>> 官方 v{v1}):\n{v2}\n\nResolve each conflict, keeping my intent while taking the official updates, and check that calls agree across files (for example, when a method, type or parameter changes, every caller must be updated). Then run pnpm typecheck and pnpm test. Once everything passes, run node scripts/self-build.mjs to build my personal version and tell me what changed.",
  "我把官方 v{v1} 合并进了个人源码，但检查没有通过：\n\n{v2}\n\n请定位并修复。重点检查跨文件调用是否一致：官方可能改了方法、类型或参数，而我的改动仍按旧接口调用。修好后运行 pnpm typecheck、pnpm test 和 node scripts/self-build.mjs，最后说明改了什么。":
    "I merged official v{v1} into my personal source, but the checks did not pass:\n\n{v2}\n\nFind and fix the problem. Pay special attention to cross-file calls: the official update may have changed a method, type or parameter while my edits still call the old interface. Afterwards run pnpm typecheck, pnpm test and node scripts/self-build.mjs, and explain what changed.",
  "检查通过：typecheck 和测试都通过了。":
    "Checks passed: typecheck and tests both succeeded.",
  "检查未完成：{v1}\n\n{v2}": "Checks did not complete: {v1}\n\n{v2}",
  "让 Pilot 检查并修复合并结果？它会在聊天里读取 typecheck/测试输出，处理跨文件调用不一致，然后重新构建个人版。":
    "Let Pilot inspect and repair the merge? It will read the typecheck/test output in chat, fix cross-file call mismatches, then rebuild your personal version.",
  "撤销上次合并？\n\n会恢复合并前自动备份的文件；合并后你对这些文件的修改会丢失。源码回到旧基线，官方更新仍可再次合并。":
    "Roll back the last merge?\n\nFiles backed up before the merge are restored; edits you made to those files after merging are lost. The source returns to the old baseline and the official update can be merged again.",
  "已撤销合并，个人源码已恢复到合并前。":
    "Merge rolled back; your personal source is back to its pre-merge state.",
  "官方更新已合并，typecheck 和测试都通过。现在让 Pilot 重新构建个人版？":
    "The official update was merged and typecheck and tests passed. Let Pilot rebuild your personal version now?",
  "官方更新已合并，但检查没有通过，可能存在跨文件调用不一致。现在让 Pilot 修复？":
    "The official update was merged, but checks failed, which may indicate cross-file call mismatches. Let Pilot repair it now?",
  "官方更新已合并。{v1}\n\n接下来让 Pilot 安装依赖、运行测试并构建个人版。":
    "The official update was merged. {v1}\n\nNext, let Pilot install dependencies, run tests and build your personal version.",
  "现在让 Pilot 构建并验证个人版？":
    "Let Pilot build and verify your personal version now?",
  "合并结果未通过检查": "Merge result failed checks",
  "合并结果尚未验证（缺少依赖）": "Merge result not verified (dependencies missing)",
  "合并结果尚未验证": "Merge result not verified",
  "文本合并无法发现跨文件逻辑冲突，请运行检查或让 Pilot 审阅。":
    "A textual merge cannot detect cross-file logic conflicts. Run the checks or let Pilot review it.",
  "查看检查输出": "Show check output",
  "运行检查": "Run checks",
  "让 Pilot 修复": "Let Pilot repair",
  "撤销合并": "Roll back merge",
  "这个版本还没有构建和测试过。跨文件逻辑可能在合并或改动后不一致，确认现在提交？":
    "This version has not been built or tested. Cross-file logic may be inconsistent after a merge or edit. Submit anyway?",
  "工具": "Tools",
  "测试目标最多 20 个。": "You can list at most 20 test targets.",
  "测试目标必须是 http:// 或 https:// 地址，且不能包含用户名或密码：{v1}":
    "A test target must be an http:// or https:// URL without a username or password: {v1}",
  "测试环境与动态工具": "Test environment and generated tools",
  "Pilot 可以为自己编写工具，但只能访问 localhost 或下面登记的测试目标。测试验证码只用于你自己的测试环境：值保存在系统安全存储中，运行时通过环境变量注入，不写进代码或日志。Pilot 不会训练或绕过未授权的验证码。":
    "Pilot can write tools for itself, but they may only reach localhost or the test targets listed below. The test captcha is only for your own test environment: it is kept in the OS secure store and injected as an environment variable at run time, never written into code or logs. Pilot does not train on or bypass unauthorized captchas.",
  "授权测试目标": "Authorized test targets",
  "每行一个 http/https 地址，最多 20 个；localhost 始终允许":
    "One http/https URL per line, up to 20; localhost is always allowed",
  "测试验证码方式": "Test captcha mode",
  "fixture 注入固定测试码；header 额外给出建议的请求头名":
    "fixture injects a fixed test code; header also provides a suggested header name",
  "固定测试码（fixture）": "Fixed test code (fixture)",
  "测试请求头（header）": "Test header (header)",
  "测试验证码固定值": "Test captcha value",
  "已保存；留空保持原值": "Saved; leave blank to keep it",
  "只填写测试环境接受的固定值": "Only enter a fixed value your test environment accepts",
  "已停用": "Disabled",
  "需要重新登记": "Needs re-registration",
  "已批准": "Approved",
  "删除工具「{v1}」及其代码？这个操作不可撤销。":
    "Delete tool \"{v1}\" and its code? This cannot be undone.",
  "把「{v1}」复制到全局工具目录？之后每个工作区都能使用它。":
    "Copy \"{v1}\" into the global tool directory? Every workspace will be able to use it.",
  "能力扩展": "Capability extensions",
  "这些工具由 Pilot 在「{v1}」中自己编写：代码放在 .pilot/tools/<name>/，登记时必须先跑通自带测试。修改任何文件都会撤销批准，需要重新登记。":
    "Pilot writes these tools for \"{v1}\": the code lives in .pilot/tools/<name>/, and registration runs the bundled self-test first. Editing any file revokes approval until it is registered again.",
  "选择一个工作区后，可以查看 Pilot 为它编写和登记的工具。":
    "Select a workspace to see the tools Pilot wrote and registered for it.",
  "可用": "available",
  "工具按工作区隔离；全局工具需要从某个工作区提升后才能使用。":
    "Tools are scoped per workspace; global tools must be promoted from a workspace before other workspaces can use them.",
  "载入工具…": "Loading tools…",
  "还没有工具": "No tools yet",
  "当一个能力需要反复使用、而内置工具覆盖不了时，Pilot 会在 .pilot/tools/<name>/ 写一个工具，先自测再由你批准。":
    "When a capability is used repeatedly and built-in tools cannot cover it, Pilot writes one under .pilot/tools/<name>/, tests it, and waits for your approval.",
  "自测通过": "Self-test passed",
  "提升为全局": "Promote to global",
  "停用": "Disable",
  "成功 {v1} · 失败 {v2}": "Succeeded {v1} · failed {v2}",
  "上次运行 {v1}": "Last run {v1}",
  "尚未运行": "Never run",
  "超时 {v1}s": "Timeout {v1}s",
  "测试目标": "Test targets",
  "代码在登记后发生了变化或自测未通过。Pilot 不能运行它，需重新调用 register_tool 登记。":
    "The code changed after registration or its self-test did not pass. Pilot cannot run it until register_tool succeeds again.",
  "边界：工具只能访问 localhost 或「设置 → 测试目标」中登记的地址；运行时不会获得 API Key 等凭据。它们仍是可执行代码，请在批准前确认代码来源和用途。":
    "Boundary: tools may only reach localhost or addresses listed in Settings → test targets; they never receive the API key or other credentials. They are still executable code, so confirm their origin and purpose before approving.",
  "未配置 API Key，无法读取余额。": "No API key is configured, so the balance cannot be read.",
  "服务商拒绝了该 Key（401），余额无法读取。":
    "The provider rejected this key (401), so the balance cannot be read.",
  "该服务商或端点不支持余额查询。":
    "This provider or endpoint does not expose a balance API.",
  "网络错误：{v1}": "Network error: {v1}",
  "余额返回的格式无法识别。": "The balance response could not be parsed.",
  "余额查询失败：{v1}": "Balance request failed: {v1}",
  "余额与费用": "Balance & cost",
  "余额来自当前 API Key 所属账户；费用按本机记录的 token 用量估算，仅供参考。":
    "The balance belongs to the account behind the saved API key. Cost is estimated from the token usage Pilot recorded locally and is indicative only.",
  "可用余额": "Available balance",
  "赠送 {v1} · 充值 {v2}": "Granted {v1} · Topped up {v2}",
  "余额不足，服务商会拒绝新的请求。":
    "The balance is depleted; the provider will reject new requests.",
  "读取失败：{v1}": "Could not read it: {v1}",
  "尚未读取。": "Not read yet.",
  "更新于 {v1} · {v2}": "Updated {v1} · {v2}",
  "本机估算费用": "Estimated cost",
  "{v1} 次运行 · 输入 {v2} · 输出 {v3} tokens":
    "{v1} runs · {v2} input · {v3} output tokens",
  "其中缓存命中 {v1} tokens，按更低价计算。":
    "{v1} of those tokens hit the cache and are billed at the lower rate.",
  "{v1} 没有价格表，未计入估算。": "No price table for {v1}; excluded from the estimate.",
  "本机还没有运行记录。": "No runs recorded on this machine yet.",
  "未记录模型": "Model not recorded",
  "单价取自 DeepSeek 定价页（高峰价，非高峰按半价折算，更新于 {v1}）。当前模型":
    "Prices come from DeepSeek's pricing page (peak rate; off-peak is billed at half, table updated {v1}). Current model",
  "这个模型还没有收录单价，只统计 token 用量。当前模型":
    "No price is recorded for this model yet, so only token usage is tracked. Current model",
  "费用按 1 美元 ≈ {v1} 元折算成人民币显示。": "Shown in RMB at 1 USD ≈ {v1} CNY.",
  "配置 API Key 后才能读取余额。": "Add an API key to read the balance.",
  "已用日常说法说明 v{v1}。": "Explained v{v1} in plain language.",
  "技术细节（给想看原文的人）": "Technical details (for those who want the original)",
  "建议启用": "Recommend turning it on",
  "建议先别启用，继续观察": "Hold off turning it on for now",
  "这个版本没有改动任何规则，只是重新保存了一次，可以直接忽略。":
    "This version changed no rules, only how they were saved. You can ignore it.",
  "这次改了什么还没翻译成日常说法。点下面的按钮，Pilot 会用大白话说明：改了什么、你会感觉到什么变化、有什么风险、要不要启用。":
    "This change has not been described in plain language yet. Click the button below and Pilot will explain what changed, what you will notice, the risks, and whether to turn it on.",
  "正在解释…": "Explaining…",
  "用大白话解释这次改动": "Explain this change in plain language",
  "作用于这台电脑上的所有项目": "Applies to every project on this computer",
  "只作用于当前项目": "Applies to the current project only",
  "你会感觉到": "What you will notice",
  "风险 / 需要留意的": "Risks / things to watch",
  "为什么这么建议": "Why this recommendation",
  "由 {v1} 生成，可重新生成": "Generated by {v1}; can be regenerated",
  "自动生成的摘要": "Auto-generated summary",
  "正在重新解释…": "Re-explaining…",
  "重新解释": "Re-explain",
  "逐条对照：{v1} 处变化（{v2}）": "Line by line: {v1} changes ({v2})",
  "对比正在使用的 v{v}": "Compared with the active v{v}",
  "对比初始设置": "Compared with the initial settings",
  "设置变化": "Setting changes",
  "新增（{v1}）": "Added ({v1})",
  "改写（{v1}）": "Rewritten ({v1})",
  "删去（{v1}）": "Removed ({v1})",
  "保持不变（{v1}）": "Unchanged ({v1})",
  "这就是现在生效的规则": "These are the rules in effect right now",
  "检查认为这次改动还不该启用：{v1}。下面仍保留原本的说明，供你对照。":
    "The check says this change should not be enabled yet: {v1}. The original explanation is kept below for comparison.",
  "谁检查过": "Who checked it",
  "{v1} 个独立的模型各自看过一遍（{v2}），结论一致才会建议启用。":
    "{v1} separate model(s) looked at it independently ({v2}); enabling is only recommended when they agree.",
  "部分模型独立检查过（{v1}），但另一些与写这条规则的模型相同，结论可能相互影响。":
    "Some independent models checked it ({v1}), but others are the same model that wrote the rule, so the verdicts may not be independent.",
  "只有当前模型自己检查，没有第二个模型参与；在设置的评估模型里选择另一个模型后才会真正独立。":
    "Only the current model checked its own change; select another model under Evaluation models in Settings for a truly independent check.",
  "去配置评估模型": "Configure evaluation models",
  "没有通过": "Did not pass",
  "实测对比能力": "Measure both versions",
  "实测对比": "Measure",
  "还没有实测对比，先跑一次实测才能启用。": "Not measured yet — run the benchmark once before enabling.",
  "当前还不满足启用条件。": "This version does not meet the activation requirements yet.",
  "这个版本没有实测记录，先跑一次实测对比才能重新启用。": "This version has no benchmark record — measure it once before re-enabling.",
  "这个版本没有实测记录，启用前必须先和当前版本跑同一批基准任务。": "This version has no benchmark record — it must run the same benchmark tasks as the active version before it can be enabled.",
  "这组数据测的是另一个版本组合，当前生效版本已经变了；重新跑一次实测才有参考价值。":
    "These numbers describe a different pair of versions — the version in force has changed since. Measure again before trusting them.",
  "题库 v{v1}：最难的 {v2} 任务两侧全部通过，题库已经饱和——「无明显差异」只说明题不够难，不代表能力相同；下一版题库需要加难度。":
    "Task library v{v1}: every {v2} task passed on both sides, so the library is saturated. “No clear difference” only means the tasks are not hard enough — it does not mean the two versions are equally capable. The next revision has to raise the difficulty.",
  "题库 v{v1}：最难的 {v2} 任务通过率 {v3}%，仍有未解决的难度空间。":
    "Task library v{v1}: the hardest {v2} tasks pass {v3}% of the time, so there is still unsolved difficulty left in the library.",
  "实测对比需要一个可用的模型密钥，先在设置里配置。":
    "Measuring both versions needs a working model key. Configure one in Settings first.",
  "把同一批基准任务在当前版本和这个版本下各跑一遍，再用配置好的第三方评审模型匿名打分。只有实测更优的版本才允许启用，删除旧规则还需要评审逐条给出理由。":
    "Runs the same benchmark tasks under the current version and this one, then has the configured third-party reviewers score the transcripts blind. Only a version measured as better may be enabled, and every deleted old rule needs a reason from the reviewers.",
  "还不能启用": "Not ready to enable",
  "评审通过（{v1} 分），但还不能切换：\n{v2}":
    "Review passed ({v1}), but it cannot be switched yet:\n{v2}",
  "全局评审通过（{v1} 分），但还不能切换：\n{v2}":
    "Global review passed ({v1}), but it cannot be switched yet:\n{v2}",
  "相比{v1}：新增 {v2} 条 · 改写 {v3} 条 · 删去 {v4} 条":
    "Versus {v1}: {v2} added · {v3} rewritten · {v4} removed",
  "正在使用的 v{v}": "the version in use (v{v})",
  "初始设置": "the initial settings",
  " · 调整 {v1} 项设置": " · {v1} setting(s) adjusted",
  "评审理由：{v1}": "Reviewer reason: {v1}",
  "评审没有为这条删除给出可用理由，这一版不能启用。":
    "The reviewers gave no usable reason for this deletion, so this version cannot be enabled.",
  "删除旧规则必须由评审逐条说明理由，否则不能启用。":
    "Deleting an old rule requires a per-rule reason from the reviewers; otherwise it cannot be enabled.",
  "实测更优": "Measured better",
  "实测更差": "Measured worse",
  "实测无明显差异": "No measurable difference",
  "样本不足": "Not enough samples",
  "候选 {v1} 胜 / {v2} 负 / {v3} 平": "candidate: {v1} better / {v2} worse / {v3} tied",
  "任务通过率": "Tasks passed",
  "平均 token": "Avg tokens",
  "第三方评分": "Reviewer score",
  "匿名评分：{v1}": "Blind scores from: {v1}",
  "匿名评分消耗：输入 {v1} / 输出 {v2} / 缓存命中 {v3}，共 {v4} 次请求":
    "Blind grading cost: input {v1} / output {v2} / cache hits {v3}, {v4} requests",
  "这次评审消耗：输入 {v1} / 输出 {v2} / 缓存命中 {v3}，共 {v4} 次请求":
    "This review cost: input {v1} / output {v2} / cache hits {v3}, {v4} requests",
  "部分评审模型没有给出评分：{v1}": "Some reviewers returned no score: {v1}",
  "{v1}\n候选 {v2} 胜 / {v3} 负 / {v4} 平\n\n{v5}":
    "{v1}\nCandidate: {v2} better / {v3} worse / {v4} tied\n\n{v5}",
  "问题反馈": "Feedback",
  "反馈问题": "Report a problem",
  "提需求": "Request a feature",
  "提建议": "Suggest an improvement",
  "哪里报错、卡住或者和预期不一样": "Something errors, hangs or behaves differently than expected",
  "希望 Pilot 增加什么能力": "Something Pilot cannot do yet",
  "对已有功能的使用体验有想法": "An idea about how an existing feature works",
  "反馈使用中遇到的问题，也可以提需求或提建议。":
    "Report a problem you ran into, or ask for a feature or an improvement.",
  "反馈类型": "Feedback kind",
  "一句话概括": "One-line summary",
  "具体内容": "Details",
  "例如：手机端排队任务换个会话就消失了":
    "For example: queued tasks on the phone disappear when I switch sessions",
  "做了什么、看到什么、期望是什么。附上报错文字会更好定位。":
    "What you did, what you saw and what you expected. Pasting the error text helps pinpoint it.",
  "联系方式（可选）": "Contact (optional)",
  "邮箱或微信号，方便回复你": "Email or WeChat id so we can reply",
  "会附带以下环境信息：Pilot v{v1}，逐项可取消。":
    "These environment details are attached (Pilot v{v1}); uncheck any you want to leave out.",
  "系统与架构": "OS and architecture",
  "CPU 型号与核数": "CPU model and core count",
  "内存占用": "Memory usage",
  "工作区磁盘剩余": "Free space on the workspace volume",
  "Electron / Node / Chromium 版本": "Electron / Node / Chromium versions",
  "沙箱后端": "Sandbox backend",
  "不含主机名、用户名、网卡、IP 或设备序列号。":
    "No host name, user name, network adapter, IP or device serial number is included.",
  "打开反馈文件夹": "Open feedback folder",
  "复制反馈内容": "Copy feedback text",
  "提交反馈": "Send feedback",
  "提交中…": "Sending…",
  "已保存这条反馈": "Feedback saved",
  "反馈保存在本机 feedback 文件夹里，可以复制成文字发给开发者。":
    "It is stored in the local feedback folder; copy the text and send it to the developer.",
  "请选择反馈类型": "Choose the kind of feedback.",
  "请填写一句话概括": "Add a one-line summary.",
  "请填写具体内容": "Describe the details.",
  "概括请控制在 {v1} 个字符以内": "Keep the summary within {v1} characters",
  "内容请控制在 {v1} 个字符以内": "Keep the details within {v1} characters",
  "联系方式请控制在 {v1} 个字符以内": "Keep the contact within {v1} characters",
  "音频文件，可在应用内直接播放和拖动进度。":
    "Audio file: play and seek right here in the app.",

  // 文件预览：缩放与独立窗口
  "缩小（Ctrl + -）": "Zoom out (Ctrl + -)",
  "缩小": "Zoom out",
  "放大（Ctrl + =）": "Zoom in (Ctrl + =)",
  "放大": "Zoom in",
  "重置为 100%（Ctrl + 0）": "Reset to 100% (Ctrl + 0)",
  "在独立窗口打开，不影响正在执行的任务":
    "Open in its own window, leaving the running task alone",
  "新窗口": "New window",
  "关闭窗口": "Close window",
  "重新读取文件": "Reload the file",
  "缺少文件参数，请从主界面重新打开。":
    "No file was given; open it again from the main window.",

  // 产出质量闸门与小铃铛
  "已记录（未超过基线）": "Recorded (did not beat the baseline)",
  "等待你授权": "Waiting for your authorization",
  "已批准，待打包": "Approved, not packaged yet",
  "打包中…": "Packaging…",
  "已打包发布": "Packaged",
  "打包失败": "Packaging failed",
  "{v1} 个更优版本等待授权": "{v1} better version(s) awaiting your authorization",
  "产出质量 {v1} 分（点击查看评估指标）": "Output quality {v1} (click for the metrics)",
  "产出质量闸门：尚未建立基线": "Quality gate: no baseline yet",
  "产出质量与更优版本": "Output quality and better versions",
  "产出质量": "Output quality",
  "现行版本 {v1} 分 · 指标集 v{v2}": "Current version {v1} · metric set v{v2}",
  "尚未建立基线：下一次评估将成为基线": "No baseline yet: the next evaluation becomes it",
  "立即评估": "Evaluate now",
  "重调指标": "Re-tune metrics",
  "还没有候选版本。点“立即评估”用配置的评估模型给当前产出打分。":
    "No candidates yet. Use Evaluate now to have the configured evaluation model score the current output.",
  "候选 #{v1}": "Candidate #{v1}",
  "批准后会更新质量基线；未配置打包目标，不会自动打包":
    "Approving updates the quality baseline; with no packaging target configured nothing is packaged.",
  "批准后更新基线，并用 {v1} 打包发布":
    "Approving updates the baseline and packages with {v1}",
  "批准（仅更新基线）": "Approve (baseline only)",
  "批准并打包发布": "Approve and package",
  "先在设置里选择打包目标": "Pick a packaging target in Settings first",
  "开始打包": "Start packaging",
  "评估记录": "Evaluation log",
  "评估模型评分 + 运行记录统计；权重随评估自动调优（指标集 v{v1}）":
    "Evaluation-model score plus run-record statistics; weights re-tune automatically (metric set v{v1})",
  "产出质量闸门": "Output quality gate",
  "让探索任务围绕可度量的产出质量展开：由你在下面配置的评估模型按可自动调优的指标给当前产出打分，分数高于现行基线时，在 App 顶部小铃铛和桌面通知里提醒你。它不会自己上线：只有你在铃铛里批准某个候选版本后，才会用固定脚本打包。评估模型不可用时仍记录客观指标，只是缺少评审分。":
    "Turns exploration into work on measurable output quality: the evaluation model you configure below scores the current output against tunable metrics, and when the score beats the current baseline the bell in the title bar and a desktop notification tell you. Nothing ships on its own: packaging only runs with a fixed script after you approve a specific candidate in the bell. If the evaluation model is unavailable the objective metrics are still recorded, just without a review score.",
  "授权后执行的打包命令": "Packaging command run after authorization",
  "只提供白名单脚本，批准候选版本后原样运行、不接受附加参数。选“不自动打包”时，批准只更新质量基线。":
    "Only allowlisted scripts are offered; they run as-is with no extra arguments after you approve a candidate. With \"do not package\" selected, approving only updates the quality baseline.",
  "不自动打包（只更新基线）": "Do not package (baseline only)",
  "打包到目录（package:dir）": "Package to a directory (package:dir)",
  "指标重调频次": "Metric re-tune frequency",
  "每评估多少次重新计算一次指标权重（低分与无样本维度会被重新分配比重）。填 0 关闭自动调优，改为在铃铛里手动重调。":
    "How many evaluations pass before metric weights are recomputed (weak and unmeasured dimensions get re-weighted). Set 0 to turn automatic tuning off and re-tune by hand from the bell.",

  "插件": "Plugins",
  "插件视图": "Plugin views",
  "插件市场与插件助手": "Plugin market and assistant",
  "市场": "Market",
  "已安装": "Installed",
  "插件助手": "Assistant",
  "重新读取插件目录": "Re-read the plugin folder",
  "个已安装": "installed",
  "个已启用": "enabled",
  "个信任密钥": "trusted keys",
  "权限": "Permissions",
  "无": "None",
  "来源": "Source",
  "入口": "Entry",
  "路由": "Routes",
  "安装": "Install",
  "安装中…": "Installing…",
  "用这个模板自己改": "Start from this template",
  "签名策略": "Signature policy",
  "打开插件目录": "Open plugin folder",
  "读取插件…": "Loading plugins…",
  "还没有安装插件": "No plugins installed yet",
  "签名密钥": "Signing key",
  "身份提供者": "Session provider",
  "重新签名": "Re-sign",
  "信任的签名密钥": "Trusted signing keys",
  "签名了 {v1}": "Signs {v1}",
  "当前没有插件使用它": "No plugin uses it yet",
  "智能体工具": "Agent tools",
  "触发器": "Triggers",
  "每轮结束后": "After every run",
  "新建会话时": "When a session is created",
  "还有 {v1} 个必填项没填": "{v1} required fields are still empty",
  "填写后对下一次调用生效": "Takes effect on the next call",
  "已保存，留空则不改": "Saved · leave empty to keep it",
  "已保存 {v1} 的设置": "Saved settings for {v1}",
  "移出信任": "Revoke trust",
  "公钥（PEM）": "Public key (PEM)",
  "备注名": "Label",
  "例如：供应商甲 2026": "e.g. Acme vendor 2026",
  "信任这个公钥": "Trust this key",
  "选目录": "Pick a folder",
  "选模板并命名": "Pick a template",
  "签名与导入": "Sign and import",
  "创建目录": "Target folder",
  "插件会写在这个目录里": "The plugin is written here",
  "选择目录": "Choose folder",
  "插件 id": "Plugin id",
  "显示名称": "Display name",
  "我的业务插件": "My business plugin",
  "模板": "Template",
  "插件模板": "Plugin template",
  "生成后签名": "Sign after generating",
  "说明": "Description",
  "是": "Yes",
  "否": "No",
  "生成中…": "Generating…",
  "生成插件": "Generate plugin",
  "已生成": "Generated",
  "目录": "Folder",
  "未签名": "Unsigned",
  "签名可信": "Signature trusted",
  "来源未知": "Unknown signer",
  "签名后改过": "Changed after signing",
  "签名文件损坏": "Signature file unreadable",
  "公钥": "Public key",
  "分发给客户时贴这个": "Share this with your customers",
  "导入当前工作区": "Import into this workspace",
  "未启用": "Disabled",
  "这些目录没能通过清单校验": "These folders failed manifest validation",
  "插件代码写到你自己选的文件夹，必须是空目录或还不存在。":
    "The plugin is written into a folder you choose; it must be empty or not exist yet.",
  "生成 plugin.json、入口文件、README 和 .gitignore。":
    "Generates plugin.json, the entry file, README and .gitignore.",
  "可选地生成自己的密钥并签名，然后一键导入当前工作区。":
    "Optionally mint your own key and sign, then import into this workspace in one click.",
  "例如：D:\\work\\my-plugin": "e.g. D:\\work\\my-plugin",
  "在 .keys/ 里生成 ed25519 密钥对并写入 plugin.sig":
    "Create an ed25519 key pair in .keys/ and write plugin.sig",
  "一句话说明这个插件解决什么问题": "One line on what this plugin solves",
  "不会改动已有文件：目录非空时会直接报错。":
    "Existing files are never touched: a non-empty folder is rejected.",
  "off：只记录，不提示": "off: record only, no warning",
  "warn：未签名给警告（默认）": "warn: flag unsigned plugins (default)",
  "required：拒绝未信任的插件": "required: refuse untrusted plugins",
  "选择插件创建目录": "Choose the plugin folder",
  "已在 {v1} 生成插件「{v2}」，共 {v3} 个文件。":
    "Created “{v2}” in {v1} with {v3} files.",
  "已安装到工作区并启用授权流程。回到「已安装」标签勾选启用。":
    "Installed into the workspace. Open the Installed tab and enable it there.",
  "已安装 {v1}，并用本机密钥签名、加入信任库。":
    "Installed {v1}, signed it with this workspace's key and trusted that key.",
  "已用工作区密钥签名，并把公钥加入信任库。":
    "Signed with the workspace key and added the public key to the trust store.",
  "删除插件「{v1}」及其目录？这个操作不可撤销。":
    "Delete plugin “{v1}” and its folder? This cannot be undone.",
  "已删除 {v1}。": "Removed {v1}.",
  "已把该公钥加入信任库。": "Public key added to the trust store.",
  "已移出信任库；用它签名的插件会回到「来源未知」。":
    "Removed from the trust store; plugins it signed are unknown signers again.",
  "和 Pilot 对话做插件": "Build a plugin by talking to Pilot",
  "说清插件处理哪些路由、需要什么权限、数据存在哪里；Pilot 给出清单和入口代码，校验通过后你点确认才会写入工作区。":
    "Describe which routes it serves, what permissions it needs and where the data lives. Pilot drafts the manifest and entry code; nothing is written until you confirm.",
  "试试这样说：": "Try one of these:",
  "给我一个按条码查商品档案的插件，只读，权限 products:read。":
    "Give me a read-only plugin that looks up a product by barcode, with products:read.",
  "做一个把订单同步到外部系统的插件，需要 orders:write 权限，带一个 /sync 路由。":
    "Build a plugin that syncs orders to an external system; it needs orders:write and a /sync route.",
  "写一个内部公告插件，提供 /list 路由，未登录也能读。":
    "Write an internal notice plugin with a /list route that anyone can read.",
  "你": "You",
  "Pilot": "Pilot",
  "正在写清单和入口代码…": "Writing the manifest and entry code…",
  "描述你想要的插件，例如：按条码查商品档案，只读，带一个查询路由。":
    "Describe the plugin you want, e.g. look up products by barcode, read-only, one query route.",
  "清空对话": "Clear conversation",
  "Enter 发送，Shift + Enter 换行": "Enter sends, Shift + Enter adds a line",
  "或者从模板手工搭一个": "Or scaffold one by hand from a template",
  "模板脚手架：先选目录、再选模板命名，适合想自己完全掌控代码的场景。":
    "Template scaffold: pick a folder, pick a template and name it. Use it when you want to write every line yourself.",
  "第 {v1} 轮修正后通过校验": "Passed validation after {v1} rounds",
  "一次通过校验": "Passed validation first try",
  "公开": "Public",
  "需要登录": "Sign-in required",
  "写入后立即启用": "Enable right after writing",
  "用工作区密钥签名": "Sign with the workspace key",
  "签名策略是 required，写入时必须签名。":
    "The signature policy is required, so writing always signs.",
  "写入工作区": "Write to workspace",
  "把需求填回输入框": "Put the request back in the box",
  "收起代码": "Hide code",
  "查看清单与代码": "Show manifest and code",
  "插件草稿已生成，见下面的卡片。": "Draft ready — see the card below.",
  "已写入插件「{v1}」，共 {v2} 个文件；{v3}":
    "Wrote plugin “{v1}” ({v2} files); {v3}",
  "已启用，可以直接调用它声明的路由。": "it is enabled and its routes are callable.",
  "尚未启用，到「已安装」标签勾选启用。":
    "it is not enabled yet — enable it on the Installed tab.",
  "插件安装在工作区里，因此需要一个工作区才能浏览、安装和创建。":
    "Plugins live inside a workspace, so pick one before browsing, installing or creating.",
  "选择一个工作区后，这里会显示可安装的插件市场、已安装插件和插件助手。":
    "Pick a workspace to see the market, your installed plugins and the plugin assistant.",
  "插件独立进程运行，能访问 HTTP 路由、声明权限并参与登录。安装位置固定为 {v1}；插件助手可以把你自己的插件写到任意一个你选的目录，再导入这里。":
    "Plugins run in their own process: they serve HTTP routes, declare permissions and can provide sign-in. Installation always lands in {v1}; the assistant can write your own plugin to any folder you choose, then import it here.",
  "市场列表内置在应用里，不需要联网；安装时用本工作区的密钥签名并加入信任库，所以你随时能核对文件有没有被改。":
    "The market list ships with the app, so no network is needed. Installing signs the plugin with this workspace's key and trusts it, so you can always tell whether the files changed.",
  "从「市场」装一个，或用「插件助手」把自己的插件生成到某个目录后导入。":
    "Install one from the Market tab, or generate your own into a folder with the Assistant and import it.",
  "还没有信任任何密钥。未签名的插件在本机可以运行，但状态会显示为「未签名」。":
    "No keys trusted yet. Unsigned plugins still run locally, but their badge reads “Unsigned”.",
  "可直接使用的内置插件": "Ready-to-use bundled plugins",
  "一键安装": "Install",
  "已安装内置插件 {v1}，到「已安装」里勾选启用就能用。":
    "Installed bundled plugin “{v1}” — enable it on the Installed tab to start using it.",
  "内置插件随应用发布，装了就能用：安装后可用本机密钥签名、加入信任库，不需要联网也不需要自己写代码。":
    "Bundled plugins ship with the app and work out of the box: installing signs them with this workspace's key and trusts it — no network, no code to write.",
  "下面的市场模板是脚手架：装的是一个能跑的空壳，适合改成自己的业务插件。":
    "The market templates below are scaffolds: you get a runnable empty shell to turn into your own business plugin.",
  "智能体可调用": "Agent-callable",
  "可在插件页配置": "Configurable here",
  "{v1} 个工具": "{v1} tools",
  "{v1} 项设置": "{v1} settings",
  "插件在独立子进程里运行，只通过逐行 JSON-RPC 与宿主通信；启用时你会看到它声明的全部权限。签名只能证明文件没被改过，不是沙箱。":
    "Plugins run in a separate child process and talk to the host over line-delimited JSON-RPC; enabling one shows every permission it declares. A signature proves the files were not changed, it is not a sandbox.",
  "工程健康": "Engineering health",
  "模块自检": "Module self-check",
  "内视": "Introspection",
  "内视 Pilot 自身功能模块": "Inspect Pilot's own modules",
  "自身功能模块": "Its own modules",
  "读的是运行中的服务实例：模型接入、审批规则、沙箱、自写工具、MCP、插件、存储、任务、反馈与更新。不读工作区代码，也不需要你指定路径。":
    "Reads live service instances: model access, approval rules, sandbox, generated tools, MCP, plugins, storage, schedules, feedback and updates. It does not read workspace code and needs no path from you.",
  "重新内视": "Run again",
  "复制全文": "Copy report",
  "正在取样…": "Sampling…",
  "正常": "Normal",
  "注意": "Watch",
  "异常": "Broken",
  "模型与策略": "Model & policy",
  "执行": "Execution",
  "扩展": "Extensions",
  "数据与同步": "Data & sync",
  "用时 {v1} ms": "{v1} ms",
  "复制失败，请手动选择文本": "Copy failed — select the text manually",
  "还没有内视结果": "No introspection result yet",
  "自检只读扫描 Pilot 内置源码里你勾选的模块，用固定规则列出风险点和优化建议。勾选后默认只生成改造提案，不改任何文件；只有勾选「自改」才会开启一个普通会话去改，写入仍受沙箱与审批约束。":
    "The check only reads Pilot's own built-in source and lists risks and suggestions for the modules you pick with fixed rules. A selection produces a change proposal only; no file is touched. A session that edits the source starts only when you tick “self-modify”, and its writes stay under the sandbox and approval policy.",
  "重新读取内置源码目录": "Reread the built-in source folder",
  "健康分": "Health",
  "风险点": "Risks",
  "已扫描文件": "Files scanned",
  "自检模块": "Modules",
  "勾选要参与的模块；不勾选时默认自检全部。":
    "Pick the modules to include; when none are picked every module is checked.",
  "共 {v1} 个模块，已选 {v2} 个。": "{v1} modules, {v2} selected.",
  "全选": "Select all",
  "清空": "Clear",
  "重新扫描": "Rescan",
  "立即自检": "Run check now",
  "自检中…": "Checking…",
  "内置源码里没有发现可自检的模块。": "No checkable modules were found in the built-in source.",
  "{v1} 个文件 · {v2} 个源文件": "{v1} files · {v2} source files",
  "{v1} 个测试": "{v1} tests",
  "定期自检": "Scheduled check",
  "已开启 · 下次 {v1}": "On · next {v1}",
  "关闭时只在手动点击时扫描。开启后按间隔在后台用同一套规则扫描已选模块。":
    "When off, scanning only happens when you click. When on, the selected modules are checked in the background on the interval with the same rules.",
  "自检间隔": "Check interval",
  "关闭定期自检": "Turn off scheduled check",
  "开启定期自检": "Turn on scheduled check",
  "上次自检：{v1}": "Last check: {v1}",
  "扫描 {v1} 个文件 / {v2} 行": "{v1} files / {v2} lines scanned",
  "触发方式：{v1}": "Trigger: {v1}",
  "定期": "scheduled",
  "风险点与建议": "Risks and suggestions",
  "高 {v1} · 中 {v2} · 低 {v3}。勾选条目后可直接生成提案，或勾选「自改」后执行。":
    "High {v1} · medium {v2} · low {v3}. Tick items to create a proposal, or tick “self-modify” to apply it.",
  "还没有自检报告。点「立即自检」生成第一份。":
    "No report yet. Click “Run check now” to create the first one.",
  "全选可优化项": "Select all fixable",
  "允许直接修改 Pilot 自己的源码（自改）": "Let Pilot edit its own source (self-modify)",
  "正在处理…": "Working…",
  "开始自改（{v1} 项）": "Start self-modify ({v1})",
  "生成改造提案（{v1} 项）": "Create change proposal ({v1})",
  "不勾选「自改」时只生成提案，不会修改任何文件。":
    "Without “self-modify”, only a proposal is created — no file is touched.",
  "自改会真的改源码：会话结束后会自动重跑一次自检，用新报告刷新提案。":
    "Self-modify really edits the source; the check runs again afterwards and refreshes the proposal.",
  "已生成改造提案（{v1}），未修改任何文件。勾选「自改」后才会真正执行。":
    "Change proposal {v1} created; no file was touched. Tick “self-modify” to actually apply it.",
  "最近一份改造提案：{v1}（{v2} 项）": "Latest change proposal: {v1} ({v2} items)",
  " · 已按最新自检刷新": " · refreshed from the latest check",
  "最近一次自改：{v1}（会话 {v2}）": "Last self-modify: {v1} (session {v2})",
  "最近一次提案：{v1}（未修改任何文件）": "Last proposal: {v1} (no file was touched)",
  "扫描目标：Pilot 内置源码（{v1}）。": "Scanning Pilot's built-in source ({v1}).",
  "已创建修复会话，正在切换过去。": "Fix session created; switching to it.",
  "已创建修复会话，优化清单在会话队列里：配置模型后发送即可。":
    "Fix session created; the list is waiting in the session queue — send it once a model is configured.",
  "没有发现风险点。": "No risks found.",
  "建议": "Suggestion",
  "依据": "Basis",
  "大文件待量化": "Large file pending measurement",
  "代码结构与拆分决策": "Code structure and split decisions",
  "行数只说明“值得量化一次”，不是拆分建议。已记录决策的文件不会再被提。":
    "A line count only means “measure this once”; it is not a split suggestion. Files with a recorded decision are never raised again.",
  "已有判据、只差决策：{v1} 个文件。":
    "Verdict measured, decision still missing: {v1} file(s).",
  "判据 {v1}": "verdict {v1}",
  "还没量过：{v1} 个文件。先在 pilot/pilot 里跑 split-candidates.mjs 再决定。":
    "Never measured: {v1} file(s). Run split-candidates.mjs in pilot/pilot before deciding.",
  "未量化": "not measured",
  "已记录拆分决策：{v1} 条": "Recorded split decisions: {v1}",
  "{v1} 行": "{v1} lines",
  "已拆分": "Split",
  "决定不拆": "Kept as is",
  "暂缓": "Deferred",
  "该项已标记为人工处理，自检不会自动修改。":
    "Marked for manual handling; the check will not modify it.",
  "{v1} 项需要人工处理（例如疑似凭据），自检不会把它们交给会话自动修改。":
    "{v1} item(s) need manual handling (for example suspected credentials); they are never handed to a session for automatic edits.",
  "本次自检没有发现风险点。": "This run found no risks.",
  "每 {v1} 天": "Every {v1} days",
  "每 {v1} 小时": "Every {v1} hours",
  "自检生成的会话已不存在，请重新自检。":
    "The session created by the check no longer exists; run the check again.",
  "待办积压": "TODO backlog",
  "调试输出": "Debug logging",
  "缺少测试": "Missing tests",
  "硬编码路径": "Hardcoded path",
  "疑似凭据": "Suspected secret",
  "重复文件": "Duplicate file",
  "缺少验证脚本": "Missing verification script",

  // 会话资源抽屉（工作区文件 / 相关链接 / 可用工具 / 会话知识库 / 产出文件）
  "会话资源": "Session resources",
  "会话资源分类": "Session resource categories",
  "相关链接": "Links",
  "可用工具": "Tools",
  "新增/修改文件": "Changed files",
  "内置": "Built-in",
  "自写": "Custom",
  "独立窗口打开": "Open in window",
  "搜索这个会话的问答": "Search this session's Q&A",
  "也可能是内容都被忽略规则隐藏了。":
    "Or everything here is hidden by the ignore rules.",
  "选择会话后，这里会列出对话里出现过的链接。":
    "Pick a session and the links its transcript mentions appear here.",
  "正在收集链接…": "Collecting links…",
  "这个会话还没有链接": "No links in this session yet",
  "对话里出现 http(s) 链接后，会自动汇总到这里。":
    "Once an http(s) link shows up in the transcript it is collected here.",
  "选择会话后，这里会列出这次运行可用的工具。":
    "Pick a session to see the tools its run could use.",
  "这个会话还没有可用工具": "No tools for this session yet",
  "内置、MCP 与自写工具一旦对这次运行开放，就会出现在这里。":
    "Built-in, MCP and custom tools appear here once the run can use them.",
  "选择会话后，这里会按轮次整理提问与回复。":
    "Pick a session to see its instructions and replies, round by round.",
  "正在整理轮次…": "Assembling rounds…",
  "没有匹配的轮次": "No matching rounds",
  "这个会话还没有问答": "This session has no Q&A yet",
  "完成一轮问答后，这里会列出「我的指令 → Pilot 回复」。":
    "After one round it lists your instruction and Pilot's reply.",
  "第 {v1} 轮": "Round {v1}",
  "第 {v1} 轮 · {v2} 条回复": "Round {v1} · {v2} replies",
  "从左侧选择一条链接。": "Pick a link on the left.",
  "从左侧选择一个工具。": "Pick a tool on the left.",
  "从左侧选择一轮问答。": "Pick a round on the left.",
  "从左侧选择一个文件查看内容。": "Pick a file on the left to preview it.",
  "链接已复制": "Link copied",
  "已复制路径": "Path copied",
  "出现 {v1} 次": "Mentioned {v1} times",
  "来自我的提问": "From my message",
  "来自 Pilot 的回复": "From Pilot's reply",
  "协议": "Scheme",
  "路径": "Path",
  "锚点": "Anchor",
  "查询参数": "Query parameters",
  "（空）": "(empty)",
  "提到它的消息": "Message that mentions it",
  "（这句里只有链接本身）": "(that message is just the link)",
  "链接只从会话正文里收集，不抓取内容：这里看到的是提过哪些链接。":
    "Links come from the transcript only; nothing is fetched. This is a list of what was mentioned.",
  "未开放": "Not offered",
  "已开放": "Offered",
  "这个工具没有写说明。": "This tool has no description.",
  "可访问目标": "Reachable targets",
  "输入结构": "Input schema",
  "版本 {v1}": "Version {v1}",
  "清单与运行时一致：这里看到的就是这次运行真实可用的工具集合。":
    "The catalog matches runtime: this is exactly what the run could call.",
  "我的指令": "My instruction",
  "跳到这条回复": "Jump to this reply",
  "这条指令在知识库里是截断后的版本。":
    "This instruction is stored truncated in the knowledge base.",
  "（这一轮没有文字回复）": "(no text reply in this round)",
  "这条回复在知识库里是截断后的版本。":
    "This reply is stored truncated in the knowledge base.",
  "链接来自本次会话正文 · 只汇总不抓取":
    "Links from this session's transcript · listed, never fetched",
  "清单与运行时一致 · 只读展示": "Catalog matches runtime · read-only",
  "按轮次整理的会话知识库 · 只读预览":
    "Session knowledge base by round · read-only preview",

  // Session resources, todos and priority pickers.
  "这个会话已不在列表里，可能被删除了。":
    "This session is no longer in the list, so it may have been deleted.",
  "全部待办": "All todos",
  "全部待办：所有会话汇总": "All todos: every session combined",
  "这里是所有会话的待办汇总；发送会把该条待办排进对应会话的队列。":
    "Every session's todos in one place; sending queues one in its own session.",
  "正在汇总所有会话的待办…": "Gathering todos from every session…",
  "没有待办": "No todos",
  "在输入框顶部的待办面板里记一条，或选中正文后加入待办。":
    "Add one in the todo panel above the input, or select text and add it as a todo.",
  "回到这个会话": "Go to this session",
  " · {v1} 项已发送": " · {v1} sent",
  "发送到该会话": "Send to that session",
  "把这条待办发到「{v1}」？": "Send this todo to “{v1}”?",
  "{v1} 项待发送 · 分布在 {v2} 个会话":
    "{v1} pending · across {v2} sessions",
  "新待办优先级": "New todo priority",
  "高优先级": "High priority",
  "中优先级": "Medium priority",
  "低优先级": "Low priority",
  "最急": "Urgent",
  "默认": "Default",
  "可以等": "Can wait",
  "模型服务已连接 · 点击打开设置":
    "Model service connected · click to open settings",
  "尚未配置 API Key · 点击打开设置":
    "API key not set · click to open settings",
  "已连接": "Connected",
  "未连接": "Not connected",
  "当前会话调用 {v1} 次": "Called {v1} times in this session",
  "在内置浏览器打开": "Open in the built-in browser",
  "交给系统默认浏览器": "Open in the system browser",
  "系统浏览器": "System browser",
  "展开到整个界面": "Expand to the whole window",
  "收拢到侧边": "Collapse back to the side",
  "设置分组": "Settings sections",
  "测试与工具": "Testing and tools",
  "全部定时任务": "All scheduled tasks",
  "全部定时任务：所有会话汇总": "All scheduled tasks: one list across sessions",
  "定时": "Schedules",
  "定时任务在电脑端运行；关闭客户端后不会触发，重新打开时到点未跑的任务会补跑。":
    "Schedules run on the desktop app. They do not fire while it is closed; missed runs catch up when it opens again.",
  "删除这条定时任务？": "Delete this scheduled task?",
  "上次执行失败": "Last run failed",
  "上次 {v1}": "Last {v1}",
  "没有定时任务": "No scheduled tasks",
  "正在汇总所有会话的定时任务…": "Collecting scheduled tasks from every session…",
  "{v1} 项定时任务": "{v1} scheduled tasks",
  "{v1} 项定时任务 · {v2} 项启用 · 分布在 {v3} 个会话":
    "{v1} scheduled tasks · {v2} enabled · across {v3} sessions",
  "转成待办": "Turn into a todo",
  "基于当前会话新建一个副本": "Create a copy of this session",
  "进化历史": "Evolution history",
  "已清理进化记录，当前生效的机制保留不变。":
    "Evolution history cleared; the active mechanism is unchanged.",
  "清理全部进化记录？历次进化轮次与已退役的版本都会被删除，当前生效的机制保留不变。此操作不可撤销。":
    "Clear all evolution history? Past cycles and retired versions are deleted; the active mechanism is unchanged. This cannot be undone.",
  "所有轮次都会保留，不再自动删除；默认按评审分数从高到低显示前 {v1} 轮。":
    "Every cycle is kept until you clear it; the top {v1} by review score are shown by default.",
  "{v1} 轮记录": "{v1} cycles",
  "只看前 {v1} 轮": "Show top {v1} only",
  "展开全部 {v1} 轮": "Show all {v1} cycles",
  "清理历史": "Clear history",
  "还没有进化记录": "No evolution cycles yet",
  "跑过一轮系统进化后，这里会按评分列出每次尝试。":
    "After one evolution cycle, every attempt is listed here by review score.",
  "未采用": "Not adopted",
  "{v1} 分": "{v1} pts",
  "无评分": "Unscored",
  // 系统工具面板（左下角「工具」）
  "系统工具": "System tools",
  "系统工具：这个工作区能用的全部工具": "System tools: every tool available in this workspace",
  "工具按工作区装载，因此先选一个工作区才能看到这套工具。":
    "Tools load per workspace, so pick one before the set appears here.",
  "选择一个工作区后，这里会列出内置、控制、MCP、插件与自写工具。":
    "Once a workspace is selected, built-in, control, MCP, plugin and self-written tools are listed here.",
  "这里是 {v1} 里一次运行可能拿到的全部工具，调用次数是这个工作区所有会话的累计。":
    "Every tool a run in {v1} can reach. Call counts are cumulative across this workspace's sessions.",
  "个可用": "enabled",
  "个用过": "called",
  "工具来源": "Tool source",
  "重新读取工具清单": "Reload the tool list",
  "正在读取工具清单…": "Reading the tool list…",
  "这一栏没有工具": "No tools in this tab",
  "换个来源看看，或者让 Pilot 写一个自写工具。":
    "Try another source, or ask Pilot to write a dynamic tool.",
  "调用 {v1} 次": "{v1} calls",
  "累计调用 {v1} 次；这里的次数只统计已经执行过的调用，失败与拒绝的同样计入。":
    "{v1} calls in total. Only executed calls count, and failures and denials are included.",
  // 系统资源详情弹框
  "本机资源使用：点击查看详情": "Local resource usage: click for details",
  "系统资源详情": "System resource details",
  "这台电脑当前的负载与本机信息，和顶栏那条读数是同一份数据。":
    "Current load and machine details; the same readings as the top bar.",
  "本机信息": "Machine info",
  "系统负载": "System load",
  "架构": "Architecture",
  "总内存": "Total memory",
  "采样于 {v1}": "Sampled at {v1}",
  "这次读不到系统资源，稍后再试。": "System resources are unreadable right now; try again later.",
  "暂时读不到": "Unavailable",
  "{v1} 个逻辑核心 · {v2}": "{v1} logical cores · {v2}",
  "型号未知": "Unknown model",
  "整机占用": "Whole machine",
  "{v1} 已用 / {v2} 总量 · 空闲 {v3}": "{v1} used of {v2} · {v3} free",
  "工作区所在卷暂时读不到": "Workspace volume unavailable right now",
  "工作区所在卷 {v1} 已用 / {v2}": "Workspace volume {v1} used of {v2}",
  // 会话内定时面板
  "先写清楚到点要做什么": "Describe what it should do when it fires",
  "延迟至少 1 分钟": "Delay must be at least 1 minute",
  "间隔至少 5 分钟": "Interval must be at least 5 minutes",
  "时间格式要像 09:30": "Time must look like 09:30",
  "起始日期格式要像 2026-11-25": "The start date must look like 2026-11-25",
  "从哪天起": "From",
  "留空表示从今天开始每天执行": "Leave empty to start today",
  "{v1}（从 {v2} 起）": "{v1} (from {v2})",
  "已加入定时任务。": "Added to scheduled tasks.",
  "{v1} 项 · {v2} 项在等": "{v1} tasks · {v2} waiting",
  "到点自动加入队列，电脑端执行": "Queued automatically at the set time, run by the desktop app",
  "到点要让 Pilot 做什么": "What should Pilot do when it fires",
  "分钟后": "minutes from now",
  "分钟一次": "minutes",
  "还没有定时任务：点「新建」、待办上的时钟按钮，或直接在对话里说「20 分钟后…」。":
    "No scheduled tasks yet: hit “New”, the clock button on a todo, or just tell me in chat (for example “in 20 minutes …”).",
  "定时任务筛选": "Filter scheduled tasks",
  "启用中": "Active",
  "项启用中": "active",
  "项已暂停": "paused",
  "没有启用中的定时任务": "No active scheduled tasks",
  "切到「全部」可以看到已暂停的任务，再点「启用」恢复它。":
    "Switch to “All” to see paused tasks, then hit “Enable” to resume one.",
  "在会话输入框上方的「定时任务」面板新建一条，或直接在对话里说「每天 9 点…」，就能给这个会话挂上。":
    "Create one in the “Scheduled tasks” panel above the composer, or just tell me in chat (for example “every day at 9:00 …”), to attach it to this session.",
  // 全部待办
  "待办筛选": "Filter todos",
  "项待发送": "pending",
  "项已发送": "sent",
  "含已发送": "With sent",
  // 反思
  "反思": "Reflection",
  "反思发现": "Reflection findings",
  "启用反思": "Enable reflection",
  "关闭后不再自动反思；仍可在这里点「立即反思」。":
    "Turns off automatic reflection; “Reflect now” still works here.",
  "触发与问题域": "Triggers and topics",
  "报错触发": "On error",
  "一次运行失败后自动反思；10 分钟内的连续失败只跑一次，避免烧额度。":
    "Reflect after a failed run; repeated failures within 10 minutes run once to save quota.",
  "固定时间触发": "On schedule",
  "按间隔或每天固定时刻自动反思；到点后一分钟内开始。":
    "Reflect every N minutes or at a fixed time each day; it starts within a minute of the slot.",
  "反思模型": "Reflection model",
  "默认跟随会话模型；换成独立模型可以让反思不受当前任务上下文影响。":
    "Defaults to the session model; an independent model keeps reflection clear of the current task context.",
  "定时方式": "Schedule",
  "按间隔": "Every N minutes",
  "每天固定时刻": "Fixed time each day",
  "间隔分钟": "Interval (minutes)",
  "30 到 10,080 分钟": "30 to 10,080 minutes",
  "每天时刻": "Daily time",
  "24 小时制，例如 09:00": "24-hour clock, e.g. 09:00",
  "问题域": "Topics",
  "两种触发方式可以同时开启；每次反思按选中的问题逐个自问。":
    "Both triggers can be on at once; each reflection asks every selected question in turn.",
  "邮箱配置": "Mailbox settings",
  "收件人、SMTP 登录名和发件人都是这一个地址，也就是自己发给自己；发信失败只记在日志里。":
    "Recipient, SMTP user name and sender are all this one address — Pilot mails you. A delivery failure is only logged.",
  "邮箱地址": "Email address",
  "邮箱服务商": "Mail provider",
  "选常用邮箱会自动填好服务器、端口和加密方式，地址仍然自己填写；用自己的服务器就选「自定义」。":
    "Pick a common provider to fill in the server, port and encryption; the address is still yours to type. Choose Custom for your own server.",
  "自定义": "Custom",
  "邮件发到这个地址，也用它登录 SMTP 和充当发件人；多个地址用逗号分隔时只有第一个参与发信":
    "Mail goes to this address, and it is also the SMTP user name and sender; with several comma-separated addresses only the first is used to sign in and send.",
  "SMTP 服务器": "SMTP server",
  "例如 smtp.qq.com": "e.g. smtp.qq.com",
  "端口": "Port",
  "加密方式": "Encryption",
  "隐式 TLS": "Implicit TLS",
  "不加密": "No encryption",
  "授权码": "App password",
  "已保存授权码，留空则保持不变。":
    "An app password is saved; leave empty to keep it.",
  "在邮箱设置里开启 SMTP 服务后生成的授权码，不是登录密码。":
    "The app password generated after enabling SMTP in your mailbox settings — not your login password.",
  "已发送，请查收。打开邮件通知后才会自动发信。":
    "Sent — check your inbox. Mail is sent automatically only once notifications are on.",
  "清除已保存的授权码": "Clear the saved app password",
  "发送测试邮件": "Send test mail",
  "立即反思": "Reflect now",
  "测试邮件使用已保存的设置，改动后请先点「保存设置」。":
    "Test mail uses saved settings — click Save settings after editing.",
  "只保存反思自己的字段。": "Saves only the reflection fields.",
  "邮件通知": "Email notifications",
  "邮箱地址、SMTP 授权码以及哪些事件发信，都已经移到「设置 → 通知」。":
    "The email address, SMTP app password and the events that send mail now live in Settings → Notifications.",
  "打开通知设置": "Open notification settings",
  "最近反思": "Recent reflections",
  "最多保留 30 条；自主优化会读取这些结论作为信号。":
    "Up to 30 kept; self-optimization reads them as signals.",
  "还没有反思记录。": "No reflections yet.",
  "（没有摘要）": "(no summary)",
  "{v1} 条发现": "{v1} findings",
  "邮件已发送到 {v1}": "Mail sent to {v1}",
  "邮件未发送：{v1}": "Mail not sent: {v1}",
  "报告已记录，但邮件未发送：{v1}": "Report saved, but no mail was sent: {v1}",
  "未知原因": "unknown reason",
  "清空记录": "Clear records",
  "反思完成：{v1} 条发现。": "Reflection finished: {v1} findings.",
  "已发送，请查收。": "Sent — check your inbox.",
  "还没填写邮箱地址，通知邮件发不出去。":
    "No email address yet, so notification mail cannot be sent.",
  "还没填写 SMTP 服务器，通知邮件发不出去。":
    "No SMTP server yet, so notification mail cannot be sent.",
  "还没有保存 SMTP 授权码，发信会被服务器拒绝。":
    "No SMTP app password is saved yet; the server will reject the mail.",
  "已开启邮件通知，需要先填写邮箱地址。":
    "Email notifications are on, so set an email address first.",
  "邮件通知未启用：{v1}":
    "Email notifications stay off for now: {v1}",
  "授权码改动还没保存：请先点「保存设置」，再点这里。":
    "The app password change is not saved yet — click Save settings first, then retry.",
  "测试邮件发送失败。": "Test mail failed to send.",
  "记录已清空。": "Records cleared.",
  "反思间隔需要在 {v1} 到 {v2} 分钟之间。":
    "The reflection interval must be between {v1} and {v2} minutes.",
  "每天触发时刻需要是 24 小时制的 HH:mm。":
    "The daily time must be HH:mm on a 24-hour clock.",
  "SMTP 端口需要在 1 到 65535 之间。": "The SMTP port must be between 1 and 65535.",
  "通知配置": "Notification settings",
  "所有邮件通知集中在这里：开启就发，关闭就不发；列表按推荐优先级排序。":
    "Every email notification lives here: on means it is sent, off means it is not. The list is ordered by recommended priority.",
  "邮件通知总开关": "Email notifications",
  "关闭后下面勾选的任何事件都不会发信，已有的通知也不会补发。":
    "When off, none of the events below are mailed and nothing is backfilled.",
  "共 {v1} 类通知，已选 {v2} 类。未勾选的事件不会发信。":
    "{v1} notification types, {v2} selected. Unchecked events are never mailed.",
  "至少选择一个反思问题域。": "Pick at least one reflection topic.",
  "Pilot 按报错或固定时间对自己提问：会话压缩、存储、页面设计、项目结构、代码、执行效率、输出质量和交互体验哪里还能更好。":
    "Pilot asks itself on error or on a schedule: where can session compaction, storage, page design, project structure, code, execution efficiency, output quality and interaction still improve.",
  "自主优化": "Self-optimization",
  "按信号在护栏内自己开一轮修复会话":
    "Driven by signals, open one repair session inside the guardrails",
  "按模块扫描，找出问题模块并修复": "Scan module by module, find the problem module and fix it",
  "按问题域对自己提问，结论进入自主优化信号":
    "Ask itself per topic; the findings feed the self-optimization signals",
  "自学习循环：运行统计、画像提案与评审、回滚":
    "Learning loop: run statistics, profile proposals and review, rollback",
  "进化功能": "Evolution features",
  "反思设置已保存。": "Reflection settings saved.",
  "运行记录": "Run records",
  "源码自检": "Source self-check",
  "已开会话": "Session opened",
  "已跳过": "Skipped",
  "自主优化闭环": "Self-optimization loop",
  "Pilot 定时把运行记录、内视结果、源码自检与反思结论汇总成一份信号清单，在护栏内只挑一件事，用普通会话去修。取舍类问题（页面设计、项目结构、交互体验、输出质量）只列不自动动手；开出来的会话照常走沙箱与审批，不打开「允许自动动手」时什么都不会改。":
    "On a schedule Pilot folds run records, self-check results, source risks and reflection findings into one signal list, then picks exactly one item and fixes it in a normal session. Trade-off topics (page design, project structure, interaction experience, output quality) are listed but never fixed automatically; every session still goes through the sandbox and approvals, and with 'allow automatic fixes' off nothing is changed.",
  "待处理": "Open",
  "已处理": "Done",
  "不打算做": "Won't do",
  "处理状态": "Status",
  "本轮未提问：{v1}": "Not asked this round: {v1}",
  "这条结论没有指出代码位置，只能当作观察看。":
    "This finding points at no code location, so treat it as an observation only.",
  "本轮证据（摘要 {v1} / 全文 {v2} 字符）":
    "Evidence this round (preview {v1} / full {v2} chars)",
  "本轮证据（{v1} 字符）": "Evidence this round ({v1} chars)",
  "今日已用": "Used today",
  "运行状态": "Run state",
  "已关闭 · 关闭时只能手动跑一轮，且不会自动动手。":
    "Off · you can still run one round by hand, but it will never act on its own.",
  "优化间隔": "Optimization interval",
  "关闭定时优化": "Turn off scheduled optimization",
  "开启定时优化": "Turn on scheduled optimization",
  "重新读取状态": "Reload state",
  "立即分析一轮": "Analyze now",
  "上次分析：{v1}": "Last analysis: {v1}",
  "今日指令已用 {v1}/{v2} 字符": "{v1}/{v2} prompt characters used today",
  "护栏": "Guardrails",
  "两道开关都必须由你手动打开。每日预算按滚动的 24 小时统计：用完只出清单。同一项 24 小时内只自动处理一次，需要人判断的项永远不进自动队列；反思里的页面设计、项目结构、输出质量、交互体验四类就是只进清单不自动动手。":
    "Both switches have to be turned on by you. The daily budget rolls over 24 hours: once it is used up Pilot only produces the list. Each item is auto-handled at most once per 24 hours, and anything needing human judgement never enters the auto queue — the four reflection topics page design, project structure, output quality and interaction experience are listed only.",
  "按间隔自动分析": "Analyze on a schedule",
  "只读采集信号并生成清单，不改任何文件。":
    "Collects signals read-only and produces a list; it never changes a file.",
  "允许自动动手": "Allow automatic fixes",
  "每轮最多开一个普通会话去修。审批策略、沙箱、权限规则都不受影响，被拒绝时这一轮只记失败。":
    "At most one normal session per round does the work. Approval policy, sandbox and permission rules stay untouched; a denial is recorded as a failed action.",
  "每日自动会话上限": "Daily automatic session limit",
  "超出后只出清单，0 表示永不自动动手。":
    "Beyond it Pilot only lists findings; 0 means it never acts automatically.",
  "每日指令字符上限": "Daily prompt character limit",
  "单条指令超预算会被截断并标注。":
    "A prompt over budget is truncated and marked as truncated.",
  "信号": "Signals",
  "还没有分析过。点「立即分析一轮」生成第一份信号。":
    "No analysis yet — click Analyze now to produce the first set of signals.",
  "暂无信号。": "No signals yet.",
  "本轮发现": "Findings this round",
  "高 {v1} 项 · 需人工确认 {v2} 项 · 本轮动手 {v3} 次。":
    "{v1} high · {v2} needing a human · {v3} action(s) taken this round.",
  "这一块只列出结论与证据，不含被扫描文件的内容。":
    "This section only lists conclusions and evidence, never the contents of scanned files.",
  "这一轮没有发现需要处理的信号。": "This round found nothing to act on.",
  "还没有分析结果。": "No analysis yet.",
  "需人工确认": "Needs a human",
  "动作记录": "Actions",
  "每一轮的动作都记账：为什么动手、为什么跳过、为什么失败。":
    "Every round records its actions: why it acted, why it skipped, why it failed.",
  "这一轮没有产生动作。": "This round produced no actions.",
  "指令 {v1} 字符": "{v1} prompt characters",
  "历史轮次": "Past rounds",
  "保留最近 {v1} 轮，供你回看健康分的变化。":
    "Keeps the last {v1} rounds so you can follow the health score.",
  "健康分 {v1}": "Score {v1}",
  "{v1} 项信号": "{v1} signals",
  "动过手": "Acted",
  "未动手": "No action",
  "还没有历史轮次。": "No past rounds yet.",
  "可用运行样本": "Usable runs",
  "运行成功率": "Success rate",
  "工具错误率": "Tool error rate",
  "内视异常": "Self-check issues",
  "源码风险": "Source risks",
  "偏好": "Preferences",
  "偏好：外观与界面语言": "Preferences: appearance and interface language",
  "偏好已保存。": "Preferences saved.",
  "外观与语言": "Appearance and language",
  "主题、字号和界面语言。选中会立刻预览，保存后生效。":
    "Theme, font size and interface language. A change previews immediately and applies once saved.",
  "模型设置已保存。": "Model settings saved.",
  "会话 · 复盘 · 评估": "Sessions · Review · Evaluation",
  "所有模型都从这里配置。会话、复盘和评估只引用资源；密钥仅保存在本机并加密。":
    "Every model is configured here. Sessions, review and evaluation only reference these resources; keys are encrypted and kept on this machine.",
  "模型：会话、复盘与评估引用的全部端点":
    "Models: every endpoint referenced by sessions, review and evaluation",
  "模型密钥与偏好见左下角「模型」「偏好」。":
    "Model keys and preferences live in “Models” and “Preferences” at the bottom left.",
  "设置（{v1} 项进化草稿待确认）": "Settings ({v1} evolution draft(s) awaiting review)",
}
