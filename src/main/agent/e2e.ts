import { access, readFile, readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { nativeImage } from 'electron'
import type { ShellInterpreter, ToolResult } from '../../shared/types'
import { runCommand, runShell } from '../workspace'
import { packageManager } from './checks'
import { encodeJpegDataUrl } from './screenshots'

/**
 * End-to-end runner integration. Pilot detects the project's own runner,
 * executes a narrow spec, parses the failure summary, and attaches failure
 * screenshots. It never installs browsers or test runners: a missing binary
 * becomes an actionable message for the user.
 */
export type E2EKind = 'playwright' | 'cypress' | 'wdio' | 'script'

export interface E2EPlan {
  kind: E2EKind
  /** Human-readable runner label. */
  runner: string
  command: string
  args: string[]
  /** Package script name for the fallback kind. */
  script: string | null
}

export interface E2ERunRequest {
  file?: string
  grep?: string
  project?: string
  maxFailures?: number
  timeoutMs?: number
  cwd?: string
}

const E2E_DIRS = [
  'test-results',
  'playwright-report',
  'cypress/screenshots',
  'cypress/videos',
  'screenshots',
  'e2e/screenshots',
]
const MAX_SCREENSHOT_CANDIDATES = 400
const MAX_ATTACHED_SCREENSHOTS = 2
const DEFAULT_TIMEOUT_MS = 600_000

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function detectE2E(root: string): Promise<E2EPlan | null> {
  let scripts: Record<string, string> = {}
  try {
    const parsed: unknown = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    if (parsed && typeof parsed === 'object') {
      const raw = (parsed as Record<string, unknown>)['scripts']
      if (raw && typeof raw === 'object') {
        for (const [name, value] of Object.entries(raw)) {
          if (typeof value === 'string') scripts[name] = value
        }
      }
    }
  } catch {
    // No package.json: only the project-script fallback is impossible anyway.
  }

  const playwright = join(root, 'node_modules', '@playwright', 'test', 'cli.js')
  if (await exists(playwright)) {
    return {
      kind: 'playwright',
      runner: 'Playwright',
      command: 'node',
      args: [relative(root, playwright).replace(/\\/g, '/'), 'test'],
      script: null,
    }
  }

  const cypress = join(root, 'node_modules', 'cypress', 'bin', 'cypress')
  if (await exists(cypress)) {
    return {
      kind: 'cypress',
      runner: 'Cypress',
      command: 'node',
      args: [relative(root, cypress).replace(/\\/g, '/'), 'run'],
      script: null,
    }
  }

  const wdio = join(root, 'node_modules', '@wdio', 'cli', 'bin', 'wdio.js')
  if (await exists(wdio)) {
    return {
      kind: 'wdio',
      runner: 'WebdriverIO',
      command: 'node',
      args: [relative(root, wdio).replace(/\\/g, '/'), 'run'],
      script: null,
    }
  }

  for (const name of ['test:e2e', 'e2e', 'e2e:test']) {
    if (typeof scripts[name] === 'string') {
      return {
        kind: 'script',
        runner: `package script "${name}"`,
        command: await packageManager(root),
        args: ['run', name],
        script: name,
      }
    }
  }
  return null
}

function normalizeSpec(value: string): string {
  const text = value.trim().replace(/\\/g, '/')
  if (!text || text.length > 300) throw new Error('file must be a relative spec path (max 300 chars)')
  if (/[\0\r\n]/.test(text)) throw new Error('file may not contain control characters')
  if (isAbsolute(text) || /^[A-Za-z]:/.test(text)) {
    throw new Error('file must be relative to the workspace')
  }
  if (text.startsWith('-') || text.split('/').includes('..')) {
    throw new Error('file must be a plain relative path inside the workspace')
  }
  return text
}

function normalizeFilter(value: string | undefined, label: string): string {
  const text = (value ?? '').trim()
  if (!text) return ''
  if (text.length > 200) throw new Error(`${label} is too long (max 200 characters)`)
  if (/[\0\r\n]/.test(text)) throw new Error(`${label} may not contain control characters`)
  return text
}

export function buildE2EArgs(
  plan: E2EPlan,
  request: E2ERunRequest,
): { args: string[]; notes: string[] } {
  const args = [...plan.args]
  const notes: string[] = []
  const file = request.file ? normalizeSpec(request.file) : ''
  const grep = normalizeFilter(request.grep, 'grep')
  const project = normalizeFilter(request.project, 'project')
  const maxFailures = Math.min(50, Math.max(1, Math.round(request.maxFailures ?? 1)))

  if (plan.kind === 'playwright') {
    if (file) args.push(file)
    args.push(`--max-failures=${maxFailures}`, '--reporter=line')
    if (grep) args.push(`--grep=${grep}`)
    if (project) args.push(`--project=${project}`)
  } else if (plan.kind === 'cypress') {
    if (file) args.push('--spec', file)
    if (grep) notes.push('Cypress ignored grep (use a spec file or a Cypress plugin).')
    if (project) notes.push('Cypress ignored project (use --spec with a config file instead).')
  } else if (plan.kind === 'wdio') {
    if (file) args.push('--spec', file)
    if (grep) notes.push('WebdriverIO ignored grep.')
    if (project) notes.push('WebdriverIO ignored project.')
  } else if (file || grep || project) {
    throw new Error(
      `The project runs E2E through the "${plan.script}" package script, which does not accept Pilot filters. Run it without file/grep/project, or point Pilot at the runner itself.`,
    )
  }
  return { args, notes }
}

function cleanAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
}

