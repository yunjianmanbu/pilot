// 运行状态与事件广播：状态快照、开关与中继地址切换、状态持久化，以及手机侧事件推送。
// 由 server.ts 的同名方法机械搬出：方法体逐字保留，this 换成 host 参数。
import { randomUUID } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { CompanionStatus, RunEvent } from '../../../shared/types'
import { normalizeRelayUrl, splitRelayUrl } from '../../../shared/relay'
import { DEFAULT_PORT, STATE_VERSION } from '../constants'
import { publicPhone } from '../helpers'
import type { CompanionState } from '../types'
import { currentCompanionScope, type CompanionRole } from '../scope'
import type { CompanionServer } from '../server'

export function blankState(
  host: CompanionServer,
): CompanionState {
  return {
    version: STATE_VERSION,
    enabled: false,
    deviceId: randomUUID(),
    port: DEFAULT_PORT,
    phones: {},
  }
}

export function blankSave(
  host: CompanionServer,
): void {
  if (host.saveTimer) return
  host.saveTimer = setTimeout(() => {
    host.saveTimer = null
    void host.saveNow()
  }, 300)
  host.saveTimer.unref?.()
}

export async function saveNow(
  host: CompanionServer,
): Promise<void> {
  if (host.saveTimer) {
    clearTimeout(host.saveTimer)
    host.saveTimer = null
  }
  try {
    await mkdir(dirname(host.stateFile), { recursive: true })
    const temp = `${host.stateFile}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(host.state, null, 2), { mode: 0o600 })
    await rename(temp, host.stateFile)
  } catch (error) {
    host.lastError = error instanceof Error ? error.message : String(error)
  }
}

export function emitStatus(
  host: CompanionServer,
): void {
  try {
    host.options.onStatus(host.status())
  } catch {
    // Status rendering must not break the relay.
  }
}

export function status(
  host: CompanionServer,
): CompanionStatus {
  const phones = Object.values(host.state.phones)
    .map((phone) => publicPhone(phone, host.phoneSockets.has(phone.phoneId)))
    .sort((left, right) => right.pairedAt.localeCompare(left.pairedAt))
  const active = host.activeOffer()
  const port = host.listeningPort()
  const relayConnected = [...host.relayRooms.values()].some((room) => room.channel.connected)
  const cloudRecords = Object.values(host.state.phones).filter((phone) =>
    Boolean(phone.relayRoom),
  )
  const lastRelayUrl =
    cloudRecords
      .slice()
      .sort((left, right) => right.pairedAt.localeCompare(left.pairedAt))
      .map((phone) => normalizeRelayUrl(phone.relayUrl) ?? '')
      .find(Boolean) ?? null
  return {
    enabled: host.state.enabled,
    running: Boolean(host.server && port),
    address: host.server && port ? `http://${host.addressHost()}:${port}` : null,
    port,
    deviceId: host.state.deviceId,
    deviceName: host.options.deviceName,
    phones,
    pairingActive: Boolean(active),
    pairingExpiresAt: active ? new Date(active.expiresAt).toISOString() : null,
    pairingRequest: host.pendingPair?.request ?? null,
    appUrl: host.appBaseUrl() || null,
    relayUrl: host.relayUrl() || null,
    relayAccess: Boolean(host.relayAccess()),
    relaySource: host.relaySource(),
    cloudPhones: cloudRecords.length,
    lastRelayUrl,
    relayConnected,
    relayError: host.relayError,
    error: host.lastError,
  }
}

export async function setEnabled(
  host: CompanionServer,
  enabled: boolean,
): Promise<CompanionStatus> {
  host.state.enabled = enabled
  await host.saveNow()
  if (enabled) {
    try {
      await host.start()
    } catch (error) {
      host.lastError = error instanceof Error ? error.message : String(error)
    }
  } else {
    await host.stop()
  }
  host.emitStatus()
  return host.status()
}

export async function setRelayUrl(
  host: CompanionServer,
  value: string,
): Promise<CompanionStatus> {
  const normalized = normalizeRelayUrl(value)
  if (normalized === null) {
    throw new Error(
      '中继地址必须是 wss:// 或 ws:// 地址，可带 #k=准入码，且不能包含用户名或密码。',
    )
  }
  // The dialog shows and resubmits the endpoint without the code, so a save
  // that only re-sends the same host/path must not wipe the stored code.
  const endpoint = splitRelayUrl(normalized)
  const previous = splitRelayUrl(host.options.store.settingsView().relayUrl)
  const next =
    !endpoint.access && endpoint.url && previous.access && previous.url === endpoint.url
      ? `${endpoint.url}#k=${previous.access}`
      : normalized
  await host.options.store.updateSettings({ relayUrl: next })
  if (host.offer) host.clearOffer()
  host.stopRelay()
  // Only reconnect when the companion service is actually running; start()
  // opens relay rooms on the new endpoint otherwise.
  if (host.server) host.startRelay()
  host.emitStatus()
  return host.status()
}

export function notify(
  host: CompanionServer,
  event: RunEvent,
): void {
  // 客户机用户的动态只属于它自己：桌面窗口与主机手机都不该看到另一个
  // 用户会话里的待办、计划与增量。`publish` 会按作用域投递给它自己的连接。
  if (currentCompanionScope()?.role !== 'client') {
    try {
      host.options.onEvent?.(event)
    } catch {
      // The desktop mirror is best-effort.
    }
  }
  host.publish(event)
}

export function publish(
  host: CompanionServer,
  event: RunEvent,
  role?: CompanionRole,
): void {
  if (event.type === 'companion.changed') return
  // 事件归属哪一套数据面：显式声明优先（客户机 runner 的 emit 走这里），
  // 否则跟随请求链（handler 里 emitTodos 等），都不在时是主机后台任务。
  const target: CompanionRole = role ?? currentCompanionScope()?.role ?? 'host'
  for (const phoneId of host.phoneSockets) {
    // 跨作用域投递就是数据泄露：客户机看不到主机会话，反之亦然。
    if (host.scopeRoleOfPhone(phoneId) !== target) continue
    host.sendEncrypted(phoneId, { type: 'event', data: event }).catch(() => {
      // A phone that dropped mid-event will reconnect; the session can be reloaded.
    })
  }
}

export function emitTodos(
  host: CompanionServer,
  sessionId: string,
): void {
  host.notify({
    type: 'todos.changed',
    sessionId,
    todos: host.options.store.todos(sessionId),
  })
}

export function emitScheduled(
  host: CompanionServer,
  sessionId: string,
): void {
  host.notify({ type: 'scheduled.changed', sessionId })
}
