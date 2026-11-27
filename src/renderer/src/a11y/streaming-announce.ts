/**
 * 流式正文的读屏播报：把 token 流按「句子」攒成几段再交出去。
 *
 * 直接给正在流式的 Markdown 挂 `aria-live` 是行不通的：每一个 delta 都会换
 * 掉整块文本，读屏会把整段重读一遍，模型吐字时读者听到的是连绵不断的重播，
 * 反而读不到内容。这里把过程拆成两步：
 *
 * 1. `takeAnnouncement` 是纯函数：从缓冲里切出一个**完整的句子**（或一个
 *    够长的块）交给读屏，剩下的留在缓冲里等下一轮；
 * 2. `useStreamAnnouncement` 每 `ANNOUNCE_INTERVAL_MS` 轮询一次缓冲，运行
 *    结束时把不足一句的尾巴强制播完，保证最后半句不会被吞掉。
 *
 * 切分粒度两头都有闸：不足 `ANNOUNCE_MIN_CHARS` 的碎片先攒着（否则「好的。」
 * 两个字就要打扰一次），超过 `ANNOUNCE_MAX_CHARS` 又没标点（代码块、长句）
 * 时硬切，避免读者永远等不到第一句话。
 */

import { useCallback, useEffect, useRef, useState } from 'react'

export interface AnnounceOptions {
  /** 够长才开始播，默认 `ANNOUNCE_MIN_CHARS`。 */
  minChars?: number
  /** 单次播报的上限，默认 `ANNOUNCE_MAX_CHARS`。 */
  maxChars?: number
  /** 换成新一轮（新的 runId / 会话）时清空缓冲。 */
  resetKey?: string | number
}

export interface Announcement {
  text: string
  rest: string
}

export interface AnnounceEntry {
  id: number
  text: string
}

export const ANNOUNCE_MIN_CHARS = 60
export const ANNOUNCE_MAX_CHARS = 240
export const ANNOUNCE_INTERVAL_MS = 900
export const ANNOUNCE_MAX_ENTRIES = 12

/** 中文句末：遇到就断，不问后面是什么。 */
const HARD_ENDS = '。！？；\n'
/** 西文句末：后面必须跟空白或到结尾，否则 `3.5` 会被切成两句。 */
const SOFT_ENDS = '.!?;'
/**
 * 缩写词后面的点不是句末。不处理的话 `e.g. the next step` 会被断成「… and e.g.」
 * —— 读者听到一句话最后一个词是个缩写点，然后下一句从头开始。
 */
const ABBREVIATIONS = new Set([
  'e.g.',
  'i.e.',
  'etc.',
  'vs.',
  'cf.',
  'mr.',
  'mrs.',
  'ms.',
  'dr.',
  'no.',
  'fig.',
  'al.',
])

function isAbbreviation(text: string, index: number): boolean {
  let start = index
  while (start > 0 && /[A-Za-z.]/.test(text[start - 1] as string)) start -= 1
  return ABBREVIATIONS.has(text.slice(start, index + 1).toLowerCase())
}

function endOfSentenceAt(text: string, index: number): boolean {
  const ch = text[index] as string
  if (HARD_ENDS.includes(ch)) return true
  if (!SOFT_ENDS.includes(ch)) return false
  if (isAbbreviation(text, index)) return false
  const next = text[index + 1]
  return next === undefined || next === ' ' || next === '\n' || next === '\t' || next === '\r'
}

/** 切点不能落在代理对中间，否则 emoji 会变成半个替换字符念出来。 */
function safeCut(text: string, cut: number): number {
  if (cut <= 0) return 0
  const code = text.charCodeAt(cut - 1)
  return code >= 0xd800 && code <= 0xdbff ? cut - 1 : cut
}

/**
 * 没有标点又超过上限时硬切：优先在最近的空白处断，别把英文单词劈成两半。
 * 只在末尾 40 个字符里找空白，太靠前就等于没切够。
 */
function hardCut(text: string, maxChars: number): number {
  const limit = Math.min(text.length, maxChars)
  const space = text.lastIndexOf(' ', limit)
  const cut = space > 0 && space > limit - 40 ? space : limit
  return safeCut(text, cut)
}

/**
 * 从缓冲里取出下一段可播报文本；还不够长且没有句末时返回 `null`。
 *
 * `force` 用在运行结束的收尾：哪怕只剩半句、哪怕不到 `minChars`，也要吐出来。
 */
