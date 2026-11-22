// 个人分支与自身源码：个人进化服务缓存、源码解析与自检会话。
import { appState } from './app-state'
import type { ContributionEvidence, RunEvent } from '../shared/types'
import { broadcast } from './diagnostics'
import {
  configureFingerprintCache,
  forgetSourceFingerprint,
  prepareGitBase,
  PersonalEvolutionService,
} from './personal'
import { prepareSelfSource } from './self-source'
import { resolveSelfSource, SelfSourceContext, SelfSourceSettings } from './self-source-git'
import { app, session } from 'electron'
import { join } from 'node:path'

/**
 * 解析自身源码要起好几个 git 子进程（开发态实测约 2 s），而且 runGit 是
 * spawnSync —— 它会把整个主进程的事件循环堵住，期间连 `exists` 都要排队。
 * 结果只与设置、安装路径和官方 HEAD 有关，设置变化会换 key，准备/同步源码时
 * 显式失效，所以缓存可以放得比较长。
 */
const PERSONAL_RESOLVE_TTL_MS = 10 * 60_000

function personalServiceKey(): string {
  return JSON.stringify({
    packaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    userDataPath: app.getPath('userData'),
    version: app.getVersion(),
    settings: currentSelfSourceSettings(),
  })
}

/**
 * 缓存的 `resolveSelfSource`。进化页会同时问个人状态和源码来源，两次都把
 * 同一串 git 子进程跑一遍就会白白阻塞主进程两次。
 */
export function resolveSelfSourceCached(): ReturnType<typeof resolveSelfSource> {
  const key = personalServiceKey()
  if (
    appState.selfSourceResolve &&
    appState.selfSourceResolve.key === key &&
    Date.now() - appState.selfSourceResolve.at < PERSONAL_RESOLVE_TTL_MS
  ) {
    return appState.selfSourceResolve.promise
  }
  const promise = resolveSelfSource({
    packaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    userDataPath: app.getPath('userData'),
    settings: currentSelfSourceSettings(),
  })
  const entry = { key, at: Date.now(), promise }
  appState.selfSourceResolve = entry
  promise.catch(() => {
    if (appState.selfSourceResolve === entry) appState.selfSourceResolve = null
  })
  return promise
}

/** 源码目录或官方基线刚刚变过，下一次必须重新解析。 */
export function forgetPersonalService(): void {
  appState.personalResolve = null
  appState.selfSourceResolve = null
  // prepare/sync 会重写官方基线树，指纹也必须重算。
  const userData = app.getPath('userData')
  forgetSourceFingerprint(selfSourcePath())
  forgetSourceFingerprint(join(userData, 'self-src-base'))
  forgetSourceFingerprint(join(process.resourcesPath, 'source'))
}

/**
 * Build the personal-fork service for the current install. Installed builds
 * diff against the pristine `resources/source`; development runs use a cached
 * git-HEAD snapshot so unrelated working-tree edits are still visible.
 */
export async function personalService(options: {
  ensureSource?: boolean
  ensureBase?: boolean
} = {}): Promise<PersonalEvolutionService> {
  const key = personalServiceKey()
  const force = Boolean(options.ensureSource || options.ensureBase)
  if (
    !force &&
    appState.personalResolve &&
    appState.personalResolve.key === key &&
    Date.now() - appState.personalResolve.at < PERSONAL_RESOLVE_TTL_MS
  ) {
    return appState.personalResolve.promise
  }
  const promise = createPersonalService(options)
  const entry = { key, at: Date.now(), promise }
  appState.personalResolve = entry
  promise.catch(() => {
    // A failed resolution must not be replayed to the next caller.
    if (appState.personalResolve === entry) appState.personalResolve = null
  })
  return promise
}

async function createPersonalService(options: {
  ensureSource?: boolean
  ensureBase?: boolean
}): Promise<PersonalEvolutionService> {
  const userData = app.getPath('userData')
  configureFingerprintCache(join(userData, 'personal', 'fingerprints.json'))
  const sourceOptions = {
    packaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    userDataPath: userData,
  }
  if (options.ensureSource) await prepareSelfSource(sourceOptions)
  // Which copy is editable, and which tree is "official", depends on the
  // user's source settings: built-in (official git baseline) or a custom
  // checkout. Falls back to the installer snapshot when nothing is configured.
  const resolved = await resolveSelfSourceCached()
  let sourcePath = resolved.sourcePath
  let basePath = resolved.basePath
  if (!basePath) {
    // No traceable baseline: development runs still diff against git HEAD so a
    // fork can be upgraded after `git pull`; installed builds have none.
    sourcePath = app.isPackaged ? join(userData, 'self-src') : app.getAppPath()
    basePath = app.isPackaged
      ? join(process.resourcesPath, 'source')
      : await prepareGitBase(sourcePath, join(userData, 'self-src-base'))
  }
  const endpoint = process.env['PILOT_CONTRIBUTION_URL']?.trim()
  return new PersonalEvolutionService({
    sourcePath,
    basePath,
    baseReadOnly: resolved.baseReadOnly,
    dataDir: join(userData, 'personal'),
    appVersion: app.getVersion(),
    provenance: resolved.provenance,
    ...(endpoint ? { endpoint } : {}),
  })
}

/** Current source settings plus the paths the resolver needs. */
export function selfSourceContext(): SelfSourceContext {
  return {
    packaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    userDataPath: app.getPath('userData'),
    settings: currentSelfSourceSettings(),
  }
}

function currentSelfSourceSettings(): SelfSourceSettings {
  const view = appState.store.settingsView()
  return {
    mode: view.selfSourceMode,
    gitUrl: view.selfSourceGitUrl,
    gitRef: view.selfSourceGitRef,
    gitPath: view.selfSourceGitPath,
    customPath: view.selfSourceCustomPath,
  }
}

/** Evidence attached to a contribution so maintainers can judge the change. */
export function contributionEvidence(): ContributionEvidence {
  const path = appState.store.activeWorkspace()
  const detail = path ? appState.store.workspaceDetail(path) : null
  const policyVersion = detail?.evolution.policyVersions.find(
    (version) => version.status === 'active',
  )
  return {
    policy: appState.store.evolutionPolicy(),
    ...(policyVersion ? { policyVersion: policyVersion.version } : {}),
    ...(detail?.activeProfile ? { activeProfile: detail.activeProfile.promptAddendum } : {}),
    cycles: (detail?.evolution.cycles ?? []).slice(0, 5).map((cycle) => cycle.summary),
  }
}

export function selfSourceOptions() {
  return {
    packaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    userDataPath: app.getPath('userData'),
  }
}

/**
 * 内置源码目录：安装版是 userData 里的可写副本，开发态就是当前 client 目录。
 * 自检与“打开自身源码”用的是同一份，不再看用户打开了哪个工作区。
 */
export function selfSourcePath(): string {
  return app.isPackaged ? join(app.getPath('userData'), 'self-src') : app.getAppPath()
}

/** Ensure the personal source exists, register it, and start a phone-driven chat. */
export async function startPersonalChat(
  title: string,
  prompt: string,
): Promise<{ sessionId: string; workspacePath: string }> {
  const prepared = await prepareSelfSource(selfSourceOptions())
  await appState.store.addWorkspace(prepared.path, { activate: false })
  const session = await appState.store.createSession(prepared.path, { title })
  await appState.runner.sendMessage(session.id, prompt, 'queue')
  const event: RunEvent = { type: 'workspace.changed', workspacePath: prepared.path }
  broadcast(event)
  appState.companion?.publish(event)
  return { sessionId: session.id, workspacePath: prepared.path }
}
