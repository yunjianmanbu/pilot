/**
 * 排队任务什么时候能跟着上一轮收尾自动开始。
 *
 * 排队语义只有一句「当前任务结束后自动开始」，所以它能开始的前提是：这一轮
 * 真的结束了，而且用户没有把它拦住。拦住的两种情况必须分开记，因为它们
 * 之后的恢复入口不同：
 *
 * - 暂停（pause）：run 记为 paused，用户点「继续」接着做；队列原地等，
 *   继续那一轮结束后才轮到队首。
 * - 停止（cancel）：run 记为 cancelled，没有「继续」；队列原地等，用户发
 *   新消息或点队列里的「执行」再按序开始。
 *
 * 以前收尾只看 finalStatus，暂停恰好落在收尾窗口里（模型刚答完、还没写盘）
 * 时 finalStatus 会是 completed，队列就被推了上来；用户随后点「继续」只能
 * 收到「任务还在运行」，看起来就是排队任务插队执行。
 */
export interface QueueGateInput {
  /** 这一轮的最终状态：completed / paused / cancelled / failed / max_steps … */
  finalStatus: string
  /** 收尾时已经安排了自动继续（失败重试、计划未完、stop hook）。 */
  continued: boolean
  /** 用户在运行中点了「暂停」。 */
  pausedByUser: boolean
  /** 用户在运行中点了「停止」。 */
  stoppedByUser: boolean
}

export function shouldPromoteQueue(gate: QueueGateInput): boolean {
  // 自动继续先跑：两条续跑同时启动会让队列和重试争同一个会话。
  if (gate.continued) return false
  // 用户主动停下的一轮，队列必须原地等，否则「继续」永远抢不到 run。
  if (gate.pausedByUser || gate.stoppedByUser) return false
  return gate.finalStatus !== 'paused'
}

/**
 * 想插进当前 run 的消息，是否必须先排队。
 *
 * 暂停/停止之后这一轮只剩收尾：steering 队列不会再被模型消费，消息会跟着旧
 * run 一起消失，而用户已经看到它写进了对话。这种时候一律降级成排队任务。
 */
export function insertMustQueue(
  live: { paused: boolean; stoppedByUser: boolean } | undefined,
): boolean {
  if (!live) return false
  return live.paused || live.stoppedByUser
}
