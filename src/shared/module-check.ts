/**
 * 模块自检：把工作区拆成可勾选的模块，用确定性规则产出风险点与优化建议。
 *
 * 设计约束：
 * - 规则只读文件事实（行数、大小、文本样本），不调用模型，因此同一份代码两次
 *   自检的结果一致，用户看到的每一条风险都能追到具体文件与行号。
 * - 证据只记录位置与计数，绝不把疑似密钥的原文写进报告：`secret-like` 命中的
 *   内容一旦进入报告，就会随报告一起落盘、同步给手机端。
 * - 报告与决策都是纯数据，可以持久化与审计。真正的修改不由自检执行，而是用户
 *   勾选后生成一个普通编码会话，走和手写任务完全相同的沙箱与审批策略。
 */

export type ModuleCheckSeverity = 'high' | 'medium' | 'low'
/**
 * 扫描触发源。`self-modify` 表示「用户刚做完一次自改，自动重扫以刷新提案」，
 * 它同样只读，不会修改任何文件。
 */
export type ModuleCheckTrigger = 'manual' | 'schedule' | 'self-modify'

export type ModuleRuleId =
  | 'oversized-file'
  | 'todo-backlog'
  | 'debug-logging'
  | 'missing-tests'
  | 'hardcoded-path'
  | 'secret-like'
  | 'duplicate-file'
  | 'missing-verification-script'

/** 一个可勾选的自检单元：通常是工作区里的一个子项目或一层目录。 */
export interface ModuleTarget {
  /** 相对工作区根目录的稳定 id，例如 `client:src:main`。 */
  id: string
  name: string
  /** 相对工作区根目录的路径，用 `/` 分隔。 */
  path: string
  files: number
  sourceFiles: number
  testFiles: number
  lines: number
}

/** 扫描阶段产出的事实。文本样本只在文件足够小且是文本时提供。 */
export interface ModuleFileFact {
  /** 相对工作区根目录的路径，用 `/` 分隔。 */
  path: string
  lines: number
  bytes: number
  text?: string
}

export interface ModuleRisk {
  /** 稳定 id：`<moduleId>:<rule>`，同一模块同一规则只有一条。 */
  id: string
  moduleId: string
  moduleName: string
  rule: ModuleRuleId
  severity: ModuleCheckSeverity
  title: string
  detail: string
  recommendation: string
  count: number
  /** 证据位置：`file` 或 `file:line`，不含任何被命中的原文。 */
  evidence: string[]
  /** 问题不能自动修改（例如疑似密钥），只能人工确认。 */
  manual: boolean
}

export interface ModuleCheckReport {
  id: string
  trigger: ModuleCheckTrigger
  startedAt: string
  finishedAt: string
  /** 自检时的工作区绝对路径。 */
  workspace: string
  /** 本次实际扫描的模块 id。 */
  modules: string[]
  targets: ModuleTarget[]
  risks: ModuleRisk[]
  scannedFiles: number
  scannedLines: number
  /** 0-100，越高越健康。 */
  score: number
}

/**
 * 改造提案：自检与内视的最终产出物。
 *
 * 提案只是一个可审阅的文本加清单，生成它**不会**改动任何文件；只有用户在界面上
 * 显式勾选「自改」后，提案才会被当作首条指令交给编码会话。
 */
export interface ModuleProposal {
  /** `mp_<timestamp>`。 */
  id: string
  /** 依据哪一份扫描报告生成。 */
  reportId: string
  createdAt: string
  /** 提案针对的源码根目录（内视固定为 Pilot 自身源码）。 */
  workspace: string
  riskIds: string[]
  /** 交给编码会话的完整指令；未勾选自改时它只用于预览。 */
  prompt: string
  /** 是否已由用户显式勾选「自改」并送入编码会话。 */
  selfModify: boolean
  /** 自改会话 id，仅 `selfModify` 为 true 时存在。 */
  sessionId?: string
  /** 自改会话结束后重跑自检、提案被刷新的时间。 */
  refreshedAt?: string
}

export interface ModuleCheckDecision {
  reportId: string
  riskIds: string[]
  /** 只在用户显式自改时存在；仅生成提案时没有会话。 */
  sessionId?: string
  at: string
  /** 这次确认是否真的允许 Pilot 改自身源码。 */
  selfModify: boolean
  proposalId?: string
}

