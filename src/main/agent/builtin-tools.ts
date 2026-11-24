import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { electronAppInfo } from '../electron-paths'
import type { AdoptBundledResult, DynamicToolRegistry } from './toolsmith'

/**
 * Vendor-shipped tools that travel inside the release package.
 *
 * A tool is a *generic capability* once it has been promoted to the global
 * source (`<userData>/tools/global`). Shipping that directory alone is not
 * enough: an approval is bound to a SHA-256 in `tool-registry.json`, so a copy
 * that arrives without a recorded hash is listed but refused at run time. The
 * bundle therefore carries `index.json`, written by
 * `scripts/pack-builtin-tools.mjs` *after* it ran every tool's own self-test,
 * and the first launch adopts each entry through
 * {@link DynamicToolRegistry.adoptBundled} — which re-hashes the copied bytes
 * and refuses anything the index does not vouch for.
 */
export const BUILTIN_TOOLS_DIR = 'builtin-tools'
export const BUILTIN_INDEX_FILE = 'index.json'
/** Keep the bundle small; global tools are capped at the same order of size. */
const MAX_BUNDLED_TOOLS = 40

export interface BuiltinToolIndexEntry {
  name: string
  version: number
  /** SHA-256 of tool.json + entry + test, computed by the pack script. */
  sha256: string
}

export interface BuiltinToolsIndex {
  version: number
  tools: BuiltinToolIndexEntry[]
}

export interface BuiltinSeedSummary {
  root: string
  installed: string[]
  updated: string[]
  kept: AdoptBundledResult[]
  skipped: AdoptBundledResult[]
}

/**
 * Every place a bundle can legitimately sit, most specific first:
 * packaged Electron (`resources/builtin-tools`), an npm server install
 * (`<package root>/builtin-tools`) and a dev checkout (`pilot/builtin-tools`).
 */
export function builtinToolsRootCandidates(input: {
  packaged?: boolean
  appPath?: string
  resourcesPath?: string
  packageRoot?: string
}): string[] {
  const candidates: string[] = []
  if (input.packaged && input.resourcesPath) {
    candidates.push(join(input.resourcesPath, BUILTIN_TOOLS_DIR))
  }
  if (input.packageRoot) candidates.push(join(input.packageRoot, BUILTIN_TOOLS_DIR))
  if (input.appPath) {
    candidates.push(join(input.appPath, BUILTIN_TOOLS_DIR))
    candidates.push(join(input.appPath, '..', BUILTIN_TOOLS_DIR))
  }
  return [...new Set(candidates.map((candidate) => resolve(candidate)))]
}

/**
 * Resolve the bundle location from the running shell. `electron-paths` is
 * imported lazily on purpose: unit tests and the headless server never need it.
 */
async function detectRoots(): Promise<string[]> {
  const info = await electronAppInfo()
  return builtinToolsRootCandidates({
    packaged: info.packaged,
    ...(info.appPath ? { appPath: info.appPath } : {}),
    ...(info.resourcesPath ? { resourcesPath: info.resourcesPath } : {}),
    ...(process.env['PILOT_PACKAGE_ROOT'] ? { packageRoot: process.env['PILOT_PACKAGE_ROOT'] } : {}),
  })
}

/** Read and validate `<root>/index.json`; null when the bundle is absent. */
export async function readBuiltinIndex(root: string): Promise<BuiltinToolsIndex | null> {
  const raw = await readFile(join(root, BUILTIN_INDEX_FILE), 'utf8').catch(() => null)
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  const list = Array.isArray(record['tools']) ? record['tools'] : []
  const tools: BuiltinToolIndexEntry[] = []
  for (const item of list.slice(0, MAX_BUNDLED_TOOLS)) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    const name = typeof entry['name'] === 'string' ? entry['name'] : ''
    const sha256 = typeof entry['sha256'] === 'string' ? entry['sha256'].trim().toLowerCase() : ''
    const version = Math.round(Number(entry['version']))
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(name)) continue
    if (!/^[0-9a-f]{64}$/.test(sha256)) continue
    tools.push({ name, version: Number.isFinite(version) && version > 0 ? version : 1, sha256 })
  }
  return {
    version: Number.isFinite(Math.round(Number(record['version'])))
      ? Math.max(1, Math.round(Number(record['version'])))
      : 1,
    tools,
  }
}

/**
 * Adopt every tool in the first bundle found. Idempotent: a launch that finds
 * an unchanged bundle writes nothing, and a tool the user edited is left alone.
 */
export async function ensureBuiltinTools(
  registry: DynamicToolRegistry,
  options: { roots?: string[] } = {},
): Promise<BuiltinSeedSummary | null> {
  const roots = options.roots ?? (await detectRoots())
  for (const root of roots) {
    const index = await readBuiltinIndex(root)
    if (!index || index.tools.length === 0) continue
    const summary: BuiltinSeedSummary = { root, installed: [], updated: [], kept: [], skipped: [] }
    for (const entry of index.tools) {
      let result: AdoptBundledResult
      try {
        result = await registry.adoptBundled({
          dir: join(root, entry.name),
          sha256: entry.sha256,
        })
      } catch (error) {
        result = {
          name: entry.name,
          status: 'skipped',
          reason: error instanceof Error ? error.message : String(error),
        }
      }
      if (result.status === 'installed') summary.installed.push(result.name)
      else if (result.status === 'updated') summary.updated.push(result.name)
      else if (result.status === 'kept') summary.kept.push(result)
      else summary.skipped.push(result)
    }
    return summary
  }
  return null
}
