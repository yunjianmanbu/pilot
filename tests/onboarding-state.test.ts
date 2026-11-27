import { describe, expect, it } from 'vitest'
import {
  ONBOARDING_SAMPLE_APPROVAL_MODE,
  ONBOARDING_SAMPLE_TASK,
  ONBOARDING_SKIP_KEY,
  ONBOARDING_STEPS,
  onboardingDoneCount,
  onboardingStep,
  onboardingVisible,
  readOnboardingSkipped,
  writeOnboardingSkipped,
  type OnboardingStorage,
  type OnboardingVisibilityInput,
} from '../src/shared/onboarding'
import { normalizeApprovalMode } from '../src/main/store-schema'

/**
 * 首启引导的三条规则都在这里钉住，它们比样式更容易写错：
 *
 * 1. 只有「启动时没有 Key」的机器看得见——老用户和恢复过设置的机器不该被打断；
 * 2. 点过跳过之后永不再出现；
 * 3. 第一步配好 Key 之后，引导不能就此消失，否则第 2、3 步永远学不到。
 */

function visible(over: Partial<OnboardingVisibilityInput> = {}): boolean {
  return onboardingVisible({
    booted: true,
    keyAtStart: false,
    skipped: false,
    ...over,
  })
}

function fakeStorage(initial: Record<string, string> = {}): OnboardingStorage & {
  data: Record<string, string>
} {
  const data = { ...initial }
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value
    },
  }
}

describe('首启引导的出现条件', () => {
  it('无 Key、未跳过、bootstrap 已回来 → 出现', () => {
    expect(visible()).toBe(true)
  })

  it('启动时就已有 Key 的机器永远不出现', () => {
    // 重装后恢复设置、导入过工作区包的用户都属于这一类。
    expect(visible({ keyAtStart: true })).toBe(false)
  })

  it('bootstrap 还没回来时先不渲染，避免闪一下再消失', () => {
    expect(visible({ booted: false })).toBe(false)
    expect(visible({ keyAtStart: null })).toBe(false)
  })

  it('点过跳过之后不再出现', () => {
    expect(visible({ skipped: true })).toBe(false)
  })

  it('配好 Key 之后继续显示：判定只看启动快照，不看当前 hasKey', () => {
    // 回归点：如果拿当前 hasKey 判定，引导会在配好 Key 的那一刻消失，
    // 用户永远看不到第 2、3 步。快照是 false，所以它继续留在屏幕上。
    expect(visible({ keyAtStart: false })).toBe(true)
  })
})

describe('当前停在第几步', () => {
  it('没 Key 先配 Key', () => {
    expect(onboardingStep({ hasKey: false, hasWorkspace: false })).toBe('key')
    // 有工作区但没 Key 也一样：没有 Key 什么都发不出去。
    expect(onboardingStep({ hasKey: false, hasWorkspace: true })).toBe('key')
  })

  it('有 Key 没工作区 → 选工作区', () => {
    expect(onboardingStep({ hasKey: true, hasWorkspace: false })).toBe('workspace')
  })

  it('两样都齐 → 跑只读示例', () => {
    expect(onboardingStep({ hasKey: true, hasWorkspace: true })).toBe('sample')
  })

  it('完成度就是「当前步之前有几步」，前三步依次是 0/1/2', () => {
    expect(onboardingDoneCount('key')).toBe(0)
    expect(onboardingDoneCount('workspace')).toBe(1)
    expect(onboardingDoneCount('sample')).toBe(2)
    expect(ONBOARDING_STEPS).toHaveLength(3)
    expect(ONBOARDING_STEPS).toEqual(['key', 'workspace', 'sample'])
  })
})

describe('跳过标记的读写', () => {
  it('默认是「没跳过」：读不到或读坏了都不能把引导藏起来', () => {
    expect(readOnboardingSkipped(null)).toBe(false)
    expect(readOnboardingSkipped(fakeStorage())).toBe(false)
    expect(readOnboardingSkipped(fakeStorage({ [ONBOARDING_SKIP_KEY]: '乱码' }))).toBe(false)
    // 存储属性访问直接抛（沙箱禁了本地存储）时也不能炸。
    const throwing: OnboardingStorage = {
      getItem: () => {
        throw new Error('storage disabled')
      },
      setItem: () => {
        throw new Error('storage disabled')
      },
    }
    expect(readOnboardingSkipped(throwing)).toBe(false)
    expect(() => writeOnboardingSkipped(true, throwing)).not.toThrow()
  })

  it('写进去能读回来，撤销后回到「没跳过」', () => {
    const store = fakeStorage()
    writeOnboardingSkipped(true, store)
    expect(store.data[ONBOARDING_SKIP_KEY]).toBe('1')
    expect(readOnboardingSkipped(store)).toBe(true)
    writeOnboardingSkipped(false, store)
    expect(readOnboardingSkipped(store)).toBe(false)
  })
})

describe('只读示例任务本身', () => {
  it('任务文案自己就写明不写文件、不执行命令', () => {
    expect(ONBOARDING_SAMPLE_TASK).toContain('不要修改任何文件')
    expect(ONBOARDING_SAMPLE_TASK).toContain('不要执行命令')
    expect(ONBOARDING_SAMPLE_TASK).toContain('只读')
  })

  it('示例会话的档位落到存档后还是同一个值', () => {
    // 曾经写过 'plan'：createSession 用 plan 建会话、updateSession 传 plan，
    // 但 normalizeApprovalMode 会把它折叠成 manual，于是调用里一个值、存档里另一个值。
    expect(ONBOARDING_SAMPLE_APPROVAL_MODE).toBe('manual')
    expect(normalizeApprovalMode(ONBOARDING_SAMPLE_APPROVAL_MODE)).toBe(
      ONBOARDING_SAMPLE_APPROVAL_MODE,
    )
  })
})
