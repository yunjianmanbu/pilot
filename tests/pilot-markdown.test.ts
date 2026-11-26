import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  isMarkdownPath,
  PILOT_MARKDOWN_LABEL,
  shouldStampPilotFooter,
  withPilotFooter,
} from '../src/shared/pilot-markdown'
import { runFileTool } from '../src/main/agent/tools/files'
import type { ToolHost } from '../src/main/agent/tools/spec'

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-md-footer-'))

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true })
})

function host(overrides: Partial<ToolHost> = {}): ToolHost {
  return {
    root: base,
    remember: async () => ({ id: 'memory-1' }),
    updatePlan: () => undefined,
    proposeSelfUpdate: async () => ({ version: 1 }),
    ...overrides,
  }
}

function write(target: string, content: string) {
  return runFileTool(
    'write_file',
    { path: target, content },
    host(),
    new AbortController().signal,
  )
}

function read(target: string): string {
  return fs.readFileSync(path.join(base, target), 'utf8')
}

describe('isMarkdownPath', () => {
  it('recognises the two Markdown extensions, case-insensitively', () => {
    expect(isMarkdownPath('a.md')).toBe(true)
    expect(isMarkdownPath('docs/report.MARKDOWN')).toBe(true)
    expect(isMarkdownPath('  notes.md  ')).toBe(true)
    expect(isMarkdownPath('a.mdx')).toBe(false)
    expect(isMarkdownPath('a.ts')).toBe(false)
    expect(isMarkdownPath('md')).toBe(false)
    expect(isMarkdownPath('')).toBe(false)
  })
})

describe('shouldStampPilotFooter', () => {
  it('skips .pilot metadata but takes ordinary docs', () => {
    expect(shouldStampPilotFooter('docs/readme.md')).toBe(true)
    expect(shouldStampPilotFooter('需求.md')).toBe(true)
    expect(shouldStampPilotFooter('.pilot/skills/demo/SKILL.md')).toBe(false)
    expect(shouldStampPilotFooter('.pilot\\hooks\\no-force-push.md')).toBe(false)
    expect(shouldStampPilotFooter('src/main.ts')).toBe(false)
  })
})

describe('withPilotFooter', () => {
  it('appends one separator and the credit line', () => {
    expect(withPilotFooter('# 标题\n\n正文')).toBe(
      `# 标题\n\n正文\n\n---\n\n${PILOT_MARKDOWN_LABEL}\n`,
    )
  })

  it('is idempotent, including the bold and CRLF forms', () => {
    const once = withPilotFooter('# 标题')
    expect(withPilotFooter(once)).toBe(once)
    const bold = `# 标题\n\n---\n\n**${PILOT_MARKDOWN_LABEL}**\n`
    expect(withPilotFooter(bold)).toBe(bold)
    expect(withPilotFooter('# 标题\r\n\r\n正文\r\n')).toBe(
      `# 标题\n\n正文\n\n---\n\n${PILOT_MARKDOWN_LABEL}\n`,
    )
  })

  it('keeps an empty body free of a dangling separator', () => {
    expect(withPilotFooter('')).toBe(`${PILOT_MARKDOWN_LABEL}\n`)
    expect(withPilotFooter('   \n\n')).toBe(`${PILOT_MARKDOWN_LABEL}\n`)
  })
})

describe('write_file', () => {
  it('stamps Markdown files once, even when the model writes it back', async () => {
    await write('docs/需求.md', '# 需求\n\n正文')
    const stamped = read('docs/需求.md')
    expect(stamped).toBe(`# 需求\n\n正文\n\n---\n\n${PILOT_MARKDOWN_LABEL}\n`)

    await write('docs/需求.md', stamped)
    expect(read('docs/需求.md')).toBe(stamped)
    expect(stamped.split(PILOT_MARKDOWN_LABEL)).toHaveLength(2)
  })

  it('leaves .pilot metadata and non-Markdown files untouched', async () => {
    await write('.pilot/skills/demo/SKILL.md', '# SKILL\n\n步骤')
    expect(read('.pilot/skills/demo/SKILL.md')).toBe('# SKILL\n\n步骤')

    await write('notes.txt', 'hello\n')
    expect(read('notes.txt')).toBe('hello\n')

    await write('src/main.ts', 'export const x = 1\n')
    expect(read('src/main.ts')).toBe('export const x = 1\n')
  })
})
