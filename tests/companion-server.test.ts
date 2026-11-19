import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'

vi.mock('electron', () => ({
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

import type { Store } from '../src/main/store'
import { CompanionServer } from '../src/main/companion/server'
import { SERVER_CAPABILITIES, type HostCapabilities } from '../src/shared/capabilities'
import type { CompanionPairRequest } from '../src/shared/types'
import {
  createKeyPair,
  decryptPayload,
  derivePairKeys,
  encryptPayload,
  tokenProof,
} from '../src/main/companion/crypto'

interface PairPayload {
  v: number
  r: string
  d: string
  k: string
  s: string
  p: string
  n: string
}

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()?.()
  }
})

function waitForFrame(
  socket: WebSocket,
  predicate: (frame: Record<string, unknown>) => boolean,
  timeout = 8_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage)
      reject(new Error('timed out waiting for WebSocket frame'))
    }, timeout)
    const onMessage = (data: WebSocket.RawData): void => {
      let frame: Record<string, unknown>
      try {
        frame = JSON.parse(data.toString()) as Record<string, unknown>
      } catch {
        return
      }
      if (!predicate(frame)) return
      clearTimeout(timer)
      socket.off('message', onMessage)
      resolve(frame)
    }
    socket.on('message', onMessage)
  })
}

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const timer = setTimeout(() => {
      socket.terminate()
      reject(new Error('WebSocket connect timed out'))
    }, 8_000)
    socket.once('open', () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

interface UpdateCalls {
  check: number
  download: number
  install: number
}

function fakeUpdateState(status: string): Record<string, unknown> {
  return {
    status,
    currentVersion: '0.1.0-test',
    release: { version: '0.1.1', date: '2026-11-15', size: 1_024, notes: 'Test release' },
    progress: 0,
    transferred: 0,
    total: 0,
    message: '',
    checkedAt: null,
  }
}

async function createServer(
  options: {
    activeRuns?: number
    withoutUpdate?: boolean
    workspacePath?: string
    surface?: 'desktop' | 'phone'
    pluginRoot?: string
    /** How the fake desktop answers the pairing prompt; 'ignore' never does. */
    pairApproval?: 'approve' | 'reject' | 'ignore'
    /** Overrides how long the phone waits for that answer. */
    pairApprovalTtlMs?: number
    /** Adds the optional checkpoint/change adapters and memory/quick-command store methods. */
    featureStubs?: boolean
    /** Host capability declaration; omitted means "desktop", as before. */
    capabilities?: HostCapabilities
  } = {},
): Promise<{
  server: CompanionServer
  status: ReturnType<CompanionServer['status']>
  dataDir: string
  billingCalls: unknown[]
  updateCalls: UpdateCalls
  retriedSessions: string[]
  modelUpdates: unknown[]
  sessionModelUpdates: Array<{ sessionId: string; modelId: string }>
  billingInvalidations: () => number
  /** Every request the desktop was asked to confirm, in order. */
  pairRequests: CompanionPairRequest[]
  /** Confirmed self-check fixes, in order. */
  moduleAccepted: Array<{ reportId: string; riskIds: string[]; selfModify: boolean }>
  /** How many times the phone asked for an introspection report. */
  selfCheckCalls: () => number
}> {
  const dataDir = await mkdtemp(join(tmpdir(), 'pilot-companion-'))
  const modelUpdates: unknown[] = []
  const sessionModelUpdates: Array<{ sessionId: string; modelId: string }> = []
  let billingInvalidations = 0
  let modelSettings = {
    resources: [
      {
        id: 'primary',
        label: '主模型',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-chat',
        enabled: true,
        hasKey: true,
        keyHint: '••••main',
      },
      {
        id: 'judge-qwen',
        label: '通义千问',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: 'qwen-plus',
        enabled: true,
        hasKey: true,
        keyHint: '••••qwen',
      },
    ],
    sessionModelId: 'primary',
    evaluationModelIds: [] as string[],
    reviewModelId: '',
  }
  let learningSettings = { learningMode: false, learningHosts: [] as string[] }
  const store = {
    settingsView: () => ({
      model: 'deepseek-chat',
      theme: 'dark',
      relayUrl: '',
      learningMode: learningSettings.learningMode,
      learningHosts: [...learningSettings.learningHosts],
    }),
    modelSettingsView: () => modelSettings,
    updateSettings: async (input: {
      sessionModelId?: string
      evaluationModelIds?: string[]
      reviewModelId?: string
      learningMode?: boolean
      learningHosts?: string[]
    }) => {
      modelUpdates.push(input)
      modelSettings = {
        ...modelSettings,
        ...(input.sessionModelId !== undefined
          ? { sessionModelId: input.sessionModelId }
          : {}),
        ...(input.evaluationModelIds !== undefined
          ? { evaluationModelIds: input.evaluationModelIds }
          : {}),
        ...(input.reviewModelId !== undefined ? { reviewModelId: input.reviewModelId } : {}),
      }
      learningSettings = {
        ...learningSettings,
        ...(input.learningMode !== undefined ? { learningMode: input.learningMode } : {}),
        ...(input.learningHosts !== undefined
          ? { learningHosts: [...input.learningHosts] }
          : {}),
      }
      return modelSettings
    },
    workspaces: () =>
      options.workspacePath
        ? [
            {
              path: options.workspacePath,
              name: 'Test Workspace',
            },
          ]
        : [],
    setSessionModel: async (sessionId: string, modelId: string) => {
      if (modelId && !modelSettings.resources.some((resource) => resource.id === modelId)) {
        throw new Error('指定的模型不存在')
      }
      sessionModelUpdates.push({ sessionId, modelId })
      return {
        id: sessionId,
        title: 'Task',
        workspacePath: options.workspacePath ?? '',
        sessionModelId: modelId,
        updatedAt: '2026-11-18T00:00:00.000Z',
      }
    },
    phoneRoots: () => [],
    sessions: () => [],
    activeWorkspace: () => '',
    session: () => null,
    deleteSession: async () => undefined,
    removeWorkspace: async () => undefined,
    settings: () => ({ testTargets: [], testCaptchaMode: 'off' }),
    getTestCaptcha: () => null,
    ...(options.featureStubs
      ? {
          workspaceDetail: () => ({ memory: [] }),
          addMemory: async (workspacePath: string, content: string) => ({
            id: 'memory-1',
            workspacePath,
            content,
            source: 'user',
            createdAt: '2026-11-16T00:00:00.000Z',
          }),
          deleteMemory: async () => undefined,
          quickCommands: () => null,
          saveQuickCommands: async (items: Array<{ id?: string; content: string }>) =>
            items.map((item, index) => ({ id: item.id ?? `quick-${index}`, content: item.content })),
        }
      : {}),
  } as unknown as Store
  const billingCalls: unknown[] = []
  const updateCalls: UpdateCalls = { check: 0, download: 0, install: 0 }
  const retriedSessions: string[] = []
  let updateStatus = 'available'
  const pairRequests: CompanionPairRequest[] = []
  // The phone report must stay small: build more risks than the relay can carry
  // so the capping and the counts are exercised.
  const moduleRisks = Array.from({ length: 170 }, (_, index) => ({
    id: `risk-${index}`,
    moduleId: 'app',
    moduleName: 'app',
    rule: 'oversized-file',
    severity: index % 3 === 0 ? 'high' : index % 3 === 1 ? 'medium' : 'low',
    title: `Risk ${index}`,
    detail: 'File is long',
    recommendation: 'Split it',
    count: 1,
    evidence: ['src/app.ts:1'],
    manual: false,
  }))
  const moduleTarget = {
    id: 'app',
    name: 'app',
    path: 'app',
    files: 2,
    sourceFiles: 1,
    testFiles: 0,
    lines: 100,
  }
  const moduleReport = {
    id: 'report-1',
    trigger: 'manual',
    startedAt: '2026-11-16T00:00:00.000Z',
    finishedAt: '2026-11-16T00:00:01.000Z',
    workspace: 'E:/demo',
    modules: ['app'],
    targets: [moduleTarget],
    risks: moduleRisks,
    scannedFiles: 2,
    scannedLines: 100,
    score: 88,
  }
  const moduleSettings = { enabled: false, intervalHours: 24, modules: [] as string[] }
  const moduleState = {
    settings: moduleSettings,
    lastRunAt: '2026-11-16T00:00:01.000Z',
    nextRunAt: '2026-11-17T00:00:01.000Z',
    lastReport: moduleReport,
    history: [moduleReport, moduleReport, moduleReport],
    decisions: Array.from({ length: 8 }, (_, index) => ({
      reportId: 'report-1',
      riskIds: ['risk-1'],
      sessionId: `session-${index}`,
      at: '2026-11-16T00:00:02.000Z',
      selfModify: true,
    })),
    proposals: [
      {
        id: 'mp_1',
        reportId: 'report-1',
        createdAt: '2026-11-16T00:00:03.000Z',
        workspace: 'E:/demo',
        riskIds: ['risk-1', 'risk-2'],
        prompt: 'x'.repeat(2_400),
        selfModify: false,
      },
    ],
  }
  const moduleAccepted: Array<{ reportId: string; riskIds: string[]; selfModify: boolean }> = []
  let selfCheckCalls = 0
  // 内视报告的最小形状：手机端只做展示，不参与判定。
  const selfCheckReport = {
    at: 1_760_000_000_000,
    version: '0.1.0-test',
    durationMs: 12,
    counts: { ok: 1, warn: 0, off: 0, broken: 0 },
    items: [
      {
        id: 'runtime',
        group: 'runtime',
        title: '运行时',
        status: 'ok',
        detail: '正常',
        facts: ['Pilot 0.1.0-test'],
        durationMs: 3,
      },
    ],
  }
  const approval = options.pairApproval ?? 'approve'
  /** Set once the server exists: `onEvent` can only answer after that. */
  let instance: CompanionServer | null = null
  const server = new CompanionServer({
    store,
    runner: {
      activeRunCount: () => options.activeRuns ?? 0,
      isRunning: () => false,
      retryRun: async (sessionId: string) => {
        retriedSessions.push(sessionId)
      },
      editMessage: async () => undefined,
      deleteMessage: async () => undefined,
      regenerate: async () => undefined,
    } as never,
    ...(options.capabilities ? { capabilities: options.capabilities } : {}),
    ...(options.featureStubs
      ? {
          checkpoints: {
            removeSession: async () => undefined,
            list: async () => [],
            create: async () => ({
              id: 'checkpoint-1',
              sessionId: 'session-1',
              workspacePath: process.cwd(),
              label: 'test',
              createdAt: '2026-11-16T00:00:00.000Z',
              messageCount: 0,
              files: 0,
              bytes: 0,
              trigger: 'manual',
              complete: true,
              skipped: 0,
            }),
            restore: async () => ({
              checkpoint: {
                id: 'checkpoint-1',
                sessionId: 'session-1',
                workspacePath: process.cwd(),
                label: 'test',
                createdAt: '2026-11-16T00:00:00.000Z',
                messageCount: 0,
                files: 0,
                bytes: 0,
                trigger: 'manual',
                complete: true,
                skipped: 0,
              },
              session: { id: 'session-1' } as never,
              restoredFiles: 1,
              removedFiles: 0,
              truncatedMessages: 0,
            }),
          },
          changes: {
            list: async () => [],
            revert: async (_sessionId: string, path: string) => ({
              path,
              restored: true,
              removed: false,
            }),
          },
          moduleCheck: {
            source: () => 'E:/demo',
            state: async () => moduleState as never,
            discover: async () => [moduleTarget] as never,
            run: async () => moduleReport as never,
            settings: async (input: { enabled?: boolean; intervalHours?: number; modules?: string[] }) => {
              if (input.enabled !== undefined) moduleSettings.enabled = input.enabled
              if (input.intervalHours !== undefined) moduleSettings.intervalHours = input.intervalHours
              if (input.modules !== undefined) moduleSettings.modules = input.modules
              return moduleState as never
            },
            accept: async (reportId: string, riskIds: string[], selfModify: boolean) => {
              moduleAccepted.push({ reportId, riskIds, selfModify })
              return selfModify
                ? { sessionId: 'module-session-1', queued: false, selfModify: true, proposalId: 'mp_1' }
                : { queued: false, selfModify: false, proposalId: 'mp_1' }
            },
          },
          selfCheck: {
            // 内视只读：手机端只能拿到报告，不能传路径或让它改文件。
            run: async () => {
              selfCheckCalls += 1
              return selfCheckReport as never
            },
          },
        }
      : {}),
    dataDir,
    assetsDir: fileURLToPath(new URL('../companion', import.meta.url)),
    deviceName: 'Test Desktop',
    appVersion: '0.1.0-test',
    ...(options.pluginRoot ? { pluginRoot: options.pluginRoot } : {}),
    ...(options.withoutUpdate
      ? {}
      : {
          update: {
            state: () => fakeUpdateState(updateStatus) as never,
            check: async () => {
              updateCalls.check += 1
              updateStatus = 'available'
              return fakeUpdateState(updateStatus) as never
            },
            download: async () => {
              updateCalls.download += 1
              updateStatus = 'downloading'
              return fakeUpdateState(updateStatus) as never
            },
            install: async () => {
              updateCalls.install += 1
            },
          },
        }),
    billing: {
      report: async (refresh?: boolean) => {
        billingCalls.push(refresh)
        return {
          hasKey: true,
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-chat',
          balance: {
            ok: true,
            available: true,
            entries: [
              { currency: 'CNY', totalBalance: '12.00', grantedBalance: '2.00', toppedUpBalance: '10.00' },
            ],
            source: 'https://api.deepseek.com/user/balance',
            fetchedAt: '2026-11-13T00:00:00.000Z',
          },
          usage: {
            rows: [],
            runs: 0,
            promptTokens: 0,
            completionTokens: 0,
            cacheHitTokens: 0,
            cacheMissTokens: 0,
            estimatedCostUsd: null,
            unpricedModels: [],
          },
          priceSource: 'test-prices',
          checkedAt: '2026-11-13T00:00:00.000Z',
        }
      },
      invalidate: () => {
        billingInvalidations += 1
      },
    },
    relayUrl: '',
    appUrl: '',
    ...(options.surface ? { surface: options.surface } : {}),
    ...(options.pairApprovalTtlMs === undefined
      ? {}
      : { pairApprovalTtlMs: options.pairApprovalTtlMs }),
    onStatus: () => undefined,
    onEvent: (event) => {
      if (event.type !== 'companion.pair_request') return
      pairRequests.push(event.request)
      if (approval === 'ignore') return
      instance?.resolvePairing(event.request.requestId, approval === 'approve')
    },
  })
  instance = server
  await server.init()
  cleanups.push(async () => {
    await server.stop()
    await rm(dataDir, { recursive: true, force: true })
  })
  const status = await server.setEnabled(true)
  return {
    server,
    status,
    dataDir,
    billingCalls,
    updateCalls,
    retriedSessions,
    moduleAccepted,
    selfCheckCalls: () => selfCheckCalls,
    modelUpdates,
    sessionModelUpdates,
    billingInvalidations: () => billingInvalidations,
    pairRequests,
  }
}

async function authenticatePhone(
  server: CompanionServer,
  status: ReturnType<CompanionServer['status']>,
): Promise<{
  phoneId: string
  call: (
    id: string,
    method: string,
    params?: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>
}> {
  const pairing = await server.createPairing()
  const payload = JSON.parse(
    Buffer.from(new URL(pairing.url).hash.slice(3), 'base64url').toString('utf8'),
  ) as PairPayload
  const phone = createKeyPair()
  const phoneId = 'testphone012345'
  const relayUrl = `ws://127.0.0.1:${status.port}/ws`
  const pairSocket = await openSocket(relayUrl)
  cleanups.push(() => pairSocket.close())
  const acceptedPromise = waitForFrame(pairSocket, (frame) => frame.type === 'pair.accepted')
  pairSocket.send(
    JSON.stringify({
      type: 'pair.join',
      lookup: payload.k,
      phoneId,
      name: 'Test Phone',
      phonePub: phone.publicBase64,
      platform: 'test',
      protocol: 2,
    }),
  )
  const accepted = await acceptedPromise
  const keys = derivePairKeys(phone.privateKey, payload.p, payload.s)
  const token = (decryptPayload(keys.pcToPhone, accepted.payload).value as { token?: string })
    .token

  const sessionSocket = await openSocket(relayUrl)
  cleanups.push(() => sessionSocket.close())
  const challengePromise = waitForFrame(
    sessionSocket,
    (frame) => frame.type === 'hello.challenge',
  )
  sessionSocket.send(
    JSON.stringify({
      type: 'hello',
      role: 'phone',
      deviceId: status.deviceId,
      phoneId,
      protocol: 2,
    }),
  )
  const challenge = await challengePromise
  const welcomePromise = waitForFrame(sessionSocket, (frame) => frame.type === 'welcome')
  sessionSocket.send(
    JSON.stringify({
      type: 'hello.proof',
      deviceId: status.deviceId,
      phoneId,
      proof: tokenProof(token as string, challenge.challenge as string),
    }),
  )
  await welcomePromise

  // 电脑端可能先推送事件再回响应，两个帧几乎同时到达；用常驻监听加队列，
  // 避免「先 attach 再等」漏掉紧跟其后的响应。
  const inbox: Record<string, unknown>[] = []
  const inboxWaiters: Array<(frame: Record<string, unknown>) => void> = []
  sessionSocket.on('message', (data: WebSocket.RawData) => {
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(data.toString()) as Record<string, unknown>
    } catch {
      return
    }
    const waiter = inboxWaiters.shift()
    if (waiter) waiter(frame)
    else inbox.push(frame)
  })
  const nextFrame = (): Promise<Record<string, unknown>> => {
    const buffered = inbox.shift()
    if (buffered) return Promise.resolve(buffered)
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout
      const deliver = (frame: Record<string, unknown>): void => {
        clearTimeout(timer)
        resolve(frame)
      }
      timer = setTimeout(() => {
        const index = inboxWaiters.indexOf(deliver)
        if (index >= 0) inboxWaiters.splice(index, 1)
        reject(new Error('timed out waiting for WebSocket frame'))
      }, 8_000)
      inboxWaiters.push(deliver)
    })
  }

  let seq = 0
  const call = async (
    id: string,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> => {
    seq += 1
    sessionSocket.send(
      JSON.stringify({
        type: 'message',
        payload: encryptPayload(
          keys.phoneToPc,
          { type: 'request', id, method, params },
          seq,
        ),
      }),
    )
    // 电脑端会先推送 session.changed / memory.changed 之类的事件，
    // 这里只取 id 对得上的响应，避免事件把响应挤掉。
    for (;;) {
      const frame = await nextFrame()
      const value = decryptPayload(keys.pcToPhone, frame.payload)
        .value as Record<string, unknown>
      if (value.type === 'response' && value.id === id) return value
    }
  }
  return { phoneId, call }
}

