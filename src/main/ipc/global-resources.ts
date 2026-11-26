// 跨会话聚合：全局链接与全局文档。
//
// 这两页要的答案在消息里（链接从正文提取、文档从工具调用提取），渲染进程
// 拿不到 transcript，所以汇总放在主进程做，一次调用返回按会话分组的全量结果，
// 和 `pilot:todos-all` 同一套路。
import type { IpcContext } from '../ipc-context'
import type { Session, SessionDocument, SessionDocumentGroup, SessionLinkGroup } from '../../shared/types'
import { collectSessionArtifacts } from '../agent/artifacts'
import { collectSessionLinks } from '../../shared/session-links'
import { officeDocumentKind } from '../../shared/office-documents'

/**
 * 每个工作区的会话，按 id 去重。
 *
 * `store.workspaces()` 只给工作区摘要，会话要逐工作区问；同一会话不会出现在
 * 两个工作区里，但去重能让「某个工作区被重复登记」这种脏数据不重复计数。
 */
function everySession(ctx: IpcContext): Session[] {
  const seen = new Set<string>()
  const out: Session[] = []
  for (const workspace of ctx.store.workspaces()) {
    for (const summary of ctx.store.sessions(workspace.path)) {
      if (seen.has(summary.id)) continue
      seen.add(summary.id)
      const session = ctx.store.session(summary.id)
      if (session) out.push(session)
    }
  }
  return out
}

export function registerGlobalLibraryIpc(ctx: IpcContext): void {
  ctx.handle('pilot:session-links-all', (): SessionLinkGroup[] => {
    const groups: SessionLinkGroup[] = []
    for (const session of everySession(ctx)) {
      const links = collectSessionLinks(session.messages)
      if (links.length === 0) continue
      groups.push({
        sessionId: session.id,
        sessionTitle: session.title,
        workspacePath: session.workspacePath,
        sessionUpdatedAt: session.updatedAt,
        links,
      })
    }
    return groups.sort((a, b) => b.sessionUpdatedAt.localeCompare(a.sessionUpdatedAt))
  })

  ctx.handle('pilot:session-documents-all', (): SessionDocumentGroup[] => {
    const groups: SessionDocumentGroup[] = []
    for (const session of everySession(ctx)) {
      const documents: SessionDocument[] = []
      const byPath = new Set<string>()
      for (const artifact of collectSessionArtifacts(session.messages)) {
        const kind = officeDocumentKind(artifact.path)
        if (!kind) continue
        // 同一会话里同一个文件被写两次只留一条：这里回答的是「有哪些文档」，
        // 不是「改过几次」。
        if (byPath.has(artifact.path)) continue
        byPath.add(artifact.path)
        documents.push({
          path: artifact.path,
          name: artifact.name,
          kind,
          action: artifact.action,
          tool: artifact.tool,
        })
      }
      if (documents.length === 0) continue
      groups.push({
        sessionId: session.id,
        sessionTitle: session.title,
        workspacePath: session.workspacePath,
        sessionUpdatedAt: session.updatedAt,
        documents,
      })
    }
    return groups.sort((a, b) => b.sessionUpdatedAt.localeCompare(a.sessionUpdatedAt))
  })
}
