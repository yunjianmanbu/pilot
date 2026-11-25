// 超级 Pilot 的 IPC：**独立注册**，不挂在 `registerAllIpc()` 里。
//
// 理由很实际：`registerAllIpc` 依赖主引擎装好了的大部分服务，而这条通道的全部
// 意义就是「主引擎坏了也要能用」。所以它在 `whenReady` 里最先注册，只依赖
// `appState.superPilot`（一个不同步读盘的构造对象）与 `appState.store`（只用来
// 取主题，取不到就用深色）。
import { appState } from '../app-state'
import { createIpcContext } from '../ipc-context'
import { openSuperWindow } from '../super-window'
import type {
  SuperPilotMessage,
  SuperPilotRescueResult,
  SuperPilotStatus,
} from '../../shared/super'

/** 主窗口与超级窗口都会调的「打开」：桌面端的应急入口。 */
export function registerSuperIpc(): void {
  const ctx = createIpcContext()

  ctx.handle('pilot:super-open', () => {
    // 主题只影响窗口底色，读不到就用深色：这里是应急路径，不能因为一次设置
    // 读取失败就打不开窗口。
    let theme: 'dark' | 'light' = 'dark'
    try {
      theme = appState.store ? appState.store.settings().theme : 'dark'
    } catch {
      theme = 'dark'
    }
    const window = openSuperWindow({ theme })
    return { ok: true, windowId: window.id }
  })

  ctx.handle('pilot:super-status', async (): Promise<SuperPilotStatus | { error: string }> => {
    const pilot = appState.superPilot
    if (!pilot) return { error: '超级 Pilot 未装配' }
    return pilot.status()
  })

  ctx.handle('pilot:super-messages', async (): Promise<SuperPilotMessage[]> => {
    const pilot = appState.superPilot
    if (!pilot) return []
    return pilot.messages()
  })

  ctx.handle('pilot:super-send', async (prompt: unknown) => {
    const pilot = appState.superPilot
    if (!pilot) return { ok: false, error: '超级 Pilot 未装配' }
    if (typeof prompt !== 'string') return { ok: false, error: '指令为空' }
    return pilot.send(prompt)
  })

  ctx.handle('pilot:super-cancel', async () => {
    await appState.superPilot?.cancel()
    return { ok: true }
  })

  ctx.handle('pilot:super-reset', async () => {
    const pilot = appState.superPilot
    if (!pilot) return { ok: false, sessionId: '' }
    return { ok: true, sessionId: await pilot.reset() }
  })

  ctx.handle('pilot:super-rescue', async (): Promise<SuperPilotRescueResult | { error: string }> => {
    const pilot = appState.superPilot
    if (!pilot) return { error: '超级 Pilot 未装配' }
    return pilot.rescue()
  })
}
