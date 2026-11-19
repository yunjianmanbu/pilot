/** Languages the desktop client and the phone app ship with. */
export type AppLocale = 'zh-CN' | 'en'

/** User preference: follow the OS, or pin one shipped language. */
export type LocaleSetting = 'auto' | AppLocale

export const APP_LOCALES: AppLocale[] = ['zh-CN', 'en']

/**
 * Map any BCP-47 tag to a shipped locale. Any Chinese variant (zh, zh-CN,
 * zh-TW, zh-Hans, …) gets the Simplified Chinese UI; everything else gets English.
 */
export function normalizeLocaleTag(tag: string | null | undefined): AppLocale {
  const value = (tag ?? '').trim().toLowerCase().replace(/_/g, '-')
  return value === 'zh' || value.startsWith('zh-') ? 'zh-CN' : 'en'
}

export function isLocaleSetting(value: unknown): value is LocaleSetting {
  return value === 'auto' || value === 'zh-CN' || value === 'en'
}

/**
 * Resolve the effective UI language. `systemLocales` should be the OS
 * preference list (most preferred first); Electron's `app.getLocale()` and the
 * browser's `navigator.languages` both fit. With no signal at all we stay on
 * the Chinese original.
 */
export function resolveLocale(
  setting: LocaleSetting | null | undefined,
  systemLocales: string | string[] | null | undefined,
): AppLocale {
  if (setting === 'zh-CN' || setting === 'en') return setting
  const tags = Array.isArray(systemLocales) ? systemLocales : [systemLocales]
  for (const tag of tags) {
    if (typeof tag === 'string' && tag.trim()) return normalizeLocaleTag(tag)
  }
  return 'zh-CN'
}
