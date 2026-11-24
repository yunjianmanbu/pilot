import { useEffect, useState } from 'react'
import type {
  FontSizePreference,
  SettingsUpdate,
  SettingsView,
  ThemeMode,
} from '../../../shared/types'
import type { LocaleSetting } from '../../../shared/i18n'
import { SunIcon } from '../icons'
import { applyLocaleSetting, t } from '../i18n'
import { Field } from './form-fields'
import { SelectMenu } from './SelectMenu'

const FONT_SIZE_OPTIONS: Array<{ value: FontSizePreference; label: string }> = [
  { value: 'standard', label: t("标准") },
  { value: 'large', label: t("大") },
  { value: 'xlarge', label: t("特大") },
]

/**
 * 「偏好」页：外观（主题 / 字号）与界面语言。
 *
 * 这些选项原先分在设置弹窗的两个分组里：看效果要先改、再保存、再关闭弹窗确认。
 * 搬到左下角后仍保留预览 + 保存两步，但不再夹在一堆无关设置中间；
 * 语言切换后整页 reload 一次，和应用启动时的解析结果保持一致。
 */
export function PreferencesPanel({
  settings,
  onSaved,
  onNotice,
  onError,
}: {
  settings: SettingsView
  onSaved: (view: SettingsView) => void
  /** 保存成功后的轻提示；换语言会 reload，提示只是为了不换语言时也有反馈。 */
  onNotice?: (message: string) => void
  onError: (message: string) => void
}) {
  const [theme, setTheme] = useState<ThemeMode>(settings.theme)
  const [fontSize, setFontSize] = useState<FontSizePreference>(settings.fontSize)
  const [locale, setLocale] = useState<LocaleSetting>(settings.locale)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const root = document.documentElement
    root.dataset['theme'] = theme
    root.dataset['fontSize'] = fontSize
    void window.pilot.previewTheme({ theme }).catch(() => undefined)
    return () => {
      root.dataset['theme'] = settings.theme
      root.dataset['fontSize'] = settings.fontSize
      void window.pilot.previewTheme(null).catch(() => undefined)
    }
  }, [theme, fontSize, settings.theme, settings.fontSize])

  const save = async () => {
    setError('')
    const input: SettingsUpdate = { theme, fontSize, locale }
    setSaving(true)
    try {
      const view = await window.pilot.updateSettings(input)
      onSaved(view)
      setTheme(view.theme)
      setFontSize(view.fontSize)
      setLocale(view.locale)
      onNotice?.(t("偏好已保存。"))
      if (applyLocaleSetting(view.locale, [view.systemLocale])) window.location.reload()
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      setError(message)
      onError(message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="page panel-page preferences-page">
      <div className="page-head">
        <div>
          <div className="page-eyebrow">
            <SunIcon width={13} height={13} />
            {t("外观与语言")}
          </div>
          <h1>{t("偏好")}</h1>
          <p>{t("主题、字号和界面语言。选中会立刻预览，保存后生效。")}</p>
        </div>
        <div className="page-head-actions">
          <button type="button" className="button primary" onClick={() => void save()} disabled={saving}>
            {saving ? <i className="spinner" /> : null}
            {t("保存")}
          </button>
        </div>
      </div>
      {error ? <div className="settings-error">{error}</div> : null}

      <section
        className="settings-section"
      >
        <div className="settings-section-head">
          <div>
            <h3>{t("外观")}</h3>
            <p>{t("暗色与浅色两套主题，只有一处主题色标记选中、焦点和进度，长时间使用也不刺眼。")}</p>
          </div>
        </div>
        <div className="appearance-block">
          <span className="field-label">{t("主题模式")}</span>
          <div className="appearance-modes" role="group" aria-label={t("主题模式")}>
            <button
              type="button"
              className={`appearance-mode${theme === 'dark' ? ' is-on' : ''}`}
              onClick={() => setTheme('dark')}
              aria-pressed={theme === 'dark'}
            >
              {t("深色")}
            </button>
            <button
              type="button"
              className={`appearance-mode${theme === 'light' ? ' is-on' : ''}`}
              onClick={() => setTheme('light')}
              aria-pressed={theme === 'light'}
            >
              {t("浅色")}
            </button>
          </div>
        </div>
        <div className="appearance-block">
          <span className="field-label">{t("字号")}</span>
          <div className="appearance-modes" role="group" aria-label={t("字号")}>
            {FONT_SIZE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`appearance-mode${fontSize === option.value ? ' is-on' : ''}`}
                onClick={() => setFontSize(option.value)}
                aria-pressed={fontSize === option.value}
              >
                {option.label}
              </button>
            ))}
          </div>
          <p className="settings-hint">
            {t("只放大文字，按钮和间距保持不变；标准就是原来的字号。")}
          </p>
        </div>
      </section>

      <section
        className="settings-section"
      >
        <div className="settings-section-head">
          <div>
            <h3>{t("语言")}</h3>
            <p>{t("界面语言。默认跟随系统；智能体始终使用你提问的语言回复。")}</p>
          </div>
        </div>
        <div className="field-grid">
          <Field
            label={t("界面语言")}
            hint={t("系统语言：{locale}", { locale: settings.systemLocale || '—' })}
          >
            <SelectMenu
              value={locale}
              options={[
                {
                  value: 'auto',
                  label: `${t("跟随系统")} · ${settings.systemLocale || 'Auto'}`,
                },
                { value: 'zh-CN', label: t("简体中文") },
                { value: 'en', label: 'English' },
              ]}
              onChange={(value) => setLocale(value as LocaleSetting)}
              ariaLabel={t("界面语言")}
            />
          </Field>
        </div>
      </section>

    </div>
  )
}
