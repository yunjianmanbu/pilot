// 手机端 companion 的开关、配对、中继与根目录，以及插件管理。
// 由 index.ts 的 registerIpc 机械搬出：只把 handle 换成 ctx.handle，其余语句逐字保留。
import type { IpcContext } from '../ipc-context'
import {
  createPlugin,
  installMarketPlugin,
  installPlugin,
  pluginOverview,
  removePlugin,
  setPluginEnabled,
  setSignaturePolicy,
  signInstalledPlugin,
  trustPublicKey,
  untrustPublicKey,
} from '../plugins/studio'
import { app, dialog, shell } from 'electron'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { resolveExisting } from '../workspace'
import type {
  PluginCreateInput,
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
    return ctx.companion.setEnabled(enabled === true)
  })

  ctx.handle('pilot:companion-relay', async (url: unknown) => {
    if (!ctx.companion) throw new Error('手机连接尚未初始化')
    return ctx.companion.setRelayUrl(typeof url === 'string' ? url : '')
  })

  ctx.handle('pilot:companion-pairing', async () => {
    if (!ctx.companion) throw new Error('手机连接尚未初始化')
    return ctx.companion.createPairing()
  })

  ctx.handle('pilot:companion-pair-decision', (requestId: unknown, approved: unknown) => {
    if (!ctx.companion) throw new Error('手机连接尚未初始化')
    return ctx.companion.resolvePairing(String(requestId ?? ''), approved === true)
  })

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
