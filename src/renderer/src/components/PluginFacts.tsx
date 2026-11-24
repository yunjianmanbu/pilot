import type { PluginRecordView, PluginTriggerView } from '../../../shared/types'
import { t } from '../i18n'

/**
 * The fact block of an installed plugin card.
 *
 * It is a separate component because it is the only place a user can see what a
 * plugin actually exposes — which tools the agent gets, which routes exist,
 * which settings the form below will ask for and when the plugin may wake up on
 * its own. Keeping it out of `PluginsPanel` lets a test render it directly
 * instead of driving the whole page through IPC.
 */

/**
 * Triggers are rendered as plain sentences rather than codes: the panel is
 * where a user decides whether a plugin may run on its own, so the text has to
 * say "when" and "how often" without a legend.
 */
export function triggerLabel(trigger: PluginTriggerView): string {
  if (trigger.event === 'run.completed') return t("每轮结束后")
  if (trigger.event === 'session.created') return t("新建会话时")
  if (trigger.timeOfDay) return t("每天 {v1}", { v1: trigger.timeOfDay })
  return t("每 {v1} 分钟", { v1: String(trigger.everyMinutes ?? 0) })
}

export function PluginFacts({ plugin }: { plugin: PluginRecordView }) {
  return (
    <div className="plugins-facts">
      <div>
        <span>{t("入口")}</span>
        <code>{plugin.entry}</code>
      </div>
      <div>
        <span>{t("权限")}</span>
        <code>{plugin.permissions.length ? plugin.permissions.join(', ') : t("无")}</code>
      </div>
      <div>
        <span>{t("路由")}</span>
        <code>
          {plugin.routes.length
            ? plugin.routes.map((route) => `${route.method} ${route.path}`).join(' · ')
            : t("无")}
        </code>
      </div>
      <div>
        <span>{t("智能体工具")}</span>
        <code>
          {plugin.tools.length
            ? plugin.tools.map((tool) => `${tool.name}（${tool.risk}）`).join(' · ')
            : t("无")}
        </code>
      </div>
      {plugin.triggers.length > 0 ? (
        <div>
          <span>{t("触发器")}</span>
          <code>{plugin.triggers.map(triggerLabel).join(' · ')}</code>
        </div>
      ) : null}
    </div>
  )
}
