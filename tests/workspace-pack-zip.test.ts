import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  PACK_CHECKPOINTS_DIR,
  PACK_CORE_FILE,
  PACK_FILES_DIR,
  PACK_SECRETS_FILE,
  normalizePackScope,
  type WorkspaceSecrets,
} from '../src/shared/workspace-pack'
import {
  readWorkspacePack,
  writeWorkspacePack,
  type WorkspacePackSnapshot,
} from '../src/main/workspace-pack'

/**
 * 端到端往返：真的写出一个 .zip，再用读包那一侧读回来。
 *
 * 这一层不用 mock，所以能证明「密钥在包里是明文、读回仍是原文」——
 * safeStorage 的重新加密在 store 里，不在这个文件里。
 */

let root = ''
let workspacePath = ''
let checkpointRoot = ''

const SECRETS: WorkspaceSecrets = {
  version: 1,
  modelResources: { fast: 'sk-plain-fast-001', review: 'sk-plain-review-002' },
  judgeProviders: {},
  testCaptcha: '654321',
  smtpPassword: 'smtp-plain-password',
  apiKey: 'sk-legacy-plain',
}

function snapshot(secrets: WorkspaceSecrets | null): WorkspacePackSnapshot {
  return {
    workspace: { memory: [], profiles: [], runs: [] },
    sessions: [
      {
        id: 'session-1',
        title: '导出往返',
        workspacePath,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        messages: [
          { id: 'm1', role: 'user', text: '第一句' },
          { id: 'm2', role: 'assistant', text: '第二句' },
        ],
        queue: [],
        todos: [{ id: 'todo-1', text: '写测试', done: false }],
      },
    ] as unknown as WorkspacePackSnapshot['sessions'],
    scheduled: [
      {
        id: 'task-1',
        sessionId: 'session-1',
        kind: 'daily',
        timeOfDay: '09:00',
        nextRunAt: '2099-01-01T09:00:00.000Z',
        content: '每天检查一次',
      },
    ] as unknown as WorkspacePackSnapshot['scheduled'],
    settings: {
      settings: {} as unknown as NonNullable<WorkspacePackSnapshot['settings']>['settings'],
      quickCommands: [{ id: 'command-1', content: 'git status' }],
      reflectionReports: [],
    },
    secrets,
  } as unknown as WorkspacePackSnapshot
}

async function writePack(target: string, withSecrets: boolean): Promise<void> {
  await writeWorkspacePack({
    snapshot: snapshot(withSecrets ? SECRETS : null),
    scope: normalizePackScope({
      sessions: true,
      files: true,
      settings: true,
      secrets: withSecrets,
      checkpoints: true,
    }),
    manifest: {
      createdAt: '2026-01-02T03:04:05.000Z',
      appVersion: '1.2.5',
      platform: 'win32',
      workspace: { name: 'demo', path: workspacePath },
      origin: 'test-host',
    },
    workspacePath,
    checkpointRoot,
    target,
  })
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'pilotpack-test-'))
  workspacePath = join(root, 'workspace')
  checkpointRoot = join(root, 'checkpoints')
  await mkdir(join(workspacePath, 'src'), { recursive: true })
  await writeFile(join(workspacePath, 'README.md'), '# demo\n')
  await writeFile(join(workspacePath, 'src', 'app.ts'), 'export const a = 1\n')
  await mkdir(join(checkpointRoot, 'session-1'), { recursive: true })
  await writeFile(join(checkpointRoot, 'session-1', 'snap.json'), '{"v":1}')
})

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})

describe('workspace pack round trip', () => {
  it('writes secrets as plaintext and reads them back unchanged', async () => {
    const target = join(root, 'with-secrets.pilotpack.zip')
    await writePack(target, true)

    // 第一层证据：zip 里的密钥文件就是明文，任何拿到包的人都能读。
    const zip = await JSZip.loadAsync(await readFile(target))
    const secretsEntry = zip.file(PACK_SECRETS_FILE)
    expect(secretsEntry).toBeTruthy()
    const rawSecrets = await secretsEntry!.async('string')
    expect(rawSecrets).toContain('sk-plain-fast-001')
    expect(rawSecrets).toContain('smtp-plain-password')
    expect(rawSecrets).toContain('654321')

    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string')) as {
      includesSecrets: boolean
      counts: { sessions: number; messages: number; files: number; checkpoints: number }
    }
    expect(manifest.includesSecrets).toBe(true)
    expect(manifest.counts.sessions).toBe(1)
    expect(manifest.counts.messages).toBe(2)
    expect(manifest.counts.files).toBe(2)
    expect(manifest.counts.checkpoints).toBe(1)

    // 第二层证据：读包那一侧把明文原样交回，交给 store 去重新加密。
    const written: Record<string, string> = {}
    const checkpoints: Record<string, string> = {}
    const read = await readWorkspacePack(target, {
      writeWorkspaceFile: async (relative, data) => {
        written[relative] = data.toString('utf8')
      },
      writeCheckpointFile: async (relative, data) => {
        checkpoints[relative] = data.toString('utf8')
      },
    })

    expect(read.manifest.includesSecrets).toBe(true)
    expect(read.secrets).toEqual(SECRETS)
    expect(read.sessions).toHaveLength(1)
    expect(read.sessions[0]?.id).toBe('session-1')
    expect(read.sessions[0]?.messages).toHaveLength(2)
    expect(written['README.md']).toBe('# demo\n')
    expect(written['src/app.ts']).toBe('export const a = 1\n')
    expect(read.filesWritten).toBe(2)
    expect(read.checkpointFilesWritten).toBe(1)
    expect(checkpoints['session-1/snap.json']).toBe('{"v":1}')
    expect(read.skipped).toEqual([])
    expect(read.core['exportedAt']).toBe('2026-01-02T03:04:05.000Z')
    expect(Array.isArray(read.core['quickCommands'])).toBe(true)
  })

  it('omits the secrets file when the scope has no secrets', async () => {
    const target = join(root, 'without-secrets.pilotpack.zip')
    await writePack(target, false)

    const zip = await JSZip.loadAsync(await readFile(target))
    expect(zip.file(PACK_SECRETS_FILE)).toBeNull()
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string')) as {
      includesSecrets: boolean
    }
    expect(manifest.includesSecrets).toBe(false)

    const read = await readWorkspacePack(target)
    expect(read.secrets).toBeNull()
    expect(read.manifest.includesSecrets).toBe(false)
    // 文件条目仍然按 scope 写在包里，只是这次不提供落地回调。
    expect(Object.keys(zip.files).some((name) => name.startsWith(`${PACK_FILES_DIR}/`))).toBe(true)
    expect(Object.keys(zip.files).some((name) => name.startsWith(`${PACK_CHECKPOINTS_DIR}/`))).toBe(
      true,
    )
  })
})