export function takeAnnouncement(
  pending: string,
  options: AnnounceOptions & { force?: boolean } = {},
): Announcement | null {
  if (!pending) return null
  const minChars = Math.max(1, options.minChars ?? ANNOUNCE_MIN_CHARS)
  const maxChars = Math.max(minChars, options.maxChars ?? ANNOUNCE_MAX_CHARS)
  const force = options.force === true

  const limit = Math.min(pending.length, maxChars)
  let firstReady = -1
  let lastEnd = -1
  for (let i = 0; i < limit; i += 1) {
    if (!endOfSentenceAt(pending, i)) continue
    lastEnd = i + 1
    if (firstReady < 0 && lastEnd >= minChars) firstReady = lastEnd
  }

  let cut: number
  if (firstReady > 0) {
    cut = firstReady
  } else if (force && pending.length <= maxChars) {
    cut = pending.length
  } else if (lastEnd > 0 && (force || pending.length >= maxChars)) {
    cut = lastEnd
  } else if (pending.length >= maxChars) {
    cut = hardCut(pending, maxChars)
  } else {
    return null
  }

  cut = safeCut(pending, cut)
  if (cut <= 0) return null
  return { text: pending.slice(0, cut).trim(), rest: pending.slice(cut) }
}

/**
 * 收尾冲干：一轮跑完后把缓冲里剩下的全切成句子。
 *
 * `guard` 防的是死循环：切不开（`cut` 一直是 0）时宁可丢掉尾巴，也不能卡住渲染。
 * 返回的数组按顺序播报，最后一项之后缓冲应为空。
 */
export function drainAnnouncements(
  pending: string,
  options: AnnounceOptions = {},
): string[] {
  const out: string[] = []
  let rest = pending
  for (let guard = 0; guard < 16; guard += 1) {
    const take = takeAnnouncement(rest, { ...options, force: true })
    if (!take) break
    rest = take.rest
    if (take.text) out.push(take.text)
  }
  return out
}

/**
 * Markdown 转「读音」：读屏不该把 `**`、`[]()`、反引号念出来。
 *
 * 只做低风险的替换，不追求完整解析：切分是按完整句子来的，跨片段的标记
 * 残渣顶多让某一句话多一个符号，不会改变语义。
 */
export function plainSpeech(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/^[ \t]*#{1,6}[ \t]*/gm, '')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

/**
 * 流式文本的播报队列。
 *
 * 返回的条目以追加方式渲染到隐藏的 live region 里：只读新增的那句，不重读
 * 整段（`aria-atomic="false"` + `aria-relevant="additions"`）。
 *
 * 只在新文本长度**变短**时重置进度：那是重新生成或换了一轮，旧进度作废。
 * 长度变长一律按增量处理，正常的流式只会让长度变大。
 */
export function useStreamAnnouncement(
  text: string | null | undefined,
  active: boolean,
  options: AnnounceOptions = {},
): AnnounceEntry[] {
  const {
    minChars = ANNOUNCE_MIN_CHARS,
    maxChars = ANNOUNCE_MAX_CHARS,
    resetKey,
  } = options
  const [entries, setEntries] = useState<AnnounceEntry[]>([])
  const sentRef = useRef(0)
  const pendingRef = useRef('')
  const idRef = useRef(0)
  const activeRef = useRef(active)
  const resetRef = useRef(resetKey)

  const push = useCallback((chunk: string) => {
    // 播报前先去 Markdown 标记：切分已经在句子边界上做过，这里改长度不影响切点。
    const spoken = plainSpeech(chunk)
    if (!spoken) return
    idRef.current += 1
    const entry: AnnounceEntry = { id: idRef.current, text: spoken }
    setEntries((prev) => [...prev, entry].slice(-ANNOUNCE_MAX_ENTRIES))
  }, [])

  // 收到新文本：只把增量塞进缓冲，切分留给下面的轮询，避免每个 token 都算一次。
  useEffect(() => {
    const full = text ?? ''
    if (resetRef.current !== resetKey) {
      resetRef.current = resetKey
      sentRef.current = 0
      pendingRef.current = ''
    }
    if (full.length < sentRef.current) {
      sentRef.current = 0
      pendingRef.current = ''
    }
    if (full.length === sentRef.current) return
    pendingRef.current += full.slice(sentRef.current)
    sentRef.current = full.length
  }, [text, resetKey])

  // 流式期间按固定间隔取句子；没有可播的内容就什么都不做。
  useEffect(() => {
    if (!active) return undefined
    const timer = setInterval(() => {
      const take = takeAnnouncement(pendingRef.current, { minChars, maxChars })
      if (!take) return
      pendingRef.current = take.rest
      push(take.text)
    }, ANNOUNCE_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [active, minChars, maxChars, push])

  // 运行结束：把不足一句的尾巴补播完，否则最后半句永远读不到。
  // 只在 true → false 的那一次跳变里做，首次挂载的静态历史不会被整段朗读。
  useEffect(() => {
    const was = activeRef.current
    activeRef.current = active
    if (!was || active) return
    const tail = drainAnnouncements(pendingRef.current, { minChars, maxChars })
    pendingRef.current = ''
    for (const chunk of tail) push(chunk)
  }, [active, minChars, maxChars, push])

  return entries
}
