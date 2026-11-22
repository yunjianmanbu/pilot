// 手机侧只读投影与会话/工作区操作：会话历史、检索、知识与链接、工具目录、目录浏览，以及会话和工作区的增改删。
// 由 server.ts 的同名方法机械搬出：方法体逐字保留，this 换成 host 参数。
import { mkdir, readdir, realpath, stat } from 'node:fs/promises'
import { join, normalize, resolve } from 'node:path'
import type {
  ApprovalMode,
  KnowledgePair,
  MessageSearchFilter,
  MessageSearchHit,
  Session,
  SessionLink,
  SessionSummary,
  StoredMessage,
  ToolCatalogEntry,
  WorkspaceSummary,
} from '../../../shared/types'
import { resolveLearningPolicy } from '../../agent/learning'
import { DynamicToolRegistry } from '../../agent/toolsmith'
import { filterLearningTools, pilotTools, RUN_SHELL } from '../../agent/tools'
import { loadMcpConfig } from '../../agent/mcp'
import { buildToolCatalog } from '../../../shared/tools-catalog'
import { collectSessionLinks } from '../../../shared/session-links'
import type { AgentRunner } from '../../agent/runner'
import { buildKnowledgePairs, clipKnowledgePair } from '../../search'
import { assertInside } from '../../workspace'
import {
  KNOWLEDGE_PAYLOAD_CHARS,
  PHONE_LINK_LIMIT,
  PHONE_LINK_URL_CHARS,
  PHONE_TOOL_DESCRIPTION_CHARS,
  PHONE_TOOL_LIMIT,
  RESERVED_WORKSPACE_NAMES,
  WORKSPACE_NAME_INVALID,
  WORKSPACE_NAME_MAX,
} from '../constants'
import { clampInt, requireString } from '../helpers'
import type { CompanionServer } from '../server'

export function listSessions(
  host: CompanionServer,
): {
    sessions: Array<SessionSummary & { workspaceName: string }>
    workspaces: WorkspaceSummary[]
    roots: string[]
  } {
  const workspaces = host.options.store.workspaces()
  const names = new Map(workspaces.map((workspace) => [workspace.path, workspace.name]))
  const sessions: Array<SessionSummary & { workspaceName: string }> = []
  for (const workspace of workspaces) {
    for (const session of host.options.store.sessions(workspace.path)) {
      sessions.push({
        ...session,
        workspaceName: names.get(session.workspacePath) ?? workspace.name,
      })
    }
  }
  sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  return { sessions, workspaces, roots: host.options.store.phoneRoots() }
}

export function getSession(
  host: CompanionServer,
  params: Record<string, unknown>,
): {
    session: Session
    hasMore: boolean
    hasNewer: boolean
    pendingApprovals: ReturnType<AgentRunner['pendingApprovalList']>
    activeRun: ReturnType<AgentRunner['activeRun']>
    workspaceName: string
  } {
  const sessionId = requireString(params['sessionId'], '会话', 80)
  const session = host.options.store.session(sessionId)
  if (!session) throw new Error('会话不存在')
  const limit = clampInt(params['limit'], 120, 1, 300)
  let start = Math.max(0, session.messages.length - limit)
  let end = session.messages.length
  let hasNewer = false
  const around = typeof params['around'] === 'string' ? params['around'] : ''
  const before = typeof params['before'] === 'string' ? params['before'] : ''
  if (around) {
    // 知识库检索命中较旧的消息时，返回以命中项为中心的窗口。
    const index = session.messages.findIndex((message) => message.id === around)
    if (index >= 0) {
      start = Math.max(0, Math.min(index - Math.floor(limit / 2), session.messages.length - limit))
      end = Math.min(session.messages.length, start + limit)
      hasNewer = end < session.messages.length
    }
  } else if (before) {
    const index = session.messages.findIndex((message) => message.id === before)
    if (index >= 0) end = index
    start = Math.max(0, end - limit)
  }
  const messages = host.phoneSafeMessages(session.messages.slice(start, end))
  const workspace = host.options.store
    .workspaces()
    .find((entry) => entry.path === session.workspacePath)
  return {
    session: {
      ...session,
      messages,
      running: host.options.runner.isRunning(session.id),
      messageCount: session.messages.length,
      queueCount: session.queue.length,
    },
    hasMore: start > 0,
    hasNewer,
    pendingApprovals: host.options.runner.pendingApprovalList(session.id),
    activeRun: host.options.runner.activeRun(session.id),
    workspaceName: workspace?.name ?? session.workspacePath,
  }
}

