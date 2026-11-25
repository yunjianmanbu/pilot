import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolCall } from '../src/shared/types'
import {
  buildHookRuleMarkdown,
  evaluateHookRules,
  extractContinueDirective,
  loadHookRules,
  parseHookRule,
} from '../src/main/agent/hook-rules'
import { HookService } from '../src/main/agent/hooks'

const cleanups: string[] = []

afterEach(async () => {
  while (cleanups.length) {
    const dir = cleanups.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

async function workspaceWithRules(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pilot-hookrules-'))
  cleanups.push(root)
  await mkdir(join(root, '.pilot', 'hooks'), { recursive: true })
  for (const [name, text] of Object.entries(files)) {
    await writeFile(join(root, '.pilot', 'hooks', name), text, 'utf8')
  }
  return root
}

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: '1', name, arguments: args }
}

const signal = new AbortController().signal

describe('parseHookRule', () => {
  it('reads frontmatter and uses the body as the message', () => {
    const rule = parseHookRule(
      [
        '---',
        'name: no-console-log',
        'event: file',
        'pattern: console\\.log',
        'action: block',
        '---',
        '',
        'Do not leave console.log in source files.',
      ].join('\n'),
      '.pilot/hooks/no-console-log.md',
    )
    expect(rule).not.toBeNull()
    expect(rule?.name).toBe('no-console-log')
    expect(rule?.event).toBe('file')
    expect(rule?.action).toBe('block')
    expect(rule?.message).toBe('Do not leave console.log in source files.')
  })

  it('defaults to event=tool, action=warn, enabled', () => {
    const rule = parseHookRule('---\npattern: TODO\n---\nnote', '.pilot/hooks/x.md')
    expect(rule?.event).toBe('tool')
    expect(rule?.action).toBe('warn')
    expect(rule?.name).toBe('x')
  })

  it('drops bad regexes and rules without a pattern, but keeps disabled ones for the settings page', () => {
    // 停用的规则仍要能被解析出来：设置页要列出它并提供「启用」，运行时求值再跳过。
    expect(parseHookRule('---\npattern: a\nenabled: false\n---\n', 'a.md')?.enabled).toBe(false)
    expect(parseHookRule('---\npattern: "[unclosed"\n---\n', 'b.md')).toBeNull()
    expect(parseHookRule('---\nname: x\n---\nno pattern', 'c.md')).toBeNull()
  })

  it('falls back to a generated message when the body is empty', () => {
    const rule = parseHookRule('---\npattern: rm -rf\n---\n', '.pilot/hooks/danger.md')
    expect(rule?.message).toContain('danger')
    expect(rule?.message).toContain('rm -rf')
  })
})

describe('evaluateHookRules', () => {
  const rules = [
    parseHookRule('---\nname: warn-console\npattern: console\\.log\naction: warn\n---\nseed\n', 'a.md')!,
    parseHookRule('---\nname: block-rm\npattern: rm -rf\naction: block\n---\nnever\n', 'b.md')!,
  ]

  it('collects warnings and the first block', () => {
    const outcome = evaluateHookRules(rules, 'tool', 'console.log(x); rm -rf /')
    expect(outcome.warnings).toEqual(['seed'])
    expect(outcome.blocked).toBe('never')
    expect(outcome.matched).toEqual(['warn-console', 'block-rm'])
  })

  it('ignores rules for other events and empty subjects', () => {
    expect(evaluateHookRules(rules, 'bash', '').matched).toEqual([])
    const stopOnly = [parseHookRule('---\nname: s\nevent: stop\npattern: done\n---\ntext\n', 's.md')!]
    expect(evaluateHookRules(stopOnly, 'tool', 'done').matched).toEqual([])
    expect(evaluateHookRules(stopOnly, 'stop', 'done').matched).toEqual(['s'])
  })

  it('skips disabled rules even when they match', () => {
    const off = parseHookRule(
      '---\nname: off\npattern: rm -rf\naction: block\nenabled: false\n---\nnever\n',
      'o.md',
    )!
    expect(off.enabled).toBe(false)
    const outcome = evaluateHookRules([off], 'tool', 'rm -rf /')
    expect(outcome.matched).toEqual([])
    expect(outcome.blocked).toBeNull()
  })
})

describe('loadHookRules', () => {
  it('returns [] when the directory does not exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pilot-hookrules-empty-'))
    cleanups.push(root)
    expect(await loadHookRules(root)).toEqual([])
  })

  it('skips broken files but keeps the valid ones', async () => {
    const root = await workspaceWithRules({
      'a-good.md': '---\nname: good\npattern: ok\n---\nmsg\n',
      'b-bad.md': '---\npattern: "[unclosed"\n---\nmsg\n',
      'notes.txt': 'ignored',
    })
    const rules = await loadHookRules(root)
    expect(rules.map((rule) => rule.name)).toEqual(['good'])
  })

  it('round-trips through buildHookRuleMarkdown', async () => {
    const root = await workspaceWithRules({
      'rt.md': buildHookRuleMarkdown({
        name: 'round-trip',
        event: 'bash',
        pattern: 'git push --force',
        action: 'block',
        message: 'Ask before force-pushing.',
      }),
    })
    const [rule] = await loadHookRules(root)
    expect(rule?.name).toBe('round-trip')
    expect(rule?.event).toBe('bash')
    expect(rule?.action).toBe('block')
    expect(rule?.message).toBe('Ask before force-pushing.')
  })
})

