// 代码智能：用 TypeScript LanguageService 回答「在哪定义 / 谁在用 / 有哪些符号 / 类型错」。
//
// 为什么需要它：search_files 是文本匹配，找定义要读多轮、猜结果；改完代码跑一次
// `tsc --noEmit` 冷启动要几十秒。这里把 LanguageService 建一次并缓存，之后每次查询
// 几百毫秒且结果精确（本机实测：建库 4.2s，definition 0.3s，references 0.6s，
// navigateToItems 0.5s，543 个源文件）。
//
// 依赖边界：typescript 从工作区自己的 node_modules 解析（Pilot 不在安装包里捆绑它，
// 因此不增加安装包体积）。工作区没有 typescript 时本模块明确报「不可用」，调用方
// 据此降级回 search_files，而不是抛一个看不懂的 MODULE_NOT_FOUND。
import { createRequire } from 'node:module'
import { readdir, readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type * as TS from 'typescript'
import type {
  CodeIntelAction,
  CodeIntelDiagnostic,
  CodeIntelRequest,
  CodeIntelResult,
} from './code-intel-types'
import { runHeuristicCodeIntel } from './lsp/fallback'
import { disposeLsp, runLspCodeIntel } from './lsp/intel'
import {
  LANGUAGES,
  TS_EXTENSIONS,
  discoverServer,
  isTypeScriptFile,
  languageById,
  languageForFile,
  scanSources,
  type LanguageId,
  type LanguageSpec,
} from './lsp/servers'

export type { CodeIntelAction, CodeIntelDiagnostic, CodeIntelRequest, CodeIntelResult }
export type { CodeIntelPosition } from './code-intel-types'

/** 收集源文件时跳过的目录名。与 workspace 搜索的剪枝口径保持一致。 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'out',
  'dist',
  'build',
  'release',
  'unpackage',
  '.pilot',
  '.build',
  'tmp',
  'coverage',
  '.next',
  '.nuxt',
  '.venv',
  'vendor',
  'target',
  '__pycache__',
  '.cache',
])

const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/

/** 建库文件上限：超过它建库会吃掉大半秒级内存，收益不如直接用 tsc。 */
const MAX_FILES = 2500
/** 空闲多久释放语言服务。Electron 主进程常驻，不能让缓存无限占内存。 */
const IDLE_MS = 10 * 60_000
/** 同时缓存几个根目录的语言服务。 */
const MAX_CACHED = 2
const MAX_SYMBOL_RESULTS = 40
const MAX_DIAGNOSTICS = 60

export interface CodeIntelUnavailable {
  /** Why the service cannot answer, phrased for the model. */
  reason: string
  /** True when the fix is "install typescript in this project". */
  needsTypeScript: boolean
}

type LoadResult = { ts: typeof TS; entry: string } | CodeIntelUnavailable

interface Snapshot {
  text: string
  version: string
}

interface Session {
  root: string
  ts: typeof TS
  service: TS.LanguageService
  files: string[]
  snapshots: Map<string, Snapshot>
  /** Line offsets per file, keyed by the snapshot version that produced them. */
  indexes: Map<string, { version: string; index: LineIndex }>
  lastUsed: number
  /** True when the file list was capped and diagnostics would be misleading. */
  truncated: boolean
}

const sessions = new Map<string, Session>()
const loaded = new Map<string, LoadResult>()

function rootKey(root: string): string {
  return process.platform === 'win32' ? root.toLowerCase() : root
}

function toPosix(value: string): string {
  return value.split('\\').join('/')
}

/**
 * 解析工作区里的 typescript。
 *
 * 顺序：工作区 → 工作区上一级（monorepo / 本仓 pilot/pilot 之上）→ 当前进程目录。
 * 用 require.resolve 而不是硬编码路径，pnpm 的符号链接布局因此不用特殊处理。
 */
async function loadTypeScript(root: string): Promise<LoadResult> {
  const key = rootKey(root)
  const cached = loaded.get(key)
  if (cached) return cached
  const bases = [join(root, 'package.json'), join(resolve(root, '..'), 'package.json'), join(process.cwd(), 'package.json')]
  for (const base of bases) {
    try {
      const require = createRequire(base)
      const entry = require.resolve('typescript')
      if (!existsSync(entry)) continue
      const mod = require('typescript') as typeof TS
      if (typeof mod.createLanguageService !== 'function') continue
      const result: LoadResult = { ts: mod, entry }
      loaded.set(key, result)
      return result
    } catch {
      // 下一个候选位置
    }
  }
  const missing: CodeIntelUnavailable = {
    reason:
      'This workspace has no `typescript` package, so code intelligence cannot run. Install it (npm i -D typescript) or use search_files instead.',
    needsTypeScript: true,
  }
  loaded.set(key, missing)
  return missing
}

async function collectSourceFiles(root: string, limit: number): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = []
  let truncated = false
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (truncated || depth > 14) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (truncated) return
      if (entry.name.startsWith('.') && entry.name !== '.') {
        // 隐藏目录少收一点，但仍允许 .pilot 之外的常规点目录（如 .storybook）被跳过
        if (SKIP_DIRS.has(entry.name)) continue
      }
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        await walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      if (!SOURCE_EXT.test(entry.name)) continue
      if (entry.name.endsWith('.d.ts')) continue
      if (files.length >= limit) {
        truncated = true
        return
      }
      files.push(full)
    }
  }
  await walk(root, 0)
  return { files, truncated }
}

