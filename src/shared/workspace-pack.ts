/**
 * 工作区导出包（.pilotpack.zip）的格式定义与纯校验逻辑。
 *
 * 这里只放**不依赖 Electron / 文件系统**的东西：包内布局常量、勾选范围、
 * manifest 结构、密钥载荷结构、路径安全校验与工作区路径重映射。打包与解包在
 * `src/main/workspace-pack.ts`，两端共用这一份定义，避免写进包里的字段名漂移。
 *
 * 包内布局：
 *
 *   manifest.json                       包说明：格式、版本、时间、范围、计数
 *   pilot-data/pilot-core.json          设置 / 工作区记录 / 定时任务 / 快速指令
 *   pilot-data/secrets.json             密钥明文（仅在勾选「密钥」时存在）
 *   pilot-data/sessions/<id>.json       会话元数据（含待办、队列、计划）
 *   pilot-data/sessions/<id>.messages.jsonl
 *   pilot-data/checkpoints/…            检查点快照（可选）
 *   workspace/…                         工作区文件（可选）
 *
 * 密钥在包里是**明文**：safeStorage 只在写入本机时才加密，跨机器没有可用的
 * 解密钥，所以导出必须解出来、导入必须重新加密。明文只存在于这个包里，
 * 导入成功后立即删除临时解包目录，并把「包里有明文密钥」的确认交给用户。
 */

export const WORKSPACE_PACK_FORMAT = 'pilot-workspace-pack'
/** 包格式版本。读到更高版本时拒绝导入，而不是猜字段。 */
export const WORKSPACE_PACK_VERSION = 1
export const WORKSPACE_PACK_EXT = 'pilotpack.zip'

export const PACK_MANIFEST_FILE = 'manifest.json'
export const PACK_DATA_DIR = 'pilot-data'
export const PACK_CORE_FILE = `${PACK_DATA_DIR}/pilot-core.json`
export const PACK_SECRETS_FILE = `${PACK_DATA_DIR}/secrets.json`
export const PACK_SESSIONS_DIR = `${PACK_DATA_DIR}/sessions`
export const PACK_CHECKPOINTS_DIR = `${PACK_DATA_DIR}/checkpoints`
export const PACK_FILES_DIR = 'workspace'

/** 单个文件上限：超过它的工作区文件不打包，只在结果里报告跳过。 */
export const PACK_MAX_FILE_BYTES = 64 * 1024 * 1024
/** 打进来的文件数上限，防止误选一个巨大的目录把磁盘写满。 */
export const PACK_MAX_FILES = 20_000
/** 解包后的总字节上限（防 zip 炸弹）。 */
export const PACK_MAX_UNPACKED_BYTES = 2 * 1024 * 1024 * 1024

/**
 * 导出/导入的范围。默认全选：用户点「导出」时最想要的是「整台机器复制过去」。
 */
export interface WorkspacePackScope {
  /** 设置：模型端点、审批模式、通知、反思、主题等（不含密钥本身）。 */
  settings: boolean
  /** 密钥：模型 API Key、SMTP 授权码、测试验证码。依赖 `settings`。 */
  secrets: boolean
  /** 会话：列表、全部消息、待办、计划、评审报告、定时任务。 */
  sessions: boolean
  /** 工作区文件（按 `.git`/`node_modules` 等排除规则跳过目录）。 */
  files: boolean
  /** 检查点快照：可以让导入端回退到导出时的文件状态。 */
  checkpoints: boolean
}

export const DEFAULT_PACK_SCOPE: WorkspacePackScope = {
  settings: true,
  secrets: true,
  sessions: true,
  files: true,
  checkpoints: false,
}

/**
 * 收窄外部传入的范围。
 *
 * 密钥跟着设置走：没有设置就没有地方放密钥，所以 `secrets` 在 `settings`
 * 为假时被强制关掉，而不是留一个「勾了但不生效」的状态。
 */
export function normalizePackScope(input: unknown): WorkspacePackScope {
  const record = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const flag = (key: keyof WorkspacePackScope): boolean =>
    typeof record[key] === 'boolean' ? (record[key] as boolean) : DEFAULT_PACK_SCOPE[key]
  const settings = flag('settings')
  return {
    settings,
    secrets: settings && flag('secrets'),
    sessions: flag('sessions'),
    files: flag('files'),
    checkpoints: flag('checkpoints'),
  }
}

