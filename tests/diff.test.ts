import { describe, expect, it } from 'vitest'
import { createUnifiedDiff } from '../src/main/agent/diff'

describe('createUnifiedDiff', () => {
  it('returns an empty string when nothing changed', () => {
    expect(createUnifiedDiff('a.ts', 'same\n', 'same\n')).toBe('')
  })

  it('marks replacements with unified diff prefixes', () => {
    const diff = createUnifiedDiff('src/a.ts', 'const a = 1\nkeep\n', 'const a = 2\nkeep\n')
    expect(diff).toContain('--- a/src/a.ts')
    expect(diff).toContain('+++ b/src/a.ts')
    expect(diff).toContain('-const a = 1')
    expect(diff).toContain('+const a = 2')
    expect(diff).toContain(' keep')
  })

  it('handles insertions and deletions', () => {
    const diff = createUnifiedDiff('file.txt', 'a\nb\n', 'a\nx\nb\n')
    expect(diff).toContain('+x')
    const removed = createUnifiedDiff('file.txt', 'a\nx\nb\n', 'a\nb\n')
    expect(removed).toContain('-x')
  })
})