function compilerOptions(ts: typeof TS): TS.CompilerOptions {
  return {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    allowJs: true,
    checkJs: false,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    resolveJsonModule: true,
    forceConsistentCasingInFileNames: true,
  }
}

async function readSnapshot(file: string): Promise<Snapshot | undefined> {
  try {
    const info = await stat(file)
    const text = await readFile(file, 'utf8')
    return { text, version: String(info.mtimeMs) }
  } catch {
    return undefined
  }
}

async function createSession(root: string, ts: typeof TS): Promise<Session> {
  const { files, truncated } = await collectSourceFiles(root, MAX_FILES)
  const snapshots = new Map<string, Snapshot>()
  for (const file of files) {
    const snapshot = await readSnapshot(file)
    if (snapshot) snapshots.set(file, snapshot)
  }
  const options = compilerOptions(ts)
  const host: TS.LanguageServiceHost = {
    getScriptFileNames: () => files,
    getScriptVersion: (file) => snapshots.get(file)?.version ?? '0',
    getScriptSnapshot: (file) => {
      const own = snapshots.get(file)
      if (own) return ts.ScriptSnapshot.fromString(own.text)
      if (!existsSync(file)) return undefined
      // 库文件（lib.*.d.ts、@types）不进快照表，直接读一次交给 TS 缓存。
      const text = ts.sys.readFile(file)
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text)
    },
    getCurrentDirectory: () => root,
    getCompilationSettings: () => options,
    getDefaultLibFileName: (opts) => ts.getDefaultLibFilePath(opts),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  }
  const service = ts.createLanguageService(host)
  // 首次 getProgram 会把库文件全部载入；放在这里一次付清，查询就快了。
  service.getProgram()
  return {
    root,
    ts,
    service,
    files,
    snapshots,
    indexes: new Map(),
    lastUsed: Date.now(),
    truncated,
  }
}

