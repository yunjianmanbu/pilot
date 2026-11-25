import { describe, expect, it } from 'vitest'
import {
  answerMessageIds,
  appendLiveProcessText,
  buildTranscript,
  emptyLiveRun,
  isDeliverableText,
  liveAnswerText,
  liveProcess,
  settleLiveAnswer,
  type LiveRun,
} from '../src/renderer/src/ui'
import type { StoredMessage } from '../src/shared/types'

/**
 * A report-shaped body: needs >= 320 chars and a heading to count as one.
 * Shaped after the real case - a deliverable report followed by a second
 * equally formatted block that the reader mistook for the conclusion.
 */
const report = [
  '## 结果',
  '',
  '证据链已跑通，报告结论未被推翻。本轮执行的是端到端可复现检查：',
  '',
  '| 脚本 | 检查 | 结果 |',
  '| --- | --- | --- |',
  '| `cells.mjs` | PDF→tsv | 通过，md5 与既有文件一致 |',
  '| `build3.mjs` | tsv→records | 通过，records 350 |',
  '',
  '提取链路幂等，`pdd_records.json` 是确定性产物：同一份输入重跑必得同一个 md5，',
  '所以任何数字都可以从产物本身反推，不需要信任这一轮的记录。',
  '',
  '## 验证',
  '',
  '按顺序重跑三行脚本即可复核任何一个数字；这是本轮唯一执行的验证路径。',
  '',
  '旧版 `build.mjs` 把 stock 列切出 30+ 个脏键，`0` 被切成 149 个碎片，',
  '计数合计与 173 不符，因此旧版只能用于阅读文本，不能用于统计。',
].join('\n')

/** The verification recap written after the report: also report-shaped. */
const recap = [
  '## 结果',
  '',
  '证据链已跑通，报告结论未被推翻。本轮实际执行的是端到端可复现检查：',
  '',
  '| 脚本 | 检查 | 结果 |',
  '| --- | --- | --- |',
  '| `node --check` | 语法 | 7/7 通过 |',
  '| `build.mjs` | 实跑 | stock 列出现 30+ 个脏键，旧版不可用于计数 |',
  '',
  '`build.mjs` 的脏键是列 x 区间重叠未截断导致，`build3.mjs` 已修掉这一处。',
  '`build2.mjs` 会写同一个 `pdd_records.json`，跑完已用备份恢复，恢复后 md5 校验一致。',
  '',
  '## 未验证',
  '',
  '`pdf2txt.mjs` 只做了语法检查，没实跑转换；重跑会覆盖现成文本且无新增信息，',
  '收益低于风险，所以本轮没有执行。',
].join('\n')

const closing = '临时脚本已清理。'

function live(overrides: Partial<LiveRun> = {}): LiveRun {
  return { ...emptyLiveRun('session-1'), runId: 'run-1', ...overrides }
}

// Both bodies have to cross the 320-char threshold, or the predicate would fall
// through to the "last thing the run said" branch and the fixture would silently
// stop testing the case it was written for.
if (!isDeliverableText(report) || !isDeliverableText(recap)) {
  throw new Error('fixtures no longer read as reports')
}

describe('live answer stays the conclusion', () => {
  it('freezes the first report-shaped text as the answer', () => {
    const settled = settleLiveAnswer(live({ content: report }), 'n-call-1')
    expect(settled.answer).toBe(report)
    expect(settled.content).toBe('')
    expect(settled.processText).toEqual([])
  })

  it('moves a second report-shaped text into the process', () => {
    const settled = settleLiveAnswer(live({ content: recap, answer: report }), 'n-call-2')
    expect(settled.answer).toBe(report)
    expect(settled.content).toBe('')
    expect(settled.processText).toEqual([recap])
    expect(settled.parts?.map((part) => part.kind)).toEqual(['note'])
  })

  it('keeps a short closing line in the answer area', () => {
    const settled = settleLiveAnswer(live({ content: closing, answer: report }), 'n-call-2')
    expect(settled.answer).toBe(report)
    expect(settled.content).toBe(closing)
    expect(settled.processText).toEqual([])
  })

  it('leaves a short narration in the answer area', () => {
    const narration = '先看一下目录。'
    const settled = settleLiveAnswer(live({ content: narration }), 'n-call-1')
    expect(settled.answer).toBeUndefined()
    expect(settled.content).toBe(narration)
  })

  it('does not freeze a report at a continuation boundary', () => {
    const settled = settleLiveAnswer(live({ content: report }), 'n-msg', { freeze: false })
    expect(settled.answer).toBeUndefined()
    expect(settled.content).toBe(report)
  })

  it('still moves a second report into the process when freezing is off', () => {
    const settled = settleLiveAnswer(live({ content: recap, answer: report }), 'n-msg', {
      freeze: false,
    })
    expect(settled.answer).toBe(report)
    expect(settled.processText).toEqual([recap])
  })

  it('is a no-op when nothing is streaming', () => {
    const base = live({ answer: report })
    expect(settleLiveAnswer(base, 'n-call-1')).toBe(base)
  })
})

