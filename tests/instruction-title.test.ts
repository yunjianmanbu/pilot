/**
 * 通知标题取「用户这一次说的话」。
 *
 * 守四件事：
 * 1) 优先取本次 run 的那条指令，而不是会话最近一条；
 * 2) 内部控制消息、折叠历史摘要不能冒充用户指令；
 * 3) markdown 记号与换行被压成一行，标题不会带 `#` 或续行；
 * 4) 截断按码点，emoji 不被切成半个字符。
 */
import { describe, expect, it } from 'vitest'
import type { StoredMessage } from '../src/shared/types'
import {
  MAIL_TITLE_LIMIT,
  NOTIFY_TITLE_LIMIT,
  cleanInstruction,
  clipInstruction,
  instructionOf,
  instructionTitle,
} from '../src/main/notify/instruction-title'

function message(overrides: Partial<StoredMessage>): StoredMessage {
  return {
    id: 'm',
    createdAt: '2026-01-01T00:00:00.000Z',
    role: 'user',
    content: '',
    ...overrides,
  } as StoredMessage
}

describe('cleanInstruction', () => {
  it('keeps the first real line and drops markdown noise', () => {
    expect(cleanInstruction('# 修复登录\n第二行不要')).toBe('修复登录')
    expect(cleanInstruction('- **重写** `notify` 模块')).toBe('重写 notify 模块')
    expect(cleanInstruction('1. 发布小红书')).toBe('发布小红书')
    expect(cleanInstruction('看这个 ![图](a.png) 和 [文档](b.md)')).toBe('看这个 和 文档')
    expect(cleanInstruction('```ts\nconst a = 1\n```\n真正的指令')).toBe('真正的指令')
  })

  it('returns an empty string for whitespace-only input', () => {
    expect(cleanInstruction('   \n\n')).toBe('')
  })
})

describe('instructionOf', () => {
  const messages = [
    message({ id: 'a', content: '第一条指令', runId: 'run-1' }),
    message({ id: 'b', content: '继续', runId: 'run-2', control: true }),
    message({ id: 'c', content: '第二条指令', runId: 'run-2' }),
    message({ id: 'd', content: '历史摘要', contextSummary: true }),
    message({ id: 'e', content: '旧工作', earlierWork: true }),
  ]

  it('prefers the instruction of the given run', () => {
    expect(instructionOf(messages, 'run-2')).toBe('第二条指令')
  })

  it('never treats control, summary or earlier-work messages as instructions', () => {
    expect(instructionOf(messages, 'run-2')).not.toBe('继续')
    expect(instructionOf(messages, undefined)).toBe('第二条指令')
  })

  it('falls back to the latest instruction when the runId is unknown', () => {
    expect(instructionOf(messages, 'run-missing')).toBe('第二条指令')
  })

  it('returns an empty string when there is no real instruction', () => {
    expect(instructionOf([message({ content: '继续', control: true })])).toBe('')
  })
})

describe('clipInstruction', () => {
  it('keeps short text untouched and clips long text with an ellipsis', () => {
    expect(clipInstruction('发布一篇小红书', 40)).toBe('发布一篇小红书')
    const clipped = clipInstruction('一'.repeat(80), 20)
    expect(Array.from(clipped)).toHaveLength(20)
    expect(clipped.endsWith('…')).toBe(true)
  })

  it('counts code points so emoji are not split', () => {
    const clipped = clipInstruction('🚀'.repeat(10), 4)
    expect(Array.from(clipped)).toEqual(['🚀', '🚀', '🚀', '…'])
  })
})

describe('instructionTitle', () => {
  it('uses the instruction and falls back when there is none', () => {
    expect(
      instructionTitle([message({ content: '整理发布清单', runId: 'r1' })], 'r1', {
        fallback: '当前任务',
      }),
    ).toBe('整理发布清单')
    expect(instructionTitle([], 'r1', { fallback: '当前任务' })).toBe('当前任务')
  })

  it('defaults to the desktop-notification limit', () => {
    const title = instructionTitle([message({ content: '一'.repeat(200) })], undefined, {
      fallback: '当前任务',
    })
    expect(Array.from(title)).toHaveLength(NOTIFY_TITLE_LIMIT)
    expect(MAIL_TITLE_LIMIT).toBeGreaterThan(NOTIFY_TITLE_LIMIT)
  })
})
