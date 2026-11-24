/**
 * 浏览器等审批时，每一轮轮询结果该怎么处理。
 *
 * 这段逻辑单独放一个模块，是因为它必须可以被测：之前页面把「问不到结果」一律
 * 当作「再问一次」，于是 `404 unknown_ticket`（这条申请不在这台电脑的表里，例如
 * 浏览器连的是另一份正在运行的服务）会让页面永远停在等待上——用户在弹框里点
 * 多少次「允许访问」都没用，因为批准的从来不是它连的那一份服务。
 */
export interface TicketReply {
  ok?: boolean
  local?: boolean
  id?: string
  state?: string
  token?: string
  reason?: string
  expiresAt?: string
  error?: string
}

export type TicketPollDecision =
  /** 批准了：拿这条 token 去连。 */
  | { kind: 'connect'; token: string }
  /** 还没结果（或只是瞬时故障）：过一会儿再问。 */
  | { kind: 'wait' }
  /** 不会再有结果了：停下来把原因显示给用户，并给一个「重新申请」。 */
  | { kind: 'stop'; message: string }

/** 服务端一条申请最多活 5 分钟；拿不到 expiresAt 时按这个值兜底，绝不留永不到期的轮询。 */
export const TICKET_TTL_MS = 5 * 60_000

const MISSING_TICKET_MESSAGE =
  '这台电脑已经不认得这次申请：可能服务重启过，或者浏览器打开的是另一份正在运行的服务。请刷新页面重新申请，并在刚打开的那个电脑窗口里点「允许访问」。'
const SERVER_DISABLED_MESSAGE = '这台电脑的网页服务已经关闭，请先在电脑上重新开启，再刷新页面。'
const EXPIRED_MESSAGE = '这次申请已经过期，请重新申请。'

/** 服务端给的过期时间；缺了或解析不出来时按默认 TTL 兜底。 */
export function parseTicketDeadline(expiresAt: unknown, now = Date.now()): number {
  const parsed = typeof expiresAt === 'string' ? Date.parse(expiresAt) : Number.NaN
  return Number.isFinite(parsed) && parsed > now ? parsed : now + TICKET_TTL_MS
}

export function decideTicketPoll(input: {
  /** HTTP 状态码；请求本身失败时传 0。 */
  status: number
  reply: TicketReply
  now: number
  deadline: number
}): TicketPollDecision {
  const { status, reply, now, deadline } = input
  if (now >= deadline) return { kind: 'stop', message: EXPIRED_MESSAGE }
  // 这条申请不在这台电脑的表里：继续轮询同一个 id 永远不会变。停在明确的提示上，
  // 而不是让用户对着一个转不停的等待页反复点授权。
  if (status === 404 || reply.error === 'unknown_ticket') {
    return { kind: 'stop', message: MISSING_TICKET_MESSAGE }
  }
  if (status === 503 || reply.error === 'server_disabled') {
    return { kind: 'stop', message: SERVER_DISABLED_MESSAGE }
  }
  if (reply.state === 'approved') {
    return reply.token ? { kind: 'connect', token: reply.token } : { kind: 'wait' }
  }
  if (reply.state === 'denied') {
    return { kind: 'stop', message: reply.reason || '这台电脑拒绝了网页访问' }
  }
  if (reply.state === 'expired') return { kind: 'stop', message: EXPIRED_MESSAGE }
  // 其余 4xx/5xx（重启中、代理返回网关错误）与「还在等」都当瞬时状态：继续问。
  return { kind: 'wait' }
}
