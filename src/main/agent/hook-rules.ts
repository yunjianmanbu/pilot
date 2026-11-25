// 声明式 hook 规则：`.pilot/hooks/<name>.md`，YAML frontmatter + 正文说明。
//
// 为什么在 hooks.json 之外再加一层：hooks.json 里的 hook 是「命令 + argv」，
// 要写清楚一条规则得懂命令怎么跑；而常见规则（「别在源码里留 console.log」、
// 「rm -rf 前拦一下」「改完测试文件记得跑测试」）本质是一句话 + 一个正则。
// 规则文件让模型和用户都能直接写，读起来是文档，执行时是校验。
//
// frontmatter 支持的键（小写）：
//   name:     规则名，默认取文件名
//   enabled:  true/false，默认 true
//   event:    file | bash | tool | stop（缺省 tool）
//   pattern:  正则，匹配对象由 event 决定
//   action:   warn（默认）| block
// 正文是给模型的说明：命中时原样作为提示语；为空时用 pattern 组合出一句。
//
// 边界：规则只做「提示 / 阻断」，不能执行命令，也不能放宽权限；block 只影响
// 被匹配的那一次工具调用，绝不改写权限层与沙箱判定。
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  HOOK_RULE_MAX_MESSAGE_CHARS,
  HOOK_RULE_MAX_PATTERN_CHARS,
  HOOK_RULE_MAX_RULES,
  type HookRuleAction,
  type HookRuleEvent,
  type HookRuleView,
} from '../../shared/hook-rules'
import { parseSkillMarkdown } from './skills'

export type { HookRuleAction, HookRuleEvent, HookRuleView }

export interface HookRule extends HookRuleView {}

export interface HookRuleEvaluation {
  /** Messages for warn rules that matched. */
  warnings: string[]
  /** Message of the first block rule that matched, if any. */
  blocked: string | null
  /** Rule names that matched, for the run log. */
  matched: string[]
}

export interface BrokenHookRule {
  source: string
  reason: string
}

export const EMPTY_EVALUATION: HookRuleEvaluation = { warnings: [], blocked: null, matched: [] }

const MAX_RULES = HOOK_RULE_MAX_RULES
const MAX_PATTERN_CHARS = HOOK_RULE_MAX_PATTERN_CHARS
const MAX_MESSAGE_CHARS = HOOK_RULE_MAX_MESSAGE_CHARS
const EVENTS = new Set<HookRuleEvent>(['file', 'bash', 'tool', 'stop'])
const RULE_FILE = /\.md$/i
const RULE_DIR = '.pilot/hooks'

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  const lower = value.trim().toLowerCase()
  if (['false', 'no', 'off', '0', 'disabled'].includes(lower)) return false
  if (['true', 'yes', 'on', '1', 'enabled'].includes(lower)) return true
  return fallback
}

/**
 * Turn one rule file into a rule, or null when it is unusable.
 *
 * A disabled rule still parses: settings has to list it so the user can turn it
 * back on, and `evaluateHookRules` skips it while `enabled` is false.
 */
export function parseHookRule(text: string, source: string): HookRule | null {
  const { meta, body } = parseSkillMarkdown(text)
  const pattern = (meta['pattern'] ?? '').trim()
  if (!pattern || pattern.length > MAX_PATTERN_CHARS) return null
  // 编译不了的正则直接丢弃：一条坏规则不该让整轮运行失败。
  try {
    new RegExp(pattern, 'i')
  } catch {
    return null
  }
  const declaredEvent = (meta['event'] ?? 'tool').trim().toLowerCase() as HookRuleEvent
  const event = EVENTS.has(declaredEvent) ? declaredEvent : 'tool'
  const action: HookRuleAction =
    (meta['action'] ?? 'warn').trim().toLowerCase() === 'block' ? 'block' : 'warn'
  const fallbackName = source.split('/').pop()?.replace(RULE_FILE, '') ?? 'rule'
  const name = (meta['name'] ?? fallbackName).trim().slice(0, 64) || fallbackName
  const message = (body.trim() || `${name}: matched /${pattern}/`).slice(0, MAX_MESSAGE_CHARS)
  return { name, event, pattern, action, message, source, enabled: parseBoolean(meta['enabled'], true) }
}

