import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Best-effort discovery of the narrow checks a project already defines.
 * The result is injected into the verification reminder; it never runs
 * anything on its own.
 */

/**
 * Best-effort recognition of commands that actually verify a change. Used for
 * the completion contract: a write followed by `ls` is not "verified".
 * Projects with unusual tooling can still explain why no check applies; the
 * gate only asks once and never blocks completion.
 */
const VERIFICATION_COMMAND =
  /(?:^|[\s;&|])(?:vitest|jest|mocha|pytest|rspec|phpunit|php\s+artisan\s+test|mix\s+test|tsc|eslint|stylelint|biome|cargo\s+(?:test|check|clippy)|go\s+(?:test|vet)|dotnet\s+test|mvn\s+(?:test|verify)|gradlew?(?:\.bat)?\s+(?:test|check)|make\s+(?:test|check)|node\s+(?:--test\b|[^\s;&|]*\.(?:test|spec)\.[cm]?js\b)|(?:node|python3?|py|ruby)\s+[^\s;&|]+\.(?:[cm]?[jt]s|py|rb)\b|(?:python3?|py)\s+-m\s+(?:pytest|unittest|nose2?|tox)\b|(?:go|cargo|dotnet)\s+run\b|(?:pnpm|npm|yarn|bun)(?:\.cmd)?\s+(?:(?:run|exec|dlx)\s+)?(?:test|typecheck|lint|build|vitest|jest|tsc|eslint)(?![:\\w-])|playwright\s+test\b|cypress\s+run\b|(?:wdio|detox)\s+(?:run|test)\b|(?:pnpm|npm|yarn|bun)(?:\.cmd)?\s+(?:(?:run|exec|dlx)\s+)?(?:test:e2e|e2e)(?![:\\w-]))\b/i

/**
 * A runner summary in the output is proof that a test suite really executed,
 * whatever the command was called. It never widens what counts as verified:
 * an empty result or an unrelated `ls` produces none of these lines.
 */
const TEST_OUTPUT_SIGNATURE =
  /(?:\bRan \d+ tests? in \b|^(?:=+\s*)?\d+ (?:passed|failed|error)\b[^\n]*\bin\s+[\d.]+|^\s*FAILED \(|=== .+ in [\d.]+m?s ===$|^\s*Test Files\s+\d+ |^\s*Tests:\s+\d+|^\s*Tests\s+\d+ (?:passed|failed)|^\s*\d+ passing\b|^\s*\d+ examples?, \d+ failures?|^\s*OK \(\d+ tests?\)|^[✔✓] \d+ tests? passed)/im

/** Only the head of a command result is inspected, so huge logs stay cheap. */
const TEST_OUTPUT_SCAN_CHARS = 4_000

export function looksLikeTestOutput(output: string): boolean {
  if (!output) return false
  const head =
    output.length > TEST_OUTPUT_SCAN_CHARS ? output.slice(0, TEST_OUTPUT_SCAN_CHARS) : output
  return TEST_OUTPUT_SIGNATURE.test(head)
}

/** Split a shell line the same way the gates think about it: one command each. */
const SEGMENT_BREAK = /&&|\|\||[;|\n]/

/** Programs that read or inspect a file instead of executing what it contains. */
const INSPECT_PROGRAMS = new Set([
  'cat',
  'tac',
  'head',
  'tail',
  'less',
  'more',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'ack',
  'ls',
  'exa',
  'dir',
  'find',
  'fd',
  'type',
  'which',
  'where',
  'whereis',
  'file',
  'stat',
  'wc',
  'diff',
  'cmp',
  'comm',
  'sed',
  'awk',
  'gawk',
  'cut',
  'sort',
  'uniq',
  'tr',
  'echo',
  'printf',
  'touch',
  'mkdir',
  'rmdir',
  'cp',
  'mv',
  'rm',
  'chmod',
  'chown',
  'chgrp',
  'tar',
  'zip',
  'unzip',
  'git',
  'nano',
  'vi',
  'vim',
  'nvim',
  'code',
  'subl',
  'pwd',
  'readlink',
  'realpath',
  'jq',
  'yq',
  'xxd',
  'od',
  'base64',
  'md5sum',
  'sha256sum',
  'sleep',
  'kill',
  'ps',
  'du',
  'df',
  'date',
  'whoami',
  'id',
  'uname',
  'printenv',
  'export',
  'set',
  'source',
  'alias',
])

/** Prefixes that wrap the real command without changing what it does. */
const WRAPPER_PROGRAMS = new Set([
  'sudo',
  'doas',
  'env',
  'nohup',
  'nice',
  'ionice',
  'time',
  'command',
  'exec',
  'stdbuf',
  'timeout',
  'gtimeout',
  'xargs',
])

const SHELL_PROGRAMS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'pwsh', 'powershell'])

