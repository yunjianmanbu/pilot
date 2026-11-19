/**
 * Task format for the public-benchmark harness.
 *
 * Two kinds share one shape, so the runner and the reporter never branch on
 * provenance:
 *
 * - `local`    — a fresh workspace materialised from `files`. Used by the smoke
 *                suite (which must pass *and* fail something, otherwise a green
 *                report proves nothing) and by hand-written regression tasks.
 * - `swebench` — a git worktree checked out at `baseCommit` from a local mirror
 *                of the upstream repository, with the official problem
 *                statement as the prompt. Nothing from FAIL_TO_PASS/PASS_TO_PASS
 *                is shown to the agent: those are grading metadata, and leaking
 *                them turns a benchmark into a lookup.
 *
 * A suite is JSONL: one task per line. Blank lines and lines starting with `#`
 * are ignored, so a suite file can carry its own provenance comment (which
 * dataset revision, which subset, why these instances were picked).
 */
import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

export type TaskKind = 'local' | 'swebench'

/** One scripted tool call, used only by `--mock` to prove the pipeline runs. */
export interface MockStep {
  tool: string
  arguments: Record<string, unknown>
}

export interface EvalTask {
  id: string
  kind: TaskKind
  /** What the agent is asked to do. For SWE-bench this is the issue text. */
  prompt: string
  /** Files written into an empty workspace before the agent starts (`local`). */
  files?: Record<string, string>
  /** Commands run in the workspace before the agent starts, in order. */
  setup?: string[]
  /** Exit code 0 means the task is resolved. */
  testCommand: string
  /** Local mirror of the upstream repo (`swebench`). */
  repoPath?: string
  baseCommit?: string
  /** Provenance kept verbatim in the report (repo name, dataset version...). */
  meta?: Record<string, unknown>
  /** Scripted transcript for `--mock`. Never present in a scored suite. */
  mockPlan?: MockStep[]
}

export interface LoadOptions {
  /** Parent directory holding one checkout/mirror per `repo` (`--repo-root`). */
  repoRoot?: string
}

interface RawTask {
  [key: string]: unknown
}

function asString(value: unknown, field: string, line: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`第 ${line} 行：字段 ${field} 必须是非空字符串`)
  }
  return value
}

function rawToTask(raw: RawTask, line: number, options: LoadOptions): EvalTask {
  // Accept the official SWE-bench field names as well as our own, so an
  // unmodified dataset file only needs `test_cmd` + a repo path added.
  const id = String(raw['id'] ?? raw['instance_id'] ?? '')
  if (!id) throw new Error(`第 ${line} 行：缺少 id / instance_id`)
  const prompt = String(raw['prompt'] ?? raw['problem_statement'] ?? '')
  if (!prompt.trim()) throw new Error(`第 ${line} 行：缺少 prompt / problem_statement`)
  const testCommand = asString(raw['testCommand'] ?? raw['test_cmd'], 'test_cmd', line)
  const repoName = typeof raw['repo'] === 'string' && raw['repo'] ? raw['repo'] : undefined
  const explicitRepo = typeof raw['repo_path'] === 'string' ? raw['repo_path'] : undefined
  if (!explicitRepo && !options.repoRoot) {
    throw new Error(`第 ${line} 行：需要 repo_path，或用 --repo-root 指定镜像目录`)
  }
  const repoPath = explicitRepo
    ? isAbsolute(explicitRepo)
      ? explicitRepo
      : join(options.repoRoot ?? process.cwd(), explicitRepo)
    : join(options.repoRoot as string, String(repoName))
  const baseCommit = typeof raw['baseCommit'] === 'string' ? raw['baseCommit'] : typeof raw['base_commit'] === 'string' ? raw['base_commit'] : undefined
  if (!baseCommit) throw new Error(`第 ${line} 行：缺少 base_commit`)

  const files: Record<string, string> = {}
  if (raw['files'] && typeof raw['files'] === 'object') {
    for (const [path, content] of Object.entries(raw['files'] as Record<string, unknown>)) {
      if (typeof content !== 'string') throw new Error(`第 ${line} 行：files.${path} 必须是字符串`)
      files[path] = content
    }
  }
  const setup = Array.isArray(raw['setup']) ? raw['setup'].map((item) => String(item)) : undefined
  const meta: Record<string, unknown> = { ...(raw['meta'] as Record<string, unknown> | undefined) }
  if (repoName) meta['repo'] = repoName
  if (raw['version']) meta['version'] = raw['version']

  let mockPlan: MockStep[] | undefined
  if (Array.isArray(raw['mockPlan'])) {
    mockPlan = raw['mockPlan'].map((step, index) => {
      const entry = step as RawTask
      const tool = String(entry['tool'] ?? '')
      if (!tool) throw new Error(`第 ${line} 行：mockPlan[${index}] 缺少 tool`)
      return { tool, arguments: (entry['arguments'] as Record<string, unknown>) ?? {} }
    })
  }

  return {
    id,
    kind: files && Object.keys(files).length > 0 ? 'local' : 'swebench',
    prompt,
    files: files && Object.keys(files).length > 0 ? files : undefined,
    setup,
    testCommand,
    repoPath: files && Object.keys(files).length > 0 ? undefined : repoPath,
    baseCommit: files && Object.keys(files).length > 0 ? undefined : baseCommit,
    meta: Object.keys(meta).length > 0 ? meta : undefined,
    mockPlan,
  }
}

/** Read a JSONL suite. Fails loudly on the first malformed line. */
export function loadTasks(file: string, options: LoadOptions = {}): EvalTask[] {
  const text = readFileSync(file, 'utf8')
  const tasks: EvalTask[] = []
  const seen = new Set<string>()
  let line = 0
  for (const raw of text.split(/\r?\n/)) {
    line += 1
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    let parsed: RawTask
    try {
      parsed = JSON.parse(trimmed) as RawTask
    } catch (error) {
      throw new Error(`第 ${line} 行不是合法 JSON：${(error as Error).message}`)
    }
    const task = rawToTask(parsed, line, options)
    if (seen.has(task.id)) throw new Error(`第 ${line} 行：重复的任务 id ${task.id}`)
    seen.add(task.id)
    tasks.push(task)
  }
  if (tasks.length === 0) throw new Error(`${file} 里没有任何任务`)
  return tasks
}
