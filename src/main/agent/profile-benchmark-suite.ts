/**
 * Versioned task library for the profile benchmark.
 *
 * A fixed suite measures "is this version better than that one" for a while and
 * then stops being useful: once every task passes on both sides, a comparison
 * can only ever return `inconclusive`. That is not a lack of difference, it is
 * a saturated ruler. This module keeps the ruler honest:
 *
 * - every revision is recorded (what was added, what was kept), so a verdict
 *   can be read against the suite it came from instead of "the suite";
 * - coverage is tracked per difficulty tier and per capability dimension, so a
 *   blind spot is visible before it is trusted;
 * - the ceiling is derived from the sessions at the hardest covered tier, and a
 *   saturated ceiling produces an explicit upgrade plan instead of a silent
 *   "no difference".
 *
 * The rule that keeps upgrades meaningful: a new revision may add tasks, it may
 * never relax or delete a check that already passed. Regression coverage is
 * what makes "the agent got better" different from "the exam got easier".
 */
import type { BenchmarkSample, BenchmarkTask } from './profile-benchmark'

export type BenchmarkTier = 'L0' | 'L1' | 'L2' | 'L3'

/** Ascending difficulty; `BenchmarkTier` is exactly this list. */
export const BENCHMARK_TIERS: readonly BenchmarkTier[] = ['L0', 'L1', 'L2', 'L3']

export interface SuiteRevision {
  version: number
  /** One line a human can read in the review panel. */
  change: string
  /** Task ids that first appeared in this revision. */
  added: string[]
  /** Task ids dropped from the run set but kept in the fixture pool. */
  retired: string[]
}

/**
 * Append-only. A published revision is never edited: if a task was wrong, it is
 * retired in the next revision and the reason is written there.
 */
export const BENCHMARK_SUITE_HISTORY: readonly SuiteRevision[] = [
  {
    version: 1,
    change: '首版：L0 冒烟 + L1 单文件修复，只回答「能不能改对」',
    added: ['respect-format', 'fix-rounding', 'fix-format', 'fix-bug'],
    retired: [],
  },
  {
    version: 2,
    change: 'L2 多文件：跨文件重命名、端口配置、在已有风格里补实现并补测试',
    added: [
      'finish-feature',
      'fix-broken-json',
      'multifile-port-bug',
      'cross-file-rename',
      'harden-validation',
    ],
    retired: [],
  },
  {
    version: 3,
    change: 'L3 天花板：单一实现的开放重构，以及非法输入的退出码契约（各带客观不变量检查）',
    added: ['budget-free-refactor', 'harden-cli-input'],
    retired: [],
  },
  {
    version: 4,
    change:
      '区分稳定解与侥幸解：最难题层默认重复 2 次并统计不稳定样本；新增一组合并能力维度任务（开放重构 + 输入契约），饱和判定要求重复全通过',
    added: ['compose-refactor-and-contract'],
    retired: [],
  },
]

export const BENCHMARK_SUITE_VERSION = BENCHMARK_SUITE_HISTORY.length

export interface SuiteDimension {
  id: string
  label: string
  /** Task tags that cover this dimension. */
  tags: readonly string[]
  /** What a task in this dimension is supposed to prove. */
  meaning: string
}

/**
 * Capability dimensions this suite claims to cover. A dimension with no task is
 * a blind spot: the benchmark cannot see a profile change there, and the verdict
 * must not be read as "no difference in this ability".
 */
export const BENCHMARK_DIMENSIONS: readonly SuiteDimension[] = [
  {
    id: 'instruction-following',
    label: '指令遵循',
    tags: ['instruction-following', 'append-only'],
    meaning: '只做被要求的事，不顺手改动无关内容',
  },
  {
    id: 'localization',
    label: '定位与阅读',
    tags: ['read-before-edit', 'single-file', 'numeric', 'read-error-first', 'data-fix'],
    meaning: '先读懂再动手，能从一个报错走到真正的根因',
  },
  {
    id: 'multi-file',
    label: '跨文件一致性',
    tags: ['multi-file', 'rename-all', 'refactor', 'implement-method'],
    meaning: '一次改动在所有引用点保持一致，旧名字不残留',
  },
  {
    id: 'verification',
    label: '自测与验证',
    tags: ['write-tests', 'edge-cases', 'keep-style', 'feature-edit'],
    meaning: '交付时带上可复现的验证，而不是口头声称通过',
  },
  {
    id: 'robustness',
    label: '鲁棒性与契约',
    tags: ['error-contract', 'input-validation'],
    meaning: '非法输入有明确的失败方式，不崩溃、不静默给出错误结果',
  },
]

export interface DimensionCoverage {
  id: string
  label: string
  taskIds: string[]
}

export interface SuiteSummary {
  version: number
  tasks: number
  byTier: Record<BenchmarkTier, number>
  /** Hardest tier that at least one task covers, or null when nothing is rated. */
  ceilingTier: BenchmarkTier | null
  dimensions: DimensionCoverage[]
  /** Dimension labels with no task. */
  blindSpots: string[]
  /** Structural problems found in the suite itself (not in a profile). */
  warnings: string[]
}

