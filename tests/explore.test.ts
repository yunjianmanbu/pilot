import { describe, expect, it } from 'vitest'
import { buildExplorePrompt, EXPLORE_TOOL_NAMES, selectExploreTools } from '../src/main/agent/explore'

describe('selectExploreTools', () => {
  it('exposes only read-only tools', () => {
    const tools = selectExploreTools()
    const names = tools.map((tool) => tool.name).sort()
    expect(names).toEqual([...EXPLORE_TOOL_NAMES].sort())
    expect(tools.every((tool) => tool.risk === 'read')).toBe(true)
  })

  it('filters writes, shell and control tools out of a wider tool list', () => {
    const tools = selectExploreTools([
      { name: 'read_file', description: '', risk: 'read', inputSchema: {} },
      { name: 'write_file', description: '', risk: 'write', inputSchema: {} },
      { name: 'run_shell', description: '', risk: 'exec', inputSchema: {} },
      { name: 'remember', description: '', risk: 'control', inputSchema: {} },
      { name: 'search_files', description: '', risk: 'read', inputSchema: {} },
    ])
    expect(tools.map((tool) => tool.name)).toEqual(['read_file', 'search_files'])
  })
})

describe('buildExplorePrompt', () => {
  it('states read-only boundaries and treats files as untrusted', () => {
    const prompt = buildExplorePrompt('C:/work/demo', '找到登录逻辑', 'src/auth')
    expect(prompt).toContain('read-only')
    expect(prompt).toContain('C:/work/demo')
    expect(prompt).toContain('src/auth')
    expect(prompt).toContain('untrusted')
    expect(prompt).toContain('Task: 找到登录逻辑')
  })

  it('omits the scope line when no scope is given', () => {
    expect(buildExplorePrompt('/repo', 'find tests')).not.toContain('Focus your search on')
  })

  it('writes the thinking text in the app language', () => {
    expect(buildExplorePrompt('/repo', 'find tests', undefined, 'en')).toContain(
      'reasoning/thinking block in English',
    )
    expect(buildExplorePrompt('/repo', 'find tests', undefined, 'zh-CN')).toContain(
      'reasoning/thinking block in Simplified Chinese',
    )
  })
})
