// 完全自主档（full autonomy）：把网络访问、自身源码与配置、自身全部功能、
// 资源/数据/日志的读取放开到功能性上限，同时保留三条不会被绕过的硬边界：
//
//   1. token 可控 —— 没有 token 上限或步数上限时不允许进入该档位；
//   2. 隐私 —— 凭据、私钥、浏览器会话、密码库等路径永远不给读写；
//   3. 留痕 —— 每次越界读取/自身配置写入/无人值守构建都写一条审计记录。
//
// 这个文件只放纯逻辑：设置层、权限层、文件工具层都从这里取同一份判断，
// 免得「设置说放开了、权限层还挡着」这类漂移。
import type { ApprovalMode } from './types'

/** 进入完全自主档的最低 token 上限：低于这个量级等于没有上限。 */
export const AUTONOMY_MIN_TOKEN_BUDGET = 100_000
/**
 * 「不限 token」（设置里为 0）时的兜底预算。完全自主档的前提之一就是消耗可控，
 * 所以这时不给无限额度，而是套一个足够跑完长任务、又不会失控的数量。
 */
export const AUTONOMY_DEFAULT_TOKEN_BUDGET = 2_000_000
/** 进入完全自主档的最低步数上限：不设上限的运行不算「可控」。 */
export const AUTONOMY_MIN_STEPS = 20

export interface AutonomyInput {
  fullAutonomy?: boolean
  approvalMode: ApprovalMode
  maxTokens?: number
  maxSteps?: number
}

export type AutonomyBlocker = 'disabled' | 'manual-mode' | 'token-budget' | 'step-cap'

export interface AutonomyPolicy {
  /** 档位真的生效：已在设置里开启、当前是全部自动模式、且预算可控。 */
  active: boolean
  /** 本次运行实际使用的 token 上限；`0` 在这里永不出现。 */
  tokenBudget: number
  /** 读类工具可以传工作区外的绝对路径（隐私路径仍拒绝）。 */
  readOutsideWorkspace: boolean
  /** 允许改写 .pilot/ 下的自身配置（技能、记忆、动态工具、钩子）。 */
  writeOwnConfig: boolean
  /** 构建个人实验版不再逐次确认。 */
  unsupervisedBuild: boolean
  /** 读取自身运行记录与执行策略不再逐轮申请授权。 */
  autoSystemAccess: boolean
  /** 沙箱网络不再被学习隔离关掉；`allow` 表示按联网处理。 */
  network: 'inherit' | 'allow'
}

const INACTIVE: AutonomyPolicy = {
  active: false,
  tokenBudget: 0,
  readOutsideWorkspace: false,
  writeOwnConfig: false,
  unsupervisedBuild: false,
  autoSystemAccess: false,
  network: 'inherit',
}

/** 哪些条件没满足。全部为空才算「可以开启并生效」。 */
export function autonomyBlockers(input: AutonomyInput): AutonomyBlocker[] {
  const blockers: AutonomyBlocker[] = []
  if (input.fullAutonomy !== true) blockers.push('disabled')
  if (input.approvalMode !== 'auto') blockers.push('manual-mode')
  const tokens = autonomyTokenBudget(input.maxTokens)
  if (tokens < AUTONOMY_MIN_TOKEN_BUDGET) blockers.push('token-budget')
  const steps = Number(input.maxSteps ?? 0)
  // `0` 是设置里的「不限」：循环会把它换成 UNLIMITED_STEPS_FALLBACK 作阀门，
  // 远高于 AUTONOMY_MIN_STEPS，所以它同样算「预算可控」。把它当成「没设上限」
  // 会让用户看到「填 0 反而不允许开启完全自主」这种自相矛盾的结论。
  if (!Number.isFinite(steps) || steps < 0 || (steps > 0 && steps < AUTONOMY_MIN_STEPS)) {
    blockers.push('step-cap')
  }
  return blockers
}

/**
 * `0` 表示用户选了「不限」，完全自主档下换成 `AUTONOMY_DEFAULT_TOKEN_BUDGET`；
 * 用户显式给了正数就用他的值，不抬高也不压低。
 */
export function autonomyTokenBudget(maxTokens: number | undefined): number {
  const value = Number(maxTokens ?? 0)
  if (!Number.isFinite(value) || value <= 0) return AUTONOMY_DEFAULT_TOKEN_BUDGET
  return Math.round(value)
}

export function autonomyReady(input: AutonomyInput): boolean {
  return autonomyBlockers(input).length === 0
}

