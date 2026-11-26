// code_intel 工具：definition / references / symbols / diagnostics，支持 TS/JS 与
// Python / Go / Java / Rust / C / C++ / Ruby / PHP / C#。
// 执行逻辑在 ../code-intel.ts（路由）与 ../lsp/*（language server + 降级），
// 这里只做参数解析、根目录解析与路径边界。
import type { AgentToolDefinition, ToolResult } from '../../../shared/types'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { CODE_INTEL } from './spec'
import type { ToolHost } from './spec'
import { rootFor } from './host'
import { runCodeIntel, type CodeIntelAction } from '../code-intel'

function inside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** 把工具参数里的 path 规范成「工作区内的相对路径」，越界就明确报错。 */
function relativeTarget(root: string, raw: string): string {
  const value = raw.trim()
  if (!value) return ''
  const absolute = isAbsolute(value) ? resolve(value) : resolve(root, value)
  if (!inside(root, absolute)) {
    throw new Error(
      `code_intel only reads files inside the workspace; ${value} is outside ${root}.`,
    )
  }
  return relative(root, absolute).split(sep).join('/')
}

export const codeIntelTools: AgentToolDefinition[] = [
  {
    name: CODE_INTEL,
    description:
      'Resolve code structure instead of text search: where a symbol is declared (definition), every place a symbol is used (references), every declaration matching a name (symbols), and type errors (diagnostics). TypeScript/JavaScript is answered in-process by the TS language service, so prefer it over search_files for exact file:line:column answers on TS/JS and for incremental diagnostics (tsc cold start takes tens of seconds). Python, Go, Java, Rust, C, C++, Ruby, PHP and C# are answered by a language server when one is installed in the workspace (node_modules/.bin) or on PATH; without a server the tool degrades to a language-aware structural search and says so in its output — diagnostics need a real server. Pass `language` to force an engine when the extension is ambiguous or no path is given.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['definition', 'references', 'symbols', 'diagnostics'],
          description:
            'definition = where the symbol at this position is declared; references = every use of it; symbols = declarations matching a name across the workspace; diagnostics = type errors.',
        },
        path: {
          type: 'string',
          description:
            'Workspace-relative file. Required for definition/references with symbol, and for file-scoped diagnostics.',
        },
        symbol: {
          type: 'string',
          description:
            'Symbol name to locate inside path. For action=symbols it is the name to search when query is absent.',
        },
        line: { type: 'number', description: '1-based line, when you know the exact position.' },
        column: { type: 'number', description: '1-based column, defaults to 1.' },
        query: { type: 'string', description: 'action=symbols: name or name fragment to match.' },
        scope: {
          type: 'string',
          enum: ['file', 'workspace'],
          description: 'action=diagnostics: check one file (default) or the whole workspace.',
        },
        language: {
          type: 'string',
          description:
            'Force an engine instead of inferring it from the file extension: typescript, python, go, java, rust, c, cpp, ruby, php, csharp.',
        },
        root: { type: 'string', description: 'Referenced workspace alias. Omit to use the current workspace.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    risk: 'read',
    source: 'builtin',
  },
]

const ACTIONS = new Set<CodeIntelAction>(['definition', 'references', 'symbols', 'diagnostics'])

export async function runCodeIntelTool(
  name: string,
  args: Record<string, unknown>,
  host: ToolHost,
  signal: AbortSignal,
): Promise<ToolResult | null> {
  if (name !== CODE_INTEL) return null
  if (signal.aborted) throw new Error('aborted')
  const rawAction = typeof args['action'] === 'string' ? (args['action'] as CodeIntelAction) : null
  if (!rawAction || !ACTIONS.has(rawAction)) {
    throw new Error('action must be one of definition, references, symbols, diagnostics')
  }
  const root = await rootFor(host, args)
  const path = typeof args['path'] === 'string' ? relativeTarget(root, args['path']) : ''
  const result = await runCodeIntel(root, {
    action: rawAction,
    ...(path ? { path } : {}),
    ...(typeof args['symbol'] === 'string' ? { symbol: args['symbol'] } : {}),
    ...(typeof args['query'] === 'string' ? { query: args['query'] } : {}),
    ...(typeof args['line'] === 'number' ? { line: args['line'] } : {}),
    ...(typeof args['column'] === 'number' ? { column: args['column'] } : {}),
    ...(args['scope'] === 'workspace' || args['scope'] === 'file'
      ? { scope: args['scope'] as 'file' | 'workspace' }
      : {}),
    ...(typeof args['language'] === 'string' ? { language: args['language'] } : {}),
  })
  return { ok: result.ok, output: result.output, metadata: result.metadata }
}
