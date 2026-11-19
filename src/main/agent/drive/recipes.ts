import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { resolveForWrite } from '../../workspace'
import type {
  DriveFingerprint,
  DriveKind,
  DriveRecipe,
  DriveRecipeSummary,
  DriveStep,
  DriveSurface,
} from './types'

/**
 * Recipes are the memory of the driving layer: a verified sequence plus the
 * surface order that worked, keyed by an app fingerprint. They live inside the
 * workspace so they can be reviewed and committed with the project. A recipe
 * is only written after a successful run; reuse is still gated by the same
 * step execution, so a stale recipe fails loudly instead of pretending.
 */
const RECIPE_DIR = '.pilot/recipes'
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/
const MAX_RECIPE_BYTES = 128 * 1024
const MAX_STEPS = 50
const SURFACES: DriveSurface[] = [
  'cdp',
  'http',
  'cli',
  'playwright',
  'uia',
  'adb',
  'screenshot',
  'custom',
]
const STEP_KINDS = new Set([
  'evaluate',
  'click',
  'type',
  'press',
  'wait',
  'screenshot',
  'console',
  'assertText',
  'assertValue',
  'http',
  'cli',
  'uia',
  'adb',
  'tool',
])
const KINDS: DriveKind[] = ['electron', 'tauri', 'web', 'native', 'android', 'http', 'unknown']

export function recipeDirectory(root: string): string {
  const base = resolve(root)
  const dir = resolve(base, RECIPE_DIR)
  if (dir !== base && !dir.startsWith(`${base}\\`) && !dir.startsWith(`${base}/`)) {
    throw new Error('Recipe directory escapes the workspace')
  }
  return dir
}

