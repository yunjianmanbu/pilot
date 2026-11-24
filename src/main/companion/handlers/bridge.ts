// `/bridge`：浏览器里的桌面界面与主进程之间的 RPC 与事件通道。
//
// 手机 PWA 走的是「配对 → 加密请求 → 桌面 host 的 method 表」这条路；桌面界面
// 不能这么走，因为它需要的是整个 `pilot:*` IPC 面（三百多个通道）。所以这里
// 复用同一条 WS 连接与同一套访问级别，但把帧直接交给服务器模式注进来的 IPC 表，
// 于是网页版和客户端跑的是同一份主进程代码，而不是两套实现。
import type { IncomingMessage } from 'node:http'
import { decodeBridgeArgs } from '../../../shared/bridge'
import { canManageHost, type AccessLevel } from '../access-level'
import { hashToken, safeEqualText } from '../crypto'
import type { ClientConnection } from '../types'
import type { CompanionServer } from '../server'

/** 一条 bridge 连接同时能有多少个请求在飞；超出直接拒绝，避免拖垮主进程。 */
const MAX_INFLIGHT = 16
/** 一个帧最多允许多少个参数，防止畸形客户端把 IPC 调用撑爆。 */
const MAX_ARGS = 8

interface BridgeRequestFrame {
  id?: unknown
  channel?: unknown
  args?: unknown
}

function sendFrame(connection: ClientConnection, frame: unknown): void {
  if (connection.socket.readyState !== 1) return
  try {
    connection.socket.send(JSON.stringify(frame))
  } catch {
    // A dying socket is cleaned up by the close handler.
  }
}

function usableLevel(level: AccessLevel | undefined): level is AccessLevel {
  return Boolean(level) && canManageHost(level as AccessLevel)
}

/**
 * 这条 `/bridge` 连接是谁：回环直连就是本机（`local`），其余必须出示配对
 * 时发放的浏览器凭据；命中记录按它自己的 `role` 定成 `host` 或 `client`。
 *
 * 同时带出记录 id：设置页的「已授权的网页」要显示最后活动，所以连接关闭时
 * 得知道该更新哪条记录。空返回值表示拒绝：桌面界面会把整份数据面都摊开，
 * 不能给未识别的调用者。
 */
export interface BridgeIdentity {
  level: AccessLevel
  /** 命中凭据的记录 id；回环直连没有记录，为 null。 */
  phoneId: string | null
}

export function bridgeIdentity(
  server: CompanionServer,
  request: IncomingMessage,
  url: URL,
): BridgeIdentity | null {
  const address = request.socket.remoteAddress ?? null
  if (!address) return null
  const bare = address.replace(/^::ffff:/i, '')
  if (bare === '::1' || bare.startsWith('127.')) return { level: 'local', phoneId: null }

  const header = request.headers['x-pilot-token']
  const candidate =
    url.searchParams.get('token') ??
    (Array.isArray(header) ? header[0] : header) ??
    ''
  const token = candidate.trim()
  if (token.length < 20) return null
  const hash = hashToken(token)
  for (const [id, phone] of Object.entries(server.state.phones)) {
    if (safeEqualText(phone.tokenHash, hash)) {
      // 浏览器凭据才有身份之分；扫码手机等同本机另一块屏幕。
      if (phone.via === 'browser' && phone.role === 'client') return { level: 'client', phoneId: id }
      return { level: 'host', phoneId: id }
    }
  }
  return null
}

/**
 * 处理一个 `ipc` 帧：调用注入的 IPC 表并回包。
 *
 * 失败一律以 `{ ok: false, error }` 回去，不抛到连接层：浏览器端一条失败的
 * `invoke` 只该让那个 Promise reject，不该把整条通道打断。
 */
export async function handleBridgeFrame(
  server: CompanionServer,
  connection: ClientConnection,
  frame: BridgeRequestFrame,
  inflight: { count: number },
): Promise<void> {
  const id = frame.id
  const requestId = typeof id === 'string' || typeof id === 'number' ? id : null
  const channel = typeof frame.channel === 'string' ? frame.channel : ''

  const reply = (ok: boolean, value: unknown): void => {
    sendFrame(connection, ok
      ? { type: 'ipc.result', id: requestId, ok: true, data: value }
      : { type: 'ipc.result', id: requestId, ok: false, error: String(value) })
  }

  if (!connection.bridgeLevel || !usableLevel(connection.bridgeLevel)) {
    reply(false, '客户机用户不能使用这台电脑的桌面界面')
    return
  }
  if (!channel.startsWith('pilot:')) {
    reply(false, `未知的 IPC 通道：${channel || '(空)'}`)
    return
  }
  const ipc = server.options.ipc
  if (!ipc) {
    reply(false, '这个进程没有装配 IPC（不是服务器模式）')
    return
  }
  if (inflight.count >= MAX_INFLIGHT) {
    reply(false, '请求过于频繁，请稍后重试')
    return
  }
  const args = Array.isArray(frame.args)
    ? decodeBridgeArgs(frame.args.slice(0, MAX_ARGS))
    : []

  inflight.count += 1
  try {
    reply(true, await ipc.invoke(channel, args))
  } catch (error) {
    reply(false, error instanceof Error ? error.message : String(error))
  } finally {
    inflight.count -= 1
  }
}

/**
 * 把主进程的一条渲染事件推给所有桌面界面连接。
 *
 * 桌面端这里是 `webContents.send`；服务器模式没有窗口，改成这个函数，通道名
 * 与载荷保持一致，因此渲染进程的分支不用区分自己是窗口还是标签页。
 */
export function bridgeEmit(
  server: CompanionServer,
  channel: string,
  payload: unknown,
): void {
  let frame: string
  try {
    frame = JSON.stringify({ type: 'event', channel, payload })
  } catch {
    return
  }
  for (const connection of server.connections) {
    if (connection.surface !== 'bridge') continue
    if (!usableLevel(connection.bridgeLevel)) continue
    if (connection.socket.readyState !== 1) continue
    try {
      connection.socket.send(frame)
    } catch {
      // Same as above: the close handler removes it.
    }
  }
}
