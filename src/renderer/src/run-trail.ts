import type { RunEvent } from '../../shared/types'

/**
 * 会话「卡点视图」的归约逻辑：把一串 `RunEvent` 压成「现在停在哪个节点、停了多久」。
 *
 * 为什么要单独一个纯模块：面板只负责画，判断「卡在哪」的规则必须能单测。
 * 事件是全产品共用的，这里的映射一旦错位，用户看到的阶段就是假的，
 * 而卡点视图存在的唯一意义就是它准确。
 */

export type TrailStage =
  | 'starting'
  | 'model'
  | 'thinking'
  | 'tool'
  | 'approval'
  | 'compacting'
  | 'done'
  | 'failed'

export interface TrailEntry {
  at: number
  stage: TrailStage
  label: string
  detail?: string
}

export interface RunTrail {
  sessionId: string
  runId: string
  stage: TrailStage
  /** 进入当前阶段的时间：面板用它算「卡在这里多久了」。 */
  stageSince: number
  updatedAt: number
  step: number
  /** 最近的动作，新的在前，最多 `TRAIL_LIMIT` 条。 */
  entries: TrailEntry[]
  /** 正在等待用户审批的工具：这是唯一「系统在等人」的状态。 */
  waiting?: { callId: string; name: string; since: number }
  /** 已完成的工具数 / 已发起的工具数，用来判断是不是在某个工具上原地打转。 */
  toolCalls: number
  durationMs?: number
  status?: string
  error?: string
}

export const TRAIL_LIMIT = 40

export const STAGE_LABEL: Record<TrailStage, string> = {
  starting: '准备运行',
  model: '等待模型回复',
  thinking: '模型推理中',
  tool: '执行工具',
  approval: '等待你审批',
  compacting: '压缩上下文',
  done: '已结束',
  failed: '失败',
}

/** 阶段是否代表「正在推进」：结束态不再需要提醒用户去看。 */
export function isActiveStage(stage: TrailStage): boolean {
  return stage !== 'done' && stage !== 'failed'
}

function push(trail: RunTrail, entry: TrailEntry): TrailEntry[] {
  return [entry, ...trail.entries].slice(0, TRAIL_LIMIT)
}

function moveStage(trail: RunTrail, stage: TrailStage, at: number): RunTrail {
  if (trail.stage === stage) return { ...trail, updatedAt: at }
  return { ...trail, stage, stageSince: at, updatedAt: at }
}

/**
 * 一个事件进来，返回新的轨迹；返回 `undefined` 表示「这个事件不影响卡点视图」
 * （例如 `queue.changed`、`todos.changed` 这类与本次运行无关的广播）。
 *
 * `now` 由调用方传入而不是在这里取 `Date.now()`，测试才能断言时间。
 */
