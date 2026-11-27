/**
 * 诊断包：把「内视、最近日志、版本 / 平台 / 沙箱」整理成一组可以发给别人的文本文件。
 *
 * 三条硬边界：
 * 1. 纯函数：不 import electron，也不碰 `node:fs`，单测能直接调用；
 * 2. 任何进入包里的字符串先过 `redactDiagnosticText`——用户目录、应用数据目录、
 *    工作区绝对路径换成占位符，凭据形状的串换成 `<redacted>`，敏感键名连键名本身
 *    都改写成 `api-key` / `口令`，这样对整包 grep `sk-` / `apiKey` / `password`
 *    都搜不到东西；
 * 3. 只收元数据：不含会话正文、命令输出、提示词与密钥。导出与否由用户决定，
 *    打包进程本身不上传任何内容。
 */
import { formatSelfCheckStamp, renderSelfCheckText, type SelfCheckReport } from './self-check'
import { formatBytes } from './system-info'

const HOME_TAG = '<home>'
const USER_DATA_TAG = '<userData>'
const WORKSPACE_TAG = '<workspace>'
const APP_DIR_TAG = '<appDir>'
const USER_TAG = '<user>'

export interface DiagnosticsRedactionScope {
  /** 当前用户主目录，例如 `C:\Users\alice` 或 `/home/alice`。 */
  home?: string | null
  /** 应用数据目录；比 home 更具体，因此先替换。 */
  userData?: string | null
  /** 其他要打码的绝对路径：工作区、日志目录等。 */
  paths?: readonly string[]
  /**
   * Pilot 自身的安装 / 源码目录。
   *
   * 必须单独打码：内视报告的「程序目录」和 super-pilot 日志里的 `workspace`
   * 记的都是这个路径，而它既不是 home、也不是 userData，更不在用户工作区清单里，
   * 不列出来就会把 `E:\code\...\pilot\pilot` 这种带项目名的绝对路径整段带出去。
   */
  appDir?: string | null
}

export interface DiagnosticsSandbox {
  mode: string
  available: boolean
  backend: string
  detail: string
  networkIsolation: boolean
}

export interface DiagnosticsEnvironment {
  version: string
  /** 例如 `win32 10.0.22631`。 */
  platform: string
  arch: string
  packaged: boolean
  locale: string
  electron: string
  node: string
  chrome: string
  cpuCount?: number
  cpuModel?: string
  memoryFreeBytes?: number | null
  memoryTotalBytes?: number | null
}

/** 日志记录的最小形状：`main/app-log.ts` 的 `AppLogRecord` 结构上满足它。 */
export interface DiagnosticsLogRecord {
  at: string
  area: string
  event: string
  level?: string
  detail?: Record<string, unknown>
}

export interface DiagnosticsBundleInput {
  generatedAt: Date
  environment: DiagnosticsEnvironment
  sandbox: DiagnosticsSandbox | null
  selfCheck: SelfCheckReport | null
  /** 内视没跑成功时的原因；成功时忽略。 */
  selfCheckError?: string
  logs: readonly DiagnosticsLogRecord[]
  /** 日志目录，按 `paths` 打码后写进 environment.json。 */
  logDir: string
  workspaces: readonly string[]
  scope: DiagnosticsRedactionScope
}

export interface DiagnosticsFile {
  /** zip 内的相对路径。 */
  name: string
  text: string
}

/** 导出结果：主进程写盘后回给渲染层，用来显示「写了几个文件」或提示原因。 */
export interface DiagnosticsExportResult {
  ok: boolean
  /** 用户点了取消：不是错误，界面应当静默。 */
  cancelled: boolean
  /** 落盘路径；只用于显示，渲染层不拿它拼命令。 */
  path: string | null
  files: number
  logLines: number
  bytes: number
  /** 脱敏自检仍命中的模式名；非空即拒绝写盘。 */
  blocked: string[]
  error?: string
}

