// 没有 language server 时的降级：按语言的定义语法做结构化搜索，而不是盲目 grep。
//
// 明确的边界：这是文本启发式，不是语义分析。它知道「Python 的函数定义行长什么样」，
// 但不知道类型、重载、接口实现或作用域。因此：
// - definition / references / symbols 会给结果，但 metadata.engine = 'heuristic'；
// - diagnostics 直接回「不可用」，因为任何猜测都会让模型误以为代码有问题/没问题。
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import type {
  CodeIntelDiagnostic,
  CodeIntelRequest,
  CodeIntelResult,
} from '../code-intel-types'
import { installHints, scanSources, type LanguageId, type LanguageSpec } from './servers'

const MAX_RESULTS = 40
const MAX_FILES = 400
const MAX_REFERENCES = 200

/** `capture group 1 = 声明的名字`。按语言给出，避免用一套通用正则乱猜。 */
const DEFINITION_RULES: Record<LanguageId, RegExp[]> = {
  python: [
    /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/,
    /^\s*class\s+([A-Za-z_]\w*)/,
    /^([A-Za-z_]\w*)\s*(?::[^=\n]+)?=(?!=)/,
  ],
  go: [
    /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
    /^\s*type\s+([A-Za-z_]\w*)/,
    /^\s*(?:var|const)\s+([A-Za-z_]\w*)/,
  ],
  java: [
    /^\s*(?:(?:public|private|protected|static|final|abstract|sealed|non-sealed|strictfp)\s+)*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/,
    /^\s*(?:(?:public|private|protected|static|final|synchronized|abstract|native|default|strictfp)\s+)+(?:[\w<>\[\],.?]+\s+)?([A-Za-z_]\w*)\s*\(/,
    /^\s*(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?[\w<>\[\],.?]+\s+([A-Za-z_]\w*)\s*[;=]/,
  ],
  rust: [
    /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?fn\s+([A-Za-z_]\w*)/,
    /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|union|mod|type)\s+([A-Za-z_]\w*)/,
    /^\s*(?:pub(?:\([^)]*\))?\s+)?const\s+([A-Z_]\w*)/,
  ],
  c: [
    /^[A-Za-z_][\w\s*]*\s+\**([A-Za-z_]\w*)\s*\([^;]*\)\s*\{?\s*$/,
    /^\s*(?:typedef\s+)?(?:struct|union|enum)\s+([A-Za-z_]\w*)/,
    /^\s*#define\s+([A-Za-z_]\w*)/,
  ],
  cpp: [
    /^[A-Za-z_][\w\s*:<>,&]*\s+\**([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:const\s*)?\{?\s*$/,
    /^\s*(?:template\s*<[^>]*>\s*)?(?:class|struct|union|enum)\s+([A-Za-z_]\w*)/,
    /^\s*(?:using|typedef)\s+([A-Za-z_]\w*)\s*=/,
  ],
  ruby: [
    /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!]?)/,
    /^\s*(?:class|module)\s+([A-Z]\w*)/,
    /^([A-Z_]\w*)\s*=/,
  ],
  php: [
    /^\s*(?:(?:public|private|protected|static|final|abstract)\s+)*function\s+([A-Za-z_]\w*)/,
    /^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait|enum)\s+([A-Za-z_]\w*)/,
    /^\s*(?:public|private|protected)\s+(?:static\s+)?\$([A-Za-z_]\w*)/,
  ],
  csharp: [
    /^\s*(?:(?:public|private|protected|internal|static|sealed|abstract|partial|readonly|async|virtual|override)\s+)*(?:class|interface|enum|struct|record|delegate)\s+([A-Za-z_]\w*)/,
    /^\s*(?:(?:public|private|protected|internal|static|sealed|abstract|partial|readonly|async|virtual|override|extern|unsafe|new)\s+)+(?:[\w<>\[\],.?'\s]+?)\s+([A-Za-z_]\w*)\s*\(/,
  ],
  typescript: [],
}

/** 方法正则容易命中控制流关键字，统一挡掉。 */
const NOT_A_DECLARATION = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'sizeof',
  'else',
  'do',
  'try',
  'new',
  'delete',
  'throw',
  'using',
  'foreach',
  'lock',
])

