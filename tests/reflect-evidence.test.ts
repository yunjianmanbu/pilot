import { describe, expect, it } from 'vitest'
import { codeFactsFromModuleCheck, renderEvidence, type ReflectionEvidence } from '../src/main/reflect/evidence'
import { SPLIT_DECISIONS, SPLIT_CONSTRAINTS } from '../src/shared/split-decisions'
import type { ModuleCheckReport } from '../src/shared/module-check'
import { sanitizeReport } from '../src/shared/module-check'

/**
 * 反思的代码事实必须和界面上那份自检报告同源：既不能重新按行数猜该不该拆，
 * 也不能漏掉已经记录过的拆分决策。这组用例锁的就是这两条。
 */

function report(overrides: Partial<ModuleCheckReport> = {}): ModuleCheckReport {
  return {
    id: 'mr_test',
    trigger: 'manual',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:05.000Z',
    workspace: 'E:/ws',
    modules: ['pilot'],
    targets: [],
    risks: [],
    scannedFiles: 100,
    scannedLines: 20000,
    score: 90,
    ...overrides,
  }
}

function baseEvidence(code: ReflectionEvidence['code']): ReflectionEvidence {
  return {
    generatedAt: '2026-01-01T00:00:00.000Z',
    workspaces: [],
    totals: {
      workspaces: 0,
      sessions: 0,
      runs: 0,
      failures: 0,
      failureRate: 0,
      toolErrors: 0,
      avgSteps: 0,
      avgTokens: 0,
      compactedRuns: 0,
      totalSteps: 0,
      totalTokens: 0,
    },
    ...(code ? { code } : {}),
  }
}

describe('codeFactsFromModuleCheck', () => {
  it('没有自检状态时不编造代码事实', () => {
    expect(codeFactsFromModuleCheck(null)).toBeNull()
    expect(codeFactsFromModuleCheck(undefined)).toBeNull()
  })

  it('只把未决策的大文件列进 oversized，已决策的不再当线索', () => {
    const facts = codeFactsFromModuleCheck({
      lastReport: report({
        // 空 workspace：本用例只验证筛选与决策互斥，不查盘（查盘行为另有用例）。
        workspace: '',
        largeFiles: [
          { path: 'src/main/agent/runner.ts', lines: 2200, decided: true },
          { path: 'src/main/new-big.ts', lines: 1200, decided: false },
        ],
      }),
    })
    expect(facts?.oversized).toEqual([{ path: 'src/main/new-big.ts', lines: 1200 }])
  })

  it('采集时重读磁盘行数：文件已拆小或已不在都反映出来', () => {
    const facts = codeFactsFromModuleCheck({
      lastReport: report({
        workspace: process.cwd(),
        largeFiles: [
          { path: 'src/main/reflect/evidence.ts', lines: 1200, decided: false },
          { path: 'src/main/already-deleted.ts', lines: 900, decided: false },
        ],
      }),
    })
    const [present, gone] = facts?.oversized ?? []
    expect(present?.currentLines).toBeGreaterThan(100)
    // 报告里的旧行数保留下来，才能看出「报告说 1200 行、现在多了多少」。
    expect(present?.lines).toBe(1200)
    expect(gone?.missing).toBe(true)
    expect(gone?.currentLines).toBeUndefined()
  })

  it('报告里没有决策时退回仓库记录的决策表', () => {
    const facts = codeFactsFromModuleCheck({ lastReport: report() })
    expect(facts?.decisions).toEqual(SPLIT_DECISIONS)
    expect(facts?.decisions.length).toBeGreaterThan(0)
  })

  it('报告里命中的决策优先，不被全表覆盖', () => {
    const hit = SPLIT_DECISIONS[1]!
    const facts = codeFactsFromModuleCheck({ lastReport: report({ decisions: [hit] }) })
    expect(facts?.decisions).toEqual([hit])
  })

  it('旧报告缺 decided 字段时，已决策的文件照样不算待决策', () => {
    // 上一版写盘的报告没有 decided 字段，sanitize 会读成 false；如果不拿决策表兜底，
    // 已经拍过板不拆的 runner.ts 会重新出现在反思线索里。这里走真实读取路径。
    const legacy = sanitizeReport({
      id: 'mr_legacy',
      trigger: 'manual',
      workspace: 'E:/ws',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:05.000Z',
      largeFiles: [{ path: 'src/main/agent/runner.ts', lines: 2200 }],
    })
    expect(legacy?.largeFiles?.[0]?.decided).toBe(false)
    const facts = codeFactsFromModuleCheck({ lastReport: legacy ?? undefined })
    expect(facts?.oversized).toEqual([])
    expect(facts?.decisions.some((decision) => decision.path === 'src/main/agent/runner.ts')).toBe(true)
  })

  it('风险点带上依据，反思才能看出结论从哪来', () => {
    const facts = codeFactsFromModuleCheck({
      lastReport: report({
        risks: [
          {
            id: 'pilot:oversized-file',
            moduleId: 'pilot',
            moduleName: 'pilot',
            rule: 'oversized-file',
            severity: 'low',
            title: '1 个大文件还没有拆分决策',
            detail: '',
            recommendation: '',
            count: 1,
            evidence: [],
            basis: 'oversized-file 阈值 800 行',
            manual: true,
          },
        ],
      }),
    })
    expect(facts?.risks[0]?.basis).toBe('oversized-file 阈值 800 行')
  })
})

