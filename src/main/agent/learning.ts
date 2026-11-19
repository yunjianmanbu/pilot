/**
 * 自主探索学习（learning mode）的守门层与账本。
 *
 * 这一层只做三件事，全部是可以在单测里断言的纯逻辑或纯文件读写：
 *  1. 出域守门：只允许对白名单主机发 GET/HEAD，拒绝一切会携带请求体的动词、
 *     带账号口令的 URL、以及本机/内网/链路本地/云元数据地址；
 *  2. shell 侧的兜底：识别会向域外发送内容的命令（curl -d、git push、sco、
 *     npm publish、docker push、云存储同步……），学习探索开启时直接拒绝；
 *  3. 学习账本：把「来源 → 任务 → 阶段成果与用户裁决」写成工作区内的 JSONL，
 *     再汇总成可复盘的统计与焦点建议，供后续迭代与自我优化使用。
 *
 * 所有产物都留在工作区 `.pilot/learning/` 下，不上传、不外发。
 */
import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const LEARNING_DIR = '.pilot/learning'
export const LEARNING_SOURCES_DIR = '.pilot/learning/sources'
export const LEARNING_LEDGER_FILE = '.pilot/learning/ledger.jsonl'

/**
 * 默认来源白名单：公开文档、公开规范与公开 issue 追踪。默认只读；
 * 用户可在设置里增删，条目写成裸主机名，子域自动包含。
 */
export const DEFAULT_LEARNING_HOSTS: readonly string[] = [
  'developer.mozilla.org',
  'nodejs.org',
  'docs.python.org',
  'doc.rust-lang.org',
  'docs.rs',
  'pkg.go.dev',
  'learn.microsoft.com',
  'kubernetes.io',
  'react.dev',
  'vuejs.org',
  'docs.npmjs.com',
  'arxiv.org',
  'api.github.com',
]

export const DEFAULT_MAX_SOURCE_BYTES = 512 * 1024

export interface LearningPolicy {
  /** 用户显式打开后才为 true；关闭时任何网络读取都被拒绝。 */
  enabled: boolean
  /** 允许读取的主机；条目是裸主机名，子域自动命中。 */
  hosts: string[]
  /** 单个来源落盘上限，超过即截断。 */
  maxSourceBytes: number
}

function normalizeHostEntry(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
}

export const MAX_LEARNING_HOSTS = 50

// 裸主机名：字母数字与连字符组成的标签，点号分隔。手机端提交的白名单会进入
// 系统提示词，必须在这里卡死形状，不能让换行、空格或通配符混进去。
const LEARNING_HOST_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/**
 * 把手机端提交的白名单整理成可直接落库的主机名。
 *
 * 和 `resolveLearningPolicy` 不同，这里对无效条目直接报错而不是静默丢掉：
 * 用户在手机上看到「保存成功」却少了一个站点，比明确拒绝更难排查。
 * 本机与内网地址也在这里拒绝，因为出域守门永远不会放行它们。
 */
export function normalizeLearningHostsInput(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  const hosts: string[] = []
  for (const value of values) {
    if (typeof value !== 'string') continue
    const raw = value.trim()
    if (!raw) continue
    const normalized = normalizeHostEntry(raw)
    if (!LEARNING_HOST_PATTERN.test(normalized)) {
      throw new Error(`学习来源白名单包含无效主机：${raw.slice(0, 120)}`)
    }
    if (isLocalHost(normalized)) {
      throw new Error(`学习来源白名单不能包含本机或内网地址：${normalized}`)
    }
    if (!hosts.includes(normalized)) hosts.push(normalized)
    if (hosts.length > MAX_LEARNING_HOSTS) {
      throw new Error(`学习来源白名单最多 ${MAX_LEARNING_HOSTS} 个主机`)
    }
  }
  return hosts
}

export function resolveLearningPolicy(raw: {
  learningMode?: unknown
  learningHosts?: unknown
}): LearningPolicy {
  const hosts = Array.isArray(raw.learningHosts)
    ? raw.learningHosts
        .filter((value): value is string => typeof value === 'string')
        .map(normalizeHostEntry)
        .filter((value) => value.length > 0)
    : []
  return {
    enabled: raw.learningMode === true,
    hosts: hosts.length > 0 ? [...new Set(hosts)] : [...DEFAULT_LEARNING_HOSTS],
    maxSourceBytes: DEFAULT_MAX_SOURCE_BYTES,
  }
}

