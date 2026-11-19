import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseBlockMap, planDelta } from '../src/main/update/blockmap'

function checksum(data: Buffer): string {
  return createHash('sha256').update(data).digest('base64').slice(0, 28)
}

function blockMap(chunks: Buffer[], extra: Record<string, unknown> = {}) {
  return {
    version: '2',
    files: [
      {
        name: 'file',
        offset: 0,
        checksums: chunks.map(checksum),
        sizes: chunks.map((chunk) => chunk.length),
        ...extra,
      },
    ],
  }
}

describe('parseBlockMap', () => {
  it('parses blocks and computes offsets', () => {
    const chunks = [Buffer.from('aaaa'), Buffer.from('bbbbbb'), Buffer.from('cc')]
    const map = parseBlockMap(blockMap(chunks), 12)
    expect(map.totalSize).toBe(12)
    expect(map.blocks.map((block) => block.offset)).toEqual([0, 4, 10])
    expect(map.blocks.map((block) => block.size)).toEqual([4, 6, 2])
  })

  it('rejects malformed or mismatched blockmaps', () => {
    const chunks = [Buffer.from('aaaa'), Buffer.from('bbbb')]
    expect(() => parseBlockMap({ version: '1' }, 8)).toThrow()
    expect(() => parseBlockMap({ version: '2', files: [] }, 8)).toThrow()
    expect(() => parseBlockMap(blockMap(chunks), 7)).toThrow()
    expect(() =>
      parseBlockMap(
        {
          version: '2',
          files: [{ name: 'file', offset: 0, checksums: ['bad'], sizes: [4] }],
        },
        4,
      ),
    ).toThrow()
    expect(() =>
      parseBlockMap(
        {
          version: '2',
          files: [{ name: 'file', offset: 0, checksums: [checksum(Buffer.from('aaaa'))], sizes: [0] }],
        },
        0,
      ),
    ).toThrow()
  })
})

describe('planDelta', () => {
  const a = Buffer.from('a'.repeat(32))
  const b = Buffer.from('b'.repeat(32))
  const c = Buffer.from('c'.repeat(32))
  const d = Buffer.from('d'.repeat(32))

  it('reuses every block when nothing changed', () => {
    const old = parseBlockMap(blockMap([a, b, c]), 96)
    const next = parseBlockMap(blockMap([a, b, c]), 96)
    const plan = planDelta(next, old)
    expect(plan.downloadBytes).toBe(0)
    expect(plan.copyBytes).toBe(96)
    expect(plan.segments).toEqual([{ kind: 'copy', targetOffset: 0, sourceOffset: 0, size: 96 }])
  })

  it('downloads only the changed range', () => {
    const old = parseBlockMap(blockMap([a, b, c]), 96)
    const next = parseBlockMap(blockMap([a, d, c]), 96)
    const plan = planDelta(next, old)
    expect(plan.downloadBytes).toBe(32)
    expect(plan.segments).toEqual([
      { kind: 'copy', targetOffset: 0, sourceOffset: 0, size: 32 },
      { kind: 'download', targetOffset: 32, sourceOffset: 0, size: 32 },
      { kind: 'copy', targetOffset: 64, sourceOffset: 64, size: 32 },
    ])
  })

  it('follows matching blocks when offsets shift', () => {
    const old = parseBlockMap(blockMap([a, b, c]), 96)
    const next = parseBlockMap(blockMap([a, c]), 64)
    const plan = planDelta(next, old)
    expect(plan.downloadBytes).toBe(0)
    expect(plan.segments).toEqual([
      { kind: 'copy', targetOffset: 0, sourceOffset: 0, size: 32 },
      { kind: 'copy', targetOffset: 32, sourceOffset: 64, size: 32 },
    ])
  })

  it('downloads blocks whose size changed even if the checksum matches', () => {
    const old = parseBlockMap(blockMap([a]), 32)
    const next = parseBlockMap(blockMap([Buffer.from('a'.repeat(64))]), 64)
    const plan = planDelta(next, old)
    expect(plan.downloadBytes).toBe(64)
    expect(plan.copyBytes).toBe(0)
  })
})
