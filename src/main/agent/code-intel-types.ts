// code_intel 的公共类型。放在独立文件里，让 TypeScript 引擎（code-intel.ts）
// 与其它语言的 LSP 实现（lsp/intel.ts）共享同一套请求/结果形状而不互相 import。

export type CodeIntelAction = 'definition' | 'references' | 'symbols' | 'diagnostics'

export interface CodeIntelRequest {
  action: CodeIntelAction
  /** Workspace-relative file, used to resolve a symbol to a position. */
  path?: string
  /** Symbol name to locate inside `path` (or across the project for action=symbols). */
  symbol?: string
  /** Explicit 1-based position; wins over `symbol`. */
  line?: number
  column?: number
  /** Name filter for action=symbols; falls back to `symbol`. */
  query?: string
  /** action=diagnostics: check the whole project instead of one file. */
  scope?: 'file' | 'workspace'
  /** Force a language instead of inferring it from the file extension. */
  language?: string
}

export interface CodeIntelPosition {
  /** Workspace-relative path with forward slashes. */
  file: string
  /** 1-based line. */
  line: number
  /** 1-based column. */
  column: number
  /** The source line, trimmed and length-capped. */
  preview: string
  /** TypeScript symbol kind name, when the query resolved to a declaration. */
  kind?: string
}

export interface CodeIntelDiagnostic {
  file: string
  line: number
  column: number
  severity: 'error' | 'warning'
  message: string
  code: number
}

export interface CodeIntelResult {
  ok: boolean
  output: string
  metadata: Record<string, unknown>
}
