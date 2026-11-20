import './locale-zh.mjs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { QualityBell, QualityBellPanel } from '../src/renderer/src/components/QualityBell'
import { defaultMetricSet, scoreMetrics } from '../src/shared/quality'
import type { QualityCandidate, QualityState } from '../src/shared/types'

/**
 * 铃铛是这条链路唯一由人看到的界面，所以直接渲染真实组件断言文案：
 * 待授权候选必须同时出现分数、差值、理由、两个决策按钮，以及"批准=打包"的后果。
 */

const metricSet = defaultMetricSet()

function score(total: number) {
  return scoreMetrics(
    metricSet,
    {
      passRate: total,
      verification: total,
      toolHealth: total,
      satisfaction: total,
      efficiency: total,
      reviewScore: total,
    },
    '2026-01-01T00:00:00.000Z',
  )
}

function candidate(overrides: Partial<QualityCandidate> = {}): QualityCandidate {
  const next = score(92)
  return {
    id: 'cand-1',
    workspacePath: '/ws',
    version: 3,
    createdAt: '2026-01-01T00:00:00.000Z',
    metricVersion: metricSet.version,
    score: next,
    baseline: score(70),
    comparison: { better: true, delta: 22, regressions: [], reason: '总分 70 → 92（门槛 3 分）' },
    verdict: '输出可用且附带验证命令',
    evidence: { runs: 12, failures: 1, source: 'records+judge', samples: {} },
    status: 'awaiting_user',
    log: [],
    ...overrides,
  }
}

function state(overrides: Partial<QualityState> = {}): QualityState {
  return { metricSet, baseline: score(70), candidates: [candidate()], ...overrides }
}

const noop = (): void => {}

function renderPanel(
  overrides: Partial<Parameters<typeof QualityBellPanel>[0]> = {},
): string {
  return renderToStaticMarkup(
    <QualityBellPanel
      state={state()}
      publishTarget="package:dir"
      busy={false}
      onDecide={noop}
      onPublish={noop}
      onEvaluate={noop}
      onTune={noop}
      {...overrides}
    />,
  )
}

describe('QualityBell badge', () => {
  it('有待授权候选时显示数字角标与提示', () => {
    const html = renderToStaticMarkup(
      <QualityBell
        workspacePath="/ws"
        state={state()}
        publishTarget="package:dir"
        busy={false}
        onDecide={noop}
        onPublish={noop}
        onEvaluate={noop}
        onTune={noop}
      />,
    )
    expect(html).toContain('quality-bell-badge')
    expect(html).toContain('>1<')
    expect(html).toContain('1 个更优版本等待授权')
    expect(html).toContain('quality-bell-button alert')
    // 弹层默认关闭：不占屏幕
    expect(html).not.toContain('quality-pop')
  })

  it('只有已记录的候选时不亮角标，只报当前分数', () => {
    const html = renderToStaticMarkup(
      <QualityBell
        workspacePath="/ws"
        state={state({ candidates: [candidate({ status: 'recorded', comparison: { better: false, delta: 1, regressions: [], reason: '未达门槛' } })] })}
        publishTarget="none"
        busy={false}
        onDecide={noop}
        onPublish={noop}
        onEvaluate={noop}
        onTune={noop}
      />,
    )
    expect(html).not.toContain('quality-bell-badge')
    expect(html).toContain('产出质量 70 分（点击查看评估指标）')
  })

  it('没有工作区或没有状态时不渲染任何东西', () => {
    expect(
      renderToStaticMarkup(
        <QualityBell
          workspacePath={null}
          state={state()}
          publishTarget="none"
          busy={false}
          onDecide={noop}
          onPublish={noop}
          onEvaluate={noop}
          onTune={noop}
        />,
      ),
    ).toBe('')
  })
})

describe('QualityBellPanel', () => {
  it('把待授权候选讲清楚：分数、差值、理由、评估结论', () => {
    const html = renderPanel()
    expect(html).toContain('现行版本 70 分 · 指标集 v1')
    expect(html).toContain('候选 #3')
    expect(html).toContain('>92<')
    expect(html).toContain('+22')
    expect(html).toContain('总分 70 → 92')
    expect(html).toContain('输出可用且附带验证命令')
    expect(html).toContain('等待你授权')
  })

  it('批准按钮说明会真的打包，拒绝按钮同时在场', () => {
    const html = renderPanel()
    expect(html).toContain('批准并打包发布')
    expect(html).toContain('批准后更新基线，并用 打包到目录（package:dir） 打包发布')
    expect(html).toContain('拒绝')
  })

  it('未配置打包目标时，批准只写基线并把按钮改成"仅更新基线"', () => {
    const html = renderPanel({ publishTarget: 'none' })
    expect(html).toContain('批准（仅更新基线）')
    expect(html).not.toContain('批准并打包发布')
    expect(html).toContain('未配置打包目标，不会自动打包')
    expect(html).toContain('不自动打包')
  })

  it('已批准但未打包的候选给出打包入口，目标未配置时按钮禁用并说明原因', () => {
    const approved = candidate({ status: 'approved' })
    const enabled = renderPanel({ state: state({ candidates: [approved] }) })
    expect(enabled).toContain('已批准，待打包')
    expect(enabled).toContain('开始打包')

    const disabled = renderPanel({ state: state({ candidates: [approved] }), publishTarget: 'none' })
    expect(disabled).toContain('先在设置里选择打包目标')
    expect(disabled).toContain('disabled')
  })

  it('打包失败把失败原因直接摆在卡片上', () => {
    const html = renderPanel({
      state: state({
        candidates: [candidate({ status: 'failed', failure: '打包退出码 2' })],
      }),
    })
    expect(html).toContain('打包失败')
    expect(html).toContain('打包退出码 2')
    // 失败候选不能再点批准或打包
    expect(html).not.toContain('批准并打包发布')
    expect(html).not.toContain('开始打包')
  })

  it('正在打包/评估时按钮全部禁用，避免重复触发', () => {
    const html = renderPanel({ busy: true })
    const buttons = html.match(/<button[^>]*>/g) ?? []
    expect(buttons.length).toBeGreaterThan(2)
    expect(buttons.every((tag) => tag.includes('disabled'))).toBe(true)
  })

  it('没有候选时说明下一步该做什么，而不是空面板', () => {
    const html = renderPanel({ state: state({ baseline: null, candidates: [] }) })
    expect(html).toContain('尚未建立基线：下一次评估将成为基线')
    expect(html).toContain('还没有候选版本')
    // 存在更低分的"现行版本"时会误导，所以确认没有渲染分数行
    expect(html).not.toContain('现行版本')
  })
})
