import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CHECKPOINT_IGNORE_LIMIT,
  matchesCheckpointIgnore,
  normalizeCheckpointIgnore,
} from '../src/shared/checkpoint-ignore'

let userDataDir = ''

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir, getLocale: () => 'zh-CN' },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error('not available in tests')
    },
    decryptString: () => {
      throw new Error('not available in tests')
    },
  },
}))

import { Store } from '../src/main/store'

const cleanups: string[] = []

afterEach(async () => {
  while (cleanups.length) {
    const dir = cleanups.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

describe('checkpoint ignore patterns', () => {
  it('normalizes separators, drops blanks and de-duplicates', () => {
    expect(normalizeCheckpointIgnore([' tmp ', 'tmp', '', '  ', 'a\\b'])).toEqual(['tmp', 'a/b'])
  })

  it('refuses patterns that escape or re-root the workspace', () => {
    expect(normalizeCheckpointIgnore(['../secret', '/etc', 'C:\\Windows', '..', '.'])).toEqual([])
    expect(normalizeCheckpointIgnore(['ok/../out'])).toEqual([])
  })

  it('ignores non-string and non-array input', () => {
    expect(normalizeCheckpointIgnore(undefined)).toEqual([])
    expect(normalizeCheckpointIgnore('tmp' as unknown)).toEqual([])
    expect(normalizeCheckpointIgnore([1, null, 'tmp'])).toEqual(['tmp'])
  })

  it('caps the pattern count', () => {
    const many = Array.from({ length: CHECKPOINT_IGNORE_LIMIT + 20 }, (_, i) => `dir-${i}`)
    expect(normalizeCheckpointIgnore(many)).toHaveLength(CHECKPOINT_IGNORE_LIMIT)
  })

  it('matches a bare segment at any depth', () => {
    expect(matchesCheckpointIgnore('tmp/a.log', ['tmp'])).toBe(true)
    expect(matchesCheckpointIgnore('sub/tmp/a.log', ['tmp'])).toBe(true)
    expect(matchesCheckpointIgnore('tmp', ['tmp'])).toBe(true)
    expect(matchesCheckpointIgnore('tmp.txt', ['tmp'])).toBe(false)
    expect(matchesCheckpointIgnore('src/tmpl/a.ts', ['tmp'])).toBe(false)
  })

  it('resolves a rooted pattern from the workspace root only', () => {
    expect(matchesCheckpointIgnore('src/cache/c.json', ['src/cache'])).toBe(true)
    expect(matchesCheckpointIgnore('src/cache/c.json', ['cache'])).toBe(true)
    expect(matchesCheckpointIgnore('other/src/cache/c.json', ['src/cache'])).toBe(false)
  })

  it('supports globs inside one segment', () => {
    expect(matchesCheckpointIgnore('dist-old/a.js', ['dist-*'])).toBe(true)
    expect(matchesCheckpointIgnore('dist-old/a.js', ['dist-?ld'])).toBe(true)
    // `dist-*` needs the dash, so the plain `dist` directory is not covered.
    expect(matchesCheckpointIgnore('dist/a.js', ['dist-*'])).toBe(false)
    expect(matchesCheckpointIgnore('dist-old/a.js', ['dist'])).toBe(false)
    // `*` never crosses a separator.
    expect(matchesCheckpointIgnore('a/b/c.ts', ['a/*/c.ts'])).toBe(true)
    expect(matchesCheckpointIgnore('a/b/x/c.ts', ['a/*/c.ts'])).toBe(false)
  })

  it('treats regex metacharacters in a pattern literally', () => {
    expect(matchesCheckpointIgnore('a+b/x.ts', ['a+b'])).toBe(true)
    expect(matchesCheckpointIgnore('aab/x.ts', ['a+b'])).toBe(false)
    expect(matchesCheckpointIgnore('node(1)/x.ts', ['node(1)'])).toBe(true)
  })

  it('is a no-op for an empty pattern list', () => {
    expect(matchesCheckpointIgnore('tmp/a.log', [])).toBe(false)
  })
})

describe('checkpoint ignore settings round-trip', () => {
  it('persists normalized patterns and drops escaping ones', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pilot-checkpoint-ignore-'))
    cleanups.push(root)
    userDataDir = join(root, 'user-data')
    const store = new Store()
    await store.load()

    await store.updateSettings({ checkpointIgnore: [' tmp ', '../escape', 'dist-*'] })
    expect(store.settings().checkpointIgnore).toEqual(['tmp', 'dist-*'])

    // A reload reads the same normalized value back from disk.
    const reloaded = new Store()
    await reloaded.load()
    expect(reloaded.settings().checkpointIgnore).toEqual(['tmp', 'dist-*'])
  })
})
