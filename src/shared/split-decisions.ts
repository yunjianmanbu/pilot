/**
 * 拆分决策事实源：自检、内视、反思、自主优化共用同一份「已经决定过什么」。
 *
 * 背景：只看行数就给「按职责把大文件拆成小文件」的建议是主观的。同一个文件
 * 该不该拆，取决于里面有没有能切开、且切开后各自读得懂的边界，以及拆完之后
 * 定位和修改是不是真的更快——这些都由 `pilot/scripts/split-candidates.mjs`
 * 的判据码量化，已经在仓库里做过决定的目标记录在这里。
 *
 * 三条约束（自检与进化输入都必须遵守）：
 * 1. 这里记录过的文件不再被建议拆分/合并，除非有人给出新证据并明确推翻某一条。
 * 2. 行数超过阈值只说明「需要量化一次」，不说明「该拆」。
 * 3. 每条决策都必须带判据与证据出处，出处要能被别人重新跑一遍核对。
 */

/** `pilot/scripts/split-candidates.mjs` 的判据码。 */
export type SplitVerdictCode = 'DATA' | 'SMALL' | 'METHOD' | 'DOMAIN' | 'SHARED' | 'REVIEW'

/** 决策结果：已拆 / 决定不拆 / 暂缓（看过但没有结论）。 */
export type SplitDecisionKind = 'split' | 'keep' | 'defer'

export interface SplitDecision {
  /**
   * 相对「自检源码根」的路径，`/` 分隔——与 `ModuleFileFact.path` 同一坐标系。
   * 开发态根是 `pilot/pilot`，安装版是 `userData/self-src`，两边都从 `src/` 开始。
   */
  path: string
  kind: SplitDecisionKind
  /** 判据码；没跑过 `split-candidates.mjs` 的手工决策不写。 */
  rule?: SplitVerdictCode
  /** 一句话说明为什么这样决定。 */
  reason: string
  /** 证据出处：命令、验收结果、文档章节。可被第三方重跑核对。 */
  evidence: string[]
  /** 决策日期（`YYYY-MM-DD`）；历史记录里没留下日期的条目不写。 */
  decidedAt?: string
}

/** 判据码的含义与「是否支持拆分」。自检的建议文本直接引用这里，不再各写一套。 */
export const SPLIT_VERDICTS: Record<
  SplitVerdictCode,
  { split: boolean; zh: string; en: string }
> = {
  DATA: {
    split: false,
    zh: 'locale / 清单 / 字面量表：行数来自内容而不是逻辑，拆了只会制造跨文件跳转',
    en: 'locale / manifest / literal tables: lines come from data, not logic; splitting only adds cross-file hops',
  },
  SMALL: {
    split: false,
    zh: '未到阈值：除定位明显困难外不拆',
    en: 'below the threshold: do not split unless locating code is clearly painful',
  },
  METHOD: {
    split: true,
    zh: '有巨型函数且体内存在可独立搬走的段落：按阶段抽',
    en: 'giant function with independently movable stages: extract by stage',
  },
  DOMAIN: {
    split: true,
    zh: '多个彼此不引用的大型顶层声明：按域拆',
    en: 'several large top-level declarations that do not reference each other: split by domain',
  },
  SHARED: {
    split: false,
    zh: '主要是同一类的成员、读写同一份私有状态：只适合抽纯函数段，整块拆会把耦合搬得更乱',
    en: 'mostly members of one class sharing private state: only pure fragments are extractable; moving the block just relocates the coupling',
  },
  REVIEW: {
    split: false,
    zh: '行数超限但没有可见边界：先读一遍再决定，不要按行数切',
    en: 'over the line budget but no visible seam: read it first, never cut by line count',
  },
}

/**
 * 已记录的拆分决策。
 *
 * 全部来自 `pilot/docs/source-split-playbook.md` 第 5 节的实测记录：每条都有
 * `verify-split` 的匹配数或判据码作为证据。新增条目走同一条路径——先跑脚本，
 * 再记录，不要凭印象补。
 *
 * `rule` 写最近一次 `--scan` 算出的判据码，`kind` 写人的决定：判据码说「有没有
 * 可切的边界」，`kind` 说「切了是否真的更快」。两者不一致是正常的，理由写在
 * `reason` 里——这正是自检不再按行数给建议的依据。
 */