describe('HookService with declarative rules', () => {
  it('blocks a matching call and reports the rule message', async () => {
    const root = await workspaceWithRules({
      'destructive.md':
        '---\nname: destructive\nevent: bash\npattern: rm -rf\naction: block\n---\nAsk the user before deleting a directory tree.\n',
    })
    const hooks = new HookService(root, true)
    await hooks.load()
    const outcome = await hooks.beforeTool(
      call('run_shell', { command: 'rm -rf build' }),
      {} as never,
      signal,
    )
    expect(outcome.blocked).toBe(true)
    expect(outcome.output).toContain('Ask the user before deleting')
  })

  it('warns without blocking', async () => {
    const root = await workspaceWithRules({
      'console.md':
        '---\nname: no-console\nevent: file\npattern: console\\.log\naction: warn\n---\nRemove console.log before shipping.\n',
    })
    const hooks = new HookService(root, true)
    await hooks.load()
    const outcome = await hooks.beforeTool(
      call('write_file', { path: 'src/a.ts', content: 'console.log(1)' }),
      {} as never,
      signal,
    )
    expect(outcome.blocked).toBe(false)
    expect(outcome.output).toContain('Remove console.log before shipping.')
  })

  it('does nothing when hooks are disabled in settings', async () => {
    const root = await workspaceWithRules({
      'destructive.md':
        '---\nname: destructive\nevent: bash\npattern: rm -rf\naction: block\n---\nno\n',
    })
    const hooks = new HookService(root, false)
    await hooks.load()
    const outcome = await hooks.beforeTool(
      call('run_shell', { command: 'rm -rf build' }),
      {} as never,
      signal,
    )
    expect(outcome.blocked).toBe(false)
    expect(hooks.activeRules).toEqual([])
  })

  it('matches stop rules against the final message', async () => {
    const root = await workspaceWithRules({
      'todo.md':
        '---\nname: unfinished\nevent: stop\npattern: TODO\naction: warn\n---\nThe plan still has open items.\n',
    })
    const hooks = new HookService(root, true)
    await hooks.load()
    expect(await hooks.stop(signal, 'All tasks done.')).toBeNull()
    expect(await hooks.stop(signal, 'TODO: two files left')).toContain('open items')
  })
})

describe('extractContinueDirective', () => {
  it('reads a CONTINUE line, tolerating markdown prefixes', () => {
    expect(extractContinueDirective('some log\nCONTINUE: run the tests')).toBe('run the tests')
    expect(extractContinueDirective('> **CONTINUE:** finish step 3')).toBe('finish step 3')
  })

  it('returns null when there is no directive', () => {
    expect(extractContinueDirective(null)).toBeNull()
    expect(extractContinueDirective('')).toBeNull()
    expect(extractContinueDirective('continued earlier')).toBeNull()
  })

  it('caps a very long directive', () => {
    const directive = extractContinueDirective(`CONTINUE: ${'x'.repeat(5000)}`)
    expect(directive?.length).toBe(2000)
  })
})
