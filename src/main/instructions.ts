import { lstat, mkdir, open, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AppLocale } from '../shared/i18n'
import type { ProjectInstructionFile } from '../shared/types'
import { resolveExisting } from './workspace'

const INSTRUCTION_FILES = ['PILOT.md', 'AGENTS.md'] as const
const MAX_FILE_BYTES = 24 * 1024
const MAX_TOTAL_CHARS = 32_000

export interface LoadedProjectInstruction extends ProjectInstructionFile {
  content: string
}

async function readLimited(target: string, maxBytes: number): Promise<{ content: string; bytes: number; truncated: boolean }> {
  const info = await stat(target)
  if (!info.isFile()) return { content: '', bytes: 0, truncated: false }
  const length = Math.min(info.size, maxBytes)
  if (length <= 0) return { content: '', bytes: 0, truncated: info.size > maxBytes }
  const handle = await open(target, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    const raw = buffer.subarray(0, bytesRead).toString('utf8')
    return {
      content: raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw,
      bytes: bytesRead,
      truncated: info.size > maxBytes,
    }
  } finally {
    await handle.close()
  }
}

/**
 * Why an instruction file did not reach the model in full. Missing files are
 * normal and stay silent; a present but unreadable or oversized file is a real
 * loss of project rules, so the run has to say so instead of quietly dropping
 * the conventions the repository asked for.
 */
export interface InstructionIssues {
  truncated: { name: string; bytes: number }[]
  unreadable: { name: string; reason: string }[]
}

async function existsUnsafe(target: string): Promise<boolean> {
  try {
    await lstat(target)
    return true
  } catch {
    return false
  }
}

/**
 * Load project instructions from the workspace root. The files are read
 * through the workspace jail, capped in size, and never resolved outside the
 * selected folder (a symlinked PILOT.md is rejected by resolveExisting).
 */
export async function loadProjectInstructions(
  workspacePath: string,
): Promise<LoadedProjectInstruction[]> {
  return (await loadProjectInstructionsDetailed(workspacePath)).files
}

export async function loadProjectInstructionsDetailed(
  workspacePath: string,
): Promise<{ files: LoadedProjectInstruction[]; issues: InstructionIssues }> {
  const loaded: LoadedProjectInstruction[] = []
  const issues: InstructionIssues = { truncated: [], unreadable: [] }
  let remaining = MAX_TOTAL_CHARS
  for (const name of INSTRUCTION_FILES) {
    if (remaining <= 0) break
    try {
      const target = await resolveExisting(workspacePath, name)
      const file = await readLimited(target, MAX_FILE_BYTES)
      if (!file.content.trim()) continue
      const content = file.content.slice(0, remaining)
      const truncated = file.truncated || content.length < file.content.length
      if (truncated) issues.truncated.push({ name, bytes: file.bytes })
      loaded.push({ name, bytes: file.bytes, truncated, content })
      remaining -= content.length
    } catch (error) {
      // A missing instruction file is simply not loaded; one that exists but
      // cannot be read (symlink leaving the workspace, locked file) is reported.
      if (await existsUnsafe(join(workspacePath, name))) {
        issues.unreadable.push({
          name,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
  return { files: loaded, issues }
}

const GLOBAL_INSTRUCTION_FILE = 'PILOT.md'
const GLOBAL_INSTRUCTION_TEMPLATE = `# Pilot 全局指令

<!--
这个文件会注入到所有工作区。适合放跨项目仍然成立的行为，例如：
- 回答使用中文，先给结论。
- 修改代码后运行最窄的验证。
- 工具失败时先读错误，再换方案；不要重复同一失败调用。
项目专属的命令、路径和目录约定请写在各自工作区的 PILOT.md 或 AGENTS.md 里。
安全、审批、凭据和证据规则由程序强制执行，不能在这里关闭。
-->
`
const GLOBAL_INSTRUCTION_TEMPLATE_EN = `# Pilot global instructions

<!--
This file is injected into every workspace. Put cross-project behavior here, such as:
- Answer in the language the user writes in; lead with the conclusion.
- After changing code, run the narrowest useful verification.
- When a tool fails, read the error before switching approach; do not repeat the same failing call.
Put project-specific commands, paths and conventions in each workspace's PILOT.md or AGENTS.md.
Safety, approval, credential and evidence rules are enforced by the program and cannot be disabled here.
-->
`

/**
 * Load the user-level PILOT.md that applies to every workspace. It lives in
 * the app's userData directory, outside any workspace, and is capped like a
 * project instruction file. Missing or unreadable files are simply ignored.
 */
export async function loadGlobalInstructions(
  userDataPath: string,
): Promise<LoadedProjectInstruction[]> {
  if (!userDataPath) return []
  try {
    const file = await readLimited(join(userDataPath, GLOBAL_INSTRUCTION_FILE), MAX_FILE_BYTES)
    const content = file.content.slice(0, MAX_TOTAL_CHARS)
    if (!content.trim()) return []
    return [
      {
        name: `${GLOBAL_INSTRUCTION_FILE} (global)`,
        bytes: file.bytes,
        truncated: file.truncated || content.length < file.content.length,
        content,
      },
    ]
  } catch {
    return []
  }
}

/** Create the user-level PILOT.md with a safe template when it is missing. */
export async function ensureGlobalInstructions(
  userDataPath: string,
  locale: AppLocale = 'zh-CN',
): Promise<string> {
  await mkdir(userDataPath, { recursive: true })
  const target = join(userDataPath, GLOBAL_INSTRUCTION_FILE)
  try {
    await stat(target)
  } catch {
    const template =
      locale === 'en' ? GLOBAL_INSTRUCTION_TEMPLATE_EN : GLOBAL_INSTRUCTION_TEMPLATE
    await writeFile(target, template, { encoding: 'utf8', flag: 'wx' }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error
      },
    )
  }
  return target
}
