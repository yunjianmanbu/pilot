// 只读 git 工具：状态、差异、日志。
// 工具定义与执行放在一起：改一个工具只动这一个文件。
import type { AgentToolDefinition, ToolResult } from '../../../shared/types'
import { gitDiff, gitLog, gitStatus } from '../../workspace'
import { GIT_STATUS, GIT_DIFF, GIT_LOG } from './spec'
import type { ToolHost } from './spec'
import { rootFor } from './host'

export const gitTools: AgentToolDefinition[] = [
{
    name: GIT_STATUS,
    description: 'Show the current branch and every uncommitted change (porcelain format).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    risk: 'read',
    source: 'builtin',
  },
{
    name: GIT_DIFF,
    description:
      'Show uncommitted changes. Use stat=true first for a compact summary, then re-run without it for the patch. Pass a path to limit a large diff.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        staged: { type: 'boolean' },
        stat: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    risk: 'read',
    source: 'builtin',
  },
{
    name: GIT_LOG,
    description:
      'List recent commits (newest first). Use it to understand recent changes and project conventions. Pass path to see commits that touched a file.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Commits to return, 1-50. Default 20.' },
        path: { type: 'string' },
      },
      additionalProperties: false,
    },
    risk: 'read',
    source: 'builtin',
  },
]

/** 只读 git 工具：状态、差异、日志。 返回 null 表示本域没有这个工具。 */
export async function runGitTool(
  name: string,
  args: Record<string, unknown>,
  host: ToolHost,
  signal: AbortSignal,
): Promise<ToolResult | null> {
  if (name === GIT_STATUS) {
  {
        const output = await gitStatus(await rootFor(host, args), signal)
        return { ok: true, output }
      }
  }
  if (name === GIT_DIFF) {
  {
        const output = await gitDiff(
          await rootFor(host, args),
          {
            ...(typeof args['path'] === 'string' ? { path: args['path'] } : {}),
            ...(typeof args['staged'] === 'boolean' ? { staged: args['staged'] } : {}),
            ...(typeof args['stat'] === 'boolean' ? { stat: args['stat'] } : {}),
          },
          signal,
        )
        return { ok: true, output: output || '(no diff)' }
      }
  }
  if (name === GIT_LOG) {
  {
        const output = await gitLog(
          await rootFor(host, args),
          {
            ...(typeof args['limit'] === 'number' ? { limit: args['limit'] } : {}),
            ...(typeof args['path'] === 'string' ? { path: args['path'] } : {}),
          },
          signal,
        )
        return { ok: true, output }
      }
  }
  return null
}
