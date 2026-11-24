import { existsSync, statSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { PluginBuiltinItem } from '../../shared/types'
import { electronAppInfo } from '../electron-paths'
import { parsePluginManifest, PLUGIN_MANIFEST_FILE, type PluginManifest } from './manifest'

/**
 * Plugins that travel inside the release package.
 *
 * `builtin-tools` ships *tools* the agent adopts into its global registry;
 * this bundle is the plugin counterpart: complete plugin directories
 * (`plugin.json` + `index.mjs`) sitting next to the app, which a workspace can
 * install with one click. Nothing is copied into a workspace at launch — a
 * plugin runs as a child process with the permissions the user grants, so
 * installing has to stay an explicit act.
 *
 * A bundled plugin is treated like any other import: it is copied into
 * `<workspace>/.pilot/plugins/<id>`, signed with the workspace's local key and
 * trusted, because the user is installing bytes that came with the app.
 */
export const BUILTIN_PLUGINS_DIR = 'builtin-plugins'
/** Keep the bundle in step with MAX_PLUGINS: a workspace can hold them all. */
const MAX_BUILTIN_PLUGINS = 16

/**
 * Every place the bundle can legitimately sit, most specific first: packaged
 * Electron (`resources/builtin-plugins`), an npm server install
 * (`<package root>/builtin-plugins`) and a dev checkout
 * (`<repo>/pilot/pilot/builtin-plugins`).
 *
 * Each candidate is the bundle directory itself, the one holding one
 * subdirectory per plugin - the same convention `builtin-tools` uses for the
 * tool bundle, so `findBuiltinPluginsRoot` never has to append the name again.
 */
export function builtinPluginsRootCandidates(input: {
  packaged?: boolean
  appPath?: string
  resourcesPath?: string
  packageRoot?: string
}): string[] {
  const candidates: string[] = []
  if (input.packaged && input.resourcesPath) {
    candidates.push(join(input.resourcesPath, BUILTIN_PLUGINS_DIR))
  }
  if (input.packageRoot) candidates.push(join(input.packageRoot, BUILTIN_PLUGINS_DIR))
  if (input.appPath) {
    candidates.push(join(input.appPath, BUILTIN_PLUGINS_DIR))
    candidates.push(join(input.appPath, '..', BUILTIN_PLUGINS_DIR))
  }
  return [...new Set(candidates.map((candidate) => resolve(candidate)))]
}

/**
 * Resolve the bundle from the running shell. `electron-paths` is imported
 * lazily on purpose: unit tests and the headless server pass `roots` instead.
 */
async function detectRoots(): Promise<string[]> {
  const info = await electronAppInfo()
  const roots = builtinPluginsRootCandidates({
    packaged: info.packaged,
    ...(info.appPath ? { appPath: info.appPath } : {}),
    ...(info.resourcesPath ? { resourcesPath: info.resourcesPath } : {}),
    ...(process.env['PILOT_PACKAGE_ROOT'] ? { packageRoot: process.env['PILOT_PACKAGE_ROOT'] } : {}),
  })
  if (process.env['PILOT_DEBUG_PLUGIN_ROOTS']) console.log('[builtin-plugins] roots', roots)
  return roots
}

/** The first bundle directory that actually exists, or null. */
export async function findBuiltinPluginsRoot(roots?: string[]): Promise<string | null> {
  for (const root of roots ?? (await detectRoots())) {
    try {
      if (statSync(root).isDirectory()) return root
    } catch {
      // Missing on this install shape: try the next candidate.
    }
  }
  return null
}

/**
 * One bundled plugin resolved on disk: the directory that gets copied plus the
 * manifest that was read out of it. `error` is set when the directory exists
 * but its manifest is invalid, so the page can show the problem instead of
 * silently offering an install that would fail.
 */
export interface BuiltinPluginSource {
  id: string
  dir: string
  manifest: PluginManifest | null
  error: string | null
}

/**
 * Read every directory in the bundle. Directories are the source of truth:
 * a broken manifest is reported, not skipped, so a typo during packaging is
 * visible on the plugins page rather than as a missing card.
 */
export async function listBuiltinPluginSources(roots?: string[]): Promise<{
  root: string | null
  entries: BuiltinPluginSource[]
}> {
  const root = await findBuiltinPluginsRoot(roots)
  if (!root) return { root: null, entries: [] }
  const dir = root
  const names = (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort()
    .slice(0, MAX_BUILTIN_PLUGINS)

  const entries: BuiltinPluginSource[] = []
  for (const name of names) {
    const pluginDir = join(dir, name)
    if (!existsSync(join(pluginDir, PLUGIN_MANIFEST_FILE))) continue
    try {
      const manifest = await readManifestFile(pluginDir, name)
      if (!existsSync(join(pluginDir, manifest.entry))) {
        entries.push({
          id: name,
          dir: pluginDir,
          manifest,
          error: `清单里的入口文件不存在：${manifest.entry}`,
        })
        continue
      }
      entries.push({ id: manifest.id, dir: pluginDir, manifest, error: null })
    } catch (error) {
      entries.push({
        id: name,
        dir: pluginDir,
        manifest: null,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return { root, entries }
}

/**
 * Read one `<dir>/plugin.json`. `expectedId` pins the id to the directory name,
 * which is what stops a packaged copy from claiming another plugin's grants.
 */
async function readManifestFile(pluginDir: string, expectedId: string): Promise<PluginManifest> {
  let raw: string
  try {
    raw = await readFile(join(pluginDir, PLUGIN_MANIFEST_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`目录里没有 ${PLUGIN_MANIFEST_FILE}`)
    }
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`${PLUGIN_MANIFEST_FILE} 不是合法 JSON`)
  }
  return parsePluginManifest(parsed, expectedId)
}

/**
 * The bundled plugins as the plugins page sees them, with the tools/settings/
 * triggers a user needs before deciding to install one. `installedIds` comes
 * from the workspace overview so this stays a pure read.
 */
export async function listBuiltinPlugins(options: {
  roots?: string[]
  installedIds?: string[]
} = {}): Promise<PluginBuiltinItem[]> {
  const installed = new Set(options.installedIds ?? [])
  const { entries } = await listBuiltinPluginSources(options.roots)
  const out: PluginBuiltinItem[] = []
  for (const entry of entries) {
    const manifest = entry.manifest
    out.push({
      id: entry.id,
      name: manifest?.name ?? entry.id,
      summary: manifest?.description ?? '',
      version: manifest?.version ?? 0,
      permissions: manifest?.permissions ?? [],
      tools: manifest?.tools.map((tool) => tool.name) ?? [],
      settings: manifest?.settings.map((setting) => setting.label) ?? [],
      triggers:
        manifest?.triggers.map((trigger) => ({
          event: trigger.event,
          everyMinutes: trigger.everyMinutes,
          timeOfDay: trigger.timeOfDay,
        })) ?? [],
      installed: installed.has(entry.id),
      sourceDir: entry.dir,
      error: entry.error,
    })
  }
  return out
}

/** Resolve one bundled directory by id (the directory name and manifest id). */
export async function findBuiltinPlugin(
  id: string,
  roots?: string[],
): Promise<{ dir: string; manifest: PluginManifest } | null> {
  const wanted = String(id ?? '').trim()
  if (!wanted) return null
  const { entries } = await listBuiltinPluginSources(roots)
  const entry = entries.find((item) => item.manifest?.id === wanted) ?? entries.find((item) => item.id === wanted)
  if (!entry || !entry.manifest) return null
  return { dir: entry.dir, manifest: entry.manifest }
}
