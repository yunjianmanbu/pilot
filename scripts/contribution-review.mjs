#!/usr/bin/env node
// Inspect and apply a personal-version contribution bundle to the official tree.
// This is the maintainer-side half of the "submit a great personal evolution"
// flow. Nothing is committed or released automatically.
//
// Usage:
//   node scripts/contribution-review.mjs inspect <bundle>
//   node scripts/contribution-review.mjs apply <bundle> --yes [--allow-base-mismatch]
//   node scripts/contribution-review.mjs apply <bundle> --yes --root <client-dir>
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const defaultRoot = resolve(scriptDir, '..', 'client')

const FORMAT = 'pilot-contribution/v1'
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024
const EXCLUDED_DIRS = new Set([
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
const FORBIDDEN_SUFFIXES = ['.jks', '.keystore', '.pem', '.key', '.pfx', '.p12', '.log']
const HARD_SECRET_PATTERN = /(-----BEGIN [A-Z ]*PRIVATE KEY-----|secret:\/\/)/i
const SOFT_SECRET_PATTERN =
  /(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{12,})/i

function isFixturePath(path) {
  const lower = path.toLowerCase()
  return (
    lower.startsWith('tests/') ||
    lower.includes('/tests/') ||
    lower.includes('/__tests__/') ||
    lower.includes('/fixtures/') ||
    /\.(test|spec)\.[a-z0-9]+$/.test(lower)
  )
}

function containsSecret(text, path) {
  if (HARD_SECRET_PATTERN.test(text)) return true
  if (!SOFT_SECRET_PATTERN.test(text)) return false
  return !path || !isFixturePath(path)
}

/** Never trust a bundle's `text` flag when looking for credentials. */
function looksLikeText(buffer) {
  const sample = buffer.subarray(0, 4_096)
  return !sample.includes(0)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`
}

function safeRelative(path) {
  const normalized = String(path).replace(/\\/g, '/')
  if (
    !normalized ||
    normalized.includes('\0') ||
    isAbsolute(normalized) ||
    normalized.startsWith('/') ||
    normalized.split('/').some((part) => part === '' || part === '.' || part === '..') ||
    normalized.includes(':')
  ) {
    throw new Error(`unsafe path: ${path}`)
  }
  return normalized
}

function forbidden(relative) {
  const segments = relative.split('/')
  if (segments.some((part) => EXCLUDED_DIRS.has(part))) return true
  const lower = relative.toLowerCase()
  return (
    FORBIDDEN_SUFFIXES.some((suffix) => lower.endsWith(suffix)) ||
    lower === '.env' ||
    lower.startsWith('.env.') ||
    lower.endsWith('/.env') ||
    lower === 'keystore-password.txt'
  )
}

function targetFor(root, relative) {
  const base = resolve(root)
  const target = resolve(base, ...safeRelative(relative).split('/'))
  if (target !== base && !target.startsWith(`${base}${sep}`)) {
    throw new Error(`path escapes the client root: ${relative}`)
  }
  return target
}

/** Reject a target reached through a symlink that points outside the tree. */
function assertNoSymlinkEscape(root, target) {
  const realRoot = realpathSync(root)
  let parent = dirname(target)
  while (!existsSync(parent)) parent = dirname(parent)
  const realParent = realpathSync(parent)
  if (realParent !== realRoot && !realParent.startsWith(`${realRoot}${sep}`)) {
    throw new Error(`path resolves outside the client root: ${target}`)
  }
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
    throw new Error(`refusing to write through a symlink: ${target}`)
  }
}

function inspect(bundle, root = defaultRoot) {
  const problems = []
  const warnings = []
  if (!bundle || typeof bundle !== 'object') throw new Error('bundle is not a JSON object')
  if (bundle.format !== FORMAT) throw new Error(`unsupported bundle format: ${bundle.format}`)
  if (!bundle.id || !bundle.createdAt || !bundle.note) {
    throw new Error('bundle is missing id, createdAt or note')
  }
  if (!bundle.version?.name || !bundle.version?.baseVersion) {
    throw new Error('bundle is missing version metadata')
  }
  if (!Array.isArray(bundle.files) || bundle.files.length === 0) {
    throw new Error('bundle has no files')
  }
  const { checksum, ...payload } = bundle
  if (checksum !== sha256(stableStringify(payload))) {
    throw new Error('checksum mismatch; the bundle was modified or is incomplete')
  }

  const packageVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  if (bundle.version.baseVersion !== packageVersion) {
    warnings.push(
      `base version is ${bundle.version.baseVersion}, official tree is ${packageVersion}; rebase may be needed`,
    )
  }
  if (containsSecret(bundle.note)) problems.push('contribution note appears to contain a secret')
  if (bundle.evidence && containsSecret(JSON.stringify(bundle.evidence))) {
    problems.push('evidence appears to contain a secret')
  }

  const seen = new Set()
  for (const file of bundle.files) {
    let relative
    try {
      relative = safeRelative(file.path)
    } catch (error) {
      problems.push(error.message)
      continue
    }
    if (seen.has(relative)) problems.push(`duplicate path: ${relative}`)
    seen.add(relative)
    if (forbidden(relative)) problems.push(`forbidden path: ${relative}`)
    if (
      /(^|\/)(src\/main\/(store|sandbox|workspace|updater|shell|session-store|personal|index)\.ts|src\/main\/agent\/(permissions|runner|tools|loop|review|mcp)\.ts|src\/preload\/index\.ts|electron-builder\.yml)$/.test(
        relative,
      )
    ) {
      warnings.push(`security-sensitive file changed: ${relative}`)
    }
    if (relative === 'package.json' || relative === 'pnpm-lock.yaml') {
      warnings.push(`dependency metadata changed; review install scripts before pnpm install: ${relative}`)
    }
    if (relative.startsWith('scripts/') || relative.startsWith('build/')) {
      warnings.push(`build or packaging script changed; review before running it: ${relative}`)
    }
    if (!['added', 'modified', 'deleted'].includes(file.status)) {
      problems.push(`invalid status for ${relative}: ${file.status}`)
      continue
    }
    if (file.status === 'deleted') {
      if (file.contentBase64) problems.push(`deleted file carries content: ${relative}`)
      continue
    }
    if (typeof file.contentBase64 !== 'string') {
      problems.push(`missing content: ${relative}`)
      continue
    }
    const content = Buffer.from(file.contentBase64, 'base64')
    if (sha256(content) !== file.afterSha256) {
      problems.push(`after hash mismatch: ${relative}`)
    }
    if (looksLikeText(content) && containsSecret(content.toString('utf8'), relative)) {
      problems.push(`file appears to contain a secret: ${relative}`)
    }
    let target
    try {
      target = targetFor(root, relative)
      assertNoSymlinkEscape(root, target)
    } catch (error) {
      problems.push(error.message)
      continue
    }
    if (file.status === 'added' && existsSync(target)) {
      const current = readFileSync(target)
      if (sha256(current) !== file.afterSha256) {
        problems.push(`added file already exists with different content: ${relative}`)
      } else {
        warnings.push(`added file already matches; apply will leave it untouched: ${relative}`)
      }
    }
    if (file.status === 'modified' || file.status === 'deleted') {
      if (!existsSync(target)) {
        problems.push(`base file is missing: ${relative}`)
      } else if (sha256(readFileSync(target)) !== file.beforeSha256) {
        problems.push(`base hash mismatch (official tree changed since submission): ${relative}`)
      }
    }
  }
  return { problems, warnings, packageVersion }
}

function apply(bundle, root) {
  const { problems, warnings } = inspect(bundle, root)
  if (problems.length > 0) {
    for (const problem of problems) console.error(`✗ ${problem}`)
    throw new Error(`refusing to apply: ${problems.length} problem(s)`)
  }
  for (const warning of warnings) console.warn(`! ${warning}`)
  let written = 0
  let deleted = 0
  for (const file of bundle.files) {
    const target = targetFor(root, file.path)
    assertNoSymlinkEscape(root, target)
    if (file.status === 'deleted') {
      if (existsSync(target)) {
        unlinkSync(target)
        deleted += 1
      }
      continue
    }
    const content = Buffer.from(file.contentBase64, 'base64')
    const current = existsSync(target) ? readFileSync(target) : null
    if (current && sha256(current) === file.afterSha256) continue
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
    written += 1
  }
  return { written, deleted }
}

function main() {
  const args = process.argv.slice(2)
  const command = args[0]
  const file = args[1]
  const flags = new Set(args.filter((arg) => arg.startsWith('--')))
  const rootIndex = args.indexOf('--root')
  const root = rootIndex >= 0 && args[rootIndex + 1] ? resolve(args[rootIndex + 1]) : defaultRoot
  if (!command || !file || !['inspect', 'apply'].includes(command)) {
    console.error('用法: node scripts/contribution-review.mjs inspect <bundle>')
    console.error('      node scripts/contribution-review.mjs apply <bundle> --yes [--allow-base-mismatch]')
    process.exit(2)
  }
  const bundlePath = resolve(file)
  if (statSync(bundlePath).size > MAX_BUNDLE_BYTES) {
    console.error('✗ 贡献包过大（上限 64 MiB）。')
    process.exit(1)
  }
  const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'))
  const report = inspect(bundle, root)
  console.log(`贡献包：${bundle.id}`)
  console.log(`个人版本：${bundle.version.name}`)
  console.log(`基线版本：${bundle.version.baseVersion}`)
  console.log(`提交说明：${bundle.note}`)
  console.log(`改动文件：${bundle.files.length}`)
  for (const changed of bundle.files) console.log(`  ${changed.status.padEnd(8)} ${changed.path}`)
  for (const warning of report.warnings) console.warn(`! ${warning}`)
  for (const problem of report.problems) console.error(`✗ ${problem}`)
  if (command === 'inspect') {
    if (report.problems.length > 0) process.exit(1)
    console.log('\n✓ 检查通过')
    return
  }
  if (!flags.has('--yes')) {
    console.error('\n应用前请先审阅上面的文件列表，然后加上 --yes 重新执行。')
    process.exit(2)
  }
  if (report.problems.length > 0) {
    console.error('\n✗ 存在冲突或安全问题，拒绝应用。')
    process.exit(1)
  }
  if (
    bundle.version.baseVersion !== report.packageVersion &&
    !flags.has('--allow-base-mismatch')
  ) {
    console.error(
      `\n✗ 基线版本 ${bundle.version.baseVersion} 与当前官方版本 ${report.packageVersion} 不一致。` +
        '\n  请先变基；确认冲突已人工处理后才能加 --allow-base-mismatch。',
    )
    process.exit(1)
  }
  const result = apply(bundle, root)
  console.log(`\n✓ 已应用：写入 ${result.written} 个文件，删除 ${result.deleted} 个文件。`)
  console.log('  下一步：审阅 git diff，运行 pnpm typecheck、pnpm test、pnpm build，再决定是否进入发版。')
}

main()
