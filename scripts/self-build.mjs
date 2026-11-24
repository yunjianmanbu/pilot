#!/usr/bin/env node
// Build a runnable experimental copy of Pilot from this source tree.
// The installed app and the stable update manifest are never touched.
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const clientDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// Keep the raw packaging output and every experimental build inside the
// workspace, so file tools can inspect them and no path escapes the jail.
const buildRoot = join(clientDir, '.selfdev-build')
const versionsRoot = join(clientDir, 'release-selfdev')
const flags = new Set(process.argv.slice(2))

function run(label, command, args) {
  console.log(`\n▶ ${label}`)
  const result = spawnSync(command, args, {
    cwd: clientDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.error) {
    console.error(`\n✗ ${label} 无法执行：${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) {
    console.error(`\n✗ ${label} 失败（退出码 ${result.status ?? 'unknown'}）`)
    process.exit(result.status ?? 1)
  }
}

function timestamp() {
  const date = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return [
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`,
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`,
  ].join('-')
}

function executableIn(directory) {
  if (process.platform === 'win32') return join(directory, 'Pilot.exe')
  if (process.platform === 'darwin') return join(directory, 'Pilot.app', 'Contents', 'MacOS', 'Pilot')
  return join(directory, 'Pilot')
}

function gitRevision() {
  const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: clientDir,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  return result.status === 0 ? result.stdout.trim() : null
}

const fingerprintExcludedDirs = new Set([
  '.git',
  '.pilot',
  '.pilot-upgrade',
  '.selfdev-build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'release',
  'release-selfdev',
])
const fingerprintExcludedFiles = new Set([
  '.DS_Store',
  'build/self-source-package.json',
  'keystore-password.txt',
])
const fingerprintForbiddenSuffixes = ['.jks', '.keystore', '.pem', '.key', '.pfx', '.p12', '.log']

function fingerprintExcluded(path) {
  if (fingerprintExcludedFiles.has(path)) return true
  const lower = path.toLowerCase()
  if (fingerprintForbiddenSuffixes.some((suffix) => lower.endsWith(suffix))) return true
  return lower === '.env' || lower.startsWith('.env.') || lower.endsWith('/.env')
}

async function sourceFingerprint(root, relative = '', output = []) {
  const directory = relative ? join(root, ...relative.split('/')) : root
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    const path = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (fingerprintExcludedDirs.has(entry.name)) continue
      await sourceFingerprint(root, path, output)
      continue
    }
    if (!entry.isFile() || fingerprintExcluded(path)) continue
    output.push({ path, absolute: join(root, ...path.split('/')) })
  }
  output.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  const hash = createHash('sha256')
  for (const entry of output) {
    hash.update(entry.path)
    hash.update('\0')
    hash.update(createHash('sha256').update(await readFile(entry.absolute)).digest('hex'))
    hash.update('\n')
  }
  return hash.digest('hex')
}

const pkg = JSON.parse(await readFile(join(clientDir, 'package.json'), 'utf8'))

if (!flags.has('--skip-install')) {
  run('安装依赖', 'pnpm', ['install', '--frozen-lockfile'])
}
run('测试', 'pnpm', ['test'])
run('构建', 'pnpm', ['build:all'])
run('准备内置源码', 'node', ['scripts/prepare-self-source.mjs'])
run('打包便携版', 'pnpm', [
  'exec',
  'electron-builder',
  '--dir',
  // Relative to clientDir, so no argument ever contains spaces.
  '--config.directories.output=.selfdev-build',
])

// Windows/Linux emit `win-unpacked` / `linux-unpacked`; macOS emits
// `mac-arm64` directly, so detect by the executable instead of the name.
const candidates = []
for (const entry of await readdir(buildRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const path = join(buildRoot, entry.name)
  try {
    await stat(executableIn(path))
  } catch {
    continue
  }
  const info = await stat(path)
  candidates.push({ path, mtime: info.mtimeMs })
}
candidates.sort((left, right) => right.mtime - left.mtime)
if (!candidates[0]) {
  console.error(`\n✗ 找不到 electron-builder 生成的实验版目录（${buildRoot}）`)
  process.exit(1)
}

const target = join(versionsRoot, `Pilot-${pkg.version}-${timestamp()}`)
await mkdir(dirname(target), { recursive: true })
await cp(candidates[0].path, target, { recursive: true, force: true })

const info = {
  version: pkg.version,
  builtAt: new Date().toISOString(),
  source: clientDir,
  sourceHash: await sourceFingerprint(clientDir),
  unpackedFrom: candidates[0].path,
  git: gitRevision(),
}
await writeFile(join(target, 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`)

const executable = executableIn(target)
console.log(`\n✓ 实验版已生成：${target}`)
console.log(`  入口：${executable}`)
console.log('  实验版独立运行，不会替换当前安装版；回退只需启动上一个 selfdev 目录。')

if (flags.has('--run')) {
  const child = spawn(executable, [], {
    cwd: target,
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  console.log('  已启动实验版。')
}
