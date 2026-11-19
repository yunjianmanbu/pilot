/**
 * CLI argument parsing for `pilot` (server mode).
 *
 * Kept free of Node I/O so it can be unit tested. Every parser returns plain
 * data plus human-readable errors instead of calling `process.exit`.
 */

export interface ServeOptions {
  host: string
  port: number
  dataDir: string
  workspaces: string[]
  publicUrl: string
  relayUrl: string
  /** Print the panel URL and pairing link only, without starting anything. */
  checkOnly: boolean
}

export interface ParsedArgs {
  command: 'serve' | 'pair' | 'workspaces' | 'update' | 'help' | 'version'
  options: ServeOptions
  errors: string[]
}

export const DEFAULT_PORT = 46231
export const DEFAULT_HOST = '0.0.0.0'

const HELP = `Pilot 服务器模式

用法：
  pilot serve [选项]        启动无界面服务，浏览器打开控制台面板
  pilot update            检查并增量升级服务器安装（只下载有变化的文件）
  pilot pair                请在 serve 运行的终端里输入 pair 生成新的配对链接
  pilot workspaces          列出已添加的工作区
  pilot plugin <子命令>     插件签名与信任（keygen / sign / trust / untrust / policy / list / verify）
  pilot solution <子命令>   行业方案包（plan / install / verify / inspect）
  pilot --help              显示本帮助
  pilot --version           显示版本

serve 选项：
  -p, --port <端口>         监听端口（默认 ${DEFAULT_PORT}，占用时报错而不是换端口）
      --host <地址>         监听地址（默认 ${DEFAULT_HOST}，仅本机可加 --host 127.0.0.1）
  -d, --data-dir <目录>     数据目录（默认 ~/.local/share/pilot、macOS 应用支持目录、%APPDATA%\\Pilot）
  -w, --workspace <目录>    添加为工作区，可重复；默认使用当前目录
      --public-url <地址>   外部访问地址，如 https://pilot.example.com/（用于配对链接）
      --relay-url <地址>    指定 Pilot Link 中继，如 wss://relay.example.com/ws
      --check               只校验参数与目录，不启动服务
  -h, --help                显示本帮助

环境变量：
  PILOT_API_KEY             模型 API Key（也可以在控制台设置页填写）
  PILOT_USER_DATA_DIR       等同 --data-dir
  PILOT_PORT                等同 --port
  PILOT_SERVER_UPDATE_URL   服务器版更新清单地址（默认为官方清单）
  PILOT_UPDATE_HOSTS        额外允许的更新下载域名，逗号分隔（自建镜像）
  PILOT_INSTALL_ROOT        要升级的安装目录（默认使用 PILOT_PACKAGE_ROOT）
`

export function helpText(): string {
  return HELP
}

function nextValue(argv: string[], index: number): string | null {
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('-')) return null
  return value
}

function parsePort(raw: string): number | null {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > 65_535) return null
  return value
}

/**
 * Parse a full argv (without the node/script prefix). Unknown flags are
 * reported instead of ignored so a typo cannot silently start the server on
 * the wrong port.
 */
export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): ParsedArgs {
  const errors: string[] = []
  const options: ServeOptions = {
    host: (env['PILOT_HOST'] ?? '').trim() || DEFAULT_HOST,
    port: DEFAULT_PORT,
    dataDir: (env['PILOT_USER_DATA_DIR'] ?? '').trim(),
    workspaces: [],
    publicUrl: '',
    relayUrl: '',
    checkOnly: false,
  }
  let command: ParsedArgs['command'] = 'help'
  let hasCommand = false

  const envPort = (env['PILOT_PORT'] ?? '').trim()
  if (envPort) {
    const parsed = parsePort(envPort)
    if (parsed === null) errors.push(`PILOT_PORT 不是合法端口：${envPort}`)
    else options.port = parsed
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    const flag = arg.startsWith('--') ? arg.slice(2) : arg.startsWith('-') ? arg.slice(1) : arg
    if (!arg.startsWith('-')) {
      if (!hasCommand && (flag === 'serve' || flag === 'pair' || flag === 'workspaces' || flag === 'update')) {
        command = flag
        hasCommand = true
        continue
      }
      errors.push(`无法识别的参数：${arg}`)
      continue
    }
    const taken = (): string | null => {
      const value = nextValue(argv, index)
      if (value === null) errors.push(`${arg} 需要一个值`)
      else index += 1
      return value
    }
    switch (flag) {
      case 'p':
      case 'port': {
        const raw = taken()
        if (raw === null) break
        const parsed = parsePort(raw)
        if (parsed === null) errors.push(`端口必须是 1-65535 的整数：${raw}`)
        else options.port = parsed
        break
      }
      case 'host': {
        const raw = taken()
        if (raw !== null) options.host = raw
        break
      }
      case 'd':
      case 'data-dir': {
        const raw = taken()
        if (raw !== null) options.dataDir = raw
        break
      }
      case 'w':
      case 'workspace': {
        const raw = taken()
        if (raw !== null) options.workspaces.push(raw)
        break
      }
      case 'public-url': {
        const raw = taken()
        if (raw === null) break
        try {
          const url = new URL(raw)
          if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            errors.push('--public-url 必须是 http:// 或 https:// 地址')
          } else {
            options.publicUrl = url.toString()
          }
        } catch {
          errors.push(`--public-url 不是合法地址：${raw}`)
        }
        break
      }
      case 'relay-url': {
        const raw = taken()
        if (raw === null) break
        try {
          const url = new URL(raw)
          if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
            errors.push('--relay-url 必须是 ws:// 或 wss:// 地址')
          } else {
            options.relayUrl = url.toString()
          }
        } catch {
          errors.push(`--relay-url 不是合法地址：${raw}`)
        }
        break
      }
      case 'check':
        options.checkOnly = true
        break
      case 'h':
      case 'help':
        command = 'help'
        hasCommand = true
        break
      case 'v':
      case 'version':
        command = 'version'
        hasCommand = true
        break
      default:
        errors.push(`未知选项：${arg}`)
        break
    }
  }

  return { command, options, errors }
}