export function summarizeE2E(
  output: string,
): { counts: string[]; failures: string[]; installHint: string | null } {
  const clean = cleanAnsi(output)
  const counts = new Map<string, number>()
  for (const match of clean.matchAll(/(\d+)\s+(failed|flaky|passed|pending|skipped|passing|failing)\b/gi)) {
    const count = Number(match[1] ?? 0)
    const word = (match[2] ?? '').toLowerCase()
    if (Number.isFinite(count)) counts.set(word, Math.max(counts.get(word) ?? 0, count))
  }

  const failurePattern =
    /(?:✘|×|✗|FAILED|failed|failing|AssertionError|TimeoutError|Error:|expect\(|Expected|Received|locator\(|waiting for|Call log:|at .+:\d+:\d+)/i
  const failures: string[] = []
  const seen = new Set<string>()
  for (const raw of clean.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.length > 400) continue
    if (!failurePattern.test(line)) continue
    if (/^[✓✔]/.test(line)) continue
    if (seen.has(line)) continue
    seen.add(line)
    failures.push(line)
    if (failures.length >= 60) break
  }

  let installHint: string | null = null
  if (/Executable doesn't exist|playwright install|BrowserType\.launch.*Executable/i.test(clean)) {
    installHint =
      'Playwright browser binaries are missing. Pilot never installs browsers automatically; ask the user to run the project\'s documented install step (for example `pnpm exec playwright install`).'
  } else if (/Cypress executable not found|No version of Cypress is installed|Cypress failed to start/i.test(clean)) {
    installHint =
      'Cypress is not installed correctly. Ask the user to reinstall project dependencies; Pilot does not install test runners.'
  } else if (/Couldn't find a browser|browser.*not installed|Unable to obtain browser/i.test(clean)) {
    installHint =
      'The E2E browser is missing. Ask the user to install it with the project\'s documented command; Pilot does not install browsers.'
  }
  return {
    counts: [...counts.entries()].map(([word, count]) => `${count} ${word}`),
    failures,
    installHint,
  }
}

interface ScreenshotCandidate {
  path: string
  mtimeMs: number
}

async function collectScreenshots(
  dir: string,
  depth: number,
  since: number,
  out: ScreenshotCandidate[],
): Promise<void> {
  if (depth > 4 || out.length >= MAX_SCREENSHOT_CANDIDATES) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (out.length >= MAX_SCREENSHOT_CANDIDATES) return
    if (entry.name.startsWith('.git') || entry.name === 'node_modules') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      await collectScreenshots(path, depth + 1, since, out)
      continue
    }
    if (!/\.(?:png|jpe?g|webp)$/i.test(entry.name)) continue
    try {
      const info = await stat(path)
      if (info.mtimeMs >= since - 2_000) out.push({ path, mtimeMs: info.mtimeMs })
    } catch {
      // File vanished between readdir and stat.
    }
  }
}

