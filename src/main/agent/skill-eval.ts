/**
 * 技能文档的机械评测。
 *
 * 一个技能能不能被别人直接用，取决于几件可以被机器判定的事：触发条件写没写、
 * 步骤是不是可执行的、有没有验证方式、有没有给出边界。这里只做这些判定，
 * 不打「聪明度」分——模型写了技能就能立刻看到缺什么，改完再写一次即可。
 *
 * 纯函数：不读磁盘、不跑模型、不回显疑似密钥的值。
 */

import { parseSkillMarkdown } from './skills'

export type SkillCheckLevel = 'ok' | 'warn' | 'error'

export interface SkillCheck {
  id: string
  level: SkillCheckLevel
  /** 一句话结论，直接展示给写技能的人。 */
  label: string
  /** 命中位置或细节；不含疑似密钥的原文。 */
  detail?: string
}

export interface SkillEvalReport {
  /** 0-100：错误每处 -25，提示每处 -8。 */
  score: number
  verdict: 'usable' | 'needs-work'
  checks: SkillCheck[]
  /** 只需要处理 `level !== 'ok'` 的建议，按严重程度排序。 */
  suggestions: string[]
}

export interface SkillUnderTest {
  name: string
  description: string
  whenToUse?: string
  body: string
  /** `.pilot/skills/<name>/` 下除 SKILL.md 之外的文件名。 */
  resources?: string[]
}

const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/
const MAX_BODY_CHARS = 24_000
const MIN_BODY_CHARS = 200
const LONG_BODY_CHARS = 8_000
const MAX_DESCRIPTION_CHARS = 300
const MIN_DESCRIPTION_CHARS = 15

