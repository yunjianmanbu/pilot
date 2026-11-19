import { describe, expect, it } from 'vitest'
import {
  applyContrastColor,
  isContrastPreference,
  isSaturationPreference,
} from '../src/shared/theme'

describe('contrast and saturation preferences', () => {
  it('narrows stored values to the three supported levels', () => {
    for (const level of ['low', 'standard', 'high']) {
      expect(isContrastPreference(level)).toBe(true)
      expect(isSaturationPreference(level)).toBe(true)
    }
    for (const value of ['LOW', 'dim', 'bright', '', undefined, null, 1]) {
      expect(isContrastPreference(value)).toBe(false)
      expect(isSaturationPreference(value)).toBe(false)
    }
  })

  it('anchors standard surfaces to the former low-contrast step', () => {
    expect(applyContrastColor('#000000', 'dark', 'standard')).toBe('#050505')
    expect(applyContrastColor('#faf9f5', 'light', 'standard')).toBe('#f8f6f0')
  })

  it('deepens dark surfaces and lifts light surfaces at high contrast', () => {
    expect(applyContrastColor('#000000', 'dark', 'high')).toBe('#040404')
    expect(applyContrastColor('#1f1e1d', 'dark', 'high')).toBe('#1e1d1c')
    expect(applyContrastColor('#ffffff', 'light', 'high')).toBe('#fdfdfd')
    expect(applyContrastColor('#faf9f5', 'light', 'high')).toBe('#fbfbf8')
  })

  it('softens the ladder once more at low contrast', () => {
    expect(applyContrastColor('#000000', 'dark', 'low')).toBe('#0a0a0a')
    expect(applyContrastColor('#1f1e1d', 'dark', 'low')).toBe('#282726')
    expect(applyContrastColor('#ffffff', 'light', 'low')).toBe('#f7f7f7')
    expect(applyContrastColor('#faf9f5', 'light', 'low')).toBe('#f5f3eb')
  })

  it('returns non-hex values unchanged instead of throwing', () => {
    expect(applyContrastColor('transparent', 'dark', 'high')).toBe('transparent')
    expect(applyContrastColor('color-mix(in srgb, red 50%, blue)', 'light', 'low')).toBe(
      'color-mix(in srgb, red 50%, blue)',
    )
  })
})
