import { describe, expect, it } from 'vitest'
import {
  FAILURE_ACTION_TEXT,
  FATAL_PROVIDER_STATUS,
  classifyRunFailure,
  failureAction,
  fatalProviderText,
} from '../src/shared/run-failure'

/**
 * The recovery bar used to say one sentence for a wrong API key, a network drop
 * and an exhausted step budget. These cases pin the three outcomes that the bar
 * and the agent loop now share, so the wording cannot drift back to generic.
 */
describe('classifyRunFailure', () => {
  it('names provider credential and model-permission failures as config', () => {
    expect(classifyRunFailure('failed', 'Qwen request failed (403): Access to model denied')).toBe(
      'config',
    )
    expect(classifyRunFailure('failed', 'glm reports insufficient balance (402)')).toBe('config')
    expect(classifyRunFailure('failed', 'DeepSeek request failed (400): model does not exist')).toBe(
      'config',
    )
    expect(classifyRunFailure('failed', 'rejected the api key')).toBe('config')
  })

  it('reports a hit step budget as budget, even without an error text', () => {
    expect(classifyRunFailure('max_steps')).toBe('budget')
    expect(classifyRunFailure('max_steps', null)).toBe('budget')
  })

  it('reports retryable transport failures as network', () => {
    expect(classifyRunFailure('failed', 'TypeError: fetch failed')).toBe('network')
    expect(classifyRunFailure('failed', 'socket hang up')).toBe('network')
    expect(classifyRunFailure('failed', 'Qwen request failed (503): service unavailable')).toBe(
      'network',
    )
    expect(classifyRunFailure('failed', 'request timed out after 120000ms')).toBe('network')
  })

  it('leaves user interruptions and unknown failures unclassified', () => {
    expect(classifyRunFailure('interrupted')).toBe('unknown')
    expect(classifyRunFailure('cancelled')).toBe('unknown')
    expect(classifyRunFailure('failed')).toBe('unknown')
    expect(classifyRunFailure('failed', '工具返回了 3 个错误')).toBe('unknown')
  })

  it('lets a fatal provider error outrank a step-budget status', () => {
    // Retrying a denied model is what pushed the run into the step cap, so the
    // user needs the configuration fix, not "continue".
    expect(classifyRunFailure('max_steps', 'Access to model denied (403)')).toBe('config')
  })

  it('does not treat rate limits as config', () => {
    expect(classifyRunFailure('failed', 'Qwen request failed (429): rate limit')).toBe('unknown')
  })

  it('matches the exact 401 wording this machine wrote 27 times', () => {
    // Real record from this workspace: every one of 27 runs ended on this line
    // and each one was replayed by auto-continue, which cannot fix a key.
    const text =
      'DeepSeek rejected the API key (401). Check it in Settings. Add credits or a valid key, then retry.'
    expect(classifyRunFailure('failed', text)).toBe('config')
    // A path or file that does not exist is not a provider problem.
    expect(classifyRunFailure('failed', 'ENOENT: no such file, path does not exist')).toBe('unknown')
  })
})

describe('failureAction', () => {
  it('picks the setting that actually needs changing', () => {
    expect(failureAction('DeepSeek rejected the API key (401). Check it in Settings.')).toBe('key')
    expect(failureAction('glm reports insufficient balance (402)')).toBe('balance')
    expect(failureAction('Qwen request failed (403): Access to model denied')).toBe('model')
    // 400 + a missing model id is still a settings problem, just not one of the
    // three named ones, so it asks for the general check.
    expect(failureAction('DeepSeek request failed (400): model does not exist')).toBe('config')
  })

  it('reads the wording when a relay sends no status code', () => {
    expect(failureAction('invalid api key')).toBe('key')
    expect(failureAction('this account has insufficient balance')).toBe('balance')
    expect(failureAction('You do not have access to the model glm-5')).toBe('model')
  })

  it('never invents an action for a retryable failure', () => {
    // The whole point is that a 429 or a dropped socket must not tell the user
    // to change their API key: they would "fix" nothing and lose the run.
    expect(failureAction('Qwen request failed (429): rate limit')).toBeNull()
    expect(failureAction('TypeError: fetch failed')).toBeNull()
    expect(failureAction('socket hang up')).toBeNull()
    expect(failureAction(null)).toBeNull()
    expect(failureAction('')).toBeNull()
  })

  it('has one sentence per action and they are all distinct', () => {
    const texts = Object.values(FAILURE_ACTION_TEXT)
    expect(texts).toHaveLength(4)
    expect(new Set(texts).size).toBe(4)
    for (const text of texts) expect(text.length).toBeGreaterThan(10)
  })
})

describe('fatalProviderText', () => {
  it('matches the wording relay endpoints use for account problems', () => {
    expect(fatalProviderText('invalid api key')).toBe(true)
    expect(fatalProviderText('You do not have access to the model glm-5')).toBe(true)
    expect(fatalProviderText('this account has no such model')).toBe(true)
  })

  it('only reads the first status code in the text', () => {
    // A retryable outer failure that merely quotes a 403 later stays retryable:
    // failing in the safe direction means a real retry is not blocked.
    expect(fatalProviderText('Qwen request failed (503): upstream said (403)')).toBe(false)
  })

  it('is false for empty and missing text', () => {
    expect(fatalProviderText(null)).toBe(false)
    expect(fatalProviderText(undefined)).toBe(false)
    expect(fatalProviderText('')).toBe(false)
  })

  it('keeps the shared fatal status list narrow', () => {
    expect([...FATAL_PROVIDER_STATUS].sort()).toEqual([401, 402, 403])
  })
})
