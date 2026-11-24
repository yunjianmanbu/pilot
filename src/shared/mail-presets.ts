/**
 * 常用邮箱服务商预设：邮箱地址一栏的下拉候选，以及选中后要填进 SMTP 三项的值。
 *
 * 地址本身永远由用户自己填（可以是任意域名、多个收件人），预设只解决「服务器地址、
 * 端口、加密方式填什么」这个最容易填错的环节。这里只放静态数据与纯函数，
 * 不引入 Electron：渲染层和测试共用同一份。
 */
import type { ReflectionSmtpSecurity } from './types'

export interface MailPreset {
  id: string
  /** 中文名（内部数据源语言，与 `shared/reflect.ts` 的目录同一套约定）。 */
  zh: string
  /** English label for the English UI. */
  en: string
  /** 归属该服务商的常见域名；按地址自动识别时用后缀匹配。 */
  domains: string[]
  host: string
  port: number
  security: ReflectionSmtpSecurity
}

/** 用户自己填服务器时下拉停在的这一项。 */
export const CUSTOM_MAIL_PRESET_ID = 'custom'

/**
 * 顺序即界面顺序：国内常用在前，国外常用在后。
 * 端口/加密以服务商官方说明为准——465 是隐式 TLS，587 是 STARTTLS。
 */
export const MAIL_PRESETS: MailPreset[] = [
  {
    id: '163',
    zh: '网易 163 邮箱',
    en: 'NetEase 163 Mail',
    domains: ['163.com'],
    host: 'smtp.163.com',
    port: 465,
    security: 'tls',
  },
  {
    id: '126',
    zh: '网易 126 邮箱',
    en: 'NetEase 126 Mail',
    domains: ['126.com'],
    host: 'smtp.126.com',
    port: 465,
    security: 'tls',
  },
  {
    id: 'yeah',
    zh: '网易 yeah.net',
    en: 'NetEase yeah.net',
    domains: ['yeah.net'],
    host: 'smtp.yeah.net',
    port: 465,
    security: 'tls',
  },
  {
    id: 'qq',
    zh: 'QQ 邮箱 / Foxmail',
    en: 'QQ Mail / Foxmail',
    domains: ['qq.com', 'foxmail.com'],
    host: 'smtp.qq.com',
    port: 465,
    security: 'tls',
  },
  {
    id: 'exmail',
    zh: '腾讯企业邮',
    en: 'Tencent Exmail',
    // 企业邮绑的是自有域名，无法从地址推断，只能手动选。
    domains: [],
    host: 'smtp.exmail.qq.com',
    port: 465,
    security: 'tls',
  },
  {
    id: 'sina',
    zh: '新浪邮箱',
    en: 'Sina Mail',
    domains: ['sina.com', 'sina.cn'],
    host: 'smtp.sina.com',
    port: 465,
    security: 'tls',
  },
  {
    id: '139',
    zh: '中国移动 139 邮箱',
    en: 'China Mobile 139 Mail',
    domains: ['139.com'],
    host: 'smtp.139.com',
    port: 465,
    security: 'tls',
  },
  {
    id: '189',
    zh: '中国电信 189 邮箱',
    en: 'China Telecom 189 Mail',
    domains: ['189.cn'],
    host: 'smtp.189.cn',
    port: 465,
    security: 'tls',
  },
  {
    id: 'gmail',
    zh: 'Gmail',
    en: 'Gmail',
    domains: ['gmail.com', 'googlemail.com'],
    host: 'smtp.gmail.com',
    port: 465,
    security: 'tls',
  },
  {
    id: 'outlook',
    zh: 'Outlook / Hotmail',
    en: 'Outlook / Hotmail',
    domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'],
    host: 'smtp-mail.outlook.com',
    port: 587,
    security: 'starttls',
  },
  {
    id: 'icloud',
    zh: 'iCloud 邮箱',
    en: 'iCloud Mail',
    domains: ['icloud.com', 'me.com', 'mac.com'],
    host: 'smtp.mail.me.com',
    port: 587,
    security: 'starttls',
  },
  {
    id: 'yahoo',
    zh: 'Yahoo 邮箱',
    en: 'Yahoo Mail',
    domains: ['yahoo.com', 'ymail.com'],
    host: 'smtp.mail.yahoo.com',
    port: 465,
    security: 'tls',
  },
  {
    id: 'zoho',
    zh: 'Zoho 邮箱',
    en: 'Zoho Mail',
    domains: ['zoho.com', 'zohomail.com'],
    host: 'smtp.zoho.com',
    port: 465,
    security: 'tls',
  },
  {
    id: 'yandex',
    zh: 'Yandex 邮箱',
    en: 'Yandex Mail',
    domains: ['yandex.com', 'yandex.ru'],
    host: 'smtp.yandex.com',
    port: 465,
    security: 'tls',
  },
  {
    id: 'gmx',
    zh: 'GMX 邮箱',
    en: 'GMX Mail',
    domains: ['gmx.com', 'gmx.net'],
    host: 'smtp.gmx.com',
    port: 465,
    security: 'tls',
  },
]

/** 第一个地址：多收件人时只有它参与 SMTP 登录，识别服务商也只看它。 */
export function firstMailbox(address: string): string {
  return (address.split(/[,;]/)[0] ?? '').trim()
}

/** 地址里的域名（小写、去首尾点）；没有 @ 时返回空串。 */
export function mailDomainOf(address: string): string {
  const mailbox = firstMailbox(address)
  const at = mailbox.lastIndexOf('@')
  if (at < 0) return ''
  return mailbox
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, '')
}

/** 按邮箱地址的域名找出服务商；自有域名返回 null（界面停在「自定义」）。 */
export function matchMailPresetByEmail(address: string): MailPreset | null {
  const domain = mailDomainOf(address)
  if (!domain) return null
  return (
    MAIL_PRESETS.find((preset) =>
      preset.domains.some((entry) => domain === entry || domain.endsWith(`.${entry}`)),
    ) ?? null
  )
}

/** 按已保存的 SMTP 主机反查服务商；用户手填的服务器返回 null。 */
export function matchMailPresetByHost(host: string): MailPreset | null {
  const normalized = host.trim().toLowerCase()
  if (!normalized) return null
  return MAIL_PRESETS.find((preset) => preset.host === normalized) ?? null
}
