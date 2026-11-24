/**
 * 通知标题取「用户这一次到底说了什么」，而不是自动生成的会话名。
 *
 * 会话名是模型或首句摘要起的（「新任务」「修复构建」），它在通知里只说明
 * 「哪个会话」，看不出一件事是什么。用户收到「Pilot · 任务完成 · 新任务」
 * 时无法判断要不要点开，所以标题改成指令原文的第一行，会话名退到正文。
 *
 * 只挑「真正的用户输入」：继续/压缩这类内部控制消息（`control`）、折叠历史
 * 时写入的摘要（`contextSummary` / `earlierWork`）都不是用户说的话，绝不能
 * 冒充成任务标题。优先取本次 run 的那条指令，找不到才退回会话最近一条。
 */
import type { StoredMessage } from '../../shared/types'

/** 桌面通知标题在 Windows/macOS 上都只显示一行，40 字以内不会被系统再截一次。 */
export const NOTIFY_TITLE_LIMIT = 40
/** 邮件主题能显示得更长一些。 */
export const MAIL_TITLE_LIMIT = 60

type InstructionMessage = Pick<
  StoredMessage,
  'role' | 'content' | 'control' | 'contextSummary' | 'earlierWork' | 'runId'
>

/** 把一条指令压成一行可读文本：去掉 markdown 记号与多余空白，保留原话。 */
export function cleanInstruction(raw: string): string {
  const withoutBlocks = raw.replace(/```[\s\S]*?```/g, ' ')
  const withoutImages = withoutBlocks.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  const withoutLinks = withoutImages.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  const firstLine =
    withoutLinks
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== '') ?? ''
  return firstLine
    .replace(/^[#>]+/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/`/g, '')
    .replace(/\*\*|__/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 按码点截断：emoji 与中文不会被切成半个字符。 */
export function clipInstruction(text: string, limit = NOTIFY_TITLE_LIMIT): string {
  const chars = Array.from(text)
  if (chars.length <= limit) return text
  return `${chars.slice(0, Math.max(1, limit - 1)).join('')}…`
}

function isInstruction(message: InstructionMessage): boolean {
  return (
    message.role === 'user' &&
    !message.control &&
    !message.contextSummary &&
    !message.earlierWork
  )
}

/**
 * 取本次运行的用户指令；`runId` 缺失或对不上时退回会话里最近一条用户指令。
 * 返回空串表示这条会话没有任何真实用户输入，调用方自己决定退到什么文案。
 */
export function instructionOf(
  messages: ReadonlyArray<InstructionMessage>,
  runId?: string,
): string {
  if (runId) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message && message.runId === runId && isInstruction(message)) {
        const text = cleanInstruction(message.content)
        if (text) return text
      }
    }
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message && isInstruction(message)) {
      const text = cleanInstruction(message.content)
      if (text) return text
    }
  }
  return ''
}

export interface InstructionTitleOptions {
  /** 没有指令时的兜底文案（通常是「当前任务」）。 */
  fallback: string
  limit?: number
}

/** 通知标题：本次指令的截断版，空则用兜底文案。 */
export function instructionTitle(
  messages: ReadonlyArray<InstructionMessage>,
  runId: string | undefined,
  options: InstructionTitleOptions,
): string {
  const text = instructionOf(messages, runId)
  if (!text) return options.fallback
  return clipInstruction(text, options.limit ?? NOTIFY_TITLE_LIMIT)
}
