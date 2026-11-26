import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PACK_SCOPE,
  WORKSPACE_PACK_FORMAT,
  countWorkspaceSecrets,
  emptyWorkspaceSecrets,
  isSafePackEntryPath,
  normalizePackScope,
  packFileName,
  parseWorkspacePackManifest,
  remapWorkspacePath,
  sanitizeWorkspaceSecrets,
  scopeIsEmpty,
  workspaceSecretsIsEmpty,
  type WorkspacePackScope,
} from '../src/shared/workspace-pack'
import {
  PACK_SCOPE_KEYS,
  canStartPackExport,
  formatPackBytes,
  initialPackScope,
  packImportSegments,
  packScopeNeedsSecretAck,
  togglePackScope,
} from '../src/renderer/src/workspace-pack-view'

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: WORKSPACE_PACK_FORMAT,
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    appVersion: '1.2.5',
    platform: 'win32',
    workspace: { name: 'demo', path: 'E:\\demo' },
    scope: { ...DEFAULT_PACK_SCOPE },
    counts: { files: 3, fileBytes: 2048, sessions: 2, messages: 40 },
    includesSecrets: true,
    origin: 'workstation',
    ...overrides,
  }
}

describe('pack scope', () => {
  it('forces secrets off when settings are off', () => {
    const scope = normalizePackScope({ settings: false, secrets: true })
    expect(scope.secrets).toBe(false)
    expect(scope.settings).toBe(false)
  })

  it('falls back to the defaults for missing or non-boolean flags', () => {
    const scope = normalizePackScope({ files: 'yes', checkpoints: true })
    expect(scope.files).toBe(DEFAULT_PACK_SCOPE.files)
    expect(scope.checkpoints).toBe(true)
    const empty = normalizePackScope(null)
    expect(empty).toEqual(DEFAULT_PACK_SCOPE)
  })

  it('treats a scope with nothing but secrets as empty', () => {
    expect(scopeIsEmpty(normalizePackScope({ settings: false, secrets: true, sessions: false, files: false, checkpoints: false }))).toBe(true)
    expect(scopeIsEmpty(normalizePackScope({ sessions: true }))).toBe(false)
  })
})

describe('scope checkboxes', () => {
  it('starts from a copy so edits never mutate the shared default', () => {
    const scope = initialPackScope()
    scope.sessions = false
    expect(DEFAULT_PACK_SCOPE.sessions).toBe(true)
    expect(PACK_SCOPE_KEYS).toContain('secrets')
  })

  it('drops secrets when the settings box is cleared', () => {
    const scope = togglePackScope({ ...DEFAULT_PACK_SCOPE, secrets: true }, 'settings', false)
    expect(scope.settings).toBe(false)
    expect(scope.secrets).toBe(false)
  })

  it('needs a plaintext acknowledgement only while secrets are in', () => {
    expect(packScopeNeedsSecretAck({ ...DEFAULT_PACK_SCOPE, secrets: true })).toBe(true)
    expect(packScopeNeedsSecretAck({ ...DEFAULT_PACK_SCOPE, secrets: false })).toBe(false)
    expect(
      packScopeNeedsSecretAck({ ...DEFAULT_PACK_SCOPE, settings: false, secrets: true }),
    ).toBe(false)
  })

  it('blocks export until the scope is non-empty and secrets are acknowledged', () => {
    const empty: WorkspacePackScope = {
      settings: false,
      secrets: false,
      sessions: false,
      files: false,
      checkpoints: false,
    }
    expect(canStartPackExport(empty, false, false)).toBe(false)
    expect(canStartPackExport({ ...DEFAULT_PACK_SCOPE, secrets: true }, false, false)).toBe(false)
    expect(canStartPackExport({ ...DEFAULT_PACK_SCOPE, secrets: true }, true, false)).toBe(true)
    expect(canStartPackExport({ ...DEFAULT_PACK_SCOPE, secrets: false }, false, false)).toBe(true)
    expect(canStartPackExport({ ...DEFAULT_PACK_SCOPE, secrets: true }, true, true)).toBe(false)
  })
})

describe('pack result formatting', () => {
  it('renders byte counts with one decimal under 100', () => {
    expect(formatPackBytes(0)).toBe('0 B')
    expect(formatPackBytes(-5)).toBe('0 B')
    expect(formatPackBytes(512)).toBe('512 B')
    expect(formatPackBytes(1536)).toBe('1.5 KB')
    expect(formatPackBytes(500 * 1024)).toBe('500 KB')
    expect(formatPackBytes(1024 * 1024)).toBe('1.0 MB')
  })

  it('lists import counts in a stable order', () => {
    const segments = packImportSegments({
      ok: true,
      workspacePath: 'E:/demo',
      workspaceName: 'demo',
      manifest: null,
      sessions: 2,
      messages: 40,
      todos: 3,
      scheduled: 1,
      files: 7,
      fileBytes: 1024,
      checkpoints: 0,
      secretsApplied: 4,
      settingsApplied: true,
      cancelled: false,
      warnings: [],
    })
    expect(segments.map((segment) => segment.key)).toEqual([
      'sessions',
      'messages',
      'todos',
      'scheduled',
      'files',
      'checkpoints',
      'secrets',
    ])
    expect(segments.find((segment) => segment.key === 'secrets')?.count).toBe(4)
  })
})