function evictIdle(now: number): void {
  for (const [key, session] of sessions) {
    if (now - session.lastUsed > IDLE_MS) {
      session.service.dispose()
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
    sessions.get(oldestKey)?.service.dispose()
    sessions.delete(oldestKey)
  }
}

/**
 * 取（或建）某根目录的语言服务。文件自上次建库后有新增时重建，单纯的编辑
 * 靠 mtime 版本号让 TS 自己失效，不重建 program。
 */
async function getSession(root: string, ts: typeof TS): Promise<Session> {
  const key = rootKey(root)
  const now = Date.now()
  evictIdle(now)
  const existing = sessions.get(key)
  if (existing) {
    existing.lastUsed = now
    // 新增文件不会自动进入 program（getScriptFileNames 已经定了），重建一次即可。
    const { files } = await collectSourceFiles(root, MAX_FILES)
    const known = new Set(existing.files)
    const grew = files.some((file) => !known.has(file)) || files.length !== existing.files.length
    if (!grew) return existing
    existing.service.dispose()
    const rebuilt = await createSession(root, ts)
    sessions.set(key, rebuilt)
    return rebuilt
  }
  const created = await createSession(root, ts)
  sessions.set(key, created)
  return created
}

/** Dispose every cached language service. Tests call this to leave no handles behind. */
export function disposeCodeIntel(): void {
  for (const session of sessions.values()) session.service.dispose()
  sessions.clear()
  loaded.clear()
}

function relPath(root: string, file: string): string {
  return toPosix(relative(root, file)) || '.'
}

function absPath(root: string, file: string): string {
  return isAbsolute(file) ? file : join(root, file)
}

interface LineIndex {
  /** 1-based line → offset of its first character. */
  starts: number[]
  text: string
}

function lineIndex(session: Session, file: string): LineIndex | null {
  const snapshot = session.snapshots.get(file)
  const text = snapshot?.text ?? session.ts.sys.readFile(file)
  if (text === undefined) return null
  const version = snapshot?.version ?? `disk:${text.length}`
  const cached = session.indexes.get(file)
  if (cached && cached.version === version) return cached.index
  const starts = [0]
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1)
  }
  const index: LineIndex = { starts, text }
  session.indexes.set(file, { version, index })
  return index
}

function offsetOf(index: LineIndex, line: number, column: number): number {
  const start = index.starts[Math.max(0, Math.min(index.starts.length - 1, line - 1))] ?? 0
  return Math.min(index.text.length, start + Math.max(0, column - 1))
}

function positionOf(index: LineIndex, offset: number): { line: number; column: number } {
  let low = 0
  let high = index.starts.length - 1
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if ((index.starts[mid] ?? 0) <= offset) low = mid
    else high = mid - 1
  }
  return { line: low + 1, column: offset - (index.starts[low] ?? 0) + 1 }
}

function lineText(index: LineIndex, line: number): string {
  const start = index.starts[line - 1] ?? 0
  const next = index.starts[line] ?? index.text.length
  return index.text.slice(start, next).replace(/\r?\n$/, '').trim().slice(0, 240)
}

function preview(session: Session, file: string, offset: number): { preview: string; position: { line: number; column: number } } {
  const index = lineIndex(session, file)
  if (!index) return { preview: '', position: { line: 1, column: 1 } }
  const position = positionOf(index, offset)
  return { preview: lineText(index, position.line), position }
}