/** 「验证」类措辞：没有它，技能读完不知道做对了没有。 */
const VERIFY_PATTERN = /\b(verify|verification|check|test|assert)\b|验证|检查|核对|跑一遍|实测/i
/** 边界措辞：技能是文档，不该被读成「覆盖安全规则」的指令。 */
const BOUNDARY_PATTERN =
  /\b(never|do not|don't|must not|boundary|out of scope)\b|不要|禁止|不得|边界|不适用|超出/i
/** 有序步骤：`1.` / `1)` 开头的编号列表。 */
const STEP_PATTERN = /^[ \t]*\d+[.)][ \t]/m
/** 可执行的东西：代码块或行内命令。 */
const COMMAND_PATTERN = /```|`[^`\n]+`/

/**
 * 疑似凭据。命中时只报行号，绝不把原文写进 detail——评测结果会被拼进
 * 工具输出、进日志、进上下文。
 */
const SECRET_PATTERN =
  /\b(api[_-]?key|secret|password|passwd|token|access[_-]?key|private[_-]?key)\b\s*[:=]\s*\S{6,}/i

function hit(checks: SkillCheck[], id: string, level: SkillCheckLevel, label: string, detail?: string) {
  checks.push(detail ? { id, level, label, detail } : { id, level, label })
}

/**
 * 评测一份技能文档。
 *
 * `source` 可选：传入 SKILL.md 原文时，先把 frontmatter 剥掉再检查正文，
 * 避免把 frontmatter 里的 `description:` 当成步骤或命令。
 */
export function evaluateSkill(skill: SkillUnderTest, source?: string): SkillEvalReport {
  const body = (source ? parseSkillMarkdown(source).body : skill.body).trim()
  const checks: SkillCheck[] = []

  if (!NAME_PATTERN.test(skill.name)) {
    hit(checks, 'name', 'error', '技能名不合规', '只能包含字母、数字、- 和 _，且不超过 64 个字符')
  } else {
    hit(checks, 'name', 'ok', '技能名合规')
  }

  const description = skill.description.trim()
  if (!description) {
    hit(checks, 'description', 'error', '缺少 description', '系统提示里列技能只显示这一行')
  } else if (description.length > MAX_DESCRIPTION_CHARS) {
    hit(checks, 'description', 'error', 'description 过长', `${description.length} 字符，上限 ${MAX_DESCRIPTION_CHARS}`)
  } else if (description.length < MIN_DESCRIPTION_CHARS) {
    hit(checks, 'description', 'warn', 'description 太短', '至少写清「做什么」与「用在什么时候」')
  } else if (description.toLowerCase() === skill.name.toLowerCase()) {
    hit(checks, 'description', 'warn', 'description 与技能名相同', '等于没有说明')
  } else {
    hit(checks, 'description', 'ok', 'description 可用')
  }

  const whenToUse = skill.whenToUse?.trim() ?? ''
  if (!whenToUse) {
    hit(checks, 'when-to-use', 'warn', '缺少 when_to_use', '没有触发条件时，模型很难判断该不该加载它')
  } else if (whenToUse.length < 10) {
    hit(checks, 'when-to-use', 'warn', 'when_to_use 过于笼统', '写成「当……时」这样能对照的条件')
  } else {
    hit(checks, 'when-to-use', 'ok', '有触发条件')
  }

  if (!body) {
    hit(checks, 'body', 'error', '正文为空', '技能就是正文，没有正文等于没写')
  } else if (body.length > MAX_BODY_CHARS) {
    hit(checks, 'body', 'error', '正文超长', `${body.length} 字符，上限 ${MAX_BODY_CHARS}；拆成 SKILL.md + 资源文件`)
  } else if (body.length < MIN_BODY_CHARS) {
    hit(checks, 'body', 'warn', '正文过短', `${body.length} 字符，通常不足以复现一次操作`)
  } else {
    hit(checks, 'body', 'ok', '正文长度合适')
  }

  if (body && !STEP_PATTERN.test(body)) {
    hit(checks, 'steps', 'warn', '没有有序步骤', '写成 1. 2. 3. 比一段散文更容易照着做')
  } else if (body) {
    hit(checks, 'steps', 'ok', '有有序步骤')
  }

  if (body && !COMMAND_PATTERN.test(body)) {
    hit(checks, 'commands', 'warn', '没有可复制的命令', '把要跑的命令放进代码块或反引号')
  } else if (body) {
    hit(checks, 'commands', 'ok', '带可复制命令')
  }

  if (body && !VERIFY_PATTERN.test(body)) {
    hit(checks, 'verification', 'warn', '没有验证方式', '写清「怎么算做完了」，否则无法判断执行结果')
  } else if (body) {
    hit(checks, 'verification', 'ok', '写明了验证方式')
  }

  if (body && !BOUNDARY_PATTERN.test(body)) {
    hit(checks, 'boundaries', 'warn', '没有边界说明', '至少写一句「不做什么」，避免技能被当成放行指令')
  } else if (body) {
    hit(checks, 'boundaries', 'ok', '有边界说明')
  }

  const resources = skill.resources ?? []
  if (body.length > LONG_BODY_CHARS && resources.length === 0) {
    hit(checks, 'resources', 'warn', '长正文没有配套资源文件', '把清单、样例拆成同名目录下的文件，正文只留步骤')
  } else if (resources.length > 0) {
    hit(checks, 'resources', 'ok', `带 ${resources.length} 个资源文件`)
  }

  if (body) {
    const lines = body.split(/\r?\n/)
    const secretLine = lines.findIndex((line) => SECRET_PATTERN.test(line))
    if (secretLine >= 0) {
      // 只给行号：这一行原文可能就是一串真实凭据。
      hit(
        checks,
        'secrets',
        'error',
        '疑似写入凭据',
        `正文第 ${secretLine + 1} 行看起来是「键 = 值」形式的密钥；技能里只写变量名和文件路径`,
      )
    }
  }

  const errors = checks.filter((check) => check.level === 'error').length
  const warnings = checks.filter((check) => check.level === 'warn').length
  const score = Math.max(0, Math.min(100, 100 - errors * 25 - warnings * 8))
  const suggestions = checks
    .filter((check) => check.level !== 'ok')
    .sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1))
    .map((check) => (check.detail ? `${check.label}：${check.detail}` : check.label))

  return {
    score,
    verdict: errors === 0 && score >= 70 ? 'usable' : 'needs-work',
    checks,
    suggestions,
  }
}

/** 工具输出用的短摘要：分数、结论、前三条待办。 */
export function formatSkillEval(report: SkillEvalReport): string {
  const head =
    report.verdict === 'usable'
      ? `技能自检 ${report.score}/100（可用）`
      : `技能自检 ${report.score}/100（建议先改再用）`
  if (report.suggestions.length === 0) return head
  const shown = report.suggestions.slice(0, 3).map((line) => `- ${line}`)
  const rest = report.suggestions.length - shown.length
  return [head, ...shown, ...(rest > 0 ? [`- 另有 ${rest} 条提示`] : [])].join('\n')
}
