// 手机请求按域分派：server.ts 只保留薄壳，各域的 case 在同类文件里。
import type { CompanionServer } from '../server'
import type { StoredPhone } from '../types'
import { handleSessionRequest } from './session'
import { handleWorkspaceRequest } from './workspace'
import { handleWorkRequest } from './work'
import { handleSettingsRequest } from './settings'

type RequestHandler = (
  host: CompanionServer,
  method: string,
  params: Record<string, unknown>,
  phone: StoredPhone,
) => Promise<unknown>

const byDomain: Record<string, RequestHandler> = {
  sessions: handleSessionRequest,
  chat: handleSessionRequest,
  run: handleSessionRequest,
  checkpoints: handleSessionRequest,
  changes: handleSessionRequest,
  queue: handleSessionRequest,
  approval: handleSessionRequest,
  approvals: handleSessionRequest,
  workspaces: handleWorkspaceRequest,
  files: handleWorkspaceRequest,
  todos: handleWorkRequest,
  schedules: handleWorkRequest,
  pairing: handleSettingsRequest,
  device: handleSettingsRequest,
  moduleCheck: handleSettingsRequest,
  selfCheck: handleSettingsRequest,
  learning: handleSettingsRequest,
  memory: handleSettingsRequest,
  quickCommands: handleSettingsRequest,
  sandbox: handleSettingsRequest,
  system: handleSettingsRequest,
  tools: handleSettingsRequest,
  update: handleSettingsRequest,
  evolution: handleSettingsRequest,
  models: handleSettingsRequest,
  billing: handleSettingsRequest,
  ping: handleSettingsRequest,
}

export async function routePhoneRequest(
  host: CompanionServer,
  method: string,
  params: Record<string, unknown>,
  phone: StoredPhone,
): Promise<unknown> {
  if (!method) throw new Error('缺少操作名称')
  const dot = method.indexOf('.')
  const domain = dot === -1 ? method : method.slice(0, dot)
  // 未知前缀仍然落到通用域，由它的 default 抛出和原来一致的「不支持该操作」。
  return (byDomain[domain] ?? handleSettingsRequest)(host, method, params, phone)
}
