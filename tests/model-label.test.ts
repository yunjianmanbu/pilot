import { describe, expect, it } from 'vitest'
import {
  MODEL_TAG_MAX_LENGTH,
  modelOptionLabel,
  modelResourceName,
  modelTagLength,
  normalizeModelTag,
} from '../src/shared/model-label'

describe('model tags', () => {
  it('counts characters, not UTF-16 code units', () => {
    expect(MODEL_TAG_MAX_LENGTH).toBe(4)
    expect(modelTagLength('个人')).toBe(2)
    expect(modelTagLength('公司甲乙')).toBe(4)
    // 一个 emoji 由两个码元组成，但只算一个字。
    expect(modelTagLength('🙂🙂🙂🙂')).toBe(4)
    expect(modelTagLength(undefined)).toBe(0)
  })

  it('trims, collapses whitespace and truncates to four characters', () => {
    expect(normalizeModelTag('  公司A ')).toBe('公司A')
    expect(normalizeModelTag('公司  A')).toBe('公司 A')
    expect(normalizeModelTag('公司甲乙丙')).toBe('公司甲乙')
    expect(normalizeModelTag('')).toBe('')
    expect(normalizeModelTag(42)).toBe('')
  })

  it('renders the dropdown label as name, dot, tag', () => {
    expect(modelOptionLabel('gpt-5', '个人')).toBe('gpt-5 · 个人')
    expect(modelOptionLabel('gpt-5', '')).toBe('gpt-5')
    expect(modelOptionLabel('gpt-5', '   ')).toBe('gpt-5')
    expect(modelOptionLabel('  通义千问  ', '公司A')).toBe('通义千问 · 公司A')
    expect(modelOptionLabel('', '公司A')).toBe('公司A')
  })

  it('never shows the built-in placeholder model as a connected model', () => {
    // 预置资源就带着 deepseek-chat：它不是用户选过的模型，不能当名字展示。
    expect(modelResourceName({ label: '', model: 'deepseek-chat' })).toBe('')
    expect(modelResourceName({ label: '默认模型', model: 'deepseek-chat' })).toBe('默认模型')
    expect(modelResourceName({ label: '  ', model: 'deepseek-chat' })).toBe('')
    expect(modelResourceName({ label: '', model: ' qwen-max ' })).toBe('qwen-max')
    expect(modelResourceName(null)).toBe('')
    expect(modelResourceName(undefined)).toBe('')
  })
})
