import { describe, expect, it } from 'vitest'
import { providerHost, providerInfo, providerLabel } from '../src/shared/provider'

describe('provider identity', () => {
  it('names the vendor behind a known endpoint', () => {
    expect(providerLabel('https://api.deepseek.com')).toBe('DeepSeek')
    expect(providerLabel('https://api.deepseek.com/')).toBe('DeepSeek')
    expect(providerLabel('https://dashscope.aliyuncs.com/compatible-mode/v1')).toBe('Qwen')
    expect(providerLabel('https://open.bigmodel.cn/api/paas/v4')).toBe('GLM')
    expect(providerLabel('https://api.z.ai/api/paas/v4')).toBe('GLM')
    expect(providerLabel('https://api.moonshot.cn/v1')).toBe('Moonshot')
    expect(providerLabel('https://api.openai.com/v1')).toBe('OpenAI')
  })

  it('prints the configured host for a custom relay or a local server', () => {
    expect(providerLabel('http://10.0.0.7:8000/v1')).toBe('10.0.0.7:8000')
    expect(providerLabel('http://localhost:11434/v1')).toBe('localhost:11434')
    expect(providerInfo('http://localhost:11434/v1')).toEqual({
      id: 'custom',
      label: 'localhost:11434',
    })
  })

  it('does not mistake an unrelated host that merely ends with the same letters', () => {
    expect(providerLabel('https://fizz.ai/v1')).toBe('fizz.ai')
  })

  it('falls back to the model name when the base URL has no host', () => {
    expect(providerLabel('', 'qwen-plus')).toBe('Qwen')
    expect(providerLabel('', 'glm-4.5')).toBe('GLM')
    expect(providerLabel('', 'deepseek-chat')).toBe('DeepSeek')
  })

  it('stays neutral when nothing identifies the endpoint', () => {
    expect(providerLabel('', 'gpt-4o-mini')).toBe('The model service')
    expect(providerLabel('   ')).toBe('The model service')
    expect(providerHost('not a url')).toBe('')
  })

  it('classifies well-known vendors', () => {
    expect(providerInfo('https://api.deepseek.com').id).toBe('deepseek')
    expect(providerInfo('https://dashscope.aliyuncs.com/compatible-mode/v1').id).toBe('qwen')
    expect(providerInfo('https://open.bigmodel.cn/api/paas/v4').id).toBe('glm')
    expect(providerInfo('https://api.moonshot.cn/v1').id).toBe('moonshot')
    expect(providerInfo('https://api.openai.com/v1').id).toBe('openai')
    expect(providerInfo('https://example.com/v1').id).toBe('custom')
  })
})
