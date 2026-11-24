import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { setLocale } from '../src/renderer/src/i18n'
import { ContinueBar } from '../src/renderer/src/components/chat/panels'
import { FAILURE_ACTION_TEXT, failureAction } from '../src/shared/run-failure'
import type { Session } from '../src/shared/types'

// Assertions pin the Chinese source copy, so pin the locale first: the runner's
// navigator.language would otherwise pick English on some machines.
setLocale('zh-CN')

function session(overrides: Partial<Session>): Session {
  return {
    id: 'session-1',
    title: '恢复条',
    workspacePath: 'E:/work',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    running: false,
    paused: false,
    canContinue: true,
    messageCount: 2,
    queueCount: 0,
    todoCount: 0,
    approvalMode: 'auto',
    sessionModelId: '',
    plan: null,
    kind: 'task',
    review: null,
    reviewReport: null,
    messages: [],
    queue: [],
    todos: [],
    ...overrides,
  } as Session
}

function render(overrides: Partial<Session>, withSettings = false): string {
  return renderToStaticMarkup(
    <ContinueBar
      session={session(overrides)}
      busy={false}
      onContinue={() => {}}
      {...(withSettings ? { onOpenSettings: () => {} } : {})}
    />,
  )
}

/**
 * 28% of recorded runs ended on one generic sentence that named neither the
 * cause nor the action. These cases lock in the four outcomes: a wrong key asks
 * for a settings fix, a step cap says what is kept, a network drop says retry,
 * and a user pause keeps showing where it stopped.
 */