/** 勾选了至少一项才有意义；一项都没勾时界面直接禁用按钮。 */
export function scopeIsEmpty(scope: WorkspacePackScope): boolean {
  return !scope.settings && !scope.sessions && !scope.files && !scope.checkpoints
}

export interface WorkspacePackCounts {
  files: number
  fileBytes: number
  skippedFiles: number
  sessions: number
  messages: number
  todos: number
  scheduled: number
  checkpoints: number
}

export const EMPTY_PACK_COUNTS: WorkspacePackCounts = {
  files: 0,
  fileBytes: 0,
  skippedFiles: 0,
  sessions: 0,
  messages: 0,
  todos: 0,
  scheduled: 0,
  checkpoints: 0,
}

export interface WorkspacePackManifest {
  format: typeof WORKSPACE_PACK_FORMAT
  version: number
  createdAt: string
  /** 导出端的应用版本，只用于提示「来自更新/更旧的客户端」。 */
  appVersion: string
  /** 导出端操作系统，路径分隔符不同时导入端会重映射。 */
  platform: string
  workspace: { path: string; name: string }
  scope: WorkspacePackScope
  counts: WorkspacePackCounts
  /** 等于 `scope.secrets`；导入界面据此显示「此包含密钥」。 */
  includesSecrets: boolean
  /** 导出端的主机名，仅用于让用户认出这个包是哪台机器导出的。 */
  origin: string
}

/**
 * 校验一个 manifest。格式名不对、版本高于本端、缺少工作区信息都返回 null：
 * 宁可拒绝，也不要按猜出来的结构往用户目录里写东西。
 */
export function parseWorkspacePackManifest(value: unknown): WorkspacePackManifest | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (record['format'] !== WORKSPACE_PACK_FORMAT) return null
  const version = typeof record['version'] === 'number' ? record['version'] : 0
  if (!Number.isFinite(version) || version < 1 || version > WORKSPACE_PACK_VERSION) return null
  const workspace = record['workspace']
  if (!workspace || typeof workspace !== 'object') return null
  const ws = workspace as Record<string, unknown>
  const path = typeof ws['path'] === 'string' ? ws['path'].trim() : ''
  const name = typeof ws['name'] === 'string' ? ws['name'].trim() : ''
  if (!path && !name) return null
  const counts = (record['counts'] && typeof record['counts'] === 'object'
    ? record['counts']
    : {}) as Record<string, unknown>
  const count = (key: keyof WorkspacePackCounts): number => {
    const raw = counts[key]
    return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0
  }
  return {
    format: WORKSPACE_PACK_FORMAT,
    version,
    createdAt: typeof record['createdAt'] === 'string' ? record['createdAt'] : '',
    appVersion: typeof record['appVersion'] === 'string' ? record['appVersion'] : '',
    platform: typeof record['platform'] === 'string' ? record['platform'] : '',
    workspace: { path, name: name || basenameish(path) || 'workspace' },
    scope: normalizePackScope(record['scope']),
    counts: {
      files: count('files'),
      fileBytes: count('fileBytes'),
      skippedFiles: count('skippedFiles'),
      sessions: count('sessions'),
      messages: count('messages'),
      todos: count('todos'),
      scheduled: count('scheduled'),
      checkpoints: count('checkpoints'),
    },
    includesSecrets: record['includesSecrets'] === true,
    origin: typeof record['origin'] === 'string' ? record['origin'] : '',
  }
}

/** 包内密钥载荷：明文，只在这个包里存在。空值一律不写入。 */
export interface WorkspaceSecrets {
  version: number
  /** 模型通道 id → API Key。 */
  modelResources: Record<string, string>
  /** 旧版评审通道 id → API Key（只为兼容更旧的客户端）。 */
  judgeProviders: Record<string, string>
  testCaptcha: string | null
  smtpPassword: string | null
  /** 旧版单通道镜像。 */
  apiKey: string | null
}

const SECRET_MAX_CHARS = 8_192