async function failureScreenshots(
  root: string,
  output: string,
  startedAt: number,
): Promise<ScreenshotCandidate[]> {
  const found: ScreenshotCandidate[] = []
  for (const dir of E2E_DIRS) {
    await collectScreenshots(join(root, dir), 0, startedAt, found)
  }
  // Reporters often print artifact paths explicitly; honour those first.
  for (const match of output.matchAll(/(?:[A-Za-z]:[\\/]|\/)?[^\s"'<>|]+\.(?:png|jpe?g|webp)/gi)) {
    const raw = match[0] ?? ''
    if (!raw || raw.includes('://')) continue
    const candidate = isAbsolute(raw) ? raw : resolve(root, raw)
    const rel = relative(root, candidate)
    if (rel.startsWith('..') || isAbsolute(rel)) continue
    try {
      const info = await stat(candidate)
      if (info.isFile()) found.push({ path: candidate, mtimeMs: info.mtimeMs })
    } catch {
      // Not a real file (for example a glob in a config).
    }
  }
  const unique = new Map<string, ScreenshotCandidate>()
  for (const item of found) unique.set(item.path, item)
  return [...unique.values()].sort((left, right) => right.mtimeMs - left.mtimeMs)
}

async function attachFailureScreenshots(
  root: string,
  output: string,
  startedAt: number,
): Promise<{
  images: string[]
  details: Array<{ path: string; width: number; height: number }>
}> {
  const images: string[] = []
  const details: Array<{ path: string; width: number; height: number }> = []
  let candidates: ScreenshotCandidate[]
  try {
    candidates = await failureScreenshots(root, output, startedAt)
  } catch {
    return { images, details }
  }
  for (const candidate of candidates) {
    if (images.length >= MAX_ATTACHED_SCREENSHOTS) break
    try {
      const info = await stat(candidate.path)
      if (info.size > 8 * 1024 * 1024) continue
      const image = nativeImage.createFromPath(candidate.path)
      if (image.isEmpty()) continue
      const encoded = encodeJpegDataUrl(image, 1_200)
      images.push(encoded.dataUrl)
      details.push({ path: candidate.path, width: encoded.width, height: encoded.height })
    } catch {
      // A corrupt or unreadable screenshot must not hide the test failures.
    }
  }
  return { images, details }
}

export interface E2EOptions {
  sandbox: { network: boolean } | null
  shellInterpreter: ShellInterpreter
  shellEnabled: boolean
}

export async function runE2E(
  root: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
  options: E2EOptions,
): Promise<ToolResult> {
  const plan = await detectE2E(root)
  if (!plan) {
    return {
      ok: false,
      output: '',
      error:
        'No E2E runner found. Pilot looks for @playwright/test, cypress, @wdio/cli in node_modules, or a test:e2e/e2e package script. Add one, or use run_command for the project\'s documented E2E command.',
    }
  }

  const request: E2ERunRequest = {
    ...(typeof args['file'] === 'string' ? { file: args['file'] } : {}),
    ...(typeof args['grep'] === 'string' ? { grep: args['grep'] } : {}),
    ...(typeof args['project'] === 'string' ? { project: args['project'] } : {}),
    ...(typeof args['maxFailures'] === 'number' ? { maxFailures: args['maxFailures'] } : {}),
    ...(typeof args['timeoutMs'] === 'number' ? { timeoutMs: args['timeoutMs'] } : {}),
    ...(typeof args['cwd'] === 'string' ? { cwd: args['cwd'] } : {}),
  }
  const { args: extra, notes } = buildE2EArgs(plan, request)
  const timeoutMs = Math.min(
    DEFAULT_TIMEOUT_MS,
    Math.max(10_000, Math.round(request.timeoutMs ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS),
  )

  if (plan.kind === 'script' && !options.shellEnabled) {
    return {
      ok: false,
      output: '',
      error:
        'This project exposes E2E only as a package script, which needs Shell mode to launch on Windows. Enable Shell mode in Settings or install a supported runner in node_modules.',
    }
  }

  const commandLine = `${plan.command} ${[...plan.args, ...extra].join(' ')}`
  const startedAt = Date.now()
  const result =
    plan.kind === 'script'
      ? await runShell(
          root,
          { command: commandLine, ...(request.cwd ? { cwd: request.cwd } : {}), timeoutMs },
          signal,
          options.sandbox,
          options.shellInterpreter,
        )
      : await runCommand(
          root,
          {
            command: plan.command,
            args: [...plan.args, ...extra],
            ...(request.cwd ? { cwd: request.cwd } : {}),
            timeoutMs,
          },
          signal,
        )

  const summary = summarizeE2E(result.output)
  const screenshotData: {
    images: string[]
    details: Array<{ path: string; width: number; height: number }>
  } = result.ok
    ? { images: [], details: [] }
    : await attachFailureScreenshots(root, result.output, startedAt)
  const header = [
    `E2E: ${plan.runner}`,
    `Command: ${commandLine}`,
    `Exit: ${result.exitCode ?? 'none'} (${result.ok ? 'passed' : 'failed'}) in ${Math.round(
      result.durationMs / 1000,
    )}s`,
    ...(summary.counts.length > 0 ? [`Counts: ${summary.counts.join(', ')}`] : []),
    ...(notes.length > 0 ? [`Notes: ${notes.join(' ')}`] : []),
    ...(summary.installHint ? [`Install: ${summary.installHint}`] : []),
  ]
  const failureBlock =
    summary.failures.length > 0
      ? ['', 'Key failure lines:', ...summary.failures.map((line) => `  ${line}`)]
      : []
  const rawLimit = result.ok ? 4_000 : 20_000
  const raw =
    result.output.length > rawLimit
      ? `…\n${result.output.slice(-rawLimit)}`
      : result.output

  return {
    ok: result.ok,
    output: [...header, ...failureBlock, '', 'Raw output:', raw || '(no output)'].join('\n'),
    ...(result.error ? { error: result.error } : {}),
    durationMs: result.durationMs,
    metadata: {
      // A completed E2E run is a real verification signal even if it passed
      // only a narrow spec; failures do not mark a run checked.
      verification: true,
      e2e: {
        kind: plan.kind,
        runner: plan.runner,
        command: commandLine,
        counts: summary.counts,
        failures: summary.failures.slice(0, 20),
        screenshots: screenshotData.details.map((detail) => detail.path),
      },
      ...(screenshotData.images.length > 0
        ? {
            images: screenshotData.images,
            screenshot: {
              target: 'e2e-failure',
              width: screenshotData.details[0]?.width ?? 0,
              height: screenshotData.details[0]?.height ?? 0,
              path: screenshotData.details[0]?.path ?? null,
            },
          }
        : {}),
    },
  }
}