describe('ContinueBar', () => {
  it('names a denied model or an empty balance and offers the fix', () => {
    const html = render({
      lastRunStatus: 'failed',
      lastRunError: 'Qwen request failed (403): Access to model denied for this account',
    })
    expect(html).toContain('模型或账号配置需要处理')
    // The body names the one thing to change; the provider's text stays as the
    // tooltip so the evidence is not lost.
    expect(html).toContain('账号无权使用这个模型')
    expect(html).toContain('Qwen request failed (403)')
    expect(html).toContain('已修复，继续')
    expect(html).not.toContain('从上次中断的地方继续')
  })

  it('asks for a top-up on 402 and a new key on 401', () => {
    const balance = render({
      lastRunStatus: 'failed',
      lastRunError: 'glm reports insufficient balance (402)',
    })
    expect(balance).toContain('账户余额不足')
    const key = render({
      lastRunStatus: 'failed',
      lastRunError: 'DeepSeek rejected the API key (401). Check it in Settings.',
    })
    expect(key).toContain('在设置里换一个有效的 API Key')
  })

  it('turns a step cap into a budget note instead of a generic restart', () => {
    const html = render({ lastRunStatus: 'max_steps' })
    expect(html).toContain('达到步数上限')
    expect(html).toContain('已完成的部分已保留在工作区')
    expect(html).toContain('继续')
  })

  it('asks for a retry when the transport dropped', () => {
    const html = render({ lastRunStatus: 'failed', lastRunError: 'TypeError: fetch failed' })
    expect(html).toContain('网络或服务端中断')
    expect(html).toContain('重试通常即可恢复')
    expect(html).toContain('重试')
  })

  it('keeps the generic sentence only when the cause really is unknown', () => {
    const html = render({ lastRunStatus: 'interrupted' })
    expect(html).toContain('上次任务没有正常结束')
    expect(html).toContain('从上次中断的地方继续')
    expect(html).toContain('继续')
  })

  it('shows the pause instruction before any run cause', () => {
    const html = render({
      paused: true,
      pauseInstruction: '第三步：跑完 tests/session-store.test.ts',
      lastRunStatus: 'failed',
      lastRunError: 'Qwen request failed (403): Access to model denied',
    })
    expect(html).toContain('任务已暂停')
    expect(html).toContain('进度停在：第三步：跑完')
    expect(html).not.toContain('模型或账号配置需要处理')
  })

  it('keeps a long provider message short enough for one line', () => {
    const html = render({
      lastRunStatus: 'failed',
      lastRunError: `Access to model denied for this account: ${'x'.repeat(400)}`,
    })
    expect(html.length).toBeLessThan(1600)
    expect(html).toContain('模型或账号配置需要处理')
    expect(html).toContain('账号无权使用这个模型')
    // The tooltip is truncated, so neither the body nor the attribute carries
    // the whole echoed page.
    expect(html).not.toContain('x'.repeat(200))
  })

  it('says how far the last run got instead of only where it stopped', () => {
    const html = render({
      lastRunStatus: 'max_steps',
      lastRunSteps: 103,
      plan: {
        goal: 'ship it',
        updatedAt: '2026-01-01T00:00:00.000Z',
        items: [
          { id: 'p1', text: 'read', status: 'done' },
          { id: 'p2', text: 'edit', status: 'in_progress' },
          { id: 'p3', text: 'test', status: 'pending' },
        ],
      },
    })
    expect(html).toContain('上次运行停在：第 103 步')
    expect(html).toContain('计划已完成 1/3 项')
  })

  it('shows plan progress even when the user paused the run', () => {
    const html = render({
      paused: true,
      plan: {
        goal: 'ship it',
        updatedAt: '2026-01-01T00:00:00.000Z',
        items: [
          { id: 'p1', text: 'read', status: 'done' },
          { id: 'p2', text: 'edit', status: 'done' },
        ],
      },
    })
    expect(html).toContain('计划已完成 2/2 项')
    expect(html).not.toContain('上次运行停在')
  })

  it('omits the step line for a run that never took a step', () => {
    const html = render({ lastRunStatus: 'failed', lastRunError: 'TypeError: fetch failed' })
    expect(html).not.toContain('上次运行停在')
    expect(html).not.toContain('计划已完成')
  })

  it('makes Settings the primary action for a config failure', () => {
    const html = render(
      { lastRunStatus: 'failed', lastRunError: 'glm reports insufficient balance (402)' },
      true,
    )
    // The fix lives in Settings, so that is the primary button; continuing is
    // still offered for someone who already fixed it elsewhere.
    expect(html).toContain('打开设置')
    expect(html).toContain('已修复，继续')
    expect(html).toMatch(/class="button"[^>]*>.*已修复，继续/s)
    expect(html).toMatch(/class="button primary"[^>]*>.*打开设置/s)
  })

  it('keeps continue primary when no settings handler is passed', () => {
    const html = render({
      lastRunStatus: 'failed',
      lastRunError: 'glm reports insufficient balance (402)',
    })
    expect(html).not.toContain('打开设置')
    expect(html).toMatch(/class="button primary"[^>]*>.*已修复，继续/s)
  })

  it('does not offer a settings detour for a step-budget or network stop', () => {
    const budget = render({ lastRunStatus: 'max_steps' }, true)
    expect(budget).not.toContain('打开设置')
    const network = render(
      { lastRunStatus: 'failed', lastRunError: 'TypeError: fetch failed' },
      true,
    )
    expect(network).not.toContain('打开设置')
    expect(network).toMatch(/class="button primary"[^>]*>.*重试/s)
  })

  it('shows exactly the shared action sentence for every config failure', () => {    // The renderer keeps its own literal `t()` keys so the dictionary can be
    // applied; this compares each of them with shared/run-failure, the table the
    // agent loop puts into its notice. If the two ever drift, the bar and the
    // notice would name different fixes for the same error.
    const cases = [
      'DeepSeek rejected the API key (401).',
      'glm reports insufficient balance (402)',
      'Qwen request failed (403): Access to model denied',
      'DeepSeek request failed (400): model does not exist',
    ]
    for (const error of cases) {
      const action = failureAction(error)
      expect(action).not.toBeNull()
      const html = render({ lastRunStatus: 'failed', lastRunError: error })
      expect(html).toContain(FAILURE_ACTION_TEXT[action!])
    }
  })

  it('translates the four config sentences instead of showing Chinese to English users', () => {
    // The detail used to be `t(FAILURE_ACTION_TEXT[action])`, a key built at run
    // time, so `t()` never saw it and the dictionary could not apply: an English
    // UI showed the Chinese sentence. The four literal `t()` keys fix that.
    setLocale('en')
    try {
      const cases: Array<[string, string]> = [
        ['DeepSeek rejected the API key (401).', 'Replace the API key in Settings'],
        ['glm reports insufficient balance (402)', 'The account is out of balance'],
        ['Qwen request failed (403): Access to model denied', 'This account may not use that model'],
        ['DeepSeek request failed (400): model does not exist', 'Check the model name, API key and account balance'],
      ]
      for (const [error, expected] of cases) {
        const html = render({ lastRunStatus: 'failed', lastRunError: error })
        expect(html).toContain(expected)
        expect(html).not.toMatch(/[一-龥]/)
      }
    } finally {
      setLocale('zh-CN')
    }
  })
})