describe('manifest parsing', () => {
  it('accepts a well-formed manifest', () => {
    const parsed = parseWorkspacePackManifest(manifest())
    expect(parsed?.workspace).toEqual({ name: 'demo', path: 'E:\\demo' })
    expect(parsed?.includesSecrets).toBe(true)
    expect(parsed?.counts.files).toBe(3)
  })

  it('rejects a foreign format, a future version and a nameless workspace', () => {
    expect(parseWorkspacePackManifest(manifest({ format: 'other' }))).toBeNull()
    expect(parseWorkspacePackManifest(manifest({ version: 99 }))).toBeNull()
    expect(parseWorkspacePackManifest(manifest({ version: 0 }))).toBeNull()
    expect(parseWorkspacePackManifest(manifest({ workspace: {} }))).toBeNull()
    expect(parseWorkspacePackManifest(null)).toBeNull()
  })

  it('derives the name from the path and zeroes broken counts', () => {
    const parsed = parseWorkspacePackManifest(
      manifest({ workspace: { path: 'E:/work/demo-app' }, counts: { files: -2, sessions: 'x' } }),
    )
    expect(parsed?.workspace.name).toBe('demo-app')
    expect(parsed?.counts.files).toBe(0)
    expect(parsed?.counts.sessions).toBe(0)
    expect(parsed?.counts.checkpoints).toBe(0)
  })

  it('normalizes the scope inside the manifest', () => {
    const parsed = parseWorkspacePackManifest(
      manifest({ scope: { settings: false, secrets: true, sessions: true } }),
    )
    expect(parsed?.scope.settings).toBe(false)
    expect(parsed?.scope.secrets).toBe(false)
    expect(parsed?.scope.sessions).toBe(true)
  })
})

describe('secret payloads', () => {
  it('drops empty, oversized and non-string values', () => {
    const secrets = sanitizeWorkspaceSecrets({
      modelResources: { fast: 'sk-1', slow: '   ', bad: 'x'.repeat(9000), none: 42 },
      judgeProviders: { judge: 'sk-2' },
      testCaptcha: ' 123456 ',
      smtpPassword: '',
      apiKey: null,
    })
    expect(secrets.modelResources).toEqual({ fast: 'sk-1' })
    expect(secrets.judgeProviders).toEqual({ judge: 'sk-2' })
    expect(secrets.testCaptcha).toBe('123456')
    expect(secrets.smtpPassword).toBeNull()
    expect(countWorkspaceSecrets(secrets)).toBe(3)
  })

  it('reports an empty payload', () => {
    expect(workspaceSecretsIsEmpty(emptyWorkspaceSecrets())).toBe(true)
    expect(countWorkspaceSecrets(sanitizeWorkspaceSecrets(undefined))).toBe(0)
  })
})

describe('entry safety', () => {
  it('accepts plain relative paths only', () => {
    expect(isSafePackEntryPath('workspace/src/app.ts')).toBe(true)
    expect(isSafePackEntryPath('pilot-data/sessions/a.json')).toBe(true)
  })

  it('rejects traversal, absolute paths, drives and backslashes', () => {
    expect(isSafePackEntryPath('../etc/passwd')).toBe(false)
    expect(isSafePackEntryPath('workspace/../../x')).toBe(false)
    expect(isSafePackEntryPath('/abs/file')).toBe(false)
    expect(isSafePackEntryPath('C:/Windows')).toBe(false)
    expect(isSafePackEntryPath('workspace\\file')).toBe(false)
    expect(isSafePackEntryPath('workspace/dir/')).toBe(false)
    expect(isSafePackEntryPath('./file')).toBe(false)
    expect(isSafePackEntryPath('')).toBe(false)
  })

  it('repoints only the exported path and leaves other paths alone', () => {
    const item = { workspacePath: 'E:\\old', id: 'session-1' }
    expect(remapWorkspacePath(item, 'E:\\old', '/home/new')).toEqual({
      workspacePath: '/home/new',
      id: 'session-1',
    })
    expect(remapWorkspacePath(item, 'E:\\other', '/home/new').workspacePath).toBe('E:\\old')
  })

  it('builds a filesystem-safe package name', () => {
    const name = packFileName('my:proj/ect*?', new Date(2026, 0, 2, 3, 4))
    expect(name).toBe('my-proj-ect-pilotpack-20260102-0304.zip')
    expect(packFileName('')).toBe(
      `workspace-pilotpack-${packFileName('x').slice(-17)}`,
    )
  })
})
