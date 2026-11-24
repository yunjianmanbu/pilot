// 手机端 companion 的开关、配对、中继与根目录，以及插件管理。
// 由 index.ts 的 registerIpc 机械搬出：只把 handle 换成 ctx.handle，其余语句逐字保留。
import type { IpcContext } from '../ipc-context'
import {
  createPlugin,
  installBuiltinPlugin,
  installMarketPlugin,
  installPlugin,
  pluginOverview,
  removePlugin,
  setPluginEnabled,
  setPluginConfig,
  setSignaturePolicy,
  signInstalledPlugin,
  trustPublicKey,
  untrustPublicKey,
} from '../plugins/studio'
import { app, dialog, shell } from 'electron'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { DeepSeekClient } from '../agent/model'
import { draftPlugin, installDraftPlugin, DRAFT_MAX_OUTPUT_TOKENS } from '../plugins/assistant'
import { resolveExisting } from '../workspace'
import type {
  PluginCreateInput,
  PluginDraftInput,
  PluginDraftInstallInput,
  PluginInstallInput,
  PluginSignaturePolicy,
} from '../../shared/types'

export function registerCompanionIpc(ctx: IpcContext): void {


  ctx.handle('pilot:companion-status', () => {
    if (!ctx.companion) throw new Error('手机连接尚未初始化')
    return ctx.companion.status()
  })

  ctx.handle('pilot:companion-enabled', async (enabled: boolean) => {
    if (!ctx.companion) throw new Error('手机连接尚未初始化')
    // 「手机连接」与「网页服务」共用同一个服务实例：开关注入 mode control，
    // 由它跟设置里的端口合并后再决定启停（`pilot serve` 没有这个对象）。
    return ctx.companionMode
      ? ctx.companionMode.setPhoneEnabled(enabled === true)
      : ctx.companion.setEnabled(enabled === true)
  })

  ctx.handle('pilot:companion-relay', async (url: unknown) => {
    if (!ctx.companion) throw new Error('手机连接尚未初始化')
    return ctx.companion.setRelayUrl(typeof url === 'string' ? url : '')
  })

  ctx.handle('pilot:companion-pairing', async () => {
    if (!ctx.companion) throw new Error('手机连接尚未初始化')
    return ctx.companion.createPairing()
  })

  ctx.handle(
    'pilot:companion-pair-decision',
    (requestId: unknown, approved: unknown, role: unknown) => {
      if (!ctx.companion) throw new Error('手机连接尚未初始化')
      // 角色只对浏览器直连申请有效，且必须是审批页明确选的；其它值一律当成客户机。
      const granted = role === 'host' ? 'host' : role === 'client' ? 'client' : undefined
      return ctx.companion.resolvePairing(String(requestId ?? ''), approved === true, granted)
    },
  )

  ctx.handle('pilot:companion-revoke', async (phoneId: string) => {
    if (!ctx.companion) throw new Error('手机连接尚未初始化')
    return ctx.companion.revoke(phoneId)
  })

  ctx.handle('pilot:companion-local-url', () => ctx.companion?.localUrl() ?? '')

  ctx.handle('pilot:companion-roots', () => ctx.store.phoneRoots())

  ctx.handle('pilot:companion-root-add', async (path: string) => {
    return ctx.store.addPhoneRoot(String(path || ''))
  })

  ctx.handle('pilot:companion-root-remove', async (path: string) => {
    return ctx.store.removePhoneRoot(String(path || ''))
  })

  ctx.handle('pilot:companion-app-qr', async () => {
    if (!ctx.companion) throw new Error('手机连接尚未初始化')
    return ctx.companion.appQr()
  })


  // ── Plugin market and plugin assistant ────────────────────────────────────
  // Every handler resolves the workspace first, so a stale renderer path cannot
  // make the main process write into an unrelated directory.
  ctx.handle('pilot:plugins-overview', async (path: string) => {
    await resolveExisting(path, '.')
    return pluginOverview(path)
  })

  ctx.handle('pilot:plugin-pick-dir', async (title?: string) => {
    if (!ctx.mainWindow) return null
    const result = await dialog.showOpenDialog(ctx.mainWindow, {
      title: typeof title === 'string' && title ? title : '选择插件创建目录',
      buttonLabel: '使用此目录',
      properties: ['openDirectory', 'createDirectory'],
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  })

  ctx.handle('pilot:plugin-create', async (input: PluginCreateInput) => {
    if (!input || typeof input !== 'object') throw new Error('缺少创建参数')
    // The target directory is outside the workspace by design (the user picks
    // it), so it is validated by createPlugin itself: id pattern, empty target.
    const created = await createPlugin({
      targetDir: String(input.targetDir ?? ''),
      id: String(input.id ?? ''),
      name: String(input.name ?? ''),
      description: String(input.description ?? ''),
      template: input.template ?? 'http',
      sign: input.sign === true,
    })
    const workspace = ctx.store.activeWorkspace()
    if (workspace) ctx.broadcast({ type: 'plugins.changed', workspacePath: workspace })
    return created
  })

  ctx.handle('pilot:plugin-install', async (path: string, input: PluginInstallInput) => {
    await resolveExisting(path, '.')
    if (!input || typeof input !== 'object') throw new Error('缺少导入参数')
    const result = await installPlugin({
      workspace: path,
      sourceDir: String(input.sourceDir ?? ''),
      trust: input.trust === true,
      publicKey: input.publicKey ? String(input.publicKey) : undefined,
      force: input.force === true,
      label: input.label ? String(input.label) : undefined,
    })
    ctx.broadcast({ type: 'plugins.changed', workspacePath: path })
    return result
  })

  ctx.handle('pilot:plugin-install-market', async (path: string, id: string) => {
    await resolveExisting(path, '.')
    const result = await installMarketPlugin(path, String(id ?? ''))
    ctx.broadcast({ type: 'plugins.changed', workspacePath: path })
    return result
  })

  ctx.handle('pilot:plugin-install-builtin', async (path: string, id: string) => {
    await resolveExisting(path, '.')
    const result = await installBuiltinPlugin(path, String(id ?? ''))
    ctx.broadcast({ type: 'plugins.changed', workspacePath: path })
    return result
  })

  // ── Conversational plugin authoring ──────────────────────────────────────
  // The model writes code, so this reuses the session model (same one the agent
  // runs on) and returns a draft only: nothing touches the disk until the user
  // presses “write and enable”.
  ctx.handle('pilot:plugin-draft', async (path: string, input: PluginDraftInput) => {
    await resolveExisting(path, '.')
    if (!input || typeof input !== 'object') throw new Error('缺少插件需求')
    const target = ctx.store.sessionModelTarget() ?? ctx.store.reflectModelTarget()
    if (!target) throw new Error('还没有配置可用的模型 API Key，请到设置 → 模型里添加。')
    const client = new DeepSeekClient({
      apiKey: target.apiKey,
      baseUrl: target.baseUrl,
      model: target.model,
      maxOutputTokens: DRAFT_MAX_OUTPUT_TOKENS,
      temperature: 0.3,
    })
    return draftPlugin(
      { prompt: String(input.prompt ?? ''), history: input.history, id: input.id },
      {
        workspace: path,
        modelLabel: target.model,
        complete: async (messages, signal) => {
          const response = await client.complete({ messages, tools: [], signal })
          return response.content ?? ''
        },
      },
    )
  })

  ctx.handle('pilot:plugin-draft-install', async (path: string, input: PluginDraftInstallInput) => {
    await resolveExisting(path, '.')
    if (!input || typeof input !== 'object') throw new Error('缺少插件草稿')
    const result = await installDraftPlugin(path, {
      id: String(input.id ?? ''),
      manifestJson: String(input.manifestJson ?? ''),
      entry: String(input.entry ?? ''),
      enable: input.enable !== false,
      sign: input.sign === true,
      readme: input.readme ? String(input.readme) : undefined,
    })
    ctx.broadcast({ type: 'plugins.changed', workspacePath: path })
    return result
  })

  ctx.handle('pilot:plugin-remove', async (path: string, id: string) => {
    await resolveExisting(path, '.')
    await removePlugin(path, String(id ?? ''))
    ctx.broadcast({ type: 'plugins.changed', workspacePath: path })
    return pluginOverview(path)
  })

  ctx.handle('pilot:plugin-enabled', async (path: string, id: string, enabled: boolean) => {
    await resolveExisting(path, '.')
    await setPluginEnabled(path, String(id ?? ''), enabled === true)
    ctx.broadcast({ type: 'plugins.changed', workspacePath: path })
    return pluginOverview(path)
  })

  ctx.handle('pilot:plugin-config', async (path: string, id: string, config: Record<string, unknown>) => {
    await resolveExisting(path, '.')
    await setPluginConfig(path, String(id ?? ''), config ?? {})
    ctx.broadcast({ type: 'plugins.changed', workspacePath: path })
    return pluginOverview(path)
  })

  ctx.handle('pilot:plugin-sign', async (path: string, id: string) => {
    await resolveExisting(path, '.')
    const { signature } = await signInstalledPlugin(path, String(id ?? ''))
    ctx.broadcast({ type: 'plugins.changed', workspacePath: path })
    return signature
  })

  ctx.handle('pilot:plugin-trust', async (path: string, publicKey: string, label?: string) => {
    await resolveExisting(path, '.')
    await trustPublicKey(path, String(publicKey ?? ''), label ? String(label) : undefined)
    ctx.broadcast({ type: 'plugins.changed', workspacePath: path })
    return pluginOverview(path)
  })

  ctx.handle('pilot:plugin-untrust', async (path: string, keyId: string) => {
    await resolveExisting(path, '.')
    await untrustPublicKey(path, String(keyId ?? ''))
    ctx.broadcast({ type: 'plugins.changed', workspacePath: path })
    return pluginOverview(path)
  })

  ctx.handle('pilot:plugin-policy', async (path: string, policy: PluginSignaturePolicy) => {
    await resolveExisting(path, '.')
    await setSignaturePolicy(path, policy)
    ctx.broadcast({ type: 'plugins.changed', workspacePath: path })
    return pluginOverview(path)
  })

  ctx.handle('pilot:plugin-reveal', async (dir: string) => {
    const target = resolve(String(dir ?? ''))
    if (!existsSync(target)) throw new Error('目录不存在')
    shell.showItemInFolder(target)
  })
}