const COMMENT_PREFIXES: Record<LanguageId, string[]> = {
  python: ['#'],
  go: ['//', '/*', '*'],
  java: ['//', '/*', '*'],
  rust: ['//', '/*', '*'],
  c: ['//', '/*', '*'],
  cpp: ['//', '/*', '*'],
  ruby: ['#'],
  php: ['//', '/*', '*', '#'],
  csharp: ['//', '/*', '*'],
  typescript: ['//', '/*', '*'],
}

interface Hit {
  file: string
  /** 声明名本身（capture group 1），而不是整行；definition 必须比这个字段。 */
  name: string
  line: number
  column: number
  preview: string
  kind: string
}

function toPosix(value: string): string {
  return value.split('\\').join('/')
}

function displayPath(root: string, file: string): string {
  const rel = relative(root, file)
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return toPosix(rel)
  return toPosix(file)
}

function commentPrefixes(language: LanguageSpec): string[] {
  return COMMENT_PREFIXES[language.id] ?? []
}

function isComment(trimmed: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => trimmed.startsWith(prefix))
}

async function collectFiles(root: string, language: LanguageSpec, only?: string): Promise<string[]> {
  if (only) return [only]
  const scan = await scanSources(root, new Set(language.extensions), MAX_FILES)
  return scan.files
}

function declarationsIn(text: string, language: LanguageSpec): Hit[] {
  const rules = DEFINITION_RULES[language.id] ?? []
  if (rules.length === 0) return []
  const prefixes = commentPrefixes(language)
  const hits: Hit[] = []
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const trimmed = line.trimStart()
    if (!trimmed || isComment(trimmed, prefixes)) continue
    for (const rule of rules) {
      const match = rule.exec(line)
      if (!match) continue
      const name = match[1]
      if (!name || NOT_A_DECLARATION.has(name)) continue
      const column = (match.index ?? 0) + match[0].indexOf(name) + 1
      hits.push({
        file: '',
        name,
        line: index + 1,
        column: Math.max(1, column),
        preview: trimmed.slice(0, 240),
        kind: rule.source.includes('class') || rule.source.includes('interface') ? 'class' : 'declaration',
      })
      break
    }
  }
  return hits
}

function header(language: LanguageSpec): string {
  return `Heuristic ${language.label} search (no ${language.label} language server installed; exact results need one: ${installHints(language)}).`
}

