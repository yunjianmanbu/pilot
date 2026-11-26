// 用 language server 回答 code_intel 查询（Python / Go / Java / Rust / C / C++ / Ruby / PHP / C#）。
//
// 与 code-intel.ts 的 TypeScript 引擎输出同一套形状（file:line:column + 源码行），
// 让模型不必关心背后是 ts.createLanguageService 还是 LSP 子进程。
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type {
  CodeIntelDiagnostic,
  CodeIntelRequest,
  CodeIntelResult,
} from '../code-intel-types'
import {
  LspClient,
  isMethodNotFound,
  type LspDiagnostic,
  type LspLocation,
  type LspRange,
  type LspSymbol,
} from './client'
import {
  discoverServer,
  installHints,
  languageById,
  languageForFile,
  launchFor,
  scanSources,
  type LanguageSpec,
} from './servers'

const MAX_RESULTS = 40
const MAX_DIAGNOSTICS = 60
/** 空闲多久回收子进程。LSP server 比 TS 的 LanguageService 更贵。 */
const IDLE_MS = 10 * 60_000
const MAX_CACHED = 2
/** workspace 级诊断最多逐文件拉这么多，防止一个超大仓库把一轮查询拖死。 */
const MAX_DIAGNOSTIC_FILES = 80

interface Session {
  key: string
  root: string
  language: LanguageSpec
  client: LspClient
  /** Files already announced through textDocument/didOpen. */
  opened: Set<string>
  lastUsed: number
}

const sessions = new Map<string, Session>()
/** Latest publishDiagnostics per uri, for servers that push instead of pull. */
const pushedDiagnostics = new Map<string, LspDiagnostic[]>()

function rootKey(root: string): string {
  return process.platform === 'win32' ? root.toLowerCase() : root
}

function sessionKey(root: string, language: LanguageSpec): string {
  return `${rootKey(root)}::${language.id}`
}

function toPosix(value: string): string {
  return value.split('\\').join('/')
}

function relPath(root: string, file: string): string {
  const rel = relative(root, file)
  return toPosix(rel) || '.'
}

/** Workspace-relative when inside the root, absolute otherwise (JDK / Go module cache). */
function displayPath(root: string, file: string): string {
  const rel = relative(root, file)
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return toPosix(rel)
  return toPosix(isAbsolute(file) ? file : join(root, file))
}

function uriOf(file: string): string {
  return pathToFileURL(file).toString()
}

function pathOfUri(uri: string): string | null {
  if (!uri.startsWith('file:')) return null
  try {
    return fileURLToPath(uri)
  } catch {
    return null
  }
}

const lineCache = new Map<string, { stamp: number; lines: string[] }>()

function linesOf(file: string): string[] {
  let stamp = 0
  try {
    stamp = existsSync(file) ? Number(readFileSync(file, { encoding: 'utf8', flag: 'r' }).length) : 0
  } catch {
    return []
  }
  const cached = lineCache.get(file)
  if (cached && cached.stamp === stamp) return cached.lines
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const lines = text.split(/\r?\n/)
  lineCache.set(file, { stamp, lines })
  return lines
}

function previewAt(file: string, position: { line: number }): string {
  const line = linesOf(file)[position.line] ?? ''
  return line.trim().slice(0, 240)
}

/** LSP 的 Position 是 0-based；工具对外一律 1-based。 */
function locationText(root: string, location: LspLocation): string {
  const file = pathOfUri(location.uri)
  const line = location.range.start.line + 1
  const column = location.range.start.character + 1
  const path = file ? displayPath(root, file) : location.uri
  const preview = file ? previewAt(file, location.range.start) : ''
  return preview ? `${path}:${line}:${column}  ${preview}` : `${path}:${line}:${column}`
}

/** DocumentSymbol 只有 range，没有 location；用它自己的文件补上。 */
function symbolLocation(file: string, symbol: LspSymbol): LspLocation | null {
  if (symbol.location) return symbol.location
  if (file && symbol.range) return { uri: uriOf(file), range: symbol.range }
  return null
}

