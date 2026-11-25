// 动态步数预算：替代「固定 maxSteps + 撞顶前 8% 强制收尾」。
//
// 目标是让**一次发送多条任务**的运行效果不劣于把它们拆成多轮发送：
//   1. 按任务数估算预算 —— 5 条任务的 200 步必然被截断，所以起步就给足；
//   2. 有实质进展就自动延展 —— 长任务不该因为一个静态数字半途而废；
//   3. 停滞（反复做同一个动作、结果一字不差）才请模型收尾 —— 收尾的理由是
//      「没有新证据」，不是「数字到了」；
//   4. 天花板仍然存在 —— 它不是任务尺度而是防跑飞的阀门，且完全自主档
//      （shared/autonomy.ts）本身就要求「有步数上限」才允许进入。
//
// 这个文件只放纯函数：设置层、循环层、测试都取同一份判断，避免「设置里放宽了、
// 循环里还卡着」这类漂移。

/**
 * 「不限步数」时实际使用的阀门。用户把设置填 0 表示不想被数字打断，
 * 但运行仍需要一个上界来防止异常循环烧光 token。取一个远大于任何真实任务的
 * 数量，使它在实践中不构成限制，同时保留可诊断性。
 */
export const UNLIMITED_STEPS_FALLBACK = 4000

/** 预算绝对上限：即使任务再多、设置再大也不越过。 */
export const HARD_CEILING_MAX = 4000

/** 单个任务的经验消耗（含排查、修改、验证）。 */
const STEPS_PER_TASK = 55

/** 起步预算占天花板的比例：留出延展空间，而不是一上来就给满。 */
const INITIAL_RATIO = 0.6

/** 连续多少步没有新证据就判定停滞。 */
const DEFAULT_STALL_AFTER = 8

/** 一个任务项至少需要的步数：低于它就没时间做完并验证。 */
export const STEPS_PER_ITEM_FLOOR = 12

/**
 * 批量运行里「改动未验证」提醒的次数上限。
 *
 * 提醒按任务项发放（第一项改完、检查、再去改第二项时必须重新问一次，效果
 * 才等同于拆成多轮），但次数直接等于任务数的上限太贵：每次提醒都是一次
 * 额外的模型请求，而循环层在每次 write 之后都会把 checkRan 置回 false，
 * 所以任务越多、提醒越可能反复触发。超过封顶后不再追问，收尾处仍有
 * 「这次结果按未验证处理」的 warn 兜底，不会静默放过。
 */
export const MAX_VERIFICATION_REMINDERS = 5

export interface StepBudgetInput {
  /** 本轮用户原始指令，用来数独立任务条数。 */
  prompt: string
  /** 设置里的步数上限；0 表示不限。作为许可下限，不是一刀切。 */
  configured: number
  /** 只读分析：允许的步数本来就少，必须有明确收尾。 */
  analysis?: boolean
  /** 代码评审：保持固定小上限，不参与动态调优。 */
  review?: boolean
  /** 会话里已有计划条目数，作为任务量的另一个下限。 */
  planItems?: number
}

export interface StepBudget {
  /** 起步预算。到这里只有「有进展」才继续延展。 */
  initial: number
  /** 天花板：到这一步才真的停。 */
  ceiling: number
  /** 每次延展的步数。 */
  extension: number
  /** 连续无进展多少步触发收尾提醒。0 表示不做停滞判断。 */
  stallAfter: number
  /** 判定出的独立任务数（>=1）。写进运行记录，便于事后归因。 */
  taskCount: number
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low
  return Math.max(low, Math.min(high, Math.round(value)))
}

/** 去掉行首编号/项目符号，用于判断「只有编号没有内容」。 */
const LEADING_MARKER =
  /^(?:\d{1,2}\s*[、.．)）]|[(（]\s*\d{1,2}\s*[)）]|[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮]|[-*•·]\s+)/

