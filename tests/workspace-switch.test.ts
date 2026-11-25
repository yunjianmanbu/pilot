import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '../src/shared/types'
import { mergeWorkspaceSessions, sameWorkspaceLayout } from '../src/renderer/src/workspace-switch'

function session(id: string, workspacePath: string, updatedAt = '2026-01-01T00:00:00.000Z') {
  return { id, workspacePath, updatedAt, title: id } as unknown as SessionSummary
}

const A = 'E:/ws/a'
const B = 'E:/ws/b'

describe('mergeWorkspaceSessions', () => {
  it('只替换目标工作区的行，其它工作区内容不变', () => {
    const previous = [session('a1', A), session('b1', B), session('a2', A)]
    const merged = mergeWorkspaceSessions(previous, A, [session('a3', A)])
    expect(merged.filter((entry) => entry.workspacePath === A).map((entry) => entry.id)).toEqual([
      'a3',
    ])
    expect(merged.filter((entry) => entry.workspacePath === B).map((entry) => entry.id)).toEqual([
      'b1',
    ])
  })

  it('目标工作区的落点沿用原位置：别的分组不会被推到前面或后面', () => {
    const previous = [session('a1', A), session('a2', A), session('b1', B)]
    const merged = mergeWorkspaceSessions(previous, A, [session('a9', A), session('a8', A)])
    // 原位置（第一个 A 行处）被新的 A 行接管，B 仍紧跟在 A 块后面，没有被挪到前面。
    const ids = merged.map((entry) => entry.id)
    expect(ids).toEqual(['a9', 'a8', 'b1'])
  })

  it('目标工作区首次出现时追加到末尾，已有分组顺序不动', () => {
    const previous = [session('a1', A)]
    const merged = mergeWorkspaceSessions(previous, B, [session('b1', B)])
    expect(merged.map((entry) => entry.id)).toEqual(['a1', 'b1'])
  })

  it('重复切换同一工作区不会让清单变长（不累积旧行）', () => {
    const previous = [session('a1', A), session('b1', B)]
    let merged = mergeWorkspaceSessions(previous, A, [session('a2', A)])
    merged = mergeWorkspaceSessions(merged, A, [session('a2', A)])
    expect(merged.map((entry) => entry.id).sort()).toEqual(['a2', 'b1'])
  })
})

describe('sameWorkspaceLayout', () => {
  it('行与顺序都没变时返回 true（只需更新字段，不必恢复滚动）', () => {
    const previous = [session('a1', A), session('b1', B)]
    const next = [session('a1', A, '2026-02-02T00:00:00.000Z'), session('b1', B)]
    expect(sameWorkspaceLayout(previous, next)).toBe(true)
  })

  it('增删或重排时返回 false', () => {
    const previous = [session('a1', A), session('b1', B)]
    expect(sameWorkspaceLayout(previous, [session('a1', A)])).toBe(false)
    expect(sameWorkspaceLayout(previous, [session('b1', B), session('a1', A)])).toBe(false)
  })
})