/** LSP SymbolKind → 可读名字，与 TS 引擎的 kind 字段对应。 */
const SYMBOL_KIND: Record<number, string> = {
  1: 'File',
  2: 'Module',
  3: 'Namespace',
  4: 'Package',
  5: 'Class',
  6: 'Method',
  7: 'Property',
  8: 'Field',
  9: 'Constructor',
  10: 'Enum',
  11: 'Interface',
  12: 'Function',
  13: 'Variable',
  14: 'Constant',
  15: 'String',
  16: 'Number',
  17: 'Boolean',
  18: 'Array',
  19: 'Object',
  20: 'Key',
  21: 'Null',
  22: 'EnumMember',
  23: 'Struct',
  24: 'Event',
  25: 'Operator',
  26: 'TypeParameter',
}

function symbolKind(kind: number): string {
  return SYMBOL_KIND[kind] ?? `Kind${kind}`
}

function flattenSymbols(symbols: LspSymbol[], into: LspSymbol[] = []): LspSymbol[] {
  for (const symbol of symbols) {
    into.push(symbol)
    if (symbol.children && symbol.children.length > 0) flattenSymbols(symbol.children, into)
  }
  return into
}

function evictIdle(now: number): void {
  for (const [key, session] of sessions) {
    if (now - session.lastUsed > IDLE_MS) {
      void session.client.dispose()
      sessions.delete(key)
    }
  }
  while (sessions.size > MAX_CACHED) {
    let oldestKey: string | null = null
    let oldest = Number.POSITIVE_INFINITY
    for (const [key, session] of sessions) {
      if (session.lastUsed < oldest) {
        oldest = session.lastUsed
        oldestKey = key
      }
    }
    if (oldestKey === null) break
    const victim = sessions.get(oldestKey)
    if (victim) void victim.client.dispose()
    sessions.delete(oldestKey)
  }
}

async function openSession(root: string, language: LanguageSpec): Promise<Session> {
  const key = sessionKey(root, language)
  const now = Date.now()
  evictIdle(now)
  const existing = sessions.get(key)
  if (existing && existing.client.alive) {
    existing.lastUsed = now
    return existing
  }
  if (existing) sessions.delete(key)

  const server = discoverServer(root, language)
  if (!server) throw new Error('no server')
  const launch = launchFor(server.command, server.args)
  const client = new LspClient(launch, { cwd: root })
  client.onNotification('textDocument/publishDiagnostics', (params) => {
    const payload = params as { uri?: string; diagnostics?: LspDiagnostic[] }
    if (payload?.uri) pushedDiagnostics.set(payload.uri, payload.diagnostics ?? [])
  })
  try {
    await client.initialize(uriOf(root), root.split(/[\\/]/).filter(Boolean).pop() ?? 'workspace')
  } catch (error) {
    // 握手失败时进程可能还活着（比如 server 不认这个 rootUri），不回收就漏一个子进程。
    await client.dispose().catch(() => undefined)
    throw error
  }
  const session: Session = { key, root, language, client, opened: new Set(), lastUsed: now }
  sessions.set(key, session)
  return session
}

function didOpen(session: Session, file: string): void {
  const uri = uriOf(file)
  if (session.opened.has(uri)) return
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return
  }
  session.client.notify('textDocument/didOpen', {
    textDocument: { uri, languageId: session.language.id, version: 1, text },
  })
  session.opened.add(uri)
}

function didClose(session: Session, file: string): void {
  const uri = uriOf(file)
  if (!session.opened.has(uri)) return
  session.client.notify('textDocument/didClose', { textDocument: { uri } })
  session.opened.delete(uri)
}

/**
 * 在一份文件里按词边界找名字第一次出现的位置（0-based）。
 *
 * LSP 没有「按名字取位置」的接口：definition/references 都要一个 Position。
 * 跳过纯注释行可以挡掉最常见的一类误命中。
 */
function findIdentifier(
  file: string,
  name: string,
  commentPrefixes: string[],
): { line: number; character: number } | null {
  const lines = linesOf(file)
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`(^|[^\\w$])(${escaped})(?![\\w$])`)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const trimmed = line.trimStart()
    if (commentPrefixes.some((prefix) => trimmed.startsWith(prefix))) continue
    const match = pattern.exec(line)
    if (!match) continue
    const offset = match.index + match[1]!.length
    return { line: index, character: offset }
  }
  return null
}

