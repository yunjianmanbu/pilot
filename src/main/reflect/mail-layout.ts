/**
 * 邮件版式：反思报告与各类事件通知共用同一套 HTML 骨架。
 *
 * 为什么自己拼 HTML 而不是引模板库：发信实现是自写的最小 SMTP（见 `mail.ts`），
 * 多带一个依赖只为一封通知不值；而「统一美观」真正需要的是同一套字号、间距、
 * 状态色和深色适配，这些一屏 CSS 就能固定下来。
 *
 * 三条约束：
 * - 表格布局 + 内联样式：Outlook / 企业邮箱会剥掉 `<style>`，卡片结构不能依赖它。
 * - 深色模式用 `<style>` 里的 `prefers-color-scheme` 做增强，剥掉也只是退回浅色。
 * - 纯文本版始终同时发送（multipart/alternative），不假设客户端能渲染 HTML。
 */

export type MailTone = 'info' | 'success' | 'warning' | 'danger'

export interface MailRow {
  label: string
  value: string
}

export interface MailBlock {
  tone?: MailTone
  heading: string
  lines: string[]
}

export interface MailLayoutInput {
  /** 卡片大标题：一条通知讲的一件事。 */
  title: string
  /** 顶部品牌行右侧的小字，如「反思报告」「事件通知」。 */
  eyebrow?: string
  /** 标题上方的小徽标，用状态色区分成败。 */
  badge?: { text: string; tone: MailTone }
  /** 生成/发生时间（已格式化为本地时间字符串）。 */
  at?: string
  rows?: MailRow[]
  paragraphs?: string[]
  blocks?: MailBlock[]
  /** 底部一行提示，通常是「打开 Pilot 查看完整过程」。 */
  footnote: string
  english?: boolean
}

const TONE: Record<MailTone, { fg: string; bg: string }> = {
  info: { fg: '#1d4ed8', bg: '#eef4ff' },
  success: { fg: '#0f7a48', bg: '#e9f6ee' },
  warning: { fg: '#9a5b06', bg: '#fdf4e4' },
  danger: { fg: '#a3231b', bg: '#fdecea' },
}

const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif"

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function badgeHtml(badge: { text: string; tone: MailTone }): string {
  const tone = TONE[badge.tone]
  return [
    `<span class="pilot-badge" style="display:inline-block;padding:3px 10px;border-radius:999px;`,
    `background:${tone.bg};color:${tone.fg};font-size:12px;font-weight:600;`,
    `letter-spacing:.02em;">${escapeHtml(badge.text)}</span>`,
  ].join('')
}

function rowsHtml(rows: MailRow[]): string {
  const cells = rows
    .filter((row) => row.value.trim() !== '')
    .map(
      (row, index) => [
        `<tr>`,
        `<td class="pilot-label pilot-rule" style="width:80px;padding:${index === 0 ? '0' : '10px'} 16px 10px 0;`,
        `font-size:13px;line-height:20px;color:#6b7280;white-space:nowrap;vertical-align:top;`,
        `border-top:${index === 0 ? 'none' : '1px solid #eef0f3'};">${escapeHtml(row.label)}</td>`,
        `<td class="pilot-value pilot-rule" style="padding:${index === 0 ? '0' : '10px'} 0 10px 0;`,
        `font-size:13px;line-height:20px;color:#111827;vertical-align:top;word-break:break-word;`,
        `border-top:${index === 0 ? 'none' : '1px solid #eef0f3'};">${escapeHtml(row.value)}</td>`,
        `</tr>`,
      ].join(''),
    )
    .join('')
  if (!cells) return ''
  return [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" `,
    `style="border-collapse:collapse;margin:18px 0 0;">${cells}</table>`,
  ].join('')
}

function paragraphsHtml(paragraphs: string[]): string {
  return paragraphs
    .filter((text) => text.trim() !== '')
    .map(
      (text) =>
        `<p class="pilot-text" style="margin:16px 0 0;font-size:14px;line-height:24px;color:#1f2937;">${escapeHtml(text)}</p>`,
    )
    .join('')
}

function blocksHtml(blocks: MailBlock[]): string {
  return blocks
    .map((block) => {
      const tone = TONE[block.tone ?? 'info']
      const body = block.lines
        .filter((line) => line.trim() !== '')
        .map(
          (line) =>
            `<div class="pilot-text" style="margin:6px 0 0;font-size:13px;line-height:22px;color:#374151;">${escapeHtml(line)}</div>`,
        )
        .join('')
      return [
        `<table role="presentation" class="pilot-block" width="100%" cellpadding="0" cellspacing="0" border="0" `,
        `style="border-collapse:collapse;margin:14px 0 0;background:#fafafa;border-radius:10px;">`,
        `<tr>`,
        `<td width="3" style="width:3px;background:${tone.fg};border-radius:10px 0 0 10px;"></td>`,
        `<td style="padding:12px 14px;">`,
        `<div class="pilot-block-heading" style="font-size:13px;font-weight:600;line-height:20px;color:${tone.fg};">${escapeHtml(block.heading)}</div>`,
        body,
        `</td></tr></table>`,
      ].join('')
    })
    .join('')
}

