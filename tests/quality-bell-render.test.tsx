import './locale-zh.mjs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { NotificationCenter } from '../src/renderer/src/components/NotificationCenter'
import { QualityBellPanel } from '../src/renderer/src/components/QualityBell'
import { QualityDialog } from '../src/renderer/src/components/QualityDialog'
import type { NoticeEntry } from '../src/renderer/src/notifications'
import { defaultMetricSet, scoreMetrics } from '../src/shared/quality'
import type { QualityCandidate, QualityState } from '../src/shared/types'

/**
 * 产出质量面板是这条链路唯一由人看到的界面，所以直接渲染真实组件断言文案：
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

describe('NotificationCenter badge', () => {
  const notice = (overrides: Partial<NoticeEntry> = {}): NoticeEntry => ({
    id: 1,
    message: '已复制',
    level: 'info',
    at: Date.now(),
    source: 'app',
    read: false,
    ...overrides,
  })

  function renderCenter(overrides: Partial<Parameters<typeof NotificationCenter>[0]> = {}) {
    return renderToStaticMarkup(
      <NotificationCenter
        open={false}
        notices={[]}
        pendingApprovals={0}
        onOpenChange={noop}
        onMarkAllRead={noop}
        onClear={noop}
        {...overrides}
      />,
    )
  }

  it('未读提醒与待审批一起计数，弹层默认关闭', () => {
    const html = renderCenter({
      notices: [notice(), notice({ id: 2, level: 'warn' })],
      pendingApprovals: 1,
    })
    expect(html).toContain('quality-bell-badge')
    expect(html).toContain('>3<')
    expect(html).toContain('3 条未读通知')
    expect(html).toContain('quality-bell-button alert')
    expect(html).not.toContain('notice-pop')
  })

  it('没有未读、没有待审批时只显示普通铃铛，不报假数', () => {
    const html = renderCenter({ notices: [notice({ read: true })] })
    expect(html).not.toContain('quality-bell-badge')
    expect(html).not.toContain('quality-bell-button alert')
    expect(html).toContain('通知与提醒')
  })

  it('打开时把提醒历史列出来，并单独提示待审批的调用', () => {
    const html = renderCenter({
      open: true,
      notices: [notice({ message: '这个配对请求已失效，请让手机重新扫码。', level: 'warn', source: 'session' })],
      pendingApprovals: 2,
    })
    expect(html).toContain('这个配对请求已失效，请让手机重新扫码。')
    expect(html).toContain('会话')
    expect(html).toContain('2 个工具调用等待你审批')
    expect(html).toContain('全部已读')
  })

  it('没有提醒时说明这里会留什么，而不是空面板', () => {
    const html = renderCenter({ open: true })
    expect(html).toContain('会话中的提示、更新与后台任务提醒都会留在这里')
  })

  it('质量裁决不在通知中心里：铃铛只管提醒与审批', () => {
    const html = renderCenter({ open: true })
    expect(html).not.toContain('产出质量')
    expect(html).not.toContain('立即评估')
    expect(html).not.toContain('notice-tabs')
  })
})

describe('QualityDialog', () => {
  function renderDialog(overrides: Partial<Parameters<typeof QualityDialog>[0]> = {}) {
    return renderToStaticMarkup(
      <QualityDialog
        state={state()}
        publishTarget="package:dir"
        workspacePath="/ws"
        busy={false}
        onClose={noop}
        onDecide={noop}
        onPublish={noop}
        onEvaluate={noop}
        onTune={noop}
        {...overrides}
      />,
    )
  }

  it('弹窗里渲染闸门面板，并自带关闭按钮', () => {
    const html = renderDialog()
    expect(html).toContain('aria-label="产出质量"')
    expect(html).toContain('候选 #3')
    expect(html).toContain('立即评估')
    expect(html).toContain('aria-label="关闭"')
  })

  it('没有工作区或质量数据时给出下一步，不渲染空白弹窗', () => {
    const html = renderDialog({ workspacePath: null, state: null })
    expect(html).toContain('先选择一个工作区')
    expect(html).not.toContain('候选 #3')
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
