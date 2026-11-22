// 文件和目录工具：读取、搜索、写入、补丁。
// 工具定义与执行放在一起：改一个工具只动这一个文件。
import type { AgentToolDefinition, ToolResult } from '../../../shared/types'
import { applyPatch, getFileInfo, listDirectoryTree, projectMap, readFileSlice, searchFiles, writeTextFile } from '../../workspace'
import { LIST_DIRECTORY, PROJECT_MAP, READ_FILE, GET_FILE_INFO, SEARCH_FILES, WRITE_FILE, APPLY_PATCH } from './spec'
import type { ToolHost } from './spec'
import { rootFor } from './host'

export const fileTools: AgentToolDefinition[] = [
{
    name: LIST_DIRECTORY,
    description:
      'List files and directories inside the workspace. Paths are relative to the workspace root. Use depth to control recursion (default 1, max 4). Start broad with this when you do not know the layout, then read specific files.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative directory path; "." for the root.' },
        depth: { type: 'number', description: 'Recursion depth, 1-4.' },
      },
      additionalProperties: false,
    },
    risk: 'read',
    source: 'builtin',
  },
{
    name: PROJECT_MAP,
    description:
      'One-call project overview for read-only analysis: recursive file counts by top-level directory and extension, package manifests with name/version/scripts, entry points, key source file paths, config files and test layout. Use this ONCE before reading code instead of many list_directory or shell counting calls. Only manifests are read; source files are listed, not opened.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative directory to map, default ".".' },
        maxFiles: { type: 'number', description: 'Stop after this many files (100-100000, default 40000).' },
        depth: { type: 'number', description: 'Maximum recursion depth, 1-20 (default 20).' },
      },
      additionalProperties: false,
    },
    risk: 'read',
    source: 'builtin',
  },
{
    name: READ_FILE,
    description:
      'Read a UTF-8 text file from the workspace. Returns at most ~2000 numbered lines. Provide startLine/endLine (1-based, inclusive) to read a slice. Read a file before editing it, and do not repeat a read you already performed unless the file changed.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative file path.' },
        startLine: { type: 'number' },
        endLine: { type: 'number' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    risk: 'read',
    source: 'builtin',
  },
{
    name: GET_FILE_INFO,
    description: 'Return metadata (type, size, modified time) for a workspace path.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    risk: 'read',
    source: 'builtin',
  },
{
    name: SEARCH_FILES,
    description:
      'Search text inside workspace files. Returns file, line number and a short preview. Use regex with a narrow glob to find definitions and call sites. Set context to 2 for readable surrounding lines. Skips ignored directories and binary files.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Literal text or regular expression.' },
        path: {
          type: 'string',
          description:
            'Directory or single file to search, defaults to workspace root. A file path searches only that file.',
        },
        glob: {
          type: 'string',
          description: 'Optional glob such as "src/**/*.ts". Supports {a,b} alternation.',
        },
        regex: { type: 'boolean', description: 'Treat query as a regular expression.' },
        caseSensitive: { type: 'boolean', description: 'Match case exactly. Default false.' },
        context: { type: 'number', description: 'Lines of context around each match, 0-5.' },
        maxResults: { type: 'number', description: 'Default 80, max 200.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    risk: 'read',
    source: 'builtin',
  },
{
    name: WRITE_FILE,
    description:
      'Create or fully replace a UTF-8 text file. Parent directories are created automatically. Prefer apply_patch for targeted edits to an existing file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    risk: 'write',
    source: 'builtin',
  },
{
    name: APPLY_PATCH,
    description:
      'Edit an existing file. Pass edits with several {oldText, newText} hunks to change many places in one call. Each oldText must occur exactly once unless replaceAll is true; include enough surrounding context to make it unique. Matching tolerates CRLF/LF and trailing-whitespace drift and reports nearby lines when a match fails.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        edits: {
          type: 'array',
          description: 'Hunks applied in order.',
          items: {
            type: 'object',
            properties: {
              oldText: { type: 'string' },
              newText: { type: 'string' },
              replaceAll: { type: 'boolean' },
            },
            required: ['oldText', 'newText'],
          },
        },
        oldText: { type: 'string', description: 'Single-hunk shorthand.' },
        newText: { type: 'string', description: 'Single-hunk shorthand.' },
        replaceAll: { type: 'boolean' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    risk: 'write',
    source: 'builtin',
  },
]