const COMMENT_PREFIXES: Record<string, string[]> = {
  python: ['#'],
  ruby: ['#'],
  php: ['#', '//', '/*', '*'],
  go: ['//', '/*', '*'],
  java: ['//', '/*', '*'],
  rust: ['//', '/*', '*'],
  c: ['//', '/*', '*'],
  cpp: ['//', '/*', '*'],
  csharp: ['//', '/*', '*'],
}

function asLocation(entry: unknown): LspLocation | null {
  if (!entry || typeof entry !== 'object') return null
  const item = entry as Record<string, unknown>
  if (typeof item['uri'] === 'string' && item['range']) return entry as LspLocation
  if (item['targetUri'] && (item['targetSelectionRange'] || item['targetRange'])) {
    // LocationLink：targetRange 是整个声明（含修饰符），targetSelectionRange 才是名字。
    // 挑名字，否则跳转会落到 `def ` / `public ` 上而不是符号本身。
    const range = (item['targetSelectionRange'] ?? item['targetRange']) as LspRange
    return { uri: String(item['targetUri']), range }
  }
  return null
}

/**
 * Normalise 实现差异：textDocument/definition 的规范结果是 `Location | Location[] | LocationLink[]`，
 * 真实 server 里 pyright / gopls / jdtls 都会直接返回单个对象。只认数组会把
 * 「找到了定义」当成「没有定义」。
 */
function locationList(value: unknown): LspLocation[] {
  if (!value) return []
  if (Array.isArray(value)) {
    const out: LspLocation[] = []
    for (const entry of value) {
      const location = asLocation(entry)
      if (location) out.push(location)
    }
    return out
  }
  const single = asLocation(value)
  return single ? [single] : []
}

function diagnosticSeverity(value: number | undefined): 'error' | 'warning' {
  return value === 1 ? 'error' : 'warning'
}

function toDiagnostic(root: string, uri: string, item: LspDiagnostic): CodeIntelDiagnostic | null {
  const file = pathOfUri(uri)
  if (!file) return null
  return {
    file: displayPath(root, file),
    line: item.range.start.line + 1,
    column: item.range.start.character + 1,
    severity: diagnosticSeverity(item.severity),
    message: String(item.message ?? '').replace(/\s+/g, ' ').trim(),
    code: typeof item.code === 'number' ? item.code : 0,
  }
}

function renderDiagnostics(root: string, diagnostics: CodeIntelDiagnostic[], language: LanguageSpec, scope: 'file' | 'workspace'): CodeIntelResult {
  if (diagnostics.length === 0) {
    return {
      ok: true,
      output: `No diagnostics reported by the ${language.label} language server.`,
      metadata: { count: 0, scope, engine: 'lsp' },
    }
  }
  const body = diagnostics
    .map((item) => `${item.file}:${item.line}:${item.column}  ${item.message}`)
    .join('\n')
  return {
    ok: true,
    output: `${diagnostics.length}${diagnostics.length >= MAX_DIAGNOSTICS ? '+' : ''} diagnostic(s) from the ${language.label} language server:\n${body}`,
    metadata: { count: diagnostics.length, scope, engine: 'lsp' },
  }
}

/**
 * 拉一个文件的诊断。
 *
 * 优先 LSP 3.17 的 pull（textDocument/diagnostic）；server 不支持（常见于 pyright、
 * gopls 的旧版本）时等 publishDiagnostics 推送，等不到就返回空而不是卡住。
 */
async function fileDiagnostics(
  session: Session,
  file: string,
  waitMs = 4_000,
): Promise<CodeIntelDiagnostic[]> {
  const uri = uriOf(file)
  didOpen(session, file)
  try {
    const pulled = await session.client.request<{
      kind?: string
      items?: LspDiagnostic[]
    }>('textDocument/diagnostic', { textDocument: { uri } })
    const items = pulled?.items ?? []
    return items
      .map((item) => toDiagnostic(session.root, uri, item))
      .filter((item): item is CodeIntelDiagnostic => item !== null)
  } catch (error) {
    if (!isMethodNotFound(error)) throw error
  }

  pushedDiagnostics.delete(uri)
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    const pushed = pushedDiagnostics.get(uri)
    if (pushed) {
      return pushed
        .map((item) => toDiagnostic(session.root, uri, item))
        .filter((item): item is CodeIntelDiagnostic => item !== null)
        .filter((item) => item.severity === 'error')
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 120))
  }
  return []
}

