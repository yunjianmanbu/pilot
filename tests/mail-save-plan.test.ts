/**
 * 保存设置时「邮件通知」开关该提交什么。
 *
 * 守一件事：邮件配置缺项不能挡住整张设置表的保存。以前保存前用
 * `validateMailSettings` 直接 return，于是「邮件通知开着但收件地址没填」
 * 会把同一张表里的「网页服务」一起拦下，表现成「没绑邮箱就开不了网页服务」。
 */
import { describe, expect, it } from 'vitest'
import {
  mailSettingsDraftFrom,
  notifyToggleForSave,
  validateMailSettings,
} from '../src/renderer/src/mail-save'

function draftOf(overrides: Record<string, unknown> = {}) {
  return {
    ...mailSettingsDraftFrom({
      notifyEmailEnabled: true,
      notifyEmailEvents: ['run.failed'],
      reflectEmailTo: '',
      reflectSmtpHost: '',
      reflectSmtpPort: 465,
      reflectSmtpSecurity: 'tls',
    }),
    ...overrides,
  }
}

describe('notifyToggleForSave', () => {
  it('在邮件通知打开但没填邮箱时只关掉通知，并给出一句说明', () => {
    const draft = draftOf()
    // 前提：这确实是「校验不通过」的配置。
    expect(validateMailSettings(draft)).not.toBe('')

    const plan = notifyToggleForSave(draft)
    expect(plan.enabled).toBe(false)
    expect(plan.warning).toContain('邮件通知未启用')
  })

  it('配置齐全时照用户的开关提交，不产生提示', () => {
    const plan = notifyToggleForSave(
      draftOf({ reflectEmailTo: 'me@example.com', reflectSmtpHost: 'smtp.example.com' }),
    )
    expect(plan.enabled).toBe(true)
    expect(plan.warning).toBe('')
  })

  it('用户把通知关掉时，残留的邮箱字段再离谱也不提示', () => {
    const plan = notifyToggleForSave(draftOf({ notifyEmailEnabled: false }))
    expect(plan.enabled).toBe(false)
    expect(plan.warning).toBe('')
  })

  it('完全没碰过邮件配置时返回空提示，保存不会多出一条噪音', () => {
    const plan = notifyToggleForSave(
      draftOf({ notifyEmailEnabled: false, reflectEmailTo: '', reflectSmtpHost: '' }),
    )
    expect(plan).toEqual({ enabled: false, warning: '' })
  })
})