/** 在一份源文件里找第一个匹配 `symbol` 的标识符节点。 */
function findIdentifierOffset(session: Session, file: string, symbol: string): number | null {
  const program = session.service.getProgram()
  const sourceFile = program?.getSourceFile(file)
  if (!sourceFile) return null
  let found: number | null = null
  const visit = (node: TS.Node): void => {
    if (found !== null) return
    const name = (node as { name?: TS.Node }).name
    if (
      name &&
      session.ts.isIdentifier(name) &&
      name.text === symbol
    ) {
      found = name.getStart(sourceFile)
      return
    }
    session.ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

function symbolKindName(kind: TS.ScriptElementKind): string {
  return String(kind)
}

/**
 * TypeScript / JavaScript 引擎（进程内 LanguageService）。
 *
 * 对外入口是文件末尾的 `runCodeIntel`，它先按扩展名路由：TS/JS 走这里，
 * 其它语言走 LSP 子进程（lsp/intel.ts）或结构化降级（lsp/fallback.ts）。
 */
async function runTsCodeIntel(root: string, request: CodeIntelRequest): Promise<CodeIntelResult> {
  const load = await loadTypeScript(root)
  if ('reason' in load) {
    return { ok: false, output: load.reason, metadata: { unavailable: true, needsTypeScript: load.needsTypeScript } }
  }
  const { ts } = load
  const session = await getSession(root, ts)

  if (session.files.length === 0) {
    return { ok: false, output: 'No TypeScript/JavaScript source files under the workspace root.', metadata: {} }
  }

  const wanted = request.path?.trim() ?? ''
  const file = wanted ? absPath(root, wanted) : ''
  if (wanted && !session.snapshots.has(file)) {
    // 允许查询尚未进入快照表的文件：直接读一次并补进来。
    const snapshot = await readSnapshot(file)
    if (!snapshot) {
      return { ok: false, output: `File not found or unreadable: ${wanted}`, metadata: {} }
    }
    session.snapshots.set(file, snapshot)
    if (!session.files.includes(file)) session.files.push(file)
  }

  if (request.action === 'symbols') {
    const query = (request.query ?? request.symbol ?? '').trim()
    const navigate = session.service.getNavigateToItems(query, MAX_SYMBOL_RESULTS, undefined, true, true)
    if (navigate.length === 0) {
      return { ok: true, output: `No declarations matching "${query}".`, metadata: { count: 0 } }
    }
    const lines = navigate.slice(0, MAX_SYMBOL_RESULTS).map((item) => {
      const at = preview(session, item.fileName, item.textSpan.start)
      const raw = item.fileName
      const name = typeof item.name === 'string' ? item.name : query
      const kind = symbolKindName(item.kind)
      const container = item.containerName ? ` (${item.containerName})` : ''
      return `${relPath(root, raw)}:${at.position.line}:${at.position.column}  ${kind} ${name}${container}\n  ${at.preview}`
    })
    return {
      ok: true,
      output: `${navigate.length} declaration(s) matching "${query}":\n${lines.join('\n')}`,
      metadata: { count: navigate.length },
    }
  }

  if (request.action === 'diagnostics') {
    const workspaceScope = request.scope === 'workspace' || !file
    const targets = workspaceScope ? session.files : [file]
    const diagnostics: CodeIntelDiagnostic[] = []
    for (const target of targets) {
      if (diagnostics.length >= MAX_DIAGNOSTICS) break
      const program = session.service.getProgram()
      const sourceFile = program?.getSourceFile(target)
      if (!sourceFile) continue
      for (const diagnostic of session.service.getSemanticDiagnostics(target)) {
        if (diagnostics.length >= MAX_DIAGNOSTICS) break
        if (diagnostic.category !== ts.DiagnosticCategory.Error) continue
        const at = preview(session, target, diagnostic.start ?? 0)
        diagnostics.push({
          file: relPath(root, target),
          line: at.position.line,
          column: at.position.column,
          severity: 'error',
          message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
          code: diagnostic.code ?? 0,
        })
      }
    }
    if (diagnostics.length === 0) {
      return {
        ok: true,
        output: `No type errors in ${workspaceScope ? `${session.files.length} files` : relPath(root, file)}.`,
        metadata: { count: 0, scope: workspaceScope ? 'workspace' : 'file' },
      }
    }
    const body = diagnostics
      .map((item) => `${item.file}:${item.line}:${item.column}  TS${item.code}  ${item.message}`)
      .join('\n')
    return {
      ok: true,
      output: `${diagnostics.length}${diagnostics.length >= MAX_DIAGNOSTICS ? '+' : ''} type error(s):\n${body}`,
      metadata: { count: diagnostics.length, scope: workspaceScope ? 'workspace' : 'file' },
    }
  }

  // definition / references need a position: explicit line/column, else a symbol in `path`.
  let offset: number | null = null
  if (
    file &&
    typeof request.line === 'number' &&
    Number.isFinite(request.line) &&
    request.line > 0
  ) {
    const index = lineIndex(session, file)
    if (!index) return { ok: false, output: `File not readable: ${wanted}`, metadata: {} }
    offset = offsetOf(index, Math.round(request.line), Math.round(request.column ?? 1))
  } else if (request.symbol?.trim()) {
    const symbol = request.symbol.trim()
    if (file) {
      offset = findIdentifierOffset(session, file, symbol)
      if (offset === null) {
        return {
          ok: false,
          output: `Symbol "${symbol}" does not appear in ${wanted}.`,
          metadata: {},
        }
      }
    } else {
      // 没有 path：跨文件按名字找声明，definition 直接用这个结果。
      const navigate = session.service.getNavigateToItems(symbol, MAX_SYMBOL_RESULTS, undefined, true, true)
      if (navigate.length === 0) {
        return { ok: false, output: `No declaration named "${symbol}" in this workspace.`, metadata: {} }
      }
      const first = navigate[0]
      if (!first) return { ok: false, output: `No declaration named "${symbol}".`, metadata: {} }
      const at = preview(session, first.fileName, first.textSpan.start)
      const where = `${relPath(root, first.fileName)}:${at.position.line}:${at.position.column}`
      if (request.action === 'definition') {
        return {
          ok: true,
          output: `${where}  ${symbol}\n  ${at.preview}`,
          metadata: { count: 1 },
        }
      }
      offset = first.textSpan.start
      const fromFile = first.fileName
      const refs = session.service.getReferencesAtPosition(fromFile, offset) ?? []
      const body = refs
        .map((ref) => {
          const hit = preview(session, ref.fileName, ref.textSpan.start)
          return `${relPath(root, ref.fileName)}:${hit.position.line}:${hit.position.column}  ${hit.preview}`
        })
        .join('\n')
      return {
        ok: true,
        output: `${refs.length} reference(s) to ${symbol} (declared at ${where}):\n${body}`,
        metadata: { count: refs.length },
      }
    }
  } else {
    return {
      ok: false,
      output: 'Provide path + symbol (or path + line/column) so the position is unambiguous.',
      metadata: {},
    }
  }

  if (offset === null) {
    return { ok: false, output: 'Could not resolve a position for this query.', metadata: {} }
  }

  if (request.action === 'definition') {
    const defs = session.service.getDefinitionAtPosition(file, offset) ?? []
    if (defs.length === 0) {
      return {
        ok: true,
        output: 'No definition found at this position (it may be a library type or a computed value).',
        metadata: { count: 0 },
      }
    }
    const seen = new Set<string>()
    const lines: string[] = []
    for (const def of defs) {
      const key = `${def.fileName}:${def.textSpan.start}`
      if (seen.has(key)) continue
      seen.add(key)
      const at = preview(session, def.fileName, def.textSpan.start)
      lines.push(`${relPath(root, def.fileName)}:${at.position.line}:${at.position.column}  ${at.preview}`)
    }
    return { ok: true, output: `Definition:\n${lines.join('\n')}`, metadata: { count: lines.length } }
  }

  const refs = session.service.getReferencesAtPosition(file, offset) ?? []
  if (refs.length === 0) {
    return { ok: true, output: 'No references found at this position.', metadata: { count: 0 } }
  }
  const lines = refs.map((ref) => {
    const at = preview(session, ref.fileName, ref.textSpan.start)
    return `${relPath(root, ref.fileName)}:${at.position.line}:${at.position.column}  ${at.preview}`
  })
  return {
    ok: true,
    output: `${refs.length} reference(s):\n${lines.join('\n')}`,
    metadata: { count: refs.length },
  }
}

/** Introspection for tests and diagnostics: what the service currently holds. */
export function codeIntelStatus(): Array<{ root: string; files: number; truncated: boolean }> {
  return [...sessions.values()].map((session) => ({
    root: session.root,
    files: session.files.length,
    truncated: session.truncated,
  }))
}

// ---------------------------------------------------------------------------
// 多语言路由
// ---------------------------------------------------------------------------

const MIX_TTL_MS = 60_000
const mixCache = new Map<string, { at: number; byExtension: Array<{ ext: string; count: number }> }>()

function mixKey(root: string): string {
  return process.platform === 'win32' ? root.toLowerCase() : root
}

/**
 * 工作区里的源文件扩展名分布（带 60s 缓存）。
 *
 * 只在不给 `path` 的查询里用到：symbols / 工程级 diagnostics 需要先知道
 * 「这个工作区主要是哪种语言」才能选对引擎。
 */
async function languageMix(root: string): Promise<Array<{ ext: string; count: number }>> {
  const key = mixKey(root)
  const cached = mixCache.get(key)
  if (cached && Date.now() - cached.at < MIX_TTL_MS) return cached.byExtension
  const extensions = new Set<string>(TS_EXTENSIONS)
  for (const spec of LANGUAGES) for (const ext of spec.extensions) extensions.add(ext)
  const scan = await scanSources(root, extensions, 3_000)
  mixCache.set(key, { at: Date.now(), byExtension: scan.byExtension })
  return scan.byExtension
}

function unsupportedMessage(file: string): string {
  const known = LANGUAGES.map((spec) => spec.extensions.join('/')).join(', ')
  return `code_intel cannot analyse ${file}. Supported: TypeScript/JavaScript, plus ${known} (which need a language server for exact results).`
}

/** 有 server 走 LSP；没有（或 server 起不来）退回结构化文本搜索，并说明原因。 */
async function runOtherLanguage(
  root: string,
  language: LanguageSpec,
  request: CodeIntelRequest,
): Promise<CodeIntelResult> {
  if (!discoverServer(root, language)) return runHeuristicCodeIntel(root, language, request)

  let result: CodeIntelResult
  try {
    result = await runLspCodeIntel(root, language, request)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const fallback = await runHeuristicCodeIntel(root, language, request)
    return {
      ...fallback,
      output: `${fallback.output}\n\nNote: the ${language.label} language server failed (${reason}), so this is a text-structure result.`,
    }
  }
  // server 找不到或握手失败：runLspCodeIntel 不抛"错误"而是回 unavailable，
  // 这时降级比把一句「不可用」交给模型有用。诊断除外——它真的需要 server。
  if (!result.metadata['unavailable']) return result
  const fallback = await runHeuristicCodeIntel(root, language, request)
  return {
    ...fallback,
    output: `${fallback.output}\n\nNote: ${result.output}`,
  }
}

/**
 * 执行一次代码智能查询。
 *
 * `root` 是工作区绝对路径；`path` 必须是工作区内的相对路径（越界一律拒绝，
 * 与读类工具同一口径）。
 *
 * 引擎选择：
 * 1. `request.language` 显式指定 -> 用它；
 * 2. 给了 `path` -> 按扩展名（TS/JS 走进程内 LanguageService）；
 * 3. 没给 `path` -> 按工作区里文件最多的语言。
 */
export async function runCodeIntel(root: string, request: CodeIntelRequest): Promise<CodeIntelResult> {
  const forced = request.language?.trim().toLowerCase() ?? ''
  if (forced) {
    if (forced === 'typescript' || forced === 'javascript') return runTsCodeIntel(root, request)
    const spec = languageById(forced as LanguageId)
    if (!spec) {
      return {
        ok: false,
        output: `Unknown language "${forced}". Known: typescript, ${LANGUAGES.map((item) => item.id).join(', ')}.`,
        metadata: { unsupported: true },
      }
    }
    return runOtherLanguage(root, spec, request)
  }

  const wanted = request.path?.trim() ?? ''
  if (wanted) {
    const file = absPath(root, wanted)
    if (isTypeScriptFile(file)) return runTsCodeIntel(root, request)
    const language = languageForFile(file)
    if (!language) return { ok: false, output: unsupportedMessage(wanted), metadata: { unsupported: true } }
    return runOtherLanguage(root, language, request)
  }

  const mix = await languageMix(root)
  if (mix.length === 0) {
    return { ok: false, output: 'No supported source files under the workspace root.', metadata: {} }
  }
  const tsCount = mix
    .filter((entry) => TS_EXTENSIONS.has(entry.ext))
    .reduce((total, entry) => total + entry.count, 0)
  const topOther = mix.find((entry) => !TS_EXTENSIONS.has(entry.ext))
  if (!topOther || tsCount >= topOther.count) return runTsCodeIntel(root, request)
  const language = languageForFile(`source.${topOther.ext}`)
  if (!language) return runTsCodeIntel(root, request)
  const result = await runOtherLanguage(root, language, request)
  return {
    ...result,
    metadata: {
      ...result.metadata,
      inferredLanguage: language.id,
      languageMix: mix.slice(0, 5),
    },
  }
}

/** 释放 TS 引擎与所有 LSP 子进程。进程退出或切换工作区时调。 */
export async function disposeAllCodeIntel(): Promise<void> {
  disposeCodeIntel()
  mixCache.clear()
  await disposeLsp()
}
