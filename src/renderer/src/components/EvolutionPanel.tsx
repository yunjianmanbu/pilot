import { useCallback, useEffect, useState } from 'react'
import type {
  EvolutionCycle,
  EvolutionPolicyVersion,
  PersonalContribution,
  PersonalEvolutionState,
  PersonalUpgradePlan,
  PersonalUpgradeReport,
  PersonalUpgradeResult,
  PersonalVersion,
  PersonalVersionInput,
  ProfileBenchmarkReport,
  ProfileVersion,
  ReviewProfileResult,
  WorkspaceDetail,
  WorkspaceSummary,
} from '../../../shared/types'

import { DEFAULT_EVOLUTION_POLICY } from '../../../shared/evolution'
import { ProfileDecision } from './ProfileDecision'
import { SelfSourceSection } from './SelfSourceSection'
import {
  ArrowUpRightIcon,
  BrainIcon,
  CheckIcon,
  ClockIcon,
  DownloadIcon,
  FilesIcon,
  InfoIcon,
  RefreshIcon,
  SparkIcon,
  TerminalIcon,
  TrashIcon,
} from '../icons'
import { formatRelative } from '../ui'
import { t } from '../i18n'
import {
  HISTORY_PREVIEW,
  changeSummary,
  contributionStatusLabel,
  cycleTone,
  isReady,
  needsChinese,
  scoreTone,
  sourceLabel,
} from './evolution/shared'
import { CycleTimeline, EvidenceGrid, ProfileCard, RunsTable } from './evolution/cards'

export { BenchmarkCard } from './evolution/cards'

