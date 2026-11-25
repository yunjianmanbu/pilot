/**
 * Whether a chunk of assistant text reads as a deliverable report rather than a
 * line of narration inside the process.
 *
 * Narration is one sentence ("先看一下目录", "再看另一处"). A result is a
 * document: a heading, a code fence or a table. Length alone is not enough, so
 * the shape has to match as well.
 *
 * Both hosts use this one predicate so they cannot disagree about whether a run
 * has already delivered its answer: the loop stops re-arming the verification
 * gate once a report exists, and the transcript decides which chunk to show as
 * the answer. Two separate copies drifted before — a run whose report the
 * transcript showed as the answer could still be told by the loop that it had
 * produced nothing.
 */
export function isDeliverableText(text: string): boolean {
  const body = text.trim()
  if (body.length < 320) return false
  if (/^#{2,6}\s+\S/m.test(body)) return true
  if (body.includes('```')) return true
  const table = body.split(/\r?\n/).filter((line) => /^\s*\|.+\|\s*$/.test(line))
  return table.length >= 2
}
