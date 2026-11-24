/**
 * MIME 拼装：纯文本邮件保持原样，带 HTML 时发 multipart/alternative。
 *
 * 守四件事：
 * 1) 没有 html 就是单段 text/plain（老行为不变）；
 * 2) 有 html 时两段都在，纯文本在前，客户端挑一份渲染；
 * 3) 中文与换行经 base64 传输，不会出现以 `.` 开头的行（SMTP 点转义的前提）；
 * 4) 分界串可由调用方注入，测试不依赖随机值。
 */
import { describe, expect, it } from 'vitest'
import { buildMimeMessage, formatMailDate } from '../src/main/reflect/mail'

const DATE = new Date('2026-11-24T13:30:00.000Z')

function decodeBase64(block: string): string {
  return Buffer.from(block.replace(/\r?\n/g, ''), 'base64').toString('utf8')
}

function messageOf(mime: string): string {
  return mime.slice(mime.indexOf('\r\n\r\n') + 4)
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

const RFC_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function mimeDateHeader(mime: string): string {
  const line = mime.split('\r\n').find((candidate) => candidate.startsWith('Date: '))
  expect(line).toBeTruthy()
  return line!.slice('Date: '.length)
}

/** 本机时区偏移，形如 `+0800` / `-0500`。 */
function localZoneSuffix(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMinutes)
  return `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`
}

describe('buildMimeMessage', () => {
  it('keeps a text-only mail as one base64 text/plain part', () => {
    const mime = buildMimeMessage(
      { to: 'me@example.com', subject: 'Pilot · 任务完成', text: '第一行\n第二行' },
      { from: 'me@example.com', date: DATE, messageId: '<m1@example.com>' },
    )
    expect(mime).toContain('Content-Type: text/plain; charset=utf-8')
    expect(mime).toContain('Content-Transfer-Encoding: base64')
    expect(mime).not.toContain('multipart/alternative')
    expect(decodeBase64(messageOf(mime))).toBe('第一行\n第二行')
  })

  it('adds an html alternative after the text part when html is present', () => {
    const mime = buildMimeMessage(
      {
        to: 'me@example.com',
        subject: 'Pilot · 任务完成',
        text: '纯文本版本',
        html: '<p>HTML 版本</p>',
      },
      {
        from: 'me@example.com',
        date: DATE,
        messageId: '<m2@example.com>',
        boundary: 'pilot-test-boundary',
      },
    )
    expect(mime).toContain(
      'Content-Type: multipart/alternative; boundary="pilot-test-boundary"',
    )
    const parts = mime.split('--pilot-test-boundary')
    expect(parts).toHaveLength(4)
    expect(parts[1]).toContain('Content-Type: text/plain; charset=utf-8')
    expect(parts[2]).toContain('Content-Type: text/html; charset=utf-8')
    expect(decodeBase64(parts[1]!.split('\r\n\r\n')[1]!)).toBe('纯文本版本')
    expect(decodeBase64(parts[2]!.split('\r\n\r\n')[1]!)).toBe('<p>HTML 版本</p>')
    expect(parts[3]!.trim().startsWith('--')).toBe(true)
  })

  it('never emits a body line starting with a dot', () => {
    const mime = buildMimeMessage(
      { to: 'me@example.com', subject: 'x', text: '.', html: '<p>.</p>' },
      { from: 'me@example.com', date: DATE, boundary: 'b' },
    )
    const body = messageOf(mime)
      .split('\r\n')
      .filter((line) => line !== '' && !line.startsWith('--') && !line.includes(':'))
    expect(body.every((line) => !line.startsWith('.'))).toBe(true)
  })

  it('ignores an empty html string and stays text-only', () => {
    const mime = buildMimeMessage(
      { to: 'me@example.com', subject: 'x', text: 'body', html: '   ' },
      { from: 'me@example.com', date: DATE },
    )
    expect(mime).not.toContain('multipart/alternative')
  })

  it('writes the Date header in the sender local zone instead of GMT', () => {
    const header = mimeDateHeader(
      buildMimeMessage(
        { to: 'me@example.com', subject: 'x', text: 'body' },
        { from: 'me@example.com', date: DATE },
      ),
    )
    // 形如 `Tue, 24 Nov 2026 21:30:00 +0800`；不接受 GMT/UTC 后缀。
    expect(header).toMatch(/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} [+-]\d{4}$/)
    expect(header).not.toMatch(/GMT|UTC/i)
    // 钟点与日历日都取本地时间：客户端不做换算也不会差一个时区。
    expect(header).toContain(` ${pad(DATE.getHours())}:${pad(DATE.getMinutes())}:${pad(DATE.getSeconds())} `)
    expect(header).toContain(` ${pad(DATE.getDate())} ${RFC_MONTHS[DATE.getMonth()]} ${DATE.getFullYear()} `)
    expect(header.endsWith(localZoneSuffix(DATE))).toBe(true)
  })

  it('keeps the offset consistent with the local clock across the year', () => {
    // 夏令时切换区在冬夏两季偏移不同，两枚样本都要与 getTimezoneOffset 同步。
    for (const iso of ['2026-01-15T12:00:00.000Z', '2026-07-15T12:00:00.000Z']) {
      const date = new Date(iso)
      const header = formatMailDate(date)
      expect(header.endsWith(localZoneSuffix(date))).toBe(true)
      expect(header).toContain(` ${pad(date.getHours())}:${pad(date.getMinutes())}:`)
    }
  })
})