/* ------------------------------------------------------------------ *
 * 出域守门
 * ------------------------------------------------------------------ */

export interface EgressVerdict {
  ok: boolean
  /** 拒绝原因（面向用户与模型的中文说明）；通过时为空串。 */
  reason: string
}

const LOCAL_NAMES = new Set(['localhost', 'ip6-localhost', 'ip6-loopback'])
const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.lan', '.intranet']

function ipv4Octets(host: string): number[] | null {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  const octets: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const value = Number(part)
    if (value > 255) return null
    octets.push(value)
  }
  return octets
}

function isPrivateIpv4(octets: number[]): boolean {
  const a = octets[0]
  const b = octets[1]
  if (a === undefined || b === undefined) return true
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a >= 224) return true
  return false
}

function isPrivateIpv6(host: string): boolean {
  const value = host.toLowerCase()
  if (!value.includes(':')) return false
  if (value === '::' || value === '::1') return true
  if (value.startsWith('fc') || value.startsWith('fd')) return true
  if (value.startsWith('fe80')) return true
  if (value.startsWith('::ffff:')) {
    const octets = ipv4Octets(value.slice('::ffff:'.length))
    return octets === null ? true : isPrivateIpv4(octets)
  }
  return false
}

/** 本机、内网、链路本地与云元数据地址一律算「域内」，不允许作为学习来源。 */
export function isLocalHost(host: string): boolean {
  const bare = host
    .trim()
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/\.$/, '')
  if (bare.length === 0) return true
  if (LOCAL_NAMES.has(bare)) return true
  if (LOCAL_SUFFIXES.some((suffix) => bare.endsWith(suffix))) return true
  const octets = ipv4Octets(bare)
  if (octets) return isPrivateIpv4(octets)
  return isPrivateIpv6(bare)
}

/**
 * 学习探索唯一被允许的出站形态：对白名单主机的 GET/HEAD。
 * 任何会携带请求体的动词、任何带账号口令的 URL、任何内网地址都在这里被拒绝。
 */
export function checkEgress(
  rawUrl: string,
  method: string,
  policy: LearningPolicy,
): EgressVerdict {
  if (!policy.enabled) {
    return { ok: false, reason: '学习探索没有开启：网络读取默认关闭，请先在设置里打开。' }
  }
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { ok: false, reason: `URL 无法解析：${rawUrl.slice(0, 200)}` }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `只允许 http/https，收到 ${url.protocol}` }
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'URL 里不允许携带账号或口令' }
  }
  const verb = method.trim().toUpperCase() || 'GET'
  if (verb !== 'GET' && verb !== 'HEAD') {
    return {
      ok: false,
      reason: `学习探索只读：拒绝 ${verb}，任何内容都不会被上传或提交。`,
    }
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (isLocalHost(host)) {
    return { ok: false, reason: `拒绝访问本机或内网地址：${host}` }
  }
  const allowed = policy.hosts.some((entry) => host === entry || host.endsWith(`.${entry}`))
  if (!allowed) {
    return {
      ok: false,
      reason: `主机 ${host} 不在学习来源白名单里（当前白名单：${policy.hosts.join(', ') || '空'}）`,
    }
  }
  return { ok: true, reason: '' }
}

/**
 * 学习探索期间是否要让 shell 沙箱断网。
 *
 * 默认不断：任务会话的联网只由用户自己的 `sandboxNetwork` 决定，学习模式的
 * 白名单（`learning_research` 的 GET/HEAD 限制）只约束探索本身。只有用户显式
 * 打开“学习探索期间 shell 断网”时，学习模式才会关掉沙箱网络，作为文本匹配之外
 * 的第二层兜底。
 */
export function sandboxNetworkFor(
  policy: LearningPolicy | null,
  requested: boolean,
  isolateShell = false,
): boolean {
  return policy?.enabled === true && isolateShell ? false : requested
}

export interface UploadVector {
  vector: string
  hint: string
}

interface UploadVectorRule {
  vector: string
  hint: string
  test: RegExp
}

