import {
  executeStep,
  surfaceSupports,
  supportedStepKinds,
  type AdapterContext,
  type AdapterState,
} from './adapters'
import { probeTarget } from './probe'
import { buildRecipe, loadRecipe, recordRecipeRun, saveRecipe } from './recipes'
import type {
  DriveFallback,
  DriveHints,
  DriveProbeResult,
  DriveRunOptions,
  DriveRunResult,
  DriveStep,
  DriveStepResult,
  DriveSurface,
} from './types'

const MAX_OUTPUT_CHARS = 32_000
const MAX_STEP_OUTPUT_CHARS = 1_800

/** Specific failures drive the fallback decision; a generic retry is useless. */
export function classifyFailure(message: string): {
  signature: string
  retryable: boolean
} {
  const text = message.toLowerCase()
  // An assertion that observed the wrong state is a result, not a surface
  // failure: switching surfaces would hide the real state behind a new error.
  if (/^text not found|^value mismatch|does not contain/.test(text)) {
    return { signature: 'assertion-failed', retryable: false }
  }
  if (/no devtools endpoint|econnrefused|econnreset|connection refused|connect.*refused/.test(text)) {
    return { signature: 'debug-port-unavailable', retryable: true }
  }
  if (/timed out|timeout|etimedout/.test(text)) {
    return { signature: 'timeout', retryable: true }
  }
  if (/selector matched no element|no element|element not found|control not found/.test(text)) {
    return { signature: 'element-not-found', retryable: true }
  }
  if (/execution context was destroyed|target closed|page crashed|inspected target navigated/.test(text)) {
    return { signature: 'target-closed', retryable: true }
  }
  if (/not supported|does not support|not a drive surface/.test(text)) {
    return { signature: 'surface-unsupported', retryable: true }
  }
  if (/enoent|command not found|not on path|is not recognized/.test(text)) {
    return { signature: 'tooling-missing', retryable: true }
  }
  if (/window not found/.test(text)) {
    return { signature: 'window-not-found', retryable: true }
  }
  if (/denied|approval|blocked|permission/.test(text)) {
    return { signature: 'blocked', retryable: false }
  }
  return { signature: 'unknown', retryable: true }
}

export function applyTemplates(step: DriveStep, vars: Record<string, string>): DriveStep {
  const replace = (value: string): string =>
    value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, key: string) => vars[key] ?? whole)
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return replace(value)
    if (Array.isArray(value)) return value.map(walk)
    if (value && typeof value === 'object') {
      const result: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) result[key] = walk(item)
      return result
    }
    return value
  }
  return walk(step) as DriveStep
}

function dedupeSurfaces(values: DriveSurface[]): DriveSurface[] {
  const result: DriveSurface[] = []
  for (const value of values) if (!result.includes(value)) result.push(value)
  return result
}

