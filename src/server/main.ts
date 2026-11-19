/**
 * Pilot headless server entry (`pilot serve`).
 *
 * Starts the same HTTP + WebSocket control panel the desktop app serves to
 * phones (see `companion/server.ts`), but without Electron and without a
 * window. The panel is a PWA, so any browser that can reach the port can drive
 * the agent: sessions, streaming output, approvals, files, settings, billing.
 *
 * Differences from the desktop host, all deliberate:
 * - the port is fixed by the CLI and a busy port is a hard error;
 * - a pairing link is printed on the terminal instead of shown in the window;
 * - screen capture needs a desktop session, so it is unavailable; the updater
 *   works, but replaces files in the install tree and needs a restart
 *   (see `src/server/update.ts`).
 */
import { existsSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { stat } from 'node:fs/promises'
import { createEngine, checkpointBridge, changesBridge } from '../core/engine'
import { createEvolutionControls } from '../core/evolution'
import { CompanionServer } from '../main/companion/server'
import { ModuleCheckService } from '../main/module-check'
import { Store } from '../main/store'
import { SERVER_CAPABILITIES } from '../shared/capabilities'
import { helpText, parseArgs, type ServeOptions } from './args'
import { CONSOLE_HELP, parseConsoleCommand } from './console'
import { applyModelEnv } from './env'
import { DEFAULT_SERVER_MANIFEST_URL, ServerUpdater, TRUSTED_SERVER_HOSTS } from './update'
import type { CompanionPairRequest, CompanionStatus, RunEvent } from '../shared/types'

const VERSION = process.env['PILOT_VERSION'] ?? '0.1.0'

/** Same layout the Electron build uses, for a machine with no desktop session. */
export function defaultDataDir(): string {
  const home = homedir()
  if (process.platform === 'win32') {
    return join((process.env['APPDATA'] ?? '').trim() || home, 'Pilot')
  }
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Pilot')
  }
  const xdg = (process.env['XDG_DATA_HOME'] ?? '').trim()
  return join(xdg || join(home, '.local', 'share'), 'pilot')
}

/** Resolve the data directory once and publish it to the electron shim. */
function applyDataDir(override: string): string {
  const dir = override.trim() || (process.env['PILOT_USER_DATA_DIR'] ?? '').trim() || defaultDataDir()
  process.env['PILOT_USER_DATA_DIR'] = dir
  return dir
}

/** Install root that the release manifest paths are relative to. */
function installRoot(): string {
  return (
    (process.env['PILOT_PACKAGE_ROOT'] ?? '').trim() ||
    (process.env['PILOT_INSTALL_ROOT'] ?? '').trim() ||
    resolve(process.cwd())
  )
}

/** Extra trusted hosts so a self-hosted mirror works without weakening HTTPS checks. */
function extraUpdateHosts(): string[] {
  return (process.env['PILOT_UPDATE_HOSTS'] ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host.length > 0)
}

function log(message: string): void {
  process.stdout.write(`${message}\n`)
}

/** Print the pairing URL in the terminal, plus the panel address. */
async function printPairing(companion: CompanionServer, panelUrl: string): Promise<void> {
  const pairing = await companion.createPairing()
  const minutes = Math.max(1, Math.round((new Date(pairing.expiresAt).getTime() - Date.now()) / 60_000))
  log('')
  log(`  控制台地址  ${panelUrl}`)
  log(`  配对链接    ${pairing.url}`)
  log(`  有效期      ${minutes} 分钟（在浏览器打开链接即可登录控制台）`)
  log('')
  log('  提示：链接包含一次性配对凭据，只发给自己。过期后在终端输入 pair 重新生成。')
  log('')
}

async function resolveWorkspaceInputs(options: ServeOptions): Promise<string[]> {
  const candidates = options.workspaces.length ? options.workspaces : [process.cwd()]
  const resolved: string[] = []
  for (const candidate of candidates) {
    const path = isAbsolute(candidate) ? candidate : resolve(process.cwd(), candidate)
    let info
    try {
      info = await stat(path)
    } catch {
      throw new Error(`工作区目录不存在：${path}`)
    }
    if (!info.isDirectory()) throw new Error(`工作区必须是目录：${path}`)
    resolved.push(path)
  }
  return resolved
}

