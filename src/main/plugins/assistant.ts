import { existsSync } from 'node:fs'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type {
  PluginDraftInstallInput,
  PluginDraftInstallResult,
  PluginDraftMessage,
  PluginDraftView,
  PluginRouteView,
} from '../../shared/types'
import { readSignaturePolicy } from './integrity'
import {
  MAX_PLUGINS,
  PLUGIN_MANIFEST_FILE,
  parsePluginManifest,
  type PluginManifest,
} from './manifest'
import {
  assertPluginId,
  pluginDirFor,
  pluginOverview,
  pluginsRoot,
  setPluginEnabled,
  signInstalledPlugin,
} from './studio'

/**
 * 对话式插件制作：把「我要一个 X 插件」变成可校验的 plugin.json + index.mjs。
 *
 * 三条边界：
 * 1. 模型只产出草稿，不落盘；落盘是用户点「写入并启用」后的独立动作，并且
 *    落盘时重新走 parsePluginManifest，渲染层传回来的内容一律不可信。
 * 2. 草稿必须过两道闸：清单走宿主的 parsePluginManifest（与运行时同一份校验），
 *    入口代码做协议级检查（ESM、必须处理 activate/request、stdout 只写协议行）。
 *    第一轮不过就把错误回喂给模型，最多两轮，不无限重试烧额度。
 * 3. 插件目录固定为 `<workspace>/.pilot/plugins/<id>`；不写工作区外路径，
 *    id 与目录名由 assertPluginId/pluginDirFor 双重约束。
 */

export const MAX_DRAFT_PROMPT_CHARS = 4_000
export const MAX_DRAFT_HISTORY = 12
export const MAX_DRAFT_HISTORY_CHARS = 4_000
export const MAX_DRAFT_ENTRY_CHARS = 200_000
export const DRAFT_TIMEOUT_MS = 180_000
/** 第一轮不合格时回喂一次错误；两次都不合格就交回用户。 */
const MAX_ATTEMPTS = 2
/** 生成代码会占掉大部分输出配额，留足够空间避免被截断。 */
export const DRAFT_MAX_OUTPUT_TOKENS = 8_000

export interface DraftMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** 一次补全调用。`DeepSeekClient.complete` 在外面包一层就能满足。 */
export type DraftCompletion = (
  messages: DraftMessage[],
  signal: AbortSignal,
) => Promise<string>

export interface DraftPluginOptions {
  prompt: string
  history?: PluginDraftMessage[]
  /** 用户建议的 id；模型可以自己选，冲突时会在 warnings 里说明。 */
  id?: string
}

export interface DraftPluginDeps {
  complete: DraftCompletion
  /** Workspace used only to detect id clashes; no writes happen here. */
  workspace?: string
  modelLabel?: string
}

const ENTRY_SKELETON = String.raw`#!/usr/bin/env node
/**
 * Pilot plugin entry. stdout carries protocol replies only; a stray console.log
 * corrupts the JSON-RPC stream the host reads.
 */
import { mkdir } from 'node:fs/promises'

let stateDir = process.env.PILOT_PLUGIN_STATE_DIR || '.'

async function activate(params) {
  if (params && typeof params.stateDir === 'string') stateDir = params.stateDir
  await mkdir(stateDir, { recursive: true })
  return { ok: true }
}

async function request(params) {
  const route = params.route || {}
  const body = params.body || {}
  if (route.path === 'hello' && route.method === 'GET') {
    return { status: 200, body: { ok: true } }
  }
  return { status: 404, body: { error: 'unknown route' } }
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (line.trim()) void handle(line)
  }
})

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: id, result: result }) + '\n')
}

function replyError(id, code, message) {
  process.stdout.write(
    JSON.stringify({ jsonrpc: '2.0', id: id, error: { code: code, message: message } }) + '\n',
  )
}

async function handle(line) {
  let message = null
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (!message || typeof message !== 'object') return
  const params = message.params && typeof message.params === 'object' ? message.params : {}
  try {
    if (message.method === 'plugin.activate') return reply(message.id, await activate(params))
    if (message.method === 'plugin.session') return reply(message.id, null)
    if (message.method === 'plugin.request') return reply(message.id, await request(params))
    if (message.method === 'plugin.deactivate') return reply(message.id, { ok: true })
    replyError(message.id, 404, 'unknown method ' + String(message.method))
  } catch (error) {
    replyError(message.id, -32000, String((error && error.message) || error))
  }
}
`

