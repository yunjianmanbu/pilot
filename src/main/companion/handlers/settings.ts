// 设置与桌面能力：设备信息、模块自检、学习、记忆、快捷命令、系统、工具、更新、进化、模型、计费、配对。
// 由 server.ts 的 handleRequest switch 按域拆出；协议文案与错误提示保持原样。
import type { MemoryEntry, ModuleCheckSettings, QuickCommand, QuickCommandInput, SystemInfo } from '../../../shared/types'
import { normalizeLearningHostsInput } from '../../agent/learning'
import { sessionMemories } from '../../../shared/memory'
import { sandboxStatus } from '../../sandbox'
import { systemInfo } from '../../system-info'
import { requireString } from '../helpers'
import type { CompanionServer } from '../server'
import type { StoredPhone } from '../types'

export async function handleSettingsRequest(
  host: CompanionServer,
  method: string,
  params: Record<string, unknown>,
  phone: StoredPhone,
): Promise<unknown> {
  switch (method) {
    case 'pairing.transfer': {
      // 只回传二维码图片和过期时间；二维码载荷本身就是凭证，不再额外
      // 下发可复制的链接文本。生成入口只对已认证的手机开放。
      const pairing = await host.createTransferPairing()
      return {
        qrDataUrl: pairing.qrDataUrl,
        expiresAt: pairing.expiresAt,
        mode: pairing.mode,
      }
    }
    case 'device.info':
      return {
        deviceName: host.options.deviceName,
        platform: process.platform,
        appVersion: host.options.appVersion,
        model: host.options.store.settingsView().model,
        theme: host.options.store.settingsView().theme,
        phoneName: phone.name,
        capabilities: host.capabilities(),
      }
    case 'moduleCheck.state': {
      if (!host.options.moduleCheck?.state) {
        throw new Error('当前电脑端版本不支持手机模块自检')
      }
      return { state: host.phoneModuleCheckState(await host.options.moduleCheck.state()) }
    }
    case 'moduleCheck.discover': {
      if (!host.options.moduleCheck?.discover) {
        throw new Error('当前电脑端版本不支持手机模块自检')
      }
      const source = host.options.moduleCheck.source?.() ?? null
      return {
        // 自检已经只扫内置源码：`source` 是新字段，`workspace` 保留给旧手机端。
        source,
        workspace: source,
        modules: await host.options.moduleCheck.discover(),
      }
    }
    case 'moduleCheck.run': {
      if (!host.options.moduleCheck?.run) {
        throw new Error('当前电脑端版本不支持手机模块自检')
      }
      const raw = params['moduleIds']
      if (raw !== undefined && !Array.isArray(raw)) {
        throw new Error('模块列表格式不正确')
      }
      const moduleIds = Array.isArray(raw)
        ? raw
            .filter((id): id is string => typeof id === 'string')
            .map((id) => id.trim().slice(0, 120))
            .filter(Boolean)
            .slice(0, 200)
        : undefined
      const report = await host.options.moduleCheck.run(
        moduleIds && moduleIds.length > 0 ? moduleIds : undefined,
      )
      return { report: host.phoneModuleCheckReport(report) }
    }
    case 'moduleCheck.settings': {
      if (!host.options.moduleCheck?.settings) {
        throw new Error('当前电脑端版本不支持手机模块自检')
      }
      const raw = params['settings']
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('自检设置格式不正确')
      }
      const record = raw as Record<string, unknown>
      const input: Partial<ModuleCheckSettings> = {}
      if (typeof record['enabled'] === 'boolean') input.enabled = record['enabled']
      if (typeof record['intervalHours'] === 'number' && Number.isFinite(record['intervalHours'])) {
        input.intervalHours = Math.max(1, Math.min(24 * 30, Math.round(record['intervalHours'])))
      }
      if (Array.isArray(record['modules'])) {
        input.modules = record['modules']
          .filter((id): id is string => typeof id === 'string')
          .map((id) => id.trim().slice(0, 120))
          .filter(Boolean)
          .slice(0, 200)
      }
      return {
        state: host.phoneModuleCheckState(await host.options.moduleCheck.settings(input)),
      }
    }
    case 'moduleCheck.accept': {
      if (!host.options.moduleCheck?.accept) {
        throw new Error('当前电脑端版本不支持手机模块自检')
      }
      const reportId = requireString(params['reportId'], '自检报告', 120)
      const raw = params['riskIds']
      if (!Array.isArray(raw)) throw new Error('请先勾选要优化的风险点')
      const riskIds = raw
        .filter((id): id is string => typeof id === 'string')
        .map((id) => id.trim().slice(0, 200))
        .filter(Boolean)
        .slice(0, 200)
      if (riskIds.length === 0) throw new Error('请先勾选要优化的风险点')
      // 默认只生成提案：手机端必须显式传 selfModify=true 才会真的改源码。
      const selfModify = params['selfModify'] === true
      const result = await host.options.moduleCheck.accept(reportId, riskIds, selfModify)
      return {
        ...(result.sessionId ? { sessionId: result.sessionId } : {}),
        queued: result.queued === true,
        selfModify: result.selfModify,
        proposalId: result.proposalId,
      }
    }
    case 'selfCheck.run': {
      if (!host.options.selfCheck?.run) {
        throw new Error('当前电脑端版本不支持手机内视')
      }
      // 只读：不传路径、不建会话，也不改任何文件。
      return { report: await host.options.selfCheck.run() }
    }
    case 'learning.state': {
      const workspacePath = requireString(params['workspacePath'], '工作区', 2_000)
      host.assertWorkspace(workspacePath)
      return { state: await host.phoneLearningState(workspacePath) }
    }
    case 'learning.settings': {
      const workspacePath = requireString(params['workspacePath'], '工作区', 2_000)
      host.assertWorkspace(workspacePath)
      const raw = params['settings']
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('学习设置格式不正确')
      }
      const record = raw as Record<string, unknown>
      const input: { learningMode?: boolean; learningHosts?: string[] } = {}
      if (typeof record['enabled'] === 'boolean') input.learningMode = record['enabled']
      if (record['hosts'] !== undefined) {
        if (!Array.isArray(record['hosts'])) throw new Error('学习来源白名单格式不正确')
        // 白名单会进入模型提示词；只接受裸主机名，本机/内网地址直接拒绝。
        input.learningHosts = normalizeLearningHostsInput(record['hosts'])
      }
      if (Object.keys(input).length === 0) throw new Error('没有需要保存的学习设置')
      await host.options.store.updateSettings(input)
      // Keep an open desktop settings window in step with the phone.
      host.options.onEvent?.({
        type: 'settings.changed',
        settings: host.options.store.settingsView(),
      })
      return { state: await host.phoneLearningState(workspacePath) }
    }
    case 'memory.list': {
      const workspacePath = requireString(params['workspacePath'], '工作区', 2_000)
      host.assertWorkspace(workspacePath)
      const detail = await host.options.store.workspaceDetail(workspacePath)
      return { memory: detail.memory }
    }
    /**
     * 「会话记忆」：这个会话注入过 / 写下的条目，连同它们的来源标记。
     * 记忆本体仍是工作区级，手机端只拿这份过滤后的视图。
     */
    case 'memory.session': {
      const sessionId = requireString(params['sessionId'], '会话', 80)
      const session = host.options.store.session(sessionId)
      if (!session) throw new Error('会话不存在')
      const detail = await host.options.store.workspaceDetail(session.workspacePath)
      const rows = sessionMemories(detail.memory, session)
      return {
        memory: rows.map((row) => ({ ...row.entry, injected: row.injected, written: row.written })),
      }
    }
    case 'memory.add': {
      const workspacePath = requireString(params['workspacePath'], '工作区', 2_000)
      host.assertWorkspace(workspacePath)
      const content = typeof params['content'] === 'string' ? params['content'].trim() : ''
      if (!content) throw new Error('记忆内容不能为空')
      if (content.length > 2_000) throw new Error('记忆内容不能超过 2000 个字符')
      const entry: MemoryEntry = await host.options.store.addMemory(
        workspacePath,
        content,
        'user',
      )
      host.notify({ type: 'memory.changed', workspacePath })
      return { entry }
    }
    case 'memory.remove': {
      const workspacePath = requireString(params['workspacePath'], '工作区', 2_000)
      host.assertWorkspace(workspacePath)
      const memoryId = requireString(params['memoryId'], '记忆', 80)
      await host.options.store.deleteMemory(workspacePath, memoryId)
      host.notify({ type: 'memory.changed', workspacePath })
      return { ok: true }
    }
    case 'quickCommands.get': {
      const commands: QuickCommand[] | null = host.options.store.quickCommands()
      return { commands }
    }
    case 'quickCommands.save': {
      const raw = Array.isArray(params['commands']) ? params['commands'] : []
      const commands: QuickCommandInput[] = raw
        .map((item) => {
          if (!item || typeof item !== 'object') return null
          const record = item as Record<string, unknown>
          const content =
            typeof record['content'] === 'string' ? record['content'].trim().slice(0, 500) : ''
          if (!content) return null
          const id =
            typeof record['id'] === 'string' && record['id'].trim()
              ? record['id'].trim().slice(0, 80)
              : undefined
          return { content, ...(id ? { id } : {}) }
        })
        .filter((item): item is QuickCommandInput => item !== null)
        .slice(0, 8)
      return { commands: await host.options.store.saveQuickCommands(commands) }
    }
    case 'sandbox.status':
      return { status: await sandboxStatus() }
    case 'system.info': {
      // 手机不接受路径参数：只测量当前工作区所在卷，避免把已配对手机
      // 变成任意磁盘的探测器。没有工作区时退回进程目录。
      const workspace = host.options.store.activeWorkspace() || undefined
      const info: SystemInfo = await systemInfo(workspace)
      return { info }
    }
    case 'tools.list': {
      const workspacePath = requireString(params['workspacePath'], '工作区', 2_000)
      host.assertWorkspace(workspacePath)
      const registry = await host.toolRegistry(workspacePath)
      return { tools: await registry.list() }
    }
    case 'update.state': {
      return { state: host.requireUpdate().state() }
    }
    case 'update.check': {
      return { state: await host.requireUpdate().check() }
    }
    case 'update.download': {
      const update = host.requireUpdate()
      const current = update.state()
      // 下载可能持续几分钟，手机请求不能一直挂着；开始后立即返回，
      // 后续进度通过 update.changed 事件推送。
      if (current.status === 'available') {
        void update.download().catch(() => undefined)
      }
      return { state: update.state() }
    }
    case 'update.install': {
      const update = host.requireUpdate()
      const running =
        typeof host.options.runner.activeRunCount === 'function'
          ? host.options.runner.activeRunCount()
          : 0
      if (running > 0) {
        throw new Error('电脑上还有任务正在执行，请等任务结束后再安装更新。')
      }
      await update.install()
      return { ok: true }
    }
    case 'evolution.state': {
      const workspacePath = requireString(params['workspacePath'], '工作区', 2_000)
      host.assertWorkspace(workspacePath)
      return host.requireEvolution().snapshot(workspacePath)
    }
    case 'evolution.personal':
      return host.requireEvolution().personal()
    case 'evolution.action': {
      const action = requireString(params['action'], '操作', 40)
      return host.requireEvolution().action(action, params)
    }
    case 'models.get': {
      // Public resource list and role selections; keys never leave the desktop.
      return host.options.store.modelSettingsView()
    }
    case 'models.update': {
      const input: {
        sessionModelId?: string
        evaluationModelIds?: string[]
        reviewModelId?: string
      } = {}
      if (params['sessionModelId'] !== undefined) {
        input.sessionModelId = requireString(params['sessionModelId'], '会话模型', 80)
      }
      if (params['reviewModelId'] !== undefined) {
        input.reviewModelId =
          typeof params['reviewModelId'] === 'string'
            ? params['reviewModelId'].slice(0, 80)
            : ''
      }
      if (params['evaluationModelIds'] !== undefined) {
        if (!Array.isArray(params['evaluationModelIds'])) {
          throw new Error('评估模型格式不正确')
        }
        input.evaluationModelIds = params['evaluationModelIds']
          .filter((item): item is string => typeof item === 'string')
          .slice(0, 6)
      }
      await host.options.store.updateSettings(input)
      host.options.billing.invalidate?.()
      // Keep an open desktop settings window in step with the phone.
      host.options.onEvent?.({
        type: 'settings.changed',
        settings: host.options.store.settingsView(),
      })
      return host.options.store.modelSettingsView()
    }
    case 'billing.get':
      // Balance and local usage only; the API key never leaves the main process.
      return host.options.billing.report(params['refresh'] === true)
    case 'ping':
      return { ok: true, t: Date.now() }
    default:
      throw new Error(`手机端不支持该操作：${method}`)
  }
}