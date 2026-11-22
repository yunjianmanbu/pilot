// 自举工具：注册、回滚、提升、运行 agent 自己写的工具。
// 工具定义与执行放在一起：改一个工具只动这一个文件。
import type { AgentToolDefinition, ToolResult } from '../../../shared/types'
import { join } from 'node:path'
import { LIST_TOOLS, REGISTER_TOOL, ROLLBACK_TOOL, PROMOTE_TOOL, RUN_TOOL } from './spec'
import type { ToolHost } from './spec'

export const toolsmithTools: AgentToolDefinition[] = [
{
    name: LIST_TOOLS,
    description:
      'List tools the agent has written for this workspace (and promoted global tools), with approval state and run statistics. Call this before deciding to create another tool, so an equivalent one is reused instead of duplicated.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    risk: 'read',
    source: 'builtin',
  },
{
    name: REGISTER_TOOL,
    description:
      'Validate and register a tool written under .pilot/tools/<name>/ and run its declared test. The tool must contain tool.json plus the entry and test files it names. Registration fails if the manifest is invalid, a path escapes the tool directory, the declared targets are not in the settings allowlist, or the test exits non-zero. Only a passing test records approval. Re-registering changed code is an upgrade: the version is bumped past the approved one and the approved bytes are kept as a snapshot for rollback_tool. Never register a tool you have not tested.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Tool directory name under .pilot/tools/, e.g. "bulk-login".',
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
    risk: 'exec',
    source: 'builtin',
  },
{
    name: ROLLBACK_TOOL,
    description:
      'Restore a previously approved version of an agent-written tool, re-run its test, and approve the restored code only if that test passes. Use it when an upgrade regresses instead of rewriting the old code from scratch. Call list_tools first to see the approval history.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Tool directory name under .pilot/tools/, e.g. "bulk-login".',
        },
        version: {
          type: 'number',
          description:
            'Version from the approval history; omit to restore the previous approved version.',
        },
        scope: {
          type: 'string',
          enum: ['workspace', 'global'],
          description:
            'Which copy to roll back. Omit to prefer the workspace tool and fall back to the promoted system-default one.',
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
    risk: 'exec',
    source: 'builtin',
  },
{
    name: PROMOTE_TOOL,
    description:
      'Promote an approved workspace tool into the global tool set, so every workspace starts with it as a system-default tool. Use it once a tool has proven generic, not for one-off helpers. Prerequisites: the tool is registered and its files are unchanged since approval; its entry and test files must not hardcode this workspace absolute path; it must have run successfully at least once (pass force: true to skip only that last check). The promoted copy keeps its version history and can be rolled back with rollback_tool scope: "global".',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Registered workspace tool name.' },
        force: {
          type: 'boolean',
          description:
            'Skip the "ran successfully at least once" check. Generality checks still apply.',
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
    risk: 'exec',
    source: 'builtin',
  },
{
    name: RUN_TOOL,
    description:
      'Run a registered workspace tool with JSON arguments. Arguments are passed on stdin as a JSON object. The tool runs in a bounded child process with the workspace as cwd, a timeout and an output cap. Its declared targets must be localhost or listed in Settings → test targets. Prefer built-in tools when they can do the job. A tool whose files changed after approval is refused until registered again.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Registered tool name.' },
        arguments: {
          type: 'object',
          description: 'Arguments object passed to the tool on stdin.',
          additionalProperties: true,
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
    risk: 'exec',
    source: 'builtin',
  },
]

/** 自举工具：注册、回滚、提升、运行 agent 自己写的工具。 返回 null 表示本域没有这个工具。 */
export async function runToolsmithTool(
  name: string,
  args: Record<string, unknown>,
  host: ToolHost,
  signal: AbortSignal,
): Promise<ToolResult | null> {
  if (name === LIST_TOOLS) {
  {
        if (!host.toolRegistry) throw new Error('Dynamic tools are not available in this context')
        const tools = await host.toolRegistry.list()
        if (tools.length === 0) {
          return {
            ok: true,
            output:
              'No agent-written tools are registered for this workspace. Create one under .pilot/tools/<name>/ only when a capability is genuinely repeated, then call register_tool.',
          }
        }
        return {
          ok: true,
          output: tools
            .map((tool) => {
              const state = !tool.enabled
                ? 'disabled'
                : tool.approved
                  ? 'approved'
                  : 'needs re-registration'
              const history = (tool.versions ?? [])
                .map((item) => `v${item.version}${item.action === 'rollback' ? '(rollback)' : ''}`)
                .join(' -> ')
              const scope =
                tool.source === 'global'
                  ? 'system default'
                  : tool.promotedAt
                    ? 'this workspace, also promoted as a system default'
                    : 'this workspace'
              const lines = [
                `- ${tool.name} (${tool.source}: ${scope}, ${tool.runtime}, v${tool.approvedVersion ?? tool.version}, ${state}; ok ${tool.successCount} / failed ${tool.failureCount}): ${tool.description}`,
                history ? `  history: ${history}` : '',
              ]
              if (!tool.approved) {
                lines.push(
                  '  next: 代码已改动，用 register_tool 重新登记（版本自动 +1，旧版本保留为快照）。',
                )
              } else if (tool.failureCount >= 3 && tool.failureCount > tool.successCount) {
                lines.push(
                  '  next: 反复失败，考虑升级：改写工具文件 → register_tool；新版本回归时用 rollback_tool 回到上一个批准版本。',
                )
              } else if (
                tool.source === 'workspace' &&
                tool.successCount >= 3 &&
                tool.failureCount <= 1
              ) {
                lines.push(
                  '  next: 看起来已经通用（多次成功、失败少）。如果它不依赖本仓库的绝对路径，用 promote_tool 提升为系统默认工具，之后每个工作区都会自带它。',
                )
              }
              return lines.filter(Boolean).join('\n')
            })
            .join('\n'),
        }
      }
  }
  if (name === REGISTER_TOOL) {
  {
        if (!host.toolRegistry) throw new Error('Dynamic tools are not available in this context')
        const name = typeof args['name'] === 'string' ? args['name'].trim() : ''
        if (!name) throw new Error('name must be a non-empty string')
        const registration = await host.toolRegistry.register(name)
        return {
          ok: true,
          output:
            `Registered ${registration.tool.name} (${registration.tool.runtime}, ${registration.tool.risk}) ` +
            `after its self-test passed in ${registration.durationMs}ms. SHA-256 ${registration.tool.sha256.slice(0, 12)}.\n` +
            `Test output:\n${registration.testOutput || '(no output)'}`,
          metadata: {
            tool: registration.tool.name,
            sha256: registration.tool.sha256,
            durationMs: registration.durationMs,
          },
        }
      }
  }
  if (name === RUN_TOOL) {
  {
        if (!host.toolRegistry) throw new Error('Dynamic tools are not available in this context')
        const name = typeof args['name'] === 'string' ? args['name'].trim() : ''
        if (!name) throw new Error('name must be a non-empty string')
        const raw = args['arguments']
        const toolArgs =
          raw && typeof raw === 'object' && !Array.isArray(raw)
            ? (raw as Record<string, unknown>)
            : {}
        return host.toolRegistry.run(name, toolArgs)
      }
  }
  if (name === ROLLBACK_TOOL) {
  {
        if (!host.toolRegistry) throw new Error('Dynamic tools are not available in this context')
        const name = typeof args['name'] === 'string' ? args['name'].trim() : ''
        if (!name) throw new Error('name must be a non-empty string')
        const restored = await host.toolRegistry.rollback(name, args['version'], args['scope'])
        return {
          ok: true,
          output:
            `Rolled back ${restored.tool.name} (${restored.tool.source}) to v${restored.tool.version} ` +
            `(SHA-256 ${restored.tool.sha256.slice(0, 12)}); its test passed again.\n` +
            `Test output:\n${restored.testOutput || '(no output)'}`,
          metadata: {
            tool: restored.tool.name,
            source: restored.tool.source,
            sha256: restored.tool.sha256,
            version: restored.tool.version,
            durationMs: restored.durationMs,
          },
        }
      }
  }
  if (name === PROMOTE_TOOL) {
  {
        if (!host.toolRegistry) throw new Error('Dynamic tools are not available in this context')
        const name = typeof args['name'] === 'string' ? args['name'].trim() : ''
        if (!name) throw new Error('name must be a non-empty string')
        const tools = await host.toolRegistry.promote(name, {
          ...(args['force'] === true ? { force: true } : {}),
        })
        const promoted = tools.find((tool) => tool.name === name && tool.source === 'global')
        return {
          ok: true,
          output:
            `Promoted ${name} to a system-default tool: every workspace now starts with ` +
            `v${promoted?.approvedVersion ?? promoted?.version ?? 1} of it. ` +
            'It keeps its version history, and rollback_tool with scope: "global" restores an older version.',
          metadata: {
            tool: name,
            source: 'global',
            version: promoted?.approvedVersion ?? promoted?.version ?? 1,
          },
        }
      }
  }
  return null
}
