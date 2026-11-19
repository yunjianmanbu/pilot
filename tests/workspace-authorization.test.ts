import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

let userDataDir = ''

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataDir,
    getLocale: () => 'zh-CN',
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error('not available in tests')
    },
    decryptString: () => {
      throw new Error('not available in tests')
    },
  },
}))

import { CompanionServer } from '../src/main/companion/server'
import { Store } from '../src/main/store'

const cleanups: string[] = []

afterEach(async () => {
  while (cleanups.length) {
    const dir = cleanups.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

async function setup(): Promise<{
  store: Store
  server: CompanionServer
  root: string
  base: string
}> {
  const base = await mkdtemp(join(tmpdir(), 'pilot-phone-roots-'))
  cleanups.push(base)
  userDataDir = join(base, 'user-data')
  const root = join(base, 'projects')
  await mkdir(root, { recursive: true })
  const store = new Store()
  await store.load()
  const server = new CompanionServer({
    store,
    runner: {} as never,
    dataDir: join(base, 'companion'),
    assetsDir: base,
    deviceName: 'Test Desktop',
    appVersion: '0.1.0-test',
    billing: { report: () => Promise.reject(new Error('billing is not stubbed in this test')) },
    onStatus: () => undefined,
  })
  return { store, server, root, base }
}

/** 走真实的方法分发，验证 workspaces.create 已接入协议。 */
function createWorkspace(
  server: CompanionServer,
  params: Record<string, unknown>,
): Promise<unknown> {
  return request(server, 'workspaces.create', params)
}

function request(
  server: CompanionServer,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  return (
    server as unknown as {
      handleRequest(
        name: string,
        input: Record<string, unknown>,
        phone: unknown,
      ): Promise<unknown>
    }
  ).handleRequest(method, params, {})
}

describe('Phone workspace authorization', () => {
  it('normalizes, dedupes and collapses authorized roots', async () => {
    const { store, root } = await setup()
    const nested = join(root, 'nested')
    await mkdir(nested)

    expect(await store.addPhoneRoot(root)).toEqual([await realpath(root)])
    // Same directory again, and a directory already covered by the root.
    expect(await store.addPhoneRoot(root)).toEqual([await realpath(root)])
    expect(await store.addPhoneRoot(nested)).toEqual([await realpath(root)])

    // Broadening an existing authorization replaces the narrower one.
    const broader = join(root, '..')
    const roots = await store.addPhoneRoot(broader)
    expect(roots).toEqual([await realpath(broader)])

    const file = join(root, 'file.txt')
    await writeFile(file, 'x')
    await expect(store.addPhoneRoot(file)).rejects.toThrow('不是文件夹')

    expect(await store.removePhoneRoot(await realpath(broader))).toEqual([])
  })

  it('adds a workspace without stealing the desktop active workspace', async () => {
    const { store, root } = await setup()
    const first = join(root, 'first')
    await mkdir(first)
    await store.addWorkspace(first)
    expect(store.activeWorkspace()).toBe(await realpath(first))

    const second = join(root, 'second')
    await mkdir(second)
    await store.addWorkspace(second, { activate: false })
    expect(store.activeWorkspace()).toBe(await realpath(first))
    expect(store.workspaces().map((workspace) => workspace.path)).toContain(
      await realpath(second),
    )
  })

  it('creates a workspace only inside an authorized root', async () => {
    const { store, server, root, base } = await setup()
    await store.addPhoneRoot(root)
    const authorized = await realpath(root)

    const created = (await createWorkspace(server, {
      root: authorized,
      name: 'my-project',
    })) as { path: string; name: string }
    expect(created.path).toBe(join(authorized, 'my-project'))
    expect(created.name).toBe('my-project')
    expect(store.workspaces().map((workspace) => workspace.path)).toContain(created.path)

    // Reusing an existing folder keeps it idempotent.
    const again = (await createWorkspace(server, {
      root: authorized,
      name: 'my-project',
    })) as { path: string }
    expect(again.path).toBe(created.path)

    const unauthorized = join(base, 'elsewhere')
    await mkdir(unauthorized)
    await expect(
      createWorkspace(server, { root: unauthorized, name: 'escape' }),
    ).rejects.toThrow('授权')
  })

  it('rejects names that could escape the authorized root', async () => {
    const { store, server, root } = await setup()
    await store.addPhoneRoot(root)
    const authorized = await realpath(root)

    for (const name of ['..', '.', '../escape', 'a/b', 'a\\b', 'con', 'name.']) {
      await expect(
        createWorkspace(server, { root: authorized, name }),
        name,
      ).rejects.toThrow()
    }
    expect(store.workspaces()).toHaveLength(0)
  })

  it('refuses to create a directory over an existing file', async () => {
    const { store, server, root } = await setup()
    await store.addPhoneRoot(root)
    const authorized = await realpath(root)
    await writeFile(join(authorized, 'taken'), 'x')

    await expect(
      createWorkspace(server, { root: authorized, name: 'taken' }),
    ).rejects.toThrow('同名文件')
  })

  it('browses folders at any depth and hides files and dot folders', async () => {
    const { store, server, root } = await setup()
    await store.addPhoneRoot(root)
    const authorized = await realpath(root)
    await mkdir(join(authorized, 'alpha', 'deep', 'deeper'), { recursive: true })
    await mkdir(join(authorized, 'beta'))
    await mkdir(join(authorized, '.hidden'))
    await writeFile(join(authorized, 'notes.txt'), 'x')

    const top = (await request(server, 'workspaces.browse', {
      root: authorized,
      path: '',
    })) as {
      root: string
      directory: string
      parent: string
      entries: Array<{ name: string; path: string }>
      truncated: boolean
    }
    expect(top.root).toBe(authorized)
    expect(top.directory).toBe('')
    expect(top.parent).toBe('')
    expect(top.truncated).toBe(false)
    expect(top.entries.map((entry) => entry.name).sort()).toEqual(['alpha', 'beta'])
    expect(top.entries.map((entry) => entry.path).sort()).toEqual(['alpha', 'beta'])

    const nested = (await request(server, 'workspaces.browse', {
      root: authorized,
      path: 'alpha/deep',
    })) as {
      directory: string
      parent: string
      entries: Array<{ name: string; path: string }>
    }
    expect(nested.directory).toBe('alpha/deep')
    expect(nested.parent).toBe('alpha')
    expect(nested.entries).toEqual([{ name: 'deeper', path: 'alpha/deep/deeper' }])

    // 反斜杠也按路径分隔处理，手机端不必关心平台差异。
    const windowsStyle = (await request(server, 'workspaces.browse', {
      root: authorized,
      path: 'alpha\\deep',
    })) as { directory: string }
    expect(windowsStyle.directory).toBe('alpha/deep')
  })

  it('refuses to browse outside the authorized root', async () => {
    const { store, server, root, base } = await setup()
    await store.addPhoneRoot(root)
    const authorized = await realpath(root)
    const outside = join(base, 'outside')
    await mkdir(outside)
    await mkdir(join(authorized, 'inside'))
    await symlink(
      outside,
      join(authorized, 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    await writeFile(join(authorized, 'plain.txt'), 'x')

    const listed = (await request(server, 'workspaces.browse', {
      root: authorized,
      path: '',
    })) as { entries: Array<{ name: string }> }
    expect(listed.entries.map((entry) => entry.name)).toEqual(['inside'])

    for (const path of ['..', '../outside', 'inside/../..', 'C:\\Windows', '/etc']) {
      await expect(
        request(server, 'workspaces.browse', { root: authorized, path }),
        path,
      ).rejects.toThrow('授权')
    }
    await expect(
      request(server, 'workspaces.browse', { root: authorized, path: 'plain.txt' }),
    ).rejects.toThrow('文件夹')
    await expect(
      request(server, 'workspaces.browse', { root: outside, path: '' }),
    ).rejects.toThrow('授权')
  })

  it('opens an existing nested folder without stealing the active workspace', async () => {
    const { store, server, root } = await setup()
    await store.addPhoneRoot(root)
    const authorized = await realpath(root)
    const active = join(authorized, 'active')
    await mkdir(active)
    await store.addWorkspace(active)
    const target = join(authorized, 'clients', 'acme')
    await mkdir(target, { recursive: true })

    const opened = (await request(server, 'workspaces.open', {
      root: authorized,
      path: 'clients/acme',
    })) as { path: string; name: string }
    expect(opened.path).toBe(await realpath(target))
    expect(opened.name).toBe('acme')
    expect(store.activeWorkspace()).toBe(await realpath(active))
    expect(store.workspaces().map((workspace) => workspace.path)).toContain(
      await realpath(target),
    )

    // 重复打开不会产生重复工作区。
    await request(server, 'workspaces.open', { root: authorized, path: 'clients/acme' })
    expect(
      store.workspaces().filter((workspace) => workspace.path === opened.path),
    ).toHaveLength(1)

    await expect(
      request(server, 'workspaces.open', { root: authorized, path: '../escape' }),
    ).rejects.toThrow('授权')
  })

  it('creates a new folder inside the currently browsed subfolder', async () => {
    const { store, server, root } = await setup()
    await store.addPhoneRoot(root)
    const authorized = await realpath(root)
    await mkdir(join(authorized, 'clients'))
    await mkdir(join(authorized, 'clients', 'acme'), { recursive: true })

    const created = (await createWorkspace(server, {
      root: authorized,
      path: 'clients',
      name: 'new-project',
    })) as { path: string }
    expect(created.path).toBe(join(authorized, 'clients', 'new-project'))

    await expect(
      createWorkspace(server, { root: authorized, path: '../..', name: 'escape' }),
    ).rejects.toThrow('授权')
  })

  it('reports authorized roots to the phone and refuses when empty', async () => {
    const { store, server, root } = await setup()
    const list = (await request(server, 'workspaces.list', {})) as {
      workspaces: unknown[]
      roots: string[]
    }
    expect(list.roots).toEqual([])
    await expect(createWorkspace(server, { root, name: 'x' })).rejects.toThrow('还没有配置')

    await store.addPhoneRoot(root)
    const next = (await request(server, 'workspaces.list', {})) as { roots: string[] }
    expect(next.roots).toEqual([await realpath(root)])

    // sessions.list 也带上授权目录，手机端一次刷新就能拿到。
    const sessionsList = (await request(server, 'sessions.list', {})) as { roots: string[] }
    expect(sessionsList.roots).toEqual([await realpath(root)])
  })
})
