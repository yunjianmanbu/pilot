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

  it('restores a mailbox that an older build wiped while keeping the password', () => {
    // 真实故障（1.0.9 及更早）：旧逻辑把预置地址当「未配置」清掉，授权码却留着。
    // 于是「有授权码 + 邮箱与主机都空」就是被清掉的硬证据，升级时还原一次，
    // 用户不必打开设置重填。
    const state = sanitize({
      settings: {
        notifyEmailEnabled: true,
        reflectEmailTo: '',
        reflectSmtpHost: '',
        reflectSmtpPasswordCipher: 'cipher-blob',
      },
    })

    expect(state.settings.reflectEmailTo).toBe('embeddedmeng@163.com')
    expect(state.settings.reflectSmtpHost).toBe('smtp.163.com')
    expect(state.settings.reflectMailboxRestored).toBe(true)
  })

  it('only restores once, so a deliberate clear later sticks', () => {
    const state = sanitize({
      settings: {
        reflectEmailTo: '',
        reflectSmtpHost: '',
        reflectSmtpPasswordCipher: 'cipher-blob',
        reflectMailboxRestored: true,
      },
    })

    expect(state.settings.reflectEmailTo).toBe('')
    expect(state.settings.reflectSmtpHost).toBe('')
  })

  it('does not invent a mailbox when no password proves the config was real', () => {
    const state = sanitize({ settings: { reflectEmailTo: '', reflectSmtpHost: '' } })

    expect(state.settings.reflectEmailTo).toBe('')
    expect(state.settings.reflectMailboxRestored).toBe(false)
  })

  it('keeps a saved mailbox when an old client submits an empty form', () => {
    // 旧手机端 / 未同步完的界面会把空表单原样提交（空串），那不是「用户想清空」。
    // 若当真清掉，换一台设备就得重填一次邮箱。只有显式 null 才清除。
    const settings = defaults().settings
    applySettingsUpdate(settings, { reflectEmailTo: 'me@example.com' }, hooks)
    applySettingsUpdate(settings, { reflectSmtpHost: 'smtp.example.com' }, hooks)

    applySettingsUpdate(settings, { reflectEmailTo: '', reflectSmtpHost: '' }, hooks)
    expect(settings.reflectEmailTo).toBe('me@example.com')
    expect(settings.reflectSmtpHost).toBe('smtp.example.com')

    applySettingsUpdate(settings, { reflectSmtpUser: '', reflectEmailFrom: '' }, hooks)
    expect(settings.reflectEmailTo).toBe('me@example.com')

    applySettingsUpdate(settings, { reflectEmailTo: null, reflectSmtpHost: null }, hooks)
    expect(settings.reflectEmailTo).toBe('')
    expect(settings.reflectSmtpHost).toBe('')
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

  it('keeps the legacy preset address when a saved SMTP password proves it is in use', () => {
    // 真实故障（1.0.9）：这个地址恰好也是作者本人在用的地址。只要它被当成
    // 「旧版预置」清掉，任务完成通知就一封也发不出去，而界面里授权码还在、
    // 总开关也是开的，看着完全像「已经配置好」。有授权码就说明这是用户的配置。
    const state = sanitize({
      settings: {
        notifyEmailEnabled: true,
        reflectEmailTo: 'embeddedmeng@163.com',
        reflectSmtpHost: 'smtp.163.com',
        reflectSmtpPasswordCipher: 'cipher-blob',
      },
    })

    expect(state.settings.reflectEmailTo).toBe('embeddedmeng@163.com')
    expect(state.settings.reflectSmtpHost).toBe('smtp.163.com')
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

  it('clears the mailbox only when the caller sends an explicit null', () => {    // 空串现在与授权码同义（保持原值），否则旧客户端把没同步好的空表单原样
    // 提交一次，用户的邮箱就要重填一次。真正要清空时传 null：桌面设置弹框
    // 在用户把输入框删空后就是这么发的。
    const settings = defaults().settings
    settings.reflectEmailTo = 'ops@example.com'

    applySettingsUpdate(settings, { reflectEmailTo: '' }, hooks)
    expect(settings.reflectEmailTo).toBe('ops@example.com')

    applySettingsUpdate(settings, { reflectEmailTo: null }, hooks)
    expect(settings.reflectEmailTo).toBe('')
  })
})

/**
 * 反思自动触发的默认粒度：高速迭代期一版一个行为，默认按「版本变化」切分。
 * 老存档里的 daily/interval 是旧默认值而不是用户的选择，必须跟着迁移；
 * 用户亲手选过的（`reflectScheduleModePinned`）一律保留。
 */
describe('reflection schedule mode defaults', () => {
  it('defaults to the version trigger', () => {
    expect(defaults().settings.reflectScheduleMode).toBe('version')
    expect(sanitize({ settings: {} }).settings.reflectScheduleMode).toBe('version')
    expect(sanitize({ settings: {} }).settings.reflectLastVersion).toBe('')
  })

  it('migrates the old default away from daily', () => {
    // 旧版默认是 daily，存进存档后与「用户主动选每天」无法区分；没有 pinned 标记就是旧默认。
    expect(
      sanitize({ settings: { reflectScheduleMode: 'daily' } }).settings.reflectScheduleMode,
    ).toBe('version')
    expect(
      sanitize({ settings: { reflectScheduleMode: 'interval' } }).settings.reflectScheduleMode,
    ).toBe('version')
  })

  it('keeps a mode the user picked themselves', () => {
    expect(
      sanitize({ settings: { reflectScheduleMode: 'daily', reflectScheduleModePinned: true } })
        .settings.reflectScheduleMode,
    ).toBe('daily')
  })

  it('pins the mode as soon as the user changes it', () => {
    const settings = defaults().settings
    applySettingsUpdate(settings, { reflectScheduleMode: 'interval' }, hooks)
    expect(settings.reflectScheduleMode).toBe('interval')
    expect(settings.reflectScheduleModePinned).toBe(true)

    // 钉住后再一次迁移（例如再次 sanitize 存档）不能把它拖回默认。
    expect(
      sanitize({ settings: { ...settings } }).settings.reflectScheduleMode,
    ).toBe('interval')
  })

  it('keeps the version baseline such a round trip survives', () => {
    const state = sanitize({ settings: { reflectLastVersion: '1.2.4' } })
    expect(state.settings.reflectLastVersion).toBe('1.2.4')
  })
})
