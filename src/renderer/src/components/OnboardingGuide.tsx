import {
  ONBOARDING_STEPS,
  onboardingDoneCount,
  type OnboardingStepId,
} from '../../../shared/onboarding'
import { CheckIcon, FolderIcon, PlayIcon, SettingsIcon, XIcon } from '../icons'
import { t } from '../i18n'

/**
 * 首启引导的三步条。只负责画：当前停在第几步由 `onboardingStep()` 算好传进来，
 * 什么时候出现由 `onboardingVisible()` 决定，二者都在 shared/onboarding.ts 里有单测。
 *
 * 每一步都只有一个按钮，不做「上一步/下一步」：三段的条件是硬依赖（没 Key 发不出
 * 任务，没工作区无处只读），给用户一个「下一步」反而会点到一个做不了的操作上。
 */
export interface OnboardingGuideProps {
  step: OnboardingStepId
  /** 第三步点了之后到会话真正开跑之间，按钮要锁住，避免连点建出多个会话。 */
  running: boolean
  onConfigureKey: () => void
  onPickWorkspace: () => void
  onRunSample: () => void
  onSkip: () => void
}

const STEP_ICONS = {
  key: SettingsIcon,
  workspace: FolderIcon,
  sample: PlayIcon,
} as const

/**
 * 三步的标题与说明都写成字面量的 `t()`：i18n 覆盖率测试是静态扫源码的，
 * 写成 `t(变量)` 会让“这句到底有没有英文”永远查不出来。
 */
function stepCopy(id: OnboardingStepId): { title: string; hint: string } {
  switch (id) {
    case 'key':
      return {
        title: t('配置 API Key'),
        hint: t('模型凭据本地加密保存，不注册、不登录。'),
      }
    case 'workspace':
      return {
        title: t('选择工作区'),
        hint: t('Pilot 只在这个文件夹里读写文件、执行命令。'),
      }
    case 'sample':
      return {
        title: t('跑一个只读示例'),
        hint: t('在只读档位下读一遍工作区，不写入、不执行命令。'),
      }
  }
}

function stepActionLabel(id: OnboardingStepId): string {
  switch (id) {
    case 'key':
      return t('去配置 API Key')
    case 'workspace':
      return t('选择工作区文件夹')
    case 'sample':
      return t('跑一个只读示例任务')
  }
}

export function OnboardingGuide({
  step,
  running,
  onConfigureKey,
  onPickWorkspace,
  onRunSample,
  onSkip,
}: OnboardingGuideProps) {
  const done = onboardingDoneCount(step)
  const action =
    step === 'key' ? onConfigureKey : step === 'workspace' ? onPickWorkspace : onRunSample
  const label = running ? t('正在创建示例会话…') : stepActionLabel(step)

  return (
    <section className="onboarding" aria-label={t('三步开始使用 Pilot')}>
      <div className="onboarding-head">
        <p className="onboarding-title">{t('三步开始使用 Pilot')}</p>
        <button type="button" className="onboarding-skip" onClick={onSkip}>
          <XIcon width={13} height={13} />
          {t('跳过引导')}
        </button>
      </div>

      <ol className="onboarding-steps">
        {ONBOARDING_STEPS.map((id, index) => {
          const state = index < done ? 'done' : index === done ? 'active' : 'todo'
          const Icon = STEP_ICONS[id]
          const copy = stepCopy(id)
          return (
            <li key={id} className={`onboarding-step is-${state}`}>
              <span className="onboarding-step-icon" aria-hidden="true">
                {state === 'done' ? <CheckIcon width={15} height={15} /> : <Icon width={15} height={15} />}
              </span>
              <span className="onboarding-step-text">
                <strong>
                  <span className="onboarding-step-index">{index + 1}</span>
                  {copy.title}
                </strong>
                <small>{copy.hint}</small>
              </span>
            </li>
          )
        })}
      </ol>

      <div className="onboarding-foot">
        <button type="button" className="button primary" onClick={action} disabled={running}>
          {label}
        </button>
        {step === 'sample' ? (
          <span className="onboarding-foot-hint">
            {t('示例会话处在只读档位，可以之后在会话栏改回常用模式。')}
          </span>
        ) : null}
      </div>
    </section>
  )
}
