export interface MergeHunk {
  baseStart: number
  baseEnd: number
  sideStart: number
  sideEnd: number
}

export interface TaggedHunk extends MergeHunk {
  side: 'mine' | 'theirs'
  sideLines: string[]
}

export interface MergeOutcome {
  text: string
  conflicts: number
}

const MAX_MERGE_LINES = 2_000
const MAX_MERGE_CELLS = 2_000_000

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split('\n')
}

export function hasConflictMarkers(text: string): boolean {
  return /^<<<<<<< |^>>>>>>> /m.test(text)
}

/**
 * Line-level diff. Returns `null` when the file is too large to merge safely,
 * so callers can report a conflict instead of blocking the event loop.
 */
export function diffHunks(base: string[], side: string[]): MergeHunk[] | null {
  if (base.length > MAX_MERGE_LINES || side.length > MAX_MERGE_LINES) return null
  let prefix = 0
  while (prefix < base.length && prefix < side.length && base[prefix] === side[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < base.length - prefix &&
    suffix < side.length - prefix &&
    base[base.length - 1 - suffix] === side[side.length - 1 - suffix]
  ) {
    suffix += 1
  }
  const mine = base.slice(prefix, base.length - suffix)
  const theirs = side.slice(prefix, side.length - suffix)
  if (mine.length === 0 && theirs.length === 0) return []
  if (mine.length * theirs.length > MAX_MERGE_CELLS) return null
  const width = theirs.length + 1
  const table = new Uint32Array((mine.length + 1) * width)
  for (let row = 1; row <= mine.length; row += 1) {
    for (let column = 1; column <= theirs.length; column += 1) {
      table[row * width + column] =
        mine[row - 1] === theirs[column - 1]
          ? table[(row - 1) * width + (column - 1)]! + 1
          : Math.max(table[(row - 1) * width + column]!, table[row * width + (column - 1)]!)
    }
  }
  const matches: { base: number; side: number }[] = []
  let row = mine.length
  let column = theirs.length
  while (row > 0 && column > 0) {
    if (mine[row - 1] === theirs[column - 1]) {
      matches.push({ base: row - 1, side: column - 1 })
      row -= 1
      column -= 1
    } else if (table[(row - 1) * width + column]! >= table[row * width + (column - 1)]!) {
      row -= 1
    } else {
      column -= 1
    }
  }
  matches.reverse()
  const hunks: MergeHunk[] = []
  let baseCursor = 0
  let sideCursor = 0
  for (const match of matches) {
    if (match.base > baseCursor || match.side > sideCursor) {
      hunks.push({
        baseStart: prefix + baseCursor,
        baseEnd: prefix + match.base,
        sideStart: prefix + sideCursor,
        sideEnd: prefix + match.side,
      })
    }
    baseCursor = match.base + 1
    sideCursor = match.side + 1
  }
  if (baseCursor < mine.length || sideCursor < theirs.length) {
    hunks.push({
      baseStart: prefix + baseCursor,
      baseEnd: prefix + mine.length,
      sideStart: prefix + sideCursor,
      sideEnd: prefix + theirs.length,
    })
  }
  return hunks
}

function hunksOverlap(left: MergeHunk, right: MergeHunk): boolean {
  const leftInsert = left.baseStart === left.baseEnd
  const rightInsert = right.baseStart === right.baseEnd
  if (leftInsert && rightInsert) return left.baseStart === right.baseStart
  if (leftInsert) return right.baseStart < left.baseStart && left.baseStart < right.baseEnd
  if (rightInsert) return left.baseStart < right.baseStart && right.baseStart < left.baseEnd
  return left.baseStart < right.baseEnd && right.baseStart < left.baseEnd
}

export function clusterHunks(hunks: TaggedHunk[]): TaggedHunk[][] {
  const sorted = [...hunks].sort(
    (left, right) =>
      left.baseStart - right.baseStart ||
      left.baseEnd - right.baseEnd ||
      (left.side === right.side ? 0 : left.side === 'mine' ? -1 : 1),
  )
  const clusters: TaggedHunk[][] = []
  let current: TaggedHunk[] = []
  for (const hunk of sorted) {
    if (current.length === 0) {
      current = [hunk]
      continue
    }
    if (current.some((entry) => hunksOverlap(entry, hunk))) {
      current.push(hunk)
      continue
    }
    clusters.push(current)
    current = [hunk]
  }
  if (current.length > 0) clusters.push(current)
  return clusters
}

function renderClusterSide(
  base: string[],
  hunks: TaggedHunk[],
  start: number,
  end: number,
): string[] {
  const ordered = [...hunks].sort((left, right) => left.baseStart - right.baseStart)
  const output: string[] = []
  let cursor = start
  for (const hunk of ordered) {
    while (cursor < hunk.baseStart) {
      output.push(base[cursor]!)
      cursor += 1
    }
    output.push(...hunk.sideLines)
    cursor = hunk.baseEnd
  }
  while (cursor < end) {
    output.push(base[cursor]!)
    cursor += 1
  }
  return output
}

/**
 * Three-way merge of text files. Non-overlapping edits are combined; overlapping
 * edits produce standard conflict markers that a coding agent can resolve.
 */
export function mergeText(
  ancestor: string,
  mine: string,
  theirs: string,
  officialVersion: string,
): MergeOutcome | null {
  if (hasConflictMarkers(mine) || hasConflictMarkers(theirs) || hasConflictMarkers(ancestor)) {
    return null
  }
  const base = splitLines(ancestor)
  const mineLines = splitLines(mine)
  const theirLines = splitLines(theirs)
  const mineHunks = diffHunks(base, mineLines)
  const theirHunks = diffHunks(base, theirLines)
  if (!mineHunks || !theirHunks) return null
  const tagged: TaggedHunk[] = [
    ...mineHunks.map((hunk) => ({
      ...hunk,
      side: 'mine' as const,
      sideLines: mineLines.slice(hunk.sideStart, hunk.sideEnd),
    })),
    ...theirHunks.map((hunk) => ({
      ...hunk,
      side: 'theirs' as const,
      sideLines: theirLines.slice(hunk.sideStart, hunk.sideEnd),
    })),
  ]
  const clusters = clusterHunks(tagged)
  const output: string[] = []
  let cursor = 0
  let conflicts = 0
  for (const cluster of clusters) {
    const start = Math.min(...cluster.map((hunk) => hunk.baseStart))
    const end = Math.max(...cluster.map((hunk) => hunk.baseEnd))
    while (cursor < start) {
      output.push(base[cursor]!)
      cursor += 1
    }
    const mineCluster = cluster.filter((hunk) => hunk.side === 'mine')
    const theirCluster = cluster.filter((hunk) => hunk.side === 'theirs')
    if (mineCluster.length > 0 && theirCluster.length > 0) {
      const mineRegion = renderClusterSide(base, mineCluster, start, end)
      const theirRegion = renderClusterSide(base, theirCluster, start, end)
      if (
        mineRegion.length === theirRegion.length &&
        mineRegion.every((line, index) => line === theirRegion[index])
      ) {
        output.push(...mineRegion)
      } else {
        conflicts += 1
        output.push(
          '<<<<<<< 我的版本',
          ...mineRegion,
          '=======',
          ...theirRegion,
          `>>>>>>> 官方 v${officialVersion}`,
        )
      }
    } else {
      output.push(...renderClusterSide(base, cluster, start, end))
    }
    cursor = Math.max(cursor, end)
  }
  while (cursor < base.length) {
    output.push(base[cursor]!)
    cursor += 1
  }
  const crlf = [ancestor, mine, theirs].some((text) => text.includes('\r\n'))
  const text = output.join('\n')
  return { text: crlf ? text.replace(/\n/g, '\r\n') : text, conflicts }
}