const SYSTEM_PROMPT = `你是 Pilot 桌面端的插件工程师。用户描述业务需求，你产出一个可以直接放进
<workspace>/.pilot/plugins/<id>/ 运行的插件（plugin.json + index.mjs）。

只输出一个 JSON 对象，不要 Markdown 围栏，不要任何额外说明。结构固定为：
{"reply": "给用户看的中文说明（2-4 句，讲清做了什么、路由和权限）",
 "manifest": { ...plugin.json 内容... },
 "entry": "index.mjs 的完整源码，用 \\n 换行"}

## 宿主契约（写错就会被拒绝加载）
- manifest.api 必须是 1，runtime 必须是 "node"，entry 必须是 "index.mjs"。
- id 必须是 2-32 位小写字母、数字或短横线，且以字母开头；name 是展示名（2-60 字符）。
- permissions 形如 "items:read"、"orders:write"；通配只能用 "items:*"。最多 32 条。
- routes 最多 24 条，path 只能是单段小写（health、items、sync），不能写 "a/b"。
- 每条 route：method 为 GET/POST/PUT/DELETE，auth 为 "public" 或 "required"，
  permission 为 null 或 permissions 里声明的某一项，description 一句话。
- provides 只有在插件要充当登录/身份提供者时才写 "session"，否则省略或 null。
- limits.timeoutMs 默认 5000（200-60000）；请求体默认 64KB。

## 入口进程协议
- 宿主用 node 启动入口，通过 stdin 逐行发 JSON-RPC，通过 stdout 逐行收结果。
  绝不能往 stdout 写日志；调试信息写 stderr。
- 必须处理四个方法：plugin.activate（握手，带 params.api / params.plugin / params.stateDir /
  params.workspaceRoot）、plugin.request（params.route / params.method / params.body /
  params.query / params.session）、plugin.session（不提供身份就返回 null）、plugin.deactivate。
- plugin.request 必须返回 {status, body}；status 用 200/201/400/404 这类 HTTP 语义。
- 只用 Node 内置模块（node:fs/promises、node:path 等），不要第三方依赖，不要 require()。
- 持久化只写 process.env.PILOT_PLUGIN_STATE_DIR（或 activate 给的 stateDir），
  不要写工作区源码目录。单次请求要在 5 秒内返回。
- permission 只在宿主侧校验：入口里不需要也不应该自己再拼一套鉴权。

## 入口骨架（照此结构实现，把 request() 换成真实业务）
\`\`\`
${ENTRY_SKELETON}\`\`\``

/** 只保留合法的对话轮次，并把每条裁剪到上限，避免把整段聊天塞进提示词。 */
function sanitizeHistory(history: PluginDraftMessage[] | undefined): PluginDraftMessage[] {
  if (!Array.isArray(history)) return []
  return history
    .filter((item): item is PluginDraftMessage =>
      Boolean(item) && (item.role === 'user' || item.role === 'assistant'),
    )
    .map((item) => ({
      role: item.role,
      content: String(item.content ?? '').slice(0, MAX_DRAFT_HISTORY_CHARS),
    }))
    .filter((item) => item.content.trim().length > 0)
    .slice(-MAX_DRAFT_HISTORY)
}

export function buildDraftMessages(input: DraftPluginOptions): DraftMessage[] {
  const prompt = String(input.prompt ?? '').trim()
  if (!prompt) throw new Error('请先描述你想要的插件')
  if (prompt.length > MAX_DRAFT_PROMPT_CHARS) {
    throw new Error(`需求描述太长了（${prompt.length} > ${MAX_DRAFT_PROMPT_CHARS} 字符）`)
  }
  const messages: DraftMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }]
  for (const item of sanitizeHistory(input.history)) {
    messages.push({ role: item.role, content: item.content })
  }
  const idHint = String(input.id ?? '').trim()
  const hint = idHint ? `\n如果合适，请使用插件 id「${idHint}」。` : ''
  messages.push({ role: 'user', content: `需求：${prompt}${hint}` })
  return messages
}

