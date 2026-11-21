#!/usr/bin/env node
/**
 * Build the generic-tool bundle that ships inside the release package.
 *
 * A tool becomes *generic* once it is promoted to the global source
 * (`<userData>/tools/global`). Shipping those bytes alone is not enough: Pilot
 * refuses to run a tool whose SHA-256 was never approved, so the bundle also
 * carries `index.json`, and the first launch adopts each entry through the same
 * approval path (`DynamicToolRegistry.adoptBundled`).
 *
 * The hash is the runtime's own hash — sha256('manifest\0' + raw tool.json +
 * '\0entry\0' + entry bytes + '\0test\0' + test bytes, then every file in the
 * directory as '\0file\0' + relative path + '\0bytes\0' + file bytes) — so a
 * byte changed by hand between packaging and install is refused instead of
 * silently trusted.
 * Every tool's self-test runs here, at build time, and a failing test stops the
 * build: a bundle that is not verified is not produced.
 *
 * Usage:
 *   node scripts/pack-builtin-tools.mjs \
 *        [--from ../../.pilot/tools] [--out ./builtin-tools] \
 *        [--workspace <工具运行时的 cwd>] [--only name1,name2] \
 *        [--allow-unverified] [--dry-run]
 *
 *   --allow-unverified  ship a tool whose self-test cannot run in this
 *                       environment (e.g. it needs a live desktop app); the
 *                       index then records `verified: false`.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAX_TOOLS = 40
const MAX_TOOL_FILES = 60
const MAX_FILE_BYTES = 512 * 1024
const MAX_TOTAL_BYTES = 2 * 1024 * 1024
const TEST_TIMEOUT_MS = 120_000
const NAME_PATTERN = /^[a-z][a-z0-9-]{1,63}$/

const scriptDir = dirname(fileURLToPath(import.meta.url))

function argValue(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return fallback
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`--${name} 需要一个值`)
  return value
}

function flag(name) {
  return process.argv.includes(`--${name}`)
}

function fail(message) {
  throw new Error(message)
}

async function collectFiles(dir) {
  const files = []
  let total = 0
  async function walk(current, prefix) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) fail(`工具文件不能是符号链接：${relative}`)
      if (entry.isDirectory()) {
        await walk(full, relative)
        continue
      }
      if (!entry.isFile()) continue
      const info = await stat(full)
      if (info.size > MAX_FILE_BYTES) fail(`工具文件过大（上限 ${MAX_FILE_BYTES} 字节）：${relative}`)
      total += info.size
      if (total > MAX_TOTAL_BYTES) fail(`工具目录超过 ${MAX_TOTAL_BYTES} 字节：${dir}`)
      files.push(relative)
      if (files.length > MAX_TOOL_FILES) fail(`工具文件数超过 ${MAX_TOOL_FILES}：${dir}`)
    }
  }
  await walk(dir, '')
  return files
}

async function copyTree(from, to) {
  await mkdir(to, { recursive: true })
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name)
    const destination = join(to, entry.name)
    if (entry.isDirectory()) await copyTree(source, destination)
    else if (entry.isFile()) await copyFile(source, destination)
  }
}

function relativeInside(value, field) {  if (value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:/.test(value)) {
    fail(`${field} 必须是工具目录内的相对路径`)
  }
  if (value.split(/[\\/]/).includes('..')) fail(`${field} 不能跳出工具目录`)
}

/** Mirror the runtime validator so a tool that cannot load never ships. */
async function readTool(dir) {
  const folder = basename(dir)
  if (!NAME_PATTERN.test(folder)) fail(`工具名不合法（2-64 位小写字母、数字或连字符）：${folder}`)
  const raw = await readFile(join(dir, 'tool.json'), 'utf8').catch(() => null)
  if (raw === null) fail(`缺少 tool.json：${folder}`)
  if (raw.length > 64_000) fail(`tool.json 过大：${folder}`)
  let manifest
  try {
    manifest = JSON.parse(raw)
  } catch {
    fail(`tool.json 不是合法 JSON：${folder}`)
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail('tool.json 必须是对象')
  }
  if (manifest.name !== folder) fail(`name 必须与目录名一致：${folder}`)
  const description = typeof manifest.description === 'string' ? manifest.description.trim() : ''
  if (description.length < 8) fail(`description 至少 8 个字符：${folder}`)
  if (description.length > 600) fail(`description 最多 600 个字符：${folder}`)
  const runtime = manifest.runtime === 'python' ? 'python' : 'node'
  const entry = typeof manifest.entry === 'string' ? manifest.entry.trim() : ''
  const test = typeof manifest.test === 'string' ? manifest.test.trim() : ''
  if (!entry) fail(`entry 必填：${folder}`)
  if (!test) fail(`test 必填：${folder}`)
  relativeInside(entry, 'entry')
  relativeInside(test, 'test')
  for (const [field, value] of [
    ['entry', entry],
    ['test', test],
  ]) {
    const info = await stat(join(dir, value)).catch(() => null)
    if (!info?.isFile()) fail(`${field} 指向的文件不存在：${folder}/${value}`)
  }
  const entryBytes = await readFile(join(dir, entry))
  const testBytes = await readFile(join(dir, test))
  const files = await collectFiles(dir)
  const hash = createHash('sha256')
  hash.update('manifest\0')
  hash.update(raw)
  hash.update('\0entry\0')
  hash.update(entryBytes)
  hash.update('\0test\0')
  hash.update(testBytes)
  // Mirror the runtime hash exactly: every file in the directory is fed with
  // its relative path as a separator, so the bundle's index.json vouches for
  // the same bytes the runtime will hash after adoption.
  for (const relative of files) {
    hash.update('\0file\0')
    hash.update(relative)
    hash.update('\0bytes\0')
    hash.update(await readFile(join(dir, relative)))
  }
  const targets = Array.isArray(manifest.targets) ? manifest.targets : []
  return {
    folder,
    runtime,
    entry,
    test,
    version: Math.max(1, Math.round(Number(manifest.version) || 1)),
    risk: manifest.risk === 'read' ? 'read' : 'exec',
    description,
    targets,
    files,
    sha256: hash.digest('hex'),
  }
}

