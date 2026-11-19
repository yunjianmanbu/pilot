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
  /(?:^|[\s;&|])(?:vitest|jest|mocha|pytest|rspec|php\s+artisan\s+test|mix\s+test|tsc|eslint|stylelint|biome|cargo\s+(?:test|check|clippy)|go\s+(?:test|vet)|dotnet\s+test|mvn\s+(?:test|verify)|gradlew?(?:\.bat)?\s+(?:test|check)|make\s+(?:test|check)|node\s+(?:--test\b|[^\s;&|]*\.(?:test|spec)\.[cm]?js\b)|(?:node|python3?|ruby)\s+[^\s;&|]+\.(?:[cm]?[jt]s|py|rb)\b|(?:go|cargo|dotnet)\s+run\b|(?:pnpm|npm|yarn|bun)(?:\.cmd)?\s+(?:(?:run|exec|dlx)\s+)?(?:test|typecheck|lint|build|vitest|jest|tsc|eslint)(?![:\w-])|playwright\s+test\b|cypress\s+run\b|(?:wdio|detox)\s+(?:run|test)\b|(?:pnpm|npm|yarn|bun)(?:\.cmd)?\s+(?:(?:run|exec|dlx)\s+)?(?:test:e2e|e2e)(?![:\w-]))\b/i

export function isVerificationCommand(command: string): boolean {
  return VERIFICATION_COMMAND.test(command.trim())
}

export async function detectCheckCommands(root: string): Promise<string> {
  let scripts: Record<string, unknown> = {}
  try {
    const raw = await readFile(join(root, 'package.json'), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      const value = (parsed as Record<string, unknown>)['scripts']
      if (value && typeof value === 'object') scripts = value as Record<string, unknown>
    }
  } catch {
    return ''
  }

  const manager = await packageManager(root)
  const parts: string[] = []
  for (const name of ['typecheck', 'test', 'lint'] as const) {
    if (typeof scripts[name] === 'string') {
      parts.push(manager === 'npm' ? `npm run ${name}` : `${manager} ${name}`)
    }
  }
  if (parts.length === 0 && typeof scripts['build'] === 'string') {
    parts.push(manager === 'npm' ? 'npm run build' : `${manager} build`)
  }
  return parts.join('；')
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
