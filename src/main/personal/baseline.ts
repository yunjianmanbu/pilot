import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { exists, readJson } from './fs-utils'

/**
 * Create a read-only baseline from git HEAD for development runs. Installed
 * builds use the pristine copy under resources/source instead.
 */
export async function prepareGitBase(sourcePath: string, cacheRoot: string): Promise<string> {
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: sourcePath,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  if (revision.status !== 0 || !revision.stdout.trim()) {
    throw new Error('开发模式下需要 git 才能保存个人版本；安装版会使用安装包内置的官方源码。')
  }
  const target = join(cacheRoot, revision.stdout.trim())
  if (await exists(join(target, 'package.json'))) return target
  const archive = spawnSync('git', ['archive', '--format=tar', 'HEAD'], {
    cwd: sourcePath,
    maxBuffer: 128 * 1024 * 1024,
  })
  if (archive.status !== 0 || !archive.stdout) {
    throw new Error('无法读取当前 git 版本的源码快照。')
  }
  await mkdir(target, { recursive: true })
  // Windows 自带的 bsdtar 在 SystemRoot 下，不能写死 C: 盘（系统盘符可能不是 C）。
  const systemTar =
    process.platform === 'win32' && process.env.SystemRoot
      ? join(process.env.SystemRoot, 'System32', 'tar.exe')
      : null
  const tar = systemTar && existsSync(systemTar) ? systemTar : 'tar'
  const extracted = spawnSync(tar, ['-xf', '-', '-C', target], { input: archive.stdout })
  if (extracted.status !== 0) {
    await rm(target, { recursive: true, force: true })
    throw new Error('无法展开官方源码快照，请确认系统自带的 tar 可用。')
  }
  return target
}

export async function latestBuild(
  sourcePath: string,
  fingerprint: string,
): Promise<{ buildPath?: string; builtAt?: string }> {
  const root = join(sourcePath, 'release-selfdev')
  let entries: string[]
  try {
    entries = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('Pilot-'))
      .map((entry) => join(root, entry.name))
  } catch {
    return {}
  }
  const withTime = await Promise.all(
    entries.map(async (path) => ({ path, mtime: (await stat(path)).mtimeMs })),
  )
  withTime.sort((left, right) => right.mtime - left.mtime)
  for (const candidate of withTime) {
    const info = await readJson<{ builtAt?: string; sourceHash?: string }>(
      join(candidate.path, 'build-info.json'),
      {},
    )
    if (info.sourceHash === fingerprint) {
      return {
        buildPath: candidate.path,
        ...(info.builtAt ? { builtAt: info.builtAt } : {}),
      }
    }
  }
  return {}
}