export function phoneSafeMessages(
  host: CompanionServer,
  messages: StoredMessage[],
): StoredMessage[] {
  const budget = 300_000
  let used = 0
  const out = [...messages]
  for (let index = out.length - 1; index >= 0; index -= 1) {
    const message = out[index]
    if (!message) continue
    const images = message.images
    if (!images || images.length === 0) continue
    const size = images.reduce((total, url) => total + url.length, 0)
    if (used + size <= budget) {
      used += size
      continue
    }
    out[index] = { ...message, images: [] }
  }
  return out
}

export function searchSessions(
  host: CompanionServer,
  params: Record<string, unknown>,
): { hits: MessageSearchHit[] } {
  const query = requireString(params['query'], '搜索内容', 200)
  const limit = clampInt(params['limit'], 40, 1, 200)
  const filter: MessageSearchFilter = {}
  if (typeof params['workspacePath'] === 'string' && params['workspacePath'].trim()) {
    filter.workspacePath = params['workspacePath'].trim()
  }
  if (typeof params['sessionId'] === 'string' && params['sessionId'].trim()) {
    filter.sessionId = params['sessionId'].trim().slice(0, 80)
  }
  if (params['role'] === 'user' || params['role'] === 'assistant') {
    filter.role = params['role']
  }
  if (typeof params['since'] === 'string' && params['since']) {
    filter.since = params['since']
  }
  return { hits: host.options.store.searchSessions(query, limit, filter) }
}

export function sessionKnowledge(
  host: CompanionServer,
  params: Record<string, unknown>,
): {
    pairs: KnowledgePair[]
    total: number
    hasMore: boolean
  } {
  const sessionId = requireString(params['sessionId'], '会话', 80)
  const session = host.options.store.session(sessionId)
  if (!session) throw new Error('会话不存在')
  const query = typeof params['query'] === 'string' ? params['query'].trim().slice(0, 200) : ''
  const limit = clampInt(params['limit'], 60, 1, 200)
  const all = buildKnowledgePairs(session.messages)
  const needle = query.toLowerCase().replace(/\s+/g, ' ')
  const matched = needle
    ? all.filter((pair) =>
        `${pair.instruction}\n${pair.reply}`
          .toLowerCase()
          .replace(/\s+/g, ' ')
          .includes(needle),
      )
    : all
  // 中继单帧有大小上限，按字符总量从最新往回挑，宁少勿撑爆一帧。
  const selected: KnowledgePair[] = []
  let used = 0
  for (let index = matched.length - 1; index >= 0 && selected.length < limit; index -= 1) {
    const pair = clipKnowledgePair(matched[index]!)
    const size = pair.instruction.length + pair.reply.length
    if (selected.length > 0 && used + size > KNOWLEDGE_PAYLOAD_CHARS) break
    selected.push(pair)
    used += size
  }
  selected.reverse()
  return {
    pairs: selected,
    total: matched.length,
    hasMore: matched.length > selected.length,
  }
}

export function sessionLinks(
  host: CompanionServer,
  params: Record<string, unknown>,
): {
    links: SessionLink[]
    total: number
    hasMore: boolean
  } {
  const sessionId = requireString(params['sessionId'], '会话', 80)
  const session = host.options.store.session(sessionId)
  if (!session) throw new Error('会话不存在')
  const limit = clampInt(params['limit'], PHONE_LINK_LIMIT, 1, 200)
  const all = collectSessionLinks(session.messages)
  return {
    links: all.slice(0, limit).map((link) => ({
      ...link,
      // 极少见的超长 URL 截断到 2000 字符，避免一帧被单条链接撑爆。
      url: link.url.slice(0, PHONE_LINK_URL_CHARS),
    })),
    total: all.length,
    hasMore: all.length > limit,
  }
}