export const SPLIT_DECISIONS: readonly SplitDecision[] = [
  {
    path: 'src/main/agent/evolution.ts',
    kind: 'split',
    rule: 'METHOD',
    reason:
      '纯函数段已搬到 agent/evolution-policy.ts（1355 → 1288 行）；当前判据 METHOD（EvolutionService=1279）说明剩下的仍是策略编排，停在已抽出的边界。',
    evidence: [
      'docs/source-split-playbook.md 第 5 节',
      'verify-split --mode=move：38 个顶层声明全中（missing=0 changed=0）',
      'split-candidates.mjs --scan（2026-11-23）：METHOD',
    ],
  },
  {
    path: 'src/main/agent/loop.ts',
    kind: 'keep',
    rule: 'METHOD',
    reason:
      '契约类型已拆到 agent/loop/types.ts；剩下的 runAgentLoop=1240 是执行序列本身，判据给 METHOD 但抽段要跨 7 处外层可变状态，除非出现清晰阶段边界否则不动。',
    evidence: [
      'docs/source-split-playbook.md 第 5 节结尾（App.tsx 与 loop.ts 的处置）',
      'split-candidates.mjs --scan（2026-11-23）：METHOD，runAgentLoop=1240',
    ],
  },
  {
    path: 'src/main/store.ts',
    kind: 'split',
    rule: 'SHARED',
    reason:
      '设置字段的更新规则已抽成 src/main/settings-update.ts；当前判据 SHARED（Store=2630 一个类读写同一份私有状态），不再整块拆。',
    evidence: [
      'docs/source-split-playbook.md 第 5 节',
      'verify-split --mode=move：全部声明逐字匹配',
      'split-candidates.mjs --scan（2026-11-23）：SHARED',
    ],
  },
  {
    path: 'src/main/agent/runner.ts',
    kind: 'keep',
    rule: 'METHOD',
    reason:
      '已抽出 permission-policy.ts 与 self-update-bridge.ts；判据给 METHOD（AgentRunner=2405 有可抽段），但剩下的 execute 里 ToolHost 段写 7 处外层可变状态，整块搬走只会把代码挪乱，因此停在已抽出的两段。',
    evidence: [
      'docs/source-split-playbook.md 第 5 节',
      'verify-split --mode=fragment budget=40：dropped=0 inserted=6 OK',
      'split-candidates.mjs --scan（2026-11-23）：METHOD，AgentRunner=2405',
    ],
  },
  {
    path: 'src/main/personal.ts',
    kind: 'split',
    rule: 'METHOD',
    reason:
      'tree / merge / fs-utils / baseline 已拆成 main/personal/（1791 → 1136 行）；判据给 METHOD 指的是 planUpgrade=132 这类段，可读性已够，不再继续切。',
    evidence: [
      'docs/source-split-playbook.md 第 5 节',
      'verify-split --mode=move：74/74 matched，missing=0 changed=0',
      'split-candidates.mjs --scan（2026-11-23）：METHOD',
    ],
  },
  {
    path: 'src/renderer/src/components/ChatView.tsx',
    kind: 'split',
    reason: '已拆成 components/chat/{composer,composer-state,panels,message-rows,approval,plan}（2448 → 662 行）。',
    evidence: [
      'docs/source-split-playbook.md 第 5 节',
      'verify-split --mode=move：34/34 matched；两份 tsc 与 electron-vite build 通过',
    ],
  },
  {
    path: 'src/renderer/src/components/EvolutionPanel.tsx',
    kind: 'keep',
    rule: 'METHOD',
    reason:
      '已拆出 components/evolution/{shared,cards}；剩下的 1842 行是一个 39 props 的面板 + 968 行 JSX，再切只能把局部 state 通过 props 往下透传。',
    evidence: [
      'docs/source-split-playbook.md 第 5 节',
      'verify-split --mode=move：19/19 matched；profile-benchmark-render 5 passed',
    ],
  },
  {
    path: 'src/renderer/src/components/SettingsDialog.tsx',
    kind: 'keep',
    rule: 'METHOD',
    reason:
      '判据给 METHOD（SettingsDialog=1690 有可抽段），但 61 个 useState 全在本组件里：8 个 section 各读写 4–21 个 state、2–19 个 setter，抽出去要透传几十个 props，拆分只把耦合搬走。',
    evidence: [
      'docs/source-split-playbook.md 第 5 节`SettingsDialog.tsx`（1859）一行',
      'split-candidates.mjs --scan（2026-11-23）：METHOD，SettingsDialog=1690',
    ],
  },
]

/**
 * 一次 `split-candidates.mjs --scan` 的实测判据。
 *
 * 它只陈述脚本算出来的边界（`verdict`）和判据指向的成员（`signature`），不含
 * 「要不要拆」的决定——决定在 `SPLIT_DECISIONS` 里。两者分开的好处：自检、内视、
 * 反思都能说清「这个文件量到什么」和「人定了什么」，不会再退化成按行数猜。
 */
