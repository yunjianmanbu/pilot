// 插件工具桥：把已启用插件在 manifest 里声明的 `tools` 变成 agent 可调用的工具。
//
// 三条边界保持不变：
// 1. 工具只是「已声明路由」的别名，插件无法通过 tools 打开新的 HTTP 面；
// 2. 每次调用仍走宿主的权限、限流与超时检查（`plugin.tool`）；
// 3. 插件被停用（grants.json 里 enabled:false）时工具当场消失。
//
// 每个 run 建一个桥：一次读盘、一次进入 LLM 工具列表，run 结束就只摘掉
// 通知出口。插件进程本身由 plugins/shared 里的共享宿主持有，所以 run 之间
// 的定时触发器不会随桥释放，用户在插件页改了配置或开关也仍在下一轮生效。
import { type PluginHost, type PluginToolDescriptor } from '../plugins/runtime'
import { attachPluginHooks, sharedPluginHost } from '../plugins/shared'
import type { AgentToolDefinition, ToolResult } from '../../shared/types'

/** 插件工具名与内置/MCP 工具之间不会撞名：宿主统一加 `plugin__<id>__` 前缀。 */
export interface PluginToolBridgeOptions {
  /** Workspace root holding `.pilot/plugins`. */
  workspacePath: string
  /** 插件通过 `host.notify` 发出的消息（写进会话提示条）。 */
  notify?: (message: string) => void
  /** 插件主动 `host.emit` 的事件。 */
  onPluginEvent?: (pluginId: string, event: string, payload: unknown) => void
}

export class PluginToolBridge {
  private readonly byName = new Map<string, PluginToolDescriptor>()

  private constructor(
    private readonly host: PluginHost,
    descriptors: PluginToolDescriptor[],
    private readonly detach: () => void,
  ) {
    for (const descriptor of descriptors) this.byName.set(descriptor.fullName, descriptor)
  }

  /**
   * Read the workspace's plugins. A broken plugin directory must not stop a
   * run: `toolDescriptors()` reports invalid manifests separately and only
   * enabled ones contribute tools.
   */
  static async create(options: PluginToolBridgeOptions): Promise<PluginToolBridge> {
    const hostOptions = { root: options.workspacePath }
    const host = sharedPluginHost(hostOptions)
    const detach = attachPluginHooks(hostOptions, {
      ...(options.notify ? { notify: options.notify } : {}),
      ...(options.onPluginEvent ? { onPluginEvent: options.onPluginEvent } : {}),
    })
    let descriptors: PluginToolDescriptor[] = []
    try {
      // 共享宿主是常驻的，新装的插件不会自己冒出来：每轮先读一次盘。
      await host.reload()
      descriptors = await host.toolDescriptors()
    } catch {
      // 读不到插件目录时按「没有插件」处理，工具列表照旧。
      descriptors = []
    }
    return new PluginToolBridge(host, descriptors, detach)
  }

  /** Definitions handed to the model; each carries its own manifest risk. */
  tools(): AgentToolDefinition[] {
    const out: AgentToolDefinition[] = []
    for (const descriptor of this.byName.values()) {
      const manifestRisk = descriptor.risk
      out.push({
        name: descriptor.fullName,
        description: `[插件 ${descriptor.pluginName}] ${descriptor.description}`.slice(0, 1_000),
        inputSchema: descriptor.inputSchema,
        risk: manifestRisk,
        source: 'plugin',
      })
    }
    return out
  }

  has(name: string): boolean {
    return this.byName.has(name)
  }

  /**
   * Run one tool. The host already refused disabled plugins when it built the
   * descriptor list; a stop between then and the call surfaces as a PluginError
   * which is returned as a failed tool result rather than thrown into the run.
   */
  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const descriptor = this.byName.get(name)
    if (!descriptor) return { ok: false, output: '', error: `Unknown plugin tool: ${name}` }
    const startedAt = Date.now()
    try {
      const result = await this.host.toolCall(descriptor.pluginId, descriptor.name, args ?? {})
      const durationMs = Date.now() - startedAt
      const body = result.body === null || result.body === undefined ? '' : result.body
      const output =
        typeof body === 'string' ? body : safeStringify(body)
      return {
        ok: result.status >= 200 && result.status < 300,
        output,
        ...(result.status >= 200 && result.status < 300
          ? {}
          : { error: `插件返回 ${result.status}` }),
        durationMs,
        risk: descriptor.risk,
        metadata: { pluginId: descriptor.pluginId, status: result.status },
      }
    } catch (error) {
      return {
        ok: false,
        output: '',
        error: `插件 ${descriptor.pluginId}/${descriptor.name}：${
          error instanceof Error ? error.message : String(error)
        }`,
        durationMs: Date.now() - startedAt,
        risk: descriptor.risk,
      }
    }
  }

  /**
   * Deliver one host event to whichever plugins declared it. Called after a run
   * finishes and when a session is created; failures stay inside the plugin
   * (they surface in its status, not in the user's run).
   */
  async emit(event: 'run.completed' | 'session.created', data: unknown): Promise<void> {
    await this.host.emit(event, data).catch(() => undefined)
  }

  /** Detach this run's notice sink; the shared host and its timers stay up. */
  async dispose(): Promise<void> {
    this.detach()
  }
}

function safeStringify(value: unknown): string {
  try {
    const text = JSON.stringify(value)
    return text.length > 20_000 ? `${text.slice(0, 20_000)}…` : text
  } catch {
    return String(value)
  }
}
