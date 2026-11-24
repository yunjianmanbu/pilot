// 主进程 → 界面的单向推送。
//
// 桌面端原来只有一条路：`BrowserWindow.webContents.send`。设置里的「网页服务」
// 打开后，同一套 renderer 也跑在浏览器标签页里，它通过 companion 的 `/bridge`
// 收帧（`bridgeEmit`）。两条路共用同一个通道名与载荷，渲染进程因此不需要知道
// 自己是在窗口里还是在标签页里。
//
// 这里只做分发，不判断谁在线：没有网页服务时 sink 为 null，行为与原来一致。
// `pilot serve` 用的是 `src/server/electron-shim.ts` 里的同名机制，两处互不影响。
import { BrowserWindow } from 'electron'

export type RendererSink = (channel: string, payload: unknown) => void

let sink: RendererSink | null = null

/** 装配时注入一次；传 null 表示这个进程没有网页服务。 */
export function setRendererSink(next: RendererSink | null): void {
  sink = next
}

/** 向每个原生窗口发一条，再交给网页服务的 sink（有的话）。 */
export function sendToRenderers(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }
  sink?.(channel, payload)
}