const UPLOAD_VECTORS: readonly UploadVectorRule[] = [
  {
    vector: 'curl-upload',
    hint: 'curl 正在携带请求体或上传文件',
    test: /\bcurl\b[^\n]*(--upload-file|\s-T\s|--data\b|\s-d\s|--data-raw|--data-binary|--form\b|\s-F\s|-X\s*(?:POST|PUT|PATCH|DELETE))/i,
  },
  {
    vector: 'wget-upload',
    hint: 'wget 正在提交表单或文件',
    test: /\bwget\b[^\n]*(--post-data|--post-file|--method)/i,
  },
  {
    vector: 'remote-copy',
    hint: 'scp/sftp/rsync 可以把文件复制到域外',
    test: /\b(scp|sftp|rsync)\b/i,
  },
  {
    vector: 'git-push',
    hint: 'git push 会把工作区内容推到远端',
    test: /\bgit\s+(push|send-email|request-pull)\b/i,
  },
  {
    vector: 'gh-cli',
    hint: 'gh 可以创建 PR/issue/release，等于外发',
    test: /\bgh\s+(pr|issue|release|api|repo|gist)\b/i,
  },
  {
    vector: 'package-publish',
    hint: '发布软件包等于上传产物',
    test: /\b(npm|pnpm|yarn|cargo|dotnet|nuget)\s+publish\b|\bnpm\s+deprecate\b/i,
  },
  {
    vector: 'image-push',
    hint: '镜像推送会把产物推到远端仓库',
    test: /\b(docker|podman)\s+(push|login)\b/i,
  },
  {
    vector: 'cloud-sync',
    hint: '云存储同步会外发文件',
    test: /\baws\s+s3\s+(cp|sync|mv)\b|\bgsutil\s+(cp|rsync|mv)\b|\baz\s+storage\s+blob\s+upload\b/i,
  },
  {
    vector: 'raw-socket',
    hint: '裸 socket 工具可以任意外发字节',
    test: /\b(nc|ncat|netcat|socat|telnet|lftp)\b|(^|\s)ftp(\s|$)/i,
  },
  {
    vector: 'infra-apply',
    hint: '基础设施 apply 会把状态与产物推到云端',
    test: /\bterraform\s+(apply|push)\b|\bpulumi\s+up\b/i,
  },
]

/**
 * 识别一条 shell 命令里是否含有「向域外发送内容」的意图。
 * 学习探索开启时命中即拒绝——这是「产物不出域」在 shell 侧的兜底。
 */
export function detectUploadVector(command: string): UploadVector | null {
  const line = command.trim()
  if (line.length === 0) return null
  for (const candidate of UPLOAD_VECTORS) {
    if (candidate.test.test(line)) return { vector: candidate.vector, hint: candidate.hint }
  }
  return null
}

/* ------------------------------------------------------------------ *
 * 网络读取（只读、限量、落盘到工作区）
 * ------------------------------------------------------------------ */

const TEXTUAL_TYPES = ['text/', 'application/json', 'application/xml', 'application/xhtml']
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 3

export interface LearningSourceRecord {
  id: string
  url: string
  host: string
  /** 相对工作区根的落盘路径。 */
  path: string
  bytes: number
  truncated: boolean
  contentType: string
  excerpt: string
  fetchedAt: string
}

export interface LearningFetchOptions {
  root: string
  url: string
  policy: LearningPolicy
  /** 测试注入点；默认用全局 fetch。 */
  fetchImpl?: typeof fetch
  maxBytes?: number
}

async function readCapped(
  response: Response,
  cap: number,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const body = response.body
  if (!body) return { text: '', bytes: 0, truncated: false }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    if (bytes + value.byteLength > cap) {
      const room = cap - bytes
      if (room > 0) chunks.push(value.subarray(0, room))
      bytes = cap
      truncated = true
      await reader.cancel().catch(() => undefined)
      break
    }
    bytes += value.byteLength
    chunks.push(value)
  }
  const merged = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return {
    text: new TextDecoder('utf-8', { fatal: false }).decode(merged),
    bytes,
    truncated,
  }
}