export interface SplitScanFact {
  /** 相对自检源码根的路径，坐标系与 `SplitDecision.path` 相同。 */
  path: string
  lines: number
  verdict: SplitVerdictCode
  /** 判据指向的具体成员（`名字=行数`），用来复核判据码是否合理。 */
  signature: string
}

/** `SPLIT_SCAN` 的实测日期，重跑 `--scan` 后必须一起更新。 */
export const SPLIT_SCAN_AT = '2026-11-23'

/**
 * 2026-11-23 在仓库根执行 `node pilot/scripts/split-candidates.mjs --scan --json`
 * 的结果（`pilot/pilot/src` 下 >=800 行的 23 个文件）。重跑后才更新，不要凭印象改。
 */
export const SPLIT_SCAN: readonly SplitScanFact[] = [
  { path: 'src/renderer/src/App.tsx', lines: 3370, verdict: 'METHOD', signature: 'App=3034 ReviewBanner=60' },
  { path: 'src/shared/types.ts', lines: 2907, verdict: 'DOMAIN', signature: 'PilotBridge=452 SettingsView=154' },
  { path: 'src/main/agent/runner.ts', lines: 2840, verdict: 'METHOD', signature: 'AgentRunner=2405 toStoredMessages=39' },
  { path: 'src/main/store.ts', lines: 2711, verdict: 'SHARED', signature: 'Store=2630' },
  { path: 'src/renderer/src/locale-en.ts', lines: 2457, verdict: 'DATA', signature: 'en=2450' },
  { path: 'src/main/checkpoints.ts', lines: 1983, verdict: 'METHOD', signature: 'CheckpointService=1642 WorkspaceState=28' },
  {
    path: 'src/renderer/src/components/SettingsDialog.tsx',
    lines: 1890,
    verdict: 'METHOD',
    signature: 'SettingsDialog=1690 Toggle=29',
  },
  {
    path: 'src/renderer/src/components/EvolutionPanel.tsx',
    lines: 1843,
    verdict: 'METHOD',
    signature: 'EvolutionPanel=1792',
  },
  { path: 'src/main/store-schema.ts', lines: 1800, verdict: 'DATA', signature: 'sanitize=357 sanitizeSession=142' },
  {
    path: 'src/main/agent/evolution.ts',
    lines: 1533,
    verdict: 'METHOD',
    signature: 'EvolutionService=1279 META_OPTIMIZER_SYSTEM=27',
  },
  { path: 'src/main/agent/loop.ts', lines: 1483, verdict: 'METHOD', signature: 'runAgentLoop=1240 toolMessage=26' },
  { path: 'src/main/agent/toolsmith.ts', lines: 1436, verdict: 'SHARED', signature: 'DynamicToolRegistry=841 runChild=72' },
  {
    path: 'src/renderer/src/components/SessionResourcesPanel.tsx',
    lines: 1422,
    verdict: 'METHOD',
    signature: 'SessionResourcesPanel=1210 FilePreviewPane=91',
  },
  {
    path: 'src/renderer/src/components/PluginsPanel.tsx',
    lines: 1306,
    verdict: 'METHOD',
    signature: 'PluginsPanel=1061 DraftCard=119',
  },
  { path: 'src/main/updater.ts', lines: 1163, verdict: 'METHOD', signature: 'UpdaterService=984 installedForAllUsers=16' },
  {
    path: 'src/main/personal.ts',
    lines: 1147,
    verdict: 'METHOD',
    signature: 'PersonalEvolutionService=891 runCommand=30',
  },
  { path: 'src/main/plugins/runtime.ts', lines: 1022, verdict: 'SHARED', signature: 'PluginHost=803 PluginHostOptions=21' },
  { path: 'src/shared/module-check.ts', lines: 992, verdict: 'METHOD', signature: 'evaluateModule=252 sanitizeReport=59' },
  { path: 'src/main/agent/permissions.ts', lines: 975, verdict: 'METHOD', signature: 'evaluatePermission=165 modeVerdict=85' },
  {
    path: 'src/main/agent/profile-benchmark.ts',
    lines: 931,
    verdict: 'METHOD',
    signature: 'ProfileBenchmark=212 compareBenchmark=200',
  },
  { path: 'src/main/companion/server.ts', lines: 871, verdict: 'SHARED', signature: 'CompanionServer=658' },
  { path: 'src/main/self-source-git.ts', lines: 849, verdict: 'METHOD', signature: 'resolveSelfSource=128 syncSelfSource=113' },
  { path: 'src/main/plugins/studio.ts', lines: 816, verdict: 'SHARED', signature: 'pluginOverview=90 installPlugin=60' },
]

