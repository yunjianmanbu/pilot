/**
 * 轻量语法着色器（零依赖）。
 *
 * 只做一件事：把一段源码切成「普通文本 + 少量语义片段」，交给 CSS 上色
 * （类名 `tok-*`，色值来自 styles.css 的 `--syn-*`，因此跟随配色、明暗、
 * 对比度与饱和度设置）。刻意不做 HTML 注入，也不需要额外依赖，仅覆盖常见
 * 语言的关键字/字符串/注释/数字/函数调用。
 *
 * 认不出的语言返回 `null`，调用方按纯文本渲染。
 */
export type TokenKind = 'comment' | 'string' | 'number' | 'keyword' | 'function'

export type Token = { text: string; kind?: TokenKind }

type Language = {
  keywords: readonly string[]
  line: readonly string[]
  block?: readonly [string, string]
}

const JS_KEYWORDS = [
  'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
  'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends',
  'finally', 'for', 'from', 'function', 'get', 'if', 'implements', 'import', 'in',
  'instanceof', 'interface', 'let', 'new', 'of', 'readonly', 'return', 'satisfies',
  'set', 'static', 'super', 'switch', 'this', 'throw', 'try', 'type', 'typeof',
  'var', 'void', 'while', 'yield', 'true', 'false', 'null', 'undefined',
] as const

const PY_KEYWORDS = [
  'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def',
  'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if',
  'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise',
  'return', 'try', 'while', 'with', 'yield', 'True', 'False', 'None', 'self',
] as const

const SH_KEYWORDS = [
  'case', 'do', 'done', 'elif', 'else', 'esac', 'fi', 'for', 'function', 'if',
  'in', 'return', 'select', 'then', 'until', 'while', 'export', 'local', 'echo',
  'cd', 'set', 'unset', 'source', 'sudo', 'command', 'exit',
] as const

const GO_KEYWORDS = [
  'break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else',
  'fallthrough', 'for', 'func', 'go', 'goto', 'if', 'import', 'interface', 'map',
  'package', 'range', 'return', 'select', 'struct', 'switch', 'type', 'var',
  'true', 'false', 'nil',
] as const

const RUST_KEYWORDS = [
  'as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn', 'else',
  'enum', 'extern', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'match',
  'mod', 'move', 'mut', 'pub', 'ref', 'return', 'self', 'static', 'struct',
  'super', 'trait', 'type', 'unsafe', 'use', 'where', 'while', 'true', 'false',
] as const

const SQL_KEYWORDS = [
  'add', 'alter', 'and', 'as', 'asc', 'begin', 'by', 'case', 'column', 'commit',
  'create', 'delete', 'desc', 'distinct', 'drop', 'else', 'end', 'exists',
  'from', 'group', 'having', 'in', 'index', 'inner', 'insert', 'into', 'join',
  'left', 'like', 'limit', 'not', 'null', 'offset', 'on', 'or', 'order', 'outer',
  'primary', 'references', 'right', 'rollback', 'select', 'set', 'table', 'then',
  'union', 'unique', 'update', 'values', 'when', 'where',
] as const

const LANGUAGES: Record<string, Language> = {
  js: { keywords: JS_KEYWORDS, line: ['//'], block: ['/*', '*/'] },
  py: { keywords: PY_KEYWORDS, line: ['#'] },
  sh: { keywords: SH_KEYWORDS, line: ['#'] },
  go: { keywords: GO_KEYWORDS, line: ['//'], block: ['/*', '*/'] },
  rust: { keywords: RUST_KEYWORDS, line: ['//'], block: ['/*', '*/'] },
  sql: { keywords: SQL_KEYWORDS, line: ['--'], block: ['/*', '*/'] },
  // JSON 没有注释，但带注释的 JSONC 在配置里常见，按 JS 处理不会误伤。
  json: { keywords: ['true', 'false', 'null'], line: ['//'] },
  css: { keywords: [], line: [], block: ['/*', '*/'] },
  yaml: { keywords: ['true', 'false', 'null', 'yes', 'no'], line: ['#'] },
}

const ALIASES: Record<string, string> = {
  javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js', node: 'js',
  ts: 'js', typescript: 'js', tsx: 'js', jsonc: 'json', json5: 'json',
  python: 'py', py3: 'py', bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh',
  shellsession: 'sh', powershell: 'sh', ps1: 'sh', golang: 'go',
  rs: 'rust', postgres: 'sql', postgresql: 'sql', mysql: 'sql', sqlite: 'sql',
  scss: 'css', less: 'css', yml: 'yaml', toml: 'yaml', ini: 'yaml',
}

/** 超过这个长度就不着色：整段一次性跑正则，太长会拖慢消息渲染。 */
const MAX_LENGTH = 20000

const cache = new Map<string, RegExp>()

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function languageOf(name: string | undefined): Language | undefined {
  if (!name) return undefined
  const key = name.toLowerCase()
  return LANGUAGES[ALIASES[key] ?? key]
}

function patternOf(key: string, language: Language): RegExp {
  const cached = cache.get(key)
  if (cached) return cached
  const parts: string[] = []
  const comments: string[] = []
  for (const marker of language.line) comments.push(`${escapeRegExp(marker)}[^\\n]*`)
  if (language.block) {
    comments.push(`${escapeRegExp(language.block[0])}[\\s\\S]*?${escapeRegExp(language.block[1])}`)
  }
  if (comments.length > 0) parts.push(`(?<comment>${comments.join('|')})`)
  parts.push(
    '(?<string>"(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\'|`(?:\\\\.|[^`\\\\])*`)',
  )
  parts.push('(?<number>(?:0[xX][0-9a-fA-F]+|\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?))')
  if (language.keywords.length > 0) {
    const words = [...language.keywords].map(escapeRegExp).join('|')
    parts.push(`(?<keyword>\\b(?:${words})\\b)`)
  }
  parts.push('(?<function>\\b[A-Za-z_$][A-Za-z0-9_$]*(?=\\s*\\())')
  const pattern = new RegExp(parts.join('|'), 'g')
  cache.set(key, pattern)
  return pattern
}

function kindOf(groups: Record<string, string | undefined> | undefined): TokenKind | undefined {
  if (!groups) return undefined
  if (groups.comment) return 'comment'
  if (groups.string) return 'string'
  if (groups.number) return 'number'
  if (groups.keyword) return 'keyword'
  if (groups.function) return 'function'
  return undefined
}

/**
 * 切分源码。认不出的语言、空字符串、超长输入一律返回 `null`。
 */
export function highlightCode(code: string, language?: string): Token[] | null {
  if (!code || code.length > MAX_LENGTH) return null
  const normalized = language ? (ALIASES[language.toLowerCase()] ?? language.toLowerCase()) : ''
  const spec = languageOf(language)
  if (!spec) return null
  const pattern = patternOf(normalized, spec)
  const tokens: Token[] = []
  let last = 0
  for (const match of code.matchAll(pattern)) {
    const start = match.index ?? 0
    if (start > last) tokens.push({ text: code.slice(last, start) })
    tokens.push({ text: match[0], kind: kindOf(match.groups) })
    last = start + match[0].length
  }
  if (last < code.length) tokens.push({ text: code.slice(last) })
  return tokens.length > 0 ? tokens : null
}