export interface ModuleCheckSettings {
  enabled: boolean
  /** 定期自检间隔，单位小时。 */
  intervalHours: number
  /** 勾选的模块 id；空数组表示全部模块。 */
  modules: string[]
}

export interface ModuleCheckState {
  settings: ModuleCheckSettings
  lastRunAt?: string
  nextRunAt?: string
  lastReport?: ModuleCheckReport
  /** 最近的报告，最新的在前。 */
  history: ModuleCheckReport[]
  decisions: ModuleCheckDecision[]
  /** 最近的改造提案，最新的在前。 */
  proposals: ModuleProposal[]
}

/**
 * 给手机端的状态摘要。
 *
 * 手机只需要设置、最新一份报告、历史份数和最近的决策，不需要把整份
 * `history` 深拷贝一遍。报告本身可能包含几百条风险，深拷贝再裁剪会让
 * 「读取自检状态」无谓地慢上几秒。
 */
export interface ModuleCheckSummary {
  settings: ModuleCheckSettings
  lastRunAt?: string
  nextRunAt?: string
  lastReport?: ModuleCheckReport
  historyCount: number
  decisions: ModuleCheckDecision[]
  proposals: ModuleProposal[]
}

export const MODULE_CHECK_HISTORY_LIMIT = 20
/** 只保留最近几份改造提案：提案里带完整指令，存太多没意义。 */
export const MODULE_PROPOSAL_LIMIT = 10

export const DEFAULT_MODULE_CHECK_SETTINGS: ModuleCheckSettings = {
  enabled: false,
  intervalHours: 24,
  modules: [],
}

export const MODULE_INTERVAL_CHOICES = [6, 12, 24, 72, 168] as const

const OVERSIZED_MEDIUM = 800
const OVERSIZED_HIGH = 1500
const TODO_THRESHOLD = 3
const MIN_DUPLICATE_BYTES = 4096
const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|vue|py|go|rs|java|kt)$/i
const TEST_FILE = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[a-z]+$|(^|\/)test\.[a-z]+$/i
/**
 * 机器生成或第三方产物：不是人工维护的代码。
 *
 * 锁文件里必然有本机路径与哈希，构建产物里必然有重复拷贝与调试输出——把这些算
 * 进风险只会把真正要处理的问题淹掉，所以任何规则都先排除它们。
 */
const GENERATED_FILE =
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb|Cargo\.lock|poetry\.lock|composer\.lock)$/i
const GENERATED_DIR =
  /(^|\/)(unpackage|dist|dist-electron|out|build|release|coverage|node_modules|vendor|__generated__|generated|public\/build)(\/|$)/i