function asString(value: unknown, field: string, max = 4_000): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`)
  if (value.length > max) throw new Error(`${field} is too long (max ${max} characters)`)
  return value
}

function optionalString(value: unknown, field: string, max = 4_000): string | undefined {
  return value === undefined ? undefined : asString(value, field, max)
}

function asOptionalInteger(value: unknown): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return undefined
  return Math.round(parsed)
}

function asStep(value: unknown, index: number): DriveStep {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`steps[${index}] must be an object`)
  }
  const record = value as Record<string, unknown>
  const doValue = record['do']
  if (typeof doValue !== 'string' || !STEP_KINDS.has(doValue)) {
    throw new Error(`steps[${index}].do is not supported`)
  }
  const step: DriveStep = { do: doValue as DriveStep['do'] }
  for (const key of [
    'description',
    'selector',
    'text',
    'key',
    'expression',
    'label',
    'method',
    'url',
    'body',
    'expectBody',
    'expectText',
    'command',
    'expectOutput',
    'tool',
    'name',
    'automationId',
    'value',
    'windowTitle',
    'serial',
    'shell',
  ] as const) {
    const parsed = optionalString(record[key], `steps[${index}].${key}`)
    if (parsed !== undefined) step[key] = parsed
  }
  for (const key of ['nth', 'timeoutMs', 'durationMs', 'expectStatus', 'expectExit', 'x', 'y'] as const) {
    const parsed = asOptionalInteger(record[key])
    if (parsed !== undefined) step[key] = parsed
  }
  if (record['clear'] !== undefined) step.clear = record['clear'] === true
  if (record['args'] !== undefined) {
    if (!Array.isArray(record['args']) || record['args'].length > 40) {
      throw new Error(`steps[${index}].args must be an array of at most 40 strings`)
    }
    step.args = record['args'].map((item, itemIndex) => asString(item, `steps[${index}].args[${itemIndex}]`, 1_000))
  }
  if (record['headers'] !== undefined) {
    if (!record['headers'] || typeof record['headers'] !== 'object' || Array.isArray(record['headers'])) {
      throw new Error(`steps[${index}].headers must be an object of strings`)
    }
    const headers: Record<string, string> = {}
    for (const [header, headerValue] of Object.entries(record['headers'] as Record<string, unknown>)) {
      headers[header] = asString(headerValue, `steps[${index}].headers.${header}`, 1_000)
    }
    step.headers = headers
  }
  if (record['toolArgs'] !== undefined) {
    if (!record['toolArgs'] || typeof record['toolArgs'] !== 'object' || Array.isArray(record['toolArgs'])) {
      throw new Error(`steps[${index}].toolArgs must be an object`)
    }
    step.toolArgs = record['toolArgs'] as Record<string, unknown>
  }
  if (record['uiaAction'] !== undefined) {
    if (record['uiaAction'] !== 'read' && record['uiaAction'] !== 'invoke' && record['uiaAction'] !== 'setText') {
      throw new Error(`steps[${index}].uiaAction must be read, invoke or setText`)
    }
    step.uiaAction = record['uiaAction']
  }
  if (record['adbAction'] !== undefined) {
    const action = record['adbAction']
    if (action !== 'dump' && action !== 'tap' && action !== 'text' && action !== 'shell') {
      throw new Error(`steps[${index}].adbAction must be dump, tap, text or shell`)
    }
    step.adbAction = action
  }
  return step
}

export function validateSteps(input: unknown): DriveStep[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error('steps must be a non-empty array')
  }
  if (input.length > MAX_STEPS) throw new Error(`steps may contain at most ${MAX_STEPS} items`)
  return input.map((step, index) => asStep(step, index))
}

export function validateRecipe(input: unknown): DriveRecipe {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('recipe must be an object')
  }
  const record = input as Record<string, unknown>
  const name = asString(record['name'], 'name', 64)
  if (!NAME_PATTERN.test(name)) {
    throw new Error('name must be lowercase letters, digits and dashes (2-64 characters)')
  }
  if (record['version'] !== 1) throw new Error('version must be 1')
  const fingerprintRaw = record['fingerprint']
  if (!fingerprintRaw || typeof fingerprintRaw !== 'object') {
    throw new Error('fingerprint must be an object')
  }
  const fp = fingerprintRaw as Record<string, unknown>
  const kind = fp['kind']
  if (typeof kind !== 'string' || !KINDS.includes(kind as DriveKind)) {
    throw new Error('fingerprint.kind is not supported')
  }
  const markersRaw = fp['markers']
  const markers = Array.isArray(markersRaw)
    ? markersRaw.map((marker, index) => asString(marker, `fingerprint.markers[${index}]`, 200)).slice(0, 40)
    : []
  const fingerprint: DriveFingerprint = {
    kind: kind as DriveKind,
    markers,
    key: asString(fp['key'], 'fingerprint.key', 120),
  }

  const surfaceRaw = record['surfaceOrder']
  if (!Array.isArray(surfaceRaw) || surfaceRaw.length === 0) {
    throw new Error('surfaceOrder must be a non-empty array')
  }
  const surfaceOrder: DriveSurface[] = []
  for (const [index, surface] of surfaceRaw.entries()) {
    if (typeof surface !== 'string' || !SURFACES.includes(surface as DriveSurface)) {
      throw new Error(`surfaceOrder[${index}] is not a supported surface`)
    }
    if (!surfaceOrder.includes(surface as DriveSurface)) surfaceOrder.push(surface as DriveSurface)
  }

  const stepsRaw = record['steps']
  if (!Array.isArray(stepsRaw) || stepsRaw.length === 0) {
    throw new Error('steps must be a non-empty array')
  }
  if (stepsRaw.length > MAX_STEPS) throw new Error(`steps may contain at most ${MAX_STEPS} items`)
  const steps = stepsRaw.map((step, index) => asStep(step, index))

  const now = new Date().toISOString()
  const recipe: DriveRecipe = {
    version: 1,
    name,
    ...(optionalString(record['note'], 'note', 1_000) ? { note: asString(record['note'], 'note', 1_000) } : {}),
    fingerprint,
    surfaceOrder,
    steps,
    createdAt: optionalString(record['createdAt'], 'createdAt', 60) ?? now,
    updatedAt: now,
    successCount: Math.max(0, asOptionalInteger(record['successCount']) ?? 0),
    failureCount: Math.max(0, asOptionalInteger(record['failureCount']) ?? 0),
  }
  if (JSON.stringify(recipe).length > MAX_RECIPE_BYTES) {
    throw new Error(`recipe is too large (max ${MAX_RECIPE_BYTES} characters)`)
  }
  return recipe
}

/** Build a new recipe from a successful run. */
export function buildRecipe(input: {
  name: string
  note?: string
  fingerprint: DriveFingerprint
  surfaceOrder: DriveSurface[]
  steps: DriveStep[]
}): DriveRecipe {
  return validateRecipe({
    version: 1,
    name: input.name,
    ...(input.note ? { note: input.note } : {}),
    fingerprint: input.fingerprint,
    surfaceOrder: input.surfaceOrder,
    steps: input.steps,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    successCount: 1,
    failureCount: 0,
  })
}

function recipePath(root: string, name: string): string {
  if (!NAME_PATTERN.test(name)) throw new Error('Invalid recipe name')
  return join(recipeDirectory(root), `${name}.json`)
}

export async function loadRecipe(root: string, name: string): Promise<DriveRecipe> {
  const raw = await readFile(recipePath(root, name), 'utf8').catch(() => {
    throw new Error(`Recipe "${name}" not found under ${RECIPE_DIR}`)
  })
  if (raw.length > MAX_RECIPE_BYTES) throw new Error(`Recipe "${name}" is too large`)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`Recipe "${name}" is not valid JSON`)
  }
  return validateRecipe(parsed)
}

export async function saveRecipe(root: string, recipe: DriveRecipe): Promise<string> {
  const valid = validateRecipe(recipe)
  // Same mutation policy as every other workspace write: the path must stay
  // inside the workspace and must not be a symlink pointing elsewhere.
  const path = await resolveForWrite(root, join(RECIPE_DIR, `${valid.name}.json`))
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(valid, null, 2)}\n`, 'utf8')
  return path
}

