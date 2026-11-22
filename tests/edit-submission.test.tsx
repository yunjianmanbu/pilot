/**
 * Editing a user message is also the rerun entry: the same button saves and
 * regenerates. It used to bail out when the text was unchanged, so clicking
 * 「保存并重新生成」without typing closed the box and started nothing — the user
 * read that as "保存并重新生成没有生效". These tests pin the decision logic and the
 * label that tells the user which of the two things the button does.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { editSubmission } from '../src/renderer/src/components/chat/message-rows'

describe('edit box submission', () => {
  it('submits unchanged text so the button can rerun without an edit', () => {
    expect(editSubmission('重新分析这个问题', false)).toEqual({
      submit: true,
      text: '重新分析这个问题',
    })
  })

  it('submits changed text after trimming it', () => {
    expect(editSubmission('  改过的指令\n', false)).toEqual({ submit: true, text: '改过的指令' })
  })

  it('refuses empty drafts and double submits', () => {
    expect(editSubmission('   ', false)).toEqual({ submit: false })
    expect(editSubmission('新指令', true)).toEqual({ submit: false })
  })
})

describe('edit box button label', () => {
  const source = readFileSync(
    fileURLToPath(
      new URL('../src/renderer/src/components/chat/message-rows.tsx', import.meta.url),
    ),
    'utf8',
  )

  it('names the rerun when the draft equals the stored content', () => {
    expect(source).toContain('draft.trim() === message.content ? t("重新生成") : t("保存并重新生成")')
  })

  it('no longer short-circuits a save on unchanged content', () => {
    expect(source).not.toContain('text === message.content')
  })
})
