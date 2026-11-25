// 超级 Pilot 的共享类型：主进程的应急引擎、preload 桥和独立窗口的页面共用一份。
//
// 刻意放在 `shared/` 而不是留在 `main/super-pilot.ts`：渲染进程不能 import 主进程
// 模块（会把 node 内置拖进打包目标），而这三份形状必须在两边逐字一致，否则页面
// 拿到的字段名一变就静默显示空值。
import type { ApprovalMode } from './types'

/** 页面轮询与推送共用的一份状态：只含可读字段，不含任何密钥。 */
export interface SuperPilotStatus {
  /** `booting` 只在第一次装配期间出现，秒级。 */
  state: 'booting' | 'ready' | 'running' | 'failed'
  /** 数据面目录（页面显示出来，出问题好让人直接去翻）。 */
  dataDir: string
  /** 工作区：默认为自身源码，方便直接修自己。 */
  workspace: string
  model: string
  /** 空串表示模型通道还没继承到（主 store 不可用且自身也没存过）。 */
  baseUrl: string
  approvalMode: ApprovalMode
  /** 完全自主档是否真的生效；未生效时 `blockers` 说明缺什么。 */
  autonomy: { active: boolean; blockers: string[] }
  /** 主引擎是否可用于继承模型通道；false 时说明这是「独立的最后手段」。 */
  inheritedFromHost: boolean
  sessionId: string
  activeRunId: string | null
  lastError: string
  startedAt: string
}

/** 一条压缩后的历史消息：页面不需要完整 tool 结果。 */
export interface SuperPilotMessage {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string
  createdAt: string
  isError?: boolean
  name?: string
}

export interface SuperPilotRescueResult {
  at: string
  actions: { label: string; ok: boolean; detail: string }[]
}

/** `pilot:super-status` 的返回：装配失败时给一个可读错误而不是抛异常。 */
export type SuperPilotStatusReply = SuperPilotStatus | { error: string }
