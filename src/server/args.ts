/**
 * CLI argument parsing for `pilot` (server mode).
 *
 * Kept free of Node I/O so it can be unit tested. Every parser returns plain
 * data plus human-readable errors instead of calling `process.exit`.
 */
import type { ApprovalMode } from '../shared/types'

export interface ServeOptions {
  host: string
  port: number
  dataDir: string
  workspaces: string[]
  publicUrl: string
  relayUrl: string
  /** Print the panel URL and pairing link only, without starting anything. */
  checkOnly: boolean
  /**
   * 服务器模式：允许同局域网的其他机器访问并各自配对。默认关闭，只监听本机回环，
   * 防止误把控制台、工作区和模型 Key 暴露给同网络的任何设备。
   */
  serverMode: boolean
}

/**
 * One prompt, one process, no terminal UI: `pilot run "..."`.
 *
 * The model key comes from `PILOT_API_KEY` (see `env.ts`), so a container or CI
 * job needs no settings page and no click. `approvalMode` defaults to the
 * read-only `dontAsk` policy: an unattended run must not be able to approve its
 * own writes, and a caller that really wants edits passes `--approval`.
 */
export interface RunOptions {
  prompt: string
  /** Read the prompt from this file instead of argv (avoids shell quoting). */
  promptFile: string
  workspace: string
  dataDir: string
  approvalMode: ApprovalMode
  /** 0 keeps whatever the data directory has configured. */
  maxSteps: number
  /** Final result as one JSON object on stdout. */
  json: boolean
  /** Every RunEvent as one NDJSON line on stdout. */
  jsonEvents: boolean
  /** 0 means no wall-clock cap. */
  timeoutSec: number
  title: string
}

export function defaultRunOptions(): RunOptions {
  return {
    prompt: '',
    promptFile: '',
    workspace: '',
    dataDir: '',
    approvalMode: 'dontAsk',
    maxSteps: 0,
    json: false,
    jsonEvents: false,
    timeoutSec: 0,
    title: '',
  }
}

export interface ParsedArgs {
  command: 'serve' | 'run' | 'pair' | 'workspaces' | 'update' | 'help' | 'version'
  options: ServeOptions
  run: RunOptions
  errors: string[]
}

const APPROVAL_MODES: readonly ApprovalMode[] = [
  'dontAsk',
  'acceptEdits',
  'auto',
  'ask',
  'manual',
  'plan',
]

export const DEFAULT_PORT = 46231
/** 默认只听回环：本机浏览器直接可用，其他机器连不上。 */
export const DEFAULT_HOST = '127.0.0.1'
/** `--server` 时监听所有网卡，同局域网的其他机器才能连进来。 */
export const SERVER_MODE_HOST = '0.0.0.0'

