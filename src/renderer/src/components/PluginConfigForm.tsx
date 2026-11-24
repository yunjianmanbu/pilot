import { useState } from 'react'
import type { PluginRecordView } from '../../../shared/types'
import { t } from '../i18n'

/**
 * Manifest-declared settings, editable in place.
 *
 * The values live in `<workspace>/.pilot/plugins/grants.json` next to the grant,
 * so the plugin reads them on the next `plugin.activate`. Passwords never come
 * back to the renderer: an empty field means "keep the stored value", which is
 * exactly what the host does when the value is submitted empty.
 */
export function PluginConfigForm({
  plugin,
  busy,
  onSave,
}: {
  plugin: PluginRecordView
  busy: boolean
  onSave: (config: Record<string, unknown>) => void
}): React.JSX.Element | null {
  const [draft, setDraft] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    for (const setting of plugin.settings) {
      const value = setting.value
      if (setting.type === 'boolean') initial[setting.key] = value === true ? 'true' : 'false'
      else if (value === null || value === undefined) initial[setting.key] = ''
      else initial[setting.key] = String(value)
    }
    return initial
  })

  if (plugin.settings.length === 0) return null

  const missing = plugin.settings.filter(
    (setting) =>
      setting.required &&
      setting.type !== 'boolean' &&
      setting.type !== 'password' &&
      !draft[setting.key]?.trim(),
  )

  return (
    <div className="plugins-config">
      <div className="plugins-config-head">
        <h4>{t("设置")}</h4>
        <span>
          {missing.length > 0
            ? t("还有 {v1} 个必填项没填", { v1: String(missing.length) })
            : t("填写后对下一次调用生效")}
        </span>
      </div>
      <div className="plugins-config-grid">
        {plugin.settings.map((setting) => {
          const id = `plugin-${plugin.id}-${setting.key}`
          const hint = setting.description || setting.placeholder
          return (
            <label className="settings-field" key={setting.key}>
              <span>
                {setting.label}
                {setting.required ? <em className="plugins-required">*</em> : null}
              </span>
              {setting.type === 'boolean' ? (
                <input
                  id={id}
                  type="checkbox"
                  checked={draft[setting.key] === 'true'}
                  onChange={(event) =>
                    setDraft((prev) => ({
                      ...prev,
                      [setting.key]: event.target.checked ? 'true' : 'false',
                    }))
                  }
                />
              ) : (
                <input
                  id={id}
                  type={setting.type === 'number' ? 'number' : setting.type}
                  value={draft[setting.key] ?? ''}
                  placeholder={
                    setting.type === 'password' && setting.value !== null
                      ? t("已保存，留空则不改")
                      : setting.placeholder
                  }
                  onChange={(event) =>
                    setDraft((prev) => ({ ...prev, [setting.key]: event.target.value }))
                  }
                  autoComplete="off"
                />
              )}
              {hint ? <small>{hint}</small> : null}
            </label>
          )
        })}
      </div>
      <div className="plugins-config-actions">
        <button
          type="button"
          className="button primary"
          disabled={busy}
          onClick={() => onSave(draft)}
        >
          {t("保存设置")}
        </button>
      </div>
    </div>
  )
}
