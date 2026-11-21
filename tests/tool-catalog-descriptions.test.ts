import { describe, expect, it } from 'vitest'
import {
  buildToolCatalog,
  countToolCalls,
  TOOL_DESCRIPTIONS_ZH,
  toolDescriptionZh,
} from '../src/shared/tools-catalog'
import { pilotTools } from '../src/main/agent/tools'

// 会话资源里的「工具」是给人看的清单，工具定义里的 description 却是写给模型的
// 英文长句。这里钉住三件事：每个内置/控制工具都有一句中文、清单确实带上了它、
// 没有中文的条目留给调用方回落原文而不是空着。

describe('中文工具说明', () => {
  it('gives every builtin and control tool a Chinese sentence', () => {
    const missing = pilotTools
      .filter((tool) => tool.source !== 'mcp')
      .filter((tool) => !toolDescriptionZh(tool.name))
      .map((tool) => tool.name)
    expect(missing).toEqual([])
  })

  it('writes Chinese, not a copy of the English description', () => {
    const copied = pilotTools
      .filter((tool) => TOOL_DESCRIPTIONS_ZH[tool.name] === tool.description)
      .map((tool) => tool.name)
    expect(copied).toEqual([])
    // 抽查一句：必须是中文，长度还得是能放进面板的一行。
    const sample = toolDescriptionZh('read_file') ?? ''
    expect(sample).toMatch(/[\u4e00-\u9fa5]/)
    expect(sample.length).toBeGreaterThan(6)
    expect(sample.length).toBeLessThan(60)
  })

  it('keeps the table free of entries no tool uses', () => {
    const known = new Set(pilotTools.map((tool) => tool.name))
    // 复盘会话的六个工具不在 pilotTools 里，单独列出，避免以后误删。
    const reviewOnly = new Set([
      'list_sessions',
      'get_session',
      'search_sessions',
      'list_runs',
      'get_run',
      'record_review',
    ])
    const stale = Object.keys(TOOL_DESCRIPTIONS_ZH).filter(
      (name) => !known.has(name) && !reviewOnly.has(name),
    )
    expect(stale).toEqual([])
  })
})

describe('buildToolCatalog 带出中文说明', () => {
  it('attaches descriptionZh to builtin entries and keeps the English text', () => {
    const catalog = buildToolCatalog({
      builtin: [
        {
          name: 'read_file',
          description: 'Read a UTF-8 text file from the workspace.',
          inputSchema: { type: 'object' },
          risk: 'read',
          source: 'builtin',
        },
      ],
      dynamic: [],
      mcpServers: [],
      mcpEnabled: false,
    })
    expect(catalog).toHaveLength(1)
    expect(catalog[0]?.description).toContain('Read a UTF-8 text file')
    expect(catalog[0]?.descriptionZh).toContain('读取工作区')
  })

  it('leaves descriptionZh undefined for a tool without a translation', () => {
    const catalog = buildToolCatalog({
      builtin: [
        {
          name: 'some_future_tool',
          description: 'Does something new.',
          inputSchema: { type: 'object' },
          risk: 'read',
          source: 'builtin',
        },
      ],
      dynamic: [],
      mcpServers: [],
      mcpEnabled: false,
    })
    expect(catalog[0]?.descriptionZh).toBeUndefined()
  })

  it('describes an MCP server in Chinese for both switch states', () => {
    const on = buildToolCatalog({
      builtin: [],
      dynamic: [],
      mcpServers: ['files'],
      mcpEnabled: true,
    })
    const off = buildToolCatalog({
      builtin: [],
      dynamic: [],
      mcpServers: ['files'],
      mcpEnabled: false,
    })
    expect(on[0]?.descriptionZh).toContain('MCP 服务器')
    expect(off[0]?.descriptionZh).toContain('关闭了 MCP')
  })

  it('keeps Chinese text on a self-written tool that reuses a builtin name', () => {
    const catalog = buildToolCatalog({
      builtin: [],
      dynamic: [
        {
          name: 'remember',
          description: 'Write a durable fact.',
          risk: 'write',
          source: 'workspace',
          enabled: true,
          approved: true,
          version: 1,
          targets: [],
          runtime: 'node',
          createdAt: '',
          updatedAt: '',
          successCount: 0,
          failureCount: 0,
        } as never,
      ],
      mcpServers: [],
      mcpEnabled: false,
    })
    expect(catalog[0]?.descriptionZh).toContain('项目事实')
  })
})

describe('countToolCalls 顺便回归', () => {
  it('counts an MCP tool under both its full name and server prefix', () => {
    const calls = countToolCalls([
      { toolCalls: [{ name: 'mcp__files__read' }, { name: 'mcp__files__write' }] },
    ] as never)
    expect(calls['mcp__files__read']).toBe(1)
    expect(calls['mcp__files']).toBe(2)
  })
})