/** CLI 入口：console 输出本身就是它的接口，不算调试残留。 */
const CLI_ENTRY = /(^|\/)(scripts?|bin|cli)\/|[-.]cli\.[a-z]+$/i
const LOG_LINE = /console\.(log|debug)\(/
const TODO_LINE = /\b(TODO|FIXME|HACK|XXX)\b\s*[:(]/
const WINDOWS_ABS_PATH = /[A-Za-z]:[\\/]{1,2}[A-Za-z0-9_.-]+[\\/][A-Za-z0-9_.\\/-]+/
const POSIX_HOME_PATH = /\/(Users|home)\/[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+/
const SECRET_SHAPES = [
  /sk-[A-Za-z0-9_-]{16,}/,
  /AKIA[0-9A-Z]{16}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /(?:api[_-]?key|secret|token)\s*[:=]\s*['"][A-Za-z0-9_\-.]{24,}['"]/i,
]

export const SEVERITY_ORDER: Record<ModuleCheckSeverity, number> = {
  high: 0,
  medium: 1,
  low: 2,
}

const SEVERITY_WEIGHT: Record<ModuleCheckSeverity, number> = {
  high: 12,
  medium: 6,
  low: 2,
}

export function isSourceFile(path: string): boolean {
  return SOURCE_FILE.test(path)
}

export function isTestFile(path: string): boolean {
  return TEST_FILE.test(path)
}

/**
 * 生成物（构建目录、锁文件）不算人工维度的代码。
 *
 * 扫描阶段仍会统计它们（体积就是事实），但规则判定前全部摘掉。
 */
export function isGeneratedPath(path: string): boolean {
  return GENERATED_FILE.test(path) || GENERATED_DIR.test(path)
}

/** CLI 入口里的 console 是正式输出，不是调试残留。 */
export function isCliEntry(path: string): boolean {
  return CLI_ENTRY.test(path)
}

/**
 * 独立服务脚本（`relay/server.mjs` 这类）：它们的 stdout 就是运维日志，
 * 进出场打一行不算调试残留；被前端/桌面打包进 `src/` 的代码才算。
 */
export function isServiceScript(path: string): boolean {
  return /\.(mjs|cjs)$/i.test(path) && !/(^|\/)src\//i.test(path)
}

/** 人看的示例文本（占位符、i18n 文案）里的路径不算写死依赖。 */
const EXAMPLE_HINT = /placeholder|\u4f8b\u5982|\be\.g\.|example/i

/**
 * 去掉 URL 再做路径判定。
 *
 * `https://pilot.example.com/app/` 在字符层面就是一个“盘符 + 双斜线”，不先抹掉
 * 会把线上域名当成写死的本地目录报出来。
 */
function stripUrls(line: string): string {
  return line.replace(/[a-z][a-z0-9+.-]*:\/\/\S*/gi, ' ')
}

/**
 * 位置是否落在引号字符串里。
 *
 * 规则只看原文，所以基准测试的任务描述（`"console.log('ok')"`）会被当成真实现
 * 的调试输出。用“行内引号奇偶”做确定性判定：奇数个引号说明这一位置在字符串内。
 */
function insideStringLiteral(line: string, at: number): boolean {
  let quotes = 0
  for (let index = 0; index < at; index += 1) {
    const char = line[index]
    if (char === '\\') {
      index += 1
      continue
    }
    if (char === '"' || char === "'" || char === '`') quotes += 1
  }
  return quotes % 2 === 1
}

/** 注释行：`//`、`/*`、`*`、`#` 开头（含缩进），或者是行内注释后半段。 */
function commentIndex(line: string): number {
  const trimmed = line.trimStart()
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) return 0
  const block = line.indexOf('/*')
  if (block >= 0) return block
  return line.indexOf('//')
}

function baseName(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 1] ?? path
}

interface RiskDraft {
  rule: ModuleRuleId
  severity: ModuleCheckSeverity
  title: string
  detail: string
  recommendation: string
  count: number
  evidence: string[]
  manual?: boolean
}

function toRisk(module: { id: string; name: string }, draft: RiskDraft): ModuleRisk {
  return {
    id: `${module.id}:${draft.rule}`,
    moduleId: module.id,
    moduleName: module.name,
    rule: draft.rule,
    severity: draft.severity,
    title: draft.title,
    detail: draft.detail,
    recommendation: draft.recommendation,
    count: draft.count,
    evidence: draft.evidence.slice(0, 8),
    manual: draft.manual === true,
  }
}

function textLines(text: string): string[] {
  return text.split(/\r?\n/)
}

/**
 * 对一个模块执行全部规则。纯函数：同样的输入永远得到同样的输出。
 */
export function evaluateModule(input: {
  id: string
  name: string
  files: ModuleFileFact[]
}): ModuleRisk[] {
  const module = { id: input.id, name: input.name }
  const risks: ModuleRisk[] = []
  // 生成物与锁文件先摘掉：它们的变动不归人管，报出来也改不了。
  const files = input.files.filter((file) => !isGeneratedPath(file.path))
  // 没有任何代码或清单的目录（会话历史、缓存、素材）不是代码模块，不套规则。
  const hasManifest = files.some((file) => baseName(file.path) === 'package.json' && file.text)
  if (!hasManifest && !files.some((file) => isSourceFile(file.path))) {
    return []
  }

  // 1) 超大文件：拆分成本和 review 成本都随行数超线性上升。
  const oversized = files
    .filter((file) => file.lines > OVERSIZED_MEDIUM)
    .sort((a, b) => b.lines - a.lines)
  const worst = oversized[0]
  if (oversized.length > 0 && worst) {
    risks.push(
      toRisk(module, {
        rule: 'oversized-file',
        severity: worst.lines > OVERSIZED_HIGH ? 'high' : 'medium',
        title: `${oversized.length} 个文件超过 ${OVERSIZED_MEDIUM} 行`,
        detail: `最大的是 ${worst.path}（${worst.lines} 行）。单文件过大时，改动冲突面和单次阅读成本都会明显上升。`,
        recommendation:
          '按职责把大文件拆成协作更紧密的小文件；拆分前先确认有测试覆盖被移动的导出，避免把重构变成静默回归。',
        count: oversized.length,
        evidence: oversized.slice(0, 6).map((file) => `${file.path} (${file.lines} 行)`),
      }),
    )
  }

  // 2) TODO/FIXME 堆积：不是错误，但代表“已知未完成”。
  const todoHits: string[] = []
  let todoCount = 0
  for (const file of files) {
    if (!file.text) continue
    const lines = textLines(file.text)
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? ''
      // 只统计注释里、且写成 `TODO:` / `TODO(...)` 的标记：文档里提到 “TODO” 这个词
      // 不算待办，文本里的标记也不一定是人工维护的注释。
      const comment = commentIndex(line)
      if (comment < 0) continue
      const marker = TODO_LINE.exec(line.slice(comment))
      if (!marker) continue
      if (insideStringLiteral(line, comment + marker.index)) continue
      todoCount += 1
      if (todoHits.length < 8) todoHits.push(`${file.path}:${index + 1}`)
    }
  }
  if (todoCount >= TODO_THRESHOLD) {
    risks.push(
      toRisk(module, {
        rule: 'todo-backlog',
        severity: 'low',
        title: `${todoCount} 处 TODO/FIXME 标记`,
        detail: '这些标记是已知的未完成项，长期积压会让后来者无法判断哪些是待办、哪些是废弃注释。',
        recommendation: '逐条确认：能当场做完的改成真实任务并完成，已失效的直接删除，剩下的补一句「为什么先不做」。',
        count: todoCount,
        evidence: todoHits,
      }),
    )
  }

  // 3) 调试日志残留：会把内部状态写进用户日志，也可能泄漏路径与内容。
  const logHits: string[] = []
  let logCount = 0
  for (const file of files) {
    if (!file.text || isTestFile(file.path) || isCliEntry(file.path) || isServiceScript(file.path)) continue
    const lines = textLines(file.text)
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? ''
      const match = LOG_LINE.exec(line)
      if (!match) continue
      // 注释里提到 console.log 不算残留，字符串里的同样不算。
      if (insideStringLiteral(line, match.index)) continue
      const comment = commentIndex(line)
      if (comment >= 0 && match.index > comment) continue
      logCount += 1
      if (logHits.length < 8) logHits.push(`${file.path}:${index + 1}`)
    }
  }
  if (logCount > 0) {
    risks.push(
      toRisk(module, {
        rule: 'debug-logging',
        severity: 'low',
        title: `${logCount} 处 console.log/debug 残留`,
        detail: '生产代码里的调试输出会污染运行日志，并可能把文件路径、参数甚至凭据片段写进日志文件。',
        recommendation: '删除调试输出，或改成受日志级别控制的结构化日志；测试文件里的输出可以保留。',
        count: logCount,
        evidence: logHits,
      }),
    )
  }

  // 4) 缺测试：有实现但没有任何测试文件。
  const sourceFiles = files.filter((file) => isSourceFile(file.path) && !isTestFile(file.path))
  const testFiles = files.filter((file) => isTestFile(file.path))
  if (sourceFiles.length >= 8 && testFiles.length === 0) {
    risks.push(
      toRisk(module, {
        rule: 'missing-tests',
        severity: 'medium',
        title: `${sourceFiles.length} 个源文件没有任何测试`,
        detail: '这个模块的改动没有任何自动化验证兜底，回归只能靠人工发现。',
        recommendation: '先给纯逻辑和边界条件补最小单测（不追求覆盖率数字），再考虑重构。',
        count: sourceFiles.length,
        evidence: sourceFiles.slice(0, 6).map((file) => file.path),
      }),
    )
  }

  // 5) 硬编码绝对路径：换机器或换工作目录就失效。
  const pathHits: string[] = []
  let pathCount = 0
  for (const file of files) {
    if (!file.text) continue
    // 文档、文案、示例与测试夹具不承担“写死路径”的风险。
    if (/\.(md|txt)$/i.test(file.path) || isTestFile(file.path)) continue
    if (/(^|\/)locale[-.]/i.test(file.path)) continue
    const lines = textLines(file.text)
    for (let index = 0; index < lines.length; index += 1) {
      const raw = lines[index] ?? ''
      // 注释与占位符文本只是说明，不会在运行时把机器绑死。
      const comment = commentIndex(raw)
      if (comment >= 0) continue
      if (EXAMPLE_HINT.test(raw)) continue
      const line = stripUrls(raw)
      if (!WINDOWS_ABS_PATH.test(line) && !POSIX_HOME_PATH.test(line)) continue
      pathCount += 1
      if (pathHits.length < 8) pathHits.push(`${file.path}:${index + 1}`)
    }
  }
  if (pathCount > 0) {
    risks.push(
      toRisk(module, {
        rule: 'hardcoded-path',
        severity: 'medium',
        title: `${pathCount} 处硬编码绝对路径`,
        detail: '这些路径写死了本机目录，换机器、换用户名或换安装位置后就会失效。',
        recommendation: '改成相对工作区的路径，或从配置/环境变量读取；测试用临时目录。',
        count: pathCount,
        evidence: pathHits,
      }),
    )
  }

  // 6) 疑似凭据：只报位置，绝不回显命中的内容。
  const secretHits: string[] = []
  for (const file of files) {
    if (!file.text || isTestFile(file.path)) continue
    const lines = textLines(file.text)
    for (let index = 0; index < lines.length; index += 1) {
      if (!SECRET_SHAPES.some((shape) => shape.test(lines[index] ?? ''))) continue
      secretHits.push(`${file.path}:${index + 1}`)
      if (secretHits.length >= 8) break
    }
    if (secretHits.length >= 8) break
  }
  if (secretHits.length > 0) {
    risks.push(
      toRisk(module, {
        rule: 'secret-like',
        severity: 'high',
        title: `疑似凭据出现在源码中（${secretHits.length} 处）`,
        detail: '检测到形如 API Key / 访问令牌 / 私钥的内容。报告只记录位置，不回显原文。',
        recommendation:
          '确认后立刻吊销并轮换该凭据，然后从源码与 git 历史中移除。自检不会替你修改这类问题，必须人工处理。',
        count: secretHits.length,
        evidence: secretHits,
        manual: true,
      }),
    )
  }

  // 7) 完全重复的文件：同一份实现两份拷贝，改一份忘另一份。
  const groups = new Map<string, ModuleFileFact[]>()
  for (const file of files) {
    if (file.bytes < MIN_DUPLICATE_BYTES) continue
    const key = `${baseName(file.path)}:${file.bytes}`
    const group = groups.get(key)
    if (group) group.push(file)
    else groups.set(key, [file])
  }
  const duplicates = [...groups.values()].filter(
    (group) =>
      group.length > 1 &&
      new Set(group.map((file) => file.path.split('/').slice(0, -1).join('/'))).size > 1,
  )
  const first = duplicates[0]
  if (duplicates.length > 0 && first) {
    risks.push(
      toRisk(module, {
        rule: 'duplicate-file',
        severity: 'low',
        title: `${duplicates.length} 组同名同大小文件`,
        detail: `例如 ${first.map((file) => file.path).join('、')}。同名同大小通常意味着整份拷贝，两份实现容易各自演进。`,
        recommendation: '确认是否有一份是遗留拷贝；能合并就抽成单一实现，不能合并则注释清楚各自用途。',
        count: duplicates.length,
        evidence: first.map((file) => file.path),
      }),
    )
  }

  // 8) 缺少验证脚本：模块自己没法跑测试或类型检查。
  // 只看模块根目录的清单：子目录里的 package.json 往往是子包或测试夹具。
  const manifest = files
    .filter((file) => baseName(file.path) === 'package.json' && file.text)
    .sort((left, right) => left.path.split('/').length - right.path.split('/').length)[0]
  if (manifest?.text) {
    const scripts = readScripts(manifest.text)
    if (scripts && !scripts['test'] && !scripts['typecheck'] && !scripts['check']) {
      risks.push(
        toRisk(module, {
          rule: 'missing-verification-script',
          severity: 'medium',
          title: 'package.json 没有 test/typecheck 脚本',
          detail: '模块没有一键自检入口，CI 或改动者无法用统一命令验证它。',
          recommendation: '补一个 `test`（至少能跑通现有测试）和 `typecheck` 脚本，再决定是否接入 CI。',
          count: 1,
          evidence: [manifest.path],
        }),
      )
    }
  }

  return risks
}

