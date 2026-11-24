import { useState } from 'react'
import type { ReflectionSmtpSecurity } from '../../../shared/types'
import {
  CUSTOM_MAIL_PRESET_ID,
  MAIL_PRESETS,
  matchMailPresetByEmail,
  matchMailPresetByHost,
  type MailPreset,
} from '../../../shared/mail-presets'
import {
  NOTIFY_EVENTS,
  notifyEventHint,
  notifyEventLabel,
  withNotifyEvent,
  type NotifyEventId,
} from '../../../shared/notify-events'
import {
  mailReadinessOf,
  mailSettingsDraftFrom,
  notifyToggleForSave,
  validateMailSettings,
  type MailSettingsDraft,
} from '../mail-save'
import { getLocale, t } from '../i18n'
import { Field, Toggle } from './form-fields'
import { SelectMenu } from './SelectMenu'

// 草稿判据与保存策略已搬到 `../mail-save`（能脱离 React 直接测试）；这里保留同名
// 导出，现有调用点（`SettingsDialog`、测试）不用跟着改导入路径。
export { mailReadinessOf, mailSettingsDraftFrom, notifyToggleForSave, validateMailSettings }
export type { MailSettingsDraft }

export function MailNotifySettings({
  draft,
  onChange,
  hasSmtpPassword,
}: {
  draft: MailSettingsDraft
  /** 逐字段回写草稿；宿主把它并入整份设置一起提交。 */
  onChange: (patch: Partial<MailSettingsDraft>) => void
  /** 已保存的授权码是否存在（设置里从不回显明文）。 */
  hasSmtpPassword: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  const mailPresetOptions = [
    ...MAIL_PRESETS.map((preset) => ({
      value: preset.id,
      label: getLocale() === 'en' ? preset.en : preset.zh,
      detail: `${preset.host}:${preset.port}`,
    })),
    { value: CUSTOM_MAIL_PRESET_ID, label: t("自定义") },
  ]

  const applyMailPreset = (preset: MailPreset) => {
    onChange({
      mailPresetId: preset.id,
      reflectSmtpHost: preset.host,
      reflectSmtpPort: String(preset.port),
      reflectSmtpSecurity: preset.security,
    })
  }

  const chooseMailPreset = (id: string) => {
    const preset = MAIL_PRESETS.find((entry) => entry.id === id)
    if (preset) {
      applyMailPreset(preset)
      return
    }
    onChange({ mailPresetId: CUSTOM_MAIL_PRESET_ID })
  }

  /**
   * 填完地址顺手把服务器带出来。只在服务器还空着、或当前值本来就等于另一个预设时
   * 才跟随：用户手写的自有服务器不能被一次输入覆盖。
   */
  const onEmailChange = (value: string) => {
    const preset = matchMailPresetByEmail(value)
    if (!preset || preset.id === draft.mailPresetId) {
      onChange({ reflectEmailTo: value })
      return
    }
    if (draft.reflectSmtpHost.trim() && !matchMailPresetByHost(draft.reflectSmtpHost)) {
      onChange({ reflectEmailTo: value })
      return
    }
    onChange({
      reflectEmailTo: value,
      mailPresetId: preset.id,
      reflectSmtpHost: preset.host,
      reflectSmtpPort: String(preset.port),
      reflectSmtpSecurity: preset.security,
    })
  }

  const onHostChange = (value: string) => {
    const preset = matchMailPresetByHost(value)
    onChange({
      reflectSmtpHost: value,
      mailPresetId: preset ? preset.id : CUSTOM_MAIL_PRESET_ID,
    })
  }

  const secretUnsaved = draft.reflectSmtpPassword.trim() !== '' || draft.clearReflectPassword

  const sendTestMail = async () => {
    setNotice('')
    setError('')
    // 测试邮件走的是已保存的 SMTP 配置：刚填的授权码还没进磁盘时，
    // 后端只会回「请先填写并保存授权码」，用户会误以为授权码本身有问题。
    if (secretUnsaved) {
      setError(t("授权码改动还没保存：请先点「保存设置」，再点这里。"))
      return
    }
    setBusy(true)
    try {
      const result = await window.pilot.testReflectionMail(draft.reflectEmailTo.trim())
      if (result.ok) {
        // 能发出去只证明 SMTP 通了；总开关或事件没开的话依旧不会自动发信。
        setNotice(
          draft.notifyEmailEnabled && draft.notifyEmailEvents.length > 0
            ? t("已发送，请查收。")
            : t("已发送，请查收。打开邮件通知后才会自动发信。"),
        )
      } else setError(result.error || t("测试邮件发送失败。"))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  const mailReadiness = mailReadinessOf(draft, hasSmtpPassword)

  return (
    <>
      {/*
        「邮箱配置」只答「用哪个邮箱发」：收件人、SMTP 登录名与发件人都是这一个
        地址（自己发给自己），所以整页只有一处地址输入。
      */}
      <div className="settings-subhead">
        <strong>{t("邮箱配置")}</strong>
        <span>
          {t("收件人、SMTP 登录名和发件人都是这一个地址，也就是自己发给自己；发信失败只记在日志里。")}
        </span>
      </div>

      {mailReadiness ? (
        <p className="reflect-notice is-warn" role="status">
          {mailReadiness}
        </p>
      ) : null}

      <div className="field-grid">
        <Field
          label={t("邮箱地址")}
          hint={t(
            "邮件发到这个地址，也用它登录 SMTP 和充当发件人；多个地址用逗号分隔时只有第一个参与发信",
          )}
        >
          <input
            className="text-input"
            value={draft.reflectEmailTo}
            onChange={(event) => onEmailChange(event.target.value)}
            placeholder="you@example.com"
            spellCheck={false}
          />
        </Field>
        <Field
          label={t("邮箱服务商")}
          hint={t("选常用邮箱会自动填好服务器、端口和加密方式，地址仍然自己填写；用自己的服务器就选「自定义」。")}
        >
          <SelectMenu
            value={draft.mailPresetId}
            options={mailPresetOptions}
            onChange={chooseMailPreset}
            ariaLabel={t("邮箱服务商")}
            maxListWidth={300}
          />
        </Field>
        <Field label={t("SMTP 服务器")} hint={t("例如 smtp.qq.com")}>
          <input
            className="text-input"
            value={draft.reflectSmtpHost}
            onChange={(event) => onHostChange(event.target.value)}
            spellCheck={false}
          />
        </Field>
        <Field label={t("端口")}>
          <input
            className="text-input"
            inputMode="numeric"
            value={draft.reflectSmtpPort}
            onChange={(event) => onChange({ reflectSmtpPort: event.target.value })}
          />
        </Field>
        <Field label={t("加密方式")}>
          <SelectMenu
            value={draft.reflectSmtpSecurity}
            options={[
              { value: 'tls', label: t("隐式 TLS") },
              { value: 'starttls', label: 'STARTTLS' },
              { value: 'none', label: t("不加密") },
            ]}
            onChange={(value) => onChange({ reflectSmtpSecurity: value as ReflectionSmtpSecurity })}
            ariaLabel={t("加密方式")}
          />
        </Field>
        <Field
          label={t("授权码")}
          hint={
            hasSmtpPassword
              ? t("已保存授权码，留空则保持不变。")
              : t("在邮箱设置里开启 SMTP 服务后生成的授权码，不是登录密码。")
          }
        >
          <input
            className="text-input"
            type="password"
            value={draft.reflectSmtpPassword}
            onChange={(event) =>
              onChange({ reflectSmtpPassword: event.target.value, clearReflectPassword: false })
            }
            autoComplete="off"
          />
          {hasSmtpPassword ? (
            <span className="judge-toggle">
              <input
                type="checkbox"
                checked={draft.clearReflectPassword}
                onChange={(event) =>
                  onChange({
                    clearReflectPassword: event.target.checked,
                    ...(event.target.checked ? { reflectSmtpPassword: '' } : {}),
                  })
                }
              />
              {t("清除已保存的授权码")}
            </span>
          ) : null}
        </Field>
      </div>

      <div className="reflect-actions">
        <button
          type="button"
          className="button ghost small"
          onClick={() => void sendTestMail()}
          disabled={busy}
        >
          {busy ? <i className="spinner" /> : null}
          {t("发送测试邮件")}
        </button>
        <span className="settings-note">
          {t("测试邮件使用已保存的设置，改动后请先点「保存设置」。")}
        </span>
      </div>
      {error ? (
        <p className="reflect-notice is-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? <p className="reflect-notice">{notice}</p> : null}

      {/*
        「通知配置」只答「哪些事发信」：总开关关掉就一封都不发，单个事件取消勾选
        只影响那一类。列表顺序就是 `NOTIFY_EVENTS` 的数组顺序（推荐优先级）。
      */}
      <div className="settings-subhead">
        <strong>{t("通知配置")}</strong>
        <span>{t("所有邮件通知集中在这里：开启就发，关闭就不发；列表按推荐优先级排序。")}</span>
      </div>

      <div className="toggle-list">
        <Toggle
          checked={draft.notifyEmailEnabled}
          onChange={(next) => onChange({ notifyEmailEnabled: next })}
          label={t("邮件通知总开关")}
          description={t("关闭后下面勾选的任何事件都不会发信，已有的通知也不会补发。")}
        />
      </div>

      <div className="toggle-list">
        {NOTIFY_EVENTS.map((entry, index) => {
          const on = draft.notifyEmailEvents.includes(entry.id)
          return (
            <Toggle
              key={entry.id}
              checked={on}
              onChange={(next) =>
                onChange({ notifyEmailEvents: withNotifyEvent(draft.notifyEmailEvents, entry.id, next) })
              }
              label={`${index + 1}. ${notifyEventLabel(entry.id, getLocale() === 'en')}`}
              description={notifyEventHint(entry.id, getLocale() === 'en')}
              disabled={!draft.notifyEmailEnabled}
            />
          )
        })}
      </div>
      <p className="settings-note">
        {t("共 {v1} 类通知，已选 {v2} 类。未勾选的事件不会发信。", {
          v1: String(NOTIFY_EVENTS.length),
          v2: String(draft.notifyEmailEvents.length),
        })}
      </p>
    </>
  )
}
