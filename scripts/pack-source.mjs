#!/usr/bin/env node
// Package the full Pilot source tree for a release.
// Usage: node scripts/pack-source.mjs [--out <file>] [--no-verify]
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const pilotDir = resolve(scriptDir, '..')
const repoRoot = resolve(pilotDir, '..')
const version = JSON.parse(readFileSync(join(pilotDir, 'pilot', 'package.json'), 'utf8')).version

const argv = process.argv.slice(2)
const outIndex = argv.indexOf('--out')
const out = outIndex >= 0 && argv[outIndex + 1]
  ? resolve(argv[outIndex + 1])
  : join(pilotDir, 'release', `Pilot-source-${version}.tar.gz`)

if (!existsSync(join(repoRoot, 'pilot', 'pilot', 'package.json'))) {
  console.error(`✗ 找不到仓库根目录下的 pilot/pilot（当前根目录：${repoRoot}）`)
  process.exit(1)
}

mkdirSync(dirname(out), { recursive: true })

// Paths are relative to the archive root, which is `pilot`.
const excludes = [
  // pilot/site（官网）不开源，也不进源码包：它不属于四个开源子项目，
  // 且工作盘上有 7 个宣传视频（约 61 MB）只在部署机需要。
  'pilot/site',
  'pilot/pilot/node_modules',
  'pilot/pilot/out',
  'pilot/pilot/release',
  'pilot/pilot/tmp',
  'pilot/pilot/.selfdev-build',
  'pilot/pilot/release-selfdev',
  'pilot/pilot/build/self-source-package.json',
  'pilot/release',
  'pilot/pilot-link/node_modules',
  'pilot/pilot-link/unpackage',
  'pilot/pilot-link/.build',
  'pilot/mobile/node_modules',
  'pilot/mobile/unpackage',
  'pilot/pilot-connector/node_modules',
  'pilot/tmp',
  'pilot/.tmp-*',
  'pilot/.archive',
  'pilot/.tmp-promo',
  'pilot/.pilot',
  'pilot/.workbuddy',
  'pilot/claude',
  // pilot/mobile 是本机 HBuilderX 的 junction（.gitignore 里忽略），不是源码：
  // 它会把 app 再打一份，还会带上 .hbuilderx/ 本地 IDE 配置。
  'pilot/mobile',
  // 仓库根的 node_modules 只残留 .vite/.vitest-cache，属于本机测试缓存。
  'pilot/node_modules',
  // 打包日志里有本机 Windows 用户名与工作盘绝对路径（C:\\Users\\<名字>\\...），
  // 不能用『逐个 pack-0xx.log』的写法，否则新增日志就又漏一个。
  '*.log',
  '*.jks',
  '*.keystore',
  '*.mp4',
  '*.webm',
  '*.mov',
  '*.mkv',
  '*.avi',
  'keystore-password.txt',
  '.env',
  '.env.*',
]

const args = [
  '-czf',
  out,
  '-C',
  repoRoot,
  ...excludes.flatMap((pattern) => ['--exclude', pattern]),
  'pilot',
]

// Git Bash ships GNU tar, which treats "E:\..." as a remote host. Use the
// Windows bsdtar so absolute drive paths and --exclude work as expected.
// SystemRoot 而不是写死的 C: 盘——系统盘符不一定是 C。
const windowsSystemRoot = process.env.SystemRoot || process.env.windir || ''
const windowsTar = windowsSystemRoot ? join(windowsSystemRoot, 'System32', 'tar.exe') : ''
const tarBinary = process.platform === 'win32' && windowsTar && existsSync(windowsTar) ? windowsTar : 'tar'

console.log(`正在打包 ${repoRoot}/pilot → ${out}`)
try {
  execFileSync(tarBinary, args, { stdio: 'inherit' })
} catch (error) {
  console.error(`✗ 打包失败：${error instanceof Error ? error.message : String(error)}`)
  console.error('  需要系统可用的 tar 命令（Windows 10+、macOS、Linux 均自带）。')
  process.exit(1)
}

const size = statSync(out).size
const sha256 = createHash('sha256').update(readFileSync(out)).digest('hex')
console.log(`\n✓ 源码包已生成`)
console.log(`  文件：${out}`)
console.log(`  版本：${version}`)
console.log(`  大小：${size} 字节（${(size / 1024 / 1024).toFixed(1)} MiB）`)
console.log(`  sha256：${sha256}`)