function rotate(order: DriveSurface[], current: DriveSurface): DriveSurface[] {
  const index = order.indexOf(current)
  if (index < 0) return order
  return [...order.slice(index), ...order.slice(0, index)]
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function formatResult(
  result: Omit<DriveRunResult, 'output'>,
  extra: string[],
): string {
  const lines: string[] = []
  lines.push(
    `${result.ok ? 'Drive succeeded' : 'Drive failed'} for ${result.fingerprint.kind} (${result.fingerprint.key}).`,
  )
  if (result.fingerprint.markers.length > 0) {
    lines.push(`Fingerprint markers: ${result.fingerprint.markers.join(', ')}`)
  }
  lines.push(`Surface order: ${result.surfaceOrder.join(' -> ')}`)
  lines.push('Steps:')
  for (const step of result.steps) {
    const label = step.description ? `${step.do}: ${step.description}` : step.do
    lines.push(
      `  ${step.index + 1}. [${step.ok ? 'ok' : 'fail'}] ${label} via ${step.surface} (${step.durationMs}ms)${
        step.output ? ` — ${truncate(step.output, MAX_STEP_OUTPUT_CHARS)}` : ''
      }${step.error ? ` — ERROR ${truncate(step.error, 800)}` : ''}`,
    )
  }
  if (result.fallbacks.length > 0) {
    lines.push('Fallbacks:')
    for (const fallback of result.fallbacks) {
      lines.push(
        `  - step ${fallback.stepIndex + 1}: ${fallback.from} -> ${fallback.to} (${fallback.signature}: ${truncate(fallback.reason, 300)})`,
      )
    }
  }
  if (result.error) lines.push(`Error: ${truncate(result.error, 2_000)}`)
  for (const line of extra) lines.push(line)
  return truncate(lines.join('\n'), MAX_OUTPUT_CHARS)
}

export async function runDrive(
  options: DriveRunOptions,
  probe?: DriveProbeResult,
): Promise<DriveRunResult> {
  const { root } = options
  const hints: DriveHints = { root, ...options.hints }
  const state: AdapterState = { images: [] }

  const recipe = options.recipe ? await loadRecipe(root, options.recipe) : null
  const steps = (options.steps && options.steps.length > 0 ? options.steps : recipe?.steps) ?? []
  if (steps.length === 0) {
    throw new Error('drive_run needs steps or a recipe with steps')
  }

  const detected =
    probe ??
    (await probeTarget(
      hints,
      {
        canScreenshot: Boolean(options.captureScreenshot),
        canCustom: Boolean(options.runDynamicTool),
        canTool: Boolean(options.runDynamicTool),
      },
      options.signal,
    ))

  const port = hints.port ?? detected.discoveredPort
  const vars: Record<string, string> = {
    root,
    ...(port ? { port: String(port) } : {}),
    ...(hints.url ? { url: hints.url } : {}),
    ...(hints.windowTitle ? { windowTitle: hints.windowTitle } : {}),
    ...(hints.processName ? { processName: hints.processName } : {}),
    ...(hints.command ? { command: hints.command } : {}),
  }
  const resolvedSteps = steps.map((step) => applyTemplates(step, vars))

  const surfaceOrder = dedupeSurfaces(
    options.surfaceOrder && options.surfaceOrder.length > 0
      ? options.surfaceOrder
      : (recipe?.surfaceOrder ?? detected.recommendation.fallbackOrder),
  )
  if (surfaceOrder.length === 0) surfaceOrder.push('custom')

  const context: AdapterContext = {
    root,
    hints,
    ...(port ? { port } : {}),
    signal: options.signal,
    ...(options.screenshotDir ? { screenshotDir: options.screenshotDir } : {}),
    ...(options.captureScreenshot ? { captureScreenshot: options.captureScreenshot } : {}),
    ...(options.runDynamicTool ? { runDynamicTool: options.runDynamicTool } : {}),
    state,
  }

  const results: DriveStepResult[] = []
  const fallbacks: DriveFallback[] = []
  let current = surfaceOrder[0] as DriveSurface
  let finalError: string | undefined
  let ok = true

  for (let index = 0; index < resolvedSteps.length; index += 1) {
    const step = resolvedSteps[index] as DriveStep
    const candidates = rotate(surfaceOrder, current).filter((surface) => surfaceSupports(surface, step))
    if (candidates.length === 0) {
      finalError = `No surface in [${surfaceOrder.join(', ')}] can perform step ${index + 1} (${step.do}). Supported by: ${surfaceOrder
        .map((surface) => `${surface}: ${supportedStepKinds(surface).join('/')}`)
        .join('; ')}.`
      results.push({
        index,
        do: step.do,
        ...(step.description ? { description: step.description } : {}),
        surface: current,
        ok: false,
        output: '',
        error: finalError,
        durationMs: 0,
      })
      ok = false
      break
    }

    let stepDone = false
    let lastError = ''
    let lastSignature = 'unknown'

    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
      const surface = candidates[candidateIndex] as DriveSurface
      if (options.signal.aborted) {
        lastError = 'Run cancelled'
        lastSignature = 'blocked'
        break
      }
      const startedAt = Date.now()
      try {
        const outcome = await executeStep(surface, step, context)
        const durationMs = Date.now() - startedAt
        if (outcome.ok) {
          // The switch itself was recorded just before trying this candidate;
          // recording it again here would duplicate the same fallback.
          current = surface
          if (outcome.images && outcome.images.length > 0) state.images.push(...outcome.images)
          results.push({
            index,
            do: step.do,
            ...(step.description ? { description: step.description } : {}),
            surface,
            ok: true,
            output: outcome.output,
            durationMs,
          })
          stepDone = true
          break
        }
        lastError = outcome.error ?? outcome.output
        const verdict = classifyFailure(lastError)
        lastSignature = verdict.signature
        // Assertions describe application state, not a surface problem: another
        // surface that can read the same state is still worth trying, but a
        // failing assertion is not "fixed" by retrying the same check.
        if (!options.allowFallback || !verdict.retryable) break
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        const verdict = classifyFailure(lastError)
        lastSignature = verdict.signature
        if (!options.allowFallback || !verdict.retryable) break
      }
      if (candidateIndex + 1 < candidates.length) {
        fallbacks.push({
          stepIndex: index,
          from: surface,
          to: candidates[candidateIndex + 1] as DriveSurface,
          signature: lastSignature,
          reason: lastError,
        })
      }
    }

    if (!stepDone) {
      ok = false
      finalError = `Step ${index + 1} (${step.do}) failed on ${candidates.join(' -> ')}: ${lastError}`
      results.push({
        index,
        do: step.do,
        ...(step.description ? { description: step.description } : {}),
        surface: current,
        ok: false,
        output: '',
        error: lastError,
        signature: lastSignature,
        durationMs: 0,
      })
      break
    }
  }

  let savedPath: string | null = null
  if (options.saveAs && ok) {
    const existing = await loadRecipe(root, options.saveAs).catch(() => null)
    const recipeToSave = buildRecipe({
      name: options.saveAs,
      ...(options.note ? { note: options.note } : {}),
      fingerprint: detected.fingerprint,
      surfaceOrder,
      steps,
    })
    if (existing) {
      recipeToSave.createdAt = existing.createdAt
      recipeToSave.successCount = existing.successCount + 1
      recipeToSave.failureCount = existing.failureCount
    }
    savedPath = await saveRecipe(root, recipeToSave)
  }
  if (recipe && options.saveAs !== recipe.name) {
    await recordRecipeRun(root, recipe.name, ok)
  }

  const result: DriveRunResult = {
    ok,
    fingerprint: detected.fingerprint,
    surfaceOrder,
    usedSurfaces: [...new Set(results.filter((step) => step.ok).map((step) => step.surface))],
    fallbacks,
    steps: results,
    output: '',
    ...(finalError ? { error: finalError } : {}),
    images: state.images,
    ...(savedPath ? { recipe: savedPath } : {}),
  }
  const extra: string[] = []
  if (recipe) {
    extra.push(`Recipe: ${recipe.name}${recipe.fingerprint.key === detected.fingerprint.key ? '' : ' (fingerprint differs from the current app; verify the first result)'}`)
  }
  if (savedPath) extra.push(`Saved recipe: ${savedPath}`)
  result.output = formatResult(result, extra)
  return result
}