describe('CompanionServer pairing and relay', () => {
  it('waits for the desktop to approve before the phone gets a token', async () => {
    let answered = false
    const captured: CompanionPairRequest[] = []
    const { server, status } = await createServer({
      pairApproval: 'ignore',
      pairApprovalTtlMs: 30_000,
    })
    const pairing = await server.createPairing()
    const payload = JSON.parse(
      Buffer.from(new URL(pairing.url).hash.slice(3), 'base64url').toString('utf8'),
    ) as PairPayload
    const phone = createKeyPair()
    const socket = await openSocket(`ws://127.0.0.1:${status.port}/ws`)
    cleanups.push(() => socket.close())

    const accepted = waitForFrame(socket, (frame) => frame.type === 'pair.accepted')
    let acceptedSeen = false
    void accepted.then(() => {
      acceptedSeen = true
    })
    const pendingPromise = waitForFrame(socket, (frame) => frame.type === 'pair.pending')
    socket.send(
      JSON.stringify({
        type: 'pair.join',
        lookup: payload.k,
        phoneId: 'approvalphone01',
        name: '待确认手机',
        phonePub: phone.publicBase64,
        platform: 'android',
        protocol: 2,
      }),
    )
    await pendingPromise

    // Nothing is stored and no token was issued while the user has not answered.
    const waiting = server.status()
    expect(waiting.pairingRequest?.name).toBe('待确认手机')
    expect(waiting.pairingRequest?.via).toBe('lan')
    expect(waiting.pairingRequest?.address).toBeTruthy()
    expect(waiting.phones).toHaveLength(0)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(answered).toBe(false)
    expect(acceptedSeen).toBe(false)
    captured.push(waiting.pairingRequest as CompanionPairRequest)

    // Approving later releases the same connection with a token.
    const released = waitForFrame(socket, (frame) => frame.type === 'pair.accepted')
    expect(server.resolvePairing(captured[0]!.requestId, true)).toBe(true)
    const frame = await released
    answered = true
    expect(typeof frame.payload).toBe('object')
    expect(server.status().phones).toHaveLength(1)
    expect(server.status().pairingRequest).toBeNull()
  })

  it('lets a paired phone mint a one-time QR that pairs another phone without desktop approval', async () => {
    const { server, status, pairRequests } = await createServer()
    const { call } = await authenticatePhone(server, status)
    const approvalsBefore = pairRequests.length

    const response = await call('transfer-1', 'pairing.transfer')
    expect(response.ok).toBe(true)
    const transfer = response.data as {
      qrDataUrl?: string
      expiresAt?: string
      mode?: string
    }
    expect(transfer.qrDataUrl).toMatch(/^data:image\/png;base64,/)
    expect(transfer.mode).toBe('lan')
    expect(Date.parse(String(transfer.expiresAt))).toBeGreaterThan(Date.now())

    const publicUrl = await call('transfer-2', 'pairing.transfer')
    expect(publicUrl.ok).toBe(true)
    // The second call replaced the first offer; only the newest QR works.
    const urlPairing = await server.createTransferPairing()
    const payload = JSON.parse(
      Buffer.from(new URL(urlPairing.url).hash.slice(3), 'base64url').toString('utf8'),
    ) as PairPayload
    const secondPhone = createKeyPair()
    const secondSocket = await openSocket(`ws://127.0.0.1:${status.port}/ws`)
    cleanups.push(() => secondSocket.close())
    const acceptedPromise = waitForFrame(secondSocket, (frame) => frame.type === 'pair.accepted')
    secondSocket.send(
      JSON.stringify({
        type: 'pair.join',
        lookup: payload.k,
        phoneId: 'transferphone02',
        name: '另一台手机',
        phonePub: secondPhone.publicBase64,
        platform: 'android',
        protocol: 2,
      }),
    )
    const accepted = await acceptedPromise
    expect(accepted.type).toBe('pair.accepted')
    expect(accepted.protocol).toBe(2)
    // No desktop prompt was raised for the transfer QR.
    expect(pairRequests).toHaveLength(approvalsBefore)
    expect(server.status().phones).toHaveLength(2)

    const reuseSocket = await openSocket(`ws://127.0.0.1:${status.port}/ws`)
    cleanups.push(() => reuseSocket.close())
    const rejected = waitForFrame(reuseSocket, (frame) => frame.type === 'pair.rejected')
    reuseSocket.send(
      JSON.stringify({
        type: 'pair.join',
        lookup: payload.k,
        phoneId: 'transferphone03',
        name: '第三台手机',
        phonePub: createKeyPair().publicBase64,
        platform: 'android',
        protocol: 2,
      }),
    )
    expect(String((await rejected).reason)).toContain('失效')
    expect(server.status().phones).toHaveLength(2)
  })

  it('tells the phone when the desktop rejects the request', async () => {
    const { server, status, pairRequests } = await createServer({ pairApproval: 'reject' })
    const pairing = await server.createPairing()
    const payload = JSON.parse(
      Buffer.from(new URL(pairing.url).hash.slice(3), 'base64url').toString('utf8'),
    ) as PairPayload
    const phone = createKeyPair()
    const socket = await openSocket(`ws://127.0.0.1:${status.port}/ws`)
    cleanups.push(() => socket.close())
    const rejected = waitForFrame(socket, (frame) => frame.type === 'pair.rejected')
    socket.send(
      JSON.stringify({
        type: 'pair.join',
        lookup: payload.k,
        phoneId: 'rejectphone0123',
        name: 'Rejected Phone',
        phonePub: phone.publicBase64,
        platform: 'ios',
        protocol: 2,
      }),
    )
    const frame = await rejected
    expect(frame.reason).toContain('拒绝')
    expect(pairRequests).toHaveLength(1)
    expect(server.status().phones).toHaveLength(0)
    expect(server.status().pairingRequest).toBeNull()
  })

  it('auto-denies the phone when nobody answers in time', async () => {
    const { server, status } = await createServer({
      pairApproval: 'ignore',
      pairApprovalTtlMs: 300,
    })
    const pairing = await server.createPairing()
    const payload = JSON.parse(
      Buffer.from(new URL(pairing.url).hash.slice(3), 'base64url').toString('utf8'),
    ) as PairPayload
    const phone = createKeyPair()
    const socket = await openSocket(`ws://127.0.0.1:${status.port}/ws`)
    cleanups.push(() => socket.close())
    const rejected = waitForFrame(socket, (frame) => frame.type === 'pair.rejected')
    socket.send(
      JSON.stringify({
        type: 'pair.join',
        lookup: payload.k,
        phoneId: 'timeoutphone012',
        name: 'Slow Phone',
        phonePub: phone.publicBase64,
        platform: 'android',
        protocol: 2,
      }),
    )
    const frame = await rejected
    expect(frame.reason).toContain('限定时间')
    expect(server.status().phones).toHaveLength(0)
    expect(server.status().pairingRequest).toBeNull()
    // Answering afterwards is a no-op instead of pairing a gone request.
    expect(server.resolvePairing('missing-request', true)).toBe(false)
  })

  it('refuses a second phone while the first request is still open', async () => {
    const { server, status, pairRequests } = await createServer({
      pairApproval: 'ignore',
      pairApprovalTtlMs: 30_000,
    })
    const pairing = await server.createPairing()
    const payload = JSON.parse(
      Buffer.from(new URL(pairing.url).hash.slice(3), 'base64url').toString('utf8'),
    ) as PairPayload
    const join = async (phoneId: string, name: string) => {
      const phone = createKeyPair()
      const socket = await openSocket(`ws://127.0.0.1:${status.port}/ws`)
      cleanups.push(() => socket.close())
      const first = waitForFrame(
        socket,
        (frame) => frame.type === 'pair.pending' || frame.type === 'pair.rejected',
      )
      socket.send(
        JSON.stringify({
          type: 'pair.join',
          lookup: payload.k,
          phoneId,
          name,
          phonePub: phone.publicBase64,
          platform: 'android',
          protocol: 2,
        }),
      )
      return first
    }
    const firstFrame = await join('queuephone0001', 'First Phone')
    expect(firstFrame.type).toBe('pair.pending')
    const second = await join('queuephone0002', 'Second Phone')
    expect(second.type).toBe('pair.rejected')
    expect(second.reason).toContain('正在确认')
    expect(pairRequests).toHaveLength(1)
    server.resolvePairing(pairRequests[0]!.requestId, false)
  })

  it('pairs a phone, authenticates it, and serves encrypted requests', async () => {
    const { server, status, billingCalls, updateCalls } = await createServer()
    expect(status.running).toBe(true)
    expect(status.port).toBeGreaterThan(0)

    const pairing = await server.createPairing()
    const url = new URL(pairing.url)
    expect(url.hash.startsWith('#p=')).toBe(true)
    const payload = JSON.parse(
      Buffer.from(url.hash.slice(3), 'base64url').toString('utf8'),
    ) as PairPayload
    expect(payload.v).toBe(1)
    expect(payload.d).toBe(status.deviceId)

    const phone = createKeyPair()
    const phoneId = 'testphone012345'
    const relayUrl = `ws://127.0.0.1:${status.port}/ws`
    const pairSocket = await openSocket(relayUrl)
    cleanups.push(() => pairSocket.close())
    const acceptedPromise = waitForFrame(pairSocket, (frame) => frame.type === 'pair.accepted')
    pairSocket.send(
      JSON.stringify({
        type: 'pair.join',
        lookup: payload.k,
        phoneId,
        name: 'Test Phone',
        phonePub: phone.publicBase64,
        platform: 'test',
        protocol: 2,
      }),
    )
    const accepted = await acceptedPromise
    expect(accepted.token).toBeUndefined()
    const keys = derivePairKeys(phone.privateKey, payload.p, payload.s)
    const confirmation = decryptPayload(keys.pcToPhone, accepted.payload)
    expect(confirmation.seq).toBe(1)
    expect(confirmation.value).toMatchObject({
      type: 'pair.accept',
      deviceId: status.deviceId,
      deviceName: 'Test Desktop',
    })
    const token = (confirmation.value as { token?: string }).token
    expect(typeof token).toBe('string')

    const sessionSocket = await openSocket(relayUrl)
    cleanups.push(() => sessionSocket.close())
    const challengePromise = waitForFrame(
      sessionSocket,
      (frame) => frame.type === 'hello.challenge',
    )
    sessionSocket.send(
      JSON.stringify({
        type: 'hello',
        role: 'phone',
        deviceId: status.deviceId,
        phoneId,
        protocol: 2,
      }),
    )
    const challenge = await challengePromise
    expect(typeof challenge.challenge).toBe('string')
    const welcomePromise = waitForFrame(sessionSocket, (frame) => frame.type === 'welcome')
    sessionSocket.send(
      JSON.stringify({
        type: 'hello.proof',
        deviceId: status.deviceId,
        phoneId,
        proof: tokenProof(token as string, challenge.challenge as string),
      }),
    )
    const welcome = await welcomePromise
    expect(welcome.phoneId).toBe(phoneId)
    expect(welcome.protocolVersion).toBe(2)
    // The phone learns every current direct endpoint, so a relay connection can
    // later upgrade to LAN without re-pairing (and picks up DHCP changes).
    expect(Array.isArray(welcome.lan)).toBe(true)
    for (const url of welcome.lan as string[]) {
      expect(url).toMatch(new RegExp(`^ws://\\d+\\.\\d+\\.\\d+\\.\\d+:${status.port}/ws$`))
    }

    const responsePromise = waitForFrame(
      sessionSocket,
      (frame) => frame.type === 'message',
    )
    sessionSocket.send(
      JSON.stringify({
        type: 'message',
        payload: encryptPayload(
          keys.phoneToPc,
          { type: 'request', id: 'req-1', method: 'device.info', params: {} },
          1,
        ),
      }),
    )
    const responseFrame = await responsePromise
    const response = decryptPayload(keys.pcToPhone, responseFrame.payload)
    expect(response.seq).toBe(2)
    expect(response.value).toMatchObject({
      type: 'response',
      id: 'req-1',
      ok: true,
      data: { deviceName: 'Test Desktop', model: 'deepseek-chat' },
    })

    expect(server.status().phones).toHaveLength(1)
    expect(server.status().phones[0]).toMatchObject({
      phoneId,
      name: 'Test Phone',
      online: true,
    })

    // The phone can read the model balance and local cost estimate, and asks
    // the desktop to bypass its cache.
    const billingResponsePromise = waitForFrame(
      sessionSocket,
      (frame) => frame.type === 'message',
    )
    sessionSocket.send(
      JSON.stringify({
        type: 'message',
        payload: encryptPayload(
          keys.phoneToPc,
          { type: 'request', id: 'req-2', method: 'billing.get', params: { refresh: true } },
          2,
        ),
      }),
    )
    const billingResponse = decryptPayload(
      keys.pcToPhone,
      (await billingResponsePromise).payload,
    )
    expect(billingResponse.value).toMatchObject({
      type: 'response',
      id: 'req-2',
      ok: true,
      data: {
        balance: { ok: true, entries: [{ currency: 'CNY', totalBalance: '12.00' }] },
        model: 'deepseek-chat',
      },
    })
    expect(billingCalls).toEqual([true])

    // The phone drives the desktop updater over the same encrypted channel.
    const updateCall = async (
      id: string,
      method: string,
      seq: number,
    ): Promise<Record<string, unknown>> => {
      const promise = waitForFrame(sessionSocket, (frame) => frame.type === 'message')
      sessionSocket.send(
        JSON.stringify({
          type: 'message',
          payload: encryptPayload(
            keys.phoneToPc,
            { type: 'request', id, method, params: {} },
            seq,
          ),
        }),
      )
      return decryptPayload(keys.pcToPhone, (await promise).payload).value as Record<
        string,
        unknown
      >
    }

    const updateState = await updateCall('req-3', 'update.state', 3)
    expect(updateState).toMatchObject({
      type: 'response',
      id: 'req-3',
      ok: true,
      data: { state: { status: 'available', release: { version: '0.1.1' } } },
    })
    const checked = await updateCall('req-4', 'update.check', 4)
    expect(checked).toMatchObject({ ok: true, data: { state: { status: 'available' } } })
    const download = await updateCall('req-5', 'update.download', 5)
    expect(download).toMatchObject({ ok: true, data: { state: { status: 'downloading' } } })
    const installed = await updateCall('req-6', 'update.install', 6)
    expect(installed).toMatchObject({ ok: true, data: { ok: true } })
    expect(updateCalls).toEqual({ check: 1, download: 1, install: 1 })

    await server.revoke(phoneId)
    expect(server.status().phones).toHaveLength(0)
  })

  it('uploads phone files into the workspace in encrypted chunks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pilot-upload-'))
    cleanups.push(async () => {
      await rm(root, { recursive: true, force: true })
    })
    const { server, status } = await createServer({ workspacePath: root })
    const { call } = await authenticatePhone(server, status)

    const bytes = Buffer.from('上传到工作区\n'.repeat(200), 'utf8')
    const begin = await call('upload-1', 'files.upload.begin', {
      workspacePath: root,
      directory: 'uploads',
      name: 'notes.txt',
      size: bytes.length,
    })
    expect(begin).toMatchObject({
      type: 'response',
      id: 'upload-1',
      ok: true,
      data: { path: 'uploads/notes.txt', name: 'notes.txt', size: bytes.length },
    })
    const uploadId = String((begin.data as Record<string, unknown>).uploadId)

    const split = 700
    const first = await call('upload-2', 'files.upload.chunk', {
      uploadId,
      offset: 0,
      data: bytes.subarray(0, split).toString('base64'),
    })
    expect(first).toMatchObject({ ok: true, data: { received: split, size: bytes.length } })
    // A chunk at the wrong offset is rejected instead of corrupting the file.
    const outOfOrder = await call('upload-3', 'files.upload.chunk', {
      uploadId,
      offset: 0,
      data: bytes.subarray(0, 1).toString('base64'),
    })
    expect(outOfOrder).toMatchObject({ ok: false })
    expect(String(outOfOrder.error)).toContain('顺序')
    await call('upload-4', 'files.upload.chunk', {
      uploadId,
      offset: split,
      data: bytes.subarray(split).toString('base64'),
    })
    const finished = await call('upload-5', 'files.upload.finish', { uploadId })
    expect(finished).toMatchObject({
      ok: true,
      data: { path: 'uploads/notes.txt', name: 'notes.txt', size: bytes.length },
    })
    expect(await readFile(join(root, 'uploads', 'notes.txt'))).toEqual(bytes)

    const duplicate = await call('upload-6', 'files.upload.begin', {
      workspacePath: root,
      directory: 'uploads',
      name: 'notes.txt',
      size: 3,
    })
    expect(duplicate).toMatchObject({ ok: true, data: { path: 'uploads/notes (1).txt' } })
    const duplicateId = String((duplicate.data as Record<string, unknown>).uploadId)
    await call('upload-7', 'files.upload.chunk', {
      uploadId: duplicateId,
      offset: 0,
      data: Buffer.from('new').toString('base64'),
    })
    await call('upload-8', 'files.upload.finish', { uploadId: duplicateId })
    expect(await readFile(join(root, 'uploads', 'notes.txt'))).toEqual(bytes)
    expect(await readFile(join(root, 'uploads', 'notes (1).txt'), 'utf8')).toBe('new')

    const escaped = await call('upload-9', 'files.upload.begin', {
      workspacePath: root,
      directory: '../outside',
      name: 'escape.txt',
      size: 1,
    })
    expect(escaped).toMatchObject({ ok: false })
    expect(String(escaped.error)).toContain('跳出工作区')
  })

  it('lets the phone list resources and change model roles', async () => {
    const { server, status, modelUpdates, billingInvalidations } = await createServer()
    const { call } = await authenticatePhone(server, status)

    const listed = await call('models-1', 'models.get')
    expect(listed).toMatchObject({
      type: 'response',
      id: 'models-1',
      ok: true,
      data: {
        sessionModelId: 'primary',
        evaluationModelIds: [],
        resources: [
          { id: 'primary', model: 'deepseek-chat', hasKey: true },
          { id: 'judge-qwen', model: 'qwen-plus', hasKey: true },
        ],
      },
    })
    expect(JSON.stringify(listed)).not.toContain('sk-')

    const updated = await call('models-2', 'models.update', {
      sessionModelId: 'primary',
      evaluationModelIds: ['judge-qwen'],
    })
    expect(updated).toMatchObject({
      type: 'response',
      id: 'models-2',
      ok: true,
      data: { evaluationModelIds: ['judge-qwen'] },
    })
    expect(modelUpdates).toEqual([
      { sessionModelId: 'primary', evaluationModelIds: ['judge-qwen'] },
    ])
    expect(billingInvalidations()).toBe(1)

    const invalid = await call('models-3', 'models.update', {
      evaluationModelIds: 'qwen',
    })
    expect(invalid).toMatchObject({
      type: 'response',
      id: 'models-3',
      ok: false,
      error: '评估模型格式不正确',
    })
    expect(modelUpdates).toHaveLength(1)
  })

  it('lets the phone pin and clear a per-task session model', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'pilot-session-model-'))
    cleanups.push(() => rm(workspacePath, { recursive: true, force: true }))
    const { server, status, sessionModelUpdates } = await createServer({ workspacePath })
    const { call } = await authenticatePhone(server, status)

    const assigned = await call('task-model-1', 'sessions.model', {
      sessionId: 'session-1',
      modelId: 'judge-qwen',
    })
    expect(assigned).toMatchObject({
      ok: true,
      data: { id: 'session-1', sessionModelId: 'judge-qwen' },
    })
    expect(sessionModelUpdates).toEqual([{ sessionId: 'session-1', modelId: 'judge-qwen' }])

    // 空字符串是合法值：清除任务覆盖，回到项目/全局。
    const cleared = await call('task-model-2', 'sessions.model', {
      sessionId: 'session-1',
      modelId: '',
    })
    expect(cleared).toMatchObject({ ok: true, data: { sessionModelId: '' } })

    const unknownModel = await call('task-model-3', 'sessions.model', {
      sessionId: 'session-1',
      modelId: 'missing',
    })
    expect(unknownModel).toMatchObject({ ok: false, error: '指定的模型不存在' })

    // 缺参不能当成“清除”，否则会悄悄改回继承模型。
    const missingModel = await call('task-model-4', 'sessions.model', { sessionId: 'session-1' })
    expect(missingModel).toMatchObject({ ok: false, error: '模型参数格式不正确' })
  })

  it('lets the phone read and update autonomous learning for a workspace', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'pilot-learning-phone-'))
    cleanups.push(() => rm(workspacePath, { recursive: true, force: true }))
    await mkdir(join(workspacePath, '.pilot', 'learning'), { recursive: true })
    await writeFile(
      join(workspacePath, '.pilot', 'learning', 'ledger.jsonl'),
      [
        {
          at: '2026-11-16T00:00:00.000Z',
          kind: 'source',
          id: 'source-1',
          url: 'https://nodejs.org/api/fs.html',
          host: 'nodejs.org',
          path: '.pilot/learning/sources/node.txt',
          bytes: 120,
        },
        {
          at: '2026-11-16T00:01:00.000Z',
          kind: 'task',
          id: 'task-1',
          title: 'Read the fs docs',
          goal: 'Prepare a verified note',
          sourceId: 'source-1',
        },
        {
          at: '2026-11-16T00:02:00.000Z',
          kind: 'outcome',
          id: 'outcome-1',
          taskId: 'task-1',
          verdict: 'pending',
          quality: 0.8,
          note: 'Waiting for the user to approve the note.',
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n') + '\n',
    )
    const { server, status, modelUpdates } = await createServer({ workspacePath })
    const { call } = await authenticatePhone(server, status)

    const state = await call('learning-1', 'learning.state', { workspacePath })
    expect(state).toMatchObject({
      type: 'response',
      id: 'learning-1',
      ok: true,
      data: {
        state: {
          enabled: false,
          hosts: [],
          ledger: '.pilot/learning/ledger.jsonl',
          entryTotal: 3,
          summary: {
            sources: 1,
            tasks: 1,
            outcomes: 1,
            pending: 1,
            openTasks: 1,
            averageQuality: 0.8,
          },
        },
      },
    })
    const phoneState = (state.data as {
      state: {
        defaultHosts: string[]
        effectiveHosts: string[]
        entries: Array<{ kind: string; verdict?: string }>
      }
    }).state
    expect(phoneState.defaultHosts).toContain('developer.mozilla.org')
    expect(phoneState.effectiveHosts).toEqual(phoneState.defaultHosts)
    expect(phoneState.entries.map((entry) => entry.kind)).toEqual([
      'outcome',
      'task',
      'source',
    ])
    expect(phoneState.entries[0]?.verdict).toBe('pending')

    const saved = await call('learning-2', 'learning.settings', {
      workspacePath,
      settings: {
        enabled: true,
        hosts: [' HTTPS://Docs.Example.COM/path ', 'nodejs.org', 'nodejs.org', ''],
      },
    })
    expect(saved).toMatchObject({
      type: 'response',
      id: 'learning-2',
      ok: true,
      data: {
        state: {
          enabled: true,
          hosts: ['docs.example.com', 'nodejs.org'],
          effectiveHosts: ['docs.example.com', 'nodejs.org'],
        },
      },
    })
    expect(modelUpdates).toContainEqual({
      learningMode: true,
      learningHosts: ['docs.example.com', 'nodejs.org'],
    })

    const invalid = await call('learning-3', 'learning.settings', {
      workspacePath,
      settings: { hosts: ['not a host'] },
    })
    expect(invalid).toMatchObject({ type: 'response', id: 'learning-3', ok: false })
    expect(String(invalid.error)).toContain('无效主机')

    // 本机/内网地址永远过不了出域守门，也不能写进白名单。
    const local = await call('learning-4', 'learning.settings', {
      workspacePath,
      settings: { hosts: ['127.0.0.1'] },
    })
    expect(local).toMatchObject({ type: 'response', id: 'learning-4', ok: false })
    expect(String(local.error)).toContain('本机或内网地址')

    const closed = await call('learning-5', 'learning.state', {
      workspacePath: `${workspacePath}-other`,
    })
    expect(closed).toMatchObject({ type: 'response', id: 'learning-5', ok: false })
    expect(String(closed.error)).toContain('工作区未打开')
  })

  it('flags cloud-paired phones when the relay address is missing', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'pilot-companion-state-'))
    cleanups.push(() => rm(dataDir, { recursive: true, force: true }))
    await writeFile(
      join(dataDir, 'companion.json'),
      JSON.stringify({
        version: 1,
        enabled: false,
        deviceId: '85677b4d-50d8-4383-bbe9-dd1c9b01f364',
        port: 47831,
        phones: {
          phone00000001: {
            phoneId: 'phone00000001',
            name: 'Cloud Phone',
            platform: 'android',
            tokenHash: 'a'.repeat(64),
            pcToPhone: 'pcToPhone',
            phoneToPc: 'phoneToPc',
            outSeq: 1,
            inSeq: 0,
            pairedAt: '2026-11-12T00:44:06.494Z',
            lastSeen: null,
            relayRoom: 'LeK-RS5TIXV3XZTEh6i9Wtux5n2T_D2R',
            relayKey: 'vy3F_IM-ZvlPLoiZpjIRt0mLe7byNlUe',
            relayUrl: 'wss://pilot.medpilot.cc/connector',
          },
        },
      }),
    )
    const store = {
      settingsView: () => ({ model: 'deepseek-chat', theme: 'dark', relayUrl: '' }),
      workspaces: () => [],
      sessions: () => [],
      activeWorkspace: () => '',
    } as unknown as Store
    const server = new CompanionServer({
      store,
      runner: {} as never,
      dataDir,
      assetsDir: fileURLToPath(new URL('../companion', import.meta.url)),
      deviceName: 'Test Desktop',
      appVersion: '0.1.0-test',
      billing: { report: () => Promise.reject(new Error('billing is not stubbed in this test')) },
      relayUrl: '',
      appUrl: '',
      onStatus: () => undefined,
    })
    cleanups.push(() => server.stop())
    await server.init()
    const status = server.status()
    expect(status.relayUrl).toBeNull()
    expect(status.cloudPhones).toBe(1)
    expect(status.lastRelayUrl).toBe('wss://pilot.medpilot.cc/connector')
  })

  it('rejects a stale pairing code', async () => {
    const { server, status } = await createServer()
    const pairing = await server.createPairing()
    const payload = JSON.parse(
      Buffer.from(new URL(pairing.url).hash.slice(3), 'base64url').toString('utf8'),
    ) as PairPayload

    const phone = createKeyPair()
    const socket = await openSocket(`ws://127.0.0.1:${status.port}/ws`)
    cleanups.push(() => socket.close())
    const rejected = waitForFrame(
      socket,
      (frame) => frame.type === 'pair.rejected' || frame.type === 'error',
    )
    socket.send(
      JSON.stringify({
        type: 'pair.join',
        lookup: `${payload.k.slice(0, -1)}x`,
        phoneId: 'testphone012345',
        name: 'Test Phone',
        phonePub: phone.publicBase64,
        platform: 'test',
      }),
    )
    const frame = await rejected
    expect(frame.type).toBe('pair.rejected')
  })

  it('blocks installing a desktop update while a run is active', async () => {
    const { server, status, updateCalls } = await createServer({ activeRuns: 1 })
    const { call } = await authenticatePhone(server, status)
    const installed = await call('req-1', 'update.install')
    expect(installed).toMatchObject({ type: 'response', id: 'req-1', ok: false })
    expect(String(installed.error)).toContain('任务正在执行')
    expect(updateCalls.install).toBe(0)
  })

  it('reports an unsupported update channel on builds without an updater', async () => {
    const { server, status } = await createServer({ withoutUpdate: true })
    const { call } = await authenticatePhone(server, status)
    const state = await call('req-1', 'update.state')
    expect(state).toMatchObject({ type: 'response', id: 'req-1', ok: false })
    expect(String(state.error)).toContain('不支持手机控制更新')
  })

  it('routes the maintenance methods the console needs', async () => {
    const { server, status, retriedSessions } = await createServer()
    const { call } = await authenticatePhone(server, status)

    const retried = await call('req-1', 'run.retry', { sessionId: 'session-1' })
    expect(retried).toMatchObject({ type: 'response', id: 'req-1', ok: true })
    expect(retriedSessions).toEqual(['session-1'])

    // The fake store has no sessions, so deleting one must fail loudly instead
    // of silently reporting success.
    const deleted = await call('req-2', 'sessions.delete', { sessionId: 'missing' })
    expect(deleted).toMatchObject({ type: 'response', id: 'req-2', ok: false })
    expect(String(deleted.error)).toContain('会话不存在')

    // The last workspace cannot be removed: the console would have nowhere to
    // create sessions afterwards.
    const workspacePath = process.cwd()
    const working = await createServer({ workspacePath })
    const phone = await authenticatePhone(working.server, working.status)
    const refused = await phone.call('req-3', 'workspaces.remove', { workspacePath })
    expect(refused).toMatchObject({ type: 'response', id: 'req-3', ok: false })
    expect(String(refused.error)).toContain('至少要保留一个工作区')
  })

  it('answers sandbox.status, system.info and tools.list from the host', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'pilot-ws-'))
    const { server, status } = await createServer({ workspacePath })
    const { call } = await authenticatePhone(server, status)

    const listed = await call('req-1', 'tools.list', { workspacePath })
    expect(listed).toMatchObject({ type: 'response', id: 'req-1', ok: true })
    expect((listed.data as { tools: unknown[] }).tools).toEqual([])

    // A path the host does not know about must be refused, not listed.
    const denied = await call('req-2', 'tools.list', { workspacePath: tmpdir() })
    expect(denied).toMatchObject({ type: 'response', id: 'req-2', ok: false })

    const sandbox = await call('req-3', 'sandbox.status')
    expect(sandbox).toMatchObject({ type: 'response', id: 'req-3', ok: true })
    expect((sandbox.data as { status: { backend: string } }).status.backend).toBeTruthy()

    // 运行环境只读：手机拿不到任意路径的磁盘读数，电脑端只测当前工作区。
    const env = await call('req-4', 'system.info')
    expect(env).toMatchObject({ type: 'response', id: 'req-4', ok: true })
    const info = (env.data as { info: { cpuCount: number; node: string; disk: unknown } }).info
    expect(info.cpuCount).toBeGreaterThan(0)
    expect(info.node).toBeTruthy()
    expect(info.disk).toBeTruthy()
    expect((env.data as { info: Record<string, unknown> }).info['hostname']).toBeUndefined()
  })

  it('routes checkpoints, changes, memory, quick commands and message edits', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'pilot-features-'))
    cleanups.push(() => rm(workspacePath, { recursive: true, force: true }))
    const { server, status } = await createServer({ workspacePath, featureStubs: true })
    const { call } = await authenticatePhone(server, status)

    const checkpoints = await call('req-1', 'checkpoints.list', { sessionId: 'session-1' })
    expect(checkpoints).toMatchObject({ type: 'response', id: 'req-1', ok: true })
    expect((checkpoints.data as { checkpoints: unknown[] }).checkpoints).toEqual([])

    const created = await call('req-2', 'checkpoints.create', {
      sessionId: 'session-1',
      label: '手动',
    })
    expect(created).toMatchObject({ type: 'response', id: 'req-2', ok: true })
    expect((created.data as { checkpoint: { id: string } }).checkpoint.id).toBe('checkpoint-1')

    const restored = await call('req-3', 'checkpoints.restore', {
      sessionId: 'session-1',
      checkpointId: 'checkpoint-1',
      mode: 'both',
    })
    expect(restored).toMatchObject({ type: 'response', id: 'req-3', ok: true })
    expect((restored.data as { result: { restoredFiles: number } }).result.restoredFiles).toBe(1)

    const changes = await call('req-4', 'changes.list', { sessionId: 'session-1' })
    expect(changes).toMatchObject({ type: 'response', id: 'req-4', ok: true })

    const reverted = await call('req-5', 'changes.revert', {
      sessionId: 'session-1',
      path: 'src/app.ts',
    })
    expect(reverted).toMatchObject({ type: 'response', id: 'req-5', ok: true })
    expect((reverted.data as { result: { path: string } }).result.path).toBe('src/app.ts')

    const memory = await call('req-6', 'memory.list', { workspacePath })
    expect(memory).toMatchObject({ type: 'response', id: 'req-6', ok: true })
    expect((memory.data as { memory: unknown[] }).memory).toEqual([])

    const added = await call('req-7', 'memory.add', {
      workspacePath,
      content: '这个项目用 pnpm',
    })
    expect(added).toMatchObject({ type: 'response', id: 'req-7', ok: true })
    expect((added.data as { entry: { content: string } }).entry.content).toBe('这个项目用 pnpm')

    const removed = await call('req-8', 'memory.remove', {
      workspacePath,
      memoryId: 'memory-1',
    })
    expect(removed).toMatchObject({ type: 'response', id: 'req-8', ok: true })

    const quick = await call('req-9', 'quickCommands.get')
    expect(quick).toMatchObject({ type: 'response', id: 'req-9', ok: true })
    expect((quick.data as { commands: unknown }).commands).toBeNull()

    const saved = await call('req-10', 'quickCommands.save', {
      commands: [{ content: '先跑测试' }, { id: 'keep', content: '再写代码' }],
    })
    expect(saved).toMatchObject({ type: 'response', id: 'req-10', ok: true })
    expect((saved.data as { commands: Array<{ content: string }> }).commands.map((item) => item.content))
      .toEqual(['先跑测试', '再写代码'])

    const edited = await call('req-11', 'chat.edit', {
      sessionId: 'session-1',
      messageId: 'message-1',
      content: '改成这样',
    })
    expect(edited).toMatchObject({ type: 'response', id: 'req-11', ok: true })

    const regenerated = await call('req-12', 'chat.regenerate', { sessionId: 'session-1' })
    expect(regenerated).toMatchObject({ type: 'response', id: 'req-12', ok: true })

    const deleted = await call('req-13', 'chat.deleteMessage', {
      sessionId: 'session-1',
      messageId: 'message-1',
    })
    expect(deleted).toMatchObject({ type: 'response', id: 'req-13', ok: true })
  })

  it('routes module self-check and trims the phone report', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'pilot-module-check-'))
    cleanups.push(() => rm(workspacePath, { recursive: true, force: true }))
    const { server, status, moduleAccepted, selfCheckCalls } = await createServer({
      workspacePath,
      featureStubs: true,
    })
    const { call } = await authenticatePhone(server, status)

    const state = await call('req-1', 'moduleCheck.state')
    expect(state).toMatchObject({ type: 'response', id: 'req-1', ok: true })
    const phoneState = (state.data as {
      state: {
        lastReport: { risks: unknown[]; riskTotal: number; riskCounts: Record<string, number> }
        historyCount: number
        decisions: unknown[]
        proposals: Array<{
          id: string
          prompt: string
          promptTruncated: boolean
          selfModify: boolean
          sessionId?: string
        }>
        settings: { enabled: boolean; intervalHours: number }
      }
    }).state
    // A full 60-module report does not fit the encrypted relay envelope, so the
    // phone gets the highest-ranked slice plus totals for the rest.
    expect(phoneState.lastReport.risks).toHaveLength(160)
    expect(phoneState.lastReport.riskTotal).toBe(170)
    expect(phoneState.lastReport.riskCounts).toEqual({ high: 57, medium: 57, low: 56 })
    // History bodies are not sent; only the count is.
    expect(phoneState.historyCount).toBe(3)
    expect(phoneState.decisions).toHaveLength(5)
    // 提案要能预览，但状态帧不能被整段指令撑大：截断到 1500 字并打标记。
    expect(phoneState.proposals).toHaveLength(1)
    expect(phoneState.proposals[0]).toMatchObject({
      id: 'mp_1',
      selfModify: false,
      promptTruncated: true,
    })
    expect(phoneState.proposals[0]?.prompt).toHaveLength(1_501)
    expect(phoneState.proposals[0]).not.toHaveProperty('sessionId')
    expect(phoneState.settings.enabled).toBe(false)

    const discovered = await call('req-2', 'moduleCheck.discover')
    expect(discovered).toMatchObject({ type: 'response', id: 'req-2', ok: true })
    // 自检已只扫内置源码：source 是新字段，workspace 仅供旧手机端兼容。
    expect((discovered.data as { source: string }).source).toBe('E:/demo')
    expect((discovered.data as { workspace: string }).workspace).toBe('E:/demo')
    expect((discovered.data as { modules: Array<{ id: string }> }).modules.map((item) => item.id))
      .toEqual(['app'])

    const run = await call('req-3', 'moduleCheck.run', {
      moduleIds: [' app ', 'app', 42, ''],
    })
    expect(run).toMatchObject({ type: 'response', id: 'req-3', ok: true })
    const report = (run.data as {
      report: { risks: unknown[]; riskTotal: number; riskCounts: Record<string, number> }
    }).report
    expect(report.risks).toHaveLength(160)
    expect(report.riskTotal).toBe(170)
    expect(report.riskCounts.high).toBe(57)
    // Capping must not drop the high risks that happen to sit in later modules.
    const capped = report.risks as Array<{ id: string; severity: string }>
    expect(capped.slice(0, 57).every((risk) => risk.severity === 'high')).toBe(true)
    expect(capped[114]?.severity).toBe('low')
    expect(capped.some((risk) => risk.id === 'risk-168')).toBe(true)
    expect(capped.some((risk) => risk.id === 'risk-167')).toBe(false)

    const saved = await call('req-4', 'moduleCheck.settings', {
      settings: { enabled: true, intervalHours: 99999, modules: [' app ', ''] },
    })
    expect(saved).toMatchObject({ type: 'response', id: 'req-4', ok: true })
    const savedSettings = (saved.data as {
      state: { settings: { enabled: boolean; intervalHours: number; modules: string[] } }
    }).state.settings
    expect(savedSettings).toMatchObject({ enabled: true, intervalHours: 720, modules: ['app'] })

    const accepted = await call('req-5', 'moduleCheck.accept', {
      reportId: 'report-1',
      riskIds: ['risk-1', 'risk-2'],
    })
    expect(accepted).toMatchObject({ type: 'response', id: 'req-5', ok: true })
    // 手机没显式传 selfModify：只落提案，不建会话、不改源码。
    expect(accepted.data).toMatchObject({ queued: false, selfModify: false, proposalId: 'mp_1' })
    expect(accepted.data).not.toHaveProperty('sessionId')
    expect(moduleAccepted).toEqual([
      { reportId: 'report-1', riskIds: ['risk-1', 'risk-2'], selfModify: false },
    ])

    const selfModified = await call('req-5b', 'moduleCheck.accept', {
      reportId: 'report-1',
      riskIds: ['risk-1'],
      selfModify: true,
    })
    expect(selfModified).toMatchObject({ type: 'response', id: 'req-5b', ok: true })
    expect(selfModified.data).toMatchObject({ sessionId: 'module-session-1', selfModify: true })

    const empty = await call('req-6', 'moduleCheck.accept', {
      reportId: 'report-1',
      riskIds: [],
    })
    expect(empty).toMatchObject({ type: 'response', id: 'req-6', ok: false })
    expect(String(empty.error)).toContain('请先勾选要优化的风险点')
    expect(moduleAccepted).toHaveLength(2)

    // 内视：只读、无参数；手机只拿到报告。
    const inspected = await call('req-7', 'selfCheck.run', { workspacePath: 'E:/other' })
    expect(inspected).toMatchObject({ type: 'response', id: 'req-7', ok: true })
    expect((inspected.data as { report: { items: unknown[] } }).report.items).toHaveLength(1)
    expect(selfCheckCalls()).toBe(1)
  })

  it('reports optional phone services that this desktop build lacks', async () => {
    const { server, status } = await createServer()
    const { call } = await authenticatePhone(server, status)

    const checkpoints = await call('req-1', 'checkpoints.list', { sessionId: 'session-1' })
    expect(checkpoints).toMatchObject({ type: 'response', id: 'req-1', ok: false })
    expect(String(checkpoints.error)).toContain('不支持手机查看回退点')

    const changes = await call('req-2', 'changes.list', { sessionId: 'session-1' })
    expect(changes).toMatchObject({ type: 'response', id: 'req-2', ok: false })
    expect(String(changes.error)).toContain('不支持手机查看变更')

    const moduleCheck = await call('req-3', 'moduleCheck.state')
    expect(moduleCheck).toMatchObject({ type: 'response', id: 'req-3', ok: false })
    expect(String(moduleCheck.error)).toContain('不支持手机模块自检')
  })

  it('tells the panel what the host can do, defaulting to the desktop set', async () => {
    const { server, status } = await createServer()
    const { call } = await authenticatePhone(server, status)

    const info = await call('req-1', 'device.info', {})
    expect(info).toMatchObject({ type: 'response', id: 'req-1', ok: true })
    expect((info as { data: { capabilities: unknown } }).data.capabilities).toEqual({
      screenshot: true,
      update: 'in-app',
      evolution: true,
      personal: true,
      window: true,
    })
  })

  it('declares what a headless host can do to the panel', async () => {
    const { server, status } = await createServer({ capabilities: SERVER_CAPABILITIES })
    const { call } = await authenticatePhone(server, status)

    const info = await call('req-1', 'device.info', {})
    expect((info as { data: { capabilities: unknown } }).data.capabilities).toEqual({
      screenshot: false,
      // Files are replaced and the service restarted, not installed in place.
      update: 'files',
      evolution: true,
      personal: false,
      window: false,
    })
  })
})