function readScripts(text: string): Record<string, string> | null {
  try {
    const parsed = JSON.parse(text) as { scripts?: Record<string, string> }
    if (!parsed || typeof parsed !== 'object') return null
    return parsed.scripts ?? {}
  } catch {
    return null
  }
}

export function moduleCheckScore(risks: ModuleRisk[]): number {
  const penalty = risks.reduce((total, risk) => total + SEVERITY_WEIGHT[risk.severity], 0)
  return Math.max(0, Math.min(100, 100 - penalty))
}

export function sortRisks(risks: ModuleRisk[]): ModuleRisk[] {
  return [...risks].sort((left, right) => {
    const bySeverity = SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity]
    if (bySeverity !== 0) return bySeverity
    if (left.moduleName !== right.moduleName) return left.moduleName.localeCompare(right.moduleName)
    return left.rule.localeCompare(right.rule)
  })
}

export function buildReport(input: {
  id: string
  trigger: ModuleCheckTrigger
  workspace: string
  startedAt: string
  finishedAt: string
  targets: ModuleTarget[]
  risks: ModuleRisk[]
  scannedFiles: number
  scannedLines: number
}): ModuleCheckReport {
  const risks = sortRisks(input.risks)
  return {
    id: input.id,
    trigger: input.trigger,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    workspace: input.workspace,
    modules: input.targets.map((target) => target.id),
    targets: input.targets,
    risks,
    scannedFiles: input.scannedFiles,
    scannedLines: input.scannedLines,
    score: moduleCheckScore(risks),
  }
}