/**
 * 有效策略。设置开着但预算不满足时返回未生效的档位，
 * 而不是半开：半开最容易出现「以为放开了，实际卡在某个随机限制上」。
 */
export function autonomyPolicy(input: AutonomyInput): AutonomyPolicy {
  if (!autonomyReady(input)) return INACTIVE
  return {
    active: true,
    tokenBudget: autonomyTokenBudget(input.maxTokens),
    readOutsideWorkspace: true,
    writeOwnConfig: true,
    unsupervisedBuild: true,
    autoSystemAccess: true,
    network: 'allow',
  }
}

/** 目录级隐私边界：整棵子树都不给读写。 */
const PRIVATE_SEGMENTS: RegExp[] = [
  /(^|\/)\.ssh(\/|$)/i,
  /(^|\/)\.gnupg(\/|$)/i,
  /(^|\/)\.aws(\/|$)/i,
  /(^|\/)\.azure(\/|$)/i,
  /(^|\/)\.kube(\/|$)/i,
  /(^|\/)\.docker(\/|$)/i,
  /(^|\/)user data(\/|$)/i,
  /(^|\/)microsoft[\\/]credentials(\/|$)/i,
  /(^|\/)keychain(s)?(\/|$)/i,
  /(^|\/)\.pilot[\\/]secrets(\/|$)/i,
]

/** 文件级隐私边界：凭据、私钥、浏览器会话库、密码库。 */
const PRIVATE_FILES: RegExp[] = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)\.env$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.git-credentials$/i,
  /(^|\/)\.pgpass$/i,
  // Pilot 自己的状态文件里存着 `keyCipher`（base64 可逆的模型 key）与判分轮商的 key，
  // 它落在 userData 而不是工作区，完全自主档能读工作区外路径，所以必须单独拦住。
  /(^|\/)pilot-state\.json($|\.)/i,
  /(^|\/)login data$/i,
  /(^|\/)cookies(\.sqlite)?$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|pfx|p12|kdbx|jks|keystore)$/i,
  /(^|\/)(credentials?|secrets?|tokens?)\.(json|ya?ml|txt|ini|env)$/i,
]

/** 归一化后判断路径是否落在隐私边界内。 */
export function isPrivatePath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').replace(/\/+/g, '/').trim()
  if (!normalized) return false
  return (
    PRIVATE_SEGMENTS.some((pattern) => pattern.test(normalized)) ||
    PRIVATE_FILES.some((pattern) => pattern.test(normalized))
  )
}

/**
 * 完全自主档下仍要拒绝的路径；返回给模型的理由。
 * 传 `null` 表示可以继续。
 */
export function autonomyPathDenial(path: string): string | null {
  if (!isPrivatePath(path)) return null
  return '完全自主档仍不读取隐私路径（凭据、私钥、浏览器会话、密码库）。需要这些内容时请由你本人打开文件并只把必要的片段贴进对话。'
}

/**
 * shell 命令是否指向隐私文件。只看“像路径”的 token（含分隔符或以 ~ / . 开头），
 * 所以 `grep cookies src` 这种普通搜索不会被误伤，而
 * `sqlite3 ~/.config/google-chrome/Default/Cookies` 会被拦住。
 */
