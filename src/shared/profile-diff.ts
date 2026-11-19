import type { ProfileExplanation, ProfileStrategy } from './types'

/**
 * Deterministic "before vs after" view of an operating-profile change.
 *
 * The plain-language explanation is written by a model, but the list of rules
 * that were added, kept, rewritten or dropped must not be: a user has to be
 * able to check it against the two texts without trusting a summary.
 */

export interface RuleRewrite {
  before: string
  after: string
}

export interface AddendumDiff {
  added: string[]
  removed: string[]
  changed: RuleRewrite[]
  kept: string[]
  /** True when both sides contain the same rules in the same order. */
  unchanged: boolean
}

export interface StrategyChange {
  field: 'maxSteps' | 'temperature'
  /** Short label for the row, e.g. "单次任务的操作步数上限". */
  label: string
  /** What this setting means, for a reader who has never seen the term. */
  plain: string
  from: string
  to: string
}

const RULE_MARKER = /^\s*(?:\d{1,2}[.)、]|[-*•])\s+/
/** A numbered marker that starts another rule inside the same line. */
const INLINE_MARKER = /(?=(?:^|\s)\d{1,2}[.)、]\s)/

function stripMarker(line: string): string {
  return line.replace(RULE_MARKER, '').trim()
}

/** Split an addendum into individual rules. Order is preserved. */
export function splitRules(text: string): string[] {
  const cleaned = (text ?? '').replace(/\r\n/g, '\n').trim()
  if (!cleaned) return []
  const parts = cleaned
    .split(/\n+/)
    .flatMap((line) => line.split(INLINE_MARKER))
    .map(stripMarker)
    .filter((line) => line.length > 0)
  const seen = new Set<string>()
  const rules: string[] = []
  for (const rule of parts) {
    const key = normalize(rule)
    if (seen.has(key)) continue
    seen.add(key)
    rules.push(rule)
  }
  return rules
}

/** Lowercase, drop punctuation and collapse whitespace, for comparison only. */
export function normalize(rule: string): string {
  return rule
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。；、,.;:：!！?？()（）\[\]【】"'“”‘’`]/g, '')
}

/**
 * Rules that protect the harness rather than the task. Even a reviewer that
 * supplies a reason may not delete these: a model-reviewed prompt must never
 * be able to remove the safety, credential, approval, evidence or verification
 * boundary that the rest of the system relies on.
 */
const PROTECTED_RULE_PATTERN =
  /(安全|审批|批准|凭据|密码|密钥|令牌|权限|沙箱|证据|验证|校验|测试|secret|credential|password|token|api.?key|approval|permission|sandbox|safety|verify|verification|evidence|test)/i

export function isProtectedRule(rule: string): boolean {
  return PROTECTED_RULE_PATTERN.test(rule)
}

function bigrams(text: string): Set<string> {
  const set = new Set<string>()
  for (let i = 0; i < text.length - 1; i += 1) set.add(text.slice(i, i + 2))
  if (text.length === 1) set.add(text)
  return set
}

/** Jaccard similarity of character bigrams, 0-1. */
export function similarity(a: string, b: string): number {
  const left = normalize(a)
  const right = normalize(b)
  if (!left || !right) return 0
  if (left === right) return 1
  const one = bigrams(left)
  const two = bigrams(right)
  let shared = 0
  for (const gram of one) if (two.has(gram)) shared += 1
  const total = one.size + two.size - shared
  return total === 0 ? 0 : shared / total
}

/** Rules rewritten in place score above this; below it they are unrelated. */
const REWRITE_THRESHOLD = 0.55

export function diffAddendum(before: string, after: string): AddendumDiff {
  const oldRules = splitRules(before)
  const newRules = splitRules(after)
  const usedOld = new Set<number>()
  const kept: string[] = []
  const changed: RuleRewrite[] = []
  const added: string[] = []

  for (const rule of newRules) {
    let best = -1
    let bestScore = 0
    oldRules.forEach((candidate, index) => {
      if (usedOld.has(index)) return
      if (normalize(candidate) === normalize(rule)) {
        best = index
        bestScore = 1
        return
      }
      const score = similarity(candidate, rule)
      if (score > bestScore) {
        best = index
        bestScore = score
      }
    })
    if (best >= 0 && bestScore >= REWRITE_THRESHOLD) {
      usedOld.add(best)
      if (bestScore === 1) kept.push(rule)
      else changed.push({ before: oldRules[best]!, after: rule })
      continue
    }
    added.push(rule)
  }

  const removed = oldRules.filter((_, index) => !usedOld.has(index))
  return {
    added,
    removed,
    changed,
    kept,
    unchanged: added.length === 0 && removed.length === 0 && changed.length === 0,
  }
}