function excerptOf(text: string, limit = 1200): string {
  const collapsed = text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim()
  return collapsed.length > limit ? `${collapsed.slice(0, limit)}…` : collapsed
}

function sourceFileName(url: string): string {
  return `${createHash('sha1').update(url).digest('hex').slice(0, 12)}.txt`
}

/**
 * 读取一个白名单来源并落盘到 `.pilot/learning/sources/`。
 * 重定向逐跳重新过守门，所以 302 到内网地址同样会被拒绝。
 */
export async function fetchLearningSource(
  options: LearningFetchOptions,
): Promise<LearningSourceRecord> {
  const doFetch = options.fetchImpl ?? fetch
  const cap = Math.max(
    1024,
    Math.min(options.maxBytes ?? options.policy.maxSourceBytes, options.policy.maxSourceBytes),
  )
  let target = options.url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const verdict = checkEgress(target, 'GET', options.policy)
    if (!verdict.ok) throw new Error(`出域守门拒绝：${verdict.reason}`)
    const response = await doFetch(target, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        accept: 'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8',
        'user-agent': 'PilotLearning/1.0 (read-only research; no uploads)',
      },
    })
    if (REDIRECT_CODES.has(response.status)) {
      const location = response.headers.get('location')
      if (!location) throw new Error(`HTTP ${response.status} 没有 Location 头`)
      target = new URL(location, target).toString()
      continue
    }
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
    const textual = contentType.length === 0 || TEXTUAL_TYPES.some((type) => contentType.includes(type))
    if (!textual) throw new Error(`拒绝保存非文本资源：${contentType || 'unknown'}`)
    const { text, bytes, truncated } = await readCapped(response, cap)
    const fetchedAt = new Date().toISOString()
    const path = `${LEARNING_SOURCES_DIR}/${sourceFileName(target)}`
    const header = [
      `# source: ${target}`,
      `# fetched: ${fetchedAt}`,
      `# bytes: ${bytes}${truncated ? ' (truncated)' : ''}`,
      '# note: read-only copy stored inside the workspace; never uploaded',
      '',
    ].join('\n')
    await mkdir(dirname(join(options.root, path)), { recursive: true })
    await writeFile(join(options.root, path), `${header}${text}`, 'utf8')
    return {
      id: `source-${createHash('sha1').update(target).digest('hex').slice(0, 12)}`,
      url: target,
      host: new URL(target).hostname.toLowerCase(),
      path,
      bytes,
      truncated,
      contentType: contentType || 'unknown',
      excerpt: excerptOf(text),
      fetchedAt,
    }
  }
  throw new Error(`重定向超过 ${MAX_REDIRECTS} 次，已放弃`)
}

/* ------------------------------------------------------------------ *
 * 学习账本
 * ------------------------------------------------------------------ */

export type LearningEntryKind = 'source' | 'task' | 'outcome'
export type LearningVerdict = 'approved' | 'rejected' | 'pending'

export interface LearningEntry {
  at: string
  kind: LearningEntryKind
  id: string
  /** source */
  url?: string
  path?: string
  host?: string
  bytes?: number
  /** task */
  title?: string
  goal?: string
  sourceId?: string
  /** outcome */
  taskId?: string
  verdict?: LearningVerdict
  /** 0..1，用户或评审模型对这次阶段成果的打分。 */
  quality?: number
  note?: string
}

export function learningLedgerPath(root: string): string {
  return join(root, LEARNING_DIR, 'ledger.jsonl')
}

function newEntryId(kind: LearningEntryKind): string {
  const stamp = Date.now().toString(36)
  const salt = Math.random().toString(36).slice(2, 6)
  return `${kind}-${stamp}-${salt}`
}

export async function appendLearningEntry(
  root: string,
  entry: Omit<LearningEntry, 'at' | 'id'> & { at?: string; id?: string },
): Promise<LearningEntry> {
  const record: LearningEntry = {
    ...entry,
    at: entry.at ?? new Date().toISOString(),
    id: entry.id ?? newEntryId(entry.kind),
  }
  await mkdir(join(root, LEARNING_DIR), { recursive: true })
  await appendFile(learningLedgerPath(root), `${JSON.stringify(record)}\n`, 'utf8')
  return record
}

