import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import {
  commitsBehind,
  decideClosure,
  effectiveSettings,
  extractGitTree,
  gitRevision,
  normalizeCustomPath,
  normalizeGitPath,
  normalizeGitRef,
  normalizeGitUrl,
  normalizeSelfSourceSettings,
  readSelfSourceRecord,
  resetGitProbe,
  resolveSelfSource,
  resolveBaseRef,
  refsContainingPath,
  runGit,
  sanitizeGitOutput,
  syncSelfSource,
  treeHasPath,
  type SelfSourceContext,
  type SelfSourceSettings,
} from '../src/main/self-source-git'

const temporary: string[] = []

afterEach(async () => {
  resetGitProbe()
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

afterAll(async () => {
  await Promise.all(temporary.map((path) => rm(path, { recursive: true, force: true })))
})

async function tempDir(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  temporary.push(path)
  return path
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    .trim()
}

/**
 * A throwaway "official" repository whose root holds the client, exactly the
 * shape `pilot/pilot` has inside this workspace.
 */
async function officialRepo(): Promise<{ repo: string; client: string }> {
  const repo = await tempDir('pilot-official-')
  await mkdir(join(repo, 'pilot', 'pilot', 'src'), { recursive: true })
  await writeFile(join(repo, 'pilot', 'pilot', 'package.json'), '{"version":"0.1.0"}\n')
  await writeFile(join(repo, 'pilot', 'pilot', 'src', 'main.ts'), 'export const v = 1\n')
  git(repo, 'init', '--quiet', '--initial-branch=main')
  git(repo, 'config', 'user.email', 'test@example.test')
  git(repo, 'config', 'user.name', 'Pilot Test')
  git(repo, 'add', '.')
  git(repo, 'commit', '--quiet', '-m', 'official: initial')
  return { repo, client: join(repo, 'pilot', 'pilot') }
}

function settings(overrides: Partial<SelfSourceSettings> = {}): SelfSourceSettings {
  return {
    mode: 'builtin',
    gitUrl: '',
    gitRef: 'main',
    gitPath: '',
    customPath: '',
    ...overrides,
  }
}

function context(
  userDataPath: string,
  repo: string,
  overrides: Partial<SelfSourceSettings> = {},
): SelfSourceContext {
  return {
    packaged: false,
    appPath: repo,
    resourcesPath: userDataPath,
    userDataPath,
    settings: settings({
      mode: 'custom',
      customPath: repo,
      gitPath: 'pilot/pilot',
      ...overrides,
    }),
  }
}

describe('source settings normalization', () => {
  it('accepts only real git remotes', () => {
    expect(normalizeGitUrl('https://example.test/pilot.git')).toBe('https://example.test/pilot.git')
    expect(normalizeGitUrl('git@example.test:pilot.git')).toBe('git@example.test:pilot.git')
    expect(normalizeGitUrl('ssh://git@example.test/pilot.git')).toBe('ssh://git@example.test/pilot.git')
    expect(normalizeGitUrl('  https://example.test/pilot.git  ')).toBe(
      'https://example.test/pilot.git',
    )
    // Anything that would make git ask for something other than a URL.
    expect(normalizeGitUrl('')).toBe('')
    expect(normalizeGitUrl('example.test/pilot')).toBe('')
    expect(normalizeGitUrl('ext::sh -c touch% /tmp/pwned')).toBe('')
    expect(normalizeGitUrl('-oProxyCommand=calc.exe')).toBe('')
    expect(normalizeGitUrl(42)).toBe('')
  })

  it('falls back to main for refs git would reject', () => {
    expect(normalizeGitRef('release/2.0')).toBe('release/2.0')
    expect(normalizeGitRef('refs/heads/main')).toBe('main')
    expect(normalizeGitRef('origin/main')).toBe('main')
    expect(normalizeGitRef('')).toBe('main')
    expect(normalizeGitRef('--upload-pack=calc')).toBe('main')
    expect(normalizeGitRef('a b')).toBe('main')
    expect(normalizeGitRef('x..y')).toBe('main')
    expect(normalizeGitRef('topic.lock')).toBe('topic.lock')
  })

  it('keeps repository paths relative and refuses escapes', () => {
    expect(normalizeGitPath('pilot/pilot')).toBe('pilot/pilot')
    expect(normalizeGitPath('/pilot/pilot/')).toBe('pilot/pilot')
    expect(normalizeGitPath('pilot\\pilot')).toBe('pilot/pilot')
    expect(normalizeGitPath('')).toBe('')
    expect(normalizeGitPath('../outside')).toBe('')
    expect(normalizeGitPath('pilot/../..')).toBe('')
    expect(normalizeGitPath('.')).toBe('')
  })

  it('normalizes a whole settings object', () => {
    expect(normalizeSelfSourceSettings(null)).toEqual({
      mode: 'builtin',
      gitUrl: '',
      gitRef: 'main',
      gitPath: '',
      customPath: '',
    })
    const parsed = normalizeSelfSourceSettings({
      mode: 'custom',
      gitUrl: 'https://example.test/pilot.git',
      gitRef: 'dev',
      gitPath: 'pilot/pilot',
      customPath: normalizeCustomPath('  D:\\code\\pilot  '),
    })
    expect(parsed).toEqual({
      mode: 'custom',
      gitUrl: 'https://example.test/pilot.git',
      gitRef: 'dev',
      gitPath: 'pilot/pilot',
      customPath: 'D:\\code\\pilot',
    })
    expect(normalizeSelfSourceSettings({ mode: 'other' }).mode).toBe('builtin')
    expect(normalizeCustomPath('')).toBe('')
    expect(normalizeCustomPath('a\u0000b')).toBe('')
  })

  it('prefers explicit settings over build-time defaults', () => {
    const defaults = {
      gitUrl: 'https://example.test/pilot.git',
      gitRef: 'main',
      gitPath: 'pilot/pilot',
    }
    expect(effectiveSettings(settings(), defaults)).toEqual({
      mode: 'builtin',
      gitUrl: 'https://example.test/pilot.git',
      gitRef: 'main',
      gitPath: 'pilot/pilot',
      customPath: '',
    })
    const explicit = settings({ gitUrl: 'https://other.test/pilot.git', gitPath: '', gitRef: 'dev' })
    expect(effectiveSettings(explicit, defaults)).toMatchObject({
      gitUrl: 'https://other.test/pilot.git',
      gitRef: 'dev',
      // An empty path cannot be distinguished from "unset", so it inherits.
      gitPath: 'pilot/pilot',
    })
  })

  it('never adopts a build-time remote in an installed build', () => {
    const defaults = {
      gitUrl: 'https://example.test/pilot.git',
      gitRef: 'dev',
      gitPath: 'pilot/pilot',
    }
    // Installed builds pass adoptDefaults=false: the official remote is empty
    // until the user types one, so nothing is fetched on their behalf.
    expect(effectiveSettings(settings(), defaults, false)).toEqual({
      mode: 'builtin',
      gitUrl: '',
      gitRef: 'main',
      gitPath: '',
      customPath: '',
    })
    // A typed address still wins in either mode.
    expect(
      effectiveSettings(settings({ gitUrl: 'https://mine.test/pilot.git' }), defaults, false),
    ).toMatchObject({ gitUrl: 'https://mine.test/pilot.git', gitPath: '' })
  })

  it('never leaks credentials from git output', () => {
    expect(sanitizeGitOutput('fatal: https://user:token@example.test/x.git not found')).toBe(
      'fatal: https://***@example.test/x.git not found',
    )
    expect(sanitizeGitOutput('\u001b[31mfatal:\u001b[0m bad\n\nref')).toBe('fatal: bad ref')
  })
})

describe('closure verdict', () => {
  it('is closed only for a current official commit', () => {
    expect(
      decideClosure({
        gitAvailable: true,
        baseKind: 'official-git',
        revision: 'a'.repeat(40),
        behind: 0,
      }),
    ).toMatchObject({ closed: true })

    // A custom checkout is closed once its own commit is pinned, even when it
    // trails the remote: that commit is what the user builds and tests.
    const custom = decideClosure({
      gitAvailable: true,
      baseKind: 'custom-git',
      revision: 'b'.repeat(40),
      behind: 4,
    })
    expect(custom.closed).toBe(true)
    expect(custom.reason).toContain('4')
  })

  it('reports why the loop is open', () => {
    expect(
      decideClosure({ gitAvailable: false, baseKind: 'official-git', revision: 'a'.repeat(40), behind: 0 })
        .reason,
    ).toContain('git')
    expect(
      decideClosure({
        gitAvailable: true,
        baseKind: 'installer-copy',
        revision: '',
        behind: null,
      }).reason,
    ).toContain('安装包')
    expect(
      decideClosure({ gitAvailable: true, baseKind: 'official-git', revision: '', behind: null }).closed,
    ).toBe(false)
    expect(
      decideClosure({ gitAvailable: true, baseKind: 'official-git', revision: 'a'.repeat(40), behind: null })
        .reason,
    ).toContain('比对')
    const stale = decideClosure({
      gitAvailable: true,
      baseKind: 'official-git',
      revision: 'c'.repeat(40),
      behind: 3,
    })
    expect(stale.closed).toBe(false)
    expect(stale.reason).toContain('3')
    expect(
      decideClosure({
        gitAvailable: true,
        baseKind: 'official-git',
        revision: 'a'.repeat(40),
        behind: 0,
        error: '拉取失败',
      }),
    ).toEqual({ closed: false, reason: '拉取失败' })
  })
})

// Real git invocations, so these need room under a loaded full-suite run.
const GIT_TIMEOUT = 30_000

describe('git baselines', { timeout: GIT_TIMEOUT }, () => {
  it('extracts one commit of a subdirectory as the official tree', async () => {
    const { repo } = await officialRepo()
    const revision = gitRevision(repo, 'HEAD')
    expect(revision).toMatch(/^[a-f0-9]{40}$/)
    const target = join(repo, '..', `base-${Date.now()}`)
    temporary.push(target)
    const ok = await extractGitTree({ repo, revision, gitPath: 'pilot/pilot', target })
    expect(ok).toEqual({ ok: true })
    // The subdirectory became the root, so the client's own files are top level.
    expect(existsSync(join(target, 'package.json'))).toBe(true)
    expect(await readFile(join(target, 'src', 'main.ts'), 'utf8')).toBe('export const v = 1' + (process.platform === 'win32' ? '\r\n' : '\n'))
    expect(existsSync(join(target, 'pilot'))).toBe(false)
    // A second call is a no-op, not a re-extraction.
    expect(await extractGitTree({ repo, revision, gitPath: 'pilot/pilot', target })).toEqual({
      ok: true,
    })
  })

  it('fails instead of pretending when the subdirectory does not exist', async () => {
    const { repo } = await officialRepo()
    const target = join(repo, '..', `missing-${Date.now()}`)
    temporary.push(target)
    const ok = await extractGitTree({
      repo,
      revision: gitRevision(repo, 'HEAD'),
      gitPath: 'nope/nothing',
      target,
    })
    expect(ok.ok).toBe(false)
    expect(ok.error).toBeTruthy()
    expect(existsSync(target)).toBe(false)
  })

  it('skips a stale official branch that never had the client directory', async () => {
    const { repo } = await officialRepo()
    // Simulate origin/main pointing at a commit from before the client existed.
    git(repo, 'checkout', '--quiet', '--orphan', 'legacy')
    git(repo, 'rm', '-r', '-f', '--quiet', 'pilot')
    await writeFile(join(repo, 'README.md'), '# legacy\n')
    git(repo, 'add', 'README.md')
    git(repo, 'commit', '--quiet', '-m', 'legacy: no client dir')
    git(repo, 'branch', '-f', 'origin/main', 'legacy')
    // Without path awareness the stale remote branch wins and yields no baseline.
    expect(resolveBaseRef(repo, 'main')).toBe('origin/main')
    // With it, the branch that actually contains pilot/pilot is used.
    expect(resolveBaseRef(repo, 'main', 'pilot/pilot')).toBe('main')
    expect(treeHasPath(repo, gitRevision(repo, 'origin/main'), 'pilot/pilot')).toBe(false)
    expect(treeHasPath(repo, gitRevision(repo, 'main'), 'pilot/pilot')).toBe(true)
  })

  it('names the remote branches that do contain the client directory', async () => {
    const { repo } = await officialRepo()
    const withClient = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'checkout', '--quiet', '--orphan', 'legacy')
    git(repo, 'rm', '-r', '-f', '--quiet', 'pilot')
    await writeFile(join(repo, 'README.md'), '# legacy\n')
    git(repo, 'add', 'README.md')
    git(repo, 'commit', '--quiet', '-m', 'legacy: no client dir')
    const withoutClient = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'update-ref', 'refs/remotes/origin/main', withoutClient)
    git(repo, 'update-ref', 'refs/remotes/origin/dev', withClient)
    // Only the remote branch whose tree has pilot/pilot is worth naming.
    expect(refsContainingPath(repo, 'pilot/pilot')).toEqual(['dev'])
    expect(refsContainingPath(repo, 'nope/nothing')).toEqual([])
    expect(refsContainingPath(repo, '')).toEqual([])
  })

  it('resolves the official ref and counts commits behind', async () => {    const { repo, client } = await officialRepo()
    // No remote in the fixture, so the local branch is the best available ref.
    expect(resolveBaseRef(repo, 'main')).toBe('main')
    expect(resolveBaseRef(repo, 'main', 'pilot/pilot')).toBe('main')
    expect(resolveBaseRef(repo, 'main', 'nope/nothing')).toBe('')
    const first = gitRevision(repo, 'HEAD')
    await writeFile(join(client, 'src', 'main.ts'), 'export const v = 2\n')
    git(repo, 'commit', '--quiet', '-am', 'official: second')
    const second = gitRevision(repo, 'HEAD')
    expect(commitsBehind(repo, first, second)).toBe(1)
    expect(commitsBehind(repo, second, second)).toBe(0)
    // Unrelated histories cannot be compared and must not claim "current".
    expect(commitsBehind(repo, second, first)).toBeNull()
    expect(commitsBehind(repo, '', second)).toBeNull()
  })

  it('reports git availability through the cached probe', async () => {
    resetGitProbe()
    const result = runGit(['--version'])
    expect(result.ok).toBe(true)
    expect(result.stdout).toMatch(/git version/i)
  })
})