/**
 * Read every `*.md` under `.pilot/hooks/`. A missing directory is normal (no
 * rules), and one broken file never hides the others — the reason is reported
 * so settings can show why a rule the user wrote is not in effect.
 */
export async function loadHookRulesDetailed(
  root: string,
): Promise<{ rules: HookRule[]; broken: BrokenHookRule[] }> {
  let entries
  try {
    entries = await readdir(join(root, '.pilot', 'hooks'), { withFileTypes: true })
  } catch {
    return { rules: [], broken: [] }
  }
  const rules: HookRule[] = []
  const broken: BrokenHookRule[] = []
  for (const entry of entries.slice(0, MAX_RULES)) {
    if (!entry.isFile() || !RULE_FILE.test(entry.name)) continue
    const source = `${RULE_DIR}/${entry.name}`
    try {
      const text = await readFile(join(root, '.pilot', 'hooks', entry.name), 'utf8')
      const rule = parseHookRule(text, source)
      if (rule) rules.push(rule)
      else broken.push({ source, reason: '缺少可用的 pattern，或正则无法编译' })
    } catch (error) {
      broken.push({
        source,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return { rules, broken }
}

/** Rules only; broken files are dropped. */
export async function loadHookRules(root: string): Promise<HookRule[]> {
  return (await loadHookRulesDetailed(root)).rules
}

/**
 * Evaluate the rules for one event. `subject` is the text the pattern is
 * matched against: the command line for `bash`, the path plus content for
 * `file`, the tool name plus arguments for `tool`, the final message for `stop`.
 */
export function evaluateHookRules(
  rules: readonly HookRule[],
  event: HookRuleEvent,
  subject: string,
): HookRuleEvaluation {
  const warnings: string[] = []
  const matched: string[] = []
  let blocked: string | null = null
  if (rules.length === 0 || !subject) return { ...EMPTY_EVALUATION, warnings, matched }
  for (const rule of rules) {
    if (rule.event !== event || !rule.enabled) continue
    let hit = false
    try {
      hit = new RegExp(rule.pattern, 'i').test(subject)
    } catch {
      hit = false
    }
    if (!hit) continue
    matched.push(rule.name)
    if (rule.action === 'block') {
      if (blocked === null) blocked = rule.message
      continue
    }
    warnings.push(rule.message)
  }
  return { warnings, blocked, matched }
}

/** Absolute path of a rule file, or null when `source` is not one of ours. */
function ruleFile(root: string, source: string): string | null {
  const name = source.split('/').pop() ?? ''
  if (!source.startsWith(`${RULE_DIR}/`) || !name || name !== source.slice(RULE_DIR.length + 1)) {
    return null
  }
  if (!RULE_FILE.test(name) || name.startsWith('.')) return null
  if (/[\\:*?"<>|]/.test(name)) return null
  return join(root, '.pilot', 'hooks', name)
}

/** `true` / `false` in the frontmatter, inserted when the key is absent. */
function withEnabledFlag(text: string, enabled: boolean): string {
  const value = enabled ? 'true' : 'false'
  const source = text.replace(/^﻿/, '')
  if (!source.startsWith('---')) {
    return ['---', `enabled: ${value}`, '---', '', source.trim(), ''].join('\n')
  }
  const end = source.indexOf('\n---', 3)
  if (end === -1) return text
  const header = source.slice(3, end)
  const rest = source.slice(end)
  const line = /^[ \t]*enabled[ \t]*:.*$/im
  const nextHeader = line.test(header)
    ? header.replace(line, `enabled: ${value}`)
    : `${header.replace(/\s*$/, '')}\nenabled: ${value}`
  return `---${nextHeader}${rest}`
}

/** 开关一条规则：只改 frontmatter 的 enabled，正文与正则一字不动。 */
export async function setHookRuleEnabled(
  root: string,
  source: string,
  enabled: boolean,
): Promise<boolean> {
  const file = ruleFile(root, source)
  if (!file) return false
  try {
    const text = await readFile(file, 'utf8')
    const next = withEnabledFlag(text, enabled)
    if (next === text) return true
    await writeFile(file, next, 'utf8')
    return true
  } catch {
    return false
  }
}

/** 删掉一条规则文件。删的是工作区里的一份文档，不可恢复。 */
export async function deleteHookRule(root: string, source: string): Promise<boolean> {
  const file = ruleFile(root, source)
  if (!file) return false
  try {
    await unlink(file)
    return true
  } catch {
    return false
  }
}

function slugOf(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return slug || 'rule'
}

/**
 * 新建一条规则。文件名由规则名派生，重名时加序号，最多 `MAX_RULES` 条。
 * 返回写入后的规则，正则编译不了时返回 null（不留下坏文件）。
 */
export async function createHookRule(
  root: string,
  input: {
    name: string
    event: HookRuleEvent
    pattern: string
    action: HookRuleAction
    message: string
  },
): Promise<HookRule | null> {
  const name = input.name.trim().slice(0, 64)
  const pattern = input.pattern.trim().slice(0, MAX_PATTERN_CHARS)
  if (!name || !pattern) return null
  try {
    new RegExp(pattern, 'i')
  } catch {
    return null
  }
  const { rules } = await loadHookRulesDetailed(root)
  if (rules.length >= MAX_RULES) return null
  const dir = join(root, '.pilot', 'hooks')
  await mkdir(dir, { recursive: true })
  const base = slugOf(name)
  let fileName = `${base}.md`
  for (let index = 2; index < MAX_RULES; index += 1) {
    try {
      await readFile(join(dir, fileName), 'utf8')
      fileName = `${base}-${index}.md`
    } catch {
      break
    }
  }
  const markdown = buildHookRuleMarkdown({
    name,
    event: input.event,
    pattern,
    action: input.action,
    message: input.message,
  })
  await writeFile(join(dir, fileName), markdown, 'utf8')
  return parseHookRule(markdown, `${RULE_DIR}/${fileName}`)
}

/** Maximum length of a continuation directive; anything longer is ignored. */
export const MAX_CONTINUE_CHARS = 2_000

/**
 * Read a `CONTINUE: <instruction>` line out of stop-hook output.
 *
 * Stop hooks normally just report, but a hook that decides the task is not
 * finished can ask for one more turn: the instruction is fed back to the same
 * session as if the user had typed it. Capped and parsed, never executed.
 *
 * ```
 * CONTINUE: the plan still has two unchecked items; finish them, then run the tests.
 * ```
 */
export function extractContinueDirective(output: string | null | undefined): string | null {
  if (!output) return null
  const match = /^[ \t>*_\-]*CONTINUE:[ \t]*(.+)$/im.exec(output)
  // `**CONTINUE:** do X` and `CONTINUE: do X **` both leave markers behind; the
  // directive is fed back verbatim, so strip formatting instead of shipping it.
  const directive = match?.[1]?.trim().replace(/^[*_`\s]+/, '').replace(/[*_`\s]+$/, '')
  if (!directive) return null
  return directive.length > MAX_CONTINUE_CHARS ? directive.slice(0, MAX_CONTINUE_CHARS) : directive
}

/** Render a rule file: used by tests, the settings panel and `createHookRule`. */
export function buildHookRuleMarkdown(rule: {
  name: string
  event: HookRuleEvent
  pattern: string
  action: HookRuleAction
  message: string
  enabled?: boolean
}): string {
  const lines = [
    '---',
    `name: ${rule.name}`,
    `enabled: ${rule.enabled === false ? 'false' : 'true'}`,
    `event: ${rule.event}`,
    `pattern: ${rule.pattern}`,
    `action: ${rule.action}`,
    '---',
    '',
    rule.message.trim(),
    '',
  ]
  return lines.join('\n')
}