function formatStrategyValue(value: number | undefined, unit: string): string {
  return typeof value === 'number' ? `${value}${unit}` : '默认'
}

/**
 * Settings changes expressed the way the user experiences them. Only fields
 * that actually differ are returned.
 */
export function describeStrategyChanges(
  before: ProfileStrategy | undefined,
  after: ProfileStrategy | undefined,
): StrategyChange[] {
  const changes: StrategyChange[] = []
  if ((before?.maxSteps ?? null) !== (after?.maxSteps ?? null)) {
    changes.push({
      field: 'maxSteps',
      label: '单次任务的操作步数上限',
      plain: '一次任务里 Pilot 最多能做多少步操作。调高能啃更复杂的任务，也更容易绕远路、花掉更多用量。',
      from: formatStrategyValue(before?.maxSteps, ''),
      to: formatStrategyValue(after?.maxSteps, ''),
    })
  }
  const beforeTemperature = typeof before?.temperature === 'number' ? before.temperature : undefined
  const afterTemperature = typeof after?.temperature === 'number' ? after.temperature : undefined
  if (beforeTemperature !== afterTemperature) {
    changes.push({
      field: 'temperature',
      label: '作答的随机性',
      plain: '越低越按套路来、结果稳定；越高越发散、偶尔有意外的好点子，也更容易跑偏。',
      from: formatStrategyValue(beforeTemperature, ''),
      to: formatStrategyValue(afterTemperature, ''),
    })
  }
  return changes
}

function shorten(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

/**
 * Mechanical summary used when the explanation model is unavailable or its
 * answer is unusable. It is honest about being automatic and never recommends
 * enabling a change it could not explain.
 */
export function fallbackExplanation(
  input: {
    rationale?: string
    evidence?: { runs: number; failures: number }
    review?: { pass: boolean; independent?: boolean; risks?: string[] }
  },
  baselineVersion: number | undefined,
  diff: AddendumDiff,
  settings: StrategyChange[],
): ProfileExplanation {
  const counts = [
    diff.added.length ? `新增 ${diff.added.length} 条` : '',
    diff.changed.length ? `改写 ${diff.changed.length} 条` : '',
    diff.removed.length ? `删去 ${diff.removed.length} 条` : '',
    settings.length ? `调整 ${settings.length} 项设置` : '',
  ].filter(Boolean)
  const changes = [
    ...diff.added.map((rule) => `新增：${shorten(rule, 120)}`),
    ...diff.changed.map((entry) => `改写：${shorten(entry.after, 120)}`),
    ...diff.removed.map((rule) => `删去：${shorten(rule, 120)}`),
    ...settings.map((entry) => `${entry.label}：${entry.from} → ${entry.to}`),
  ].slice(0, 8)
  const risks = (input.review?.risks ?? []).slice(0, 4)
  const scopeText = baselineVersion ? `相对正在使用的 v${baselineVersion}` : '相对 Pilot 的初始设置'
  return {
    headline: counts.length
      ? `这次改动${counts.join('、')}（${scopeText}）`
      : `这次改动没有改变任何规则（${scopeText}）`,
    changes,
    impact:
      input.review?.pass === true
        ? '这些规则是在真实任务记录的基础上提出的，检查认为可以使用。'
        : '还没有通过检查，是否真的有用目前没有证据。',
    risks: risks.length
      ? risks
      : ['这段是从原文直接摘出的自动摘要，没有做过通俗解释，可能不够准确，建议看下方的原文或点「重新解释」。'],
    recommend: 'observe',
    reason: '缺少通俗解释时，先保持现在的版本更安全；可以让 Pilot 重新解释后再决定。',
    at: new Date().toISOString(),
  }
}
