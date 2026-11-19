/**
 * Self-evolution controls, shared by both hosts.
 *
 * The desktop app used to own this whole block: the snapshot the panel paints,
 * the cycle/policy/profile actions, and the personal-fork actions that need the
 * bundled pristine source tree. `pilot serve` had none of it, so the panel's
 * evolution tab failed there with a "update the desktop app" message — the one
 * thing a server install can never do.
 *
 * The block lives here now. A host supplies the engine and its event fan-out,
 * plus (if it can) the personal-fork services; a host without them still gets
 * cycles, policy versions and profiles, and the personal actions fail with a
 * message that names the real reason.
 */
import type { AgentRunner } from '../main/agent/runner'
import type { CompanionOptions } from '../main/companion/server'
import type { PersonalEvolutionService } from '../main/personal'
import type { Store } from '../main/store'
import type { EvolutionPolicyVersion, EvolutionSnapshot, RunEvent } from '../shared/types'
import { assertActivatable } from './profile-gate'

/** Personal-fork support. Only a host that ships the pristine source can offer it. */
export interface PersonalEvolutionHost {
  service(options?: {
    ensureSource?: boolean
    ensureBase?: boolean
  }): Promise<PersonalEvolutionService>
  /** Evidence attached to a contribution so maintainers can judge the change. */
  evidence(): import('../shared/types').ContributionEvidence
  /** Open a chat that works on the personal fork, like any other workspace. */
  startChat(
    title: string,
    prompt: string,
  ): Promise<{ sessionId: string; workspacePath: string }>
  /** Register the personal source tree as a workspace and return its path. */
  openSource(): Promise<{ path: string; copied?: boolean }>
}

export interface EvolutionHostOptions {
  store: Store
  runner: AgentRunner
  /**
   * Where evolution events go. The desktop host fans out to the window, the OS
   * notifier and the panel; the server host only has the panel. Passing the
   * full fan-out here is why the moved code no longer publishes twice.
   */
  publish: (event: RunEvent) => void
  personal?: PersonalEvolutionHost
}

/** A host without personal-fork support answers these actions with this. */
const NO_PERSONAL = '服务器模式不支持个人版本（需要随安装包发布的官方源码），请在电脑端操作。'