function pythonCommand() {
  const configured = process.env['PILOT_PYTHON']
  if (configured) return configured
  return process.platform === 'win32' ? 'python' : 'python3'
}

function runSelfTest(tool, dir, workspace) {
  const command = tool.runtime === 'python' ? pythonCommand() : process.execPath
  const env = {
    PATH: process.env['PATH'] ?? '',
    SystemRoot: process.env['SystemRoot'] ?? '',
    ComSpec: process.env['ComSpec'] ?? '',
    PATHEXT: process.env['PATHEXT'] ?? '',
    TEMP: process.env['TEMP'] ?? process.env['TMP'] ?? '',
    TMP: process.env['TMP'] ?? process.env['TEMP'] ?? '',
    HOME: process.env['HOME'] ?? process.env['USERPROFILE'] ?? '',
    USERPROFILE: process.env['USERPROFILE'] ?? '',
    APPDATA: process.env['APPDATA'] ?? '',
    LOCALAPPDATA: process.env['LOCALAPPDATA'] ?? '',
    LANG: process.env['LANG'] ?? '',
    // The same marker the registry sets for a registration run.
    PILOT_SELF_TEST: '1',
    PILOT_TOOL_NAME: tool.folder,
    PILOT_TOOL_DIR: dir,
    PILOT_WORKSPACE: workspace,
  }
  if (tool.runtime === 'python') env['PYTHONIOENCODING'] = 'utf-8'
  const result = spawnSync(command, [join(dir, tool.test)], {
    cwd: workspace,
    env,
    timeout: TEST_TIMEOUT_MS,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? `exit ${result.status}`
    fail(`自测未通过：${tool.folder}（${detail}）\n${output.slice(-2_000)}`)
  }
  return output.slice(-2_000)
}

async function main() {
  const from = resolve(process.cwd(), argValue('from', '.pilot/tools'))
  const out = resolve(process.cwd(), argValue('out', join(scriptDir, '..', 'pilot', 'builtin-tools')))
  const workspace = resolve(process.cwd(), argValue('workspace', process.cwd()))
  const only = argValue('only', '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  const allowUnverified = flag('allow-unverified')
  const dryRun = flag('dry-run')

  const entries = await readdir(from, { withFileTypes: true }).catch(() => fail(`工具目录不存在：${from}`))
  const dirs = entries
    .filter((entry) => entry.isDirectory() && NAME_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .filter((name) => only.length === 0 || only.includes(name))
    .sort()
  if (dirs.length === 0) fail(`没有可打包的工具：${from}`)
  if (dirs.length > MAX_TOOLS) fail(`内置工具最多 ${MAX_TOOLS} 个，当前 ${dirs.length}`)

  const tools = []
  const lines = []
  for (const name of dirs) {
    const dir = join(from, name)
    const tool = await readTool(dir)
    if (tool.targets.length > 0) {
      // Bundled tools may only call loopback addresses: any other host would
      // need a per-user allowlist entry the shipped tool cannot carry.
      for (const target of tool.targets) {
        let host = ''
        try {
          host = new URL(target).hostname.toLowerCase()
        } catch {
          fail(`targets 里有无效地址：${name} → ${String(target)}`)
        }
        const local =
          host === 'localhost' ||
          host.endsWith('.localhost') ||
          host === '127.0.0.1' ||
          host === '[::1]' ||
          host === '::1'
        if (!local) fail(`内置工具只能声明本机测试目标：${name} → ${host}`)
      }
    }
    let verified = false
    if (dryRun) {
      lines.push(`${name}  v${tool.version}  ${tool.sha256.slice(0, 12)}…  (dry-run，未跑自测)`)
    } else {
      try {
        runSelfTest(tool, dir, workspace)
        verified = true
      } catch (error) {
        if (!allowUnverified) throw error
        lines.push(`${name}  v${tool.version}  ${tool.sha256.slice(0, 12)}…  自测失败但 --allow-unverified`)
      }
      if (verified) {
        lines.push(`${name}  v${tool.version}  ${tool.sha256.slice(0, 12)}…  自测通过  ${tool.files.length} 文件`)
      }    }
    tools.push({
      name: tool.folder,
      version: tool.version,
      sha256: tool.sha256,
      runtime: tool.runtime,
      risk: tool.risk,
      entry: tool.entry,
      test: tool.test,
      description: tool.description,
      verified,
    })
    if (dryRun) continue
    // Stage on the same volume as the output: Windows refuses to rename across
    // drives (EXDEV), and the system temp dir is usually on another one.
    await mkdir(out, { recursive: true })
    const staging = await mkdtemp(join(out, '.staging-'))
    try {
      for (const relative of tool.files) {
        const destination = join(staging, relative)
        await mkdir(dirname(destination), { recursive: true })
        await copyFile(join(dir, relative), destination)
      }
      // Replace the on-disk bundle atomically: a half-written tool must never
      // sit next to a matching hash.
      const target = join(out, name)
      const previous = join(out, `.previous-${name}`)
      await rm(previous, { recursive: true, force: true }).catch(() => {})
      await rename(target, previous).catch(() => {})
      try {
        await rename(staging, target)
      } catch {
        await copyTree(staging, target)
        await rm(staging, { recursive: true, force: true }).catch(() => {})
      }
      await rm(previous, { recursive: true, force: true }).catch(() => {})
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => {})
      throw error
    }
  }

  if (!dryRun) {
    const index = {
      version: 1,
      generatedAt: new Date().toISOString(),
      generator: 'scripts/pack-builtin-tools.mjs',
      tools,
    }
    await writeFile(join(out, 'index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8')
    // Drop tools that are no longer part of the bundle, so an upgrade cannot
    // leave an orphaned directory behind with a stale approval.
    const keep = new Set(tools.map((tool) => tool.name))
    for (const entry of await readdir(out, { withFileTypes: true })) {
      if (entry.isDirectory() && !keep.has(entry.name)) {
        await rm(join(out, entry.name), { recursive: true, force: true })
      }
    }
  }

  process.stdout.write(
    [
      '',
      `内置工具包  ${out}`,
      `来源        ${from}`,
      `工具数      ${tools.length}`,
      '',
      ...lines,
      '',
      dryRun ? 'dry-run：未写入任何文件。' : '下一步：electron-builder 会把它复制到 resources/builtin-tools。',
      '',
    ].join('\n') + '\n',
  )
}

main().catch((error) => {
  process.stderr.write(`打包失败：${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