export function applyTrailEvent(
  previous: RunTrail | undefined,
  event: RunEvent,
  now: number,
): RunTrail | undefined {
  switch (event.type) {
    case 'run.started': {
      return {
        sessionId: event.sessionId,
        runId: event.runId,
        stage: 'starting',
        stageSince: now,
        updatedAt: now,
        step: 0,
        entries: [{ at: now, stage: 'starting', label: `开始运行（${event.mode}）` }],
        toolCalls: 0,
      }
    }
    case 'step.started': {
      // 新一轮请求必然回到模型：上一轮的工具已经返回，这里把等待对象切回来。
      const base =
        previous && previous.runId === event.runId
          ? previous
          : emptyTrail(event.sessionId, event.runId, now)
      const next = moveStage(base, 'model', now)
      return {
        ...next,
        step: event.step,
        entries: push(next, { at: now, stage: 'model', label: `第 ${event.step} 步：请求模型` }),
      }
    }
    case 'message.started': {
      const base = resolve(previous, event.sessionId, event.runId, now)
      return moveStage(base, 'model', now)
    }
    case 'reasoning.delta': {
      // 推理流已经开始：这回答的是「模型在思考」而不是「请求还没回」。
      // 只在第一次切阶段，后续增量返回 undefined —— 一秒几十条 delta 不能变成几十次重画。
      const base = resolve(previous, event.sessionId, event.runId, now)
      if (base.stage === 'thinking') return undefined
      const next = moveStage(base, 'thinking', now)
      return {
        ...next,
        entries: push(next, { at: now, stage: 'thinking', label: '模型开始推理' }),
      }
    }
    case 'tool.call': {
      const base = resolve(previous, event.sessionId, event.runId, now)
      const next = moveStage(base, 'tool', now)
      return {
        ...next,
        toolCalls: next.toolCalls + 1,
        entries: push(next, {
          at: now,
          stage: 'tool',
          label: `调用 ${event.call.name}`,
          detail: event.risk,
        }),
      }
    }
    case 'tool.approval_required': {
      const base = resolve(previous, event.sessionId, event.runId, now)
      const next = moveStage(base, 'approval', now)
      return {
        ...next,
        waiting: { callId: event.call.id, name: event.call.name, since: now },
        entries: push(next, {
          at: now,
          stage: 'approval',
          label: `等待审批 ${event.call.name}`,
          ...(event.reason ? { detail: event.reason } : {}),
        }),
      }
    }
    case 'tool.approval_resolved': {
      if (!previous) return undefined
      const { waiting: _drop, ...rest } = previous
      const next = moveStage({ ...rest, waiting: undefined }, 'tool', now)
      return {
        ...next,
        entries: push(next, {
          at: now,
          stage: 'tool',
          label: `${event.approved ? '已允许' : '已拒绝'} ${event.name ?? event.callId}`,
          ...(event.reason ? { detail: event.reason } : {}),
        }),
      }
    }
    case 'tool.result': {
      if (!previous) return undefined
      const next = moveStage(previous, 'tool', now)
      return {
        ...next,
        entries: push(next, {
          at: now,
          stage: 'tool',
          label: `${event.name} ${event.result.ok ? '完成' : '失败'}`,
          ...(event.result.ok ? {} : { detail: String(event.result.error ?? '').slice(0, 120) }),
        }),
      }
    }
    case 'context.compacted': {
      if (!previous) return undefined
      const next = moveStage(previous, 'compacting', now)
      return {
        ...next,
        entries: push(next, {
          at: now,
          stage: 'compacting',
          label: '压缩上下文',
          detail: `移除 ${event.droppedMessages} 条，整理 ${event.compactedResults} 条工具输出`,
        }),
      }
    }
    case 'run.completed': {
      if (!previous) return undefined
      const next = moveStage(previous, 'done', now)
      return {
        ...next,
        waiting: undefined,
        durationMs: event.durationMs,
        status: event.status,
        entries: push(next, {
          at: now,
          stage: 'done',
          label: `运行结束（${event.status}，${event.steps} 步）`,
        }),
      }
    }
    case 'run.failed': {
      if (!previous) return undefined
      const next = moveStage(previous, 'failed', now)
      return {
        ...next,
        waiting: undefined,
        error: event.message,
        entries: push(next, {
          at: now,
          stage: 'failed',
          label: `运行失败：${event.code}`,
          detail: event.message.slice(0, 200),
        }),
      }
    }
    default:
      return undefined
  }
}

function emptyTrail(sessionId: string, runId: string, now: number): RunTrail {
  return {
    sessionId,
    runId,
    stage: 'starting',
    stageSince: now,
    updatedAt: now,
    step: 0,
    entries: [],
    toolCalls: 0,
  }
}

/**
 * 增量事件可能比 `run.started` 先到（重新连上一个已经在跑的会话），
 * 这时补一条起头记录，而不是丢掉后面所有事件。
 */
function resolve(
  previous: RunTrail | undefined,
  sessionId: string,
  runId: string,
  now: number,
): RunTrail {
  if (previous && previous.runId === runId) return previous
  return emptyTrail(sessionId, runId, now)
}

/**
 * 面板顶部的一句话：不只说阶段，还说「现在该看谁」。
 * 卡在模型上说明慢在服务端；卡在审批说明在等人；卡在工具说明在等命令。
 */
export function trailHint(trail: RunTrail, now: number): string {
  const held = Math.max(0, now - trail.stageSince)
  const seconds = Math.round(held / 1000)
  switch (trail.stage) {
    case 'model':
      return seconds >= 45
        ? `已等待模型 ${seconds} 秒。慢在这里说明请求发出去了，瓶颈在模型服务或网络，不在本机。`
        : `正在等模型回复（${seconds} 秒）。`
    case 'thinking':
      return `模型正在推理（${seconds} 秒）。`
    case 'tool':
      return `正在执行工具（${seconds} 秒）。长时间不动说明命令本身没返回，可在运行日志里按 "tool" 过滤。`
    case 'approval':
      return trail.waiting
        ? `正在等你审批「${trail.waiting.name}」（${seconds} 秒）。任务不是卡住，是在等你的决定。`
        : `正在等待审批（${seconds} 秒）。`
    case 'compacting':
      return `正在压缩上下文（${seconds} 秒）。会话很长时会走到这一步，完成后会继续。`
    case 'done':
      return trail.status === 'completed'
        ? '运行已正常结束。'
        : `运行已结束：${trail.status ?? '未知状态'}。`
    case 'failed':
      return `运行失败：${trail.error ?? '未知错误'}`
    default:
      return `准备中（${seconds} 秒）。`
  }
}