function filesForLanguage(
  root: string,
  language: LanguageSpec,
): Promise<{ files: string[]; truncated: boolean }> {
  const extensions = new Set(language.extensions)
  return scanSources(root, extensions, 400)
}

/** Run one code_intel request through the language server for `language`. */
export async function runLspCodeIntel(
  root: string,
  language: LanguageSpec,
  request: CodeIntelRequest,
): Promise<CodeIntelResult> {
  const server = discoverServer(root, language)
  if (!server) {
    return {
      ok: false,
      output: `No ${language.label} language server found for this workspace. Install one to get exact definitions, references and diagnostics: ${installHints(language)}. Without it, code_intel falls back to a structural text search.`,
      metadata: { unavailable: true, needsServer: true, language: language.id },
    }
  }

  let session: Session
  try {
    session = await openSession(root, language)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      output: `The ${language.label} language server (${server.command}) could not be started: ${reason}. Install hint: ${installHints(language)}.`,
      metadata: { unavailable: true, needsServer: true, language: language.id },
    }
  }
  session.lastUsed = Date.now()

  const wanted = request.path?.trim() ?? ''
  const file = wanted ? (isAbsolute(wanted) ? wanted : join(root, wanted)) : ''

  if (request.action === 'symbols') {
    const query = (request.query ?? request.symbol ?? '').trim()
    let symbols: LspSymbol[] = []
    try {
      symbols = await session.client.request<LspSymbol[]>('workspace/symbol', { query })
    } catch (error) {
      if (!isMethodNotFound(error)) throw error
    }
    let flat = flattenSymbols(symbols ?? [])
    if (flat.length === 0 && file) {
      didOpen(session, file)
      const document = await session.client.request<LspSymbol[]>('textDocument/documentSymbol', {
        textDocument: { uri: uriOf(file) },
      })
      flat = flattenSymbols(Array.isArray(document) ? document : [])
      if (query) flat = flat.filter((symbol) => symbol.name.toLowerCase().includes(query.toLowerCase()))
    }
    if (flat.length === 0) {
      return {
        ok: true,
        output: `No declarations matching "${query}" reported by the ${language.label} language server.`,
        metadata: { count: 0, engine: 'lsp' },
      }
    }
    const lines = flat.slice(0, MAX_RESULTS).map((symbol) => {
      const where = symbolLocation(file, symbol)
      const kind = symbolKind(symbol.kind)
      const container = symbol.containerName ? ` (${symbol.containerName})` : ''
      const label = `[${kind} ${symbol.name}${container}]`
      if (!where) return label
      return `${locationText(root, where)}  ${label}`
    })
    return {
      ok: true,
      output: `${flat.length} declaration(s) matching "${query}" (${language.label} language server):\n${lines.join('\n')}`,
      metadata: { count: Math.min(flat.length, MAX_RESULTS), engine: 'lsp', language: language.id },
    }
  }

  if (request.action === 'diagnostics') {
    const workspaceScope = request.scope === 'workspace' || !file
    const diagnostics: CodeIntelDiagnostic[] = []
    if (!workspaceScope) {
      diagnostics.push(...(await fileDiagnostics(session, file)))
      return renderDiagnostics(root, diagnostics.slice(0, MAX_DIAGNOSTICS), language, 'file')
    }
    const { files } = await filesForLanguage(root, language)
    for (const target of files.slice(0, MAX_DIAGNOSTIC_FILES)) {
      if (diagnostics.length >= MAX_DIAGNOSTICS) break
      const found = await fileDiagnostics(session, target, 1_500)
      for (const item of found) {
        if (diagnostics.length >= MAX_DIAGNOSTICS) break
        diagnostics.push(item)
      }
    }
    return renderDiagnostics(root, diagnostics, language, 'workspace')
  }

  // definition / references 需要一个位置。
  let anchor: { file: string; position: { line: number; character: number } } | null = null
  if (file && typeof request.line === 'number' && request.line > 0) {
    anchor = {
      file,
      position: { line: Math.round(request.line) - 1, character: Math.max(0, Math.round(request.column ?? 1) - 1) },
    }
  } else if (request.symbol?.trim()) {
    const symbol = request.symbol.trim()
    if (file) {
      const position = findIdentifier(file, symbol, COMMENT_PREFIXES[language.id] ?? [])
      if (!position) {
        return { ok: false, output: `Symbol "${symbol}" does not appear in ${wanted}.`, metadata: {} }
      }
      anchor = { file, position }
    } else {
      // 没有 path：先用 workspace/symbol 找声明，definition 直接用它。
      let symbols: LspSymbol[] = []
      try {
        symbols = await session.client.request<LspSymbol[]>('workspace/symbol', { query: symbol })
      } catch (error) {
        if (!isMethodNotFound(error)) throw error
      }
      const match = flattenSymbols(symbols ?? []).find((item) => item.name === symbol)
      const location = match?.location
      const located = location ? pathOfUri(location.uri) : null
      if (!match || !located || !location) {
        return { ok: false, output: `No declaration named "${symbol}" reported by the ${language.label} language server.`, metadata: {} }
      }
      if (request.action === 'definition') {
        return {
          ok: true,
          output: `Definition:\n${locationText(root, location)}`,
          metadata: { count: 1, engine: 'lsp', language: language.id },
        }
      }
      anchor = { file: located, position: location.range.start }
    }
  } else {
    return {
      ok: false,
      output: 'Provide path + symbol (or path + line/column) so the position is unambiguous.',
      metadata: {},
    }
  }

  if (!existsSync(anchor.file)) {
    return { ok: false, output: `File not found or unreadable: ${displayPath(root, anchor.file)}`, metadata: {} }
  }
  didOpen(session, anchor.file)

  const params = {
    textDocument: { uri: uriOf(anchor.file) },
    position: anchor.position,
  }

  if (request.action === 'definition') {
    const raw = await session.client.request<unknown>('textDocument/definition', params)
    const locations = locationList(raw)
    if (locations.length === 0) {
      return {
        ok: true,
        output: 'No definition found at this position (the server may treat it as a library or computed value).',
        metadata: { count: 0, engine: 'lsp', language: language.id },
      }
    }
    const seen = new Set<string>()
    const lines: string[] = []
    for (const location of locations) {
      const key = `${location.uri}:${location.range.start.line}:${location.range.start.character}`
      if (seen.has(key)) continue
      seen.add(key)
      lines.push(locationText(root, location))
    }
    return {
      ok: true,
      output: `Definition:\n${lines.join('\n')}`,
      metadata: { count: lines.length, engine: 'lsp', language: language.id },
    }
  }

  const refParams = { ...params, context: { includeDeclaration: true } }
  const raw = await session.client.request<unknown>('textDocument/references', refParams)
  const refs = locationList(raw)
  if (refs.length === 0) {
    return {
      ok: true,
      output: 'No references found at this position.',
      metadata: { count: 0, engine: 'lsp', language: language.id },
    }
  }
  const lines = refs.slice(0, 200).map((location) => locationText(root, location))
  return {
    ok: true,
    output: `${refs.length} reference(s) (${language.label} language server):\n${lines.join('\n')}`,
    metadata: { count: refs.length, engine: 'lsp', language: language.id },
  }
}

/** Dispose every cached language server. Tests call this to leave no child behind. */
export async function disposeLsp(): Promise<void> {
  const all = [...sessions.values()]
  sessions.clear()
  pushedDiagnostics.clear()
  lineCache.clear()
  await Promise.all(all.map((session) => session.client.dispose()))
}

/** Introspection for tests and diagnostics. */
export function lspStatus(): Array<{ root: string; language: string; opened: number; alive: boolean }> {
  return [...sessions.values()].map((session) => ({
    root: session.root,
    language: session.language.id,
    opened: session.opened.size,
    alive: session.client.alive,
  }))
}

export { languageById, languageForFile }