export function severityLabel(severity: ModuleCheckSeverity): string {
  if (severity === 'high') return '高'
  if (severity === 'medium') return '中'
  return '低'
}

export function ruleLabel(rule: ModuleRuleId): string {
  switch (rule) {
    case 'oversized-file':
      return '超大文件'
    case 'todo-backlog':
      return '待办积压'
    case 'debug-logging':
      return '调试输出'
    case 'missing-tests':
      return '缺少测试'
    case 'hardcoded-path':
      return '硬编码路径'
    case 'secret-like':
      return '疑似凭据'
    case 'duplicate-file':
      return '重复文件'
    case 'missing-verification-script':
      return '缺少验证脚本'
    default:
      return rule
  }
}

/**
 * 把用户勾选的风险点写成一份可审阅的改造指令。
 *
 * 它只是文本：默认用于提案预览，只有用户显式勾选「自改」后才成为编码会话的
 * 首条指令。刻意写得像人写的任务：先复述验收标准，再逐条列出，最后要求给出
 * 验证命令，这样真的执行时仍然受普通沙箱与审批策略约束。
 */
export function buildOptimizePrompt(report: ModuleCheckReport, risks: ModuleRisk[]): string {
  const accepted = sortRisks(risks).filter((risk) => !risk.manual)
  const manual = sortRisks(risks).filter((risk) => risk.manual)
  const lines: string[] = [
    '你在执行「模块自检」中用户已确认的优化项。',
    '',
    `自检得分：${report.score}/100（报告 ${report.id}，扫描 ${report.scannedFiles} 个文件）。`,
    '',
    '原则：只改下列已确认的问题，不要顺手重构无关代码；每处改动都要能说明为什么安全。',
    '',
    '已确认的优化项：',
  ]
  accepted.forEach((risk, index) => {
    lines.push(
      `${index + 1}. [${risk.moduleName}] ${risk.title}`,
      `   位置：${risk.evidence.join('；')}`,
      `   建议：${risk.recommendation}`,
    )
  })
  if (manual.length > 0) {
    lines.push(
      '',
      '以下问题自检已标记为需要人工处理，不要自动修改，只在回复里说明你确认到的事实：',
      ...manual.map((risk) => `- [${risk.moduleName}] ${risk.title}（${risk.evidence.join('；')}）`),
    )
  }
  lines.push(
    '',
    '完成标准：',
    '- 每项改动后运行对应的单测或类型检查，并在最终回复里贴出命令与结果。',
    '- 若某项无法安全完成，停下来说明原因，不要为了“做完”而降低正确性。',
  )
  return lines.join('\n')
}

