import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { isLocaleSetting, normalizeLocaleTag, resolveLocale } from '../src/shared/i18n'
import { applyLocaleSetting, getLocale, setLocale, t } from '../src/renderer/src/i18n'
import { en } from '../src/renderer/src/locale-en'

describe('locale resolution', () => {
  it('maps every Chinese tag to zh-CN and everything else to en', () => {
    expect(normalizeLocaleTag('zh')).toBe('zh-CN')
    expect(normalizeLocaleTag('zh-CN')).toBe('zh-CN')
    expect(normalizeLocaleTag('zh-Hans-CN')).toBe('zh-CN')
    expect(normalizeLocaleTag('zh_TW')).toBe('zh-CN')
    expect(normalizeLocaleTag('en-US')).toBe('en')
    expect(normalizeLocaleTag('de-DE')).toBe('en')
    expect(normalizeLocaleTag('')).toBe('en')
    expect(normalizeLocaleTag(null)).toBe('en')
  })

  it('follows the OS list when the setting is auto', () => {
    expect(resolveLocale('auto', ['zh-Hans-CN', 'en-US'])).toBe('zh-CN')
    expect(resolveLocale('auto', ['en-US', 'zh-Hans-CN'])).toBe('en')
    expect(resolveLocale('auto', 'ja-JP')).toBe('en')
  })

  it('honors a pinned setting over the OS', () => {
    expect(resolveLocale('en', ['zh-CN'])).toBe('en')
    expect(resolveLocale('zh-CN', ['en-US'])).toBe('zh-CN')
  })

  it('falls back to zh-CN when no OS locale is available', () => {
    expect(resolveLocale('auto', [])).toBe('zh-CN')
    expect(resolveLocale(undefined, undefined)).toBe('zh-CN')
  })

  it('validates persisted settings', () => {
    expect(isLocaleSetting('auto')).toBe(true)
    expect(isLocaleSetting('zh-CN')).toBe(true)
    expect(isLocaleSetting('en')).toBe(true)
    expect(isLocaleSetting('fr')).toBe(false)
    expect(isLocaleSetting(null)).toBe(false)
  })
})

describe('renderer translation', () => {
  it('applies the setting and reports whether the language changed', () => {
    const before = getLocale()
    expect(applyLocaleSetting('en', ['zh-CN'])).toBe(before !== 'en')
    expect(getLocale()).toBe('en')
    expect(setLocale('en')).toBe(false)
  })

  it('translates and interpolates placeholders', () => {
    setLocale('en')
    expect(t('剩余 {v1}', { v1: 3 })).toBe('3 left')
    expect(t('{v1} 个会话', { v1: 2 })).toBe('2 sessions')
    expect(t('命中 {v1} 条 · 来自 {v2} 个会话', { v1: 5, v2: 2 })).toBe(
      '5 hits · from 2 sessions',
    )
  })

  it('falls back to Chinese for untranslated copy and keeps unknown vars', () => {
    setLocale('en')
    expect(t('这段文案还没有英文')).toBe('这段文案还没有英文')
    expect(t('剩余 {v1}', {})).toBe('{v1} left')
    setLocale('zh-CN')
    expect(t('剩余 {v1}', { v1: 3 })).toBe('剩余 3')
  })
})

const RENDERER = path.join(__dirname, '..', 'src', 'renderer', 'src')
const SKIP = new Set(['i18n.ts', 'locale-en.ts'])

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(full))
    else if (/\.tsx?$/.test(entry.name) && !SKIP.has(entry.name)) out.push(full)
  }
  return out
}

/** Every source string handed to t(), including multi-line templates. */
function usedKeys(): Set<string> {
  const keys = new Set<string>()
  for (const file of sourceFiles(RENDERER)) {
    const code = fs.readFileSync(file, 'utf8')
    const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 't' &&
        node.arguments.length > 0
      ) {
        const first = node.arguments[0]
        if (first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) {
          keys.add(first.text)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return keys
}

describe('English dictionary coverage', () => {
  it('translates every string wrapped by t()', () => {
    const keys = usedKeys()
    expect(keys.size).toBeGreaterThan(500)
    const missing = [...keys].filter((key) => !(key in en))
    expect(missing).toEqual([])
  })

  it('has no entries that no component uses', () => {
    const keys = usedKeys()
    const extra = Object.keys(en).filter((key) => !keys.has(key))
    expect(extra).toEqual([])
  })
})