/** 文件和目录工具：读取、搜索、写入、补丁。 返回 null 表示本域没有这个工具。 */
export async function runFileTool(
  name: string,
  args: Record<string, unknown>,
  host: ToolHost,
  signal: AbortSignal,
): Promise<ToolResult | null> {
  if (name === LIST_DIRECTORY) {
  {
        const output = await listDirectoryTree(
          await rootFor(host, args),
          typeof args['path'] === 'string' ? args['path'] : '.',
          typeof args['depth'] === 'number' ? args['depth'] : undefined,
        )
        return { ok: true, output, metadata: { truncated: output.includes('…') } }
      }
  }
  if (name === PROJECT_MAP) {
  {
        const { output, metadata } = await projectMap(await rootFor(host, args), {
          ...(typeof args['path'] === 'string' ? { path: args['path'] } : {}),
          ...(typeof args['maxFiles'] === 'number' ? { maxFiles: args['maxFiles'] } : {}),
          ...(typeof args['depth'] === 'number' ? { depth: args['depth'] } : {}),
        })
        return { ok: true, output, metadata }
      }
  }
  if (name === READ_FILE) {
  {
        const path = typeof args['path'] === 'string' ? args['path'] : ''
        if (!path) throw new Error('path must be a non-empty string')
        const { output, metadata } = await readFileSlice(
          await rootFor(host, args),
          path,
          args['startLine'],
          args['endLine'],
        )
        return { ok: true, output, metadata }
      }
  }
  if (name === GET_FILE_INFO) {
  {
        const path = typeof args['path'] === 'string' ? args['path'] : ''
        if (!path) throw new Error('path must be a non-empty string')
        return { ok: true, output: await getFileInfo(await rootFor(host, args), path) }
      }
  }
  if (name === SEARCH_FILES) {
  {
        const query = typeof args['query'] === 'string' ? args['query'] : ''
        const { output, metadata } = await searchFiles(await rootFor(host, args), {
          query,
          ...(typeof args['path'] === 'string' ? { path: args['path'] } : {}),
          ...(typeof args['glob'] === 'string' ? { glob: args['glob'] } : {}),
          ...(typeof args['regex'] === 'boolean' ? { regex: args['regex'] } : {}),
          ...(typeof args['caseSensitive'] === 'boolean'
            ? { caseSensitive: args['caseSensitive'] }
            : {}),
          ...(typeof args['context'] === 'number' ? { context: args['context'] } : {}),
          ...(typeof args['maxResults'] === 'number' ? { maxResults: args['maxResults'] } : {}),
        })
        return { ok: true, output, metadata }
      }
  }
  if (name === WRITE_FILE) {
  {
        const path = typeof args['path'] === 'string' ? args['path'] : ''
        const content = typeof args['content'] === 'string' ? args['content'] : null
        if (content === null) throw new Error('content must be a string')
        const result = await writeTextFile(host.root, path, content)
        return {
          ok: true,
          output: result.output,
          ...(result.diff ? { metadata: { ...result.metadata, diff: result.diff } } : { metadata: result.metadata }),
        }
      }
  }
  if (name === APPLY_PATCH) {
  {
        const result = await applyPatch(host.root, args)
        return {
          ok: true,
          output: result.output,
          metadata: { ...result.metadata, ...(result.diff ? { diff: result.diff } : {}) },
        }
      }
  }
  return null
}