describe('live answer rendering', () => {
  it('never lets a second report replace the answer', () => {
    expect(liveAnswerText(live({ answer: report, content: recap }))).toBe(report)
  })

  it('never shows text that arrived after the answer', () => {
    // The closing line used to be appended here. It now grows the live process
    // box instead, so the answer area cannot flicker between one and two blocks
    // while the model is still writing.
    expect(liveAnswerText(live({ answer: report, content: closing }))).toBe(report)
  })

  it('falls back to the streaming text before any answer is frozen', () => {
    expect(liveAnswerText(live({ content: closing }))).toBe(closing)
    expect(liveAnswerText(undefined)).toBe('')
  })

  it('shows the second report as a process note instead of dropping it', () => {
    const settled = settleLiveAnswer(live({ content: recap, answer: report }), 'n-call-2')
    const process = liveProcess(settled)
    expect(process).not.toBeNull()
    expect(process?.text).toEqual([recap])
    expect(process?.parts?.map((part) => part.kind)).toEqual(['note'])
  })

  it('does not repeat the answer inside the process box', () => {
    expect(liveProcess(live({ answer: report }))).toBeNull()
  })
})

describe('streaming agrees with the stored transcript', () => {
  function message(overrides: Partial<StoredMessage>): StoredMessage {
    return {
      id: 'message-1',
      role: 'assistant',
      content: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      runId: 'run-1',
      ...overrides,
    }
  }

  it('shows exactly one answer when a run wrote two reports', () => {
    const stored = [
      message({ id: 'report', content: report }),
      message({ id: 'recap', content: recap }),
    ]
    const answers = answerMessageIds(stored)
    expect([...answers]).toEqual(['report'])

    const liveRun = settleLiveAnswer(live({ content: recap, answer: report }), 'n-call-2')
    expect(liveAnswerText(liveRun)).toBe(liveAnswerText(live({ answer: report })))
  })

  it('keeps text written after the answer in the process on both sides', () => {
    const stored = [
      message({ id: 'report', content: report }),
      message({ id: 'closing', content: closing }),
    ]
    const answers = answerMessageIds(stored)
    expect([...answers]).toEqual(['report'])
    const blocks = buildTranscript(stored)
    expect(blocks.filter((block) => block.kind === 'assistant')).toHaveLength(1)
    const process = blocks.find((block) => block.kind === 'process')
    expect(process?.kind === 'process' ? process.text : []).toEqual([closing])

    // The live view has to agree: the answer never changes and the text streamed
    // afterwards shows up in the step box as it arrives.
    const streamed = appendLiveProcessText(live({ answer: report }), closing)
    expect(liveAnswerText(streamed)).toBe(report)
    expect(liveProcess(streamed)?.text).toEqual([closing])
  })

  it('keeps a marked supplement after the report in the process on both sides', () => {
    // The prompt asks for a marker (补充：) instead of a second heading. The
    // renderer must not promote that sentence to an answer: the run keeps one
    // conclusion, and the supplement stays readable with the steps.
    const supplement = '补充：pdf2txt.mjs 只做了语法检查，未实跑转换。'
    expect(isDeliverableText(supplement)).toBe(false)
    const stored = [
      message({ id: 'report', content: report }),
      message({ id: 'supplement', content: supplement }),
    ]
    expect([...answerMessageIds(stored)]).toEqual(['report'])
    const blocks = buildTranscript(stored)
    expect(blocks.filter((block) => block.kind === 'assistant')).toHaveLength(1)
    const process = blocks.find((block) => block.kind === 'process')
    expect(process?.kind === 'process' ? process.text : []).toEqual([supplement])

    const streamed = appendLiveProcessText(live({ answer: report }), supplement)
    expect(liveAnswerText(streamed)).toBe(report)
    expect(liveProcess(streamed)?.text).toEqual([supplement])
  })

  it('grows one process note while a second block streams in', () => {
    let liveRun = live({ answer: report })
    for (const chunk of ['## 结果', '\n\n补充', ' 说明']) {
      liveRun = appendLiveProcessText(liveRun, chunk)
    }
    expect(liveRun.content).toBe('')
    expect(liveAnswerText(liveRun)).toBe(report)
    expect(liveRun.processText).toEqual(['## 结果\n\n补充 说明'])
    expect(liveRun.parts?.map((part) => part.kind)).toEqual(['note'])

    // A tool call after the streamed block closes it: the note is not duplicated.
    const settled = settleLiveAnswer(liveRun, 'n-call-2')
    expect(settled.processText).toEqual(['## 结果\n\n补充 说明'])
  })
})
