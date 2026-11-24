import { describe, expect, it } from 'vitest'

import { applySettingsUpdate } from '../src/main/settings-update'
import { defaults, sanitize } from '../src/main/store-schema'

const hooks = {
  setTestCaptcha: () => undefined,
  setApiKey: () => undefined,
  setSmtpPassword: () => undefined,
}

/**
 * 反思发信的默认配置：出厂既不预置邮箱地址，也不预置 SMTP 服务器——邮箱是用户
 * 自己的，产品方不该在默认值里留一个看得见、也可能被误发的地址。端口与加密方式
 * 保留通用默认，用户只需要补自己的邮箱与授权码。
 *
 * 老 store 把邮箱拆在 reflectEmailTo / reflectSmtpUser / reflectEmailFrom 三个键里，
 * 归一化时必须合并成单字段，否则升级后用户填过的邮箱会凭空消失。
 */
describe('reflection mail defaults', () => {
  it('ships without a mailbox address or SMTP host', () => {
    const state = sanitize({ version: 1, settings: { model: 'deepseek-chat' } })

    expect(state.settings).toMatchObject({
      reflectEmailEnabled: true,
      reflectEmailTo: '',
      reflectSmtpHost: '',
      reflectSmtpPort: 465,
      reflectSmtpSecurity: 'tls',
    })
    // 反思本身保持默认关闭，只有用户主动打开才会跑。
    expect(state.settings.reflectEnabled).toBe(false)
  })

  it('respects values the user saved explicitly', () => {
    const state = sanitize({
      settings: {
        reflectEmailEnabled: false,
        reflectEmailTo: 'ops@example.com',
        reflectSmtpHost: 'smtp.example.com',
        reflectSmtpPort: 587,
        reflectSmtpSecurity: 'starttls',
      },
    })

    expect(state.settings).toMatchObject({
      reflectEmailEnabled: false,
      reflectEmailTo: 'ops@example.com',
      reflectSmtpHost: 'smtp.example.com',
      reflectSmtpPort: 587,
      reflectSmtpSecurity: 'starttls',
    })
  })

  it('does not refill an address the user deliberately cleared', () => {
    const state = sanitize({ settings: { reflectEmailTo: '', reflectSmtpHost: '' } })

    expect(state.settings.reflectEmailTo).toBe('')
    expect(state.settings.reflectSmtpHost).toBe('')
  })

  it('matches the fresh-install defaults', () => {
    const fresh = defaults().settings
    const migrated = sanitize({ settings: {} }).settings

    expect(fresh.reflectEmailTo).toBe('')
    expect(fresh.reflectSmtpHost).toBe('')
    expect(migrated.reflectEmailTo).toBe(fresh.reflectEmailTo)
    expect(migrated.reflectSmtpHost).toBe(fresh.reflectSmtpHost)
    expect(migrated.reflectSmtpPort).toBe(fresh.reflectSmtpPort)
    expect(migrated.reflectSmtpSecurity).toBe(fresh.reflectSmtpSecurity)
    expect(migrated.reflectEmailEnabled).toBe(fresh.reflectEmailEnabled)
  })

  it('drops the legacy product mailbox that older builds wrote into the store', () => {
    // 真实故障：旧版 defaults() 里就有这个地址，用户一装就把它们落盘了。
    // 只改 defaults 不够，老存档里那份也必须当成「未配置」。
    const state = sanitize({
      settings: {
        reflectEmailEnabled: true,
        reflectEmailTo: 'embeddedmeng@163.com',
        reflectSmtpHost: 'smtp.163.com',
        reflectSmtpPort: 465,
        reflectSmtpSecurity: 'tls',
      },
    })

    expect(state.settings.reflectEmailTo).toBe('')
    expect(state.settings.reflectSmtpHost).toBe('')
    // 其它字段不动：用户改过的端口与加密方式原样保留。
    expect(state.settings.reflectSmtpPort).toBe(465)
    expect(state.settings.reflectSmtpSecurity).toBe('tls')
  })

  it('keeps a user-supplied mailbox even when it sits on 163', () => {
    const state = sanitize({
      settings: { reflectEmailTo: 'someone@163.com', reflectSmtpHost: 'smtp.163.com' },
    })

    expect(state.settings.reflectEmailTo).toBe('someone@163.com')
    expect(state.settings.reflectSmtpHost).toBe('smtp.163.com')
  })

  it('clears the legacy preset even when it only survived as the SMTP user name', () => {
    const state = sanitize({ settings: { reflectSmtpUser: 'embeddedmeng@163.com' } })

    expect(state.settings.reflectEmailTo).toBe('')
  })

  it('merges the legacy three mailboxes into the single field', () => {
    const mailbox = (settings: Record<string, unknown>): string =>
      sanitize({ settings }).settings.reflectEmailTo

    // 收件地址是语义上最接近「那个邮箱」的一个，优先取它。
    expect(
      mailbox({
        reflectEmailTo: 'to@example.com',
        reflectSmtpUser: 'user@example.com',
        reflectEmailFrom: 'from@example.com',
      }),
    ).toBe('to@example.com')
    // 只有旧 SMTP 用户名有值（老用户常这么填）时也不能丢。
    expect(
      mailbox({ reflectEmailTo: '', reflectSmtpUser: 'user@example.com', reflectEmailFrom: 'from@example.com' }),
    ).toBe('user@example.com')
    expect(mailbox({ reflectEmailFrom: 'from@example.com' })).toBe('from@example.com')
    // 三个键都没有时保持空，而不是回落到任何产品方地址。
    expect(mailbox({})).toBe('')
  })

  it('accepts the deprecated aliases from an old client', () => {
    const settings = defaults().settings

    applySettingsUpdate(settings, { reflectSmtpUser: 'user@example.com' }, hooks)
    expect(settings.reflectEmailTo).toBe('user@example.com')

    applySettingsUpdate(settings, { reflectEmailFrom: 'from@example.com' }, hooks)
    expect(settings.reflectEmailTo).toBe('from@example.com')

    // 新字段优先：两者同时出现时以 reflectEmailTo 为准。
    applySettingsUpdate(
      settings,
      { reflectEmailTo: 'to@example.com', reflectSmtpUser: 'user@example.com' },
      hooks,
    )
    expect(settings.reflectEmailTo).toBe('to@example.com')
  })

  it('clears the mailbox when the user empties the only field', () => {
    const settings = defaults().settings
    settings.reflectEmailTo = 'ops@example.com'

    applySettingsUpdate(settings, { reflectEmailTo: '' }, hooks)

    expect(settings.reflectEmailTo).toBe('')
  })
})