export async function recordRecipeRun(root: string, name: string, ok: boolean): Promise<void> {
  try {
    const recipe = await loadRecipe(root, name)
    recipe.successCount += ok ? 1 : 0
    recipe.failureCount += ok ? 0 : 1
    recipe.updatedAt = new Date().toISOString()
    await saveRecipe(root, recipe)
  } catch {
    // A missing or broken recipe must not turn a completed run into a failure.
  }
}

export async function listRecipes(
  root: string,
  fingerprint?: DriveFingerprint,
): Promise<DriveRecipeSummary[]> {
  const dir = recipeDirectory(root)
  let names: string[]
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.json'))
  } catch {
    return []
  }
  const summaries: DriveRecipeSummary[] = []
  for (const file of names.sort()) {
    try {
      const raw = await readFile(join(dir, file), 'utf8')
      if (raw.length > MAX_RECIPE_BYTES) continue
      const recipe = validateRecipe(JSON.parse(raw))
      const exact = fingerprint ? recipe.fingerprint.key === fingerprint.key : false
      const sameKind = fingerprint ? recipe.fingerprint.kind === fingerprint.kind : false
      if (fingerprint && !exact && !sameKind) continue
      summaries.push({
        name: recipe.name,
        ...(recipe.note ? { note: recipe.note } : {}),
        fingerprintKey: recipe.fingerprint.key,
        kind: recipe.fingerprint.kind,
        updatedAt: recipe.updatedAt,
        successCount: recipe.successCount,
        failureCount: recipe.failureCount,
        match: exact ? 'exact' : 'kind',
        stepCount: recipe.steps.length,
      })
    } catch {
      // Skip a malformed recipe; one bad file must not hide the rest.
    }
  }
  return summaries.sort((a, b) => {
    if (a.match !== b.match) return a.match === 'exact' ? -1 : 1
    return b.updatedAt.localeCompare(a.updatedAt)
  })
}
