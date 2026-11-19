/**
 * Environment-driven model configuration for `pilot serve`.
 *
 * A headless deployment has no desktop settings page, and a container usually
 * cannot run an interactive command, so the endpoint and key must be settable
 * from the environment. Kept in its own module (no Electron, no runner imports)
 * so it can be unit tested without booting the whole server.
 */

/** The slice of `Store` this helper needs; anything with `updateSettings` fits. */
export interface ModelEnvTarget {
  updateSettings(input: {
    apiKey?: string | null
    baseUrl?: string
    model?: string
  }): Promise<unknown>
}

export interface ModelEnv {
  apiKey?: string
  baseUrl?: string
  model?: string
}

/** Read `PILOT_API_KEY` / `PILOT_BASE_URL` / `PILOT_MODEL` without applying them. */
export function readModelEnv(env: NodeJS.ProcessEnv = process.env): ModelEnv | null {
  const apiKey = (env['PILOT_API_KEY'] ?? '').trim()
  const baseUrl = (env['PILOT_BASE_URL'] ?? '').trim()
  const model = (env['PILOT_MODEL'] ?? '').trim()
  if (!apiKey && !baseUrl && !model) return null
  const value: ModelEnv = {}
  if (apiKey) value.apiKey = apiKey
  if (baseUrl) value.baseUrl = baseUrl
  if (model) value.model = model
  return value
}

/**
 * Write the environment model settings into the store.
 *
 * Returns the applied values, or null when no related variable was set. Only
 * present variables are written, so a persisted data directory keeps whatever
 * was configured earlier (CLI `apikey`, a previous environment, the console).
 */
export async function applyModelEnv(
  target: ModelEnvTarget,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ModelEnv | null> {
  const value = readModelEnv(env)
  if (!value) return null
  await target.updateSettings(value)
  return value
}
