/**
 * Tolerant JSON extraction for model replies.
 *
 * Reasoning models routinely wrap the answer in a sentence or a Markdown
 * fence, and a few leave a trailing comma behind. The caller still validates
 * every field; this module only locates the object, so a harmless formatting
 * habit does not turn into "没有返回可解析的结果".
 */

function matchingBrace(text: string, start: number): number {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
    } else if (char === '{') {
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/** Remove commas that directly precede a closing brace/bracket, outside strings. */
export function stripTrailingCommas(text: string): string {
  let output = ''
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    if (inString) {
      output += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      output += char
      continue
    }
    if (char === ',') {
      let next = index + 1
      while (next < text.length && /\s/.test(text[next]!)) next += 1
      const following = text[next]
      if (following === '}' || following === ']') {
        index = next - 1
        continue
      }
    }
    output += char
  }
  return output
}

function firstObject(text: string): Record<string, unknown> | null {
  const cleaned = stripTrailingCommas(text.replace(/^﻿/, ''))
  for (let start = cleaned.indexOf('{'); start >= 0; start = cleaned.indexOf('{', start + 1)) {
    const end = matchingBrace(cleaned, start)
    if (end < 0) continue
    try {
      const parsed: unknown = JSON.parse(cleaned.slice(start, end + 1))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // Not this candidate; keep scanning in case an earlier brace was prose.
    }
  }
  return null
}

/**
 * Return the first JSON object in `text`, accepting a Markdown fence or prose
 * around it. A fenced block is preferred, because prose may itself contain
 * braces (for example an example template) before the real answer.
 */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const candidates: string[] = []
  const fenced = /```(?:json)?\s*([\s\S]*?)```/gi
  for (let match = fenced.exec(text); match; match = fenced.exec(text)) {
    if (match[1]) candidates.push(match[1])
  }
  candidates.push(text)
  for (const candidate of candidates) {
    const parsed = firstObject(candidate)
    if (parsed) return parsed
  }
  return null
}

/**
 * Read a 0-100 score from a number, a numeric string ("85", "85/100",
 * "85 分"), or an object carrying a `score` field. Returns null when there is
 * no usable number so the caller can report an unparsable verdict.
 */
export function coerceScore(value: unknown, min = 0, max = 100): number | null {
  const raw =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)['score']
      : value
  let number: number | null = null
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    number = raw
  } else if (typeof raw === 'string') {
    const match = raw.match(/-?\d+(?:\.\d+)?/)
    if (match) number = Number(match[0])
  }
  if (number === null || !Number.isFinite(number)) return null
  // A model that ignores the 0-100 instruction sometimes answers 0-1
  // ("score": 0.85). Treat a value strictly between 0 and 1 as a ratio; a
  // literal sub-1 score on the stated scale would fail either way.
  if (number > 0 && number < 1) number *= 100
  return Math.min(max, Math.max(min, Math.round(number)))
}

/** Accepts true and the string "true"; everything else is false. */
export function coerceTrue(value: unknown): boolean {
  return value === true || value === 'true'
}
