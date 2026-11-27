import { describe, expect, it } from 'vitest'
import {
  READONLY_SAMPLES,
  READONLY_SAMPLE_APPROVAL_MODE,
  READONLY_SAMPLE_PREFIX,
} from '../src/shared/readonly-samples'

describe('只读示例', () => {
  it('are exactly three, with stable ids', () => {
    expect(READONLY_SAMPLES).toHaveLength(3)
    expect(new Set(READONLY_SAMPLES.map((sample) => sample.id)).size).toBe(3)
    expect(READONLY_SAMPLES.map((sample) => sample.id)).toEqual([
      'overview',
      'walkthrough',
      'improve',
    ])
  })

  it('carry the read-only boundary in the prompt itself', () => {
    for (const sample of READONLY_SAMPLES) {
      expect(sample.prompt.startsWith(READONLY_SAMPLE_PREFIX)).toBe(true)
      // 档位只是第二层保险：任务文本自己就禁止写入与执行命令。
      expect(sample.prompt).toContain('不要修改任何文件')
      expect(sample.prompt).toContain('不要执行命令')
      // 空态示例必须短到一眼读完，长了就会被当成说明书略过。
      expect(sample.prompt.length).toBeLessThan(160)
    }
  })

  it('runs in the read-only tier', () => {
    // plan / dontAsk 会被 store-schema 折叠成 manual，写旧值会让调用值与落盘值不一致。
    expect(READONLY_SAMPLE_APPROVAL_MODE).toBe('manual')
  })
})
