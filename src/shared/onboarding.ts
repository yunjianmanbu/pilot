/**
 * 首启引导：配 Key → 选工作区 → 跑一个只读示例任务。
 *
 * 这里只有判定与存档的纯函数，加上一个窄到可以传假对象的存储接口；
 * 真正把三步画出来的是 renderer 的 OnboardingGuide，读 state 的是 App。
 * 之所以把规则抽出来，是因为「什么时候才该出现」比样式更容易出错：
 *
 * 1. 只有**启动时就没有 API Key** 的机器才见得到它。已经配好 Key 的用户
 *    （含重装后恢复了设置、导入过工作区包的人）永远不该被引导打断。
 * 2. 一旦用户点过「跳过」，或走完了第三步，同一台机器不再出现第二次。
 * 3. 判定只看**启动时的快照**，不看当前 `hasKey`：用户在第一步配好 Key 之后，
 *    快照仍是「没有 Key」，引导因此继续留在屏幕上走完第 2、3 步；否则它会在
 *    配好 Key 的那一刻消失，等于只教了配 Key。
 */

import type { ApprovalMode } from './types'

/** 「不再显示引导」的本地标记。值只用 `'1'` / `'0'`，读不到就当没标记。 */
export const ONBOARDING_SKIP_KEY = 'pilot.onboarding.skipped.v1'

export type OnboardingStepId = 'key' | 'workspace' | 'sample'

/**
 * 三步的顺序就是执行顺序。文案不放在这里：i18n 的覆盖率测试只认渲染层里
 * `t('字面量')` 的写法，把中文搬进 shared 会让“有没有英文”再也查不出来。
 */
export const ONBOARDING_STEPS: OnboardingStepId[] = ['key', 'workspace', 'sample']

/**
 * 第三步发出去的那句话。它自己就把边界写在任务里，即使权限层将来放宽，
 * 模型也不会顺手改文件；当前还叠加了只读档位。
 */
export const ONBOARDING_SAMPLE_TASK =
  '只读示例：先列出这个工作区根目录下的文件（不要修改任何文件、不要执行命令），然后用两三句话说明这是一个什么项目。'

/**
 * 示例会话的档位：`manual` = 只读自动（读文件自动放行，写入与命令先问）。
 *
 * 只能写这三个正式值。旧值 `plan` / `dontAsk` 会被 store-schema 的
 * normalizeApprovalMode 折叠成 manual、`acceptEdits` 折叠成 auto，所以写旧值会得到
 * 「调用里一个值、落盘后另一个值」，本地状态与存档悄悄不一致。t
 * tests/onboarding-state.test.ts 用 normalizeApprovalMode 直接盯住这一条。
 */
export const ONBOARDING_SAMPLE_APPROVAL_MODE: ApprovalMode = 'manual'

export interface OnboardingVisibilityInput {
  /** bootstrap 是否已经回来。没回来时先不渲染，避免引导闪一下再消失。 */
  booted: boolean
  /**
   * 本窗口第一次拿到设置时的 `hasKey`。`null` 表示还不知道。
   * 判定只认这个快照，所以「刚配好 Key」不会把自己判断成老用户。
   */
  keyAtStart: boolean | null
  /** 用户点过跳过，或已经完成引导。 */
  skipped: boolean
}

export function onboardingVisible(input: OnboardingVisibilityInput): boolean {
  if (!input.booted || input.skipped) return false
  // 出厂/新机器没有 Key 才引导；已经有 Key 的是老用户，不打扰。
  return input.keyAtStart === false
}

export interface OnboardingProgressInput {
  hasKey: boolean
  hasWorkspace: boolean
}

/**
 * 当前该停在第一步。三步是顺序依赖的：没有 Key 什么都发不出去，没有工作区
 * 就无处只读，所以不提供跳步，只按已知条件推进。
 */
export function onboardingStep(input: OnboardingProgressInput): OnboardingStepId {
  if (!input.hasKey) return 'key'
  if (!input.hasWorkspace) return 'workspace'
  return 'sample'
}

/** 已经做完几步，用于把前几步打成对勾。 */
export function onboardingDoneCount(step: OnboardingStepId): number {
  return ONBOARDING_STEPS.indexOf(step)
}

/** The little bit of `localStorage` this module needs, narrow enough to fake in tests. */
export interface OnboardingStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function defaultStorage(): OnboardingStorage | null {
  try {
    return (globalThis as { localStorage?: OnboardingStorage }).localStorage ?? null
  } catch {
    // 关掉本地存储的沙箱会在属性访问上直接抛。
    return null
  }
}

/** 读不到、读坏了都当「没跳过」：宁可多提示一次，也不要让需要引导的人看不到。 */
export function readOnboardingSkipped(
  store: OnboardingStorage | null = defaultStorage(),
): boolean {
  try {
    return store?.getItem(ONBOARDING_SKIP_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * 记住「别再提示」。存储不可用时不报错：本次窗口内仍然靠 App 的 state 隐藏，
 * 只是下次启动会再出现一次，比因为写盘失败把引导卡在屏幕上好。
 */
export function writeOnboardingSkipped(
  skipped: boolean,
  store: OnboardingStorage | null = defaultStorage(),
): void {
  try {
    store?.setItem(ONBOARDING_SKIP_KEY, skipped ? '1' : '0')
  } catch {
    // ignore: the in-memory state still hides it for this window.
  }
}
