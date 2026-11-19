#!/usr/bin/env node
/**
 * Build the manifest `pilot update` and the browser panel read.
 *
 * A server install is a directory (`npm i -g pilot-agent` puts one under the
 * npm prefix), so the release is described per file instead of as one installer:
 * every shipped file gets a size and a SHA-256, and the updater downloads only
 * the files whose hash changed. That is what makes a server upgrade incremental.
 *
 * Usage:
 *   node scripts/pack-server-release.mjs --root <安装目录> --out <输出目录> \
 *        --base https://download.medpilot.cc/pilot/server/<版本>/ [--notes 说明]
 *
 * The script writes a mirror of the install tree plus `server.json` into the
 * output directory, because the manifest resolves every file path against
 * `--base`. Upload the output directory to `--base`; the manifest goes last, so
 * it never points at a file that is not there yet.
 */
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

/** Files that are part of an install and safe to replace. */
const SKIP_DIRS = new Set(['.git', '.pilot-update', 'node_modules/.cache', 'coverage', 'test'])
const SKIP_FILES = new Set(['pilot-server.json', '.DS_Store', 'Thumbs.db', 'npm-debug.log'])
const MAX_FILE_BYTES = 64 * 1024 * 1024

function parseArgs(argv) {
  const options = { root: process.cwd(), out: 'release/server', base: '', notes: '', version: '' }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    switch (flag) {
      case '--root':
        options.root = value ?? options.root
        index += 1
        break
      case '--out':
        options.out = value ?? options.out
        index += 1
        break
      case '--base':
        options.base = value ?? ''
        index += 1
        break
      case '--notes':
        options.notes = value ?? ''
        index += 1
        break
      case '--version':
        options.version = value ?? ''
        index += 1
        break
      case '-h':
      case '--help':
        options.help = true
        break
      default:
        if (flag.startsWith('--')) throw new Error(`未知参数：${flag}`)
    }
  }
  return options
}

function shouldSkip(relativePath) {
  const segments = relativePath.split('/')
  if (segments.some((segment) => SKIP_DIRS.has(segment))) return true
  return SKIP_FILES.has(segments.at(-1) ?? '')
}

async function walk(root, current = root, found = []) {
  const entries = await readdir(current, { withFileTypes: true })
  for (const entry of entries) {
    const absolute = join(current, entry.name)
    const relativePath = relative(root, absolute).split(sep).join('/')
    if (shouldSkip(relativePath)) continue
    if (entry.isDirectory()) {
      await walk(root, absolute, found)
      continue
    }
    if (!entry.isFile()) continue
    const info = await stat(absolute)
    if (info.size > MAX_FILE_BYTES) {
      throw new Error(`文件过大，不应放进服务器更新包：${relativePath}`)
    }
    found.push({ absolute, path: relativePath, size: info.size })
  }
  return found
}

async function sha256(path) {
  const data = await readFile(path)
  return createHash('sha256').update(data).digest('hex')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(
      'node scripts/pack-server-release.mjs --root <安装目录> --base <下载地址前缀> [--out <输出目录>] [--version <版本>] [--notes <说明>]\n',
    )
    return
  }
  const root = resolve(options.root)
  const out = resolve(options.out)
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const version = String(options.version || pkg.version || '').trim()
  if (!/^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.-]{1,40})?$/.test(version)) {
    throw new Error(`版本号不合法：${version}`)
  }
  const base = new URL(String(options.base || '').trim())
  // Loopback http is allowed exactly like the updater allows it, so the same
  // script can produce a manifest for a local dry run.
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)
  if (base.protocol !== 'https:' && !(loopback && base.protocol === 'http:')) {
    throw new Error('--base 必须是 https 地址（仅 localhost 可以用 http）')
  }
  if (!base.pathname.endsWith('/')) throw new Error('--base 必须以 / 结尾')
  const baseUrl = base.toString()

  const files = await walk(root)
  if (files.length === 0) throw new Error(`${root} 下没有可发布的文件`)

  const manifest = { version, channel: 'stable', date: new Date().toISOString().slice(0, 10), notes: options.notes, base: baseUrl, files: [] }
  let totalBytes = 0
  for (const file of files.sort((left, right) => left.path.localeCompare(right.path))) {
    if (file.path === 'server.json') {
      throw new Error('安装目录根下不能有同名 server.json，会与本清单冲突')
    }
    const digest = await sha256(file.absolute)
    manifest.files.push({ path: file.path, size: file.size, sha256: digest })
    totalBytes += file.size
    const target = join(out, ...file.path.split('/'))
    await mkdir(dirname(target), { recursive: true })
    await copyFile(file.absolute, target)
  }

  await writeFile(join(out, 'server.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  process.stdout.write(
    [
      `版本        ${version}`,
      `文件数      ${manifest.files.length}`,
      `总大小      ${(totalBytes / 1024 / 1024).toFixed(2)} MB`,
      `安装目录    ${root}`,
      `输出目录    ${out}`,
      `下载前缀    ${baseUrl}`,
      '',
      `下一步：把 ${out} 上传到 ${baseUrl}（先传文件，最后传 server.json）。`,
      '',
    ].join('\n'),
  )
}

main().catch((error) => {
  process.stderr.write(`打包失败：${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
