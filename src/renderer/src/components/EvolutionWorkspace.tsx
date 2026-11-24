import type { ComponentProps } from 'react'
import type { SettingsView } from '../../../shared/types'
import { t } from '../i18n'
import { type EvolutionTab } from './EvolutionHub'
import { EvolutionPanel } from './EvolutionPanel'
import { ModuleCheckPanel } from './ModuleCheckPanel'
import { ReflectionPanel } from './ReflectionPanel'
import { SelfCheckPanel } from './SelfCheckPanel'
import { SupervisorPanel } from './SupervisorPanel'

type EvolutionPanelProps = ComponentProps<typeof EvolutionPanel>

/**
 * 「进化」的核心页签：自我进化 / 自主优化 / 模块自检 / 内视 / 反思。
 *
 * 这些能力原先各自占一个侧栏入口，用户得先判断「我想做的事归哪个页面」；
 * 它们其实共用一套数据（运行统计 → 提案 → 评审 → 回滚），拆开只会让同一份
 * 状态在五个页面里各拉一次。
 *
 * 这里返回的是页签数组，而不是一个组件：复盘评估和「自动与学习」两个页签的
 * 字段由设置弹窗持有（和整张设置表一起提交），所以弹窗用 `extraTabs` 把它们
 * 拼在核心页签之后，用户只看到一个「进化」入口。
 */
export function evolutionWorkspaceTabs({
  settings,
  onOpenSession,
  onOpenModuleCheckSession,
  onSettingsSaved,
  onOpenNotifySettings,
  ...rest
}: EvolutionPanelProps & {
  settings: SettingsView | null
  onOpenSession: (sessionId: string) => void
  onOpenModuleCheckSession: (sessionId: string) => void
  /** 反思页签自己保存字段，需要把新设置回写给 App。 */
  onSettingsSaved: (view: SettingsView) => void
  /** 跳到「设置 → 通知」：邮箱与通知配置在那里。 */
  onOpenNotifySettings: () => void
}): EvolutionTab[] {
  return [
    {
      id: 'profile',
      label: t("自我进化"),
      hint: t("自学习循环：运行统计、画像提案与评审、回滚"),
      content: <EvolutionPanel {...rest} />,
    },
    {
      id: 'supervisor',
      label: t("自主优化"),
      hint: t("按信号在护栏内自己开一轮修复会话"),
      content: <SupervisorPanel onOpenSession={onOpenSession} onError={rest.onError} />,
    },
    {
      id: 'module-check',
      label: t("模块自检"),
      hint: t("按模块扫描，找出问题模块并修复"),
      content: (
        <ModuleCheckPanel onOpenSession={onOpenModuleCheckSession} onError={rest.onError} />
      ),
    },
    {
      id: 'self-check',
      label: t("内视"),
      hint: t("内视 Pilot 自身功能模块"),
      content: <SelfCheckPanel onError={rest.onError} />,
    },
    {
      id: 'reflect',
      label: t("反思"),
      hint: t("按问题域对自己提问，结论进入自主优化信号"),
      content: settings ? (
        <ReflectionPanel
          settings={settings}
          onSaved={onSettingsSaved}
          onError={rest.onError}
          onOpenNotifySettings={onOpenNotifySettings}
        />
      ) : null,
    },
  ]
}
