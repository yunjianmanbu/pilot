import type {
  ContrastPreference,
  FontSizePreference,
  SaturationPreference,
  ThemeMode,
  ThemePreference,
} from './types'

/**
 * Turn the stored preference into the theme the UI actually paints.
 *
 * `system` follows the OS. The renderer resolves it with `matchMedia` and the
 * main process with `nativeTheme.shouldUseDarkColors`, so both ends agree on
 * the same value at any moment; keeping the maths in one pure function is what
 * stops the two from drifting.
 */
export function resolveThemePreference(
  preference: ThemePreference,
  prefersDark: boolean,
): ThemeMode {
  if (preference === 'system') return prefersDark ? 'dark' : 'light'
  return preference
}

/** Narrow a value read from disk or IPC; anything else falls back to `dark`. */
export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'dark' || value === 'light' || value === 'system'
}

/** Narrow a stored text-size preference; anything else is the original size. */
export function isFontSizePreference(value: unknown): value is FontSizePreference {
  return value === 'standard' || value === 'large' || value === 'xlarge'
}

/** Narrow a stored contrast preference; anything else is `standard`. */
export function isContrastPreference(value: unknown): value is ContrastPreference {
  return value === 'low' || value === 'standard' || value === 'high'
}

/** Narrow a stored saturation preference; anything else is `standard`. */
export function isSaturationPreference(value: unknown): value is SaturationPreference {
  return value === 'low' || value === 'standard' || value === 'high'
}

function rgbOf(hex: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim())
  if (!match?.[1]) return null
  const digits = match[1]
  return [0, 2, 4].map((index) => parseInt(digits.slice(index, index + 2), 16)) as [
    number,
    number,
    number,
  ]
}

function hexOf(rgb: [number, number, number]): string {
  return `#${rgb
    .map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0'))
    .join('')}`
}

function rgbToHsl([r, g, b]: [number, number, number]): [number, number, number] {
  const red = r / 255
  const green = g / 255
  const blue = b / 255
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  const lightness = (max + min) / 2
  if (max === min) return [0, 0, lightness]
  const delta = max - min
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min)
  let hue: number
  if (max === red) hue = (green - blue) / delta + (green < blue ? 6 : 0)
  else if (max === green) hue = (blue - red) / delta + 2
  else hue = (red - green) / delta + 4
  return [hue / 6, saturation, lightness]
}

function hslToRgb([hue, saturation, lightness]: [number, number, number]): [
  number,
  number,
  number,
] {
  if (saturation === 0) {
    const value = lightness * 255
    return [value, value, value]
  }
  const q =
    lightness < 0.5
      ? lightness * (1 + saturation)
      : lightness + saturation - lightness * saturation
  const p = 2 * lightness - q
  const channel = (input: number): number => {
    let value = input
    if (value < 0) value += 1
    if (value > 1) value -= 1
    if (value < 1 / 6) return p + (q - p) * 6 * value
    if (value < 1 / 2) return q
    if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6
    return p
  }
  return [channel(hue + 1 / 3) * 255, channel(hue) * 255, channel(hue - 1 / 3) * 255]
}

/**
 * Shift one surface color for the chosen contrast level.
 *
 * The generated stylesheet (`gen-appearance-css.mjs`) uses the same maths; this
 * copy exists so the main process can paint window chrome that matches the page.
 * `standard` is the old low-contrast step, so low/high compose from it instead
 * of from the raw palette.
 */
export function applyContrastColor(
  hex: string,
  theme: ThemeMode,
  contrast: ContrastPreference,
): string {
  const rgb = rgbOf(hex)
  if (!rgb) return hex
  const [hue, saturation, lightness] = rgbToHsl(rgb)
  const low = (value: number): number =>
    theme === 'dark' ? value + (1 - value) * 0.02 : value * 0.985
  const high = (value: number): number =>
    theme === 'dark' ? value * 0.85 : value + (1 - value) * 0.5
  const standard = low(lightness)
  const next = contrast === 'standard' ? standard : contrast === 'high' ? high(standard) : low(standard)
  return hexOf(hslToRgb([hue, saturation, next]))
}
