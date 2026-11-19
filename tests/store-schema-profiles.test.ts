import { describe, expect, it } from 'vitest'
import { sanitizeWorkspace } from '../src/main/store-schema'

function rawProfile(version: number, status: 'draft' | 'active' | 'retired') {
  return {
    id: `p${version}`,
    version,
    status,
    promptAddendum: `规则 ${version}`,
    strategy: {},
    rationale: 'evidence',
    source: 'self',
    scope: 'workspace',
    evidence: { runs: 3, failures: 0, avgSteps: 5, avgTokens: 100, positive: 0, negative: 0 },
    createdAt: '2026-11-19T00:00:00.000Z',
  }
}

describe('sanitizeWorkspace profile cap', () => {
  it('keeps the active profile when newer drafts fill the stored history', () => {
    // The store keeps profiles newest-first, so the active profile is the last
    // entry; a plain slice(0, 40) on load would silently drop it.
    const drafts = Array.from({ length: 40 }, (_, index) => rawProfile(40 - index, 'draft'))
    const record = sanitizeWorkspace({
      path: 'E:\\code\\demo',
      profiles: [...drafts, rawProfile(17, 'active')],
    })

    expect(record?.profiles).toHaveLength(40)
    expect(record?.profiles.map((profile) => profile.id)).toContain('p17')
    expect(record?.profiles.map((profile) => profile.id)).not.toContain('p1')
  })

  it('leaves a short history untouched', () => {
    const record = sanitizeWorkspace({
      path: 'E:\\code\\demo',
      profiles: [rawProfile(2, 'draft'), rawProfile(1, 'active')],
    })
    expect(record?.profiles.map((profile) => profile.id)).toEqual(['p2', 'p1'])
  })
})