/**
 * 数一条指令里有几个独立任务。
 *
 * 只认结构，不做语义判断：行首编号、项目符号、圈号，以及同一行里串联的
 * `1、…2、…`。识别不出就按 1 个算——宁可少算，也不要凭空把预算抬高。
 */
export function countRequestedTasks(prompt: string): number {
  const text = String(prompt ?? '')
  if (!text.trim()) return 1

  let numbered = 0
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (!LEADING_MARKER.test(line)) continue
    const rest = line.replace(LEADING_MARKER, '').trim()
    // 只有编号、没有正文的行（例如单独一行 "2、")不算一个任务。
    if (rest) numbered += 1
  }
  if (numbered >= 2) return Math.min(20, numbered)

  // 单行串联：「1、…；2、…；3、…」
  const inline = text.match(/(?:^|[\s；;，,。])\d{1,2}\s*[、.．)）]\s*\S/g)
  if (inline && inline.length >= 2) return Math.min(20, inline.length)

  return 1
}

/**
 * 把设置里的「最大步数」规范成 `[0, HARD_CEILING_MAX]`：
 *
 * - `0` 表示不限（循环里换成 `UNLIMITED_STEPS_FALLBACK` 作阀门）；
 * - 负数与非数字视为「没填」——直接夹到 0 会把 `-5` 这种误输入变成「不限」，
 *   反而更危险，所以回落 `fallback`；
 * - 超过硬天花板的值按天花板算。UI、写入路径、读取路径共用这一个判断。
 */
export function normalizeConfiguredSteps(value: unknown, fallback: number): number {
  const raw = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(raw) || raw < 0) return clamp(fallback, 0, HARD_CEILING_MAX)
  return clamp(raw, 0, HARD_CEILING_MAX)
}

/**
 * 算出本次运行可用的预算。
 *
 * 天花板取「用户设置」与「按任务量估算」的较大值，再夹到 HARD_CEILING_MAX：
 * 设置填 200、一次发 5 条任务时抬到约 305，因为 5 条任务在 200 步内必然有一次
 * 是被硬截断而不是做完；设置填 0（不限）时用阀门值，实践中不构成限制。
 */
export function planStepBudget(input: StepBudgetInput): StepBudget {
  const configuredRaw = Number(input.configured ?? 0)
  const configured =
    Number.isFinite(configuredRaw) && configuredRaw > 0
      ? clamp(configuredRaw, 4, HARD_CEILING_MAX)
      : UNLIMITED_STEPS_FALLBACK
  const planItems = clamp(input.planItems ?? 0, 0, 20)
  const taskCount = Math.max(1, clamp(countRequestedTasks(input.prompt), 1, 20), planItems)

  if (input.review === true) {
    // 评审只读、结论短，延展没有意义。
    const ceiling = Math.min(configured, 120)
    return { initial: ceiling, ceiling, extension: 0, stallAfter: 0, taskCount }
  }

  if (input.analysis === true) {
    // 只读分析故意不给大预算：搜得越久越容易把「没找到」写成结论。
    const ceiling = clamp(34 + 10 * (taskCount - 1), 34, Math.min(configured, 160))
    return { initial: Math.min(ceiling, 30), ceiling, extension: 10, stallAfter: 6, taskCount }
  }

  const byTask = 30 + STEPS_PER_TASK * taskCount
  const ceiling = clamp(Math.max(configured, byTask), 24, HARD_CEILING_MAX)
  const initial = clamp(ceiling * INITIAL_RATIO, 24, ceiling)
  return {
    initial,
    ceiling,
    extension: Math.max(8, Math.round(initial * 0.15)),
    stallAfter: DEFAULT_STALL_AFTER,
    taskCount,
  }
}

/** 一条工具结果的指纹材料。 */
export interface StepObservation {
  name: string
  /** 参数序列化后的稳定字符串。 */
  args: string
  /** 输出摘要，用于区分「同一条命令产生了不同结果」。 */
  output: string
}

