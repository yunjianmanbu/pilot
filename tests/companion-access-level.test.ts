import { mkdir, mkdtemp, rm } from 'node:fs/promises'
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
import {
  accessLevelOf,
  canApproveRisk,
  canManageHost,
  isLocalOnlyMethod,
  APPROVAL_EXEC_LOCAL_ONLY_ERROR,
  CLIENT_NO_SPACE_ERROR,
  LOCAL_ONLY_ERROR,
  type AccessLevel,
} from '../src/main/companion/access-level'

const cleanups: string[] = []

afterEach(async () => {
  while (cleanups.length) {
    const dir = cleanups.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

async function setup(
  runner: unknown = {},
  guest: { runner?: unknown } | null = null,
): Promise<{ server: CompanionServer; root: string; store: Store; guestStore: Store | null }> {
  const base = await mkdtemp(join(tmpdir(), 'pilot-access-level-'))
  cleanups.push(base)
  userDataDir = join(base, 'user-data')
  const root = join(base, 'projects')
  await mkdir(root, { recursive: true })
  const store = new Store()
  await store.load()
  const server = new CompanionServer({
    store,
    runner: runner as never,
    dataDir: join(base, 'companion'),
    assetsDir: base,
    deviceName: 'Test Desktop',
    appVersion: '0.1.0-test',
    billing: { report: () => Promise.reject(new Error('billing is not stubbed')) },
    onStatus: () => undefined,
  })
  let guestStore: Store | null = null
  if (guest) {
    // 客户机用户必须有独立数据面；测试里给它一套自己的 Store + runner stub。
    guestStore = new Store(join(base, 'guest-data'))
    await guestStore.load()
    server.attachGuest({
      role: 'client',
      store: guestStore,
      runner: (guest.runner ?? {}) as never,
    })
  }
  return { server, root, store, guestStore }
}

function request(
  server: CompanionServer,
  method: string,
  params: Record<string, unknown>,
  access: AccessLevel,
): Promise<unknown> {
  return (
    server as unknown as {
      handleRequest(
        name: string,
        input: Record<string, unknown>,
        phone: unknown,
        level: AccessLevel,
      ): Promise<unknown>
    }
  ).handleRequest(method, params, {}, access)
}

describe('access level from the connection', () => {
  it('treats a loopback LAN socket as the person at the computer', () => {
    expect(accessLevelOf({ via: 'lan', address: '127.0.0.1' })).toBe('local')
    expect(accessLevelOf({ via: 'lan', address: '::1' })).toBe('local')
    expect(accessLevelOf({ via: 'lan', address: '::ffff:127.0.0.1' })).toBe('local')
  })

  it('never calls a relay socket local, even though the host dialled out', () => {
    // 中继连接由本机出站建立，socket 地址是本机的回环口；按地址判断会误放行，
    // 所以必须同时要求 via === 'lan'。
    expect(accessLevelOf({ via: 'relay', address: '127.0.0.1' })).not.toBe('local')
    expect(accessLevelOf({ via: 'relay', address: null })).not.toBe('local')
  })

  it('separates a scanned phone from a browser that was simply handed the URL', () => {
    expect(accessLevelOf({ via: 'lan', address: '192.168.0.42', credential: 'qr' })).toBe('paired')
    expect(
      accessLevelOf({ via: 'lan', address: '192.168.0.42', credential: 'browser' }),
    ).toBe('client')
    // 旧记录没有 via 字段：按扫码配对处理，避免升级后手机掉功能。
    expect(accessLevelOf({ via: 'lan', address: '192.168.0.42' })).toBe('paired')
  })

  it('turns a browser the host accepted as a host user into a full copy of this computer', () => {
    expect(
      accessLevelOf({
        via: 'lan',
        address: '192.168.0.42',
        credential: 'browser',
        role: 'host',
      }),
    ).toBe('host')
    // 没有 role 的旧凭据、或审批时选了客户机，都只能拿到受限数据面。
    expect(
      accessLevelOf({ via: 'lan', address: '192.168.0.42', credential: 'browser', role: 'client' }),
    ).toBe('client')
  })

  it('only withholds host management from the client user', () => {
    expect(canManageHost('local')).toBe(true)
    expect(canManageHost('paired')).toBe(true)
    expect(canManageHost('host')).toBe(true)
    expect(canManageHost('client')).toBe(false)
  })

  it('grades approvals by risk rather than by who is farther away', () => {
    expect(canApproveRisk('client', 'read')).toBe(true)
    expect(canApproveRisk('client', 'write')).toBe(true)
    expect(canApproveRisk('client', 'exec')).toBe(false)
    // 配对手机是自己的另一块屏幕，命令也能批。
    expect(canApproveRisk('paired', 'exec')).toBe(true)
    expect(canApproveRisk('local', 'exec')).toBe(true)
  })
})

describe('what a browser visitor may not touch', () => {
  it('locks the operations that change this computer, its credentials or its spend', () => {
    for (const method of [
      'update.check',
      'update.download',
      'update.install',
      'evolution.state',
      'evolution.apply',
      'reflect.settings',
      'reflect.now',
      'reflect.mail.test',
      'moduleCheck.run',
      'moduleCheck.accept',
      'pairing.transfer',
      'selfCheck.run',
      'system.info',
      'billing.get',
      'workspaces.open',
      'workspaces.create',
      'workspaces.browse',
      'workspaces.remove',
      'models.update',
      'memory.add',
      'memory.remove',
      'learning.settings',
      'quickCommands.save',
      // 把本会话降级成自动批准，等于替本机把安全门槛清零。
      'approval.allowSession',
      // 换个入口降低同一道门槛（「全部自动」等于逐条自动批准）。
      'sessions.approvalMode',
      // 定时任务＝没人看着时让这台电脑自己跑 agent。
      'schedules.add',
      'schedules.update',
      'schedules.remove',
    ]) {
      expect(isLocalOnlyMethod(method), method).toBe(true)
    }
  })

  it('leaves the work itself open: sessions, chat, files, approvals, review', () => {
    for (const method of [
      'sessions.list',
      'sessions.create',
      'sessions.model',
      'chat.send',
      'chat.stop',
      'run.retry',
      'files.list',
      'files.read',
      'files.upload.begin',
      'workspaces.list',
      'memory.list',
      'quickCommands.get',
      'learning.state',
      'approvals.list',
      'approval.decide',
      'schedules.list',
      'changes.revert',
      'checkpoints.restore',
      'device.info',
    ]) {
      expect(isLocalOnlyMethod(method), method).toBe(false)
    }
  })
})

describe('the gate is in the protocol, not only in the UI', () => {
  it('rejects a host-changing call from a browser visitor before it reaches any domain', async () => {
    const { server } = await setup()
    await expect(request(server, 'update.check', {}, 'client')).rejects.toThrow(
      LOCAL_ONLY_ERROR,
    )
    await expect(request(server, 'pairing.transfer', {}, 'client')).rejects.toThrow(
      LOCAL_ONLY_ERROR,
    )
    await expect(request(server, 'approval.allowSession', {}, 'client')).rejects.toThrow(
      LOCAL_ONLY_ERROR,
    )
    await expect(request(server, 'billing.get', {}, 'client')).rejects.toThrow(
      LOCAL_ONLY_ERROR,
    )
    await expect(
      request(server, 'sessions.approvalMode', { sessionId: 's', approvalMode: 'auto' }, 'client'),
    ).rejects.toThrow(LOCAL_ONLY_ERROR)
    await expect(request(server, 'schedules.add', { content: 'x' }, 'client')).rejects.toThrow(
      LOCAL_ONLY_ERROR,
    )
  })

  it('lets the same client user use the work', async () => {
    const { server } = await setup(undefined, { runner: {} })
    const sessions = (await request(server, 'sessions.list', {}, 'client')) as {
      sessions: unknown[]
    }
    expect(Array.isArray(sessions.sessions)).toBe(true)
    const workspaces = (await request(server, 'workspaces.list', {}, 'client')) as {
      workspaces: unknown[]
    }
    expect(Array.isArray(workspaces.workspaces)).toBe(true)
  })

  it('gives a client user their own data instead of this computer\u2019s sessions', async () => {
    const { server, root, store, guestStore } = await setup(undefined, { runner: {} })
    await store.addWorkspace(root)
    const hostSession = await store.createSession(root, { title: '只有本机能看见' })

    const asClient = (await request(server, 'sessions.list', {}, 'client')) as {
      sessions: { id: string }[]
    }
    expect(asClient.sessions.map((item) => item.id)).not.toContain(hostSession.id)
    const clientWorkspaces = (await request(server, 'workspaces.list', {}, 'client')) as {
      workspaces: unknown[]
    }
    expect(clientWorkspaces.workspaces).toEqual([])

    // 同一台电脑上的 host 身份仍然看到本机那份数据。
    const asHost = (await request(server, 'sessions.list', {}, 'local')) as {
      sessions: { id: string }[]
    }
    expect(asHost.sessions.map((item) => item.id)).toContain(hostSession.id)
    expect(guestStore?.workspaces()).toEqual([])
  })

  it('refuses a client user when this computer has no separate space ready', async () => {
    const { server } = await setup()
    await expect(request(server, 'sessions.list', {}, 'client')).rejects.toThrow(
      CLIENT_NO_SPACE_ERROR,
    )
    // 身份信息仍然可以读，页面据此提示「请在电脑前批准一次」。
    const info = (await request(server, 'device.info', {}, 'client')) as { accessLevel: AccessLevel }
    expect(info.accessLevel).toBe('client')
  })

  it('reports the access level so the page can hide what it cannot do', async () => {
    const { server } = await setup()
    const browserView = (await request(server, 'device.info', {}, 'client')) as {
      accessLevel: AccessLevel
      capabilities: unknown
    }
    expect(browserView.accessLevel).toBe('client')
    expect(browserView.capabilities).toBeTruthy()

    const pairedView = (await request(server, 'device.info', {}, 'paired')) as {
      accessLevel: AccessLevel
    }
    expect(pairedView.accessLevel).toBe('paired')
  })

  it('keeps a paired phone fully capable', async () => {
    const { server } = await setup()
    // 配对手机（本人设备）仍可管这台电脑；这里只要求不被访问级别挡下，
    // 具体能否安装由更新器自己的状态决定。
    await expect(request(server, 'update.check', {}, 'paired')).rejects.not.toThrow(
      LOCAL_ONLY_ERROR,
    )
  })
})

describe('approving a pending tool call is graded by risk', () => {
  function runnerStub(risk: string) {
    const decisions: { callId: string; approved: boolean }[] = []
    return {
      decisions,
      runner: {
        pendingApprovalList: () => [
          { callId: 'call-1', sessionId: 's-1', tool: 'run_shell', risk, runId: 'r-1' },
        ],
        decideApproval: async (callId: string, approved: boolean) => {
          decisions.push({ callId, approved })
        },
      },
    }
  }

  it('lets a client user approve reads and edits inside their own space', async () => {
    const hostStub = runnerStub('write')
    const guestStub = runnerStub('write')
    const { server } = await setup(hostStub.runner, { runner: guestStub.runner })
    await expect(
      request(server, 'approval.decide', { callId: 'call-1', approved: true }, 'client'),
    ).resolves.toEqual({ ok: true })
    // 决定落在客户机自己的 runner 上，本机那套完全没被动过。
    expect(guestStub.decisions).toEqual([{ callId: 'call-1', approved: true }])
    expect(hostStub.decisions).toEqual([])
  })

  it('refuses a client user approving a command, because that hands over the shell', async () => {
    const hostStub = runnerStub('exec')
    const guestStub = runnerStub('exec')
    const { server } = await setup(hostStub.runner, { runner: guestStub.runner })
    await expect(
      request(server, 'approval.decide', { callId: 'call-1', approved: true }, 'client'),
    ).rejects.toThrow(APPROVAL_EXEC_LOCAL_ONLY_ERROR)
    // 被拒时不能悄悄改了状态：决定不能落到任何一台 runner 上。
    expect(guestStub.decisions).toEqual([])
    expect(hostStub.decisions).toEqual([])
  })

  it('still lets that client user refuse a command', async () => {
    const hostStub = runnerStub('exec')
    const guestStub = runnerStub('exec')
    const { server } = await setup(hostStub.runner, { runner: guestStub.runner })
    await expect(
      request(server, 'approval.decide', { callId: 'call-1', approved: false }, 'client'),
    ).resolves.toEqual({ ok: true })
    expect(guestStub.decisions).toEqual([{ callId: 'call-1', approved: false }])
    expect(hostStub.decisions).toEqual([])
  })

  it('lets the person at the computer approve a command', async () => {
    const stub = runnerStub('exec')
    const { server } = await setup(stub.runner)
    await expect(
      request(server, 'approval.decide', { callId: 'call-1', approved: true }, 'local'),
    ).resolves.toEqual({ ok: true })
    expect(stub.decisions).toEqual([{ callId: 'call-1', approved: true }])
  })
})
