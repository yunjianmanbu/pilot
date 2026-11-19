import { describe, expect, it } from 'vitest'
import { buildSystemPrompt } from '../src/main/agent/prompt'
import { pilotTools, RUN_SHELL, withShellDescription } from '../src/main/agent/tools'

const gitBash = 'Git Bash (POSIX bash syntax: $VAR, forward-slash paths)'

function shellTool(tools = pilotTools) {
  const found = tools.find((tool) => tool.name === RUN_SHELL)
  if (!found) throw new Error('missing run_shell')
  return found
}

describe('run_shell interpreter guidance', () => {
  it('adds the effective interpreter to the tool description', () => {
    const tools = withShellDescription(pilotTools, gitBash)
    const shell = shellTool(tools)
    expect(shell.description).toContain(`The shell on this machine is ${gitBash}`)
    expect(shell.description).toContain('powershell.exe')
    // The approval and sandbox policy must survive the appended guidance.
    expect(shell.description).toContain('explicit approval even in auto mode')
    expect(shell.description).toContain('OS sandbox')
    // Other tools are untouched and the source array is not mutated.
    expect(tools.find((tool) => tool.name === 'read_file')?.description).toBe(
      pilotTools.find((tool) => tool.name === 'read_file')?.description,
    )
    expect(shellTool().description).not.toContain('The shell on this machine')
  })

  it('leaves definitions unchanged when no interpreter is known', () => {
    expect(withShellDescription(pilotTools, undefined)).toBe(pilotTools)
  })

  it('tells the model how to write commands in the system prompt', () => {
    const prompt = buildSystemPrompt({
      root: 'E:\\work\\acme',
      topLevel: 'src',
      memory: [],
      profile: null,
      plan: null,
      selfUpdate: false,
      shellMode: true,
      shellInterpreter: gitBash,
    })
    expect(prompt).toContain(`through ${gitBash}`)
    expect(prompt).toContain('never wrap them in powershell.exe or cmd /c')
  })
})
