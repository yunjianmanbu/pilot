/**
 * 邮件通知的事件目录。
 *
 * 这里是「哪些事值得发一封邮件」的唯一事实来源：主进程按 id 分发，渲染层按
 * 同一个数组渲染开关，两边的顺序与文案不会漂移。数组顺序就是推荐优先级
 * （1 最高），越靠前越需要用户当场知道，默认值也据此决定。
 *
 * 事件是「发给用户自己」的：收件人、SMTP 登录名与发件人都是设置里那一个
 * 邮箱地址，这里不再出现收件人字段。
 */
export type NotifyEventId =
  | 'run.failed'
  | 'approval.required'
  | 'schedule.failed'
  | 'run.completed'
  | 'reflect.report'
  | 'reflect.failed'
  | 'companion.pair_request'
  | 'update.ready'
  | 'schedule.started'
  | 'module-check.completed'
  | 'supervisor.applied'
  | 'quality.better'

export interface NotifyEventDef {
  id: NotifyEventId
  /** 1 = 最需要用户当场知道；列表与勾选结果都按它排序。 */
  priority: number
  /** 出厂默认是否勾选：只把「不知道会出事」的事件默认打开。 */
  defaultOn: boolean
  zh: string
  en: string
  zhHint: string
  enHint: string
}

export const NOTIFY_EVENTS: readonly NotifyEventDef[] = [
  {
    id: 'run.failed',
    priority: 1,
    defaultOn: true,
    zh: '运行失败',
    en: 'Run failed',
    zhHint: '任务中途报错或没能跑完时发信，是唯一必须知道的告警。',
    enHint: 'Sent when a run errors out or cannot finish. The one alert you should keep on.',
  },
  {
    id: 'approval.required',
    priority: 2,
    defaultOn: true,
    zh: '等待审批',
    en: 'Approval needed',
    zhHint: '有工具调用需要你批准时发信；人不在电脑前也不会让任务一直挂着。',
    enHint: 'Sent when a tool call waits for your approval, so an unattended task does not stall.',
  },
  {
    id: 'schedule.failed',
    priority: 3,
    defaultOn: true,
    zh: '定时任务失败',
    en: 'Scheduled task failed',
    zhHint: '定时任务没能开始执行（会话已删除、模型不可用等）时发信。',
    enHint: 'Sent when a scheduled task cannot start (session removed, no model, and so on).',
  },
  {
    id: 'run.completed',
    priority: 4,
    defaultOn: true,
    zh: '任务完成',
    en: 'Task finished',
    zhHint: '每次运行结束时发信，含达到步数或额度上限的提前结束。',
    enHint: 'Sent at the end of every run, including ones stopped by the step or token cap.',
  },
  {
    id: 'reflect.report',
    priority: 5,
    defaultOn: true,
    zh: '反思报告',
    en: 'Reflection report',
    zhHint: '每次反思完成后把摘要与发现发到邮箱，等价于原来的「发送反思邮件」。',
    enHint: 'Emails the summary and findings after each reflection; same as the old reflection mail switch.',
  },
  {
    id: 'reflect.failed',
    priority: 6,
    defaultOn: true,
    zh: '反思失败',
    en: 'Reflection failed',
    zhHint: '反思这一轮没有跑完时发信，报告本身不会生成。',
    enHint: 'Sent when a reflection round could not finish; no report is produced in that case.',
  },
  {
    id: 'companion.pair_request',
    priority: 7,
    defaultOn: true,
    zh: '手机配对请求',
    en: 'Pairing request',
    zhHint: '有手机或浏览器请求接入这台电脑时发信，避免错过而让请求过期。',
    enHint: 'Sent when a phone or browser asks to pair, so the request does not silently expire.',
  },
  {
    id: 'update.ready',
    priority: 8,
    defaultOn: false,
    zh: '新版本可用',
    en: 'Update available',
    zhHint: '检查到新版本且已下载好、可以安装时发信。',
    enHint: 'Sent when a new version is found and already downloaded, ready to install.',
  },
  {
    id: 'schedule.started',
    priority: 9,
    defaultOn: false,
    zh: '定时任务开始',
    en: 'Scheduled task started',
    zhHint: '定时任务到点开始执行时发信；结束时另有「任务完成 / 运行失败」。',
    enHint: 'Sent when a scheduled task starts; its end is covered by task finished / run failed.',
  },
  {
    id: 'module-check.completed',
    priority: 10,
    defaultOn: false,
    zh: '模块自检完成',
    en: 'Module check finished',
    zhHint: '一轮模块自检扫描结束时发信，含风险点数量与得分。',
    enHint: 'Sent when a module self-check scan finishes, with risk count and score.',
  },
  {
    id: 'supervisor.applied',
    priority: 11,
    defaultOn: false,
    zh: '自主优化开跑',
    en: 'Self-optimization started',
    zhHint: '自主优化决定动手并开了一轮会话时发信。',
    enHint: 'Sent when self-optimization decides to act and starts a session.',
  },
  {
    id: 'quality.better',
    priority: 12,
    defaultOn: false,
    zh: '发现更优版本',
    en: 'Better candidate found',
    zhHint: '质量闸门产出更优候选、需要你决定是否采用时发信。',
    enHint: 'Sent when the quality gate produces a better candidate that needs your decision.',
  },
]

export const NOTIFY_EVENT_IDS: readonly NotifyEventId[] = NOTIFY_EVENTS.map((entry) => entry.id)

/** 出厂默认勾选的事件，按目录顺序排列。 */
export const DEFAULT_NOTIFY_EMAIL_EVENTS: NotifyEventId[] = NOTIFY_EVENTS.filter(
  (entry) => entry.defaultOn,
).map((entry) => entry.id)

const KNOWN_IDS = new Set<string>(NOTIFY_EVENT_IDS)

/**
 * 归一化事件集合：丢掉未知 id 与重复项，并按推荐优先级重新排序。
 * 排序后的数组可以直接比较，不必担心用户勾选顺序造成设置「看起来变了」。
 */
export function normalizeNotifyEmailEvents(value: unknown): NotifyEventId[] {
  const raw = Array.isArray(value) ? value : []
  const picked = new Set(
    raw.filter((entry): entry is string => typeof entry === 'string' && KNOWN_IDS.has(entry)),
  )
  return NOTIFY_EVENTS.filter((entry) => picked.has(entry.id)).map((entry) => entry.id)
}

/** 打开或关闭一个事件，返回仍然有序的新数组。 */
export function withNotifyEvent(
  list: readonly NotifyEventId[],
  id: NotifyEventId,
  on: boolean,
): NotifyEventId[] {
  const next = new Set(list)
  if (on) next.add(id)
  else next.delete(id)
  return normalizeNotifyEmailEvents([...next])
}

export function notifyEventLabel(id: NotifyEventId, english: boolean): string {
  const entry = NOTIFY_EVENTS.find((candidate) => candidate.id === id)
  if (!entry) return id
  return english ? entry.en : entry.zh
}

export function notifyEventHint(id: NotifyEventId, english: boolean): string {
  const entry = NOTIFY_EVENTS.find((candidate) => candidate.id === id)
  if (!entry) return ''
  return english ? entry.enHint : entry.zhHint
}
