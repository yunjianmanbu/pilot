// 手机请求按域分派：server.ts 只保留薄壳，各域的 case 在同类文件里。
import type { CompanionServer } from '../server'
import type { StoredPhone } from '../types'
import {
  canManageHost,
  isLocalOnlyMethod,
  LOCAL_ONLY_ERROR,
  type AccessLevel,
} from '../access-level'
import { handleSessionRequest } from './session'
import { handleWorkspaceRequest } from './workspace'
import { handleWorkRequest } from './work'
import { handleSettingsRequest } from './settings'
import { handleReflectRequest } from './reflect'
import { CLIENT_NO_SPACE_ERROR } from '../access-level'

type RequestHandler = (
  host: CompanionServer,
  method: string,
  params: Record<string, unknown>,
  phone: StoredPhone,
  access: AccessLevel,
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
  reflect: handleReflectRequest,
  models: handleSettingsRequest,
  billing: handleSettingsRequest,
  ping: handleSettingsRequest,
}

export async function routePhoneRequest(
  host: CompanionServer,
  method: string,
  params: Record<string, unknown>,
  phone: StoredPhone,
  access: AccessLevel = 'paired',
): Promise<unknown> {
  if (!method) throw new Error('缺少操作名称')
  // 默认按扫码配对处理：只有明确判定为「浏览器直连」的访问者才受限，
  // 这样旧记录（没有 via 字段）不会因为升级而掉功能。
  // 本机专属功能在进域之前就挡住：受限访问者拿到的是一条明确的拒绝，
  // 而不是「未找到工作区」这种看起来像 bug 的报错。
  if (!canManageHost(access) && isLocalOnlyMethod(method)) {
    throw new Error(LOCAL_ONLY_ERROR)
  }
  // 客户机用户必须有自己的一套数据。没装配就拒绝，而不是静默用本机数据：
  // 静默回退会让远端看到本机的会话与设置，而且它自己不会发现。
  if (access === 'client' && !host.guestScope && method !== 'device.info') {
    throw new Error(CLIENT_NO_SPACE_ERROR)
  }
  const dot = method.indexOf('.')
  const domain = dot === -1 ? method : method.slice(0, dot)
  // 未知前缀仍然落到通用域，由它的 default 抛出和原来一致的「不支持该操作」。
  return (byDomain[domain] ?? handleSettingsRequest)(host, method, params, phone, access)
}
