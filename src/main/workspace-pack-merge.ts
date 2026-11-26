/**
 * 导入端的合并规则：哪些设置可以跨机器带走、会话 id 怎么重映射、密钥挂到哪个资源。
 *
 * 全部是纯函数，跑在 `Store.applyWorkspacePack` 里。之所以单独成文件：这些规则
 * 决定了导入会不会改坏本机数据（覆盖已有密钥、把时间锚点带过来导致立刻触发反思），
 * 单测要能一条条钉住。
 */
import { randomUUID } from 'node:crypto'
import type { Session, SettingsUpdate } from '../shared/types'
import type { WorkspacePackManifest, WorkspaceSecrets } from '../shared/workspace-pack'
import type { PersistedSettings } from './store-schema'
import { sanitizeSession } from './store-schema'

/** 包里 `pilot-data/sessions/<id>.json` 与 `.messages.jsonl` 拼回来的样子。 */
export interface PackSessionPayload {
  id: string
  meta: Record<string, unknown>
  messages: unknown[]
}

/**
 * 导出前把密文与明文标记从设置里摘掉。
 *
 * 原因有二：本机的 safeStorage 密文到了另一台机器解不开，留着只会误导
 * 「看起来已经配好了」；而真正的密钥放在 `secrets.json` 里，避免同一份凭据
 * 在包里出现两次。
 */
export function stripPersistedSecrets(settings: PersistedSettings): PersistedSettings {
  return {
    ...settings,
    testCaptchaCipher: null,
    testCaptchaPlain: false,
    reflectSmtpPasswordCipher: null,
    reflectSmtpPasswordPlain: false,
    apiKeyCipher: null,
    apiKeyPlain: false,
    modelResources: settings.modelResources.map((resource) => ({
      ...resource,
      keyCipher: null,
      keyPlain: false,
    })),
    judgeProviders: settings.judgeProviders.map((provider) => ({
      ...provider,
      keyCipher: null,
      keyPlain: false,
    })),
  }
}

/**
 * 可以跨机器应用的设置白名单。
 *
 * 刻意不带走的四类：
 * - 本机绝对路径：`selfSourceGitPath` / `selfSourceCustomPath` / `phoneRoots`；
 * - 时间锚点：`reflectLastRunAt` / `reflectLastVersion` / `reflectMailboxRestored`
 *   —— 带过来会让导入端以为刚反思过（或永远不再反思），
 * - 模型资源与角色选择（由 `secrets` 与 `ModelResourceInput` 单独合并）；
 * - 服务形态：`serverMode` / `serverPort`，导入端不该因为别人的包开始监听端口。
 *
 * `reflectEmailTo` 用 `|| null`：空串在 SettingsUpdate 里表示「保持原值」，
 * 想表达「包里的确没有邮箱」就得传 null。
 */
export function portableSettingsPatch(raw: unknown): SettingsUpdate {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const patch: SettingsUpdate = {}
  const bool = (key: keyof SettingsUpdate): void => {
    const value = record[key as string]
    if (typeof value === 'boolean') (patch as Record<string, unknown>)[key as string] = value
  }
  const num = (key: keyof SettingsUpdate): void => {
    const value = record[key as string]
    if (typeof value === 'number' && Number.isFinite(value)) {
      (patch as Record<string, unknown>)[key as string] = value
    }
  }
  const text = (key: keyof SettingsUpdate): void => {
    const value = record[key as string]
    if (typeof value === 'string') (patch as Record<string, unknown>)[key as string] = value
  }
  const list = (key: keyof SettingsUpdate): void => {
    const value = record[key as string]
    if (Array.isArray(value)) (patch as Record<string, unknown>)[key as string] = value
  }

  for (const key of [
    'maxSteps',
    'maxTokens',
    'maxContextTokens',
    'maxOutputTokens',
    'temperature',
    'autoContinueLimit',
    'approvalTimeoutSec',
    'qualityTuneEvery',
    'checkpointRetention',
    'checkpointMaxBytes',
    'reflectIntervalMinutes',
    'reflectSmtpPort',
  ] as const) {
    num(key)
  }
  for (const key of [
    'autoReflect',
    'autoEvolve',
    'autoContinue',
    'screenshotFeedback',
    'shellMode',
    'sandboxNetwork',
    'sandboxAutoAllow',
    'allowUnattendedBuild',
    'fullAutonomy',
    'learningMode',
    'learningShellIsolation',
    'qualityGate',
    'checkpointShell',
    'notifyDesktop',
    'hooksEnabled',
    'mcpEnabled',
    'reflectEnabled',
    'notifyEmailEnabled',
  ] as const) {
    bool(key)
  }
  for (const key of [
    'model',
    'testCaptchaMode',
    'shellInterpreter',
    'defaultApprovalMode',
    'classifierModel',
    'sandboxMode',
    'qualityPublishTarget',
    'reflectScheduleMode',
    'reflectDailyTime',
    'reflectSmtpHost',
    'reflectSmtpSecurity',
    'reflectModelId',
    'relayUrl',
    'theme',
    'fontSize',
    'locale',
  ] as const) {
    text(key)
  }
  for (const key of [
    'testTargets',
    'trustedCommands',
    'learningHosts',
    'checkpointIgnore',
    'reflectTopics',
    'notifyEmailEvents',
  ] as const) {
    list(key)
  }
  if (record['permissionRules'] && typeof record['permissionRules'] === 'object') {
    patch.permissionRules = record['permissionRules'] as SettingsUpdate['permissionRules']
  }
  if (record['reflectTriggers'] && typeof record['reflectTriggers'] === 'object') {
    patch.reflectTriggers = record['reflectTriggers'] as SettingsUpdate['reflectTriggers']
  }
  // 空串在 SettingsUpdate 里等于「不改」，这里要明确表达「包里就是空的」。
  patch.reflectEmailTo = typeof record['reflectEmailTo'] === 'string' && record['reflectEmailTo'].trim()
    ? String(record['reflectEmailTo'])
    : null
  return patch
}

