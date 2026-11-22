// 个人服务与自源、自我进化、应用更新、工作区操作与档案（profile）。
// 由 index.ts 的 registerIpc 机械搬出：只把 handle 换成 ctx.handle，其余语句逐字保留。
import type { IpcContext } from '../ipc-context'
import { app, dialog, session, shell } from 'electron'
import { assertActivatable } from '../../core/profile-gate'
import { localizeMain, localizeUpdateState } from '../localize'
import { normalizeSelfSourceSettings, syncSelfSource } from '../self-source-git'
import { openLink } from '../preview'
import { prepareSelfSource } from '../self-source'
import { resolve } from 'node:path'
import { resolveExisting } from '../workspace'
import type { ContributionEvidence, PersonalVersionInput } from '../../shared/types'

export function registerPersonalIpc(ctx: IpcContext): void {


  ctx.handle('pilot:workspace-open', async (path: string) => {
    const workspace = await ctx.store.addWorkspace(path)
    ctx.store.setActiveWorkspace(workspace.path)
    const sessions = ctx.store.sessions(workspace.path)
    ctx.store.setActiveSession(sessions[0]?.id ?? null)
    await ctx.store.save()
    return { workspace, sessions }
  })


  ctx.handle('pilot:workspace-remove', async (path: string) => {
    for (const session of ctx.store.sessions(path)) {
      if (ctx.runner.isRunning(session.id)) await ctx.runner.cancelRun(session.id)
    }
    await ctx.store.removeWorkspace(path)
    if (ctx.store.activeWorkspace()) {
      ctx.store.setActiveSession(ctx.store.sessions(ctx.store.activeWorkspace()!)[0]?.id ?? null)
    } else {
      ctx.store.setActiveSession(null)
    }
    await ctx.store.save()
  })


  ctx.handle('pilot:workspace-reveal', async (path: string) => {
    const target = await resolveExisting(path, '.')
    const error = await shell.openPath(target)
    if (error) throw new Error(error)
  })


  ctx.handle('pilot:self-source-prepare', async () => {
    const prepared = await prepareSelfSource({
      packaged: app.isPackaged,
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      userDataPath: app.getPath('userData'),
    })
    ctx.forgetPersonalService()
    return prepared
  })


  ctx.handle('pilot:personal-state', async () => (await ctx.personalService()).state())

  // Source provenance: which commit the evolution loop is measured against.
  ctx.handle('pilot:self-source-status', async () => (await ctx.resolveSelfSourceCached()).provenance)

  ctx.handle('pilot:self-source-configure', async (input: unknown) => {
    const settings = normalizeSelfSourceSettings(input)
    ctx.store.updateSettings({
      selfSourceMode: settings.mode,
      selfSourceGitUrl: settings.gitUrl,
      selfSourceGitRef: settings.gitRef,
      selfSourceGitPath: settings.gitPath,
      selfSourceCustomPath: settings.customPath,
    })
    // Re-resolve immediately so the panel shows the new baseline without a
    // second round trip; nothing is fetched here.
    ctx.forgetPersonalService()
    return (await ctx.resolveSelfSourceCached()).provenance
  })

  ctx.handle('pilot:self-source-sync', async () => {
    const result = await syncSelfSource(ctx.selfSourceContext())
    // The fetched baseline moved, so the resolved paths and provenance are stale.
    ctx.forgetPersonalService()
    return result
  })

  ctx.handle('pilot:self-source-pick', async (): Promise<string | null> => {
    if (!ctx.mainWindow) return null
    const english = ctx.store.uiLocale() === 'en'
    const result = await dialog.showOpenDialog(ctx.mainWindow, {
      title: english ? 'Choose the Pilot source directory' : '选择 Pilot 源码目录',
      buttonLabel: english ? 'Use this tree' : '使用此目录',
      properties: ['openDirectory'],
    })
    const picked = result.canceled ? '' : (result.filePaths[0] ?? '')
    return picked || null
  })

  ctx.handle('pilot:personal-save-version', async (input: PersonalVersionInput) =>
    (await ctx.personalService({ ensureSource: true, ensureBase: true })).saveVersion(input),
  )

  ctx.handle('pilot:personal-restore-version', async (versionId: string) => {
    await (await ctx.personalService({ ensureSource: true })).restoreVersion(versionId)
  })

  ctx.handle(
    'pilot:personal-submit',
    async (versionId: string, note: string, evidence?: ContributionEvidence) =>
      (await ctx.personalService()).submitVersion(
        versionId,
        note,
        evidence ?? ctx.contributionEvidence(),
      ),
  )

  ctx.handle('pilot:personal-reveal-contribution', async (contributionId: string) => {
    const path = await (await ctx.personalService()).contributionPath(contributionId)
    shell.showItemInFolder(path)
  })

  ctx.handle('pilot:personal-upgrade-plan', async () => (await ctx.personalService()).prepareUpgrade())

  ctx.handle('pilot:personal-upgrade-apply', async () => (await ctx.personalService()).applyUpgrade())

  ctx.handle('pilot:personal-upgrade-validate', async () => (await ctx.personalService()).validateUpgrade())

  ctx.handle('pilot:personal-upgrade-rollback', async () => (await ctx.personalService()).rollbackUpgrade())


  ctx.handle('pilot:workspace-detail', (path: string) => ctx.store.workspaceDetail(path))


  ctx.handle('pilot:evolution-propose', async (path: string) => {
    const profile = await ctx.runner.evolution.propose(path)
    ctx.broadcast({ type: 'profile.changed', workspacePath: path })
    return profile
  })

  ctx.handle('pilot:evolution-run-cycle', async (path: string) => {
    const cycle = await ctx.runner.evolution.runCycle(path, 'manual')
    ctx.broadcast({ type: 'evolution.changed', workspacePath: path })
    if (cycle.activated) ctx.broadcast({ type: 'profile.changed', workspacePath: path })
    return cycle
  })

  ctx.handle('pilot:evolution-improve-policy', async () => {
    const path = ctx.store.activeWorkspace()
    if (!path) throw new Error('No workspace is open')
    const version = await ctx.runner.evolution.improvePolicy(path)
    ctx.broadcast({ type: 'evolution.changed', workspacePath: path })
    return version
  })

  ctx.handle('pilot:evolution-policy-rollback', async () => {
    const version = await ctx.store.rollbackEvolutionPolicy()
    ctx.broadcast({
      type: 'evolution.changed',
      workspacePath: ctx.store.activeWorkspace() ?? '',
    })
    return version
  })

  ctx.handle('pilot:evolution-clear-history', async () => {
    await ctx.store.clearEvolutionHistory()
    ctx.broadcast({
      type: 'evolution.changed',
      workspacePath: ctx.store.activeWorkspace() ?? '',
    })
  })

  ctx.handle('pilot:profile-review', async (path: string, profileId: string) => {
    const result = await ctx.runner.evolution.review(path, profileId)
    ctx.broadcast({ type: 'profile.changed', workspacePath: path })
    return result
  })

  ctx.handle('pilot:profile-benchmark', async (path: string, profileId: string) => {
    const run = await ctx.runner.evolution.benchmark(path, profileId)
    // Persist the measured outcome and recompute the activation gate, so a
    // measured regression (or a tie that proves nothing) cannot be overridden
    // by an older rubric score. `recordBenchmark` also stores which two version
    // ids were compared, so a later rollback cannot reuse stale numbers.
    const comparison = await ctx.runner.evolution.recordBenchmark('workspace', path, profileId, run)
    ctx.broadcast({ type: 'profile.changed', workspacePath: path })
    return { comparison, rows: ctx.benchmarkRows(run.samples) }
  })

  ctx.handle(
    'pilot:profile-activate',
    async (path: string, profileId: string, force?: boolean) => {
      const detail = ctx.store.workspaceDetail(path)
      const profile = detail.profiles.find((entry) => entry.id === profileId)
      if (!profile) throw new Error('Profile not found')
      assertActivatable(
        ctx.store.activeProfile(path),
        profile,
        force === true,
        '独立评审尚未通过',
      )
      const active = await ctx.store.activateProfile(path, profileId)
      ctx.broadcast({ type: 'profile.changed', workspacePath: path })
      return active
    },
  )

  ctx.handle('pilot:profile-rollback', async (path: string) => {
    const profile = await ctx.store.rollbackProfile(path)
    ctx.broadcast({ type: 'profile.changed', workspacePath: path })
    return profile
  })

  ctx.handle('pilot:profile-delete', async (path: string, profileId: string) => {
    await ctx.store.deleteProfile(path, profileId)
    ctx.broadcast({ type: 'profile.changed', workspacePath: path })
  })


  ctx.handle('pilot:evolution-promote-global', async (path: string, profileId: string) => {
    const profile = await ctx.runner.evolution.promote(path, profileId)
    ctx.broadcastGlobalProfileChanged()
    return profile
  })

  ctx.handle(
    'pilot:profile-localize',
    async (scope: 'workspace' | 'global', path: string, profileId: string) => {
      const profile = await ctx.runner.evolution.localize(scope, path, profileId)
      if (scope === 'global') ctx.broadcastGlobalProfileChanged()
      else ctx.broadcast({ type: 'profile.changed', workspacePath: path })
      return profile
    },
  )

  ctx.handle(
    'pilot:profile-explain',
    async (scope: 'workspace' | 'global', path: string, profileId: string) => {
      const profile = await ctx.runner.evolution.explain(scope, path, profileId)
      if (scope === 'global') ctx.broadcastGlobalProfileChanged()
      else ctx.broadcast({ type: 'profile.changed', workspacePath: path })
      return profile
    },
  )

  ctx.handle('pilot:global-profile-review', async (profileId: string) => {
    const result = await ctx.runner.evolution.reviewGlobal(profileId)
    ctx.broadcastGlobalProfileChanged()
    return result
  })

  ctx.handle('pilot:global-profile-benchmark', async (profileId: string) => {
    const run = await ctx.runner.evolution.benchmarkGlobal(profileId)
    const comparison = await ctx.runner.evolution.recordBenchmark('global', '', profileId, run)
    ctx.broadcastGlobalProfileChanged()
    return { comparison, rows: ctx.benchmarkRows(run.samples) }
  })

  ctx.handle(
    'pilot:global-profile-activate',
    async (profileId: string, force?: boolean) => {
      const profile = ctx.store.globalProfile(profileId)
      if (!profile) throw new Error('Global profile not found')
      assertActivatable(
        ctx.store.activeGlobalProfile(),
        profile,
        force === true,
        'The independent review did not pass. Use "Enable anyway" only if you accept the noted risks.',
      )
      const active = await ctx.store.activateGlobalProfile(profileId)
      ctx.broadcastGlobalProfileChanged()
      return active
    },
  )

  ctx.handle('pilot:global-profile-rollback', async () => {
    const profile = await ctx.store.rollbackGlobalProfile()
    ctx.broadcastGlobalProfileChanged()
    return profile
  })

  ctx.handle('pilot:global-profile-delete', async (profileId: string) => {
    await ctx.store.deleteGlobalProfile(profileId)
    ctx.broadcastGlobalProfileChanged()
  })


  ctx.handle('pilot:self-check-run', () => ctx.collectSelfCheck())

  ctx.handle('pilot:open-link', async (url: string, external?: boolean) => {
    await openLink(url, { external, activeRoot: () => ctx.store.activeWorkspace() })
  })


  ctx.handle('pilot:update-state', () => localizeUpdateState(ctx.updater.stateSnapshot(), ctx.store.uiLocale()))

  ctx.handle('pilot:update-check', async () =>
    localizeUpdateState(await ctx.updater.check(), ctx.store.uiLocale()),
  )

  ctx.handle('pilot:update-download', async () =>
    localizeUpdateState(await ctx.updater.download(), ctx.store.uiLocale()),
  )

  ctx.handle('pilot:update-install', async () => {
    try {
      await ctx.updater.install()
    } catch (error) {
      throw new Error(localizeMain(error instanceof Error ? error.message : String(error), ctx.store.uiLocale()))
    }
  })
}
