// 启动装配失败时的最后一道保险。
//
// `whenReady` 里任何一步抛错（主 store 损坏、回退点目录不可写、网关端口被占……）
// 都会让整个启动链中断：没有主窗口、没有托盘、也没有任何提示，用户只看到应用
// 静默退出。这时候唯一还能救场的是超级 Pilot —— 它有自己的数据面与引擎。
//
// 这个模块只负责「失败之后还能留一条入口」，所以三条依赖都是注入的，任何一条
// 自己抛错都不许影响另外两条：抢救时最怕的就是第一个动作失败、后面更重要的
// 动作没跑到。它不 import electron，可以单测。
import type { AppLogEntry } from './app-log'

export interface StartupFallbackDeps {
  /** 写应用日志；失败被吞掉，日志写不出来也不能让启动兜底再次抛错。 */
  log: (entry: AppLogEntry) => void
  /** 把失败原因记到超级 Pilot 的状态里，设置页与应急窗口都能看到。 */
  noteHostFailure: (message: string) => void
  /** 通道可能还没注册（失败点早于注册）；重复注册会抛，调用方自己兜。 */
  registerSuperIpc: () => void
  createTray: () => void
  openSuperWindow: (options: { theme: 'dark' | 'light' }) => unknown
  /** 主题只影响窗口底色：读不到就用深色。 */
  theme: () => 'dark' | 'light'
}

const MAX_DETAIL = 300

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 生成 `whenReady().catch(...)` 的处理函数。
 *
 * 它永远不抛：走到这里已经没有别的窗口能展示异常了，再抛一次只会换个地方静默。
 * 每一步单独兜住异常并各写一条日志，事后能看出「哪一条兜底动作也没成功」。
 */
export function createStartupFallback(deps: StartupFallbackDeps): (error: unknown) => void {
  const attempt = (event: string, task: () => void): void => {
    try {
      task()
    } catch (error) {
      try {
        deps.log({
          area: 'startup',
          event,
          level: 'error',
          detail: { message: messageOf(error).slice(0, MAX_DETAIL) },
        })
      } catch {
        // 日志自身不可用时无处可写，只能放弃。
      }
    }
  }

  return (error: unknown) => {
    const message = messageOf(error)
    attempt('startup.failed', () => {
      deps.log({
        area: 'startup',
        event: 'startup.failed',
        level: 'error',
        detail: { message: message.slice(0, MAX_DETAIL) },
      })
    })
    attempt('startup.note_failed', () => deps.noteHostFailure(`启动失败：${message}`))
    // 已注册过时 registerSuperIpc 会抛（同一 channel 已有 handler），属预期。
    attempt('startup.ipc_failed', () => deps.registerSuperIpc())
    attempt('startup.tray_failed', () => deps.createTray())
    attempt('startup.emergency_window_failed', () => {
      let theme: 'dark' | 'light' = 'dark'
      try {
        theme = deps.theme()
      } catch {
        theme = 'dark'
      }
      deps.openSuperWindow({ theme })
    })
  }
}