export function emptyWorkspaceSecrets(): WorkspaceSecrets {
  return {
    version: WORKSPACE_PACK_VERSION,
    modelResources: {},
    judgeProviders: {},
    testCaptcha: null,
    smtpPassword: null,
    apiKey: null,
  }
}

function secretOf(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > SECRET_MAX_CHARS) return null
  return trimmed
}

function secretMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const id = key.trim()
    const secret = secretOf(raw)
    if (!id || !secret || id.length > 128) continue
    out[id] = secret
  }
  return out
}

/** 收窄包里的密钥载荷：丢弃空值、超长值与非法结构。 */
export function sanitizeWorkspaceSecrets(value: unknown): WorkspaceSecrets {
  const record = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  return {
    version: WORKSPACE_PACK_VERSION,
    modelResources: secretMap(record['modelResources']),
    judgeProviders: secretMap(record['judgeProviders']),
    testCaptcha: secretOf(record['testCaptcha']),
    smtpPassword: secretOf(record['smtpPassword']),
    apiKey: secretOf(record['apiKey']),
  }
}

/** 密钥条目总数，用于在界面和结果里显示「带出 N 个密钥」。 */
export function countWorkspaceSecrets(secrets: WorkspaceSecrets): number {
  let total =
    Object.keys(secrets.modelResources).length +
    Object.keys(secrets.judgeProviders).length
  if (secrets.testCaptcha) total += 1
  if (secrets.smtpPassword) total += 1
  if (secrets.apiKey) total += 1
  return total
}

export function workspaceSecretsIsEmpty(secrets: WorkspaceSecrets): boolean {
  return countWorkspaceSecrets(secrets) === 0
}

/** 包文件名：`<工作区名>-pilotpack-20260101-1530.zip`，非法字符换成 `-`。 */
export function packFileName(workspaceName: string, at: Date = new Date()): string {
  const safe =
    (workspaceName || 'workspace')
      .replace(/[\\/:*?"<>|\r\n\t]+/g, '-')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'workspace'
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp =
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}`
  return `${safe}-pilotpack-${stamp}.zip`
}

function basenameish(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

/**
 * 包内条目路径是否安全。
 *
 * 拒绝绝对路径、盘符、`..` 段与反斜杠，确保解包只会在临时目录里发生；
 * 导入端写工作区文件时还会再拼一次沙箱校验，这里只是第一道闸。
 */
export function isSafePackEntryPath(entry: string): boolean {
  if (!entry || entry.length > 1_024) return false
  if (entry.includes('\\')) return false
  if (entry.startsWith('/') || entry.startsWith('~')) return false
  if (/^[A-Za-z]:/.test(entry)) return false
  if (entry.endsWith('/')) return false
  return entry.split('/').every((segment) => segment && segment !== '.' && segment !== '..')
}

/** 包内某个工作区文件的条目名。 */
export function packFilePath(relative: string): string {
  return `${PACK_FILES_DIR}/${relative.replace(/^\/+/, '')}`
}

/**
 * 把导出的工作区路径换成导入端的路径。
 *
 * 会话、定时任务、工作区记录里都有绝对路径，只改其中一处会留下指向旧机器的
 * 死路径，所以统一由这一个函数处理。
 */
export function remapWorkspacePath<T extends { workspacePath: string }>(
  item: T,
  from: string,
  to: string,
): T {
  return { ...item, workspacePath: item.workspacePath === from ? to : item.workspacePath }
}

export interface WorkspacePackExportResult {
  /** 写出的 zip 路径；用户取消时为 null。 */
  path: string | null
  manifest: WorkspacePackManifest | null
  /** 包里带出去的密钥条数（`scope.secrets` 为假时是 0）。 */
  secretCount: number
}

export interface WorkspacePackImportResult {
  ok: boolean
  /** 新建/复用的工作区绝对路径。 */
  workspacePath: string | null
  workspaceName: string | null
  manifest: WorkspacePackManifest | null
  sessions: number
  messages: number
  todos: number
  scheduled: number
  files: number
  fileBytes: number
  checkpoints: number
  /** 从包里恢复并重新加密的密钥条数。 */
  secretsApplied: number
  settingsApplied: boolean
  /** 用户取消选择文件/目录。 */
  cancelled: boolean
  warnings: string[]
  error?: string
}
