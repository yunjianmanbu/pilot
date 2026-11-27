import './locale-zh.mjs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { OnboardingGuide } from '../src/renderer/src/components/OnboardingGuide'

/**
 * 引导条只负责画，这里钉住三件会直接影响体验的事：
 *
 * 1. 每一步的按钮必须真的接到对应的动作上（配 Key / 选工作区 / 跑示例），
 *    接错的话用户会点半天没反应；
 * 2. 已经做完的步骤打对勾，未到的步骤是灰的，让人看得出自己在第几步；
 * 3. 「跳过」永远在，并且第三步跑起来之后按钮要锁住。
 *
 * 动作是否被调用用渲染出的 `onClick` 挂载点判断不了（静态渲染不跑事件），
 * 所以这里断言的是 DOM 结构与文案，动作接线由 App 侧的类型检查兜住。
 */

describe('首启引导条', () => {
  it('第一步：配 Key，提示里有跳过按钮与三步索引', () => {
    const html = renderToStaticMarkup(
      <OnboardingGuide
        step="key"
        running={false}
        onConfigureKey={vi.fn()}
        onPickWorkspace={vi.fn()}
        onRunSample={vi.fn()}
        onSkip={vi.fn()}
      />,
    )
    expect(html).toContain('三步开始使用 Pilot')
    expect(html).toContain('去配置 API Key')
    expect(html).toContain('跳过引导')
    // 三步都在索引里，一个不少。
    expect(html).toContain('配置 API Key')
    expect(html).toContain('选择工作区')
    expect(html).toContain('跑一个只读示例')
  })

  it('第二步：第一步打了勾，第二步是当前步，按钮换成选文件夹', () => {
    const html = renderToStaticMarkup(
      <OnboardingGuide
        step="workspace"
        running={false}
        onConfigureKey={vi.fn()}
        onPickWorkspace={vi.fn()}
        onRunSample={vi.fn()}
        onSkip={vi.fn()}
      />,
    )
    expect(html.match(/is-done/g) ?? []).toHaveLength(1)
    expect(html.match(/is-active/g) ?? []).toHaveLength(1)
    expect(html).toContain('选择工作区文件夹')
    expect(html).not.toContain('去配置 API Key')
  })

  it('第三步：写明示例会话是只读档位，避免用户以为被锁死', () => {
    const html = renderToStaticMarkup(
      <OnboardingGuide
        step="sample"
        running={false}
        onConfigureKey={vi.fn()}
        onPickWorkspace={vi.fn()}
        onRunSample={vi.fn()}
        onSkip={vi.fn()}
      />,
    )
    expect(html.match(/is-done/g) ?? []).toHaveLength(2)
    expect(html).toContain('跑一个只读示例任务')
    expect(html).toContain('只读档位')
  })

  it('示例会话创建期间按钮锁住，文案改成进行中', () => {
    const html = renderToStaticMarkup(
      <OnboardingGuide
        step="sample"
        running
        onConfigureKey={vi.fn()}
        onPickWorkspace={vi.fn()}
        onRunSample={vi.fn()}
        onSkip={vi.fn()}
      />,
    )
    expect(html).toContain('正在创建示例会话')
    expect(html).toContain('disabled')
  })
})