export function isPrivateShellTarget(command: string): boolean {
  const tokens = command.split(/[\s'"|;&<>()`,]+/).filter(Boolean)
  return tokens.some((token) => {
    if (!/[/\\~]|^\./.test(token)) return false
    return isPrivatePath(token)
  })
}

/** 审计记录的一行。越界读取、自身配置写入、无人值守构建、自动系统授权都写。 */
export interface AutonomyAuditEntry {
  at: string
  kind: AutonomyAuditKind
  tool: string
  detail: string
  tokenBudget: number
  stepCap: number
}

export type AutonomyAuditKind =
  | 'read-outside'
  | 'write-own-config'
  | 'unattended-build'
  | 'system-access'

/** 写入落在 `.pilot/` 下的自身配置（技能、记忆、动态工具、钩子、配方）。 */
const OWN_CONFIG_MARKERS: RegExp[] = [
  /(^|\/)\.pilot\/skills(\/|$)/i,
  /(^|\/)\.pilot\/memory(\/|$)/i,
  /(^|\/)\.pilot\/tools(\/|$)/i,
  /(^|\/)\.pilot\/recipes(\/|$)/i,
  /(^|\/)\.pilot\/hooks\.json$/i,
  /(^|\/)\.pilot\/mcp\.json$/i,
  // 会话级 MCP 配置在仓库根，不在 `.pilot/` 下，但同属「Pilot 自身配置」，
  // 权限层放行它，审计就必须跟着记一笔。
  /(^|\/)\.mcp\.json$/i,
  /(^|\/)\.pilot\/learning(\/|$)/i,
]

function slash(path: string): string {
  return path.replace(/\\/g, '/')
}

export function isOwnConfigPath(path: string): boolean {
  const normalized = slash(path)
  return OWN_CONFIG_MARKERS.some((pattern) => pattern.test(normalized))
}

/**
 * 构建/启动个人实验版的命令。这是**审计用**的保守近似：宁可多记一条，
 * 也不要漏记「源码变成可执行文件」这种不可逆动作。权限层对它的判定更严格，
 * 见 `src/main/agent/permissions.ts` 的 `isSelfEvolutionBuildCommand`。
 */
export function isAutonomyBuildCommand(command: string): boolean {
  const text = command.trim()
  if (!text) return false
  return (
    /\bself-build\b/i.test(text) ||
    /\bpackage:(?:dir|win|mac|linux|source)\b/i.test(text) ||
    /\belectron-builder\b/i.test(text) ||
    /release-selfdev/i.test(text)
  )
}

/** shell 命令行里出现的、指向工作区外的绝对路径（只用于留痕）。 */
function outsideAbsoluteToken(command: string, root: string): string {
  const tokens = command.split(/[\s'"|;&<>()`,=]+/).filter(Boolean)
  const normalizedRoot = slash(root).replace(/\/+$/, '').toLowerCase()
  for (const token of tokens) {
    if (!isAbsolutePath(slash(token))) continue
    const value = slash(token).toLowerCase()
    if (normalizedRoot !== '' && (value === normalizedRoot || value.startsWith(`${normalizedRoot}/`))) {
      continue
    }
    return token
  }
  return ''
}

/**
 * 一次工具调用是否要写审计记录。完全自主档放开了功能边界，所以越界的每一次
 * 读写都留痕；未生效（返回 `null`）时不记，普通运行的量大且没有审计价值。
 *
 * 纯函数：入参是工具名、工具风险、参数和工作区根，便于单测。
 */
export function autonomyAuditKind(
  tool: { name: string; risk?: string },
  args: Record<string, unknown>,
  workspacePath: string,
): AutonomyAuditKind | null {
  const command = typeof args['command'] === 'string' ? args['command'] : ''
  const path = typeof args['path'] === 'string' ? slash(args['path'].trim()) : ''
  // 构建优先：它同时可能带工作区外路径（node_modules/.bin/...），
  // 但真正不可逆的是「源码变成可执行文件」这一步。
  if (command && isAutonomyBuildCommand(command)) return 'unattended-build'
  if (path && isAbsolutePath(path)) {
    const root = slash(workspacePath).replace(/\/+$/, '')
    const inside = root !== '' && path.toLowerCase().startsWith(`${root.toLowerCase()}/`)
    if (!inside) return 'read-outside'
  }
  if (command && outsideAbsoluteToken(command, workspacePath) !== '') return 'read-outside'
  if (path && tool.risk === 'write' && isOwnConfigPath(path)) return 'write-own-config'
  return null
}

/** 只看形状，不碰 node:path，免得共享层依赖平台。 */
function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[a-zA-Z]:\//.test(path) || path.startsWith('//')
}

export function formatAutonomyAudit(entry: AutonomyAuditEntry): string {
  return JSON.stringify(entry)
}

/**
 * 沙箱里需要额外给写权限的根。完全自主档能改自身源码，所以源码目录必须可写
 * （bwrap 默认把 / 只读绑定，只有工作区是 `--bind` 可写）。
 * 只返回真实落在工作区之外的路径：工作区已经在可写列表里，重复绑定没有意义。
 */
export function extraWritableRoots(workspacePath: string, selfSourceRoot?: string): string[] {
  const workspace = slash(workspacePath).replace(/\/+$/, '').toLowerCase()
  const source = typeof selfSourceRoot === 'string' ? slash(selfSourceRoot).trim() : ''
  if (!source) return []
  const normalized = source.replace(/\/+$/, '')
  const lowered = normalized.toLowerCase()
  if (workspace !== '' && (lowered === workspace || lowered.startsWith(`${workspace}/`))) return []
  return [normalized]
}