function tierOf(task: BenchmarkTask): BenchmarkTier | null {
  return task.difficulty && BENCHMARK_TIERS.includes(task.difficulty) ? task.difficulty : null
}

function nextTier(tier: BenchmarkTier): BenchmarkTier | null {
  const index = BENCHMARK_TIERS.indexOf(tier)
  return index >= 0 && index < BENCHMARK_TIERS.length - 1 ? BENCHMARK_TIERS[index + 1]! : null
}

/** Describe the suite itself: version, tier balance, dimension coverage. */
export function summarizeSuite(
  tasks: readonly BenchmarkTask[],
  version: number = BENCHMARK_SUITE_VERSION,
): SuiteSummary {
  const byTier = { L0: 0, L1: 0, L2: 0, L3: 0 } satisfies Record<BenchmarkTier, number>
  const warnings: string[] = []
  const seen = new Set<string>()
  for (const task of tasks) {
    if (seen.has(task.id)) warnings.push(`任务 id 重复：${task.id}`)
    seen.add(task.id)
    const tier = tierOf(task)
    if (!tier) {
      warnings.push(`任务 ${task.id} 没有难度分级，无法计入能力上限`)
      continue
    }
    byTier[tier] += 1
  }

  const dimensions = BENCHMARK_DIMENSIONS.map((dimension) => ({
    id: dimension.id,
    label: dimension.label,
    taskIds: tasks
      .filter((task) => (task.tags ?? []).some((tag) => dimension.tags.includes(tag)))
      .map((task) => task.id),
  }))
  const blindSpots = dimensions.filter((entry) => entry.taskIds.length === 0).map((entry) => entry.label)
  if (blindSpots.length > 0) {
    warnings.push(`题库在「${blindSpots.join('」「')}」上没有任务，这些能力测不出来`)
  }

  const covered = BENCHMARK_TIERS.filter((tier) => byTier[tier] > 0)
  const ceilingTier = covered.length > 0 ? covered[covered.length - 1]! : null
  if (ceilingTier && ceilingTier !== 'L3') {
    warnings.push(`题库最高只到 ${ceilingTier}，没有 L3 开放任务，测不出能力上限`)
  }
  if (tasks.length > 0 && tasks.length < 6) {
    warnings.push(`只有 ${tasks.length} 组任务，低于下结论所需的最小样本量`)
  }
  return { version, tasks: tasks.length, byTier, ceilingTier, dimensions, blindSpots, warnings }
}

export interface TierOutcome {
  tier: BenchmarkTier
  /** Tasks at this tier that actually ran. */
  tasks: number
  runs: number
  passed: number
  passRate: number
  /**
   * Samples that both passed and failed among their attempts. A flaky sample
   * counts as unfinished, so it is not coverage — it is noise that would make a
   * single run look like a pass.
   */
  flaky: number
}

export interface BenchmarkCeiling {
  /** One entry per tier that has tasks, ascending. */
  tiers: TierOutcome[]
  ceilingTier: BenchmarkTier | null
  /** Pass rate across every run at the hardest tier, or null when unmeasured. */
  ceilingPassRate: number | null
  /** Every run at the hardest tier passed: the suite can no longer separate profiles there. */
  saturated: boolean
  recommendations: string[]
}

/**
 * How high did the agent actually get? Computed per tier over both variants:
 * the question is "does this profile family finish the hardest tasks", not
 * "which of the two is ahead".
 */
export function assessCeiling(
  summary: SuiteSummary,
  samples: readonly BenchmarkSample[],
  tasks: readonly BenchmarkTask[],
): BenchmarkCeiling {
  const tierByTask = new Map<string, BenchmarkTier>()
  for (const task of tasks) {
    const tier = tierOf(task)
    if (tier) tierByTask.set(task.id, tier)
  }
  const tiers: TierOutcome[] = []
  for (const tier of BENCHMARK_TIERS) {
    if (summary.byTier[tier] === 0) continue
    const tierSamples = samples.filter((sample) => tierByTask.get(sample.taskId) === tier)
    const passed = tierSamples.filter((sample) => sample.ok).length
    const flaky = tierSamples.filter((sample) => sample.flaky === true).length
    tiers.push({
      tier,
      tasks: new Set(tierSamples.map((sample) => sample.taskId)).size,
      runs: tierSamples.length,
      passed,
      passRate: tierSamples.length === 0 ? 0 : Math.round((passed / tierSamples.length) * 1000) / 1000,
      flaky,
    })
  }

  const ceilingTier = tiers.length > 0 ? tiers[tiers.length - 1]! : null
  const ceilingPassRate = ceilingTier && ceilingTier.runs > 0 ? ceilingTier.passRate : null
  // Saturated only when the hardest tier passes every run *stably*: a tier with
  // flaky samples is still discriminating, it just discriminates by luck.
  const saturated = ceilingPassRate === 1 && (ceilingTier?.flaky ?? 0) === 0
  const recommendations: string[] = []
  if (!ceilingTier) {
    recommendations.push('题库没有分级任务，无法评估能力上限：先给任务补上 L0-L3 分级。')
  } else if (saturated && ceilingTier.tier === 'L3') {
    recommendations.push(
      '最难的 L3 任务在两侧全部通过：题库已饱和，当前判定「无差别」只是尺子不够长，需要升级题库。',
    )
  } else if (saturated) {
    recommendations.push(
      `最难的 ${ceilingTier.tier} 任务全部通过，而题库缺少更高层级：补 ${nextTier(ceilingTier.tier) ?? 'L3'} 任务才能继续测上限。`,
    )
  } else {
    recommendations.push(
      `最难的 ${ceilingTier.tier} 通过率 ${Math.round((ceilingPassRate ?? 0) * 100)}%，能力上限仍在题库覆盖范围内：继续用同层任务观察，暂不必加难度。`,
    )
  }
  if (ceilingTier && ceilingTier.runs > 0 && ceilingTier.tasks < 2) {
    recommendations.push(
      `最难题层只有 ${ceilingTier.tasks} 组任务，单次成败就是结论；同层至少保留 2 组不同类型任务。`,
    )
  }
  if (summary.blindSpots.length > 0) {
    recommendations.push(`「${summary.blindSpots.join('」「')}」没有任务，补齐后再相信「无差别」的结论。`)
  }
  return { tiers, ceilingTier: ceilingTier?.tier ?? null, ceilingPassRate, saturated, recommendations }
}

