// 只读 git 工具：状态、差异、日志。
// 工具定义与执行放在一起：改一个工具只动这一个文件。
import type { AgentToolDefinition, ToolResult } from '../../../shared/types'
import { isAbsolute, resolve } from 'node:path'
import { gitDiff, gitLog, gitStatus } from '../../workspace'
import { autonomyPathDenial } from '../../../shared/autonomy'
import { GIT_STATUS, GIT_DIFF, GIT_LOG } from './spec'
import type { ToolHost } from './spec'
import { rootFor } from './host'

/**
 * git 工具在哪个仓库里跑。
 *
 * 完全自主档下 `repo` 可以是工作区外的绝对路径：git 工具全是只读命令，把它们放到
 * 别的仓库上跑不触碰写入边界；隐私路径仍拒。其余情况 `repo` 只是一个工作区别名。
 */
async function repoRoot(host: ToolHost, args: Record<string, unknown>): Promise<string> {
  const raw = typeof args['repo'] === 'string' ? args['repo'].trim() : ''
  if (raw !== '' && isAbsolute(raw)) {
    if (host.fullAutonomy !== true) {
      throw new Error(
        '没有开启完全自主档时，git 工具只能作用于工作区：请传已注册的 root 别名，不要传绝对路径。',
      )
    }
    const target = resolve(raw)
    const denial = autonomyPathDenial(target)
    if (denial) throw new Error(denial)
    return target
  }
  return raw === '' ? rootFor(host, args) : rootFor(host, { root: raw })
}

const REPO_PROPERTY = {
  type: 'string',
  description:
    'Repository directory. Use a registered root alias, or in full-autonomy mode an absolute path to any repository outside the workspace.',
}

export const gitTools: AgentToolDefinition[] = [
{
    name: GIT_STATUS,
    description:
      'Show the current branch and every uncommitted change (porcelain format). Pass repo to inspect another repository.',
    inputSchema: {
      type: 'object',
      properties: { repo: REPO_PROPERTY },
      additionalProperties: false,
    },
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
        repo: REPO_PROPERTY,
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
        repo: REPO_PROPERTY,
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
  const scope = { fullAutonomy: host.fullAutonomy === true }
  if (name === GIT_STATUS) {
  {
        const output = await gitStatus(await repoRoot(host, args), signal, scope)
        return { ok: true, output }
      }
  }
  if (name === GIT_DIFF) {
  {
        const output = await gitDiff(
          await repoRoot(host, args),
          {
            ...(typeof args['path'] === 'string' ? { path: args['path'] } : {}),
            ...(typeof args['staged'] === 'boolean' ? { staged: args['staged'] } : {}),
            ...(typeof args['stat'] === 'boolean' ? { stat: args['stat'] } : {}),
          },
          signal,
          scope,
        )
        return { ok: true, output: output || '(no diff)' }
      }
  }
  if (name === GIT_LOG) {
  {
        const output = await gitLog(
          await repoRoot(host, args),
          {
            ...(typeof args['limit'] === 'number' ? { limit: args['limit'] } : {}),
            ...(typeof args['path'] === 'string' ? { path: args['path'] } : {}),
          },
          signal,
          scope,
        )
        return { ok: true, output }
      }
  }
  return null
}
