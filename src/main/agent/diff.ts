/**
 * Small unified-diff generator used only to show the user what a write/patch
 * changed. It is deliberately bounded: a huge file falls back to a whole-file
 * summary instead of allocating an enormous LCS matrix.
 */
type Op = { type: 'equal' | 'insert' | 'delete'; line: string }

function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

function lcsOps(before: string[], after: string[]): Op[] {
  const n = before.length
  const m = after.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] =
        before[i] === after[j] ? (dp[i + 1]![j + 1] ?? 0) + 1 : Math.max(dp[i + 1]![j] ?? 0, dp[i]![j + 1] ?? 0)
    }
  }
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      ops.push({ type: 'equal', line: before[i] ?? '' })
      i += 1
      j += 1
    } else if ((dp[i + 1]![j] ?? 0) >= (dp[i]![j + 1] ?? 0)) {
      ops.push({ type: 'delete', line: before[i] ?? '' })
      i += 1
    } else {
      ops.push({ type: 'insert', line: after[j] ?? '' })
      j += 1
    }
  }
  while (i < n) {
    ops.push({ type: 'delete', line: before[i] ?? '' })
    i += 1
  }
  while (j < m) {
    ops.push({ type: 'insert', line: after[j] ?? '' })
    j += 1
  }
  return ops
}

function fallback(before: string[], after: string[]): string {
  const lines = [
    `@@ -1,${before.length} +1,${after.length} @@`,
    ...before.map((line) => `-${line}`),
    ...after.map((line) => `+${line}`),
  ]
  return lines.join('\n')
}

export function createUnifiedDiff(path: string, beforeText: string, afterText: string): string {
  if (beforeText === afterText) return ''
  const before = splitLines(beforeText)
  const after = splitLines(afterText)
  if (before.length * after.length > 4_000_000) {
    return `--- a/${path}\n+++ b/${path}\n${fallback(before, after)}`
  }

  const ops = lcsOps(before, after)
  const changed = ops
    .map((op, index) => (op.type === 'equal' ? -1 : index))
    .filter((index) => index >= 0)
  if (changed.length === 0) return ''

  const context = 3
  const ranges: Array<[number, number]> = []
  for (const index of changed) {
    const start = Math.max(0, index - context)
    const end = Math.min(ops.length - 1, index + context)
    const last = ranges[ranges.length - 1]
    if (last && start <= last[1] + 1) last[1] = end
    else ranges.push([start, end])
  }

  const out: string[] = [`--- a/${path}`, `+++ b/${path}`]
  for (const [start, end] of ranges) {
    let oldLine = 1
    let newLine = 1
    for (let index = 0; index < start; index += 1) {
      const op = ops[index]
      if (op?.type !== 'insert') oldLine += 1
      if (op?.type !== 'delete') newLine += 1
    }
    const slice = ops.slice(start, end + 1)
    const oldCount = slice.filter((op) => op.type !== 'insert').length
    const newCount = slice.filter((op) => op.type !== 'delete').length
    out.push(`@@ -${oldLine},${oldCount} +${newLine},${newCount} @@`)
    for (const op of slice) {
      out.push(`${op.type === 'insert' ? '+' : op.type === 'delete' ? '-' : ' '}${op.line}`)
    }
  }
  return out.join('\n')
}