export function EvolutionPanel({
  workspace,
  detail,
  hasKey,
  autoEvolve,
  onToggleAutoEvolve,
  onRunEvolution,
  onImproveEvolution,
  onRollbackEvolutionPolicy,
  onClearHistory,
  onPropose,
  onReview,
  onBenchmark,
  onActivate,
  onRollback,
  onDelete,
  onPromote,
  onLocalize,
  onExplainProfile,
  onBenchmarkGlobal,
  onReviewGlobal,
  onActivateGlobal,
  onRollbackGlobal,
  onDeleteGlobal,
  onOpenSelfSource,
  onChatSelfSource,
  onLoadPersonal,
  onSavePersonalVersion,
  onRestorePersonalVersion,
  onSubmitPersonalVersion,
  onRevealPersonalContribution,
  onAskBuild,
  onPreparePersonalUpgrade,
  onApplyPersonalUpgrade,
  onValidatePersonalUpgrade,
  onRollbackPersonalUpgrade,
  onAskResolveUpgrade,
  onAskFixUpgrade,
  onError,
  onOpenSettings,
}: {
  workspace: WorkspaceSummary | null
  detail: WorkspaceDetail | null
  hasKey: boolean
  autoEvolve: boolean
  onToggleAutoEvolve: (value: boolean) => Promise<void>
  onRunEvolution: () => Promise<EvolutionCycle>
  onImproveEvolution: () => Promise<EvolutionPolicyVersion | null>
  onRollbackEvolutionPolicy: () => Promise<EvolutionPolicyVersion | null>
  /** Remove every stored evolution record; the active policy version survives. */
  onClearHistory: () => Promise<void>
  onPropose: () => Promise<void>
  onReview: (profileId: string) => Promise<ReviewProfileResult>
  onBenchmark: (profileId: string) => Promise<ProfileBenchmarkReport>
  onActivate: (profileId: string, force?: boolean) => Promise<void>
  onRollback: () => Promise<void>
  onDelete: (profileId: string) => Promise<void>
  onPromote: (profileId: string) => Promise<ProfileVersion>
  onLocalize: (profileId: string, scope: 'workspace' | 'global') => Promise<ProfileVersion>
  onExplainProfile: (profileId: string, scope: 'workspace' | 'global') => Promise<ProfileVersion>
  onBenchmarkGlobal: (profileId: string) => Promise<ProfileBenchmarkReport>
  onReviewGlobal: (profileId: string) => Promise<ReviewProfileResult>
  onActivateGlobal: (profileId: string, force?: boolean) => Promise<void>
  onRollbackGlobal: () => Promise<void>
  onDeleteGlobal: (profileId: string) => Promise<void>
  onOpenSelfSource: () => Promise<void>
  onChatSelfSource: () => Promise<void>
  onLoadPersonal: () => Promise<PersonalEvolutionState>
  onSavePersonalVersion: (input: PersonalVersionInput) => Promise<PersonalVersion>
  onRestorePersonalVersion: (versionId: string) => Promise<void>
  onSubmitPersonalVersion: (versionId: string, note: string) => Promise<PersonalContribution>
  onRevealPersonalContribution: (contributionId: string) => Promise<void>
  onAskBuild: (sourcePath: string) => Promise<void>
  onPreparePersonalUpgrade: () => Promise<PersonalUpgradePlan>
  onApplyPersonalUpgrade: () => Promise<PersonalUpgradeResult>
  onValidatePersonalUpgrade: () => Promise<PersonalUpgradeReport>
  onRollbackPersonalUpgrade: () => Promise<void>
  onAskResolveUpgrade: (
    sourcePath: string,
    conflicts: string[],
    toVersion: string,
    officialCopyPath?: string,
  ) => Promise<void>
  onAskFixUpgrade: (
    sourcePath: string,
    details: string,
    toVersion: string,
  ) => Promise<void>
  onError: (message: string) => void
  /** Jump to the settings section that configures independent reviewer models. */
  onOpenSettings?: () => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [showAllCycles, setShowAllCycles] = useState(false)
  const [personalBusy, setPersonalBusy] = useState<string | null>(null)
  const [personal, setPersonal] = useState<PersonalEvolutionState | null>(null)
  const profiles = detail?.profiles ?? []
  const active = detail?.activeProfile ?? null
  const drafts = profiles.filter((profile) => profile.status === 'draft')
  const retired = profiles.filter((profile) => profile.status === 'retired')
  const globalProfiles = detail?.globalProfiles ?? []
  const activeGlobal = detail?.activeGlobalProfile ?? null
  const globalDrafts = globalProfiles.filter((profile) => profile.status === 'draft')
  const globalRetired = globalProfiles.filter((profile) => profile.status === 'retired')
  /**
   * The version the active profile replaced, so the active card can say what
   * changed for the user, not just what rules are in force.
   */
  const previousProfile = active
    ? ([...profiles]
        .filter((profile) => profile.id !== active.id && profile.version < active.version)
        .sort((a, b) => b.version - a.version)[0] ?? null)
    : null
  const previousGlobalProfile = activeGlobal
    ? ([...globalProfiles]
        .filter((profile) => profile.id !== activeGlobal.id && profile.version < activeGlobal.version)
        .sort((a, b) => b.version - a.version)[0] ?? null)
    : null
  const runs = detail?.runs ?? []
  const completed = runs.filter((run) => run.status !== 'running')
  const failures = completed.filter((run) =>
    ['failed', 'cancelled', 'interrupted', 'max_steps'].includes(run.status),
  ).length
  const avgSteps =
    completed.length > 0
      ? completed.reduce((sum, run) => sum + run.steps, 0) / completed.length
      : 0
  const canPropose = Boolean(workspace) && hasKey && completed.length >= 3
  const policy = detail?.evolution.policy ?? DEFAULT_EVOLUTION_POLICY
  const cycles = detail?.evolution.cycles ?? []
  const lastCycle = cycles[0] ?? null
  /**
   * Records are kept until the user clears them, so the panel cannot simply
   * dump everything. The default view ranks by the reviewer score and shows the
   * best 20; "show all" reveals the remaining rounds in the same order.
   */
  const rankedCycles = [...cycles].sort((left, right) => {
    const leftScore = typeof left.score === 'number' ? left.score : -1
    const rightScore = typeof right.score === 'number' ? right.score : -1
    if (rightScore !== leftScore) return rightScore - leftScore
    return right.startedAt.localeCompare(left.startedAt)
  })
  const visibleCycles = showAllCycles ? rankedCycles : rankedCycles.slice(0, HISTORY_PREVIEW)
  const policyVersions = detail?.evolution.policyVersions ?? []
  const activePolicyVersion = policyVersions.find((version) => version.status === 'active') ?? null
  const canRollbackPolicy = policyVersions.some(
    (version) => version.status === 'retired' && version.activatedAt,
  )
  const canRunCycle = Boolean(workspace) && hasKey && completed.length >= policy.minRuns

  const runCycle = async () => {
    if (busy) return
    setBusy('cycle')
    try {
      await onRunEvolution()
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }

  const toggleAuto = async () => {
    if (busy) return
    setBusy('auto-toggle')
    try {
      await onToggleAutoEvolve(!autoEvolve)
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }

  const improveFlow = async () => {
    if (
      !window.confirm(
        t("让 Pilot 调整自己的进化流程？\n\n它会根据历史轮次提出新的节奏与阈值，交给独立模型评审，通过后自动启用。所有数值都有硬上限，你随时可以回滚。"),
      )
    ) {
      return
    }
    setBusy('meta')
    try {
      await onImproveEvolution()
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }

  const rollbackPolicy = async () => {
    if (!window.confirm(t("回滚到上一个进化机制版本？当前版本的节奏和阈值会退役，但不会被删除。"))) {
      return
    }
    setBusy('policy-rollback')
    try {
      await onRollbackEvolutionPolicy()
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }

  const clearHistory = async () => {
    if (
      !window.confirm(
        t(
          "清理全部进化记录？历次进化轮次与已退役的版本都会被删除，当前生效的机制保留不变。此操作不可撤销。",
        ),
      )
    ) {
      return
    }
    setBusy('clear-history')
    try {
      await onClearHistory()
      setShowAllCycles(false)
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }

  const propose = async () => {
    if (busy) return
    setBusy('propose')
    try {
      await onPropose()
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }

  const openSelfSource = async () => {
    if (busy) return
    setBusy('self-source')
    try {
      await onOpenSelfSource()
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }

  const chatSelfSource = async () => {
    if (busy) return
    setBusy('self-source')
    try {
      await onChatSelfSource()
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }

  const refreshPersonal = useCallback(async () => {
    try {
      setPersonal(await onLoadPersonal())
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [onError, onLoadPersonal])

  useEffect(() => {
    void refreshPersonal()
  }, [refreshPersonal])

  const refreshPersonalNow = async () => {
    if (personalBusy) return
    setPersonalBusy('refresh')
    try {
      await refreshPersonal()
    } finally {
      setPersonalBusy(null)
    }
  }

  const savePersonal = async () => {
    if (personalBusy) return
    const fallback = new Date().toLocaleString()
    const name = window.prompt(t("给这个个人版本起个名字"), t("我的版本 {v1}", { v1: fallback }))
    if (!name?.trim()) return
    const note = window.prompt(t("说明你希望这个版本改进什么（可留空）"), '') ?? ''
    setPersonalBusy('save')
    try {
      const version = await onSavePersonalVersion({ name: name.trim(), note: note.trim() })
      await refreshPersonal()
      window.alert(
        version.buildPath
          ? t("已保存版本“{v1}”，共 {v2} 个文件改动；已关联最新实验版。", {
              v1: version.name,
              v2: version.files.length,
            })
          : t("已保存版本“{v1}”，共 {v2} 个文件改动。让 Pilot 构建个人版后会关联新的实验版。", {
              v1: version.name,
              v2: version.files.length,
            }),
      )
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setPersonalBusy(null)
    }
  }

  const askBuild = async () => {
    if (personalBusy || !personal?.available || !hasKey) return
    setPersonalBusy('build')
    try {
      await onAskBuild(personal.sourcePath)
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setPersonalBusy(null)
    }
  }

  const validationText = (report: PersonalUpgradeReport): string =>
    [report.message, report.output ? report.output.slice(-1_500) : ''].filter(Boolean).join('\n\n')

  const runValidation = async () => {
    if (personalBusy) return
    setPersonalBusy('validate')
    try {
      const report = await onValidatePersonalUpgrade()
      await refreshPersonal()
      window.alert(
        report.validation === 'passed'
          ? t("检查通过：typecheck 和测试都通过了。")
          : t("检查未完成：{v1}\n\n{v2}", {
              v1: report.message ?? '',
              v2: report.output ? report.output.slice(-1_500) : '',
            }),
      )
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setPersonalBusy(null)
    }
  }

  const fixUpgrade = async () => {
    const report = personal?.lastUpgrade
    if (!report) return
    if (
      !window.confirm(
        t("让 Pilot 检查并修复合并结果？它会在聊天里读取 typecheck/测试输出，处理跨文件调用不一致，然后重新构建个人版。"),
      )
    ) {
      return
    }
    await onAskFixUpgrade(personal.sourcePath, validationText(report), report.toVersion)
  }

  const rollbackMerge = async () => {
    if (personalBusy || !personal?.lastUpgrade) return
    if (
      !window.confirm(
        t("撤销上次合并？\n\n会恢复合并前自动备份的文件；合并后你对这些文件的修改会丢失。源码回到旧基线，官方更新仍可再次合并。"),
      )
    ) {
      return
    }
    setPersonalBusy('rollback')
    try {
      await onRollbackPersonalUpgrade()
      await refreshPersonal()
      window.alert(t("已撤销合并，个人源码已恢复到合并前。"))
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setPersonalBusy(null)
    }
  }

  const mergeUpgrade = async () => {
    if (personalBusy || !personal?.available) return
    setPersonalBusy('upgrade')
    try {
      const plan = await onPreparePersonalUpgrade()
      if (!plan.available) {
        await refreshPersonal()
        return
      }
      if (plan.requiresManual) {
        if (
          window.confirm(
            t(
              "官方已经升级到 v{v1}，但找不到升级前保存的官方基线，无法自动合并。\n\n新版官方源码会复制到 .pilot-upgrade/official，然后让 Pilot 对照迁移，并保留你的改动。继续？",
              { v1: plan.toVersion },
            ),
          )
        ) {
          await onAskResolveUpgrade(
            personal.sourcePath,
            [],
            plan.toVersion,
            plan.officialCopyPath ?? '.pilot-upgrade/official',
          )
        }
        return
      }
      if (
        !window.confirm(
          t(
            "把官方 v{v1} 合并进你的个人源码：\n\n官方更新 {v2} 个文件，保留你的改动 {v3} 个，自动合并 {v4} 个，冲突 {v5} 个。\n\n合并前会自动备份当前个人源码。继续？",
            {
              v1: plan.toVersion,
              v2: plan.counts.upstream,
              v3: plan.counts.kept,
              v4: plan.counts.merged,
              v5: plan.counts.conflicts,
            },
          ),
        )
      ) {
        return
      }
      const result = await onApplyPersonalUpgrade()
      await refreshPersonal()
      window.alert(
        t(
          "已合并官方 v{v1}：写入 {v2} 个文件，自动合并 {v3} 个，冲突 {v4} 个。\n\n合并前的个人源码备份在：{v5}",
          {
            v1: result.toVersion,
            v2: result.applied,
            v3: result.merged,
            v4: result.conflicts.length,
            v5: result.backupPath,
          },
        ),
      )
      if (result.conflicts.length > 0) {
        if (
          window.confirm(
            t("有 {v1} 个文件还留着冲突标记。现在让 Pilot 合并它们？", {
              v1: result.conflicts.length,
            }),
          )
        ) {
          await onAskResolveUpgrade(
            personal.sourcePath,
            result.conflicts.map((conflict) => conflict.path),
            result.toVersion,
          )
        }
        return
      }
      // Textual merging cannot see cross-file semantics; gate the result.
      const report = await onValidatePersonalUpgrade()
      await refreshPersonal()
      if (report.validation === 'passed') {
        if (
          window.confirm(
            t("官方更新已合并，typecheck 和测试都通过。现在让 Pilot 重新构建个人版？"),
          )
        ) {
          await onAskBuild(personal.sourcePath)
        }
      } else if (report.validation === 'failed') {
        if (
          window.confirm(
            t(
              "官方更新已合并，但检查没有通过，可能存在跨文件调用不一致。现在让 Pilot 修复？",
            ),
          )
        ) {
          await onAskFixUpgrade(personal.sourcePath, validationText(report), result.toVersion)
        }
      } else {
        window.alert(
          t("官方更新已合并。{v1}\n\n接下来让 Pilot 安装依赖、运行测试并构建个人版。", {
            v1: report.message ?? '',
          }),
        )
        if (window.confirm(t("现在让 Pilot 构建并验证个人版？"))) {
          await onAskBuild(personal.sourcePath)
        }
      }
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setPersonalBusy(null)
    }
  }

  const restorePersonal = async (version: PersonalVersion) => {
    if (
      !window.confirm(
        t("把源码恢复到这个版本？\n\n只回写该版本记录的 {v1} 个文件；之后新增的其他改动会保留。", {
          v1: version.files.length,
        }),
      )
    ) {
      return
    }
    setPersonalBusy(`restore:${version.id}`)
    try {
      await onRestorePersonalVersion(version.id)
      await refreshPersonal()
      window.alert(t("已恢复到“{v1}”。", { v1: version.name }))
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setPersonalBusy(null)
    }
  }

  const submitPersonal = async (version: PersonalVersion) => {
    const note = window.prompt(
      t("向官方说明这个改动的价值（会附在贡献包里）"),
      version.note || version.name,
    )
    if (!note?.trim()) return
    if (
      !version.buildPath &&
      !window.confirm(
        t("这个版本还没有构建和测试过。跨文件逻辑可能在合并或改动后不一致，确认现在提交？"),
      )
    ) {
      return
    }
    if (
      personal?.uploadEndpoint &&
      !window.confirm(
        t("把这个版本的源码改动、提交说明和进化摘要上传到官方？\n\n不会上传工作区文件、会话或 API Key。上传后仍由维护者决定是否采纳。"),
      )
    ) {
      return
    }
    setPersonalBusy(`submit:${version.id}`)
    try {
      const record = await onSubmitPersonalVersion(version.id, note.trim())
      await refreshPersonal()
      if (record.status === 'uploaded') {
        window.alert(t("已提交官方。贡献包编号：{v1}", { v1: record.id }))
      } else if (record.status === 'failed') {
        window.alert(
          t("上传失败：{v1}\n\n贡献包已保存在：{v2}\n可以打开所在位置后手动发送。", {
            v1: record.error ?? t("未知错误"),
            v2: record.path,
          }),
        )
      } else {
        window.alert(
          t("贡献包已生成：{v1}\n\n当前没有配置官方上传通道，可以打开所在位置后通过官方渠道发送。", {
            v1: record.path,
          }),
        )
      }
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setPersonalBusy(null)
    }
  }

  const revealContribution = async (contribution: PersonalContribution) => {
    try {
      await onRevealPersonalContribution(contribution.id)
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const review = async (profile: ProfileVersion) => {
    const key = `review:${profile.id}`
    setBusy(key)
    try {
      const result = await onReview(profile.id)
      if (result.activated) {
        window.alert(
          t("评审通过（{v1} 分），版本 v{v2} 已自动启用。", { v1: result.profile.review?.score ?? 0, v2: result.profile.version }),
        )
      } else if (result.profile.review?.pass && !isReady(result.profile.review)) {
        window.alert(
          t("评审通过（{v1} 分），但还不能切换：\n{v2}", {
            v1: result.profile.review.score,
            v2: (result.profile.review.activation?.reasons ?? []).join('\n'),
          }),
        )
      } else {
        window.alert(
          t("评审未通过（{v1} 分）。\n\n{v2}", { v1: result.profile.review?.score ?? 0, v2: result.profile.review?.notes ?? '' }),
        )
      }
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }

  /**
   * Run the paired benchmark and report what actually differed. The result is
   * shown in the review card afterwards; the dialog here is only the summary so
   * a user who never opens the card still learns the verdict.
   */
  const benchmark = async (profile: ProfileVersion, global = false) => {
    const key = `benchmark:${profile.id}`
    setBusy(key)
    try {
      const report = global
        ? await onBenchmarkGlobal(profile.id)
        : await onBenchmark(profile.id)
      const { comparison } = report
      const label =
        comparison.verdict === 'better'
          ? t('实测更优')
          : comparison.verdict === 'worse'
            ? t('实测更差')
            : comparison.verdict === 'inconclusive'
              ? t('实测无明显差异')
              : t('样本不足')
      window.alert(
        t('{v1}\n候选 {v2} 胜 / {v3} 负 / {v4} 平\n\n{v5}', {
          v1: label,
          v2: comparison.wins,
          v3: comparison.losses,
          v4: comparison.ties,
          v5: comparison.reasons.join('\n'),
        }),
      )
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      // A missing key is the likeliest reason a benchmark cannot start, and the fix
      // sits one screen away; send the user to the reviewer section instead of a
      // dead-end toast.
      if (/api key/i.test(message)) {
        onError(t('实测对比需要一个可用的模型密钥，先在设置里配置。'))
        onOpenSettings?.()
      } else {
        onError(message)
      }
    } finally {
      setBusy(null)
    }
  }

  const activate = async (profile: ProfileVersion, force: boolean) => {
    if (
      force &&
      !window.confirm(
        t("以风险自担方式启用 v{v1}？\n\n独立评审未通过或尚未通过时，强制启用可能让后续运行退化。你随时可以回滚。", { v1: profile.version }),
      )
    ) {
      return
    }
    const key = `activate:${profile.id}`
    setBusy(key)
    try {
      await onActivate(profile.id, force)
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }

  const remove = async (profile: ProfileVersion) => {
    if (!window.confirm(t("删除候选版本 v{v1}？", { v1: profile.version }))) return
    const key = `delete:${profile.id}`
    setBusy(key)
    try {
      await onDelete(profile.id)
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }

  const promote = async (profile: ProfileVersion) => {
    if (
      !window.confirm(
        t("把工作区画像 v{v1} 提升为全局候选？\n\nPilot 会把项目专属规则泛化成跨项目规则，生成一份全局草稿；它仍需独立评审和你的手动启用。", { v1: profile.version }),
      )
    ) {
      return
    }
    const key = `promote:${profile.id}`
    setBusy(key)
    try {
      const draft = await onPromote(profile.id)
      window.alert(t("已生成全局候选 v{v1}。请先做独立评审，再手动启用。", { v1: draft.version }))
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }

  const explain = async (profile: ProfileVersion, scope: 'workspace' | 'global') => {
    const key = `explain:${profile.id}`
    setBusy(key)
    try {
      await onExplainProfile(profile.id, scope)
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }

  const localize = async (profile: ProfileVersion, scope: 'workspace' | 'global') => {
    if (
      !window.confirm(
        t("为 v{v1} 生成中文版本？\n\nPilot 会生成一份新的中文草稿，不会修改或停用当前版本；草稿仍需独立评审后才能启用。命令、路径、工具名和代码标识会保持原样。", { v1: profile.version }),
      )
    ) {
      return
    }
    const key = `localize:${profile.id}`
    setBusy(key)
    try {
      const draft = await onLocalize(profile.id, scope)
      window.alert(t("已生成中文版本 v{v1}（草稿）。它不会自动启用。", { v1: draft.version }))
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }

  const reviewGlobal = async (profile: ProfileVersion) => {
    const key = `review:${profile.id}`
    setBusy(key)
    try {
      const result = await onReviewGlobal(profile.id)
      if (result.profile.review?.pass && isReady(result.profile.review)) {
        window.alert(
          t("全局评审通过（{v1} 分）。\n\n全局规则影响所有工作区，不会自动启用；请确认后手动启用 v{v2}。", { v1: result.profile.review.score, v2: result.profile.version }),
        )
      } else if (result.profile.review?.pass) {
        window.alert(
          t("全局评审通过（{v1} 分），但还不能切换：\n{v2}", {
            v1: result.profile.review.score,
            v2: (result.profile.review.activation?.reasons ?? []).join('\n'),
          }),
        )
      } else {
        window.alert(
          t("全局评审未通过（{v1} 分）。\n\n{v2}", { v1: result.profile.review?.score ?? 0, v2: result.profile.review?.notes ?? '' }),
        )
      }
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }

  const activateGlobal = async (profile: ProfileVersion, force: boolean) => {
    if (
      force &&
      !window.confirm(
        t("以风险自担方式启用全局画像 v{v1}？\n\n它会应用到所有工作区；评审未通过时可能让多个项目一起退化。你随时可以回滚。", { v1: profile.version }),
      )
    ) {
      return
    }
    const key = `activate:${profile.id}`
    setBusy(key)
    try {
      await onActivateGlobal(profile.id, force)
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }

  const removeGlobal = async (profile: ProfileVersion) => {
    if (!window.confirm(t("删除全局候选版本 v{v1}？", { v1: profile.version }))) return
    const key = `delete:${profile.id}`
    setBusy(key)
    try {
      await onDeleteGlobal(profile.id)
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }

  const rollbackGlobal = async () => {
    if (
      !window.confirm(
        t("回滚到上一个全局版本？当前全局版本会退役，但不会被删除；所有工作区都会受到影响。"),
      )
    ) {
      return
    }
    setBusy('global-rollback')
    try {
      await onRollbackGlobal()
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }

  const rollback = async () => {
    if (!window.confirm(t("回滚到上一个已启用的版本？当前版本会退役，但不会被删除。"))) return
    setBusy('rollback')
    try {
      await onRollback()
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="page panel-page">
      <div className="page-head">
        <div>
          <div className="page-eyebrow">
            <SparkIcon width={13} height={13} />
            {t("自学习循环")}</div>
          <h1>{t("自我进化")}</h1>
          <p>
            {t("Pilot 从真实运行中反思，提出行为改进；每个版本都要经过独立模型评审，通过后才会生效，并且随时可回滚。")}</p>
        </div>
        <div className="stat-strip">
          <div className="stat">
            <strong>{completed.length}</strong>
            <span>{t("次运行")}</span>
          </div>
          <div className="stat">
            <strong>{failures}</strong>
            <span>{t("次异常")}</span>
          </div>
          <div className="stat">
            <strong>{avgSteps.toFixed(1)}</strong>
            <span>{t("平均步数")}</span>
          </div>
          <div className="stat">
            <strong>{active ? `v${active.version}` : t("内置默认")}</strong>
            <span>{t("当前版本")}</span>
          </div>
        </div>
      </div>

      <div className="evolution-flow">
        <div>
          <span>01</span>
          <strong>{t("真实运行")}</strong>
          <p>{t("每次任务记录步数、工具错误、tokens 和你的反馈。")}</p>
        </div>
        <div>
          <span>02</span>
          <strong>{t("反思与提案")}</strong>
          <p>{t("模型基于证据提出提示词增补和策略调整，而不是随意改写代码。")}</p>
        </div>
        <div>
          <span>03</span>
          <strong>{t("独立评审")}</strong>
          <p>{t("另一个模型会话按 100 分制审查，≥ 75 分才自动启用。")}</p>
        </div>
        <div>
          <span>04</span>
          <strong>{t("可回滚")}</strong>
          <p>{t("旧版本保留为历史；效果变差可以一键退回。")}</p>
        </div>
      </div>

      <section className="evolution-section system-evolution">
        <div className="evolution-section-head">
          <div>
            <h2>{t("系统级自动进化")}</h2>
            <p>
              {t("不需要写代码。Pilot 自动收集近期任务、提出改进、交给独立模型评审；通过后自动启用，失败率明显上升时自动回滚。")}</p>
          </div>
          <div className="section-actions">
            <label className={`toggle-inline${autoEvolve ? ' is-on' : ''}`}>
              <input
                type="checkbox"
                checked={autoEvolve}
                disabled={busy === 'auto-toggle'}
                onChange={() => void toggleAuto()}
              />
              <span>{autoEvolve ? t("自动运行已开启") : t("自动运行已关闭")}</span>
            </label>
            <button
              type="button"
              className="button primary small"
              onClick={() => void runCycle()}
              disabled={!canRunCycle || busy === 'cycle'}
              title={
                !hasKey
                  ? t("需要先配置 API Key")
                  : completed.length < policy.minRuns
                    ? t("至少需要 {v1} 次运行记录", { v1: policy.minRuns })
                    : t("立即运行一轮系统进化")
              }
            >
              {busy === 'cycle' ? <i className="spinner" /> : <SparkIcon width={14} height={14} />}
              {busy === 'cycle' ? t("进化中…") : t("立即进化")}
            </button>
          </div>
        </div>

        {lastCycle ? (
          <CycleTimeline cycle={lastCycle} />
        ) : (
          <div className="empty-panel compact">
            <SparkIcon width={22} height={22} />
            <strong>{t("还没有运行过系统进化")}</strong>
            <span>
              {t("完成至少 {v1} 次任务后，可以点“立即进化”，或开启自动运行让 Pilot 自己开始。", { v1: policy.minRuns })}</span>
          </div>
        )}

        <div className="policy-card">
          <div className="policy-card-head">
            <span className="profile-version small">
              {activePolicyVersion ? `v${activePolicyVersion.version}` : t("内置默认")}
            </span>
            <span className="profile-source">{t("进化机制")}</span>
            <span className="muted">
              {t("每 {v1} 次运行 · 评审 ≥ {v2} 分 · 观察 {v3} 次", {
                v1: policy.cooldownRuns,
                v2: policy.reviewScore,
                v3: policy.watchRuns,
              })}
            </span>
          </div>
          <div className="policy-chips">
            <span>{policy.autoApply ? t("评审通过后自动启用") : t("评审通过后手动启用")}</span>
            <span>{t("证据窗口 {v1} 次", { v1: policy.evidenceRuns })}</span>
            <span>{t("失败率上升 {v1} 个百分点即回滚", { v1: policy.regressionDelta })}</span>
            <span>{t("每 {v1} 轮自检一次流程", { v1: policy.metaEvery })}</span>
          </div>
          {policy.focus ? (
            <p className="policy-focus">{t("当前进化重点：{v1}", { v1: policy.focus })}</p>
          ) : null}
          {activePolicyVersion?.review ? (
            <div className={`review-card review-${activePolicyVersion.review.pass ? 'pass' : 'fail'}`}>
              <div className={`review-score tone-${scoreTone(activePolicyVersion.review.score)}`}>
                <strong>{activePolicyVersion.review.score}</strong>
                <span>/ 100</span>
              </div>
              <div className="review-body">
                <div className="review-head">
                  <span>{t("流程评审")}</span>
                  <span className="review-model">{activePolicyVersion.review.model}</span>
                  <span className="review-date">
                    {formatRelative(activePolicyVersion.review.at)}
                  </span>
                </div>
                <p>{activePolicyVersion.review.notes}</p>
                {activePolicyVersion.review.risks.length > 0 ? (
                  <ul className="review-risks">
                    {activePolicyVersion.review.risks.map((risk, index) => (
                      <li key={`${index}-${risk.slice(0, 12)}`}>{risk}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </div>
          ) : null}
          {activePolicyVersion ? (
            <details className="prompt-addendum">
              <summary>{t("查看本次流程调整理由")}</summary>
              <pre>{activePolicyVersion.rationale}</pre>
            </details>
          ) : null}
          <div className="profile-actions">
            <button
              type="button"
              className="button ghost small"
              onClick={() => void improveFlow()}
              disabled={busy === 'meta' || !workspace}
              title={workspace ? t("让 Pilot 根据历史轮次调整自己的阈值与节奏") : t("需要先打开工作区")}
            >
              {busy === 'meta' ? <i className="spinner" /> : <SparkIcon width={14} height={14} />}
              {busy === 'meta' ? t("调整中…") : t("改进进化机制")}
            </button>
            {canRollbackPolicy ? (
              <button
                type="button"
                className="button ghost small"
                onClick={() => void rollbackPolicy()}
                disabled={busy === 'policy-rollback'}
              >
                {busy === 'policy-rollback' ? (
                  <i className="spinner" />
                ) : (
                  <RefreshIcon width={14} height={14} />
                )}
                {t("回滚进化机制")}
              </button>
            ) : null}
            <span className="profile-active-note">
              <InfoIcon width={13} height={13} />
              {t("阈值和节奏可以被进化，但独立评审、证据要求和回滚不会被关闭。")}
            </span>
          </div>
        </div>
      </section>

      {/* 进化历史：记录不再自动裁剪，所以这里自己控制展示量（默认评分前 20）。 */}
      <section className="evolution-section">
        <div className="evolution-section-head">
          <div>
            <h2>{t("进化历史")}</h2>
            <p>
              {t(
                "所有轮次都会保留，不再自动删除；默认按评审分数从高到低显示前 {v1} 轮。",
                { v1: HISTORY_PREVIEW },
              )}</p>
          </div>
          <div className="section-actions">
            <span className="section-count">{t("{v1} 轮记录", { v1: cycles.length })}</span>
            {rankedCycles.length > HISTORY_PREVIEW ? (
              <button
                type="button"
                className="button ghost small"
                onClick={() => setShowAllCycles((value) => !value)}
              >
                {showAllCycles
                  ? t("只看前 {v1} 轮", { v1: HISTORY_PREVIEW })
                  : t("展开全部 {v1} 轮", { v1: rankedCycles.length })}
              </button>
            ) : null}
            {cycles.length > 0 ? (
              <button
                type="button"
                className="button ghost small danger"
                onClick={() => void clearHistory()}
                disabled={busy === 'clear-history'}
              >
                {busy === 'clear-history' ? (
                  <i className="spinner" />
                ) : (
                  <TrashIcon width={13} height={13} />
                )}
                {t("清理历史")}
              </button>
            ) : null}
          </div>
        </div>
        {cycles.length === 0 ? (
          <div className="empty-panel compact">
            <SparkIcon width={22} height={22} />
            <strong>{t("还没有进化记录")}</strong>
            <span>{t("跑过一轮系统进化后，这里会按评分列出每次尝试。")}</span>
          </div>
        ) : (
          <div className="cycle-history">
            {visibleCycles.map((cycle, index) => (
              <details className="cycle-history-row" key={cycle.id}>
                <summary>
                  <span className="cycle-history-rank">{index + 1}</span>
                  <span className={`cycle-status tone-${cycleTone(cycle.status)}`}>
                    {cycle.status === 'completed'
                      ? t("完成")
                      : cycle.status === 'rejected'
                        ? t("未采用")
                        : t("失败")}
                  </span>
                  {typeof cycle.score === 'number' ? (
                    <span className="cycle-history-score">
                      {t("{v1} 分", { v1: cycle.score })}
                    </span>
                  ) : (
                    <span className="cycle-history-score muted">{t("无评分")}</span>
                  )}
                  <span className="cycle-history-summary">{cycle.summary}</span>
                  <span className="muted cycle-history-time">
                    {formatRelative(cycle.startedAt)}
                  </span>
                </summary>
                <CycleTimeline cycle={cycle} />
              </details>
            ))}
          </div>
        )}
      </section>

      <section className="evolution-section">
        <div className="evolution-section-head">
          <div>
            <h2>{t("源码级进化（实验室）")}</h2>
            <p>
              {t("Pilot 可以在自己的源码工作区里修改代码、运行测试并构建实验版。实验版独立运行，不影响当前安装；工作区快照和旧构建目录都可以回退。")}</p>
          </div>
          <div className="section-actions">
            <span className="section-count">{t("需要 Node 22.12+ 与 pnpm")}</span>
            <button
              type="button"
              className="button primary small"
              onClick={() => void openSelfSource()}
              disabled={busy === 'self-source'}
            >
              {busy === 'self-source' ? (
                <i className="spinner" />
              ) : (
                <TerminalIcon width={14} height={14} />
              )}
              {t("打开自身源码工作区")}</button>
          </div>
        </div>
        <div className="evolution-flow">
          <div>
            <span>01</span>
            <strong>{t("修改源码")}</strong>
            <p>{t("按 SELF.md 的说明修改代码，先给出计划。")}</p>
          </div>
          <div>
            <span>02</span>
            <strong>{t("测试与构建")}</strong>
            <p>{t("运行 node scripts/self-build.mjs；测试或构建失败就停下。")}</p>
          </div>
          <div>
            <span>03</span>
            <strong>{t("运行实验版")}</strong>
            <p>{t("实验版在独立目录运行；建议先退出当前版本，避免两个实例同时写本地数据。")}</p>
          </div>
          <div>
            <span>04</span>
            <strong>{t("回退")}</strong>
            <p>{t("旧实验版目录保留，随时切回。")}</p>
          </div>
        </div>
      </section>

      <section className="evolution-section personal-evolution">
        <div className="evolution-section-head">
          <div>
            <h2>{t("个人版本与官方贡献")}</h2>
            <p>
              {t("不会写代码也能拥有自己的 Pilot：用聊天告诉它你想改进什么，它会修改自身源码、跑测试并构建个人版。满意后保存版本；特别有价值的改动可以打包提交官方，采纳后会合并进正式发行版。")}</p>
          </div>
          <div className="section-actions">
            <button
              type="button"
              className="button ghost small"
              onClick={() => void refreshPersonalNow()}
              disabled={personalBusy === 'refresh'}
            >
              {personalBusy === 'refresh' ? <i className="spinner" /> : <RefreshIcon width={14} height={14} />}
              {t("刷新")}</button>
            <button
              type="button"
              className="button primary small"
              onClick={() => void chatSelfSource()}
              disabled={!hasKey || busy === 'self-source'}
              title={
                !hasKey
                  ? t("需要先配置 API Key")
                  : t("打开内置源码并新建对话，用聊天告诉 Pilot 你想怎么改造自己")
              }
            >
              {busy === 'self-source' ? (
                <i className="spinner" />
              ) : (
                <SparkIcon width={14} height={14} />
              )}
              {t("和 Pilot 聊源码改造")}</button>
            <button
              type="button"
              className="button ghost small"
              onClick={() => void askBuild()}
              disabled={!personal?.available || !hasKey || personalBusy === 'build'}
              title={
                !hasKey
                  ? t("需要先配置 API Key")
                  : personal?.available
                    ? t("切换到聊天，让 Pilot 按 SELF.md 运行测试并构建个人版")
                    : t("请先打开自身源码工作区")
              }
            >
              {personalBusy === 'build' ? <i className="spinner" /> : <SparkIcon width={14} height={14} />}
              {t("让 Pilot 构建")}</button>
            <button
              type="button"
              className="button ghost small"
              onClick={() => void savePersonal()}
              disabled={!personal?.available || personalBusy === 'save'}
              title={
                personal?.available
                  ? t("把当前源码改动保存为一个可回退的个人版本")
                  : t("请先打开自身源码工作区")
              }
            >
              {personalBusy === 'save' ? <i className="spinner" /> : <DownloadIcon width={14} height={14} />}
              {personalBusy === 'save' ? t("保存中…") : t("保存当前版本")}</button>
          </div>
        </div>

        <SelfSourceSection onError={onError} onChanged={refreshPersonal} />

        {!personal ? (
          <div className="empty-panel compact">
            <FilesIcon width={22} height={22} />
            <strong>{t("正在读取个人版本…")}</strong>
          </div>
        ) : !personal.available ? (
          <div className="empty-panel compact">
            <TerminalIcon width={22} height={22} />
            <strong>{t("还没有个人源码工作区")}</strong>
            <span>{t("先打开自身源码工作区。之后你在聊天里提出的改进，Pilot 会直接写进这份个人源码。")}</span>
            <button type="button" className="button primary small" onClick={() => void openSelfSource()}>
              {t("打开自身源码工作区")}</button>
          </div>
        ) : (
          <>
            <div className="personal-meta">
              <span className="personal-fork">
                {t("个人分支 {v1}", { v1: personal.forkId.slice(0, 8) })}
              </span>
              <span>{t("官方基线 v{v1}", { v1: personal.baseVersion })}</span>
              {personal.provenance && (
                <span
                  className={`personal-provenance ${personal.provenance.closed ? 'ok' : 'open'}`}
                  title={personal.provenance.reason}
                >
                  {personal.provenance.closed ? t("闭环") : t("未闭环")}
                  {' · '}
                  {personal.provenance.revision
                    ? t("基线提交 {v1}", { v1: personal.provenance.revision.slice(0, 8) })
                    : t("基线未绑定提交")}
                </span>
              )}
              <span className={personal.uploadEndpoint ? 'positive' : 'muted'}>
                {personal.uploadEndpoint ? t("官方上传通道已配置") : t("仅生成贡献包")}
              </span>
              <code title={personal.sourcePath}>{personal.sourcePath}</code>
            </div>

            {personal.upgrade.available ? (
              <div
                className={`personal-upgrade${personal.upgrade.requiresManual ? ' manual' : ''}`}
              >
                <div>
                  <strong>
                    {t("官方已升级到 v{v1}", { v1: personal.upgrade.toVersion })}
                  </strong>
                  <span>
                    {personal.upgrade.requiresManual
                      ? t(
                          "你的个人版本基于 v{v1}，但升级前的官方基线没有保存。可以让 Pilot 对照新版官方源码手动迁移，个人改动不会丢失。",
                          { v1: personal.upgrade.fromVersion },
                        )
                      : t(
                          "你的个人版本基于 v{v1}。合并后会同时包含官方更新和你自己的改动；冲突会标出来交给 Pilot 处理。",
                          { v1: personal.upgrade.fromVersion },
                        )}
                  </span>
                </div>
                <button
                  type="button"
                  className="button primary small"
                  onClick={() => void mergeUpgrade()}
                  disabled={personalBusy === 'upgrade'}
                >
                  {personalBusy === 'upgrade' ? (
                    <i className="spinner" />
                  ) : (
                    <RefreshIcon width={14} height={14} />
                  )}
                  {personalBusy === 'upgrade'
                    ? t("合并中…")
                    : personal.upgrade.requiresManual
                      ? t("让 Pilot 迁移")
                      : t("合并官方更新")}
                </button>
              </div>
            ) : null}

            {personal.lastUpgrade && personal.lastUpgrade.validation !== 'passed' ? (
              <div className={`personal-upgrade validation ${personal.lastUpgrade.validation}`}>
                <div>
                  <strong>
                    {personal.lastUpgrade.validation === 'failed'
                      ? t("合并结果未通过检查")
                      : personal.lastUpgrade.validation === 'skipped'
                        ? t("合并结果尚未验证（缺少依赖）")
                        : t("合并结果尚未验证")}
                  </strong>
                  <span>
                    {personal.lastUpgrade.message ??
                      t("文本合并无法发现跨文件逻辑冲突，请运行检查或让 Pilot 审阅。")}
                  </span>
                  {personal.lastUpgrade.output ? (
                    <details className="personal-validation-output">
                      <summary>{t("查看检查输出")}</summary>
                      <pre>{personal.lastUpgrade.output}</pre>
                    </details>
                  ) : null}
                </div>
                <div className="personal-upgrade-actions">
                  <button
                    type="button"
                    className="button primary small"
                    onClick={() => void runValidation()}
                    disabled={Boolean(personalBusy)}
                  >
                    {personalBusy === 'validate' ? (
                      <i className="spinner" />
                    ) : (
                      <RefreshIcon width={14} height={14} />
                    )}
                    {t("运行检查")}
                  </button>
                  <button
                    type="button"
                    className="button ghost small"
                    onClick={() => void fixUpgrade()}
                    disabled={Boolean(personalBusy)}
                  >
                    {t("让 Pilot 修复")}
                  </button>
                  <button
                    type="button"
                    className="button ghost small"
                    onClick={() => void rollbackMerge()}
                    disabled={Boolean(personalBusy)}
                  >
                    {personalBusy === 'rollback' ? <i className="spinner" /> : null}
                    {t("撤销合并")}
                  </button>
                </div>
              </div>
            ) : null}

            {personal.versions.length === 0 ? (
              <div className="empty-panel compact">
                <SparkIcon width={22} height={22} />
                <strong>{t("还没有保存过个人版本")}</strong>
                <span>{t("先在聊天里让 Pilot 改进自己，然后回来点“保存当前版本”。版本会记录改了哪些文件，之后可以恢复。")}</span>
              </div>
            ) : (
              <div className="personal-version-list">
                {personal.versions.slice(0, 8).map((version) => (
                  <article key={version.id} className="profile-card personal-version-card">
                    <div className="profile-card-head">
                      <span className="profile-version small">{version.name}</span>
                      <span className="profile-source">{changeSummary(version.files)}</span>
                      {version.buildPath ? (
                        <span className="active-chip">{t("已构建")}</span>
                      ) : (
                        <span className="retired-chip">{t("待构建")}</span>
                      )}
                      <span className="profile-date">{formatRelative(version.createdAt)}</span>
                    </div>
                    {version.note ? <p className="personal-note">{version.note}</p> : null}
                    {version.buildPath ? (
                      <p className="personal-build" title={version.buildPath}>
                        {t("实验版：{v1}", { v1: version.buildPath })}
                      </p>
                    ) : null}
                    <div className="profile-actions">
                      <button
                        type="button"
                        className="button ghost small"
                        onClick={() => void restorePersonal(version)}
                        disabled={personalBusy === `restore:${version.id}`}
                      >
                        {personalBusy === `restore:${version.id}` ? (
                          <i className="spinner" />
                        ) : (
                          <RefreshIcon width={14} height={14} />
                        )}
                        {t("恢复此版本")}</button>
                      <button
                        type="button"
                        className="button ghost small"
                        onClick={() => void submitPersonal(version)}
                        disabled={personalBusy === `submit:${version.id}`}
                      >
                        {personalBusy === `submit:${version.id}` ? (
                          <i className="spinner" />
                        ) : (
                          <ArrowUpRightIcon width={14} height={14} />
                        )}
                        {t("提交官方")}</button>
                      <span className="profile-active-note">
                        <InfoIcon width={13} height={13} />
                        {t("提交前会检查密钥和危险路径；贡献包只包含这个版本记录的改动。")}
                      </span>
                    </div>
                  </article>
                ))}
                {personal.versions.length > 8 ? (
                  <p className="muted personal-more">
                    {t("另有 {v1} 个较早版本已保留在本地。", { v1: personal.versions.length - 8 })}
                  </p>
                ) : null}
              </div>
            )}

            {personal.contributions.length > 0 ? (
              <div className="personal-contributions">
                <h3>{t("贡献包")}</h3>
                {personal.contributions.slice(0, 6).map((contribution) => (
                  <div key={contribution.id} className="personal-contribution-row">
                    <span className={`contribution-status status-${contribution.status}`}>
                      {contributionStatusLabel(contribution.status)}
                    </span>
                    <div className="personal-contribution-body">
                      <strong>{contribution.note}</strong>
                      <span>
                        {formatRelative(contribution.createdAt)} ·{' '}
                        {(contribution.bytes / 1024).toFixed(1)} KiB
                        {contribution.error ? ` · ${contribution.error}` : ''}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="button ghost small"
                      onClick={() => void revealContribution(contribution)}
                    >
                      {t("打开位置")}</button>
                  </div>
                ))}
              </div>
            ) : null}
          </>
        )}
      </section>

      <section className="evolution-section">
        <div className="evolution-section-head">
          <div>
            <h2>{t("全局画像")}</h2>
            <p>
              {t("跨所有工作区生效。由工作区画像提升而来，评审通过后仍需你手动启用，避免一个项目的经验影响所有项目。")}</p>
          </div>
          <div className="section-actions">
            {activeGlobal ? (
              <button
                type="button"
                className="button ghost small"
                onClick={() => void rollbackGlobal()}
                disabled={busy === 'global-rollback'}
              >
                {busy === 'global-rollback' ? (
                  <i className="spinner" />
                ) : (
                  <RefreshIcon width={14} height={14} />
                )}
                {t("回滚全局版本")}</button>
            ) : null}
            <span className="section-count">{globalDrafts.length} {t("份全局候选")}</span>
          </div>
        </div>

        {activeGlobal ? (
          <div className="active-profile-card">
            <div className="active-profile-top">
              <div>
                <span className="profile-version large">v{activeGlobal.version}</span>
                <span className="active-chip">
                  <CheckIcon width={11} height={11} />
                  {t("全局生效中")}</span>
                <span className="profile-source">{sourceLabel(activeGlobal.source)}</span>
              </div>
              <span className="muted">
                {t("启用")}{activeGlobal.activatedAt ? formatRelative(activeGlobal.activatedAt) : ''}
              </span>
            </div>
            <ProfileDecision
              profile={activeGlobal}
              baseline={previousGlobalProfile}
              scope="global"
              mode="active"
              busy={busy === `explain:${activeGlobal.id}`}
              onExplain={() => void explain(activeGlobal, 'global')}
              onOpenSettings={onOpenSettings}
            />
            <details className="profile-technical">
              <summary>{t("技术细节（给想看原文的人）")}</summary>
              <p>{activeGlobal.rationale}</p>
              <EvidenceGrid profile={activeGlobal} />
            </details>
            <details className="prompt-addendum">
              <summary>{t("查看全局提示词增补")}</summary>
              <pre>{activeGlobal.promptAddendum}</pre>
            </details>
            {needsChinese(activeGlobal) ? (
              <div className="profile-actions">
                <button
                  type="button"
                  className="button ghost small"
                  disabled={busy === `localize:${activeGlobal.id}`}
                  onClick={() => void localize(activeGlobal, 'global')}
                >
                  {busy === `localize:${activeGlobal.id}` ? (
                    <i className="spinner" />
                  ) : (
                    <SparkIcon width={14} height={14} />
                  )}
                  {t("生成中文版")}</button>
                <span className="profile-active-note">{t("不会修改当前生效版本，中文草稿需重新评审。")}</span>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="empty-panel">
            <BrainIcon width={28} height={28} />
            <strong>{t("尚未启用全局画像")}</strong>
            <span>
              {t("工作区画像运行稳定后，可以点击“提升为全局候选”，让跨项目仍然成立的经验在所有工作区生效。")}</span>
          </div>
        )}

        {globalDrafts.length > 0 ? (
          <div className="profile-list">
            {globalDrafts.map((profile) => (
              <ProfileCard
                profile={profile}
                baseline={activeGlobal}
                runs={runs}
                busy={busy}
                global
                key={profile.id}
                onReview={(item) => void reviewGlobal(item)}
                onBenchmark={(item) => void benchmark(item, true)}
                onActivate={(item, force) => void activateGlobal(item, force)}
                onDelete={(item) => void removeGlobal(item)}
                onLocalize={(item, scope) => void localize(item, scope)}
                onExplain={(item, scope) => void explain(item, scope)}
                onOpenSettings={onOpenSettings}
              />
            ))}
          </div>
        ) : null}

        {globalRetired.length > 0 ? (
          <details className="retired-section">
            <summary>
              <ClockIcon width={14} height={14} />
              {t("全局历史版本 ·")}{globalRetired.length}
            </summary>
            <div className="retired-list">
              {globalRetired.map((profile) => (
                <div className="retired-row" key={profile.id}>
                  <span className="profile-version small">v{profile.version}</span>
                  <span className="retired-rationale">{profile.rationale}</span>
                  <span className="muted">
                    {profile.retiredAt ? formatRelative(profile.retiredAt) : ''}
                  </span>
                  {profile.review?.comparison ? (
                    <button
                      type="button"
                      className="button ghost tiny"
                      onClick={() =>
                        void activateGlobal(profile, profile.review?.pass !== true)
                      }
                    >
                      {t("重新启用")}</button>
                  ) : (
                    <button
                      type="button"
                      className="button ghost tiny"
                      title={t(
                        "这个版本没有实测记录，启用前必须先和当前版本跑同一批基准任务。",
                      )}
                      disabled={busy === `benchmark:${profile.id}`}
                      onClick={() => void benchmark(profile, true)}
                    >
                      {t("实测对比")}</button>
                  )}
                </div>
              ))}
            </div>
          </details>
        ) : null}
      </section>

      <section className="evolution-section">
        <div className="evolution-section-head">
          <div>
            <h2>{t("当前工作区画像")}</h2>
            <p>
              {t("只对")}{workspace?.name ?? t("当前工作区")} {t("生效。画像按工作区保存，切换工作区会看到各自的版本。")}</p>
          </div>
          <div className="section-actions">
            {active ? (
              <button
                type="button"
                className="button ghost small"
                onClick={() => void promote(active)}
                disabled={busy === `promote:${active.id}`}
              >
                {busy === `promote:${active.id}` ? (
                  <i className="spinner" />
                ) : (
                  <SparkIcon width={14} height={14} />
                )}
                {t("提升为全局候选")}</button>
            ) : null}
            {active ? (
              <button
                type="button"
                className="button ghost small"
                onClick={() => void rollback()}
                disabled={busy === 'rollback'}
              >
                {busy === 'rollback' ? <i className="spinner" /> : <RefreshIcon width={14} height={14} />}
                {t("回滚到上一版本")}</button>
            ) : null}
            <button
              type="button"
              className="button primary small"
              onClick={() => void propose()}
              disabled={!canPropose || busy === 'propose'}
              title={
                !hasKey
                  ? t("需要先配置 API Key")
                  : completed.length < 3
                    ? t("至少需要 3 次运行记录")
                    : t("让 Pilot 基于近期运行提出改进")
              }
            >
              {busy === 'propose' ? <i className="spinner" /> : <SparkIcon width={14} height={14} />}
              {busy === 'propose' ? t("分析中…") : t("生成新版本")}
            </button>
          </div>
        </div>

        {active ? (
          <div className="active-profile-card">
            <div className="active-profile-top">
              <div>
                <span className="profile-version large">v{active.version}</span>
                <span className="active-chip">
                  <CheckIcon width={11} height={11} />
                  {t("生效中")}</span>
                <span className="profile-source">{sourceLabel(active.source)}</span>
              </div>
              <span className="muted">
                {t("启用")}{active.activatedAt ? formatRelative(active.activatedAt) : ''}
              </span>
            </div>
            <ProfileDecision
              profile={active}
              baseline={previousProfile}
              scope="workspace"
              mode="active"
              runs={runs}
              busy={busy === `explain:${active.id}`}
              onExplain={() => void explain(active, 'workspace')}
              onOpenSettings={onOpenSettings}
            />
            <details className="profile-technical">
              <summary>{t("技术细节（给想看原文的人）")}</summary>
              <p>{active.rationale}</p>
              <EvidenceGrid profile={active} />
            </details>
            <details className="prompt-addendum">
              <summary>{t("查看提示词增补")}</summary>
              <pre>{active.promptAddendum}</pre>
            </details>
            {needsChinese(active) ? (
              <div className="profile-actions">
                <button
                  type="button"
                  className="button ghost small"
                  disabled={busy === `localize:${active.id}`}
                  onClick={() => void localize(active, 'workspace')}
                >
                  {busy === `localize:${active.id}` ? (
                    <i className="spinner" />
                  ) : (
                    <SparkIcon width={14} height={14} />
                  )}
                  {t("生成中文版")}</button>
                <span className="profile-active-note">{t("不会修改当前生效版本，中文草稿需重新评审。")}</span>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="empty-panel">
            <BrainIcon width={28} height={28} />
            <strong>{t("当前工作区尚未启用画像")}</strong>
            <span>
              {t("这个工作区还没有自己的运行画像；画像按工作区保存，其他工作区的版本不会显示在这里。 累计至少 3 次真实任务后，可以手动生成第一份候选版本。")}{canPropose ? '' : hasKey ? t(" 继续完成几个任务即可。") : t(" 先在设置中配置 API Key。")}
            </span>
          </div>
        )}
      </section>

      <section className="evolution-section">
        <div className="evolution-section-head">
          <div>
            <h2>{t("候选版本")}</h2>
            <p>{t("草稿不会影响运行，除非通过评审或被你手动启用。")}</p>
          </div>
          <span className="section-count">{drafts.length} {t("份草稿")}</span>
        </div>

        {drafts.length === 0 ? (
          <div className="empty-panel compact">
            <SparkIcon width={24} height={24} />
            <strong>{t("没有待处理的候选版本")}</strong>
            <span>
              {canPropose
                ? t("点击“生成新版本”，Pilot 会分析近期运行并提出一份改进草稿。")
                : t("完成更多真实任务后，Pilot 才能总结出可靠的改进。")}
            </span>
          </div>
        ) : (
          <div className="profile-list">
            {drafts.map((profile) => (
              <ProfileCard
                profile={profile}
                baseline={active}
                runs={runs}
                busy={busy}
                key={profile.id}
                onReview={(item) => void review(item)}
                onBenchmark={(item) => void benchmark(item)}
                onActivate={(item, force) => void activate(item, force)}
                onDelete={(item) => void remove(item)}
                onPromote={(item) => void promote(item)}
                onLocalize={(item, scope) => void localize(item, scope)}
                onExplain={(item, scope) => void explain(item, scope)}
                onOpenSettings={onOpenSettings}
              />
            ))}
          </div>
        )}
      </section>

      {retired.length > 0 ? (
        <section className="evolution-section">
          <details className="retired-section">
            <summary>
              <ClockIcon width={14} height={14} />
              {t("历史版本 ·")}{retired.length}
            </summary>
            <div className="retired-list">
              {retired.map((profile) => (
                <div className="retired-row" key={profile.id}>
                  <span className="profile-version small">v{profile.version}</span>
                  <span className="retired-rationale">{profile.rationale}</span>
                  <span className="muted">
                    {profile.retiredAt ? formatRelative(profile.retiredAt) : ''}
                  </span>
                  {profile.review?.comparison ? (
                    <button
                      type="button"
                      className="button ghost tiny"
                      onClick={() => void activate(profile, profile.review?.pass !== true)}
                    >
                      {t("重新启用")}</button>
                  ) : (
                    <button
                      type="button"
                      className="button ghost tiny"
                      title={t(
                        "这个版本没有实测记录，启用前必须先和当前版本跑同一批基准任务。",
                      )}
                      disabled={busy === `benchmark:${profile.id}`}
                      onClick={() => void benchmark(profile)}
                    >
                      {t("实测对比")}</button>
                  )}
                </div>
              ))}
            </div>
          </details>
        </section>
      ) : null}

      <section className="evolution-section">
        <div className="evolution-section-head">
          <div>
            <h2>{t("运行证据")}</h2>
            <p>{t("Pilot 的进化提案只基于这些真实运行记录。")}</p>
          </div>
          <span className="section-count">{runs.length} {t("条记录")}</span>
        </div>
        <RunsTable runs={runs} />
      </section>
    </div>
  )
}