/** 路径 → 实测判据。 */
export function splitScanIndex(facts: readonly SplitScanFact[] = SPLIT_SCAN): Map<string, SplitScanFact> {
  const index = new Map<string, SplitScanFact>()
  for (const fact of facts) {
    const key = normalizeSplitPath(fact.path)
    if (!index.has(key)) index.set(key, fact)
  }
  return index
}

/** 判据码分布：只列出现过的码，自检与反思用它说明「量到了什么」。 */
export function splitScanCounts(
  facts: readonly SplitScanFact[] = SPLIT_SCAN,
): { code: SplitVerdictCode; count: number }[] {
  const counts = new Map<SplitVerdictCode, number>()
  for (const fact of facts) counts.set(fact.verdict, (counts.get(fact.verdict) ?? 0) + 1)
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([code, count]) => ({ code, count }))
}

/**
 * 拆分相关的硬约束。自检的建议、改造指令、反思提示词都原样引用这几条，
 * 不再各自改写措辞——同一件事在不同入口说法不一致，用户就会看到互相矛盾的建议。
 */
export const SPLIT_CONSTRAINTS: readonly string[] = [
  '行数不是拆分理由：800 行只是「需要量化一次」的阈值，不是「该拆」的结论。',
  '拆不拆看 split-candidates.mjs 的判据码：DATA / SHARED / REVIEW 不拆，DOMAIN / METHOD 且能说明拆分后定位或修改更快才拆。',
  '已记录在 src/shared/split-decisions.ts 的决策不得推翻；要推翻必须给出新证据，并写明推翻的是哪一条。',
  '拆完必须用 verify-split.mjs 证明没丢逻辑，再跑两份 tsc、受影响的测试与 electron-vite build。',
]

export const SPLIT_CONSTRAINTS_EN: readonly string[] = [
  'Line count is not a reason to split: 800 lines means "measure once", not "split".',
  'Decide with split-candidates.mjs verdicts: DATA / SHARED / REVIEW do not split; only DOMAIN / METHOD with a concrete argument that splitting makes locating or editing faster.',
  'Decisions recorded in src/shared/split-decisions.ts must not be overturned; overturning one requires new evidence and naming the decision it replaces.',
  'After a split, prove nothing was lost with verify-split.mjs, then run both tsc projects, the affected tests and electron-vite build.',
]

export function splitConstraints(english: boolean): readonly string[] {
  return english ? SPLIT_CONSTRAINTS_EN : SPLIT_CONSTRAINTS
}

/** 统一路径写法：去掉 `./`、反斜杠，便于和扫描结果比较。 */
export function normalizeSplitPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '')
}

/** 决策索引：同一路径只保留第一条（列表按优先级从上到下）。 */
export function splitDecisionIndex(
  decisions: readonly SplitDecision[] = SPLIT_DECISIONS,
): Map<string, SplitDecision> {
  const index = new Map<string, SplitDecision>()
  for (const decision of decisions) {
    const key = normalizeSplitPath(decision.path)
    if (!index.has(key)) index.set(key, decision)
  }
  return index
}

export function splitDecisionKindLabel(kind: SplitDecisionKind, english = false): string {
  switch (kind) {
    case 'split':
      return english ? 'split' : '已拆分'
    case 'keep':
      return english ? 'kept as is' : '决定不拆'
    case 'defer':
      return english ? 'deferred' : '暂缓'
    default:
      return kind
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

/** 磁盘上的数据不可信：形状不对就丢掉整条，不抛错。 */
export function sanitizeSplitDecisions(value: unknown): SplitDecision[] {
  if (!Array.isArray(value)) return []
  const out: SplitDecision[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const path = asString(record['path'])
    const reason = asString(record['reason'])
    const kind = asString(record['kind'])
    if (!path || !reason) continue
    if (kind !== 'split' && kind !== 'keep' && kind !== 'defer') continue
    const decision: SplitDecision = {
      path: normalizeSplitPath(path),
      kind,
      reason,
      evidence: Array.isArray(record['evidence'])
        ? record['evidence'].filter((entry): entry is string => typeof entry === 'string').slice(0, 8)
        : [],
    }
    const rule = asString(record['rule'])
    if (rule && rule in SPLIT_VERDICTS) decision.rule = rule as SplitVerdictCode
    const decidedAt = asString(record['decidedAt'])
    if (decidedAt) decision.decidedAt = decidedAt
    out.push(decision)
  }
  return out.slice(0, 200)
}
