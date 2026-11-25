import { useCallback, useEffect, useState } from 'react'
import {
  HOOK_RULE_ACTIONS,
  HOOK_RULE_EVENTS,
  type HookRuleAction,
  type HookRuleEvent,
  type HookRuleView,
  type HookRulesReport,
} from '../../../shared/hook-rules'
import { t } from '../i18n'
import { Field } from './form-fields'
import { SelectMenu } from './SelectMenu'

const EMPTY: HookRulesReport = {
  enabled: false,
  rules: [],
  commands: { preTool: 0, postEdit: 0, stop: 0 },
  broken: [],
}

function eventLabel(event: HookRuleEvent): string {
  return HOOK_RULE_EVENTS.find((entry) => entry.id === event)?.label ?? event
}

function actionLabel(action: HookRuleAction): string {
  return HOOK_RULE_ACTIONS.find((entry) => entry.id === action)?.label ?? action
}

/**
 * 工作区的声明式 hook 规则（`.pilot/hooks/*.md`）。
 *
 * 这里只做三件事：看清有哪些规则、逐条开关、写一条新的。规则永远不能执行命令，
 * 也不能放宽权限——它只能给模型一句提示，或在命中的那一次调用上拦一下。
 */
export function HookRulesPanel({ workspacePath }: { workspacePath: string }) {
  const [report, setReport] = useState<HookRulesReport>(EMPTY)
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState({
    name: '',
    event: 'bash' as HookRuleEvent,
    action: 'warn' as HookRuleAction,
    pattern: '',
    message: '',
  })

  const refresh = useCallback(async () => {
    if (!workspacePath) {
      setReport(EMPTY)
      return
    }
    setLoading(true)
    try {
      const next = await window.pilot.hookRules(workspacePath)
      setReport(next)
      setError('')
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setLoading(false)
    }
  }, [workspacePath])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const toggle = async (rule: HookRuleView) => {
    setNotice('')
    try {
      setReport(await window.pilot.setHookRuleEnabled(workspacePath, rule.source, !rule.enabled))
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : String(toggleError))
    }
  }

  const remove = async (rule: HookRuleView) => {
    const confirmed = window.confirm(
      t('删除规则「{name}」？这会从工作区删掉 {source}，无法撤销。', {
        name: rule.name,
        source: rule.source,
      }),
    )
    if (!confirmed) return
    setNotice('')
    try {
      setReport(await window.pilot.deleteHookRule(workspacePath, rule.source))
      setNotice(t('已删除 {name}。', { name: rule.name }))
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError))
    }
  }

  const submit = async () => {
    setNotice('')
    setError('')
    const created = await window.pilot.createHookRule(workspacePath, {
      name: draft.name.trim(),
      event: draft.event,
      action: draft.action,
      pattern: draft.pattern.trim(),
      message: draft.message.trim(),
    })
    if (!created) {
      setError(t('名称与正则不能为空，且正则必须能编译。'))
      return
    }
    setDraft({ name: '', event: 'bash', action: 'warn', pattern: '', message: '' })
    setCreating(false)
    setNotice(t('已新建规则 {name}（{source}）。', { name: created.name, source: created.source }))
    await refresh()
  }

  const totalCommands = report.commands.preTool + report.commands.postEdit + report.commands.stop

  return (
    <div className="hook-rules-panel">
      <div className="settings-section-head">
        <div>
          <h3>{t('Hook 规则')}</h3>
          <p>
            {t(
              '规则文件放在工作区的 .pilot/hooks/*.md：正则需要一行说明，命中时给模型一句提示，action 为 block 时拦下那一次调用。规则不能执行命令，也不能放宽权限或沙箱判定。',
            )}
          </p>
        </div>
        <button
          type="button"
          className="button ghost small"
          onClick={() => void refresh()}
          disabled={loading || !workspacePath}
        >
          {loading ? <i className="spinner" /> : null}
          {t('刷新')}
        </button>
      </div>

      {!workspacePath ? <p className="settings-note">{t('先打开一个工作区。')}</p> : null}

      {workspacePath && !report.enabled ? (
        <p className="settings-note">
          {t('工作区钩子当前是关闭的（运行参数里的「工作区钩子」）。规则仍然可以编辑，但不会生效。')}
        </p>
      ) : null}

      {error ? <p className="settings-note is-error">{error}</p> : null}
      {notice ? <p className="settings-note">{notice}</p> : null}

      {report.rules.length === 0 ? (
        <p className="settings-note">
          {t('还没有规则。常见写法：命令执行里匹配 rm -rf 并设为阻断，或写文件里匹配 console.log 并设为提示。')}
        </p>
      ) : (
        <ul className="hook-rule-list">
          {report.rules.map((rule) => (
            <li key={rule.source} className={`hook-rule${rule.enabled ? '' : ' is-off'}`}>
              <div className="hook-rule-head">
                <strong>{rule.name}</strong>
                <span className="hook-rule-tag">{eventLabel(rule.event)}</span>
                <span className={`hook-rule-tag${rule.action === 'block' ? ' is-block' : ''}`}>
                  {actionLabel(rule.action)}
                </span>
                <code className="hook-rule-pattern">/{rule.pattern}/i</code>
                <span className="hook-rule-actions">
                  <button type="button" className="button ghost small" onClick={() => void toggle(rule)}>
                    {rule.enabled ? t('停用') : t('启用')}
                  </button>
                  <button type="button" className="button ghost small" onClick={() => void remove(rule)}>
                    {t('删除')}
                  </button>
                </span>
              </div>
              <p className="hook-rule-message">{rule.message}</p>
              <small className="hook-rule-source">{rule.source}</small>
            </li>
          ))}
        </ul>
      )}

      {report.broken.length > 0 ? (
        <div className="settings-note is-error">
          <strong>{t('有 {count} 个规则文件没被采用：', { count: report.broken.length })}</strong>
          <ul>
            {report.broken.map((entry) => (
              <li key={entry.source}>
                <code>{entry.source}</code> — {entry.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="settings-note">
        {totalCommands > 0
          ? t(
              '另有 {count} 条命令钩子（.pilot/hooks.json：pre_tool {pre} / post_edit {post} / stop {stop}）。命令钩子需要直接编辑该文件。',
              {
                count: totalCommands,
                pre: report.commands.preTool,
                post: report.commands.postEdit,
                stop: report.commands.stop,
              },
            )
          : t('没有命令钩子。需要跑 lint、跑测试这类动作时，直接编辑 .pilot/hooks.json。')}
      </p>

      {creating ? (
        <div className="hook-rule-form">
          <div className="field-grid">
            <Field label={t('规则名')}>
              <input
                className="text-input"
                value={draft.name}
                placeholder="no-force-push"
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </Field>
            <Field label={t('生效时机')}>
              <SelectMenu
                value={draft.event}
                options={HOOK_RULE_EVENTS.map((entry) => ({ value: entry.id, label: entry.label }))}
                onChange={(value) => setDraft({ ...draft, event: value as HookRuleEvent })}
                ariaLabel={t('生效时机')}
              />
            </Field>
            <Field label={t('处理方式')}>
              <SelectMenu
                value={draft.action}
                options={HOOK_RULE_ACTIONS.map((entry) => ({ value: entry.id, label: entry.label }))}
                onChange={(value) => setDraft({ ...draft, action: value as HookRuleAction })}
                ariaLabel={t('处理方式')}
              />
            </Field>
            <Field label={t('正则')} hint={t('大小写不敏感，匹配对象由生效时机决定')} wide>
              <input
                className="text-input mono"
                value={draft.pattern}
                placeholder="git push --force"
                spellCheck={false}
                onChange={(event) => setDraft({ ...draft, pattern: event.target.value })}
              />
            </Field>
            <Field label={t('给模型的说明')} hint={t('命中时原样显示')} wide>
              <textarea
                className="text-input settings-textarea"
                rows={2}
                value={draft.message}
                placeholder={t('先问用户，再强推远端分支。')}
                onChange={(event) => setDraft({ ...draft, message: event.target.value })}
              />
            </Field>
          </div>
          <div className="settings-inline">
            <button type="button" className="button primary small" onClick={() => void submit()}>
              {t('保存规则')}
            </button>
            <button type="button" className="button ghost small" onClick={() => setCreating(false)}>
              {t('取消')}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="button ghost small"
          onClick={() => setCreating(true)}
          disabled={!workspacePath}
        >
          {t('新建规则')}
        </button>
      )}
    </div>
  )
}