export async function readLearningLedger(root: string): Promise<LearningEntry[]> {
  let raw: string
  try {
    raw = await readFile(learningLedgerPath(root), 'utf8')
  } catch {
    return []
  }
  const entries: LearningEntry[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      const parsed = JSON.parse(trimmed) as LearningEntry
      if (parsed && typeof parsed === 'object' && typeof parsed.kind === 'string') entries.push(parsed)
    } catch {
      // 跳过坏行：一行写坏不应该让整个账本不可读。
    }
  }
  return entries
}

export interface LearningSummary {
  sources: number
  tasks: number
  outcomes: number
  approved: number
  rejected: number
  pending: number
  /** approved / (approved + rejected)；没有裁决过时为 0。 */
  approvalRate: number
  /** 有打分结果的均值（0..1）；没有打分时为 0。 */
  averageQuality: number
  /** 还没有结果记录的任务数。 */
  openTasks: number
  hosts: Array<{ host: string; sources: number }>
  /** 「把自己作为优化对象」用的焦点建议，最多 4 条。 */
  focus: string[]
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

export function summarizeLearning(entries: LearningEntry[]): LearningSummary {
  let sources = 0
  let tasks = 0
  let outcomes = 0
  let approved = 0
  let rejected = 0
  let pending = 0
  let qualityTotal = 0
  let qualityCount = 0
  const hostCounts = new Map<string, number>()
  const taskIds = new Set<string>()
  const decidedTasks = new Set<string>()

  for (const entry of entries) {
    if (entry.kind === 'source') {
      sources += 1
      const host = entry.host ?? (entry.url ? safeHost(entry.url) : '')
      if (host) hostCounts.set(host, (hostCounts.get(host) ?? 0) + 1)
      continue
    }
    if (entry.kind === 'task') {
      tasks += 1
      if (entry.id) taskIds.add(entry.id)
      continue
    }
    outcomes += 1
    if (entry.verdict === 'approved') approved += 1
    else if (entry.verdict === 'rejected') rejected += 1
    else pending += 1
    if (entry.verdict === 'approved' || entry.verdict === 'rejected') {
      if (entry.taskId) decidedTasks.add(entry.taskId)
    }
    if (typeof entry.quality === 'number' && Number.isFinite(entry.quality)) {
      qualityTotal += Math.max(0, Math.min(1, entry.quality))
      qualityCount += 1
    }
  }

  const decided = approved + rejected
  let openTasks = 0
  for (const id of taskIds) if (!decidedTasks.has(id)) openTasks += 1

  const hosts = [...hostCounts.entries()]
    .map(([host, count]) => ({ host, sources: count }))
    .sort((a, b) => b.sources - a.sources || a.host.localeCompare(b.host))

  const focus: string[] = []
  if (openTasks > 0) {
    focus.push(`${openTasks} 个探索任务还没有阶段成果裁决：先收尾再开新任务。`)
  }
  if (pending > 0) {
    focus.push(`${pending} 个阶段成果在等用户裁决：把待审清单交给用户，不要自行视为通过。`)
  }
  if (decided >= 3 && approved / decided < 0.6) {
    focus.push(
      `近期通过率 ${(approved / decided * 100).toFixed(0)}%（${approved}/${decided}）：先复盘被拒原因，再扩大探索范围。`,
    )
  }
  if (qualityCount >= 3 && qualityTotal / qualityCount < 0.7) {
    focus.push(
      `近期成果质量均值 ${(qualityTotal / qualityCount).toFixed(2)}：把可复用的做法写成工作区 skill 或工具，而不是重复手工步骤。`,
    )
  }
  if (sources === 0 && tasks > 0) {
    focus.push('有任务但没有任何来源记录：先 learning_research 留证，再动手。')
  }
  if (sources > 0 && hosts.length === 1) {
    focus.push(`来源只集中在 ${hosts[0]?.host ?? '单一站点'}：交叉验证至少再取一个来源。`)
  }

  return {
    sources,
    tasks,
    outcomes,
    approved,
    rejected,
    pending,
    approvalRate: decided > 0 ? approved / decided : 0,
    averageQuality: qualityCount > 0 ? qualityTotal / qualityCount : 0,
    openTasks,
    hosts,
    focus: focus.slice(0, 4),
  }
}
