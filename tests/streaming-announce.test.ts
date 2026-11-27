/**
 * 流式播报的切句逻辑。
 *
 * 这里钉住的是「读屏会不会被逐字轰炸」这件事的判定依据：所有切点都来自
 * `takeAnnouncement` 这个纯函数，组件只负责按固定间隔取一次。
 */
import { describe, expect, it } from 'vitest'
import {
  ANNOUNCE_MAX_CHARS,
  ANNOUNCE_MIN_CHARS,
  drainAnnouncements,
  plainSpeech,
  takeAnnouncement,
} from '../src/renderer/src/a11y/streaming-announce'

describe('takeAnnouncement', () => {
  it('waits for a whole sentence instead of reading every fragment', () => {
    expect(takeAnnouncement('好的')).toBeNull()
    expect(takeAnnouncement('正在检查配置，')).toBeNull()
  })

  it('cuts after the first sentence once it is long enough', () => {
    const text =
      '我先看一下这个仓库的入口文件在哪里，然后再决定要不要动构建脚本。第二步是跑一遍类型检查并记录结论。'
    const take = takeAnnouncement(text, { minChars: 20 })
    expect(take).not.toBeNull()
    expect(take?.text.endsWith('。')).toBe(true)
    // 只切到第一句，后面的留在缓冲里等下一轮。
    expect(take?.rest.startsWith('第二步')).toBe(true)
  })

  it('does not split western text on a decimal point or an abbreviation', () => {
    const text =
      'The build took 3.5 seconds in total, and e.g. the packaging step was the slow one here.'
    const take = takeAnnouncement(text, { minChars: 10 })
    // 切点不落在 3.5 的句点上，所以小数后面的内容也一同被播出去。
    expect(take?.text).toContain('3.5 seconds in total')
    // 断点落在整句结尾：小数点与 e.g. 都不算句末。
    expect(take?.text).toContain('e.g. the packaging')
    expect(take?.text.endsWith('here.')).toBe(true)
  })

  it('hard-cuts a long run without punctuation so the reader is never starved', () => {
    const blob = `${'abcdefghij '.repeat(40)}`
    const take = takeAnnouncement(blob)
    expect(take).not.toBeNull()
    expect(take!.text.length).toBeLessThanOrEqual(ANNOUNCE_MAX_CHARS)
    // 硬切优先落在空白处，不把英文单词劈成两半。
    expect(take!.text.endsWith('h') || take!.text.endsWith('abcdefghij')).toBe(true)
    expect(take!.rest.length).toBeGreaterThan(0)
  })

  it('never cuts an emoji surrogate pair in half', () => {
    const text = `${'😀'.repeat(ANNOUNCE_MAX_CHARS)}`
    const take = takeAnnouncement(text, { minChars: 4, maxChars: 7 })
    expect(take).not.toBeNull()
    const code = take!.text.charCodeAt(take!.text.length - 1)
    expect(code >= 0xd800 && code <= 0xdbff).toBe(false)
    expect(take!.text).toBe('😀😀😀')
  })

  it('respects a custom minimum', () => {
    const text = '第一句。第二句。'
    expect(takeAnnouncement(text, { minChars: 100 })).toBeNull()
    expect(takeAnnouncement(text, { minChars: 2 })?.text).toBe('第一句。')
  })

  it('flushes the tail when forced, even without punctuation', () => {
    const take = takeAnnouncement('最后半句没有句号', { force: true })
    expect(take?.text).toBe('最后半句没有句号')
    expect(take?.rest).toBe('')
  })

  it('defaults are the documented ones', () => {
    expect(ANNOUNCE_MIN_CHARS).toBe(60)
    expect(ANNOUNCE_MAX_CHARS).toBe(240)
  })
})

describe('drainAnnouncements', () => {
  it('empties the buffer without losing text', () => {
    const body = `${'第一段说明文字。'.repeat(3)}尾巴没有标点`
    const chunks = drainAnnouncements(body)
    const joined = chunks.join('').replace(/\s+/g, '')
    expect(joined).toBe(body.replace(/\s+/g, ''))
    // 一段话不该被切成几十条：每条都至少接近 minChars。
    expect(chunks.length).toBeLessThanOrEqual(4)
  })

  it('returns nothing for an empty buffer', () => {
    expect(drainAnnouncements('')).toEqual([])
  })
})

describe('plainSpeech', () => {
  it('strips markdown noise the reader should not spell out', () => {
    expect(plainSpeech('**结论**：`npm test` 通过')).toBe('结论：npm test 通过')
    expect(plainSpeech('见 [文档](https://example.com/a) 第二节')).toBe('见 文档 第二节')
    expect(plainSpeech('## 标题\n> 引用')).toBe('标题\n引用')
  })
})
