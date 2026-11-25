import {
  MAX_REFLECTION_FINDINGS,
  REFLECTION_TOPICS,
  reflectionRefLabel,
  sanitizeReflectionFinding,
  type ReflectionFinding,
  type ReflectionTopicId,
} from '../../shared/reflect'
import { renderMailHtml, type MailTone } from './mail-layout'

/**
 * 反思用的提示词与输出解析。
 *
 * 反思只读本地统计证据、不调用任何工具：它要的是“自问 + 结论”，而不是再跑一遍
 * 任务。这样反思可以由定时器在后台触发，不会弹审批、不会改文件，也不会因为
 * 沙箱规则把一次自问变成一次失败运行。
 */

export interface ReflectionPromptInput {
  trigger: 'manual' | 'error' | 'schedule'
  topics: ReflectionTopicId[]
  evidence: string
  /** 报错触发时的错误原文（已脱敏、已截断）。 */
  errorText?: string
  /** 版本变化触发时的上一版与当前版，告诉模型该对比哪一段行为。 */
  versionChange?: { from: string; to: string }
  english: boolean
}

export function buildReflectionSystemPrompt(english: boolean): string {
  if (english) {
    return [
      "You are Pilot's reflection layer: a desktop AI coding agent reviewing itself.",
      'Your reader is Pilot itself, not the end user.',
      'Rules:',
      '1. Ground every finding in the supplied evidence (counts, failures, compaction, tool errors). Never invent numbers, files or logs.',
      '2. Ask what a senior engineer would ask after reading those numbers: what is drifting, what is wasted, what will break next.',
      '3. One finding = one concrete, checkable observation plus one actionable suggestion. No restating the evidence, no generic advice such as "improve quality".',
      '4. If the evidence cannot support a topic, skip that topic instead of filling the quota.',
      `5. At most ${MAX_REFLECTION_FINDINGS} findings. Rank by severity.`,
      '6. For code-structure claims, cite the supplied split verdict code or a recorded decision. A line count only means "measure this once", never "split it"; a recorded decision may not be overturned without new evidence and a named rule.',
      '7. Any finding about code must carry `refs`: the exact files from the evidence, with line numbers when you know them, e.g. "src/main/reflect/service.ts:202". Never cite a file, path or line that does not appear in the evidence.',
      '8. Findings already marked done were fixed in code: do not raise them again unless the current numbers show the problem came back. Findings marked dismissed were rejected on purpose — leave them alone.',
      '9. When the evidence is older than the code you would cite, say so in the observation instead of presenting it as current.',
      '10. Write in English and return JSON only.',
    ].join('\n')
  }
  return [
    '你是 Pilot（桌面 AI 编码代理）的反思层，读者是 Pilot 自己，不是最终用户。',
    '规则：',
    '1. 每条结论都必须落在给出的证据上（计数、失败记录、压缩次数、工具错误）。不要编造数字、文件或日志。',
    '2. 像一位资深工程师那样追问：哪些东西在慢慢漂移？哪里在被浪费？下一步最可能在哪里崩？',
    '3. 一条结论 = 一个可核对的现象 + 一条可执行的建议。不要复述证据，也不要写“提升质量”这类空话。',
    '4. 证据支撑不了某个问题域时就跳过它，不要为凑数而写。',
    `5. 最多 ${MAX_REFLECTION_FINDINGS} 条，按严重程度排序。`,
    '6. 涉及代码结构的结论必须引用给出的判据码或已记录决策。行数只说明“值得量化一次”，不能单独当拆分理由；没有新证据并说明推翻哪一条时，不得推翻已记录的决策。',
    '7. 凡是谈代码的结论都必须带 refs：从证据里取真实文件路径，知道行号就写 path:line（例如 src/main/reflect/service.ts:202）。不得引用证据里没出现过的文件、路径或行号。',
    '8. 标为「已处理」的结论表示代码已经改过：除非当前数字显示问题又回来了，否则不要再提。标为「不打算做」的结论直接跳过。',
    '9. 证据比你要引用的代码旧时，在现象里写清这一点，不要把旧数字当成现状。',
    '10. 用中文作答，只输出 JSON。',
  ].join('\n')
}