const HELP = `Pilot 服务器模式

用法：
  pilot run "任务文字"      跑一次任务后退出（非交互；Key 读 PILOT_API_KEY）
  pilot serve [选项]        启动无界面服务，浏览器打开控制台面板
  pilot update            检查并增量升级服务器安装（只下载有变化的文件）
  pilot pair                请在 serve 运行的终端里输入 pair 生成新的配对链接
  pilot workspaces          列出已添加的工作区
  pilot plugin <子命令>     插件签名与信任（keygen / sign / trust / untrust / policy / list / verify）
  pilot solution <子命令>   行业方案包（plan / install / verify / inspect）
  pilot --help              显示本帮助
  pilot --version           显示版本

run 选项：
      --prompt <文字>       任务内容（也可直接写成第一个位置参数）
      --prompt-file <文件>  从文件读取任务内容（- 表示标准输入）
  -w, --workspace <目录>    在哪个目录里干活（默认当前目录）
  -d, --data-dir <目录>     数据目录（默认与 serve 相同）
      --approval <模式>     dontAsk（默认，只读）/ acceptEdits / auto / ask / manual / plan
      --max-steps <数量>    本次最多几步（默认沿用数据目录里的设置）
      --timeout <秒>        墙钟上限，超时取消本次任务（默认不限）
      --title <标题>        会话标题（默认取任务前 40 字）
      --json                结果以一个 JSON 对象输出
      --json-events         每个运行事件输出一行 NDJSON

run 退出码：
  0 完成   1 失败   2 用法或配置错误   3 未完成（步数/令牌上限、暂停、取消）   4 超时

serve 选项：
  -p, --port <端口>         监听端口（默认 ${DEFAULT_PORT}，占用时报错而不是换端口）
      --server              服务器模式：允许同局域网其他机器访问（默认只监听本机 ${DEFAULT_HOST}）
      --host <地址>         监听地址（默认 ${DEFAULT_HOST}；给了具体地址则不再按模式改）
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
    host: (env['PILOT_HOST'] ?? '').trim(),
    port: DEFAULT_PORT,
    dataDir: (env['PILOT_USER_DATA_DIR'] ?? '').trim(),
    workspaces: [],
    publicUrl: '',
    relayUrl: '',
    checkOnly: false,
    serverMode: ['1', 'true', 'yes'].includes(
      (env['PILOT_SERVER_MODE'] ?? '').trim().toLowerCase(),
    ),
  }
  let hostGiven = Boolean(options.host)
  if (!options.host) options.host = options.serverMode ? SERVER_MODE_HOST : DEFAULT_HOST
  let command: ParsedArgs['command'] = 'help'
  let hasCommand = false
  const run = defaultRunOptions()

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
      if (
        !hasCommand &&
        (flag === 'serve' || flag === 'run' || flag === 'pair' || flag === 'workspaces' || flag === 'update')
      ) {
        command = flag
        hasCommand = true
        continue
      }
      // `pilot run "修一下这个 bug"` — the first bare word is the task itself.
      if (command === 'run' && !run.prompt) {
        run.prompt = arg
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
      case 'server':
      case 'server-mode':
      case 'lan': {
        options.serverMode = true
        if (!hostGiven) options.host = SERVER_MODE_HOST
        break
      }
      case 'host': {
        const raw = taken()
        if (raw !== null) {
          options.host = raw
          hostGiven = true
        }
        break
      }
      case 'd':
      case 'data-dir': {
        const raw = taken()
        if (raw !== null) {
          options.dataDir = raw
          run.dataDir = raw
        }
        break
      }
      case 'w':
      case 'workspace': {
        const raw = taken()
        if (raw !== null) {
          options.workspaces.push(raw)
          if (!run.workspace) run.workspace = raw
        }
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
      case 'prompt': {
        const raw = taken()
        if (raw !== null) run.prompt = raw
        break
      }
      case 'prompt-file': {
        const raw = taken()
        if (raw !== null) run.promptFile = raw
        break
      }
      case 'approval': {
        const raw = taken()
        if (raw === null) break
        const mode = APPROVAL_MODES.find((entry) => entry === raw)
        if (!mode) errors.push(`未知审批模式：${raw}（可选 ${APPROVAL_MODES.join(' / ')}）`)
        else run.approvalMode = mode
        break
      }
      case 'max-steps': {
        const raw = taken()
        if (raw === null) break
        const value = Number(raw)
        if (!Number.isInteger(value) || value < 1 || value > 500) {
          errors.push(`--max-steps 必须是 1-500 的整数：${raw}`)
        } else run.maxSteps = value
        break
      }
      case 'timeout': {
        const raw = taken()
        if (raw === null) break
        const value = Number(raw)
        if (!Number.isFinite(value) || value < 0) errors.push(`--timeout 必须是非负秒数：${raw}`)
        else run.timeoutSec = value
        break
      }
      case 'title': {
        const raw = taken()
        if (raw !== null) run.title = raw
        break
      }
      case 'json':
        run.json = true
        break
      case 'json-events':
        run.jsonEvents = true
        break
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

  return { command, options, run, errors }
}