export interface ProgressState {
  /** 见过的结果指纹，用来判断「这一步有没有带来新证据」。 */
  seen: Set<string>
  /** 连续无进展的步数。 */
  streak: number
  /** 已延展次数，只用于报告与诊断。 */
  extensions: number
}

export function createProgressState(): ProgressState {
  return { seen: new Set<string>(), streak: 0, extensions: 0 }
}

/** 指纹集合上限：只用于判重，不需要记住整段历史。 */
const MAX_SEEN = 500

function hashText(text: string): string {
  let hash = 5381
  const limit = Math.min(text.length, 4096)
  for (let index = 0; index < limit; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0
  }
  return (hash >>> 0).toString(36)
}

export function observationSignature(observation: StepObservation): string {
  return `${observation.name}|${hashText(observation.args)}|${hashText(observation.output)}`
}

export interface StepProgressResult {
  /** 本步是否带来了至少一条没见过的结果。 */
  progress: boolean
  /** 更新后的连续停滞步数。 */
  streak: number
  /** 本步新增指纹条数。 */
  fresh: number
}

/**
 * 记录一步的观察结果。
 *
 * 判据刻意保守：只要有一条结果没见过就算有进展。失败调用也会产生不同输出
 * （错误文本、退出码），所以「换个方式再试」不会被误判成停滞；真正被判停滞的
 * 是「反复读同一个文件、反复跑同一条命令、结果一字不差」——那正是拆分时用户
 * 会自己打断并换一轮的那种空转。
 */
export function noteStepObservations(
  state: ProgressState,
  observations: StepObservation[],
): StepProgressResult {
  let fresh = 0
  for (const observation of observations) {
    const signature = observationSignature(observation)
    if (state.seen.has(signature)) continue
    fresh += 1
    if (state.seen.size < MAX_SEEN) state.seen.add(signature)
  }
  state.streak = fresh > 0 ? 0 : state.streak + 1
  return { progress: fresh > 0, streak: state.streak, fresh }
}

/** 还能不能延展：天花板没到、且本步有进展。 */
export function canExtend(state: ProgressState, budget: StepBudget, currentLimit: number): boolean {
  if (budget.extension <= 0) return false
  if (currentLimit >= budget.ceiling) return false
  return state.streak === 0
}

/** 延展后的新上限，永远不超过天花板。 */
export function extendLimit(currentLimit: number, budget: StepBudget): number {
  if (budget.extension <= 0) return currentLimit
  return Math.min(budget.ceiling, currentLimit + budget.extension)
}

/** 是否该请模型收尾：连续停滞达到阈值。 */
export function shouldStallCloseOut(state: ProgressState, budget: StepBudget): boolean {
  if (budget.stallAfter <= 0) return false
  return state.streak >= budget.stallAfter
}

/**
 * 批量任务是否已经出现「一项吃光预算」的兆头。
 *
 * 拆成多轮发送时，每一项都有自己的预算：第一项做得再久，第二项也不会因此
 * 一步都不剩。单轮批量没有这个天然隔离，所以这里用同一个尺度补上——按未完成
 * 项数均分天花板，剩下的步数已经不够每项做完并验证时，提前请模型交代轮转，
 * 而不是等到天花板前才发现后几项从没开始。
 *
 * 只要还有两步及以上的未完成项才判断：只剩一项时不存在可轮转的对象，
 * 让它把这一项做完才是正确的。步数按 ceiling 而不是当前许可计算，避免
 * 「还能延展」时被误报。
 */
export function needsItemRotation(input: { openItems: number; stepsLeft: number }): boolean {
  const openItems = Number(input.openItems ?? 0)
  if (!Number.isFinite(openItems) || openItems < 2) return false
  const stepsLeft = Number(input.stepsLeft ?? 0)
  if (!Number.isFinite(stepsLeft) || stepsLeft <= 0) return false
  return stepsLeft < openItems * STEPS_PER_ITEM_FLOOR
}
