import './locale-zh.mjs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { Welcome } from '../src/renderer/src/components/chat/panels'
import { READONLY_SAMPLES } from '../src/shared/readonly-samples'
import type { WorkspaceSummary } from '../src/shared/types'

/**
 * 空态只画三件事：三条只读示例、「再缺 Key 怎么配」的一个入口、常用指令。
 *
 * 这里钉住的是空态最容易回退的两点：
 *
 * 1. 缺 Key 不再用一条独立横幅占据空态主体——原来的「还差一个 API Key」整块说明
 *    由示例卡片替代，缺 Key 只在示例区右上角留一个可点的小胶囊。空态里再冒出
 *    `composer-warning` 那种橙色横幅，等于同一件事说两遍，还把示例往下挤。
 * 2. 卡片数必须与 `READONLY_SAMPLES` 一致。写死 3 会让「数据加一条、界面还画三条」
 *    这种漂移在测试里看不出来。
 *
 * 动作接线由 App 的类型检查兜住：静态渲染不跑事件。
 */

const workspace: WorkspaceSummary = {
  path: 'E:/demo/project',
  name: 'project',
  addedAt: '2026-01-01T00:00:00.000Z',
  lastOpenedAt: '2026-01-01T00:00:00.000Z',
  sessionCount: 0,
  hasMemory: false,
}

function render(props: { hasKey: boolean; workspace?: WorkspaceSummary | null }): string {
  return renderToStaticMarkup(
    <Welcome
      workspace={'workspace' in props ? (props.workspace ?? null) : workspace}
      hasKey={props.hasKey}
      hasSession={false}
      quickCommands={null}
      onQuickCommandsChange={vi.fn()}
      onPickWorkspace={vi.fn()}
      onOpenSettings={vi.fn()}
      onQuickStart={vi.fn()}
      onRunSample={vi.fn()}
    />,
  )
}

describe('空态只读示例', () => {
  it('每条示例画成一张可点的卡片，数量与数据一致', () => {
    const html = render({ hasKey: true })
    expect(html.match(/class="sample-card"/g) ?? []).toHaveLength(READONLY_SAMPLES.length)
    // 三张卡都在 `<button>` 里，否则「点一下就跑」无从谈起。
    expect(html.match(/<button[^>]*class="sample-card"/g) ?? []).toHaveLength(
      READONLY_SAMPLES.length,
    )
    for (const sample of READONLY_SAMPLES) {
      expect(html).toContain(`title="${sample.prompt.replace(/"/g, '&quot;')}"`)
    }
  })

  it('缺 Key 时只在示例区右上角留一个配置入口，不画空态横幅', () => {
    const html = render({ hasKey: false })
    expect(html).toContain('配置 API Key 后即可运行')
    expect(html).toContain('welcome-samples-key')
    // 旧的整块说明已从空态移除。
    expect(html).not.toContain('welcome-alert')
    expect(html).not.toContain('还差一个 API Key')
  })

  it('已连上模型时说明行改成「点一下就开始」', () => {
    const html = render({ hasKey: true })
    expect(html).toContain('点一下就开始：只读档位运行，不改动任何文件')
    expect(html).not.toContain('welcome-samples-key')
  })

  it('还没选工作区时不画示例，只留选文件夹的动作', () => {
    const html = render({ hasKey: true, workspace: null })
    expect(html).not.toContain('sample-card')
    expect(html).toContain('选择工作区文件夹')
  })
})
