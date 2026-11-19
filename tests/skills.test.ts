import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseSkillMarkdown, SkillsService } from '../src/main/agent/skills'
import { executePilotTool, USE_SKILL, type ToolHost } from '../src/main/agent/tools'

const cleanups: string[] = []

afterEach(async () => {
  while (cleanups.length) {
    const dir = cleanups.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

async function workspaceWithSkills(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pilot-skills-'))
  cleanups.push(root)
  await mkdir(join(root, '.pilot', 'skills', 'release'), { recursive: true })
  await writeFile(
    join(root, '.pilot', 'skills', 'release', 'SKILL.md'),
    [
      '---',
      'name: release',
      'description: Build and publish the desktop app',
      'when_to_use: when the user asks to release',
      '---',
      '',
      '# Release',
      '',
      'Run pnpm build, then upload.',
    ].join('\n'),
    'utf8',
  )
  await mkdir(join(root, '.pilot', 'skills', 'broken name'), { recursive: true })
  await writeFile(
    join(root, '.pilot', 'skills', 'broken name', 'SKILL.md'),
    '---\ndescription: should be skipped\n---\nbody',
    'utf8',
  )
  return root
}

describe('parseSkillMarkdown', () => {
  it('parses quoted frontmatter and keeps the body', () => {
    const parsed = parseSkillMarkdown(
      '---\nname: "deploy"\ndescription: Ship it\nwhen_to_use: deploy day\n---\n\n# Steps\nGo.',
    )
    expect(parsed.meta).toEqual({
      name: 'deploy',
      description: 'Ship it',
      when_to_use: 'deploy day',
    })
    expect(parsed.body).toBe('# Steps\nGo.')
  })

  it('treats a document without frontmatter as plain body', () => {
    const parsed = parseSkillMarkdown('# Just docs')
    expect(parsed.meta).toEqual({})
    expect(parsed.body).toBe('# Just docs')
  })
})

describe('SkillsService', () => {
  it('lists valid skills and reads one by name', async () => {
    const root = await workspaceWithSkills()
    const service = new SkillsService(root)
    const list = await service.load()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      name: 'release',
      description: 'Build and publish the desktop app',
      whenToUse: 'when the user asks to release',
    })
    expect(service.read('release')?.body).toContain('Run pnpm build')
    expect(service.read('missing')).toBeNull()
  })

  it('loads a skill through the use_skill tool', async () => {
    const root = await workspaceWithSkills()
    const service = new SkillsService(root)
    await service.load()
    const host: ToolHost = {
      root,
      remember: async () => ({ id: 'x' }),
      updatePlan: () => undefined,
      proposeSelfUpdate: async () => ({ version: 1 }),
      useSkill: async (name) => service.read(name)?.body ?? null,
    }
    const result = await executePilotTool(
      USE_SKILL,
      { name: 'release' },
      host,
      new AbortController().signal,
    )
    expect(result.ok).toBe(true)
    expect(result.output).toContain('Run pnpm build')
  })
})
