import { describe, expect, it } from 'vitest'
import type { MemoryCategory, MemoryEntry } from '../src/shared/types'
import {
  MEMORY_CATEGORIES,
  MEMORY_ENTRY_MAX_CHARS,
  MEMORY_INJECT_LIMIT,
  inferMemoryCategory,
  isMemoryCategory,
  memoryCategoryOf,
} from '../src/shared/memory'
import {
  MEMORY_QUOTAS,
  looksLikeCorrection,
  memoryPromptLine,
  memoryValue,
  selectMemories,
  shortenMemory,
} from '../src/main/agent/memory'

let seq = 0

function entry(
  content: string,
  overrides: Partial<MemoryEntry> & { category?: MemoryCategory } = {},
): MemoryEntry {
  seq += 1
  return {
    id: `m${seq}`,
    content,
    source: 'reflection',
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('memory category vocabulary', () => {
  it('keeps one shared category list', () => {
    expect(MEMORY_CATEGORIES).toContain('fact')
    expect(MEMORY_CATEGORIES).toContain('invariant')
    expect(isMemoryCategory('negative')).toBe(true)
    expect(isMemoryCategory('nope')).toBe(false)
  })

  it('infers a category from the wording', () => {
    expect(inferMemoryCategory('根目录没有 tsconfig.json，必须在 pilot/client 下执行')).toBe(
      'negative',
    )
    expect(inferMemoryCategory('类型检查用 cd pilot/client && npx tsc -p tsconfig.node.json')).toBe(
      'verification',
    )
    expect(inferMemoryCategory('App.vue 与 styles.css 的色值必须同步，否则主题测试失败')).toBe(
      'invariant',
    )
    expect(inferMemoryCategory('曾尝试把 vitest 与 tsc 串在一条命令里，放弃')).toBe('decision')
    expect(inferMemoryCategory('Windows 下 start_process 需要 exe 绝对路径')).toBe('environment')
    expect(inferMemoryCategory('用户希望回复用中文', 'user')).toBe('preference')
    expect(inferMemoryCategory('addMemory 在 store.ts:1907')).toBe('fact')
  })

  it('falls back to inference for entries written before categories existed', () => {
    const legacy = entry('根目录没有 tsconfig.json')
    expect(legacy.category).toBeUndefined()
    expect(memoryCategoryOf(legacy)).toBe('negative')
  })
})

describe('selectMemories', () => {
  it('caps each category at its quota when the budget is scarce', () => {
    // More entries than slots in every category, so the quota pass is what binds.
    const memory = MEMORY_CATEGORIES.flatMap((category) =>
      Array.from({ length: 10 }, (_, index) =>
        entry(`${category} lesson ${index}`, { category }),
      ),
    )
    const picked = selectMemories(memory, MEMORY_INJECT_LIMIT)
    const byCategory = (category: MemoryCategory) =>
      picked.filter((item) => memoryCategoryOf(item) === category).length
    expect(picked).toHaveLength(MEMORY_INJECT_LIMIT)
    // The quota pass fills categories in priority order until the limit is hit,
    // so the last category only gets the slots that are left.
    expect(byCategory('invariant')).toBe(MEMORY_QUOTAS.invariant)
    expect(byCategory('verification')).toBe(MEMORY_QUOTAS.verification)
    expect(byCategory('fact')).toBe(MEMORY_QUOTAS.fact)
    expect(byCategory('decision')).toBe(0)
  })

  it('never exceeds the inject limit even with plenty of entries', () => {
    const memory = Array.from({ length: 80 }, (_, index) => entry(`lesson ${index}`))
    expect(selectMemories(memory)).toHaveLength(MEMORY_INJECT_LIMIT)
  })

  it('drops duplicate content and keeps the first ranked copy', () => {
    const memory = [
      entry('same lesson', { reinforced: 0 }),
      entry('Same Lesson', { reinforced: 3 }),
    ]
    const picked = selectMemories(memory)
    expect(picked).toHaveLength(1)
    expect(picked[0]?.reinforced).toBe(3)
  })

  it('ranks re-derived lessons above one-off ones', () => {
    const fresh = entry('one off', { createdAt: new Date().toISOString() })
    const proven = entry('proven', {
      reinforced: 4,
      createdAt: new Date(Date.now() - 20 * 86_400_000).toISOString(),
    })
    expect(memoryValue(proven)).toBeGreaterThan(memoryValue(fresh))
  })

  it('decays entries injected many times but never re-derived', () => {
    const stale = entry('stale', { injected: 12 })
    const used = entry('used', { injected: 12, reinforced: 1 })
    expect(memoryValue(used)).toBeGreaterThan(memoryValue(stale))
  })

  it('prefers user-written entries over reflections of equal strength', () => {
    const mine = entry('mine', { source: 'user' })
    const reflected = entry('reflected', { source: 'reflection' })
    expect(memoryValue(mine)).toBeGreaterThan(memoryValue(reflected))
  })

  it('ignores empty content', () => {
    expect(selectMemories([entry('   ')])).toHaveLength(0)
  })
})

describe('prompt rendering', () => {
  it('labels each line with category and source', () => {
    const line = memoryPromptLine(entry('根目录没有 tsconfig.json'))
    expect(line).toBe('- [negative/reflection] 根目录没有 tsconfig.json')
  })

  it('shortens long legacy entries to the entry budget', () => {
    const long = `${'a'.repeat(MEMORY_ENTRY_MAX_CHARS)} ${'b'.repeat(200)}`
    const shortened = shortenMemory(long)
    expect(shortened.length).toBeLessThanOrEqual(MEMORY_ENTRY_MAX_CHARS + 1)
    expect(shortened.endsWith('…')).toBe(true)
  })

  it('leaves short content untouched', () => {
    expect(shortenMemory('short')).toBe('short')
  })
})

describe('looksLikeCorrection', () => {
  it('detects the ways a user corrects earlier behaviour', () => {
    expect(looksLikeCorrection('不对，应该用 pnpm 而不是 npm')).toBe(true)
    expect(looksLikeCorrection('不要再改 styles.css 了')).toBe(true)
    expect(looksLikeCorrection('为什么还是没生效')).toBe(true)
    expect(looksLikeCorrection('That is wrong, use the absolute path instead')).toBe(true)
  })

  it('ignores ordinary requests', () => {
    expect(looksLikeCorrection('请帮我给项目记忆加一个分类字段')).toBe(false)
    expect(looksLikeCorrection('')).toBe(false)
  })
})