/**
 * 生成改造提案。
 *
 * 这是自检/内视唯一会「留下」的产物：一份可阅读的提案文本 + 清单。
 * 生成它不写任何源码文件，也不开会话。
 */
export function buildProposal(input: {
  id: string
  report: ModuleCheckReport
  risks: ModuleRisk[]
  createdAt: string
  selfModify: boolean
  sessionId?: string
}): ModuleProposal {
  const proposal: ModuleProposal = {
    id: input.id,
    reportId: input.report.id,
    createdAt: input.createdAt,
    workspace: input.report.workspace,
    riskIds: input.risks.map((risk) => risk.id),
    prompt: buildOptimizePrompt(input.report, input.risks),
    selfModify: input.selfModify,
  }
  if (input.sessionId) proposal.sessionId = input.sessionId
  return proposal
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function sanitizeTarget(value: unknown): ModuleTarget | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const id = asString(record['id'])
  const path = asString(record['path'])
  if (!id || !path) return null
  const numeric = (key: string): number => {
    const raw = record[key]
    return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? Math.round(raw) : 0
  }
  return {
    id,
    name: asString(record['name']) ?? id,
    path,
    files: numeric('files'),
    sourceFiles: numeric('sourceFiles'),
    testFiles: numeric('testFiles'),
    lines: numeric('lines'),
  }
}