export async function sessionTools(
  host: CompanionServer,
  params: Record<string, unknown>,
): Promise<{
    tools: Array<{
      name: string
      description: string
      risk: ToolCatalogEntry['risk']
      source: ToolCatalogEntry['source']
      enabled: boolean
      approved?: boolean
      version?: number
    }>
    total: number
    hasMore: boolean
    mcpEnabled: boolean
  }> {
  const sessionId = requireString(params['sessionId'], '会话', 80)
  const session = host.options.store.session(sessionId)
  if (!session) throw new Error('会话不存在')
  const settings = host.options.store.settings()
  const builtin = filterLearningTools(
    settings.shellMode
      ? pilotTools
      : pilotTools.filter((tool) => tool.name !== RUN_SHELL),
    resolveLearningPolicy(settings).enabled,
  )
  const servers = await loadMcpConfig(session.workspacePath).catch(() => ({}))
  const registry = await host.toolRegistry(session.workspacePath)
  const catalog = buildToolCatalog({
    builtin,
    dynamic: await registry.list().catch(() => []),
    mcpServers: Object.keys(servers),
    mcpEnabled: settings.mcpEnabled === true,
  })
  const tools = catalog.slice(0, PHONE_TOOL_LIMIT).map((tool) => ({
    name: tool.name,
    description:
      tool.description.length > PHONE_TOOL_DESCRIPTION_CHARS
        ? `${tool.description.slice(0, PHONE_TOOL_DESCRIPTION_CHARS)}…`
        : tool.description,
    // 手机端中文界面用这一句，缺省时回落到上面的英文原文。
    ...(tool.descriptionZh ? { descriptionZh: tool.descriptionZh } : {}),
    risk: tool.risk,
    source: tool.source,
    // 内置工具没有 enabled 字段，出现即代表可用。
    enabled: tool.enabled !== false,
    ...(tool.approved === undefined ? {} : { approved: tool.approved }),
    ...(tool.version === undefined ? {} : { version: tool.version }),
  }))
  return {
    tools,
    total: catalog.length,
    hasMore: catalog.length > tools.length,
    mcpEnabled: settings.mcpEnabled === true,
  }
}

export async function toolRegistry(
  host: CompanionServer,
  workspacePath: string,
): Promise<DynamicToolRegistry> {
  const settings = host.options.store.settings()
  return new DynamicToolRegistry({
    workspacePath,
    userDataDir: host.options.dataDir,
    testTargets: settings.testTargets,
    testCaptchaMode: settings.testCaptchaMode,
    testCaptcha: host.options.store.getTestCaptcha(),
  })
}

export async function phoneDirectory(
  host: CompanionServer,
  root: string,
  input: unknown,
): Promise<{ relative: string; path: string; resolved: string }> {
  const display = typeof input === 'string' ? input.trim().replace(/\\/g, '/') : ''
  const relative = display === '.' ? '' : display.replace(/^\/+|\/+$/g, '')
  if (!relative) {
    const resolved = await realpath(root)
    assertInside(root, resolved)
    return { relative: '', path: root, resolved }
  }
  const segments = relative.split('/')
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        segment.includes(':') ||
        segment.includes('\0'),
    )
  ) {
    throw new Error('目录不在授权范围内')
  }
  const target = join(root, ...segments)
  try {
    assertInside(root, target)
  } catch {
    throw new Error('目录不在授权范围内')
  }
  let resolved = ''
  try {
    resolved = await realpath(target)
    assertInside(root, resolved)
  } catch {
    throw new Error('目录不在授权范围内')
  }
  const info = await stat(resolved)
  if (!info.isDirectory()) throw new Error('选择的不是文件夹')
  return { relative: segments.join('/'), path: target, resolved }
}

