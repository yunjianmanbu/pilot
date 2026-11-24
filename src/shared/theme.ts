import type { FontSizePreference, ThemeMode } from './types'

/**
 * Narrow a stored theme; anything else falls back to `dark`.
 *
 * There are only two themes, so this is the single place that decides what the
 * stylesheet may receive — the renderer applies the value as-is and the main
 * process paints window chrome from the same value.
 */
export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'dark' || value === 'light'
}

/** Narrow a stored text-size preference; anything else is the original size. */
export function isFontSizePreference(value: unknown): value is FontSizePreference {
  return value === 'standard' || value === 'large' || value === 'xlarge'
}
