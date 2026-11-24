// 进程级共享的插件宿主。
//
// 以前每个「使用方」都自己 new 一个 PluginHost：智能体每一轮对话建一个、
// 手机关掉再连又建一个。于是同一个插件会被启动多次（重复的 Node 子进程，
// 还会并发写同一份 kv.json），而且定时触发器随宿主一起释放——桥一析构，
// `schedule` 触发器就悄悄失效，用户在插件页配好的定时任务永远不触发。
//
// 现在按 root（+ 可选的 stateRoot）共享同一个宿主：
// - 进程只起一份，工具调用与 HTTP 转发看到的是同一份运行状态；
// - 宿主不随一次对话结束而停止，`schedule` 定时器因此能一直跑；
// - 每个使用方通过 attachPluginHooks 挂自己的通知出口，用完 detach，
//   不会因为一个人退出而让另一个人的通知消失。
//
// 生命周期只在应用退出时收尾（stopSharedPluginHosts）。
import { PluginHost, type PluginHostOptions } from './runtime'
import type { ToolCatalogInputPlugin } from '../../shared/tools-catalog'

/** 插件向宿主推送消息的两个出口。 */
export interface PluginHostHooks {
  /** `host.notify`：插件想让人看到的一句话。 */
  notify?: (message: string) => void
  /** `host.emit`：插件主动广播的事件。 */
  onPluginEvent?: (pluginId: string, event: string, payload: unknown) => void
}

interface SharedHost {
  host: PluginHost
  hooks: Set<PluginHostHooks>
}

const hosts = new Map<string, SharedHost>()

function keyOf(options: PluginHostOptions): string {
  // stateRoot 决定插件私有的 kv 落点，不同的落点就是不同的运行环境。
  return options.stateRoot ? `${options.root}\u0000${options.stateRoot}` : options.root
}

/**
 * The one host for this workspace. The first caller's options decide the
 * process-level settings (root, timeout, env); later callers reuse them, which
 * is what keeps a single plugin process per workspace.
 */
export function sharedPluginHost(options: PluginHostOptions): PluginHost {
  const key = keyOf(options)
  const existing = hosts.get(key)
  if (existing) return existing.host
  const entry: SharedHost = { host: null as unknown as PluginHost, hooks: new Set() }
  // Hooks are resolved per message, so a plugin started before a UI attached
  // still reaches whoever is listening by the time it notifies.
  entry.host = new PluginHost({
    ...options,
    notify: (message) => {
      for (const hook of entry.hooks) hook.notify?.(message)
    },
    onPluginEvent: (pluginId, event, payload) => {
      for (const hook of entry.hooks) hook.onPluginEvent?.(pluginId, event, payload)
    },
  })
  hosts.set(key, entry)
  return entry.host
}

/**
 * Attach one caller's notification sinks. Returns a detach function; the
 * returned host keeps running after detach, so timers survive a finished run.
 */
export function attachPluginHooks(
  options: PluginHostOptions,
  hooks: PluginHostHooks,
): () => void {
  const entry = hosts.get(keyOf(options))
  if (!entry) return () => undefined
  entry.hooks.add(hooks)
  return () => {
    entry.hooks.delete(hooks)
  }
}

/** Re-read manifests and grants once per run without spawning anything. */
export async function reloadSharedPluginHosts(): Promise<void> {
  await Promise.all([...hosts.values()].map((entry) => entry.host.reload().catch(() => undefined)))
}

/**
 * Tools the agent would be offered right now, in catalog shape.
 *
 * Reads manifests and grants only (`toolDescriptors` never spawns), so the
 * tool panel can list plugin tools without starting a plugin process just to
 * draw a row. The shape matches `ToolCatalogInputPlugin` on purpose: the panel
 * wants to say "接口巡检 · 每 30 分钟" and not just a bare tool name.
 */
export async function pluginCatalogTools(
  workspacePath: string,
): Promise<ToolCatalogInputPlugin[]> {
  const host = sharedPluginHost({ root: workspacePath })
  const descriptors = await host.toolDescriptors().catch(() => [])
  return descriptors.map((descriptor) => ({
    id: descriptor.pluginId,
    name: descriptor.pluginName,
    tool: descriptor.name,
    fullName: descriptor.fullName,
    description: descriptor.description,
    risk: descriptor.risk,
  }))
}
/** Stop every plugin process. Call on application exit only. */
export async function stopSharedPluginHosts(): Promise<void> {
  const entries = [...hosts.values()]
  hosts.clear()
  await Promise.all(entries.map((entry) => entry.host.stopAll().catch(() => undefined)))
}

/** Test helper: forget the registry without stopping (stop first in real code). */
export async function resetSharedPluginHosts(): Promise<void> {
  await stopSharedPluginHosts()
}
