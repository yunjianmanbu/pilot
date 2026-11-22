// 会话与运行控制：sessions / chat / queue / run / checkpoints / changes / 审批。
// 由 server.ts 的 handleRequest switch 按域拆出；协议文案与错误提示保持原样。
import { sanitizeImages, sanitizeReferences } from '../../agent/attachments'
import { MAX_MESSAGE_CHARS } from '../constants'
import { requireString } from '../helpers'
import type { CompanionServer } from '../server'
import type { StoredPhone } from '../types'

export async function handleSessionRequest(
  host: CompanionServer,
  method: string,
  params: Record<string, unknown>,
  _phone: StoredPhone,
): Promise<unknown> {
  switch (method) {
    case 'sessions.list':
      return host.listSessions()
    case 'sessions.search':
      return host.searchSessions(params)
    case 'sessions.knowledge':
      return host.sessionKnowledge(params)
    case 'sessions.links':
      return host.sessionLinks(params)
    case 'sessions.tools':
      return host.sessionTools(params)
    case 'sessions.get':
    case 'sessions.history':
      return host.getSession(params)
    case 'sessions.create':
      return host.createSession(params)
    case 'sessions.rename':
      return host.renameSession(params)
    case 'sessions.approvalMode':
      return host.setApprovalMode(params)
    case 'sessions.model':
      return host.setSessionModel(params)
    case 'chat.send': {
      const sessionId = requireString(params['sessionId'], '会话', 80)
      const content = typeof params['content'] === 'string' ? params['content'] : ''
      if (content.length > MAX_MESSAGE_CHARS) {
        throw new Error(`消息长度不能超过 ${MAX_MESSAGE_CHARS} 个字符`)
      }
      const images = sanitizeImages(params['images'])
      const references = sanitizeReferences(params['references'])
      if (!content.trim() && images.length === 0) throw new Error('消息不能为空')
      const delivery = params['delivery'] === 'insert' ? 'insert' : 'queue'
      const result = await host.options.runner.sendMessage(sessionId, content, delivery, {
        images,
        references,
      })
      return result
    }
    case 'chat.stop': {
      const sessionId = requireString(params['sessionId'], '会话', 80)
      await host.options.runner.cancelRun(sessionId)
      return { ok: true }
    }
    case 'chat.pause': {
      const sessionId = requireString(params['sessionId'], '会话', 80)
      await host.options.runner.pauseRun(sessionId)
      return { ok: true }
    }
    case 'chat.resume': {
      const sessionId = requireString(params['sessionId'], '会话', 80)
      return host.options.runner.continueRun(sessionId)
    }
    case 'sessions.fork': {
      const sessionId = requireString(params['sessionId'], '会话', 80)
      if (host.options.runner.isRunning(sessionId)) {
        throw new Error('请先等待当前任务结束再创建副本')
      }
      return host.options.store.forkSession(sessionId)
    }
    case 'sessions.delete':
      return host.deleteSession(params)
    case 'run.retry': {
      const sessionId = requireString(params['sessionId'], '会话', 80)
      await host.options.runner.retryRun(sessionId)
      return { ok: true }
    }
    case 'chat.edit': {
      const sessionId = requireString(params['sessionId'], '会话', 80)
      const messageId = requireString(params['messageId'], '消息', 80)
      const content = typeof params['content'] === 'string' ? params['content'] : ''
      if (!content.trim()) throw new Error('消息不能为空')
      if (content.length > MAX_MESSAGE_CHARS) {
        throw new Error(`消息长度不能超过 ${MAX_MESSAGE_CHARS} 个字符`)
      }
      await host.options.runner.editMessage(sessionId, messageId, content)
      return { ok: true }
    }
    case 'chat.deleteMessage': {
      const sessionId = requireString(params['sessionId'], '会话', 80)
      const messageId = requireString(params['messageId'], '消息', 80)
      await host.options.runner.deleteMessage(sessionId, messageId)
      return { ok: true }
    }
    case 'chat.regenerate': {
      const sessionId = requireString(params['sessionId'], '会话', 80)
      await host.options.runner.regenerate(sessionId)
      return { ok: true }
    }
    case 'checkpoints.list': {
      const sessionId = requireString(params['sessionId'], '会话', 80)
      if (!host.options.checkpoints?.list) {
        throw new Error('当前电脑端版本不支持手机查看回退点')
      }
      return { checkpoints: await host.options.checkpoints.list(sessionId) }
    }
    case 'checkpoints.create': {
      const sessionId = requireString(params['sessionId'], '会话', 80)
      if (!host.options.checkpoints?.create) {
        throw new Error('当前电脑端版本不支持手机创建回退点')
      }
      if (host.options.runner.isRunning(sessionId)) {
        throw new Error('请先等待当前任务结束再创建回退点')
      }
      const label =
        typeof params['label'] === 'string' ? params['label'].trim().slice(0, 120) : ''
      return {
        checkpoint: await host.options.checkpoints.create(sessionId, label || undefined),
      }
    }
    case 'checkpoints.restore': {
      const sessionId = requireString(params['sessionId'], '会话', 80)
      const checkpointId = requireString(params['checkpointId'], '回退点', 120)
      const mode = params['mode']
      if (mode !== 'code' && mode !== 'conversation' && mode !== 'both') {
        throw new Error('回退方式无效')
      }
      if (!host.options.checkpoints?.restore) {
        throw new Error('当前电脑端版本不支持手机恢复回退点')
      }
      if (host.options.runner.isRunning(sessionId)) {
        throw new Error('请先等待当前任务结束再回退')
      }
      const result = await host.options.checkpoints.restore(sessionId, checkpointId, mode)
      host.notify({ type: 'session.changed', sessionId })
      return { result }
    }
    case 'changes.list': {
      const sessionId = requireString(params['sessionId'], '会话', 80)
      if (!host.options.changes?.list) {
        throw new Error('当前电脑端版本不支持手机查看变更')
      }
      return { changes: await host.options.changes.list(sessionId) }
    }
    case 'changes.revert': {
      const sessionId = requireString(params['sessionId'], '会话', 80)
      const file = requireString(params['path'], '文件', 2_000)
      if (!host.options.changes?.revert) {
        throw new Error('当前电脑端版本不支持手机撤销变更')
      }
      if (host.options.runner.isRunning(sessionId)) {
        throw new Error('请先等待当前任务结束再撤销变更')
      }
      const result = await host.options.changes.revert(sessionId, file)
      host.notify({ type: 'session.changed', sessionId })
      return { result }
    }
    case 'queue.remove': {
      const sessionId = requireString(params['sessionId'], '会话', 80)
      const taskId = requireString(params['taskId'], '排队消息', 80)
      await host.options.runner.removeQueueItem(sessionId, taskId)
      return { ok: true }
    }
    case 'queue.update': {
      const sessionId = requireString(params['sessionId'], '会话', 80)
      const taskId = requireString(params['taskId'], '排队消息', 80)
      const content = requireString(params['content'], '排队消息', 4_000)
      await host.options.runner.updateQueueItem(sessionId, taskId, content)
      return { ok: true }
    }
    case 'queue.move': {
      const sessionId = requireString(params['sessionId'], '会话', 80)
      const taskId = requireString(params['taskId'], '排队消息', 80)
      const direction = requireString(params['direction'], '方向', 8)
      if (direction !== 'up' && direction !== 'down') throw new Error('不支持的方向')
      await host.options.runner.moveQueueItem(sessionId, taskId, direction)
      return { ok: true }
    }
    case 'queue.toTodo': {
      const sessionId = requireString(params['sessionId'], '会话', 80)
      const taskId = requireString(params['taskId'], '排队消息', 80)
      const todo = await host.options.runner.convertQueueItemToTodo(sessionId, taskId)
      if (!todo) throw new Error('排队消息不存在')
      host.emitTodos(sessionId)
      return { todo }
    }
    case 'queue.insert': {
      const sessionId = requireString(params['sessionId'], '会话', 80)
      const taskId = requireString(params['taskId'], '排队消息', 80)
      await host.options.runner.insertQueueItem(sessionId, taskId)
      return { ok: true }
    }
    case 'approval.decide': {
      const callId = requireString(params['callId'], '审批请求', 120)
      const approved = params['approved'] === true
      const reason =
        typeof params['reason'] === 'string' ? params['reason'].slice(0, 500) : undefined
      await host.options.runner.decideApproval(callId, approved, reason)
      return { ok: true }
    }
    case 'approval.allowSession': {
      const callId = requireString(params['callId'], '审批请求', 120)
      const sessionId = requireString(params['sessionId'], '会话', 80)
      await host.options.store.updateSession(sessionId, { approvalMode: 'auto' })
      host.options.runner.setApprovalMode(sessionId, 'auto')
      await host.options.runner.decideApproval(callId, true)
      return { ok: true }
    }
    case 'approvals.list': {
      const sessionId =
        typeof params['sessionId'] === 'string' ? params['sessionId'].slice(0, 80) : undefined
      return { approvals: host.options.runner.pendingApprovalList(sessionId) }
    }
    default:
      throw new Error(`手机端不支持该操作：${method}`)
  }
}