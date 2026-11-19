/**
 * Interactive console commands for `pilot serve`.
 *
 * The server reads commands from the controlling terminal (`pair`, `status`,
 * `apikey`, `workspaces`, `help`, `quit`). Parsing lives here, free of I/O, so
 * the key handling can be tested without a TTY — and so a mistyped command can
 * never be mistaken for a secret.
 */

export type ConsoleCommand =
  | { kind: 'empty' }
  | { kind: 'pair' }
  | { kind: 'status' }
  | { kind: 'workspaces' }
  /** Approve the phone that is waiting for the desktop answer. */
  | { kind: 'pair-allow' }
  /** Reject the phone that is waiting for the desktop answer. */
  | { kind: 'pair-deny' }
  /** Check for a new server version, download only the changed files, install. */
  | { kind: 'update' }
  | { kind: 'help' }
  | { kind: 'quit' }
  /** `apikey` with no value: report whether a key is configured. */
  | { kind: 'apikey-show' }
  /** `apikey clear`: remove the stored key. */
  | { kind: 'apikey-clear' }
  /** `apikey <key>`: store exactly what was typed, case preserved. */
  | { kind: 'apikey-set'; key: string }
  | { kind: 'unknown'; input: string }

export function parseConsoleCommand(raw: string): ConsoleCommand {
  const line = raw.trim()
  if (!line) return { kind: 'empty' }

  // API keys are case sensitive, so this branch never goes through lowercasing.
  const keyMatch = /^apikey\b(.*)$/i.exec(line)
  if (keyMatch) {
    const value = (keyMatch[1] ?? '').trim()
    if (!value) return { kind: 'apikey-show' }
    if (value.toLowerCase() === 'clear') return { kind: 'apikey-clear' }
    return { kind: 'apikey-set', key: value }
  }

  switch (line.toLowerCase()) {
    case 'pair':
      return { kind: 'pair' }
    case 'status':
      return { kind: 'status' }
    case 'workspaces':
      return { kind: 'workspaces' }
    case 'allow':
    case 'approve':
      return { kind: 'pair-allow' }
    case 'deny':
    case 'reject':
      return { kind: 'pair-deny' }
    case 'update':
    case 'upgrade':
      return { kind: 'update' }
    case 'help':
    case '?':
      return { kind: 'help' }
    case 'quit':
    case 'exit':
      return { kind: 'quit' }
    default:
      return { kind: 'unknown', input: line }
  }
}

export const CONSOLE_HELP =
  '可用命令：pair（新配对链接） allow（允许正在等待的手机配对） deny（拒绝该手机） status（运行状态） apikey（模型密钥） workspaces（工作区） update（增量升级服务器） quit（退出）'