export interface SessionImportPlan {
  sessions: Session[]
  /** 包内 id → 导入端 id（未改动的 id 也在这张表里）。 */
  idMap: Record<string, string>
  skipped: string[]
}

export interface SessionImportInput {
  payloads: PackSessionPayload[]
  fromPath: string
  toPath: string
  /** 导入端已占用的会话 id。 */
  taken: Set<string>
}

/**
 * 把包里的会话落成可直接进 `state.sessions` 的对象。
 *
 * 三件事：id 撞了换新（否则会覆盖本机同名会话）、`workspacePath` 换成导入端路径、
 * 每条记录都过一遍 `sanitizeSession`（包是外部文件，字段可能被手改）。
 * 计划、待办、摘要、`memoryIds` 都随之保留，只把「正在运行」相关的瞬时状态清掉。
 */
export function planSessionImport(input: SessionImportInput): SessionImportPlan {
  const plan: SessionImportPlan = { sessions: [], idMap: {}, skipped: [] }
  for (const payload of input.payloads) {
    const sourceId = typeof payload.id === 'string' ? payload.id : ''
    if (!sourceId) {
      plan.skipped.push('(无 id 的会话)')
      continue
    }
    const id = input.taken.has(sourceId) ? randomUUID() : sourceId
    const raw = {
      ...payload.meta,
      id,
      workspacePath: input.toPath,
      messages: payload.messages,
      // 包里的 `running` 只是导出那一刻的快照，导入端没有对应的子进程。
      running: false,
      runningSince: undefined,
      paused: false,
    }
    const session = sanitizeSession(raw)
    if (!session) {
      plan.skipped.push(sourceId)
      continue
    }
    input.taken.add(id)
    plan.idMap[sourceId] = id
    plan.sessions.push(session)
  }
  return plan
}

/** 包内密钥表的 key 跟着 id 重映射走；映射不到的原样保留，交给上层决定是否忽略。 */
export function remapSecretKeys(
  secrets: Record<string, string>,
  idMap: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [id, value] of Object.entries(secrets)) {
    out[idMap[id] ?? id] = value
  }
  return out
}

/** 把包里的密钥按「模型资源 id」挂到 updateSettings 的入参上。 */
export function secretsForResource(resourceId: string, secrets: WorkspaceSecrets | null): string | null {
  if (!secrets) return null
  return secrets.modelResources[resourceId] ?? secrets.judgeProviders[resourceId] ?? null
}

/** 一次导入请求里，`Store.applyWorkspacePack` 需要的全部内容。 */
export interface WorkspacePackImportInput {
  manifest: WorkspacePackManifest
  core: Record<string, unknown>
  sessions: PackSessionPayload[]
  secrets: WorkspaceSecrets | null
  /** 导入端落地的绝对路径。 */
  workspacePath: string
  workspaceName: string
}

export interface WorkspacePackImportOutcome {
  sessions: number
  scheduled: number
  files: number
  checkpoints: number
  /** 重新加密并写回本机的密钥条数。 */
  secretsApplied: number
  settingsApplied: boolean
  warnings: string[]
}