describe('CompanionServer panel surface', () => {
  async function fetchPanel(
    port: number | null,
    path: string,
  ): Promise<{ status: number; type: string; body: string }> {
    const response = await fetch(`http://127.0.0.1:${port}${path}`)
    return {
      status: response.status,
      type: response.headers.get('content-type') ?? '',
      body: await response.text(),
    }
  }

  it('paints the console like the desktop client in server mode', async () => {
    const { server, status } = await createServer({ surface: 'desktop' })
    const page = await fetchPanel(status.port, '/')
    expect(page.status).toBe(200)
    // The attribute scopes every desktop rule, the link loads them.
    expect(page.body).toContain('data-surface="desktop"')
    expect(page.body).toContain('href="./desktop.css"')
    expect(page.body).toContain('<meta name="theme-color" content="#000000" />')

    const css = await fetchPanel(status.port, '/desktop.css')
    expect(css.status).toBe(200)
    expect(css.type).toContain('text/css')
    expect(css.body).toContain("html[data-surface='desktop']")
    expect(css.body).toContain('--panel-3: #2f2f2f')

    // The phone stylesheet stays served and untouched for the PWA build.
    const base = await fetchPanel(status.port, '/style.css')
    expect(base.status).toBe(200)
    expect(base.body).not.toContain('data-surface')
  })

  it('keeps the phone PWA panel unchanged when surface is not set', async () => {
    const { status } = await createServer()
    const page = await fetchPanel(status.port, '/')
    expect(page.status).toBe(200)
    expect(page.body).not.toContain('data-surface')
    expect(page.body).not.toContain('desktop.css')
    expect(page.body).toContain('theme-color" content="#080c11"')
  })
})