/** 剥掉 ```json 围栏与前后解释性文字，再取最外层 JSON 对象。 */
export function parseDraftResponse(content: string): {
  reply: string
  manifest: unknown
  entry: string
} {
  const text = String(content ?? '').trim()
  if (!text) throw new Error('模型返回了空内容')
  let candidate = text
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const inner = fenced?.[1]?.trim() ?? ''
  if (inner) candidate = inner
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型输出里没有 JSON 对象')
  let parsed: unknown
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`模型输出的 JSON 无法解析：${reason}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('模型输出的根节点不是对象')
  }
  const record = parsed as Record<string, unknown>
  const manifest = record['manifest']
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('缺少 manifest 字段')
  }
  let entry = record['entry']
  // 少数模型会把 entry 写成数组或对象，这里统一成文本并给出明确报错。
  if (typeof entry !== 'string') {
    if (Array.isArray(entry)) entry = entry.join('\n')
    else throw new Error('缺少 entry 源码字段')
  }
  return {
    reply: typeof record['reply'] === 'string' ? record['reply'].trim() : '',
    manifest,
    entry: String(entry),
  }
}

/** 入口代码的协议级检查；返回问题列表，空数组表示可用。 */
export function inspectDraftEntry(code: string): string[] {
  const text = String(code ?? '')
  const problems: string[] = []
  if (!text.trim()) return ['入口源码是空的']
  if (text.length > MAX_DRAFT_ENTRY_CHARS) {
    problems.push(`入口源码超过 ${MAX_DRAFT_ENTRY_CHARS} 字符`)
  }
  if (/\brequire\s*\(/.test(text)) {
    problems.push('入口必须是 ESM，不能用 require()')
  }
  if (!text.includes('plugin.activate')) {
    problems.push('入口没有处理 plugin.activate 握手，宿主会激活超时')
  }
  if (!text.includes('plugin.request')) {
    problems.push('入口没有处理 plugin.request，任何路由调用都会超时')
  }
  if (!text.includes('process.stdout.write')) {
    problems.push('入口没有写回协议响应（process.stdout.write）')
  }
  return problems
}

/** 统一换行并保证文件以换行结尾，避免打印/签名时的字节漂移。 */
function normalizeEntry(code: string): string {
  const text = String(code ?? '').replace(/\r\n?/g, '\n')
  return text.endsWith('\n') ? text : `${text}\n`
}

function slug(value: unknown): string {
  const text = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  return /^[a-z][a-z0-9-]{1,31}$/.test(text) ? text : ''
}

export interface ValidatedDraft {
  manifest: PluginManifest
  manifestJson: string
  entry: string
  warnings: string[]
}

/**
 * 用宿主自己的 parsePluginManifest 校验草稿，并做两处温和归一化：
 * id 变成合法 slug、entry 一律落到 index.mjs。其余字段不做修正——模型写错的
 * 权限、路由、api 版本应该暴露出来，而不是被悄悄改掉。
 */
export function validateDraft(
  parsed: { reply: string; manifest: unknown; entry: string },
  idHint?: string,
): ValidatedDraft {
  const warnings: string[] = []
  const raw = { ...(parsed.manifest as Record<string, unknown>) }
  const wantedId = slug(raw['id']) || slug(idHint)
  if (!wantedId) throw new Error('manifest.id 不合法：需要 2-32 位小写字母、数字或短横线')
  if (String(raw['id'] ?? '') !== wantedId) {
    warnings.push(`插件 id 已规范化为「${wantedId}」`)
  }
  raw['id'] = wantedId
  if (raw['entry'] !== undefined && raw['entry'] !== 'index.mjs') {
    warnings.push('入口文件统一写作 index.mjs')
  }
  raw['entry'] = 'index.mjs'
  const manifest = parsePluginManifest(raw, wantedId)

  const problems = inspectDraftEntry(parsed.entry)
  if (problems.length > 0) throw new Error(problems.join('；'))
  const entry = normalizeEntry(parsed.entry)
  return {
    manifest,
    manifestJson: `${JSON.stringify(manifest, null, 2)}\n`,
    entry,
    warnings,
  }
}

export function draftView(
  manifest: PluginManifest,
  reply: string,
  meta: { entry: string; manifestJson: string; warnings: string[]; model: string; attempts: number; durationMs: number },
): PluginDraftView {
  const routes: PluginRouteView[] = manifest.routes.map((route) => ({
    method: route.method,
    path: route.path,
    auth: route.auth,
    permission: route.permission,
    description: route.description,
  }))
  return {
    id: manifest.id,
    name: manifest.name,
    reply,
    manifestJson: meta.manifestJson,
    entry: meta.entry,
    permissions: manifest.permissions.slice(),
    providesSession: manifest.provides === 'session',
    routes,
    warnings: meta.warnings,
    model: meta.model,
    attempts: meta.attempts,
    durationMs: meta.durationMs,
  }
}

/** 生成一份草稿（不落盘）。两轮都不合格时抛出最后一次的校验原因。 */
export async function draftPlugin(
  input: DraftPluginOptions,
  deps: DraftPluginDeps,
): Promise<PluginDraftView> {
  const messages = buildDraftMessages(input)
  const startedAt = Date.now()
  let lastError = ''
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), DRAFT_TIMEOUT_MS)
    let content = ''
    try {
      content = await deps.complete(messages, controller.signal)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`模型调用失败：${reason}`)
    } finally {
      clearTimeout(timeout)
    }
    try {
      const parsed = parseDraftResponse(content)
      const validated = validateDraft(parsed, input.id)
      if (deps.workspace) {
        const dir = pluginDirFor(deps.workspace, validated.manifest.id)
        if (existsSync(dir)) {
          validated.warnings.push(
            `工作区里已经有 ${validated.manifest.id}；写入前请换个 id，或先删掉旧插件`,
          )
        }
      }
      return draftView(validated.manifest, parsed.reply, {
        entry: validated.entry,
        manifestJson: validated.manifestJson,
        warnings: validated.warnings,
        model: deps.modelLabel ?? '',
        attempts: attempt,
        durationMs: Date.now() - startedAt,
      })
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      // 把失败原因回喂一次：这类错误几乎都是清单字段或协议骨架写偏，模型能直接改。
      messages.push({
        role: 'user',
        content: `上一次输出没有通过宿主校验：${lastError}。请只返回修正后的 JSON 对象（字段仍是 reply/manifest/entry），不要解释。`,
      })
    }
  }
  throw new Error(`模型连续 ${MAX_ATTEMPTS} 轮没有给出可用插件：${lastError}`)
}

async function installedCount(workspace: string): Promise<number> {
  try {
    const entries = await readdir(pluginsRoot(workspace), { withFileTypes: true })
    return entries.filter(
      (entry) => entry.isDirectory() && /^[a-z][a-z0-9-]{1,31}$/.test(entry.name),
    ).length
  } catch {
    return 0
  }
}

function readmeFor(manifest: PluginManifest): string {
  const lines = [
    `# ${manifest.name}`,
    '',
    manifest.description || '由 Pilot 插件助手生成。',
    '',
    '## 路由',
    '',
    ...manifest.routes.map(
      (route) =>
        `- \`${route.method} /api/plugins/${manifest.id}/${route.path}\`（${route.auth}${
          route.permission ? `，需要 ${route.permission}` : ''
        }）${route.description ? `：${route.description}` : ''}`,
    ),
    '',
    '## 文件',
    '',
    '- `plugin.json`：清单（id、权限、路由、限额）',
    '- `index.mjs`：入口，按行收发 JSON-RPC，不进入宿主进程',
    '',
    '## 说明',
    '',
    '插件在独立子进程里运行，授权的权限与启停状态记录在 `.pilot/plugins/grants.json`。',
    '改动 `index.mjs` 后需要重新签名（设置 → 插件 → 签名），否则签名策略会拦截加载。',
    '',
  ]
  return lines.join('\n')
}

