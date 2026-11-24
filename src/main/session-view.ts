// 会话只读视图：消息片段、页码切片与评审根目录解析。
import type {
  ReviewRoot,
  ReviewSessionInput,
  Session,
  SessionPage,
  StoredMessage,
} from '../shared/types'
import { workspaceRoot } from './workspace'
import { sessionPage } from './session-page'
import { session } from 'electron'
import { basename, join, resolve } from 'node:path'

export { sessionPage }
export function pathKey(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

/**
 * Resolve every review root through realpath before it is persisted. The
 * primary workspace is always first and is the default root for file tools.
 */
export async function resolveReviewRoots(
  primaryInput: string,
  requested: ReviewSessionInput['roots'],
): Promise<ReviewRoot[]> {
  const primary = await workspaceRoot(primaryInput)
  const candidates: Array<{ path: string; name?: string }> = []
  const requestedPrimary = Array.isArray(requested)
    ? requested.find(
        (entry) =>
          entry &&
          typeof entry.path === 'string' &&
          pathKey(resolve(entry.path)) === pathKey(primary),
      )
    : undefined
  candidates.push({
    path: primary,
    ...(requestedPrimary?.name ? { name: requestedPrimary.name } : {}),
  })
  if (Array.isArray(requested)) {
    for (const entry of requested.slice(0, 8)) {
      if (!entry || typeof entry.path !== 'string' || !entry.path.trim()) continue
      candidates.push({
        path: entry.path.trim(),
        ...(typeof entry.name === 'string' ? { name: entry.name } : {}),
      })
    }
  }
  const seenPaths = new Set<string>()
  const seenNames = new Set<string>()
  const roots: ReviewRoot[] = []
  for (const candidate of candidates) {
    if (roots.length >= 8) break
    const resolved = await workspaceRoot(candidate.path)
    const key = pathKey(resolved)
    if (seenPaths.has(key)) continue
    seenPaths.add(key)
    const base =
      (candidate.name ?? '').trim().replace(/[\\/]+/g, '-').slice(0, 40) ||
      basename(resolved) ||
      'root'
    let name = base
    let suffix = 2
    while (seenNames.has(name.toLowerCase())) {
      name = `${base.slice(0, 36)}-${suffix}`
      suffix += 1
    }
    seenNames.add(name.toLowerCase())
    roots.push({ name, path: resolved })
  }
  if (roots.length === 0) throw new Error('复盘至少需要一个可读取的目录')
  return roots
}

/** Full transcript used by "copy whole conversation" even when the UI only holds a page. */
export function transcriptText(messages: StoredMessage[]): string {
  const parts: string[] = []
  for (const message of messages) {
    if (message.role === 'user' && !message.control) {
      if (message.content.trim()) parts.push(`## 我\n${message.content.trim()}`)
      continue
    }
    if (message.role === 'assistant') {
      if (message.content.trim()) parts.push(`## Pilot\n${message.content.trim()}`)
      for (const call of message.toolCalls ?? []) {
        const args = JSON.stringify(call.arguments ?? {})
        parts.push(`> 调用 ${call.name} ${args.length > 400 ? `${args.slice(0, 400)}…` : args}`)
      }
      continue
    }
    if (message.role === 'tool' && message.content.trim()) {
      const body = message.content.trim()
      parts.push(
        `> ${message.name ?? 'tool'} ${message.isError ? '失败' : '完成'}\n${body.length > 4_000 ? `${body.slice(0, 4_000)}…` : body}`,
      )
    }
  }
  return parts.join('\n\n')
}

/** Center a page on a search hit so the target message is always present. */
export function sessionPageAround(session: Session, messageId: string, limit = 120): SessionPage {
  const safeLimit = Math.max(1, Math.min(300, Math.round(limit) || 120))
  const index = session.messages.findIndex((message) => message.id === messageId)
  if (index < 0) return sessionPage(session, undefined, safeLimit)
  const half = Math.floor(safeLimit / 2)
  const start = Math.max(0, index - half)
  const end = Math.min(session.messages.length, start + safeLimit)
  return {
    session: {
      ...session,
      messages: session.messages.slice(start, end),
      messageCount: session.messages.length,
    },
    hasMore: start > 0,
    hasNewer: end < session.messages.length,
  }
}