async function serve(options: ServeOptions): Promise<void> {
  // The electron shim reads this on every call, but resolving it up front keeps
  // error messages (and `--check`) honest about the directory that will be used.
  const dataDir = applyDataDir(options.dataDir)
  const workspaces = await resolveWorkspaceInputs(options)

  if (options.checkOnly) {
    log(`数据目录    ${dataDir}`)
    for (const path of workspaces) log(`工作区      ${path}`)
    log(`监听        ${options.host}:${options.port}`)
    if (options.publicUrl) log(`外部地址    ${options.publicUrl}`)
    log('参数校验通过，未启动服务。')
    return
  }

  const store = new Store()
  await store.load()
  for (const path of workspaces) {
    const existing = store.workspaces().some((workspace) => workspace.path === path)
    // The first workspace becomes active; the rest are only registered so the
    // console can switch to them.
    if (!existing) await store.addWorkspace(path, { activate: workspaces[0] === path })
    // `-w` is the operator granting this directory in the browser console: from
    // there the panel can also create and remove workspaces underneath it.
    await store.addPhoneRoot(path)
  }
  if (!store.activeWorkspace()) {
    const first = store.workspaces()[0]?.path
    if (first) store.setActiveWorkspace(first)
  }

  // A headless deployment has no desktop settings page, so the model endpoint
  // and key must be settable from the environment. Values are only written when
  // the variable is actually present, so a data directory keeps what it has.
  const applied = await applyModelEnv(store)
  if (applied?.apiKey) log('  已应用环境变量 PILOT_API_KEY（不会回显）。')

  const publish = (event: RunEvent): void => {
    companion?.publish(event)
  }

  // One assembly path for both hosts: `src/core/engine.ts`. What is left here
  // is host-specific — the fixed port, the terminal pairing prompt, the file
  // updater and the capability set a headless process can honour.
  const engine = createEngine({ store, dataDir, publish })
  const { billing, checkpoints, runner, scheduler } = engine
  const moduleCheck = new ModuleCheckService({
    userDataDir: dataDir,
    // 无桌面会话的宿主没有额外的内置源码副本：安装目录本身就是它的源码树。
    sourceRoot: () => {
      const bundled = join(installRoot(), 'source')
      return existsSync(bundled) ? bundled : installRoot()
    },
    emit: publish,
    startSession: async (workspacePath, prompt) => {
      // Same path as a user-written task: ordinary session, sandbox and approvals.
      const created = await store.createSession(workspacePath)
      try {
        await runner.sendMessage(created.id, prompt, 'queue')
        return { sessionId: created.id }
      } catch (error) {
        // A missing model key is recoverable: keep the confirmed list in the queue.
        const message = error instanceof Error ? error.message : ''
        if (!/API key/i.test(message)) throw error
        const current = store.session(created.id)
        await store.setQueue(created.id, [
          ...(current?.queue ?? []),
          { id: `mc_${Date.now()}`, content: prompt, createdAt: new Date().toISOString() },
        ])
        const queue = store.session(created.id)?.queue ?? []
        publish({ type: 'queue.changed', sessionId: created.id, queue })
        return { sessionId: created.id, queued: true }
      }
    },
  })
  await moduleCheck.load()

  const panelUrl = (): string => {
    if (options.publicUrl) return options.publicUrl
    // status().address is the LAN address a remote browser can actually use.
    const reachable = companion?.status().address ?? ''
    if (reachable) return reachable
    const host = options.host === '0.0.0.0' || options.host === '::' ? '127.0.0.1' : options.host
    return `http://${host}:${options.port}/`
  }

  let companion: CompanionServer | null = null
  /** The phone the console is currently being asked about, if any. */
  let pendingPairRequest: CompanionPairRequest | null = null
  const assetsDir = resolve(process.env['PILOT_PANEL_DIR'] ?? 'companion')
  if (!existsSync(join(assetsDir, 'index.html'))) {
    throw new Error(`找不到控制台面板资源：${assetsDir}（应包含 index.html）`)
  }

  // Incremental self-update for the server install. Only the files whose
  // SHA-256 changed are downloaded, so a release that touches one bundle costs
  // one bundle instead of the whole tree.
  const updater = new ServerUpdater({
    root: installRoot(),
    currentVersion: VERSION,
    manifestUrl:
      (process.env['PILOT_SERVER_UPDATE_URL'] ?? '').trim() || DEFAULT_SERVER_MANIFEST_URL,
    extraHosts: extraUpdateHosts(),
    onChange: (state) => companion?.publish({ type: 'update.changed', state }),
  })

  companion = new CompanionServer({
    store,
    runner,
    billing,
    checkpoints: checkpointBridge(engine),
    changes: changesBridge(engine),
    capabilities: SERVER_CAPABILITIES,
    moduleCheck: {
      // 展示用的扫描根：与自检实际扫描的内置源码目录一致。
      source: () => (existsSync(join(installRoot(), 'source')) ? join(installRoot(), 'source') : installRoot()),
      // 手机只消费摘要；返回 snapshot() 会白拷贝整份历史报告。
      state: async () => moduleCheck.summary(),
      discover: () => moduleCheck.discover(),
      run: (moduleIds) => moduleCheck.run(moduleIds, 'manual'),
      settings: (input) => moduleCheck.updateSettings(input),
      accept: async (reportId, riskIds, selfModify) => {
        const result = await moduleCheck.accept(reportId, riskIds, { selfModify: selfModify === true })
        return {
          ...(result.sessionId ? { sessionId: result.sessionId } : {}),
          queued: result.queued === true,
          selfModify: result.selfModify,
          proposalId: result.proposalId,
        }
      },
    },
    update: {
      state: () => updater.stateSnapshot(),
      check: () => updater.check(),
      download: () => updater.download(),
      install: async () => {
        await updater.install()
      },
    },
    // Same controls as the desktop panel. Cycles and policy versions only need
    // the store, so they work headless; the personal fork has no pristine source
    // tree here and answers with a message that says so (`capabilities.personal`).
    evolution: createEvolutionControls({ store, runner, publish }),
    dataDir,
    assetsDir,
    deviceName: hostname(),
    appVersion: VERSION,
    relayUrl: options.relayUrl || (process.env['PILOT_RELAY_URL'] ?? '').trim() || undefined,
    // The console is served by this process, so pairing links point at it.
    // An empty appUrl makes the server fall back to its LAN address.
    appUrl: options.publicUrl || '',
    port: options.port,
    // `pilot serve --workspace a --workspace b` registers several workspaces;
    // plugins come from the active one, same as the desktop app.
    pluginRoot: workspaces[0],
    host: options.host,
    strictPort: true,
    // The browser console mirrors the PC client's look, not the phone PWA's.
    surface: 'desktop',
    publicBaseUrl: options.publicUrl || undefined,
    onStatus: (status: CompanionStatus) => {
      if (status.error) log(`  [控制台] ${status.error}`)
    },
    onEvent: (event) => {
      // A phone that scanned the QR code waits for a person here: the terminal
      // is this deployment's desktop, so `allow` / `deny` answer it.
      if (event.type === 'companion.pair_request') {
        pendingPairRequest = event.request
        log('')
        log(`  [配对请求] ${event.request.name}（${event.request.platform}）`)
        log(
          `    来源：${event.request.via === 'relay' ? '云端中继' : `局域网 ${event.request.address ?? '未知地址'}`}`,
        )
        log(
          `    输入 allow 允许，或 deny 拒绝；${new Date(event.request.expiresAt).toLocaleTimeString('zh-CN')} 前未选择则自动拒绝。`,
        )
        return
      }
      if (event.type === 'companion.pair_resolved') {
        pendingPairRequest = null
        log(event.approved ? '  [配对请求] 已允许。' : `  [配对请求] 已拒绝：${event.reason ?? ''}`)
      }
    },
  })

  await companion.init()
  await companion.start()

  scheduler.start()
  moduleCheck.start()

  const status = companion.status()
  log('')
  log(`Pilot ${VERSION} 服务器模式已启动`)
  log(`  数据目录    ${dataDir}`)
  log(`  监听地址    ${options.host}:${status.port}`)
  for (const path of workspaces) log(`  工作区      ${path}`)
  if (!store.getApiKey()) {
    log('')
    log('  尚未配置模型 API Key：用环境变量 PILOT_API_KEY 启动，或在终端输入 apikey <key> 设置。')
  }

  await printPairing(companion, panelUrl())

  const shutdown = async (signal: string): Promise<void> => {
    log(`收到 ${signal}，正在停止…`)
    scheduler.stop()
    moduleCheck.stop()
    await store.flush().catch(() => undefined)
    await companion?.stop().catch(() => undefined)
    checkpoints.dispose()
    await runner.shutdown().catch(() => undefined)
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  // The console also answers piped input (`printf 'apikey sk-…\n' | pilot serve`),
  // which is how containers and service managers configure a key without a TTY.
  if (process.stdin.isTTY || process.stdin.readable) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.on('line', (raw) => {
      const command = parseConsoleCommand(raw)
      switch (command.kind) {
        case 'empty':
          return
        case 'apikey-show':
          log(
            store.getApiKey() ?
              '  已配置模型 API Key。输入 apikey <key> 替换，apikey clear 清除。'
            : '  尚未配置模型 API Key：输入 apikey <key> 设置。',
          )
          return
        case 'apikey-set':
        case 'apikey-clear': {
          const value = command.kind === 'apikey-set' ? command.key : null
          store
            .updateSettings({ apiKey: value })
            .then(() =>
              log(value ? '  模型 API Key 已保存，新会话立即生效。' : '  模型 API Key 已清除。'),
            )
            .catch((error: unknown) =>
              log(`  保存失败：${error instanceof Error ? error.message : String(error)}`),
            )
          return
        }
        case 'pair':
          printPairing(companion!, panelUrl()).catch((error: unknown) =>
            log(`生成配对链接失败：${error instanceof Error ? error.message : String(error)}`),
          )
          return
        case 'pair-allow':
        case 'pair-deny': {
          if (!pendingPairRequest) {
            log('  当前没有等待确认的配对请求。手机扫码后会在这里提示。')
            return
          }
          const approved = command.kind === 'pair-allow'
          if (!companion!.resolvePairing(pendingPairRequest.requestId, approved)) {
            log('  该配对请求已失效（可能已超时），请让手机重新扫码。')
          }
          pendingPairRequest = null
          return
        }
        case 'status': {
          const current = companion!.status()
          log(
            `运行中=${current.running} 端口=${current.port ?? '-'} 地址=${current.address ?? '-'} 已配对=${current.phones.length} 中继=${current.relayConnected ? '已连接' : '未连接'}`,
          )
          return
        }
        case 'workspaces':
          for (const workspace of store.workspaces()) log(`  ${workspace.path}`)
          return
        case 'update': {
          // Progress goes to the terminal as well: a server install is usually
          // upgraded over SSH, where the browser panel may not be open.
          log('  正在检查更新…')
          const stop = updater.subscribe((state) => {
            if (state.status === 'downloading' && state.total > 0) {
              const percent = Math.round(state.progress * 100)
              log(`  下载中 ${percent}%（${state.transferred}/${state.total} 字节）`)
            }
          })
          updater
            .runNow()
            .then((state) => log(`  ${state.message}`))
            .catch((error: unknown) =>
              log(`  升级失败：${error instanceof Error ? error.message : String(error)}`),
            )
            .finally(stop)
          return
        }
        case 'help':
          log(CONSOLE_HELP)
          return
        case 'quit':
          void shutdown('quit')
          return
        default:
          log(`未知命令：${command.input}。输入 help 查看可用命令。`)
      }
    })
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)
  // Plugin signing and solution installs are workspace management, not servers;
  // they run before argument parsing so `pilot` stays a single entry point.
  if (command === 'plugin' || command === 'solution') {
    const { runPluginCommand } = await import('../main/plugins/cli')
    process.exitCode = await runPluginCommand(command, rest)
    return
  }
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed.command === 'help') {
    process.stdout.write(helpText())
    return
  }
  if (parsed.command === 'version') {
    log(`pilot ${VERSION}`)
    return
  }
  if (parsed.errors.length) {
    for (const error of parsed.errors) process.stderr.write(`错误：${error}\n`)
    process.stderr.write('\n用 `pilot --help` 查看用法。\n')
    process.exitCode = 2
    return
  }
  if (parsed.command === 'update') {
    await runUpdateCommand(parsed.options)
    return
  }
  await serve(parsed.options)
}

/**
 * `pilot update`: the same incremental upgrade the browser panel offers, but
 * scriptable — cron and CI can run it and the server picks the new code up on
 * its next restart.
 */
async function runUpdateCommand(options: ServeOptions): Promise<void> {
  applyDataDir(options.dataDir)
  const updater = new ServerUpdater({
    root: installRoot(),
    currentVersion: VERSION,
    manifestUrl:
      (process.env['PILOT_SERVER_UPDATE_URL'] ?? '').trim() || DEFAULT_SERVER_MANIFEST_URL,
    extraHosts: extraUpdateHosts(),
    onChange: (state) => {
      if (state.status === 'downloading' && state.total > 0) {
        const percent = Math.round(state.progress * 100)
        process.stdout.write(`\r  下载中 ${percent}%（${state.transferred}/${state.total} 字节）`)
      }
    },
  })
  log(`Pilot ${VERSION} · 安装目录 ${installRoot()}`)
  log('正在检查更新…')
  const state = await updater.runNow()
  process.stdout.write('\n')
  log(`\n${state.message}`)
  if (state.status === 'error') process.exitCode = 1
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`启动失败：${message}\n`)
  process.exit(1)
})