/**
 * 把草稿写进当前工作区并（可选地）签名、启用。
 *
 * 渲染层传入的 manifestJson / entry 在这里全部重新校验：它们来自页面，等价于
 * 不可信输入。写入顺序是「先检查、再落盘、后授权」，任何一步失败都不会留下
 * 一个已启用的半成品。
 */
export async function installDraftPlugin(
  workspace: string,
  input: PluginDraftInstallInput,
): Promise<PluginDraftInstallResult> {
  const root = resolve(workspace)
  const id = assertPluginId(String(input.id ?? ''))
  let rawManifest: unknown
  try {
    rawManifest = JSON.parse(String(input.manifestJson ?? ''))
  } catch {
    throw new Error('插件清单不是合法的 JSON')
  }
  const manifest = parsePluginManifest(rawManifest, id)
  const problems = inspectDraftEntry(String(input.entry ?? ''))
  if (problems.length > 0) throw new Error(problems.join('；'))
  const entry = normalizeEntry(String(input.entry ?? ''))

  const dir = pluginDirFor(root, id)
  if (existsSync(dir)) {
    throw new Error(`工作区里已经安装了 ${id}；请换个 id，或先在「已安装」里删除旧插件`)
  }
  if ((await installedCount(root)) >= MAX_PLUGINS) {
    throw new Error(`一个工作区最多 ${MAX_PLUGINS} 个插件，请先卸载不用的插件`)
  }

  const policy = await readSignaturePolicy(root)
  const enable = input.enable !== false
  // required 策略下未签名的插件无法启用；与其写完后启用失败，不如现在就签。
  const sign = input.sign === true || (enable && policy === 'required')

  await mkdir(dir, { recursive: true })
  const files = [PLUGIN_MANIFEST_FILE, 'index.mjs', 'README.md', '.gitignore']
  try {
    await writeFile(join(dir, PLUGIN_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    await writeFile(join(dir, 'index.mjs'), entry, 'utf8')
    const readme = String(input.readme ?? '').trim()
    await writeFile(join(dir, 'README.md'), readme ? `${readme}\n` : readmeFor(manifest), 'utf8')
    await writeFile(join(dir, '.gitignore'), ['.keys/', 'node_modules/', '.state/', ''].join('\n'), 'utf8')
    if (sign) {
      await signInstalledPlugin(root, id)
      files.push('plugin.sig')
    }
    if (enable) await setPluginEnabled(root, id, true)
  } catch (error) {
    // 半成品目录会让用户下次创建同一个 id 时被「已存在」挡住，直接清掉。
    const { rm } = await import('node:fs/promises')
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }

  return {
    id,
    dir,
    files,
    enabled: enable,
    signed: sign,
    overview: await pluginOverview(root),
  }
}