function basename(token: string): string {
  const cleaned = token.replace(/^["']|["']$/g, '')
  const parts = cleaned.split(/[\\/]/)
  return (parts[parts.length - 1] ?? cleaned).replace(/\.exe$/i, '').toLowerCase()
}

/** Index of the token that names the program, skipping assignments and wrappers. */
function programIndex(tokens: string[]): number {
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]!
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      index += 1
      continue
    }
    if (WRAPPER_PROGRAMS.has(basename(token))) {
      index += 1
      while (index < tokens.length && /^(?:-|[\d.]+[smhd]?$)/.test(tokens[index]!)) index += 1
      continue
    }
    return index
  }
  return -1
}

/** True when this token names a project test entrypoint, at any path depth. */
function isEntrypointToken(token: string): boolean {
  const name = basename(token)
  if (!name) return false
  if (name === 'tox' || name === 'nox' || name === 'ctest') return true
  if (!/\.(?:sh|bash|bat|cmd|ps1|py)$/.test(name)) return false
  return /(?:run[-_]?tests?|runtests|test[-_]?all|check[-_]?all|run[-_]?checks?|^tests?$)/.test(name)
}

/** `just test`, `hatch run test`, `bazel test`, `invoke test`, `poetry run pytest`. */
function isEntrypointHead(tokens: string[], index: number): boolean {
  const name = basename(tokens[index] ?? '')
  const next = basename(tokens[index + 1] ?? '')
  const after = basename(tokens[index + 2] ?? '')
  if (name === 'just') return /^(?:test|check|tests)$/.test(next)
  if (name === 'hatch') return next === 'run' && /^tests?$/.test(after)
  if (name === 'invoke') return next === 'test'
  if (name === 'bazel') return next === 'test'
  if (name === 'poetry') return next === 'run' && after === 'pytest'
  return false
}

