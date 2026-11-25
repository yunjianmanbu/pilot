import type { SessionSummary } from '../../shared/types'

/**
 * 切换工作区时如何更新侧栏的会话清单。
 *
 * 以前这里直接 `setSessions(data.sessions)`（整份 bootstrap），于是切换工作区
 * 等于把整个列表换了一遍：其它分组的位置、滚动高度、正在看的那一行全部重排，
 * 用户看到的就是「切个工作区，列表刷新了，还跳回顶部」。
 *
 * 现在只替换目标工作区那一段，并把这一段放回它原来的位置：
 * - 其它工作区的会话原样保留（内容与顺序都不动）；
 * - 目标工作区原有的行被新清单替换，但落点沿用旧位置，列表高度与顺序稳定；
 * - 新工作区（列表里还没有它）追加到末尾。
 *
 * 顺序稳定是「不回顶」的前提：DOM 行顺序不变时浏览器不会把 scrollTop 夹小。
 */
export function mergeWorkspaceSessions(
  previous: SessionSummary[],
  workspacePath: string,
  next: SessionSummary[],
): SessionSummary[] {
  const existing = previous.filter((entry) => entry.workspacePath === workspacePath)
  if (existing.length === 0) {
    // 这个工作区之前没有会话：不重排已有分组，直接接在后面。
    return [...previous, ...next]
  }
  const firstIndex = previous.findIndex((entry) => entry.workspacePath === workspacePath)
  const kept = previous.filter((entry) => entry.workspacePath !== workspacePath)
  return [...kept.slice(0, firstIndex), ...next, ...kept.slice(firstIndex)]
}

/**
 * 会话清单是否只是「同一个工作区内已有行的更新」。
 *
 * 只有行被增删、或分组之间发生交错时才需要担心滚动被夹紧；纯字段更新不会
 * 改变高度，可以跳过滚动恢复，避免无谓的 layout 抖动。
 */
export function sameWorkspaceLayout(previous: SessionSummary[], next: SessionSummary[]): boolean {
  if (previous.length !== next.length) return false
  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index]?.id !== next[index]?.id) return false
  }
  return true
}