export interface SuiteUpgrade {
  fromVersion: number
  /** Equal to `fromVersion` when nothing needs to change. */
  toVersion: number
  reason: string
  /** Next revision must cover this tier, if one is missing entirely. */
  addTier: BenchmarkTier | null
  /** Concrete probes the next revision should add. */
  addProbes: string[]
  /** Tasks the next revision must keep running so a gain is not an easier exam. */
  keepForRegression: string[]
}

/**
 * Turn a saturated ceiling into an actionable next revision. Task ids are not
 * invented here — a revision only exists once someone writes and validates the
 * fixture, this only states what it has to contain.
 */
export function planSuiteUpgrade(
  summary: SuiteSummary,
  ceiling: BenchmarkCeiling,
  tasks: readonly BenchmarkTask[] = [],
): SuiteUpgrade {
  const addTier = !ceiling.ceilingTier
    ? 'L1'
    : ceiling.saturated
      ? nextTier(ceiling.ceilingTier)
      : null
  const addProbes: string[] = []
  if (ceiling.saturated && ceiling.ceilingTier === 'L3') {
    addProbes.push(
      '在同层加压而不是换层：同一 L3 任务叠加更少步数预算、更多文件、隐藏回归测试，直到它不再全部通过。',
      '把两个能力维度合成一组任务（例如开放重构 + 非法输入契约），单项都过但组合会掉分的表现才是上限。',
      '最难题层默认已重复 2 次（attempts），饱和判定要求每次重跑都通过；再加压时先把最难题层的重复次数提到 3 次。',
    )
  } else if (addTier) {
    addProbes.push(`补 ${addTier} 层任务：开放目标 + 客观检查，检查要能验证不变量而不是某一种写法。`)
  } else {
    addProbes.push('同层补任务：优先选择当前最难的层级里尚未覆盖的能力组合。')
  }
  for (const spot of summary.blindSpots) {
    addProbes.push(`覆盖「${spot}」：至少 1 组任务，检查必须是客观可判定的。`)
  }
  const needsWork = addTier !== null || summary.blindSpots.length > 0 || ceiling.saturated
  const reason = needsWork
    ? ceiling.saturated
      ? '最难题层已饱和，再加同层同类任务也不会产生区分度，必须提高难度或扩大覆盖面。'
      : '题库缺少更高层级或存在能力盲区，先补齐再判断能力上限。'
    : '最难题层仍能区分版本且无能力盲区，题库保留现状即可。'
  return {
    fromVersion: summary.version,
    toVersion: needsWork ? summary.version + 1 : summary.version,
    reason,
    addTier,
    addProbes,
    // Everything already in the suite stays: a revision that drops old tasks
    // would let a regression look like progress.
    keepForRegression: tasks.map((task) => task.id),
  }
}

/** One sentence for the review panel: how much of the ruler is still left. */
export function describeCeiling(ceiling: BenchmarkCeiling): string {
  if (!ceiling.ceilingTier || ceiling.ceilingPassRate === null) {
    return '题库能力上限：尚未测出（任务没有分级或没有跑完）。'
  }
  const percent = Math.round(ceiling.ceilingPassRate * 100)
  const flaky = ceiling.tiers[ceiling.tiers.length - 1]?.flaky ?? 0
  const stability =
    flaky > 0 ? `（其中 ${flaky} 次为重复运行中不稳定的结果，不计为通过）` : ''
  if (ceiling.saturated) {
    return `题库能力上限：最难的 ${ceiling.ceilingTier} 任务通过率 ${percent}%${stability}，题库已饱和，再比较版本需要先升级题库。`
  }
  return `题库能力上限：最难的 ${ceiling.ceilingTier} 任务通过率 ${percent}%${stability}，仍有未解决的难度空间。`
}
