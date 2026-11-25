/**
 * 声明式 hook 规则的类型与常量，渲染层与主进程共用。
 *
 * 这里只有纯 JS：规则文件怎么读、怎么求值都在 `src/main/agent/hook-rules.ts`，
 * 渲染层拿到的是 `HookRuleView`，永远不碰 node 的 fs。
 */

export type HookRuleEvent = 'file' | 'bash' | 'tool' | 'stop'
export type HookRuleAction = 'warn' | 'block'

/** 事件取值与中文说明：设置页的下拉和规则徽章都用这一份，避免两处漂移。 */
export const HOOK_RULE_EVENTS: ReadonlyArray<{ id: HookRuleEvent; label: string }> = [
  { id: 'tool', label: '任意工具调用' },
  { id: 'bash', label: '命令执行' },
  { id: 'file', label: '写文件' },
  { id: 'stop', label: '回合结束' },
]

export const HOOK_RULE_ACTIONS: ReadonlyArray<{ id: HookRuleAction; label: string }> = [
  { id: 'warn', label: '提示' },
  { id: 'block', label: '阻断' },
]

/** 一条规则的可展示形态；`source` 是工作区相对路径（`.pilot/hooks/x.md`）。 */
export interface HookRuleView {
  name: string
  event: HookRuleEvent
  /** 大小写不敏感的正则源码。 */
  pattern: string
  action: HookRuleAction
  /** 命中时给模型的说明。 */
  message: string
  source: string
  /** 关掉的规则留在磁盘上但不生效，设置页仍能看到它。 */
  enabled: boolean
}

/** `.pilot/hooks.json` 里的命令钩子，只报数量：改它们请直接编辑那个文件。 */
export interface HookCommandCounts {
  preTool: number
  postEdit: number
  stop: number
}

export interface HookRulesReport {
  /** 工作区是否开启了 hook（设置里的 `hooksEnabled`）。关着时规则不生效。 */
  enabled: boolean
  rules: HookRuleView[]
  commands: HookCommandCounts
  /** 读不出来的规则文件：路径 + 原因，让用户知道为什么少了一条。 */
  broken: Array<{ source: string; reason: string }>
}

export const HOOK_RULE_MAX_RULES = 50
export const HOOK_RULE_MAX_PATTERN_CHARS = 300
export const HOOK_RULE_MAX_MESSAGE_CHARS = 600
