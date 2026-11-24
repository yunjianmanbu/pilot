// 桌面端把两个开关合并到同一个服务实例上：设置里的「网页服务」
// （`serverMode` / `serverPort`，存在应用设置里）与「手机连接」
// （`CompanionServer` 自己持久化的 `state.enabled`）。
//
// 任一为真就监听，端口以网页服务的设置为准——否则两个开关各自 start/stop
// 同一个实例，后按的那个会把前一个踢掉。`pilot serve` 不经过这里：它由一个
// 固定的 CLI 端口加 `strictPort` 启动。
import type { CompanionStatus } from '../../shared/types'
import type { CompanionServer } from './server'

export interface CompanionModeControl {
  /** 启动时按已存设置对齐一次。 */
  init(): Promise<CompanionStatus>
  /** 「手机连接」开关；与网页服务合并决定服务是否运行。 */
  setPhoneEnabled(enabled: boolean): Promise<CompanionStatus>
  /** 设置保存后同步（开关与端口都可能变）。 */
  syncFromSettings(): Promise<CompanionStatus>
}

/**
 * 关掉网页服务时收回在网页里发出的凭据。
 *
 * 只让静态页面返回「已关闭」不够：已经打开的标签页手里还握着 `/bridge`
 * token，刷新前仍能调整份 IPC 表。手机（`via: 'phone'`）是另一套入口，这里
 * 只清理 `via: 'browser'` 的记录，不影响「手机连接」这个开关。
 */
async function revokeBrowserSessions(server: CompanionServer): Promise<void> {
  const ids = Object.values(server.state.phones)
    .filter((phone) => phone.via === 'browser')
    .map((phone) => phone.phoneId)
  for (const id of ids) await server.revoke(id)
}

/**
 * 主进程的报错文案是给 CLI 写的（叫用户改 `--port`），而走到这里的只有桌面
 * 设置页。端口占用是这条路上最常撞到的一种，换成指向设置页的说法。
 */
function desktopErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace('请用 --port 指定其它端口', '请在设置里换一个端口')
}

export function createCompanionModeControl(
  server: CompanionServer,
): CompanionModeControl {
  /**
   * 上次交给监听器的端口来源：只有它变了才值得停一次再起。
   *
   * 不能拿「实际监听端口」比：端口被占用时 `start()` 会回退到系统分配的端口，
   * 每保存一次设置就会重启一次，界面上的地址也跟着抖。
   */
  let requestedPort: number | null = null
  /** 串行化：连点开关时两条 start/stop 不能交错。 */
  let queue: Promise<unknown> = Promise.resolve()

  const run = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task)
    queue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  async function apply(): Promise<CompanionStatus> {
    const settings = server.options.store.settings()
    if (settings.serverMode !== true) await revokeBrowserSessions(server)
    const wantedPort = settings.serverMode ? settings.serverPort : null
    const wantRun = server.state.enabled || settings.serverMode
    const running = server.listeningPort() !== null
    if (!wantRun) {
      if (running) await server.stop()
      requestedPort = null
      server.emitStatus()
      return server.status()
    }
    // 已经在要的端口上监听：不必重启，否则会把正在用这个页面的连接踢掉
    // （在浏览器里点一下「网页服务」开关就断线）。
    if (running && wantedPort !== null && server.listeningPort() === wantedPort) {
      requestedPort = wantedPort
      server.emitStatus()
      return server.status()
    }
    if (running && requestedPort !== wantedPort) await server.stop()
    // `start()` 用它覆盖持久化端口；关掉网页服务时回到 `state` 里记的端口。
    server.options.port = wantedPort ?? undefined
    // 在设置页指定了端口就期望是这个端口：被占用时报错比默默换一个更可解释。
    // 只开「手机连接」时保持原来的回退行为（随机端口也能用）。
    server.options.strictPort = settings.serverMode === true
    try {
      await server.start()
      requestedPort = wantedPort
    } catch (error) {
      // 与 `setEnabled` 一样：启动失败记在状态里给设置页看，不抛到调用方，
      // 否则保存设置会整条失败，用户也看不到原因。
      server.lastError = desktopErrorText(error)
    }
    server.emitStatus()
    return server.status()
  }

  return {
    init: () => run(apply),
    setPhoneEnabled(enabled: boolean) {
      return run(async () => {
        server.state.enabled = enabled === true
        await server.saveNow()
        return apply()
      })
    },
    syncFromSettings: () => run(apply),
  }
}
