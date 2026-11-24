/**
 * Desktop preload: the same bridge the browser console builds over WebSocket,
 * backed here by Electron's IPC.
 *
 * The channel names, argument order and event subscriptions all live in
 * `src/shared/bridge.ts`, so the desktop window and the `pilot serve` browser
 * tab cannot drift apart: they are one object with two transports.
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { createBridge, type BridgeRpc } from '../shared/bridge'
import type { PilotBridge } from '../shared/types'

const rpc: BridgeRpc = {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (channel, listener) => {
    const handler = (_event: unknown, payload: unknown): void => listener(payload)
    ipcRenderer.on(channel, handler)
    return () => {
      ipcRenderer.removeListener(channel, handler)
    }
  },
  pathForFile: (file) => webUtils.getPathForFile(file as never),
}

const bridge: PilotBridge = createBridge(rpc)

contextBridge.exposeInMainWorld('pilot', bridge)
