/**
 * 审批卡的播报判定：哪些是「新来的」，需要打断读屏一次。
 *
 * 卡片本身不能挂 `aria-live`：里面的倒计时每秒变一次，读者会被每秒打断一次。
 * 所以只在**新增**审批时播一句，判定收在这里，组件只负责拼文案与渲染节点。
 *
 * `seen` 原样返回（而不是原地改），是因为调用方把它存在 ref 里：留下旧数组
 * 的组件实例（React 严格模式的双调用、并发渲染）不该被另一个实例改掉。
 */
export function freshApprovals<T extends { callId: string }>(
  seen: readonly string[],
  approvals: readonly T[],
): { fresh: T[]; seen: string[] } {
  if (approvals.length === 0) return { fresh: [], seen: [] }
  const known = new Set(seen)
  const fresh = approvals.filter((request) => !known.has(request.callId))
  return { fresh, seen: approvals.map((request) => request.callId) }
}