export function buildReflectionUserPrompt(input: ReflectionPromptInput): string {
  const english = input.english
  const topicLines = input.topics
    .map((id) => {
      const topic = REFLECTION_TOPICS.find((entry) => entry.id === id)
      if (!topic) return ''
      return `- ${id} (${english ? topic.en : topic.zh}): ${english ? topic.question.en : topic.question.zh}`
    })
    .filter(Boolean)
    .join('\n')
  const triggerLine = english
    ? input.trigger === 'error'
      ? 'Trigger: a run just failed. Start from that failure, then widen to the other domains.'
      : input.trigger === 'schedule'
        ? 'Trigger: scheduled self-review.'
        : 'Trigger: the user asked for a reflection now.'
    : input.trigger === 'error'
      ? '触发原因：刚刚有一次运行失败。先从这个错误入手，再扩展到其他问题域。'
      : input.trigger === 'schedule'
        ? '触发原因：定时自问。'
        : '触发原因：用户要求现在反思一次。'
  const shape = english
    ? '{"summary": "<=400 chars, what is drifting overall", "findings": [{"topic": "<one of the ids>", "severity": "high|medium|low", "observation": "what the evidence shows", "suggestion": "one concrete action", "refs": ["src/path/file.ts:123"]}]}'
    : '{"summary": "不超过 400 字，概括整体在往哪漂", "findings": [{"topic": "<上面某个 id>", "severity": "high|medium|low", "observation": "证据显示的现象", "suggestion": "一条具体动作", "refs": ["src/路径/文件.ts:123"]}]}'
  const parts = [
    triggerLine,
    ...(input.versionChange
      ? [
          english
            ? `The app just changed from ${input.versionChange.from} to ${input.versionChange.to}: judge this version's runs first, and say plainly when the evidence cannot separate a regression from an old issue.`
            : `应用刚从 ${input.versionChange.from} 升级到 ${input.versionChange.to}：先看这一版的运行，证据分不清是新回归还是旧问题时直接说明。`,
        ]
      : []),
    english ? 'Domains to question:' : '要自问的问题域：',
    topicLines,
    english ? 'Evidence:' : '证据：',
    input.evidence,
  ]
  if (input.errorText) {
    parts.push(english ? 'Failure text:' : '失败原文：', input.errorText)
  }
  parts.push(english ? 'Return JSON exactly in this shape:' : '严格按这个形状返回 JSON：', shape)
  return parts.join('\n\n')
}

export interface ReflectionOutput {
  summary: string
  findings: ReflectionFinding[]
}

/** 从模型回复里抠出 JSON：优先 ```json 代码块，其次首尾花括号之间。 */
function extractJson(text: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  if (fenced?.[1]) return fenced[1].trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) return text.slice(start, end + 1)
  return null
}

/**
 * 解析反思输出。任何一个字段坏了都不该让整次反思失败：
 * 解析不出 JSON 就把原文当摘要，条目为空也保留摘要。
 */
export function parseReflectionOutput(text: string): ReflectionOutput {
  const raw = typeof text === 'string' ? text.trim() : ''
  if (!raw) return { summary: '', findings: [] }
  const json = extractJson(raw)
  if (!json) return { summary: raw.slice(0, 800), findings: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return { summary: raw.slice(0, 800), findings: [] }
  }
  if (!parsed || typeof parsed !== 'object') return { summary: raw.slice(0, 800), findings: [] }
  const record = parsed as Record<string, unknown>
  const summary =
    typeof record['summary'] === 'string'
      ? record['summary'].replace(/\s+/g, ' ').trim().slice(0, 800)
      : ''
  const list = Array.isArray(record['findings'])
    ? record['findings']
    : Array.isArray(record['items'])
      ? record['items']
      : []
  const findings = list
    .map(sanitizeReflectionFinding)
    .filter((item): item is ReflectionFinding => Boolean(item))
    .slice(0, MAX_REFLECTION_FINDINGS)
  return { summary: summary || (findings.length === 0 ? raw.slice(0, 800) : ''), findings }
}

/** 邮件里的时间用本地时区：报告是给人看的，「09:00」比 ISO 串更直接。 */
function localTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso.slice(0, 16).replace('T', ' ')
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 严重度 → 邮件里那条发现的左侧色条。 */
function severityTone(severity: string): MailTone {
  return severity === 'high' ? 'danger' : severity === 'low' ? 'info' : 'warning'
}

