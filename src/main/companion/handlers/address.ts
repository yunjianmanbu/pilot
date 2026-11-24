// 地址推导：监听地址、对外可达地址、二维码所指向的基础地址与局域网地址列表。
// 由 server.ts 的同名方法机械搬出：方法体逐字保留，this 换成 host 参数。
import type { PluginHost } from '../../plugins/runtime'
import { attachPluginHooks, sharedPluginHost } from '../../plugins/shared'
import { DEFAULT_APP_URL } from '../constants'
import { lanAddresses, preferredLanAddress } from '../helpers'
import type { CompanionServer } from '../server'

export function pluginHost(
  server: CompanionServer,
): PluginHost | null {
  if (server.pluginHostInstance) return server.pluginHostInstance
  const root = server.options.pluginRoot ?? server.options.store.activeWorkspace()
  if (!root) return null
  // 与智能体工具共用同一份宿主：同一个插件不会因为手机连上来又起一个进程，
  // 定时触发器也不会在两份宿主之间各跑一遍。
  const options = { root }
  server.pluginHostInstance = sharedPluginHost(options)
  server.pluginHostDetach = attachPluginHooks(options, {
    notify: (message) => {
      try {
        server.notify({ type: 'notice', level: 'info', message })
      } catch {
        // 手机不在线时通知丢掉即可，不能影响插件调用本身。
      }
    },
    onPluginEvent: (pluginId, event) => {
      try {
        server.notify({
          type: 'notice',
          level: 'info',
          message: `插件 ${pluginId} 发出事件 ${event}`,
        })
      } catch {
        // 同上。
      }
    },
  })
  return server.pluginHostInstance
}

export function listenHost(
  server: CompanionServer,
): string {
  const host = (server.options.host ?? '').trim()
  return host || '0.0.0.0'
}

export function addressHost(
  server: CompanionServer,
): string {
  const bound = server.listenHost()
  if (bound === '0.0.0.0' || bound === '::' || bound === '::0') return preferredLanAddress()
  return bound
}

export function appBaseUrl(
  server: CompanionServer,
): string {
  return (server.options.appUrl ?? DEFAULT_APP_URL).trim()
}

export function publicBaseUrl(
  server: CompanionServer,
): string {
  const raw = (server.options.publicBaseUrl ?? '').trim()
  if (!raw) return ''
  try {
    const url = new URL(raw)
    url.search = ''
    url.hash = ''
    if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`
    return url.toString()
  } catch {
    return ''
  }
}

export function lanUrls(
  server: CompanionServer,
): string[] {
  const port = server.listeningPort()
  if (!port) return []
  return lanAddresses()
    .slice(0, 4)
    .map((address) => `ws://${address}:${port}/ws`)
}

export function listeningPort(
  server: CompanionServer,
): number | null {
  const address = server.server?.address()
  return address && typeof address === 'object' ? address.port : null
}
