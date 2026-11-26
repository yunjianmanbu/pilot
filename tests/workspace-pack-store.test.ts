import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * 跨客户端导入：一个 Store 导出，另一个空 Store 导入。
 *
 * 这里 mock 的 safeStorage 是**可用的**（真实 AES-256-GCM，密钥只在本进程里），
 * 所以能证明两件事：导出端把密钥解成明文写进包，导入端又把它重新加密入盘——
 * 磁盘上的 store 文件里读不到任何明文密钥。
 */

const SECRETS_KEY = randomBytes(32)

function encrypt(value: string): Buffer {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', SECRETS_KEY, iv)
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body])
}

function decrypt(buffer: Buffer): string {
  const iv = buffer.subarray(0, 12)
  const tag = buffer.subarray(12, 28)
  const body = buffer.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', SECRETS_KEY, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
}

vi.mock('electron', () => ({
  app: {
    getPath: () => process.env['PILOT_TEST_USER_DATA'] ?? tmpdir(),
    getLocale: () => 'zh-CN',
    getVersion: () => '1.2.6',
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => encrypt(value),
    decryptString: (buffer: Buffer) => decrypt(buffer),
  },
}))

import { Store } from '../src/main/store'
import { readWorkspacePack, writeWorkspacePack } from '../src/main/workspace-pack'
import { CORE_FILE } from '../src/main/session-store'
import { readFile as readFileRaw } from 'node:fs/promises'
import {
  DEFAULT_PACK_SCOPE,
  PACK_SECRETS_FILE,
  normalizePackScope,
} from '../src/shared/workspace-pack'
import JSZip from 'jszip'

const API_KEY = 'demo-key-000123'
const SMTP_PASSWORD = 'smtp-plain-password-456'
const TEST_CAPTCHA = '112233'

const cleanups: string[] = []

afterEach(async () => {
  while (cleanups.length) {
    const dir = cleanups.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

interface Fixture {
  store: Store
  root: string
  userData: string
  workspacePath: string
}

async function setup(label: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), `pilot-pack-store-${label}-`))
  cleanups.push(root)
  const userData = join(root, 'user-data')
  const workspacePath = join(root, 'workspace')
  await mkdir(workspacePath, { recursive: true })
  // 包里 workspace/ 的文件来自源工作区，所以得先真放一个文件进去。
  await mkdir(join(workspacePath, 'docs'), { recursive: true })
  await writeFile(join(workspacePath, 'docs', 'notes.md'), '# 交付说明\n跨机器可见。\n', 'utf8')
  process.env['PILOT_TEST_USER_DATA'] = userData
  const store = new Store(userData)
  await store.load()
  await store.addWorkspace(workspacePath)
  return { store, root, userData, workspacePath }
}

function message(id: string, content: string) {
  return { id, role: 'user' as const, content, createdAt: '2026-01-01T00:00:00.000Z' }
}

/** 在来源端配置一套「完整」的本机状态：一个模型资源（带密钥）+ 测试验证码 + SMTP 授权码。 */
async function seedSource(fixture: Fixture): Promise<string> {
  const { store, workspacePath } = fixture
  await store.updateSettings({
    modelResources: [
      {
        id: 'resource-primary',
        label: '主通道',
        baseUrl: 'https://api.example.com/v1',
        model: 'example-model',
        tag: '主',
        enabled: true,
        apiKey: API_KEY,
      },
    ],
    sessionModelId: 'resource-primary',
    testCaptcha: TEST_CAPTCHA,
    reflectEmailTo: 'demo@example.com',
    reflectSmtpHost: 'smtp.example.com',
    reflectSmtpPort: 465,
    reflectSmtpSecurity: 'tls',
    reflectSmtpPassword: SMTP_PASSWORD,
  })
  const session = await store.createSession(workspacePath)
  await store.addMessage(session.id, message('message-1', '第一句'))
  await store.addMessage(session.id, message('message-2', '第二句'))
  await store.flush()
  return session.id
}

async function exportFrom(fixture: Fixture, scope = DEFAULT_PACK_SCOPE): Promise<string> {
  const target = join(fixture.root, 'workspace.pilotpack.zip')
  await writeWorkspacePack({
    snapshot: fixture.store.workspacePackSnapshot(fixture.workspacePath, scope),
    scope,
    manifest: {
      createdAt: '2026-01-02T03:04:05.000Z',
      appVersion: '1.2.6',
      platform: 'win32',
      workspace: { name: 'source', path: fixture.workspacePath },
      origin: 'source-host',
    },
    workspacePath: fixture.workspacePath,
    checkpointRoot: join(fixture.userData, 'checkpoints'),
    target,
  })
  return target
}

