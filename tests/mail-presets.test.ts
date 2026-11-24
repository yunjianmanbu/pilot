import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CUSTOM_MAIL_PRESET_ID,
  MAIL_PRESETS,
  firstMailbox,
  mailDomainOf,
  matchMailPresetByEmail,
  matchMailPresetByHost,
} from '../src/shared/mail-presets'

describe('常用邮箱预设表', () => {
  it('每一项都有可用的主机、端口与加密方式', () => {
    expect(MAIL_PRESETS.length).toBeGreaterThanOrEqual(12)
    for (const preset of MAIL_PRESETS) {
      expect(preset.id).not.toBe(CUSTOM_MAIL_PRESET_ID)
      expect(preset.host).toMatch(/^[a-z0-9.-]+\.[a-z]{2,}$/)
      expect(preset.port).toBeGreaterThan(0)
      expect(preset.port).toBeLessThanOrEqual(65_535)
      expect(['tls', 'starttls', 'none']).toContain(preset.security)
      expect(preset.zh.trim()).not.toBe('')
      expect(preset.en.trim()).not.toBe('')
    }
  })

  it('id 与 host 都唯一，避免下拉里出现两个一样的项', () => {
    expect(new Set(MAIL_PRESETS.map((preset) => preset.id)).size).toBe(MAIL_PRESETS.length)
    expect(new Set(MAIL_PRESETS.map((preset) => preset.host)).size).toBe(MAIL_PRESETS.length)
  })

  it('隐式 TLS 只配 465，STARTTLS 只配 587', () => {
    for (const preset of MAIL_PRESETS) {
      if (preset.security === 'tls') expect(preset.port).toBe(465)
      if (preset.security === 'starttls') expect(preset.port).toBe(587)
    }
  })
})

describe('按地址识别服务商', () => {
  it('只取第一个地址与最后一个 @ 之后的域名', () => {
    expect(firstMailbox(' a@163.com , b@gmail.com ')).toBe('a@163.com')
    expect(mailDomainOf(' a@163.com , b@gmail.com ')).toBe('163.com')
    expect(mailDomainOf('A@QQ.COM')).toBe('qq.com')
    expect(mailDomainOf('no-at-sign')).toBe('')
    expect(mailDomainOf('')).toBe('')
  })

  it('常见邮箱与子域名都能命中', () => {
    expect(matchMailPresetByEmail('someone@163.com')?.id).toBe('163')
    expect(matchMailPresetByEmail('someone@qq.com')?.id).toBe('qq')
    expect(matchMailPresetByEmail('someone@vip.qq.com')?.id).toBe('qq')
    expect(matchMailPresetByEmail('someone@foxmail.com')?.id).toBe('qq')
    expect(matchMailPresetByEmail('someone@gmail.com')?.id).toBe('gmail')
    expect(matchMailPresetByEmail('someone@outlook.com')?.id).toBe('outlook')
    expect(matchMailPresetByEmail('someone@icloud.com')?.id).toBe('icloud')
  })

  it('自有域名与空值都停在自定义', () => {
    expect(matchMailPresetByEmail('ops@example.com')).toBeNull()
    expect(matchMailPresetByEmail('someone@163.com.evil.test')).toBeNull()
    expect(matchMailPresetByEmail('')).toBeNull()
  })
})

describe('按已保存的主机反查服务商', () => {
  it('忽略大小写与首尾空格', () => {
    expect(matchMailPresetByHost(' SMTP.163.COM ')?.id).toBe('163')
    expect(matchMailPresetByHost('smtp.gmail.com')?.id).toBe('gmail')
  })

  it('用户手填的服务器不算任何预设', () => {
    expect(matchMailPresetByHost('mail.example.com')).toBeNull()
    expect(matchMailPresetByHost('')).toBeNull()
  })
})

/**
 * 手机端（pilot-link）是独立仓库，不打包桌面源码，所以预设表有两份副本。
 * 拆仓后本地看不到对方源码时跳过，其余情况逐条比对 id / host / port / security。
 */
const MOBILE_PANEL = path.join(
  __dirname,
  '..',
  '..',
  'pilot-link',
  'components',
  'reflect-panel',
  'reflect-panel.vue',
)
const hasMobilePanel = fs.existsSync(MOBILE_PANEL)

describe.skipIf(!hasMobilePanel)('与手机端预设表一致', () => {
  it('id / host / port / security 逐条相同且顺序一致', () => {
    const source = fs.readFileSync(MOBILE_PANEL, 'utf8')
    const start = source.indexOf('export const MAIL_PRESETS = [')
    expect(start).toBeGreaterThan(-1)
    const end = source.indexOf('/** 第一个地址的域名', start)
    expect(end).toBeGreaterThan(start)
    const block = source.slice(start, end)
    const entries = [...block.matchAll(
      /id: '([^']+)',[\s\S]*?host: '([^']+)',\s*port: (\d+),\s*security: '([^']+)'/g,
    )].map((match) => match.slice(1))
    expect(entries).toEqual(
      MAIL_PRESETS.map((preset) => [
        preset.id,
        preset.host,
        String(preset.port),
        preset.security,
      ]),
    )
  })
})
