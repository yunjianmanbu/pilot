import type {
  ProfileEvidence,
  ProfileExplanation,
  ProfileStrategy,
  ProfileVersion,
} from '../../shared/types'

/**
 * propose_self_update 用到的 store 面。只声明这五个方法，单测可以拿内存实现顶替，
 * 也避免 bridge 顺手取到别的状态。
 */
export interface SelfUpdateStore {
  workspaces(): Array<{ path: string }>
  runs(workspacePath: string): Array<{ steps: number; totalTokens: number }>
  evidence(workspacePath: string): ProfileEvidence
  createProfileDraft(
    workspacePath: string,
    input: {
      promptAddendum: string
      rationale: string
      source: ProfileVersion['source']
      strategy?: ProfileStrategy
      evidence?: ProfileEvidence
    },
  ): Promise<ProfileVersion>
  createGlobalProfileDraft(input: {
    promptAddendum: string
    rationale: string
    source: ProfileVersion['source']
    strategy?: ProfileStrategy
    evidence?: ProfileEvidence
  }): Promise<ProfileVersion>
}

/** 与 ToolHost.proposeSelfUpdate 的入参一致。 */
export interface SelfUpdateRequest {
  promptAddendum: string
  rationale: string
  scope?: 'workspace' | 'global'
  maxSteps?: number
  temperature?: number
}

export interface SelfUpdateBridgeInput {
  store: SelfUpdateStore
  workspacePath: string
  /** 草案落盘后通知渲染进程刷新自我进化面板。 */
  onProfileChanged: () => void
  /** 给草案补一句人话解释；失败时返回空对象，不影响草案可用。 */
  explainDraft(
    scope: 'workspace' | 'global',
    workspacePath: string,
    profileId: string,
  ): Promise<{ explanation?: ProfileExplanation }>
}

/**
 * 把 propose_self_update 接到本工作区的草案存储上。写入的是 draft：用户仍要在
 * 自我进化面板里复核并启用，工具本身不会让任何规则生效。
 *
 * global 草案要跨全部工作区取证据，否则「全局」提案只反映正好开口的那一个工作区；
 * 平均步数/令牌按最近 30 条 run 现算，而不是复用 evidence 里的均值。
 */
export function createSelfUpdateBridge(
  input: SelfUpdateBridgeInput,
): (request: SelfUpdateRequest) => Promise<{ version: number; explanation?: ProfileExplanation }> {
  const { store, workspacePath, onProfileChanged, explainDraft } = input
  return async (request) => {
    if (request.scope === 'global') {
      // A system-wide draft needs evidence from every workspace, not
      // just the one that happened to ask. The user still has to review
      // and activate it in the Evolution panel.
      const workspaces = store.workspaces().map((workspace) => workspace.path)
      const recentRuns = workspaces.flatMap((path) => store.runs(path).slice(0, 30))
      const evidence = workspaces
        .map((path) => store.evidence(path))
        .reduce(
          (total, entry) => ({
            runs: total.runs + entry.runs,
            failures: total.failures + entry.failures,
            avgSteps: 0,
            avgTokens: 0,
            positive: total.positive + entry.positive,
            negative: total.negative + entry.negative,
          }),
          { runs: 0, failures: 0, avgSteps: 0, avgTokens: 0, positive: 0, negative: 0 },
        )
      const draft = await store.createGlobalProfileDraft({
        promptAddendum: request.promptAddendum,
        rationale: request.rationale,
        source: 'self',
        strategy: {
          ...(request.maxSteps !== undefined ? { maxSteps: request.maxSteps } : {}),
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        },
        evidence: {
          ...evidence,
          avgSteps:
            recentRuns.length > 0
              ? Math.round(
                  (recentRuns.reduce((sum, run) => sum + run.steps, 0) /
                    recentRuns.length) *
                    10,
                ) / 10
              : 0,
          avgTokens:
            recentRuns.length > 0
              ? Math.round(
                  recentRuns.reduce((sum, run) => sum + run.totalTokens, 0) /
                    recentRuns.length,
                )
              : 0,
        },
      })
      onProfileChanged()
      return {
        version: draft.version,
        ...(await explainDraft('global', workspacePath, draft.id)),
      }
    }
    const draft = await store.createProfileDraft(workspacePath, {
      promptAddendum: request.promptAddendum,
      rationale: request.rationale,
      source: 'self',
      strategy: {
        ...(request.maxSteps !== undefined ? { maxSteps: request.maxSteps } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      },
      evidence: store.evidence(workspacePath),
    })
    onProfileChanged()
    return {
      version: draft.version,
      ...(await explainDraft('workspace', workspacePath, draft.id)),
    }
  }
}