describe('CompanionServer plugin surface', () => {
  it('serves /api/plugins from the workspace and gates protected routes', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'pilot-plugin-ws-'))
    const pluginDir = join(workspace, '.pilot', 'plugins', 'pilot-auth')
    await mkdir(pluginDir, { recursive: true })
    const example = fileURLToPath(new URL('../../examples/plugins/pilot-auth/', import.meta.url))
    for (const file of ['plugin.json', 'index.mjs']) {
      await writeFile(join(pluginDir, file), await readFile(join(example, file), 'utf8'))
    }
    await writeFile(
      join(workspace, '.pilot', 'plugins', 'grants.json'),
      JSON.stringify({ 'pilot-auth': { enabled: true, permissions: ['users:read', 'users:write'] } }),
    )
    const { server, status } = await createServer({ workspacePath: workspace, pluginRoot: workspace })
    const base = `http://127.0.0.1:${status.port}`

    const discovery = await fetch(`${base}/api/plugins`)
    expect(discovery.status).toBe(200)
    expect(((await discovery.json()) as { providers: string[] }).providers).toEqual(['pilot-auth'])

    // A public route is reachable without a session.
    const registered = await fetch(`${base}/api/plugins/pilot-auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'panel@example.com', password: 'correct-horse' }),
    })
    expect(registered.status).toBe(201)

    // A protected route without a token is rejected by the host, not the plugin.
    const anonymous = await fetch(`${base}/api/plugins/pilot-auth/users`)
    expect(anonymous.status).toBe(401)

    // Static panel routes still work and keep their GET-only contract.
    const page = await fetch(`${base}/healthz`)
    expect(page.status).toBe(200)
    const rejected = await fetch(`${base}/healthz`, { method: 'POST' })
    expect(rejected.status).toBe(405)

    await server.stop()
    await rm(workspace, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }, 30_000)

  it('answers 503 for plugin routes when no workspace is open', async () => {
    const { server, status } = await createServer()
    const response = await fetch(`http://127.0.0.1:${status.port}/api/plugins`)
    expect(response.status).toBe(503)
    expect((await response.json()) as { error: string }).toMatchObject({ error: 'unavailable' })
    await server.stop()
  })
})
