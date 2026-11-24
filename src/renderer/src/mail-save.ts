/**
 * 邮件配置的草稿判据与「保存时怎么提交」的纯逻辑。
 *
 * 为什么这些不留在 `components/MailNotifySettings.tsx` 里：保存策略是最容易回退
 * 的一处（以前邮件缺项会直接把整张设置表拦下，连网页服务开关都存不进去），
 * 所以它必须能被一个不渲染 React 的测试直接覆盖。
 */
import type { ReflectionSmtpSecurity, SettingsView } from '../../shared/types'
import {
  CUSTOM_MAIL_PRESET_ID,
  matchMailPresetByEmail,
  matchMailPresetByHost,
} from '../../shared/mail-presets'
import { normalizeNotifyEmailEvents, type NotifyEventId } from '../../shared/notify-events'
import { t } from './i18n'

/**
 * 「邮箱配置」与「通知配置」的表单草稿。
 *
 * 这两块回答的是两个问题：用哪个邮箱发（地址、SMTP、授权码），和哪些事发信
 * （总开关 + 事件清单）。草稿本身不保存，保存由宿主负责——设置弹窗整份提交，
 * 所以这里只维护字段，不自己调用 updateSettings。
 */
export interface MailSettingsDraft {
  notifyEmailEnabled: boolean
  notifyEmailEvents: NotifyEventId[]
  reflectEmailTo: string
  reflectSmtpHost: string
  reflectSmtpPort: string
  reflectSmtpSecurity: ReflectionSmtpSecurity
  reflectSmtpPassword: string
  clearReflectPassword: boolean
  /** 下拉只决定「SMTP 三项填什么」，地址始终由用户输入，所以它不参与保存。 */
  mailPresetId: string
}

/** 从已保存的设置生成草稿：授权码永远从空开始，避免把密文渲染进输入框。 */
export function mailSettingsDraftFrom(
  settings: Pick<
    SettingsView,
    | 'notifyEmailEnabled'
    | 'notifyEmailEvents'
    | 'reflectEmailTo'
    | 'reflectSmtpHost'
    | 'reflectSmtpPort'
    | 'reflectSmtpSecurity'
  >,
): MailSettingsDraft {
  return {
    notifyEmailEnabled: settings.notifyEmailEnabled,
    notifyEmailEvents: normalizeNotifyEmailEvents(settings.notifyEmailEvents),
    reflectEmailTo: settings.reflectEmailTo,
    reflectSmtpHost: settings.reflectSmtpHost,
    reflectSmtpPort: String(settings.reflectSmtpPort),
    reflectSmtpSecurity: settings.reflectSmtpSecurity,
    reflectSmtpPassword: '',
    clearReflectPassword: false,
    mailPresetId:
      matchMailPresetByHost(settings.reflectSmtpHost)?.id ??
      matchMailPresetByEmail(settings.reflectEmailTo)?.id ??
      CUSTOM_MAIL_PRESET_ID,
  }
}

/** 保存前的校验：返回错误文案，空串表示通过。与提交字段同一份判据。 */
export function validateMailSettings(draft: MailSettingsDraft): string {
  // 完全没碰过邮件的人不该被一个不生效的端口字段挡住整张设置表。
  const touched =
    draft.notifyEmailEnabled ||
    draft.reflectEmailTo.trim() !== '' ||
    draft.reflectSmtpHost.trim() !== ''
  const port = Number(draft.reflectSmtpPort)
  if (touched && (!Number.isFinite(port) || port < 1 || port > 65_535)) {
    return t("SMTP 端口需要在 1 到 65535 之间。")
  }
  if (
    draft.notifyEmailEnabled &&
    draft.notifyEmailEvents.length > 0 &&
    !draft.reflectEmailTo.trim().includes('@')
  ) {
    return t("已开启邮件通知，需要先填写邮箱地址。")
  }
  return ''
}

/** 邮箱缺项时把还差什么说清楚：发信失败的原因通常就在这里，不在勾了哪些通知。 */
export function mailReadinessOf(draft: MailSettingsDraft, hasSmtpPassword: boolean): string {
  if (!draft.reflectEmailTo.trim()) return t("还没填写邮箱地址，通知邮件发不出去。")
  if (!draft.reflectSmtpHost.trim()) return t("还没填写 SMTP 服务器，通知邮件发不出去。")
  if (!hasSmtpPassword && !draft.reflectSmtpPassword.trim()) {
    return t("还没有保存 SMTP 授权码，发信会被服务器拒绝。")
  }
  return ''
}

/**
 * 保存时该怎么提交「邮件通知」开关。
 *
 * 邮件配置缺项只影响「发信」这一件事，不能把整张设置表一起挡下来：以前保存
 * 遇到缺项就直接拒绝，于是「邮件通知开着但收件地址没填」会把同一张表里的
 * serverMode 一起拦在本地，表现成「没绑邮箱就开不了网页服务」。现在降级为
 * 「本次不启用邮件通知 + 一句说明」，其余字段照常保存。
 */
export function notifyToggleForSave(draft: MailSettingsDraft): {
  enabled: boolean
  warning: string
} {
  const error = validateMailSettings(draft)
  if (!error) return { enabled: draft.notifyEmailEnabled, warning: '' }
  return { enabled: false, warning: t("邮件通知未启用：{v1}", { v1: error }) }
}
