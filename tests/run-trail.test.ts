import { describe, expect, it } from 'vitest'
import type { RunEvent } from '../src/shared/types'
import { STAGE_LABEL, applyTrailEvent, trailHint, type RunTrail } from '../src/renderer/src/run-trail'

/**
 * 卡点视图的唯一价值是「说得准」：它告诉用户现在是等模型、等审批还是等命令。
 * 这些用例把每条 RunEvent 到阶段的映射钉住，改事件字段时会立刻红。
 */

const T0 = 1_700_000_000_000

function runStarted(now = T0, runId = 'r1'): RunEvent {
  return {
    type: 'run.started',
    sessionId: 's1',
    runId,
    profileVersion: 1,
    mode: 'auto',
  } as RunEvent
}

function feed(events: RunEvent[], from?: RunTrail): RunTrail | undefined {
  let trail = from
  events.forEach((event, index) => {
    trail = applyTrailEvent(trail, event, T0 + (index + 1) * 1000)
  })
  return trail
}

describe('applyTrailEvent', () => {
  it('从 run.started 起头，阶段是准备运行', () => {
    const trail = applyTrailEvent(undefined, runStarted(), T0)
    expect(trail?.stage).toBe('starting')
    expect(trail?.step).toBe(0)
    expect(trail?.entries).toHaveLength(1)
    expect(STAGE_LABEL[trail!.stage]).toBe('准备运行')
  })

  it('step.started 把阶段切到等模型并记步数', () => {
    const trail = feed([
      runStarted(),
      { type: 'step.started', sessionId: 's1', runId: 'r1', step: 3 } as RunEvent,
    ])
    expect(trail?.stage).toBe('model')
    expect(trail?.step).toBe(3)
  })

  it('tool.call 切到执行工具并累计调用次数', () => {
    const call = {
      type: 'tool.call',
      sessionId: 's1',
      runId: 'r1',
      call: { id: 'c1', name: 'read_file', arguments: {} },
      risk: 'read',
    } as unknown as RunEvent
    const trail = feed([runStarted(), call, { ...call, call: { id: 'c2', name: 'run_shell', arguments: {} } } as RunEvent])
    expect(trail?.stage).toBe('tool')
    expect(trail?.toolCalls).toBe(2)
  })

  it('审批请求把阶段切到等待审批，且带上是哪个工具', () => {
    const trail = feed([
      runStarted(),
      {
        type: 'tool.approval_required',
        sessionId: 's1',
        runId: 'r1',
        call: { id: 'c1', name: 'run_shell', arguments: {} },
        risk: 'exec',
        reason: 'needs confirmation',
      } as unknown as RunEvent,
    ])
    expect(trail?.stage).toBe('approval')
    expect(trail?.waiting?.name).toBe('run_shell')
    // 提示语必须说清「在等人」，否则用户会以为卡死。
    expect(trailHint(trail!, T0 + 5000)).toContain('审批')
  })

  it('审批结果清掉等待态并回到执行工具', () => {
    const trail = feed([
      runStarted(),
      {
        type: 'tool.approval_required',
        sessionId: 's1',
        runId: 'r1',
        call: { id: 'c1', name: 'run_shell', arguments: {} },
        risk: 'exec',
      } as unknown as RunEvent,
      {
        type: 'tool.approval_resolved',
        sessionId: 's1',
        runId: 'r1',
        callId: 'c1',
        approved: true,
        name: 'run_shell',
      } as unknown as RunEvent,
    ])
    expect(trail?.stage).toBe('tool')
    expect(trail?.waiting).toBeUndefined()
  })

  it('run.completed 收尾并记下状态与耗时', () => {
    const trail = feed([
      runStarted(),
      {
        type: 'run.completed',
        sessionId: 's1',
        runId: 'r1',
        status: 'completed',
        steps: 4,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        durationMs: 12_000,
      } as unknown as RunEvent,
    ])
    expect(trail?.stage).toBe('done')
    expect(trail?.durationMs).toBe(12_000)
    expect(trailHint(trail!, T0 + 20_000)).toContain('正常结束')
  })

  it('run.failed 把错误原文留在轨迹里', () => {
    const trail = feed([
      runStarted(),
      {
        type: 'run.failed',
        sessionId: 's1',
        runId: 'r1',
        code: 'provider_error',
        message: 'upstream 529',
      } as unknown as RunEvent,
    ])
    expect(trail?.stage).toBe('failed')
    expect(trail?.error).toBe('upstream 529')
  })

  it('与本次运行无关的广播不改变轨迹', () => {
    const base = applyTrailEvent(undefined, runStarted(), T0)
    expect(applyTrailEvent(base, { type: 'queue.changed', sessionId: 's1', queue: [] } as unknown as RunEvent, T0 + 1)).toBeUndefined()
  })

  it('新运行的 run.started 覆盖旧轨迹', () => {
    const first = applyTrailEvent(undefined, runStarted(T0, 'r1'), T0)
    const second = applyTrailEvent(first, runStarted(T0 + 5000, 'r2'), T0 + 5000)
    expect(second?.runId).toBe('r2')
    expect(second?.entries).toHaveLength(1)
  })

  it('事件早于 run.started 到达时不丢事件，补一条起头轨迹', () => {
    const trail = applyTrailEvent(
      undefined,
      { type: 'step.started', sessionId: 's1', runId: 'r9', step: 1 } as RunEvent,
      T0,
    )
    expect(trail?.runId).toBe('r9')
    expect(trail?.stage).toBe('model')
  })

  it('轨迹条数有上限，不会无限增长', () => {
    let trail = applyTrailEvent(undefined, runStarted(), T0)
    for (let index = 0; index < 120; index += 1) {
      trail = applyTrailEvent(
        trail,
        { type: 'step.started', sessionId: 's1', runId: 'r1', step: index } as RunEvent,
        T0 + index,
      )
    }
    expect(trail!.entries.length).toBeLessThanOrEqual(40)
  })
  it('reasoning.delta 把阶段从等模型切到推理中，后续增量不再触发更新', () => {
    const trail = feed([
      runStarted(),
      { type: 'step.started', sessionId: 's1', runId: 'r1', step: 1 } as RunEvent,
      { type: 'reasoning.delta', sessionId: 's1', runId: 'r1', text: '先看' } as RunEvent,
    ])!
    expect(trail.stage).toBe('thinking')
    expect(trail.entries[0]?.label).toBe('模型开始推理')
    // 第二条增量必须返回 undefined：App 据此跳过 setState，一秒几十条不会变成几十次重画。
    expect(
      applyTrailEvent(
        trail,
        { type: 'reasoning.delta', sessionId: 's1', runId: 'r1', text: '再看' } as RunEvent,
        T0 + 9_000,
      ),
    ).toBeUndefined()
    expect(trailHint(trail, T0 + 3_000)).toContain('模型正在推理')
  })
})

describe('trailHint', () => {
  it('等模型超过 45 秒时明确指出瓶颈不在本机', () => {
    const trail = feed([
      runStarted(),
      { type: 'step.started', sessionId: 's1', runId: 'r1', step: 1 } as RunEvent,
    ])!
    const hint = trailHint(trail, T0 + 2_000 + 60_000)
    expect(hint).toContain('瓶颈在模型服务')
  })
})