/**
 * 导出结果该怎么展示。
 *
 * 抽成纯函数是为了让「取消不报错」成为可测试的规则而不是界面里的一行 if：
 * 用户自己点了取消却弹出红色错误提示，是这类功能最常见的体验缺陷。
 */
export type DiagnosticsExportOutcome =
  | { kind: 'silent' }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; files: number; logLines: number; bytes: number }

export function diagnosticsExportOutcome(
  result: DiagnosticsExportResult | null | undefined,
): DiagnosticsExportOutcome {
  if (!result) return { kind: 'error', message: '导出没有返回结果' }
  if (result.cancelled) return { kind: 'silent' }
  if (!result.ok) {
    const reason = result.error?.trim()
    if (reason) return { kind: 'error', message: reason }
    const blocked = result.blocked.filter(Boolean)
    return {
      kind: 'error',
      message: blocked.length > 0 ? `脱敏自检未通过：${blocked.join('、')}` : '导出失败',
    }
  }
  return { kind: 'ok', files: result.files, logLines: result.logLines, bytes: result.bytes }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 同一路径的多种写法：原样、正斜杠、反斜杠、JSON 转义后的双反斜杠、去掉结尾分隔符。
 * 日志里这三种都会出现（Windows 原生路径、拼出来的 URL、`JSON.stringify` 后的记录）。
 */
function pathVariants(path: string): string[] {
  const trimmed = path.trim()
  if (!trimmed) return []
  const variants = new Set<string>([trimmed])
  variants.add(trimmed.replace(/\\/g, '/'))
  variants.add(trimmed.replace(/\//g, '\\'))
  variants.add(JSON.stringify(trimmed).slice(1, -1))
  for (const value of [...variants]) variants.add(value.replace(/[\\/]+$/, ''))
  return [...variants].filter((value) => value.length > 2)
}

function replacePaths(text: string, scope: DiagnosticsRedactionScope): string {
  const targets: Array<{ path: string; tag: string }> = []
  if (scope.userData) targets.push({ path: scope.userData, tag: USER_DATA_TAG })
  if (scope.home) targets.push({ path: scope.home, tag: HOME_TAG })
  if (scope.appDir) targets.push({ path: scope.appDir, tag: APP_DIR_TAG })
  for (const path of scope.paths ?? []) targets.push({ path, tag: WORKSPACE_TAG })

  const ordered = targets
    .flatMap((target) => pathVariants(target.path).map((value) => ({ value, tag: target.tag })))
    // 长的先替换：应用数据目录通常在 home 下面，先换掉才能留下更具体的标签。
    .sort((left, right) => right.value.length - left.value.length)

  let out = text
  for (const { value, tag } of ordered) {
    out = out.replace(new RegExp(escapeRegExp(value), 'gi'), tag)
  }
  return out
}

/**
 * 敏感键名换成中文占位。
 *
 * 为什么不是改写成 `api-key` 这类英文别名：口径是对整包 grep `sk-` / `apiKey` /
 * `password` 零命中，而任何英文别名（`api-key`、`passwd`）都会在更宽松的 grep
 * （`-i` 或 `api[_-]?key`）下再次命中，还会被本文件的 `scanForSecrets` 当成未清理的
 * 凭据、把导出永久拦下。中文占位同时保留了「这里原本有一个敏感字段」的信息。
 */
const KEY_LABELS: ReadonlyArray<readonly [RegExp, string]> = [
  [/api[\s_-]?key/i, '<密钥>'],
  [/pass(?:word|wd|phrase)/i, '<口令>'],
  [/token/i, '<令牌>'],
  [/secret|credential|authorization|cookie/i, '<凭据>'],
]

function keyLabel(key: string): string {
  for (const [pattern, label] of KEY_LABELS) if (pattern.test(key)) return label
  return '<凭据>'
}

/** 明确的凭据键：键名与值一起替换，短口令也不放过。 */
const SECRET_KEY_ASSIGN =
  /(["']?)(api[\s_-]?key|pass(?:word|wd|phrase)|secret|credential|authorization|cookie)(["']?)(\s*[:=]\s*)(["']?)([^\s"',;) }\]]+)/gi

/** `token` 也常存凭据，但日志里还有 token 计数，只打码看起来像凭据的长值。 */
const TOKEN_KEY_ASSIGN =
  /(["']?)\b(token)\b(["']?)(\s*[:=]\s*)(["']?)([^\s"',;) }\]]{8,})/gi

/** 不带值出现的裸敏感键名：同样换成占位，保证整包零命中。 */
const BARE_KEY_REWRITES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bapi[\s_-]?key\b/gi, '<密钥>'],
  [/\bpass(?:word|wd|phrase)\b/gi, '<口令>'],
  [/\bsecret\b|\bcredential\b|\bauthorization\b|\bcookie\b/gi, '<凭据>'],
]

/** 形状本身就能认出的凭据：与 `main/agent/redact.ts` 同一张表，多几种前缀。 */
const CREDENTIAL_PATTERNS: ReadonlyArray<readonly [string, string]> = [
  ['sk', '\\bsk-[A-Za-z0-9_-]{8,}'],
  ['github', '\\bgh[pousr]_[A-Za-z0-9]{12,}'],
  ['slack', '\\bxox[abprs]-[A-Za-z0-9-]{8,}'],
  ['aws', '\\bAKIA[0-9A-Z]{12,}'],
  ['private-key', '-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----'],
  ['dsn', "secret:\\/\\/[^\\s\"']+"],
  ['bearer', '\\bBearer\\s+[A-Za-z0-9._\\-+/=]{12,}'],
  ['jwt', '\\beyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{6,}'],
]

/**
 * 打码一个字符串：路径 → 占位符，凭据 → `<redacted>`。
 *
 * 顺序有意义：先换长路径（否则 `C:\Users\alice` 会先吃掉应用数据目录），再连同键名
 * 一起替换敏感键值，最后用凭据形状与裸键名兜底。
 */
export function redactDiagnosticText(text: string, scope: DiagnosticsRedactionScope = {}): string {
  let out = replacePaths(text, scope)

  // 用户名可能以裸形式出现在路径之外（URL、命令行片段），长度 >=3 才替换，
  // 并用前后非标识符字符兜住，避免把 `development` 这类词打成 `<user>elopment`。
  const homeBase = (scope.home ?? '').split(/[\\/]/).filter(Boolean).pop()
  if (homeBase && homeBase.length >= 3) {
    out = out.replace(new RegExp(`(?<![\\w.-])${escapeRegExp(homeBase)}(?![\\w.-])`, 'gi'), USER_TAG)
  }

  out = out.replace(
    SECRET_KEY_ASSIGN,
    (_match, q1: string, key: string, q2: string, separator: string, q3: string) =>
      `${q1}${keyLabel(key)}${q2}${separator}${q3}<redacted>`,
  )
  out = out.replace(
    TOKEN_KEY_ASSIGN,
    (_match, q1: string, key: string, q2: string, separator: string, q3: string) =>
      `${q1}${keyLabel(key)}${q2}${separator}${q3}<redacted>`,
  )
  for (const [, source] of CREDENTIAL_PATTERNS) out = out.replace(new RegExp(source, 'g'), '<redacted>')
  for (const [pattern, replacement] of BARE_KEY_REWRITES) out = out.replace(pattern, replacement)

  return out
}

/** 键名是否属于「值一定要打码」的敏感字段（结构化打码用，不依赖引号与分隔符）。 */
function isSensitiveKey(key: string): boolean {
  return (
    /api[\s_-]?key|pass(?:word|wd|phrase)|secret|credential|authorization|cookie/i.test(key) ||
    /^token$/i.test(key)
  )
}

/**
 * 结构化打码：用于 JSON 类产物。
 *
 * 为什么不能只对 `JSON.stringify` 后的文本跑正则：替换键名会顺手吃掉引号，
 * 产物就不是合法 JSON 了（日志要能被别人 `JSON.parse` 才能算证据）。这里在对象层
 * 改键名、打码值，序列化后仍然是合法 JSON。
 */
export function redactDiagnosticValue(value: unknown, scope: DiagnosticsRedactionScope = {}): unknown {
  if (typeof value === 'string') return redactDiagnosticText(value, scope)
  if (Array.isArray(value)) return value.map((item) => redactDiagnosticValue(item, scope))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(key)) {
        out[keyLabel(key)] = '<redacted>'
        continue
      }
      out[redactDiagnosticText(key, scope)] = redactDiagnosticValue(inner, scope)
    }
    return out
  }
  return value
}

/**
 * 导出前的最后一道闸：对已打码的文本再扫一遍，返回仍然命中的模式名。
 *
 * 非空说明有某类凭据没被上面的规则覆盖——此时调用方必须拒绝写盘，而不是
 * 把「可能泄漏」的文件交给用户去发送。
 */
export function scanForSecrets(text: string): string[] {
  const hits: string[] = []
  if (/\bsk-[A-Za-z0-9_-]{8,}/.test(text)) hits.push('sk-...')
  if (/api[\s_-]?key/i.test(text)) hits.push('api key')
  if (/pass(?:word|wd|phrase)/i.test(text)) hits.push('password')
  for (const [name, source] of CREDENTIAL_PATTERNS) {
    if (name === 'sk') continue
    if (new RegExp(source).test(text)) hits.push(name)
  }
  return hits
}

/** zip 文件名：`Pilot-diagnostics-20261126-1504.zip`。 */
export function diagnosticsFileName(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `Pilot-diagnostics-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours(),
  )}${pad(date.getMinutes())}.zip`
}

function buildSummary(input: DiagnosticsBundleInput): string {
  const env = input.environment
  const errorCount = input.logs.filter((record) => record.level === 'error').length
  const warnCount = input.logs.filter((record) => record.level === 'warn').length
  const sandbox = input.sandbox
  const counts = input.selfCheck?.counts

  return [
    `Pilot 诊断包 · ${formatSelfCheckStamp(input.generatedAt.getTime())}`,
    `版本 ${env.version}${env.packaged ? '（打包版）' : '（开发版）'} · 平台 ${env.platform} · 架构 ${env.arch} · 语言 ${env.locale}`,
    `运行时 Electron ${env.electron} · Node ${env.node} · Chromium ${env.chrome}`,
    `内存 ${formatBytes(env.memoryFreeBytes ?? null)} 可用 / ${formatBytes(env.memoryTotalBytes ?? null)}`,
    sandbox
      ? `沙箱 ${sandbox.available ? `已启用（${sandbox.backend}）` : `未启用（${sandbox.backend}）`}${sandbox.networkIsolation ? ' · 可隔离网络' : ''}：${sandbox.detail}`
      : '沙箱 未采集',
    input.selfCheck && counts
      ? `内视 正常 ${counts.ok} · 注意 ${counts.warn} · 未启用 ${counts.off} · 异常 ${counts.broken}（用时 ${input.selfCheck.durationMs} ms）`
      : `内视 未完成：${input.selfCheckError ?? '未知原因'}`,
    `日志 最近 ${input.logs.length} 条（错误 ${errorCount} · 警告 ${warnCount}）`,
    `工作区 ${input.workspaces.length} 个（路径已打码）`,
    '',
    '已脱敏：用户目录 → <home>，应用数据目录 → <userData>，工作区与日志目录 → <workspace>，Pilot 自身目录 → <appDir>，用户名 → <user>，凭据 → <redacted>。',
    '不含：会话正文、命令输出、提示词与密钥。发送前请自行打开确认。',
  ].join('\n')
}

const README_TEXT = [
  'Pilot 诊断包',
  '',
  '文件说明：',
  '- summary.txt         一页总览：版本、平台、运行时、沙箱、内视计数、日志条数',
  '- environment.json    机器与运行时事实（不含主机名、用户名、IP、MAC、序列号）',
  '- self-check.txt      内视报告的可读文本（复制全文用的同一份）',
  '- self-check.json     内视报告的结构化副本，便于脚本比对',
  '- runtime-log.jsonl   最近若干条运行日志，每行一个 JSON 对象',
  '',
  '已做脱敏：',
  '- 用户目录 <home>、应用数据目录 <userData>、工作区与日志目录 <workspace>、Pilot 自身目录 <appDir>、用户名 <user>',
  '- 凭据形状的串与敏感键值一律 <redacted>，敏感键名改写成 <密钥> / <口令> / <令牌> / <凭据>',
  '',
  '不含：会话正文、命令输出、提示词与密钥。',
  '这个包由你在本地生成，Pilot 不会自动上传。发给谁、发多少由你决定。',
].join('\n')

/**
 * 生成诊断包内的全部文件（尚未压缩）。
 *
 * 每个文本都过一遍 `redactDiagnosticText`，返回前再逐文件 `scanForSecrets`；
 * 仍有命中时把模式名放进 `blocked`，由调用方拒绝写盘。
 */
export function buildDiagnosticsBundle(input: DiagnosticsBundleInput): {
  files: DiagnosticsFile[]
  logLines: number
  blocked: string[]
} {
  const redact = (text: string): string => redactDiagnosticText(text, input.scope)

  const environment = {
    generatedAt: input.generatedAt.toISOString(),
    app: {
      version: input.environment.version,
      packaged: input.environment.packaged,
      locale: input.environment.locale,
    },
    platform: {
      os: input.environment.platform,
      arch: input.environment.arch,
      electron: input.environment.electron,
      node: input.environment.node,
      chrome: input.environment.chrome,
    },
    hardware: {
      cpuCount: input.environment.cpuCount ?? null,
      cpuModel: input.environment.cpuModel ?? null,
      memoryFreeBytes: input.environment.memoryFreeBytes ?? null,
      memoryTotalBytes: input.environment.memoryTotalBytes ?? null,
    },
    sandbox: input.sandbox
      ? {
          mode: input.sandbox.mode,
          available: input.sandbox.available,
          backend: input.sandbox.backend,
          networkIsolation: input.sandbox.networkIsolation,
          detail: input.sandbox.detail,
        }
      : null,
    logDir: input.logDir,
    workspaces: [...input.workspaces],
  }

  const logLines = input.logs.map((record) =>
    JSON.stringify(
      redactDiagnosticValue(
        {
          at: record.at,
          area: record.area,
          event: record.event,
          level: record.level ?? 'info',
          ...(record.detail ? { detail: record.detail } : {}),
        },
        input.scope,
      ),
    ),
  )

  const selfCheckText = input.selfCheck
    ? renderSelfCheckText(input.selfCheck)
    : `内视未完成：${input.selfCheckError ?? '未知原因'}`

  const files: DiagnosticsFile[] = [
    { name: 'README.txt', text: README_TEXT },
    { name: 'summary.txt', text: redact(buildSummary(input)) },
    { name: 'environment.json', text: JSON.stringify(redactDiagnosticValue(environment, input.scope), null, 2) },
    { name: 'self-check.txt', text: redact(selfCheckText) },
    {
      name: 'self-check.json',
      text: JSON.stringify(
        redactDiagnosticValue(input.selfCheck ?? { error: selfCheckText }, input.scope),
        null,
        2,
      ),
    },
    { name: 'runtime-log.jsonl', text: redact(logLines.join('\n')) },
  ]

  const blocked = new Set<string>()
  for (const file of files) for (const hit of scanForSecrets(file.text)) blocked.add(hit)

  return { files, logLines: logLines.length, blocked: [...blocked] }
}