describe('workspace pack across two clients', () => {
  it('carries the plaintext key in the zip and restores it encrypted on the other side', async () => {
    const source = await setup('source')
    const sessionId = await seedSource(source)
    const pack = await exportFrom(source)

    // 第一层：包内就是明文，任何拿到 zip 的人都读得到（这是产品选择，界面必须二次确认）。
    const zip = await JSZip.loadAsync(await readFile(pack))
    const rawSecrets = await zip.file(PACK_SECRETS_FILE)!.async('string')
    expect(rawSecrets).toContain(API_KEY)
    expect(rawSecrets).toContain(SMTP_PASSWORD)
    expect(rawSecrets).toContain(TEST_CAPTCHA)

    // 第二层：另一台机器的空 store 导入后，设置与密钥全部可用。
    const target = await setup('target')
    expect(target.store.settingsView().hasKey).toBe(false)
    const written: string[] = []
    const read = await readWorkspacePack(pack, {
      writeWorkspaceFile: async (relative, data) => {
        const file = join(target.workspacePath, ...relative.split('/'))
        await mkdir(join(file, '..'), { recursive: true })
        await writeFile(file, data)
        written.push(relative)
      },
    })
    // 工作区文件真的落到目标目录（这是「另一台机器能直接开工」的前提）。
    expect(written).toContain('docs/notes.md')
    expect(await readFileRaw(join(target.workspacePath, 'docs', 'notes.md'), 'utf8')).toContain(
      '跨机器可见',
    )
    const applied = await target.store.applyWorkspacePack({
      manifest: read.manifest,
      core: read.core,
      sessions: read.sessions,
      secrets: read.secrets,
      workspacePath: target.workspacePath,
      workspaceName: 'target',
    })
    expect(applied.secretsApplied).toBeGreaterThanOrEqual(3)
    expect(applied.settingsApplied).toBe(true)
    expect(applied.sessions).toBe(1)

    const view = target.store.settingsView()
    expect(view.hasKey).toBe(true)
    expect(view.keyHint).toBe('••••0123')
    expect(view.hasTestCaptcha).toBe(true)
    expect(view.hasSmtpPassword).toBe(true)
    expect(view.reflectEmailTo).toBe('demo@example.com')
    expect(view.reflectSmtpHost).toBe('smtp.example.com')

    // 明文只活在包里：导入端的磁盘文件重新加密过，读不到任何原文。
    const core = await readFile(join(target.userData, CORE_FILE), 'utf8')
    expect(core).not.toContain(API_KEY)
    expect(core).not.toContain(SMTP_PASSWORD)
    expect(core).not.toContain(TEST_CAPTCHA)
    const reopened = new Store(target.userData)
    await reopened.load()
    expect(reopened.getApiKey()).toBe(API_KEY)
    expect(reopened.getSmtpPassword()).toBe(SMTP_PASSWORD)
    expect(reopened.getTestCaptcha()).toBe(TEST_CAPTCHA)

    // 会话连同消息一起搬过来。
    const sessions = target.store.sessions(target.workspacePath)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.messageCount).toBe(2)
    // 会话 id 保持不变（同 id 才会走「跳过已存在」而不是每次导入都翻倍）。
    expect(sessions[0]?.id).toBe(sessionId)
  })

  it('leaves the target without secrets when the pack was exported without them', async () => {
    const source = await setup('source-nosecret')
    await seedSource(source)
    const scope = normalizePackScope({ ...DEFAULT_PACK_SCOPE, secrets: false })
    const pack = await exportFrom(source, scope)
    expect(await JSZip.loadAsync(await readFile(pack)).then((z) => z.file(PACK_SECRETS_FILE))).toBeNull()

    const target = await setup('target-nosecret')
    const read = await readWorkspacePack(pack, { writeWorkspaceFile: async () => {} })
    expect(read.secrets).toBeNull()
    const applied = await target.store.applyWorkspacePack({
      manifest: read.manifest,
      core: read.core,
      sessions: read.sessions,
      secrets: read.secrets,
      workspacePath: target.workspacePath,
      workspaceName: 'target',
    })
    expect(applied.secretsApplied).toBe(0)
    const view = target.store.settingsView()
    expect(view.hasKey).toBe(false)
    expect(view.hasTestCaptcha).toBe(false)
    expect(view.hasSmtpPassword).toBe(false)
  })
})