/** Payload of a `-c "…"` / `-lc "…"` argument, if the segment has one. */
function inlineScript(segment: string): string {
  const match = /(?:^|\s)-(?:l?c)\s+(.+)$/.exec(segment)
  if (!match) return ''
  return (match[1] ?? '').replace(/^["']|["']$/g, '').trim()
}

/**
 * `docker exec -i 3f2a ./run-tests.sh x` runs the command after the container.
 * Returns the remainder of the segment after that point.
 */
function containerPayload(segment: string, tokens: string[], index: number): string {
  const inline = inlineScript(segment)
  if (inline) return inline
  let cursor = index + 1
  while (cursor < tokens.length && /^[a-z]+$/.test(tokens[cursor]!) && /^(?:exec|run)$/.test(tokens[cursor]!)) {
    cursor += 1
  }
  // Skip flags (`-i`, `-e FOO=bar`, `-w /x`) then the container or image name.
  while (cursor < tokens.length && tokens[cursor]!.startsWith('-')) {
    const flag = tokens[cursor]!
    cursor += 1
    if (/^-[a-zA-Z]*[ewu]$/.test(flag) || /^--(?:env|workdir|user|volume)$/.test(flag)) cursor += 1
  }
  cursor += 1
  return tokens.slice(cursor).join(' ')
}

/**
 * A segment counts only when the program it names can actually run a suite.
 * Without this, `grep -n pytest docs.md` or `cat run-tests.sh` would satisfy
 * the gate and let an unverified change complete.
 */
type SegmentKind = 'inspect' | 'entrypoint' | 'runner'

function classifySegment(segment: string, depth = 0): SegmentKind {
  const tokens = segment.trim().split(/\s+/).filter(Boolean)
  const index = programIndex(tokens)
  if (index < 0) return 'inspect'
  const name = basename(tokens[index]!)

  if ((name === 'docker' || name === 'podman') && depth === 0) {
    // Only the payload inside the box can be a test run.
    const payload = containerPayload(segment, tokens, index)
    return payload ? classifySegment(payload, depth + 1) : 'inspect'
  }
  if (SHELL_PROGRAMS.has(name)) {
    if (isEntrypointToken(tokens[index + 1] ?? '')) return 'entrypoint'
    const payload = inlineScript(segment)
    return payload ? classifySegment(payload, depth + 1) : 'inspect'
  }
  if (INSPECT_PROGRAMS.has(name)) return 'inspect'
  if (isEntrypointToken(tokens[index]!) || isEntrypointHead(tokens, index)) return 'entrypoint'
  return 'runner'
}

export function isVerificationCommand(command: string): boolean {
  for (const segment of command.split(SEGMENT_BREAK)) {
    const trimmed = segment.trim()
    if (!trimmed) continue
    const kind = classifySegment(trimmed)
    if (kind === 'entrypoint') return true
    if (kind === 'runner' && VERIFICATION_COMMAND.test(trimmed)) return true
  }
  return false
}

export async function detectCheckCommands(root: string): Promise<string> {
  const exists = async (file: string): Promise<boolean> => {
    try {
      await access(join(root, file))
      return true
    } catch {
      return false
    }
  }

  const parts: string[] = []
  // The project's own entrypoint comes first: when a repo ships one, that is
  // the only command its authors trust, and naming it saves the model a step
  // spent reading the script just to find out how tests run here.
  for (const candidate of ENTRY_SCRIPT_CANDIDATES) {
    if (await exists(candidate)) {
      parts.push(candidate.endsWith('.py') ? `python ${candidate}` : `./${candidate}`)
      break
    }
  }
  if (await exists('tox.ini')) parts.push('tox')
  if (await exists('noxfile.py')) parts.push('nox')
  if ((await exists('justfile')) || (await exists('Justfile'))) parts.push('just test')

  let scripts: Record<string, unknown> = {}
  try {
    const raw = await readFile(join(root, 'package.json'), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      const value = (parsed as Record<string, unknown>)['scripts']
      if (value && typeof value === 'object') scripts = value as Record<string, unknown>
    }
  } catch {
    scripts = {}
  }

  if (Object.keys(scripts).length > 0) {
    const manager = await packageManager(root)
    const packageParts: string[] = []
    for (const name of ['typecheck', 'test', 'lint'] as const) {
      if (typeof scripts[name] === 'string') {
        packageParts.push(manager === 'npm' ? `npm run ${name}` : `${manager} ${name}`)
      }
    }
    if (packageParts.length === 0 && typeof scripts['build'] === 'string') {
      packageParts.push(manager === 'npm' ? 'npm run build' : `${manager} build`)
    }
    parts.push(...packageParts)
  }

  if (parts.length === 0) {
    const makefile = await readFile(join(root, 'Makefile'), 'utf8').catch(() => '')
    if (/^test:/m.test(makefile)) parts.push('make test')
  }
  return parts.slice(0, 4).join('；')
}

/**
 * Entry points the workspace already ships, named as runnable commands.
 *
 * Used when a command fails with "not found": on a machine without the binary
 * the project's own entry script is the shortest path to a real result, and
 * naming it stops the model from probing for alternative interpreters. Only
 * things that exist are returned; an empty list means there is nothing to
 * suggest and the caller should stay silent.
 */
/**
 * Shell/Python entry scripts every detector below agrees on. Kept in one place
 * so the verification hint and the not-found hint never name different files.
 */
const ENTRY_SCRIPT_CANDIDATES = [
  'run-tests.sh',
  'run_tests.sh',
  'runtests.sh',
  'test.sh',
  'scripts/run-tests.sh',
  'run-tests.py',
  'runtests.py',
] as const

export async function detectEntryPoints(root: string): Promise<string[]> {
  const exists = async (file: string): Promise<boolean> => {
    try {
      await access(join(root, file))
      return true
    } catch {
      return false
    }
  }

  const entries: string[] = []
  for (const candidate of ENTRY_SCRIPT_CANDIDATES) {
    if (await exists(candidate)) {
      entries.push(candidate.endsWith('.py') ? `python3 ${candidate}` : `./${candidate}`)
      break
    }
  }
  if (await exists('Makefile')) {
    const makefile = await readFile(join(root, 'Makefile'), 'utf8').catch(() => '')
    entries.push(/^test:/m.test(makefile) ? 'make test (Makefile)' : 'make (Makefile)')
  }
  if (await exists('tox.ini')) entries.push('tox (tox.ini)')

  try {
    const parsed: unknown = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    const scripts =
      parsed && typeof parsed === 'object'
        ? ((parsed as Record<string, unknown>)['scripts'] as Record<string, unknown> | undefined)
        : undefined
    const names =
      scripts && typeof scripts === 'object'
        ? Object.keys(scripts).filter((name) => typeof scripts[name] === 'string')
        : []
    if (names.length > 0) {
      // Checks first, and long-lived dev servers last: suggesting `pnpm dev` as
      // the way out of a missing toolchain would push the model into a command
      // that never exits. Verification scripts are also what the completion
      // contract asks for later in the run.
      const rank = (name: string): number =>
        /^test(?::|$)/.test(name)
          ? 0
          : name === 'typecheck' || name === 'check'
            ? 1
            : name === 'lint'
              ? 2
              : name === 'build'
                ? 3
                : name === 'dev' || name === 'start' || name === 'serve'
                  ? 9
                  : 5
      const ordered = [...names].sort((a, b) => rank(a) - rank(b))
      const manager = await packageManager(root)
      const shown = ordered
        .slice(0, 4)
        .map((name) => (manager === 'npm' ? `npm run ${name}` : `${manager} ${name}`))
      entries.push(`${shown.join(' / ')} (package.json scripts)`)
    }
  } catch {
    // No package.json, or one that does not parse: nothing to advertise.
  }

  return entries.slice(0, 5)
}

export async function packageManager(root: string): Promise<'pnpm' | 'yarn' | 'bun' | 'npm'> {
  const exists = async (file: string): Promise<boolean> => {
    try {
      await access(join(root, file))
      return true
    } catch {
      return false
    }
  }
  if (await exists('pnpm-lock.yaml')) return 'pnpm'
  if (await exists('yarn.lock')) return 'yarn'
  if (await exists('bun.lockb')) return 'bun'
  return 'npm'
}