describe('renderEvidence', () => {
  it('把决策与结构约束一起交给模型，并说明行数不是结论', () => {
    const facts = codeFactsFromModuleCheck({
      lastReport: report({
        workspace: '',
        largeFiles: [{ path: 'src/main/new-big.ts', lines: 1200, decided: false }],
      }),
    })
    const text = renderEvidence(baseEvidence(facts ?? undefined), false)
    expect(text).toContain('src/main/new-big.ts')
    expect(text).toContain('只是行数，不是结论')
    expect(text).toContain('已记录的决策（不得推翻）')
    for (const decision of SPLIT_DECISIONS) expect(text).toContain(decision.path)
    for (const constraint of SPLIT_CONSTRAINTS) expect(text).toContain(constraint)
  })

  it('没量过的大文件不会被当成拆分候选：只要求先量化', () => {
    const facts = codeFactsFromModuleCheck({
      lastReport: report({
        workspace: '',
        largeFiles: [{ path: 'src/main/new-big.ts', lines: 1200, decided: false }],
      }),
    })
    const text = renderEvidence(baseEvidence(facts ?? undefined), false)
    expect(text).toContain('还没量过（只是行数，不是结论）：src/main/new-big.ts（扫描时 1200 行）')
    expect(text).not.toContain('已有判据但还没决策')
  })

  it('带 verdict 的大文件单独成行，并给出判据分布', () => {
    // 用 App.tsx：它在实测表（SPLIT_SCAN）里有判据，但还没写进决策表，
    // 正好是「有判据、只差一条决策」这种待决策状态。
    const facts = codeFactsFromModuleCheck({
      lastReport: report({
        workspace: '',
        largeFiles: [
          { path: 'src/renderer/src/App.tsx', lines: 3370, decided: false, verdict: 'METHOD' },
          { path: 'src/main/brand-new.ts', lines: 900, decided: false },
        ],
      }),
    })
    expect(facts?.oversized).toEqual([
      { path: 'src/renderer/src/App.tsx', lines: 3370, verdict: 'METHOD' },
      { path: 'src/main/brand-new.ts', lines: 900 },
    ])
    const text = renderEvidence(baseEvidence(facts ?? undefined), false)
    expect(text).toContain('已有判据但还没决策：src/renderer/src/App.tsx（扫描时 3370 行，METHOD）')
    expect(text).toContain('还没量过（只是行数，不是结论）：src/main/brand-new.ts（扫描时 900 行）')
    // 判据分布 + “哪些码不支持拆”必须一起给，否则模型仍会用行数当理由。
    expect(text).toContain('判据分布')
    expect(text).toContain('都不支持拆分')
  })

  it('英文渲染同样带上判据约束，不留中文残句', () => {
    const facts = codeFactsFromModuleCheck({
      lastReport: report({ largeFiles: [{ path: 'src/main/new-big.ts', lines: 1200, decided: false }] }),
    })
    const text = renderEvidence(baseEvidence(facts ?? undefined), true)
    expect(text).toContain('line count only, not a verdict')
    expect(text).toContain('recorded decisions (do not overturn)')
    expect(text).not.toContain('已记录的决策')
    expect(text).not.toContain('决定不拆')
    expect(text).not.toContain('暂缓')
  })
})