/** 生成整封邮件的 HTML 正文。 */
export function renderMailHtml(input: MailLayoutInput): string {
  const lang = input.english ? 'en' : 'zh-CN'
  const title = escapeHtml(input.title)
  const eyebrow = escapeHtml(input.eyebrow ?? (input.english ? 'Notification' : '事件通知'))
  const parts: string[] = []
  parts.push('<!doctype html>')
  parts.push(`<html lang="${lang}"><head><meta charset="utf-8">`)
  parts.push('<meta name="viewport" content="width=device-width,initial-scale=1">')
  parts.push(`<meta name="color-scheme" content="light dark">`)
  parts.push(`<title>${title}</title>`)
  parts.push('<style>')
  parts.push(
    `@media (prefers-color-scheme: dark){.pilot-body{background:#0f1116!important}` +
      `.pilot-card{background:#181b21!important;border-color:#242833!important}` +
      `.pilot-brand{color:#f9fafb!important}.pilot-eyebrow{color:#6b7280!important}` +
      `.pilot-dot{background:#f9fafb!important}` +
      `.pilot-rule{border-top-color:#242833!important}` +
      `.pilot-title{color:#f3f4f6!important}.pilot-text{color:#d1d5db!important}` +
      `.pilot-label{color:#9ca3af!important}.pilot-value{color:#e5e7eb!important}` +
      `.pilot-hint{color:#6b7280!important;border-top-color:#242833!important}` +
      `.pilot-block{background:#20242c!important}` +
      `.pilot-block-heading{color:#f3f4f6!important}` +
      `.pilot-foot{color:#4b5563!important}}`,
  )
  parts.push('</style></head>')
  parts.push(`<body class="pilot-body" style="margin:0;padding:0;background:#f3f4f6;">`)
  // 邮件列表里的预览文本：不显示，但决定收件箱里那半行说明。
  parts.push(
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${title}</div>`,
  )
  parts.push(
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">',
  )
  parts.push('<tr><td align="center" style="padding:24px 12px;">')
  parts.push(
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" class="pilot-card" ` +
      `style="width:100%;max-width:600px;border-collapse:separate;background:#ffffff;` +
      `border:1px solid #e8eaee;border-radius:14px;font-family:${FONT};">`,
  )
  // 品牌行
  parts.push('<tr><td style="padding:22px 26px 0 26px;">')
  parts.push('<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>')
  parts.push(
    `<td class="pilot-brand" style="font-size:13px;font-weight:700;letter-spacing:.04em;color:#111827;">` +
      `<span class="pilot-dot" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#111827;` +
      `margin-right:8px;vertical-align:middle;"></span>Pilot</td>`,
  )
  parts.push(
    `<td align="right" class="pilot-eyebrow" style="font-size:12px;color:#9ca3af;letter-spacing:.02em;">${eyebrow}</td>`,
  )
  parts.push('</tr></table></td></tr>')
  // 标题
  parts.push('<tr><td style="padding:16px 26px 0 26px;">')
  if (input.badge) parts.push(`<div style="margin-bottom:10px;">${badgeHtml(input.badge)}</div>`)
  parts.push(
    `<div class="pilot-title" style="font-size:19px;font-weight:700;line-height:28px;color:#111827;word-break:break-word;">${title}</div>`,
  )
  if (input.at) {
    parts.push(
      `<div style="margin-top:6px;font-size:12px;line-height:18px;color:#9ca3af;">${escapeHtml(input.at)}</div>`,
    )
  }
  parts.push('</td></tr>')
  // 正文
  parts.push('<tr><td style="padding:0 26px 26px 26px;">')
  parts.push(rowsHtml(input.rows ?? []))
  parts.push(paragraphsHtml(input.paragraphs ?? []))
  parts.push(blocksHtml(input.blocks ?? []))
  parts.push(
    `<div class="pilot-hint" style="margin:22px 0 0;padding-top:14px;border-top:1px solid #eef0f3;` +
      `font-size:12px;line-height:18px;color:#9ca3af;">${escapeHtml(input.footnote)}</div>`,
  )
  parts.push('</td></tr>')
  parts.push('</table>')
  parts.push(
    `<div class="pilot-foot" style="margin-top:12px;font-size:11px;line-height:16px;color:#9ca3af;font-family:${FONT};">` +
      `${escapeHtml(input.english ? 'Sent by Pilot — your own desktop agent.' : '由 Pilot 发送 —— 你自己的桌面助手。')}</div>`,
  )
  parts.push('</td></tr></table></body></html>')
  return parts.join('\n')
}