export function createEvolutionControls(
  deps: EvolutionHostOptions,
): NonNullable<CompanionOptions['evolution']> {
  const store = deps.store
  const runner = deps.runner
  // The moved code called both `broadcast` and `companion?.publish`; the host's
  // single `publish` already does both, so mirroring here would duplicate frames.
  const broadcast = deps.publish
  const companion: { publish(event: RunEvent): void } | null = null
  /** Long-running self-evolution work started from the phone. */
  let evolutionBusy: 'cycle' | 'policy' | null = null
  /** Personal-fork validation/merge work started from the phone. */
  let personalBusy: 'upgrade' | 'validate' | null = null

  const requirePersonal = (): PersonalEvolutionHost => {
    if (!deps.personal) throw new Error(NO_PERSONAL)
    return deps.personal
  }
  const personalService = (
    options: { ensureSource?: boolean; ensureBase?: boolean } = {},
  ): Promise<PersonalEvolutionService> => requirePersonal().service(options)
  const contributionEvidence = (): import('../shared/types').ContributionEvidence =>
    requirePersonal().evidence()
  const startPersonalChat = (
    title: string,
    prompt: string,
  ): Promise<{ sessionId: string; workspacePath: string }> =>
    requirePersonal().startChat(title, prompt)

/** Workspace the action applies to, defaulting to the active one. */
function evolutionWorkspace(params: Record<string, unknown>): string {
  const requested = typeof params['workspacePath'] === 'string' ? params['workspacePath'].trim() : ''
  const path = requested || store.activeWorkspace() || ''
  if (!path || !store.workspaces().some((workspace) => workspace.path === path)) {
    throw new Error('工作区未打开')
  }
  return path
}

/**
 * Activation is a hard gate, shared with the desktop IPC handlers so a phone
 * and a desktop click cannot disagree about what may be activated.
 */

function publishEvolutionEvent(
  workspacePath: string,
  kind: 'evolution' | 'profile' = 'evolution',
): void {
  const event: RunEvent =
    kind === 'profile'
      ? { type: 'profile.changed', workspacePath }
      : { type: 'evolution.changed', workspacePath }
  broadcast(event)
  companion?.publish(event)
}

function notifyEvolution(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
  const event: RunEvent = { type: 'notice', level, message: message.slice(0, 800) }
  broadcast(event)
  companion?.publish(event)
}

function evolutionFailure(error: unknown): void {
  notifyEvolution(error instanceof Error ? error.message : String(error), 'error')
}

async function evolutionSnapshot(workspacePath: string): Promise<EvolutionSnapshot> {
  const detail = store.workspaceDetail(workspacePath)
  const settings = store.settingsView()
  const completed = detail.runs.filter((run) => run.status !== 'running')
  const failures = completed.filter((run) =>
    ['failed', 'cancelled', 'interrupted', 'max_steps'].includes(run.status),
  ).length
  const avgSteps =
    completed.length > 0
      ? Math.round((completed.reduce((sum, run) => sum + run.steps, 0) / completed.length) * 10) / 10
      : 0
  const policy = detail.evolution.policy
  const policyVersions = detail.evolution.policyVersions
  const hasKey = Boolean(store.getApiKey())
  return {
    workspacePath,
    workspaceName: detail.workspace.name,
    hasKey,
    autoEvolve: settings.autoEvolve,
    busy: evolutionBusy,
    completedRuns: completed.length,
    failures,
    avgSteps,
    canRunCycle: hasKey && completed.length >= policy.minRuns && !evolutionBusy,
    minRuns: policy.minRuns,
    policy,
    activePolicyVersion:
      policyVersions.find((version) => version.status === 'active') ?? null,
    canRollbackPolicy: policyVersions.some(
      (version) => version.status === 'retired' && version.activatedAt,
    ),
    cycles: detail.evolution.cycles.slice(0, 8),
    activeProfile: detail.activeProfile,
    profiles: detail.profiles.slice(0, 20),
    globalProfiles: detail.globalProfiles.slice(0, 20),
    activeGlobalProfile: detail.activeGlobalProfile,
  }
}
async function handleEvolutionAction(
  action: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (action) {
    case 'auto': {
      const value = params['value'] === true
      const settings = await store.updateSettings({ autoEvolve: value })
      const event: RunEvent = { type: 'settings.changed', settings }
      broadcast(event)
      companion?.publish(event)
      return { autoEvolve: settings.autoEvolve }
    }
    case 'cycle': {
      const workspacePath = evolutionWorkspace(params)
      if (evolutionBusy) throw new Error('已有自进化任务正在进行，请稍候')
      if (!store.getApiKey()) throw new Error('需要先在电脑上配置 API Key')
      const policy = store.workspaceDetail(workspacePath).evolution.policy
      const completed = store
        .workspaceDetail(workspacePath)
        .runs.filter((run) => run.status !== 'running').length
      if (completed < policy.minRuns) {
        throw new Error(`至少需要 ${policy.minRuns} 次运行记录才能开始进化`)
      }
      evolutionBusy = 'cycle'
      void runner.evolution
        .runCycle(workspacePath, 'manual')
        .then((cycle) => {
          publishEvolutionEvent(workspacePath, 'evolution')
          if (cycle.activated) publishEvolutionEvent(workspacePath, 'profile')
        })
        .catch(evolutionFailure)
        .finally(() => {
          evolutionBusy = null
          publishEvolutionEvent(workspacePath, 'evolution')
        })
      return { started: true }
    }
    case 'improvePolicy': {
      const workspacePath = evolutionWorkspace(params)
      if (evolutionBusy) throw new Error('已有自进化任务正在进行，请稍候')
      if (!store.getApiKey()) throw new Error('需要先在电脑上配置 API Key')
      evolutionBusy = 'policy'
      void runner.evolution
        .improvePolicy(workspacePath)
        .then((version) => {
          if (version) publishEvolutionEvent(workspacePath, 'evolution')
          else notifyEvolution('这一轮没有产生新的进化机制。', 'info')
        })
        .catch(evolutionFailure)
        .finally(() => {
          evolutionBusy = null
          publishEvolutionEvent(workspacePath, 'evolution')
        })
      return { started: true }
    }
    case 'rollbackPolicy': {
      const version: EvolutionPolicyVersion | null = await store.rollbackEvolutionPolicy()
      publishEvolutionEvent(store.activeWorkspace() ?? '', 'evolution')
      return version
    }
    case 'propose': {
      const workspacePath = evolutionWorkspace(params)
      const profile = await runner.evolution.propose(workspacePath)
      publishEvolutionEvent(workspacePath, 'profile')
      return profile
    }
    case 'review': {
      const workspacePath = evolutionWorkspace(params)
      const profileId = String(params['profileId'] ?? '').slice(0, 80)
      if (!profileId) throw new Error('缺少进化版本编号')
      const result = await runner.evolution.review(workspacePath, profileId)
      publishEvolutionEvent(workspacePath, 'profile')
      return result
    }
    case 'activate': {
      const workspacePath = evolutionWorkspace(params)
      const profileId = String(params['profileId'] ?? '').slice(0, 80)
      const detail = store.workspaceDetail(workspacePath)
      const profile = detail.profiles.find((entry) => entry.id === profileId)
      if (!profile) throw new Error('进化版本不存在')
      assertActivatable(
        store.activeProfile(workspacePath),
        profile,
        false,
        '独立评审尚未通过，手机端不能强制启用；请先在电脑上确认风险。',
      )
      const active = await store.activateProfile(workspacePath, profileId)
      publishEvolutionEvent(workspacePath, 'profile')
      return active
    }
    case 'rollback': {
      const workspacePath = evolutionWorkspace(params)
      const profile = await store.rollbackProfile(workspacePath)
      publishEvolutionEvent(workspacePath, 'profile')
      return profile
    }
    case 'delete': {
      const workspacePath = evolutionWorkspace(params)
      const profileId = String(params['profileId'] ?? '').slice(0, 80)
      await store.deleteProfile(workspacePath, profileId)
      publishEvolutionEvent(workspacePath, 'profile')
      return { ok: true }
    }
    case 'promote': {
      const workspacePath = evolutionWorkspace(params)
      const profileId = String(params['profileId'] ?? '').slice(0, 80)
      const draft = await runner.evolution.promote(workspacePath, profileId)
      publishEvolutionEvent(workspacePath, 'profile')
      return draft
    }
    case 'localize': {
      const workspacePath = evolutionWorkspace(params)
      const profileId = String(params['profileId'] ?? '').slice(0, 80)
      const scope = params['scope'] === 'global' ? 'global' : 'workspace'
      const draft = await runner.evolution.localize(scope, workspacePath, profileId)
      publishEvolutionEvent(workspacePath, 'profile')
      return draft
    }
    case 'globalReview': {
      const profileId = String(params['profileId'] ?? '').slice(0, 80)
      const result = await runner.evolution.reviewGlobal(profileId)
      publishEvolutionEvent(store.activeWorkspace() ?? '', 'profile')
      return result
    }
    case 'globalActivate': {
      const profileId = String(params['profileId'] ?? '').slice(0, 80)
      const profile = store.globalProfile(profileId)
      if (!profile) throw new Error('全局进化版本不存在')
      assertActivatable(
        store.activeGlobalProfile(),
        profile,
        false,
        '独立评审尚未通过，手机端不能强制启用；请先在电脑上确认风险。',
      )
      const active = await store.activateGlobalProfile(profileId)
      publishEvolutionEvent(store.activeWorkspace() ?? '', 'profile')
      return active
    }
    case 'globalRollback': {
      const profile = await store.rollbackGlobalProfile()
      publishEvolutionEvent(store.activeWorkspace() ?? '', 'profile')
      return profile
    }
    case 'globalDelete': {
      const profileId = String(params['profileId'] ?? '').slice(0, 80)
      await store.deleteGlobalProfile(profileId)
      publishEvolutionEvent(store.activeWorkspace() ?? '', 'profile')
      return { ok: true }
    }
    case 'personalSave': {
      const name = String(params['name'] ?? '').trim().slice(0, 120)
      if (!name) throw new Error('版本名称不能为空')
      const note = String(params['note'] ?? '').trim().slice(0, 500)
      const service = await personalService({ ensureSource: true, ensureBase: true })
      const version = await service.saveVersion({ name, ...(note ? { note } : {}) })
      publishEvolutionEvent(store.activeWorkspace() ?? '', 'evolution')
      return version
    }
    case 'personalRestore': {
      const versionId = String(params['versionId'] ?? '').slice(0, 80)
      if (!versionId) throw new Error('缺少版本编号')
      await (await personalService({ ensureSource: true })).restoreVersion(versionId)
      publishEvolutionEvent(store.activeWorkspace() ?? '', 'evolution')
      return { ok: true }
    }
    case 'personalSubmit': {
      const versionId = String(params['versionId'] ?? '').slice(0, 80)
      const note = String(params['note'] ?? '').trim().slice(0, 1_000)
      if (!versionId) throw new Error('缺少版本编号')
      if (!note) throw new Error('请填写改动说明')
      const record = await (await personalService()).submitVersion(
        versionId,
        note,
        contributionEvidence(),
      )
      publishEvolutionEvent(store.activeWorkspace() ?? '', 'evolution')
      return record
    }
    case 'personalUpgradePlan':
      return (await personalService()).prepareUpgrade()
    case 'personalUpgradeApply': {
      if (personalBusy) throw new Error('已有个人版本任务正在进行')
      personalBusy = 'upgrade'
      try {
        const result = await (await personalService()).applyUpgrade()
        publishEvolutionEvent(store.activeWorkspace() ?? '', 'evolution')
        return result
      } finally {
        personalBusy = null
      }
    }
    case 'personalUpgradeValidate': {
      if (personalBusy) throw new Error('已有个人版本任务正在进行')
      personalBusy = 'validate'
      try {
        const report = await (await personalService()).validateUpgrade()
        publishEvolutionEvent(store.activeWorkspace() ?? '', 'evolution')
        return report
      } finally {
        personalBusy = null
      }
    }
    case 'personalUpgradeRollback':
      await (await personalService()).rollbackUpgrade()
      publishEvolutionEvent(store.activeWorkspace() ?? '', 'evolution')
      return { ok: true }
    case 'personalOpenSource': {
      const prepared = await requirePersonal().openSource()
      await store.addWorkspace(prepared.path, { activate: false })
      const event: RunEvent = { type: 'workspace.changed', workspacePath: prepared.path }
      broadcast(event)
      companion?.publish(event)
      return { path: prepared.path, copied: prepared.copied }
    }
    case 'personalBuild':
      return startPersonalChat(
        '构建个人版',
        '请按 SELF.md 的流程构建我的个人版：先检查当前改动，特别确认官方更新和我的改动在跨文件调用上是否一致（例如某个方法、类型或参数被改后，所有调用方是否同步），然后运行 pnpm typecheck、pnpm test 和 node scripts/self-build.mjs；失败就修到通过，最后告诉我实验版目录和改了什么。',
      )
    case 'personalResolve': {
      const toVersion = String(params['toVersion'] ?? '').slice(0, 40)
      const conflicts = Array.isArray(params['conflicts'])
        ? params['conflicts']
            .filter((item): item is string => typeof item === 'string')
            .slice(0, 40)
            .map((item) => item.slice(0, 2_000))
        : []
      const officialCopyPath = String(params['officialCopyPath'] ?? '').slice(0, 2_000)
      const prompt = officialCopyPath
        ? `官方已经升级到 v${toVersion}，但找不到升级前的官方基线，无法自动合并。新版官方源码已复制到 ${officialCopyPath}，我当前的个人源码在工作区根目录。请逐文件对比，把官方更新迁移进来，同时保留我的改动，并检查跨文件调用是否同步（例如方法、类型或参数变了，所有调用方都要一起改）。完成后运行 pnpm typecheck 和 pnpm test，全部通过后运行 node scripts/self-build.mjs 构建个人版。`
        : `官方已经合并到 v${toVersion}，以下文件还留着冲突标记（<<<<<<< 我的版本 / >>>>>>> 官方 v${toVersion}）：\n${conflicts.join('\n')}\n\n请逐个解决冲突，既保留我的意图也吸收官方更新，并检查跨文件调用是否同步（例如方法、类型或参数变了，所有调用方都要一起改）。然后运行 pnpm typecheck 和 pnpm test，全部通过后运行 node scripts/self-build.mjs 构建个人版，并告诉我改了什么。`
      return startPersonalChat('处理官方更新', prompt)
    }
    case 'personalFix': {
      const details = String(params['details'] ?? '').slice(0, 4_000)
      const toVersion = String(params['toVersion'] ?? '').slice(0, 40)
      return startPersonalChat(
        '修复个人版',
        `我把官方 v${toVersion} 合并进了个人源码，但检查没有通过：\n\n${details}\n\n请定位并修复。重点检查跨文件调用是否一致：官方可能改了方法、类型或参数，而我的改动仍按旧接口调用。修好后运行 pnpm typecheck、pnpm test 和 node scripts/self-build.mjs，最后说明改了什么。`,
      )
    }
    default:
      throw new Error(`手机端不支持该自进化操作：${action}`)
  }
}

  const personalStatus = async (): Promise<{
    state: import('../shared/types').PersonalEvolutionState
    busy: string | null
    hasKey: boolean
  }> => ({
    state: await (await personalService()).state(),
    busy: personalBusy,
    hasKey: Boolean(store.getApiKey()),
  })

  return {
    snapshot: evolutionSnapshot,
    personal: personalStatus,
    action: handleEvolutionAction,
  }
}