function sanitizeRisk(value: unknown): ModuleRisk | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const rule = asString(record['rule']) as ModuleRuleId | null
  const severity = asString(record['severity']) as ModuleCheckSeverity | null
  if (!rule || !severity || !(severity in SEVERITY_ORDER)) return null
  const moduleId = asString(record['moduleId']) ?? 'module'
  return {
    id: asString(record['id']) ?? `${moduleId}:${rule}`,
    moduleId,
    moduleName: asString(record['moduleName']) ?? moduleId,
    rule,
    severity,
    title: asString(record['title']) ?? ruleLabel(rule),
    detail: asString(record['detail']) ?? '',
    recommendation: asString(record['recommendation']) ?? '',
    count: typeof record['count'] === 'number' && record['count'] > 0 ? Math.round(record['count']) : 1,
    evidence: Array.isArray(record['evidence'])
      ? record['evidence'].filter((item): item is string => typeof item === 'string').slice(0, 8)
      : [],
    manual: record['manual'] === true,
  }
}

export function sanitizeReport(value: unknown): ModuleCheckReport | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const id = asString(record['id'])
  const workspace = asString(record['workspace'])
  const startedAt = asString(record['startedAt'])
  const finishedAt = asString(record['finishedAt'])
  if (!id || !workspace || !startedAt || !finishedAt) return null
  const targets = Array.isArray(record['targets'])
    ? record['targets']
        .map(sanitizeTarget)
        .filter((target): target is ModuleTarget => target !== null)
    : []
  const risks = Array.isArray(record['risks'])
    ? record['risks'].map(sanitizeRisk).filter((risk): risk is ModuleRisk => risk !== null)
    : []
  const trigger: ModuleCheckTrigger =
    record['trigger'] === 'schedule'
      ? 'schedule'
      : record['trigger'] === 'self-modify'
        ? 'self-modify'
        : 'manual'
  const numeric = (key: string): number => {
    const raw = record[key]
    return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? Math.round(raw) : 0
  }
  return {
    id,
    trigger,
    startedAt,
    finishedAt,
    workspace,
    modules: Array.isArray(record['modules'])
      ? record['modules'].filter((item): item is string => typeof item === 'string')
      : targets.map((target) => target.id),
    targets,
    risks: sortRisks(risks),
    scannedFiles: numeric('scannedFiles'),
    scannedLines: numeric('scannedLines'),
    score: Math.max(0, Math.min(100, typeof record['score'] === 'number' ? Math.round(record['score']) : 100)),
  }
}