describe('resolveSelfSource', { timeout: GIT_TIMEOUT }, () => {
  it('closes the loop over a custom checkout', async () => {
    const { repo } = await officialRepo()
    const userData = await tempDir('pilot-userdata-')
    const resolved = await resolveSelfSource(context(userData, repo, { mode: 'custom' }))
    expect(resolved.provenance.mode).toBe('custom')
    expect(resolved.provenance.baseKind).toBe('custom-git')
    expect(resolved.provenance.closed).toBe(true)
    expect(resolved.provenance.revision).toMatch(/^[a-f0-9]{40}$/)
    // The editable copy is the client directory, not the repository root.
    expect(resolved.sourcePath).toBe(join(repo, 'pilot', 'pilot'))
    expect(existsSync(join(resolved.basePath, 'package.json'))).toBe(true)
    expect(resolved.provenance.reason).toContain('闭环')
  })

  it('refuses a custom path that is not a git repository', async () => {
    const plain = await tempDir('pilot-plain-')
    await writeFile(join(plain, 'package.json'), '{}\n')
    const userData = await tempDir('pilot-userdata-')
    const resolved = await resolveSelfSource(context(userData, plain, { mode: 'custom' }))
    expect(resolved.provenance.closed).toBe(false)
    expect(resolved.provenance.error).toContain('git 仓库')
    expect(resolved.basePath).toBe('')
  })

  it('reports a missing custom directory instead of falling back silently', async () => {
    const userData = await tempDir('pilot-userdata-')
    const resolved = await resolveSelfSource(
      context(userData, join(userData, 'absent'), { mode: 'custom' }),
    )
    expect(resolved.provenance.closed).toBe(false)
    expect(resolved.provenance.error).toContain('不存在')
  })

  it('uses the installer snapshot when no official remote is configured', async () => {
    const userData = await tempDir('pilot-userdata-')
    const resources = join(userData, 'resources')
    await mkdir(join(resources, 'source'), { recursive: true })
    await writeFile(join(resources, 'source', 'package.json'), '{}\n')
    const resolved = await resolveSelfSource({
      packaged: true,
      appPath: join(userData, 'app'),
      resourcesPath: resources,
      userDataPath: userData,
      settings: settings(),
    })
    expect(resolved.provenance.baseKind).toBe('installer-copy')
    expect(resolved.provenance.closed).toBe(false)
    expect(resolved.provenance.reason).toContain('安装包')
  })
})

