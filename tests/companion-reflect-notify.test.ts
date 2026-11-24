/**
 * 手机端「邮箱配置 / 通知配置」依赖电脑端下发的通知目录。
 *
 * 守三件事：
 * 1) notifyCatalog 与 shared/notify-events 是同一份定义，顺序即推荐优先级；
 * 2) 总开关与事件表随设置变化实时下发，手机端勾完就能看到自己的选择；
 * 3) 旧字段 emailEnabled 仍等于「反思报告」这一类，旧版手机端不会被锁死。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NOTIFY_EVENTS, DEFAULT_NOTIFY_EMAIL_EVENTS } from '../src/shared/notify-events'

let userDataDir = ''

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataDir,
    getLocale: () => 'zh-CN',
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error('not available in tests')
    },
    decryptString: () => {
      throw new Error('not available in tests')
    },
  },
}))

import { Store } from '../src/main/store'
import { phoneReflectState } from '../src/main/companion/handlers/reflect'

const cleanups: string[] = []

afterEach(async () => {
  while (cleanups.length) {
    const dir = cleanups.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

async function setup(): Promise<Store> {
  const root = await mkdtemp(join(tmpdir(), 'pilot-reflect-notify-'))
  cleanups.push(root)
  userDataDir = join(root, 'user-data')
  const store = new Store()
  await store.load()
  return store
}

describe('Phone reflection settings for notifications', () => {
  it('ships the whole event catalog in recommended priority order', async () => {
    const store = await setup()
    const catalog = phoneReflectState(store, false).settings.notifyCatalog

    expect(catalog).toHaveLength(NOTIFY_EVENTS.length)
    expect(catalog.map((entry) => entry.id)).toEqual(NOTIFY_EVENTS.map((entry) => entry.id))
    expect(catalog.map((entry) => entry.priority)).toEqual(
      NOTIFY_EVENTS.map((entry) => entry.priority),
    )
    for (const entry of catalog) {
      expect(entry.zh.length).toBeGreaterThan(0)
      expect(entry.en.length).toBeGreaterThan(0)
      expect(entry.zhHint.length).toBeGreaterThan(0)
      expect(entry.enHint.length).toBeGreaterThan(0)
    }
  })

  it('follows the switch and the selected events after a settings update', async () => {
    const store = await setup()
    const before = phoneReflectState(store, false).settings
    expect(before.notifyEmailEvents).toEqual([...DEFAULT_NOTIFY_EMAIL_EVENTS])

    await store.updateSettings({
      notifyEmailEnabled: true,
      // 故意乱序并混入重复项：电脑端要按推荐优先级归一化后再下发。
      notifyEmailEvents: ['quality.better', 'run.failed', 'quality.better'],
    })

    const after = phoneReflectState(store, false).settings
    expect(after.notifyEmailEnabled).toBe(true)
    expect(after.notifyEmailEvents).toEqual(['run.failed', 'quality.better'])
  })

  it('keeps emailEnabled as the alias of the reflection report event', async () => {
    const store = await setup()
    expect(phoneReflectState(store, false).settings.emailEnabled).toBe(
      store.settingsView().notifyEmailEvents.includes('reflect.report'),
    )

    await store.updateSettings({
      notifyEmailEvents: ['run.failed', 'reflect.report'],
    })
    expect(phoneReflectState(store, false).settings.emailEnabled).toBe(true)

    await store.updateSettings({ notifyEmailEvents: ['run.failed'] })
    expect(phoneReflectState(store, false).settings.emailEnabled).toBe(false)
  })

  it('never ships the SMTP password, only whether one is stored', async () => {
    const store = await setup()
    const settings = phoneReflectState(store, false).settings as unknown as Record<string, unknown>
    expect(settings['hasPassword']).toBe(false)
    // 只发布尔，任何以 smtpPassword / password 结尾的真实凭据键都不能出现。
    expect(Object.keys(settings).filter((key) => /^(smtp|reflect)?Password$/i.test(key))).toEqual([])
  })
})