export function sanitizeProposal(value: unknown): ModuleProposal | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const id = asString(record['id'])
  const reportId = asString(record['reportId'])
  const createdAt = asString(record['createdAt'])
  const workspace = asString(record['workspace'])
  if (!id || !reportId || !createdAt || !workspace) return null
  const proposal: ModuleProposal = {
    id,
    reportId,
    createdAt,
    workspace,
    riskIds: Array.isArray(record['riskIds'])
      ? record['riskIds'].filter((item): item is string => typeof item === 'string').slice(0, 200)
      : [],
    // 提案里的指令只是一段待审阅文本，除了长度别的不做加工。
    prompt: typeof record['prompt'] === 'string' ? record['prompt'].slice(0, 20_000) : '',
    selfModify: record['selfModify'] === true,
  }
  const sessionId = asString(record['sessionId'])
  if (sessionId) proposal.sessionId = sessionId
  const refreshedAt = asString(record['refreshedAt'])
  if (refreshedAt) proposal.refreshedAt = refreshedAt
  return proposal
}

export function sanitizeSettings(value: unknown): ModuleCheckSettings {
  if (!value || typeof value !== 'object') return { ...DEFAULT_MODULE_CHECK_SETTINGS }
  const record = value as Record<string, unknown>
  const interval = typeof record['intervalHours'] === 'number' && Number.isFinite(record['intervalHours'])
    ? Math.max(1, Math.min(24 * 30, Math.round(record['intervalHours'])))
    : DEFAULT_MODULE_CHECK_SETTINGS.intervalHours
  return {
    enabled: record['enabled'] === true,
    intervalHours: interval,
    modules: Array.isArray(record['modules'])
      ? record['modules'].filter((item): item is string => typeof item === 'string').slice(0, 200)
      : [],
  }
}

/** 从磁盘读到的东西不可信：任何字段不合法都退回默认值，而不是抛错。 */
export function sanitizeModuleCheckState(value: unknown): ModuleCheckState {
  if (!value || typeof value !== 'object') {
    return { settings: { ...DEFAULT_MODULE_CHECK_SETTINGS }, history: [], decisions: [], proposals: [] }
  }
  const record = value as Record<string, unknown>
  const history = Array.isArray(record['history'])
    ? record['history']
        .map(sanitizeReport)
        .filter((report): report is ModuleCheckReport => report !== null)
        .slice(0, MODULE_CHECK_HISTORY_LIMIT)
    : []
  const decisions: ModuleCheckDecision[] = Array.isArray(record['decisions'])
    ? (record['decisions'] as unknown[])
        .map((item) => {
          if (!item || typeof item !== 'object') return null
          const entry = item as Record<string, unknown>
          const reportId = asString(entry['reportId'])
          const at = asString(entry['at'])
          if (!reportId || !at) return null
          // 旧版本一定带 sessionId；新版本只生成提案时它为空。
          const sessionId = asString(entry['sessionId'])
          const decision: ModuleCheckDecision = {
            reportId,
            at,
            selfModify: entry['selfModify'] === true || (!('selfModify' in entry) && Boolean(sessionId)),
            riskIds: Array.isArray(entry['riskIds'])
              ? entry['riskIds'].filter((id): id is string => typeof id === 'string')
              : [],
          }
          if (sessionId) decision.sessionId = sessionId
          const proposalId = asString(entry['proposalId'])
          if (proposalId) decision.proposalId = proposalId
          return decision
        })
        .filter((entry): entry is ModuleCheckDecision => entry !== null)
        .slice(0, MODULE_CHECK_HISTORY_LIMIT)
    : []
  const proposals = Array.isArray(record['proposals'])
    ? record['proposals']
        .map(sanitizeProposal)
        .filter((proposal): proposal is ModuleProposal => proposal !== null)
        .slice(0, MODULE_PROPOSAL_LIMIT)
    : []
  const state: ModuleCheckState = {
    settings: sanitizeSettings(record['settings']),
    history,
    decisions,
    proposals,
  }
  const lastRunAt = asString(record['lastRunAt'])
  if (lastRunAt) state.lastRunAt = lastRunAt
  const nextRunAt = asString(record['nextRunAt'])
  if (nextRunAt) state.nextRunAt = nextRunAt
  const lastReport = sanitizeReport(record['lastReport'])
  if (lastReport) state.lastReport = lastReport
  else if (history.length > 0) state.lastReport = history[0]
  return state
}