/** definition / references / symbols 的降级实现；diagnostics 由调用方挡在前面。 */
export async function runHeuristicCodeIntel(
  root: string,
  language: LanguageSpec,
  request: CodeIntelRequest,
): Promise<CodeIntelResult> {
  const wanted = request.path?.trim() ?? ''
  const file = wanted ? (isAbsolute(wanted) ? wanted : join(root, wanted)) : ''
  const prefixes = commentPrefixes(language)

  if (request.action === 'diagnostics') {
    return {
      ok: false,
      output: `${header(language)} Diagnostics need a language server: text search cannot tell a type error from a comment.`,
      metadata: { unavailable: true, needsServer: true, language: language.id, engine: 'heuristic' },
    }
  }

  if (request.action === 'symbols') {
    const query = (request.query ?? request.symbol ?? '').trim()
    const files = await collectFiles(root, language)
    const hits: Hit[] = []
    for (const target of files) {
      if (hits.length >= MAX_RESULTS) break
      let text = ''
      try {
        text = await readFile(target, 'utf8')
      } catch {
        continue
      }
      for (const hit of declarationsIn(text, language)) {
        if (query && !hit.name.includes(query)) continue
        hits.push({ ...hit, file: target })
        if (hits.length >= MAX_RESULTS) break
      }
    }
    if (hits.length === 0) {
      return {
        ok: true,
        output: `${header(language)}\nNo declarations matching "${query}".`,
        metadata: { count: 0, engine: 'heuristic', language: language.id },
      }
    }
    const lines = hits.map(
      (hit) =>
        `${displayPath(root, hit.file)}:${hit.line}:${hit.column}  ${hit.preview}`,
    )
    return {
      ok: true,
      output: `${header(language)}\n${hits.length} declaration(s) matching "${query}":\n${lines.join('\n')}`,
      metadata: { count: hits.length, engine: 'heuristic', language: language.id },
    }
  }

  const symbol = request.symbol?.trim() ?? ''
  if (!symbol && typeof request.line !== 'number') {
    return {
      ok: false,
      output: 'Heuristic search needs a symbol name (or path + line/column).',
      metadata: { engine: 'heuristic', language: language.id },
    }
  }

  if (request.action === 'definition') {
    const files = await collectFiles(root, language, file || undefined)
    if (file) {
      let text = ''
      try {
        text = await readFile(file, 'utf8')
      } catch {
        return { ok: false, output: `File not found or unreadable: ${wanted}`, metadata: {} }
      }
      // 比名字而不是比整行：Go 的 `func (s *Server) Start()` 里出现了 Server，
      // 但它声明的是 Start；用 preview.includes 会把 receiver / 参数 / 泛型当成定义。
      const hits = declarationsIn(text, language).filter((hit) => hit.name === symbol)
      if (hits.length === 0) {
        return {
          ok: true,
          output: `${header(language)}\nNo definition of "${symbol}" in ${displayPath(root, file)}.`,
          metadata: { count: 0, engine: 'heuristic', language: language.id },
        }
      }
      const lines = hits.map(
        (hit) => `${displayPath(root, file)}:${hit.line}:${hit.column}  ${hit.preview}`,
      )
      return {
        ok: true,
        output: `${header(language)}\nDefinition:\n${lines.join('\n')}`,
        metadata: { count: hits.length, engine: 'heuristic', language: language.id },
      }
    }

    const found: Hit[] = []
    for (const target of files) {
      let text = ''
      try {
        text = await readFile(target, 'utf8')
      } catch {
        continue
      }
      for (const hit of declarationsIn(text, language)) {
        // 只认同名声明；名字只在行内出现（receiver、参数、基类）不算定义。
        if (hit.name !== symbol) continue
        found.push({ ...hit, file: target })
        if (found.length >= MAX_RESULTS) break
      }
      if (found.length >= MAX_RESULTS) break
    }
    if (found.length === 0) {
      return {
        ok: true,
        output: `${header(language)}\nNo declaration named "${symbol}" in this workspace.`,
        metadata: { count: 0, engine: 'heuristic', language: language.id },
      }
    }
    const lines = found.map(
      (hit) => `${displayPath(root, hit.file)}:${hit.line}:${hit.column}  ${hit.preview}`,
    )
    return {
      ok: true,
      output: `${header(language)}\n${found.length} possible declaration(s) of "${symbol}":\n${lines.join('\n')}`,
      metadata: { count: found.length, engine: 'heuristic', language: language.id },
    }
  }

  // references：词边界匹配，跳过注释行。
  const files = await collectFiles(root, language, file || undefined)
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`(^|[^\\w$])${escaped}(?![\\w$])`)
  const hits: Hit[] = []
  let total = 0
  for (const target of files) {
    let text = ''
    try {
      text = await readFile(target, 'utf8')
    } catch {
      continue
    }
    const lines = text.split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? ''
      const trimmed = line.trimStart()
      if (isComment(trimmed, prefixes)) continue
      const match = pattern.exec(line)
      if (!match) continue
      total += 1
      if (hits.length >= MAX_REFERENCES) continue
      const column = match.index + match[1]!.length + 1
      hits.push({
        file: target,
        name: symbol,
        line: index + 1,
        column,
        preview: trimmed.slice(0, 240),
        kind: 'reference',
      })
    }
  }
  if (total === 0) {
    return {
      ok: true,
      output: `${header(language)}\nNo references to "${symbol}" found.`,
      metadata: { count: 0, engine: 'heuristic', language: language.id },
    }
  }
  const lines = hits.map(
    (hit) => `${displayPath(root, hit.file)}:${hit.line}:${hit.column}  ${hit.preview}`,
  )
  const more = total > hits.length ? `\n…${total - hits.length} more` : ''
  return {
    ok: true,
    output: `${header(language)}\n${total} reference(s) to ${symbol}:\n${lines.join('\n')}${more}`,
    metadata: { count: total, engine: 'heuristic', language: language.id },
  }
}
