import {
  normalizeLocaleTag,
  resolveLocale,
  type AppLocale,
  type LocaleSetting,
} from '../../shared/i18n'
import { en } from './locale-en'

/**
 * Source-text i18n: the Chinese copy in the components is the key. Missing
 * English entries fall back to the Chinese original, so a new label is
 * readable before its translation lands.
 */
export type MessageVars = Record<string, string | number>

interface LocaleStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

interface LocaleNavigator {
  languages?: unknown
  language?: string
}

const LOCALE_CACHE_KEY = 'pilot.locale.v1'

function storage(): LocaleStorage | null {
  try {
    return (globalThis as { localStorage?: LocaleStorage }).localStorage ?? null
  } catch {
    return null
  }
}

function readCache(): AppLocale | null {
  try {
    const value = storage()?.getItem(LOCALE_CACHE_KEY)
    return value === 'zh-CN' || value === 'en' ? value : null
  } catch {
    return null
  }
}

function writeCache(locale: AppLocale): void {
  try {
    storage()?.setItem(LOCALE_CACHE_KEY, locale)
  } catch {
    // The cache only avoids a first-paint flash; storage may be disabled.
  }
}

export function systemLocales(): string[] {
  const nav = (globalThis as { navigator?: LocaleNavigator }).navigator
  const languages = nav?.languages
  if (Array.isArray(languages)) {
    const list = languages.filter((item): item is string => typeof item === 'string')
    if (list.length > 0) return list
  }
  return nav?.language ? [nav.language] : []
}

let current: AppLocale = readCache() ?? normalizeLocaleTag(systemLocales()[0] ?? 'zh-CN')

export function getLocale(): AppLocale {
  return current
}

/** Pin the effective language; returns true when it actually changed. */
export function setLocale(next: AppLocale): boolean {
  if (next === current) return false
  current = next
  writeCache(next)
  return true
}

/** Apply the saved preference against the OS list; returns true on change. */
export function applyLocaleSetting(
  setting: LocaleSetting | null | undefined,
  system: string | string[] = systemLocales(),
): boolean {
  return setLocale(resolveLocale(setting, system))
}

export function t(source: string, vars?: MessageVars): string {
  const template = current === 'en' ? en[source] ?? source : source
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name]
    return value === undefined ? match : String(value)
  })
}