describe('syncSelfSource', { timeout: GIT_TIMEOUT }, () => {
  it('fetches the official remote and records a traceable baseline', async () => {
    const { repo } = await officialRepo()
    const userData = await tempDir('pilot-userdata-')
    // The fixture repository is addressed as a file:// URL, which is a real
    // remote for git and the only form the URL validator accepts.
    const synced = await syncSelfSource({
      packaged: true,
      appPath: join(userData, 'app'),
      resourcesPath: userData,
      userDataPath: userData,
      settings: settings({ gitUrl: pathToFileURL(repo).href, gitPath: 'pilot/pilot' }),
    })
    expect(synced.error).toBeUndefined()
    expect(synced.closed).toBe(true)
    expect(synced.baseKind).toBe('official-git')
    expect(synced.revision).toMatch(/^[a-f0-9]{40}$/)
    expect(synced.behind).toBe(0)
    expect(existsSync(join(synced.basePath, 'package.json'))).toBe(true)

    const record = await readSelfSourceRecord(userData)
    expect(record?.revision).toBe(synced.revision)
    expect(record?.gitPath).toBe('pilot/pilot')
  })

  it('marks the loop open when the official remote is unreachable', async () => {
    const userData = await tempDir('pilot-userdata-')
    const synced = await syncSelfSource({
      packaged: true,
      appPath: join(userData, 'app'),
      resourcesPath: userData,
      userDataPath: userData,
      settings: settings({ gitUrl: join(userData, 'no-such-repo'), gitPath: 'pilot/pilot' }),
    })
    expect(synced.closed).toBe(false)
    expect(synced.error).toBeTruthy()
  })

  it('asks for a URL before syncing the built-in source', async () => {
    const userData = await tempDir('pilot-userdata-')
    const synced = await syncSelfSource({
      packaged: true,
      appPath: join(userData, 'app'),
      resourcesPath: userData,
      userDataPath: userData,
      settings: settings(),
    })
    expect(synced.closed).toBe(false)
    expect(synced.reason).toContain('git 地址')
  })
})
