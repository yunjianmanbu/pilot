import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface SkillSummary {
  name: string
  description: string
  whenToUse?: string
}

export interface SkillDocument extends SkillSummary {
  body: string
  resources: string[]
}

interface ParsedSkill {
  meta: Record<string, string>
  body: string
}

const MAX_SKILLS = 50
const MAX_BODY_CHARS = 24_000
const MAX_DESCRIPTION_CHARS = 300
const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/

export interface CreateSkillInput {
  name: string
  description: string
  /** Short trigger hint shown in the system prompt list. */
  whenToUse?: string
  /** Markdown instructions the model loads on demand. */
  body: string
  /** Replace a skill with the same name. Off by default. */
  overwrite?: boolean
}

export interface CreatedSkill {
  name: string
  /** Workspace-relative path of the written SKILL.md. */
  path: string
  overwritten: boolean
}

/** Collapse a value onto one line so the frontmatter subset stays parseable. */
function scalar(value: string, max: number): string {
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["']+/, '')
    .replace(/["']+$/, '')
    .slice(0, max)
}

/** Build SKILL.md text: the frontmatter subset parseSkillMarkdown reads, then the body. */
export function buildSkillMarkdown(input: CreateSkillInput): string {
  const lines = [
    '---',
    `name: ${scalar(input.name, 64)}`,
    `description: ${scalar(input.description, MAX_DESCRIPTION_CHARS)}`,
  ]
  const whenToUse = input.whenToUse ? scalar(input.whenToUse, MAX_DESCRIPTION_CHARS) : ''
  if (whenToUse) lines.push(`when_to_use: ${whenToUse}`)
  lines.push('---', '', input.body.trim(), '')
  return lines.join('\n')
}

/**
 * Write `.pilot/skills/<name>/SKILL.md`. A skill is documentation the model
 * loads on demand, so it is refused when the name could escape that directory
 * or when the body is empty or oversized; an existing skill is kept unless the
 * caller asks to overwrite it.
 */
export async function writeSkill(
  root: string,
  input: CreateSkillInput,
): Promise<CreatedSkill> {
  const name = input.name.trim()
  if (!NAME_PATTERN.test(name)) {
    throw new Error(
      'Skill name must match ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$ (letters, digits, - and _).',
    )
  }
  const description = input.description.trim()
  if (!description) throw new Error('Skill description must be a non-empty string.')
  const body = input.body.trim()
  if (!body) throw new Error('Skill body must be a non-empty Markdown document.')
  if (body.length > MAX_BODY_CHARS) {
    throw new Error(
      `Skill body is ${body.length} characters; the limit is ${MAX_BODY_CHARS}. Split it into a main SKILL.md plus resource files instead of one long body.`,
    )
  }
  const dir = join(root, '.pilot', 'skills', name)
  const file = join(dir, 'SKILL.md')
  let existing = false
  try {
    existing = (await stat(file)).isFile()
  } catch {
    existing = false
  }
  if (existing && input.overwrite !== true) {
    throw new Error(
      `Skill ${name} already exists at .pilot/skills/${name}/SKILL.md. Pass overwrite=true to replace it.`,
    )
  }
  await mkdir(dir, { recursive: true })
  await writeFile(file, buildSkillMarkdown({ ...input, name, description, body }), 'utf8')
  return { name, path: `.pilot/skills/${name}/SKILL.md`, overwritten: existing }
}

/** Parse the small YAML subset used by SKILL.md frontmatter. */
export function parseSkillMarkdown(text: string): ParsedSkill {
  const source = text.replace(/^﻿/, '')
  if (!source.startsWith('---')) return { meta: {}, body: source.trim() }
  const end = source.indexOf('\n---', 3)
  if (end === -1) return { meta: {}, body: source.trim() }
  const header = source.slice(3, end)
  const body = source.slice(end + 4).replace(/^\r?\n/, '').trim()
  const meta: Record<string, string> = {}
  for (const rawLine of header.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const key = line.slice(0, colon).trim().toLowerCase()
    let value = line.slice(colon + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (key && value) meta[key] = value
  }
  return { meta, body }
}

/**
 * Workspace-local skills: `.pilot/skills/<name>/SKILL.md`. A skill is
 * documentation the model can load on demand; it is not executable and never
 * overrides safety, approval or credential rules.
 */
export class SkillsService {
  private documents: SkillDocument[] = []
  private loaded = false

  constructor(private readonly root: string) {}

  async load(): Promise<SkillSummary[]> {
    if (this.loaded) return this.list()
    this.loaded = true
    let entries
    try {
      entries = await readdir(join(this.root, '.pilot', 'skills'), { withFileTypes: true })
    } catch {
      return []
    }
    for (const entry of entries.slice(0, MAX_SKILLS)) {
      if (!entry.isDirectory()) continue
      const name = entry.name
      if (!NAME_PATTERN.test(name)) continue
      try {
        const raw = await readFile(join(this.root, '.pilot', 'skills', name, 'SKILL.md'), 'utf8')
        const { meta, body } = parseSkillMarkdown(raw)
        const declared = meta['name']?.trim()
        const skillName = declared && NAME_PATTERN.test(declared) ? declared : name
        if (this.documents.some((skill) => skill.name === skillName)) continue
        const description =
          meta['description']?.trim() ||
          body.split(/\r?\n/).find((line) => line.trim() && !line.startsWith('#'))?.trim() ||
          name
        const resources = await this.listResources(name)
        this.documents.push({
          name: skillName,
          description: description.slice(0, 300),
          ...(meta['when_to_use'] ? { whenToUse: meta['when_to_use'].slice(0, 300) } : {}),
          body: body.slice(0, MAX_BODY_CHARS),
          resources,
        })
      } catch {
        // A broken skill must not stop a run.
      }
    }
    this.documents.sort((a, b) => a.name.localeCompare(b.name))
    return this.list()
  }

  list(): SkillSummary[] {
    return this.documents.map(({ name, description, whenToUse }) => ({
      name,
      description,
      ...(whenToUse ? { whenToUse } : {}),
    }))
  }

  read(name: string): SkillDocument | null {
    return this.documents.find((skill) => skill.name === name) ?? null
  }

  /** Re-read the skills directory after a skill was created in this session. */
  async reload(): Promise<SkillSummary[]> {
    this.loaded = false
    this.documents = []
    return this.load()
  }

  private async listResources(skillDir: string): Promise<string[]> {
    try {
      const entries = await readdir(join(this.root, '.pilot', 'skills', skillDir), {
        withFileTypes: true,
      })
      return entries
        .filter((entry) => entry.isFile() && entry.name !== 'SKILL.md')
        .map((entry) => entry.name)
        .slice(0, 50)
    } catch {
      return []
    }
  }
}