export async function matchPhoneRoot(
  host: CompanionServer,
  requested: string,
  roots: string[],
): Promise<string> {
  const key = (value: string): string => {
    const path = normalize(resolve(value))
    return process.platform === 'win32' ? path.toLowerCase() : path
  }
  const wanted = key(requested)
  for (const root of roots) {
    if (key(root) === wanted) {
      try {
        return await realpath(root)
      } catch {
        return ''
      }
    }
  }
  return ''
}

export async function createWorkspace(
  host: CompanionServer,
  params: Record<string, unknown>,
): Promise<WorkspaceSummary> {
  const roots = host.options.store.phoneRoots()
  if (roots.length === 0) {
    throw new Error('电脑端还没有配置「手机可创建的工作区」目录')
  }
  const requestedRoot = requireString(params['root'], '授权目录', 1_000)
  const root = await host.matchPhoneRoot(requestedRoot, roots)
  if (!root) throw new Error('只能在自己电脑授权过的目录里新建工作区')
  const name = requireString(params['name'], '工作区名称', WORKSPACE_NAME_MAX)
  if (name === '.' || name === '..' || WORKSPACE_NAME_INVALID.test(name)) {
    throw new Error('工作区名称不能包含 / \\ : * ? " < > | 等字符')
  }
  if (name.endsWith('.') || name.endsWith(' ')) {
    throw new Error('工作区名称不能以点或空格结尾')
  }
  if (RESERVED_WORKSPACE_NAMES.test(name)) {
    throw new Error('这个名称是系统保留名，请换一个')
  }

  // The phone may create the folder at the root or inside the subdirectory
  // it is currently browsing.
  const parent = await host.phoneDirectory(root, params['path'])
  const target = join(parent.resolved, name)
  try {
    assertInside(parent.resolved, target)
  } catch {
    throw new Error('只能在自己电脑授权过的目录里新建工作区')
  }
  const existing = await stat(target).catch(() => null)
  if (existing) {
    if (!existing.isDirectory()) throw new Error('同名文件已存在，请换一个名称')
  } else {
    try {
      await mkdir(target, { recursive: false })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  let resolved = ''
  try {
    resolved = await realpath(target)
    assertInside(parent.resolved, resolved)
  } catch {
    throw new Error('新建的目录不在授权范围内')
  }
  const workspace = await host.options.store.addWorkspace(resolved, { activate: false })
  host.notify({ type: 'workspace.changed', workspacePath: workspace.path })
  return workspace
}

export async function browseWorkspace(
  host: CompanionServer,
  params: Record<string, unknown>,
): Promise<{
    root: string
    directory: string
    parent: string
    entries: Array<{ name: string; path: string }>
    truncated: boolean
  }> {
  const roots = host.options.store.phoneRoots()
  if (roots.length === 0) {
    throw new Error('电脑端还没有配置「手机可创建的工作区」目录')
  }
  const requestedRoot = requireString(params['root'], '授权目录', 1_000)
  const root = await host.matchPhoneRoot(requestedRoot, roots)
  if (!root) throw new Error('只能浏览自己电脑授权过的目录')
  const directory = await host.phoneDirectory(root, params['path'])
  const dirents = await readdir(directory.path, { withFileTypes: true })
  const entries: Array<{ name: string; path: string }> = []
  let truncated = false
  const sorted = dirents
    .filter((entry) => !entry.name.startsWith('.'))
    .sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of sorted) {
    if (entries.length >= 300) {
      truncated = true
      break
    }
    const child = join(directory.path, entry.name)
    let info
    try {
      info = await stat(child)
    } catch {
      continue
    }
    if (!info.isDirectory()) continue
    // Resolve every directory so junctions/symlinks pointing outside the
    // authorized root never show up in the list.
    try {
      assertInside(root, await realpath(child))
    } catch {
      continue
    }
    entries.push({
      name: entry.name,
      path: directory.relative ? `${directory.relative}/${entry.name}` : entry.name,
    })
  }
  return {
    root,
    directory: directory.relative,
    parent: directory.relative ? directory.relative.split('/').slice(0, -1).join('/') : '',
    entries,
    truncated,
  }
}

export async function openWorkspace(
  host: CompanionServer,
  params: Record<string, unknown>,
): Promise<WorkspaceSummary> {
  const roots = host.options.store.phoneRoots()
  if (roots.length === 0) {
    throw new Error('电脑端还没有配置「手机可创建的工作区」目录')
  }
  const requestedRoot = requireString(params['root'], '授权目录', 1_000)
  const root = await host.matchPhoneRoot(requestedRoot, roots)
  if (!root) throw new Error('只能把自己电脑授权过的目录作为工作区')
  const directory = await host.phoneDirectory(root, params['path'])
  const workspace = await host.options.store.addWorkspace(directory.resolved, {
    activate: false,
  })
  host.notify({ type: 'workspace.changed', workspacePath: workspace.path })
  return workspace
}

export async function removeWorkspace(
  host: CompanionServer,
  params: Record<string, unknown>,
): Promise<{ ok: true }> {
  const workspacePath = requireString(params['workspacePath'], '工作区', 2_000)
  host.assertWorkspace(workspacePath)
  if (host.options.store.workspaces().length <= 1) {
    throw new Error('至少要保留一个工作区')
  }
  await host.options.store.removeWorkspace(workspacePath)
  host.notify({ type: 'workspace.changed', workspacePath })
  return { ok: true }
}

export async function deleteSession(
  host: CompanionServer,
  params: Record<string, unknown>,
): Promise<{ ok: true }> {
  const sessionId = requireString(params['sessionId'], '会话', 80)
  if (!host.options.store.session(sessionId)) throw new Error('会话不存在')
  if (host.options.runner.isRunning(sessionId)) {
    throw new Error('请先停止正在运行的任务再删除会话')
  }
  await host.options.store.deleteSession(sessionId)
  await host.options.checkpoints?.removeSession(sessionId)
  host.notify({ type: 'session.changed', sessionId, plan: null })
  return { ok: true }
}

export async function createSession(
  host: CompanionServer,
  params: Record<string, unknown>,
): Promise<Session> {
  const workspaces = host.options.store.workspaces()
  if (workspaces.length === 0) throw new Error('电脑上还没有打开工作区')
  const requested =
    typeof params['workspacePath'] === 'string' ? params['workspacePath'] : ''
  const workspace =
    workspaces.find((entry) => entry.path === requested) ??
    workspaces.find((entry) => entry.path === host.options.store.activeWorkspace()) ??
    workspaces[0]
  if (!workspace) throw new Error('电脑上还没有打开工作区')
  return host.options.store.createSession(workspace.path)
}

export async function renameSession(
  host: CompanionServer,
  params: Record<string, unknown>,
): Promise<SessionSummary> {
  const sessionId = requireString(params['sessionId'], '会话', 80)
  const title = requireString(params['title'], '标题', 120)
  return host.options.store.updateSession(sessionId, { title })
}

export async function setSessionModel(
  host: CompanionServer,
  params: Record<string, unknown>,
): Promise<SessionSummary> {
  const sessionId = requireString(params['sessionId'], '会话', 80)
  if (typeof params['modelId'] !== 'string') {
    // 缺参不能当成“清除”，否则用户会以为设置成功却悄悄改回继承模型。
    throw new Error('模型参数格式不正确')
  }
  return host.options.store.setSessionModel(sessionId, params['modelId'].slice(0, 80))
}

export async function setApprovalMode(
  host: CompanionServer,
  params: Record<string, unknown>,
): Promise<SessionSummary> {
  const sessionId = requireString(params['sessionId'], '会话', 80)
  const mode = params['approvalMode']
  if (
    mode !== 'manual' &&
    mode !== 'ask' &&
    mode !== 'auto' &&
    // Legacy names from older app builds are migrated by the store.
    mode !== 'acceptEdits' &&
    mode !== 'plan' &&
    mode !== 'dontAsk'
  ) {
    throw new Error('执行模式不正确')
  }
  const updated = await host.options.store.updateSession(sessionId, {
    approvalMode: mode as ApprovalMode,
  })
  host.options.runner.setApprovalMode(sessionId, updated.approvalMode)
  return updated
}
