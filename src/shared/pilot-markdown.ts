/**
 * Pilot 生成 Markdown 时统一追加的品牌脚注。
 *
 * 用法只有两类，且都走同一个函数，保证正文末尾只有一行：
 * - 会话报告（预览 / 复制 / 保存同一份文本），见 `main/agent/session-report.ts`；
 * - Agent 的 `write_file` 写出的 `.md` / `.markdown` 文件，见 `main/agent/tools/files.ts`。
 *
 * 函数是幂等的：正文末尾已经有这行就直接返回，模型把带脚注的文件读回来再整体写回
 * 不会堆出第二行。`.pilot/` 下面放的是 Agent 自己的元数据（技能、hook 规则），
 * 不是给用户看的文档，用 `shouldStampPilotFooter` 排除。
 */

export const PILOT_MARKDOWN_LABEL = 'Powered by Pilot'

/** 正文末尾已经是「--- 空行 Powered by Pilot」（加粗也算）时视为已带脚注。 */
const FOOTER_AT_END = /(?:^|\n)[ \t]*(?:-{3,}[ \t]*\n+)?(?:\*\*)?Powered by Pilot(?:\*\*)?[ \t]*$/i

/** `.md` / `.markdown`，大小写不敏感；只看扩展名，不猜内容。 */
export function isMarkdownPath(path: string): boolean {
  return /\.(?:md|markdown)$/i.test(path.trim())
}

/**
 * 这个路径算不算「Pilot 生成的 Markdown 文档」。
 *
 * `.pilot/` 下的技能与 hook 规则由各自的构造器原样写出，加脚注会把元数据当成正文，
 * 所以一律跳过；其余 `.md` 都算。
 */
export function shouldStampPilotFooter(path: string): boolean {
  if (!isMarkdownPath(path)) return false
  const segments = path.trim().split(/[\\/]+/).map((segment) => segment.toLowerCase())
  return !segments.includes('.pilot')
}

/** 追加脚注；已带脚注时原样返回（只统一 CRLF 为 LF）。 */
export function withPilotFooter(markdown: string): string {
  const body = markdown.replace(/\r\n/g, '\n')
  if (FOOTER_AT_END.test(body.trimEnd())) return body
  const trimmed = body.trimEnd()
  const head = trimmed === '' ? '' : `${trimmed}\n\n---\n\n`
  return `${head}${PILOT_MARKDOWN_LABEL}\n`
}