/** 把报告渲染成纯文本 + HTML 两版正文：同源字段，不会各说各话。 */
export function renderReportText(input: {
  createdAt: string
  trigger: string
  model: string
  summary: string
  findings: ReflectionFinding[]
  english: boolean
}): { subject: string; body: string; html: string } {
  const english = input.english
  const at = localTime(input.createdAt)
  const title = english ? 'Reflection report' : '反思报告'
  const subject = english
    ? `Pilot reflection · ${at} · ${input.findings.length} findings`
    : `Pilot 反思 · ${at} · ${input.findings.length} 条`
  const severityLabel = (severity: string): string =>
    english ? severity : severity === 'high' ? '高' : severity === 'low' ? '低' : '中'
  const topicLabel = (topic: ReflectionFinding['topic']): string => {
    const entry = REFLECTION_TOPICS.find((candidate) => candidate.id === topic)
    return english ? (entry?.en ?? topic) : (entry?.zh ?? topic)
  }
  const lines: string[] = []
  lines.push(title)
  lines.push('')
  lines.push(`${english ? 'Generated' : '生成时间'}: ${at}`)
  lines.push(`${english ? 'Trigger' : '触发方式'}: ${input.trigger}`)
  if (input.model) lines.push(`${english ? 'Model' : '模型'}: ${input.model}`)
  lines.push(`${english ? 'Findings' : '发现数'}: ${input.findings.length}`)
  lines.push('')
  lines.push(english ? 'Summary' : '整体判断')
  lines.push(input.summary || (english ? '(no summary)' : '（无摘要）'))
  lines.push('')
  if (input.findings.length === 0) {
    lines.push(english ? 'No actionable finding this round.' : '本轮没有可执行的发现。')
  }
  input.findings.forEach((finding, index) => {
    lines.push(
      `${index + 1}. [${severityLabel(finding.severity)}] ${topicLabel(finding.topic)}`,
    )
    lines.push(`   ${english ? 'Observation' : '现象'}: ${finding.observation}`)
    if (finding.suggestion) {
      lines.push(`   ${english ? 'Suggestion' : '建议'}: ${finding.suggestion}`)
    }
    const refs = (finding.refs ?? []).map(reflectionRefLabel)
    if (refs.length > 0) {
      lines.push(`   ${english ? 'Code' : '代码位置'}: ${refs.join(', ')}`)
    }
  })
  lines.push('', english ? 'Open Pilot to see the evidence.' : '打开 Pilot 可以查看本轮证据。')
  const html = renderMailHtml({
    title,
    eyebrow: english ? 'Reflection' : '反思报告',
    badge: { text: input.trigger, tone: input.findings.length > 0 ? 'warning' : 'success' },
    at,
    rows: [
      { label: english ? 'Model' : '模型', value: input.model },
      { label: english ? 'Findings' : '发现数', value: String(input.findings.length) },
    ],
    paragraphs: [input.summary || (english ? '(no summary)' : '（无摘要）')],
    blocks:
      input.findings.length === 0
        ? [
            {
              tone: 'success',
              heading: english ? 'No actionable finding this round.' : '本轮没有可执行的发现。',
              lines: [],
            },
          ]
        : input.findings.map((finding, index) => ({
            tone: severityTone(finding.severity),
            heading: `${index + 1}. [${severityLabel(finding.severity)}] ${topicLabel(finding.topic)}`,
            lines: [
              `${english ? 'Observation' : '现象'}: ${finding.observation}`,
              ...(finding.suggestion
                ? [`${english ? 'Suggestion' : '建议'}: ${finding.suggestion}`]
                : []),
              ...((finding.refs ?? []).length > 0
                ? [
                    `${english ? 'Code' : '代码位置'}: ${(finding.refs ?? [])
                      .map(reflectionRefLabel)
                      .join(', ')}`,
                  ]
                : []),
            ],
          })),
    footnote: english ? 'Open Pilot to see the evidence.' : '打开 Pilot 可以查看本轮证据。',
    english,
  })
  return { subject, body: lines.join('\n'), html }
}
