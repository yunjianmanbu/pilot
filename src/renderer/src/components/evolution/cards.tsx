import type {
  EvolutionCycle,
  ProfileComparison,
  ProfileVersion,
  RunRecord,
} from '../../../../shared/types'

import { ProfileDecision, ProfileRuleDiff } from '../ProfileDecision'
import {
  CheckIcon,
  InfoIcon,
  SparkIcon,
  ThumbDownIcon,
  ThumbUpIcon,
  TrashIcon,
} from '../../icons'
import { formatNumber, formatRelative } from '../../ui'
import { t } from '../../i18n'
import {
  STATUS_LABELS,
  canForce,
  cycleTone,
  evidenceVoided,
  isReady,
  needsChinese,
  needsMeasurement,
  scoreTone,
  sourceLabel,
  stageLabel,
} from './shared'

export function EvidenceGrid({ profile }: { profile: ProfileVersion }) {
  const evidence = profile.evidence
  return (
    <div className="evidence-grid">
      <div>
        <strong>{evidence.runs}</strong>
        <span>{t("运行样本")}</span>
      </div>
      <div>
        <strong className="positive">{evidence.verified ?? 0}</strong>
        <span>{t("已验证交付")}</span>
      </div>
      <div>
        <strong>{evidence.failures}</strong>
        <span>{t("失败")}</span>
      </div>
      <div>
        <strong>{evidence.avgSteps.toFixed(1)}</strong>
        <span>{t("平均步数")}</span>
      </div>
      <div>
        <strong>{formatNumber(Math.round(evidence.avgTokens))}</strong>
        <span>{t("平均 tokens")}</span>
      </div>
      <div>
        <strong className="positive">{evidence.positive}</strong>
        <span>{t("正反馈")}</span>
      </div>
      <div>
        <strong className="negative">{evidence.negative}</strong>
        <span>{t("负反馈")}</span>
      </div>
    </div>
  )
}

export function ProfileCard({
  profile,
  baseline,
  busy,
  runs,
  suiteVersion,
  global = false,
  onReview,
  onBenchmark,
  onActivate,
  onDelete,
  onPromote,
  onLocalize,
  onExplain,
  onOpenSettings,
}: {
  profile: ProfileVersion
  baseline: ProfileVersion | null
  busy: string | null
  /** Current task-library revision; a comparison from another one is stale. */
  suiteVersion?: number
  /** Recorded runs of this workspace, for the before/after measurement. */
  runs: RunRecord[]
  global?: boolean
  onReview: (profile: ProfileVersion) => void
  /** Run the paired active-vs-candidate benchmark; workspace profiles only. */
  onBenchmark: (profile: ProfileVersion) => void
  onActivate: (profile: ProfileVersion, force: boolean) => void
  onDelete: (profile: ProfileVersion) => void
  onPromote?: (profile: ProfileVersion) => void
  onLocalize: (profile: ProfileVersion, scope: 'workspace' | 'global') => void
  onExplain: (profile: ProfileVersion, scope: 'workspace' | 'global') => void
  onOpenSettings?: () => void
}) {
  const scope: 'workspace' | 'global' = global ? 'global' : 'workspace'
  const review = profile.review
  // The stored review carries the numbers of its own moment. Re-check them
  // against the pair and the task library in force now, so the panel never
  // offers an enable button that the gate will refuse as stale evidence.
  const voided = evidenceVoided(review, {
    candidateId: profile.id,
    activeProfileId: baseline?.id ?? null,
    suiteVersion,
  })
  const ready = !voided && isReady(review)
  const forceable = !voided && canForce(review)
  const strategy = [
    profile.strategy.maxSteps !== undefined ? t("最多 {v1} 步", { v1: profile.strategy.maxSteps }) : null,
    profile.strategy.temperature !== undefined ? t("温度 {v1}", { v1: profile.strategy.temperature }) : null,
  ].filter((item): item is string => Boolean(item))

  return (
    <article className="profile-card">
      <div className="profile-card-head">
        <span className="profile-version">v{profile.version}</span>
        {global ? <span className="profile-source">{t("全局")}</span> : null}
        <span className="profile-source">{sourceLabel(profile.source)}</span>
        {profile.status === 'active' ? <span className="active-chip">{t("已启用")}</span> : null}
        {profile.status === 'retired' ? <span className="retired-chip">{t("已退役")}</span> : null}
        <span className="profile-date">{formatRelative(profile.createdAt)}</span>
      </div>

      <ProfileDecision
        profile={profile}
        baseline={baseline}
        scope={scope}
        runs={runs}
        busy={busy === `explain:${profile.id}`}
        onExplain={() => onExplain(profile, scope)}
        onOpenSettings={onOpenSettings}
      />

      <ProfileRuleDiff profile={profile} baseline={baseline} />

      <details className="profile-technical">
        <summary>{t("技术细节（给想看原文的人）")}</summary>
        {strategy.length > 0 ? (
          <div className="strategy-chips">
            {strategy.map((item) => (
              <span key={item}>{item}</span>
            ))}
          </div>
        ) : null}
        <p className="profile-rationale">{profile.rationale}</p>
        <EvidenceGrid profile={profile} />
      </details>

      <details className="prompt-addendum">
        <summary>{t("提示词增补")}</summary>
        <pre>{profile.promptAddendum}</pre>
      </details>

      {review ? (
        <div className={`review-card review-${review.pass ? 'pass' : 'fail'}`}>
          <div className={`review-score tone-${scoreTone(review.score)}`}>
            <strong>{review.score}</strong>
            <span>/ 100</span>
          </div>
          <div className="review-body">
            <div className="review-head">
              <span>
                {review.pass
                  ? review.independent
                    ? t("独立评审通过")
                    : t("评审通过（非独立评审）")
                  : t("评审未通过")} 
              </span>
              <span className="review-model">{review.model}</span>
              <span className="review-date">{formatRelative(review.at)}</span>
            </div>
            <p>{review.notes}</p>
            {review.judges && review.judges.length > 0 ? (
              <ul className="review-judges">
                {review.judges.map((verdict, index) => (
                  <li key={`${index}-${verdict.id}`}>
                    <strong>{verdict.label}</strong>
                    <span className="review-model">{verdict.model}</span>
                    <span className="review-judge-origin">
                      {verdict.external ? t("外部模型") : t("本机同款模型")}
                    </span>
                    <span className={`review-judge-score tone-${scoreTone(verdict.score)}`}>
                      {verdict.score}
                    </span>
                    <span>{verdict.pass ? t("通过") : t("未通过")}</span>
                    {verdict.notes ? (
                      <details className="review-judge-notes">
                        <summary>{t("它的理由")}</summary>
                        <p>{verdict.notes}</p>
                        {verdict.risks.length > 0 ? (
                          <ul className="review-risks">
                            {verdict.risks.map((risk) => (
                              <li key={risk.slice(0, 12)}>{risk}</li>
                            ))}
                          </ul>
                        ) : null}
                      </details>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {profile.status === 'draft' &&
            (review.independent === false || !review.judges || review.judges.length === 0) ? (
              <p className="review-self-note">
                {t("这次评审只有运行模型自己参与，属于自评。到 设置 → 模型资源 → 评估模型 里选择一个别的厂商的模型，再重新评审，就是三方独立评审。")}
              </p>
            ) : null}
            {review.judgeErrors && review.judgeErrors.length > 0 ? (
              <ul className="review-risks">
                {review.judgeErrors.map((failure, index) => (
                  <li key={`judge-error-${index}`}>{failure}</li>
                ))}
              </ul>
            ) : null}
            {review.judgeUsage ? (
              <p className="review-self-note">
                {t('这次评审消耗：输入 {v1} / 输出 {v2} / 缓存命中 {v3}，共 {v4} 次请求', {
                  v1: review.judgeUsage.input,
                  v2: review.judgeUsage.output,
                  v3: review.judgeUsage.cacheHit,
                  v4: review.judgeUsage.calls,
                })}
              </p>
            ) : null}
            {review.risks.length > 0 ? (
              <ul className="review-risks">
                {review.risks.map((risk, index) => (
                  <li key={`${index}-${risk.slice(0, 12)}`}>{risk}</li>
                ))}
              </ul>
            ) : null}
            {review.comparison ? (
              <BenchmarkCard
                comparison={review.comparison}
                stale={
                  (review.comparison.candidateId !== undefined &&
                    review.comparison.candidateId !== profile.id) ||
                  (review.comparison.currentId ?? null) !== (baseline?.id ?? null)
                }
                staleSuite={
                  suiteVersion !== undefined &&
                  review.comparison.suiteVersion !== suiteVersion
                }
                suiteVersion={suiteVersion}
              />
            ) : null}
            {review.activation && !review.activation.ready ? (
              <div className="review-gate">
                <strong>{t("还不能启用")}</strong>
                <ul className="review-risks">
                  {review.activation.reasons.map((reason, index) => (
                    <li key={`${index}-${reason.slice(0, 12)}`}>{reason}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="review-pending">
          <InfoIcon width={14} height={14} />
          {global
            ? t("尚未评审。启用前必须先通过评审（配好评审模型才是独立评审）；即使通过，也需要你手动启用。")
            : t("尚未评审。启用前必须先通过评审（配好评审模型才是独立评审），分数 ≥ 75 才会自动启用。")}
        </div>
      )}

      <div className="profile-actions">
        {profile.status !== 'active' ? (
          <button
            type="button"
            className="button small"
            title={t(
              "把同一批基准任务在当前版本和这个版本下各跑一遍，再用配置好的第三方评审模型匿名打分。只有实测更优的版本才允许启用，删除旧规则还需要评审逐条给出理由。",
            )}
            disabled={busy === `benchmark:${profile.id}`}
            onClick={() => onBenchmark(profile)}
          >
            {busy === `benchmark:${profile.id}` ? <i className="spinner" /> : null}
            {t("实测对比能力")}
          </button>
        ) : null}
        {profile.status === 'draft' ? (
          <>
            {!review ? (
              <button
                type="button"
                className="button primary small"
                disabled={busy === `review:${profile.id}`}
                onClick={() => onReview(profile)}
              >
                {busy === `review:${profile.id}` ? (
                  <i className="spinner" />
                ) : (
                  <SparkIcon width={14} height={14} />
                )}
                {t("独立评审")}</button>
            ) : null}
            {review?.pass && ready ? (
              <button
                type="button"
                className="button primary small"
                disabled={busy === `activate:${profile.id}`}
                onClick={() => onActivate(profile, false)}
              >
                {busy === `activate:${profile.id}` ? (
                  <i className="spinner" />
                ) : (
                  <CheckIcon width={14} height={14} />
                )}
                {global ? t("启用此全局版本") : t("启用此版本")}
              </button>
            ) : null}
            {forceable ? (
              <button
                type="button"
                className="button danger ghost small"
                disabled={busy === `activate:${profile.id}`}
                onClick={() => onActivate(profile, true)}
              >
                {t("仍然启用")}</button>
            ) : null}
            {review && !ready && !forceable ? (
              <span className="profile-active-note">
                {voided
                  ? t('旧实测已失效：{v1}；重新跑一次实测才能启用。', { v1: voided })
                  : needsMeasurement(review)
                    ? t("还没有实测对比，先跑一次实测才能启用。")
                    : (review.activation?.reasons?.[0] ?? t("当前还不满足启用条件。"))}
              </span>
            ) : null}
            {onPromote && !global ? (
              <button
                type="button"
                className="button ghost small"
                disabled={busy === `promote:${profile.id}`}
                onClick={() => onPromote(profile)}
              >
                {busy === `promote:${profile.id}` ? (
                  <i className="spinner" />
                ) : (
                  <SparkIcon width={14} height={14} />
                )}
                {t("提升为全局候选")}</button>
            ) : null}
            {needsChinese(profile) ? (
              <button
                type="button"
                className="button ghost small"
                disabled={busy === `localize:${profile.id}`}
                onClick={() => onLocalize(profile, global ? 'global' : 'workspace')}
              >
                {busy === `localize:${profile.id}` ? (
                  <i className="spinner" />
                ) : (
                  <SparkIcon width={14} height={14} />
                )}
                {t("生成中文版")}</button>
            ) : null}
            <button
              type="button"
              className="button ghost small danger-text"
              disabled={busy === `delete:${profile.id}`}
              onClick={() => onDelete(profile)}
            >
              <TrashIcon width={13} height={13} />
              {t("删除草稿")}</button>
          </>
        ) : null}
        {profile.status === 'active' ? (
          <span className="profile-active-note">
            <CheckIcon width={13} height={13} />
            {global
              ? t("所有工作区的新运行都会使用这个版本。")
              : t("本工作区的新运行会使用这个版本的提示词与策略。")}
          </span>
        ) : null}
        {profile.status === 'retired' ? (
          voided ? (
            <span className="profile-active-note">
              {t('旧实测已失效：{v1}；重新跑一次实测对比才能重新启用。', { v1: voided })}
            </span>
          ) : needsMeasurement(review) ? (
            <span className="profile-active-note">
              {t("这个版本没有实测记录，先跑一次实测对比才能重新启用。")}
            </span>
          ) : (
            <button
              type="button"
              className="button ghost small"
              onClick={() => onActivate(profile, review?.pass !== true)}
            >
              {t("重新启用")}</button>
          )
        ) : null}
      </div>
    </article>
  )
}

export function RunsTable({ runs }: { runs: RunRecord[] }) {
  if (runs.length === 0) {
    return (
      <div className="empty-panel compact">
        <SparkIcon width={24} height={24} />
        <strong>{t("还没有运行记录")}</strong>
        <span>{t("完成至少 3 次真实任务后，Pilot 才能提出第一份进化草稿。")}</span>
      </div>
    )
  }
  return (
    <div className="runs-table">
      <div className="runs-head">
        <span>{t("任务")}</span>
        <span>{t("状态")}</span>
        <span>{t("步数")}</span>
        <span>tokens</span>
        <span>{t("反馈")}</span>
        <span>{t("时间")}</span>
      </div>
      {runs.slice(0, 14).map((run) => (
        <div className="runs-row" key={run.id}>
          <span className="run-prompt" title={run.prompt}>
            {run.prompt}
          </span>
          <span>
            <span className={`run-status status-${run.status}`}>
              {STATUS_LABELS[run.status] ?? run.status}
            </span>
          </span>
          <span className="mono-cell">{run.steps}</span>
          <span className="mono-cell">{formatNumber(run.totalTokens)}</span>
          <span className="feedback-cell">
            {run.feedback?.rating === 'up' ? (
              <ThumbUpIcon width={13} height={13} className="positive" />
            ) : run.feedback?.rating === 'down' ? (
              <ThumbDownIcon width={13} height={13} className="negative" />
            ) : (
              <span className="muted">—</span>
            )}
          </span>
          <span className="muted">{formatRelative(run.startedAt)}</span>
        </div>
      ))}
    </div>
  )
}

export function CycleTimeline({ cycle }: { cycle: EvolutionCycle }) {
  return (
    <div className="cycle-card">
      <div className="cycle-head">
        <span className={`cycle-status tone-${cycleTone(cycle.status)}`}>
          {cycle.status === 'completed'
            ? t("本轮完成")
            : cycle.status === 'rejected'
              ? t("本轮未采用")
              : t("本轮失败")}
        </span>
        <span className="cycle-trigger">
          {cycle.trigger === 'manual'
            ? t("手动触发")
            : cycle.trigger === 'auto'
              ? t("自动触发")
              : cycle.trigger === 'meta'
                ? t("流程自进化")
                : t("回归保护")}
        </span>
        {typeof cycle.score === 'number' ? (
          <span className="cycle-score">{t("评审 {v1} 分", { v1: cycle.score })}</span>
        ) : null}
        <span className="muted">{formatRelative(cycle.startedAt)}</span>
      </div>
      <p className="cycle-summary">{cycle.summary}</p>
      <div className="cycle-stages">
        {cycle.stages.map((stage, index) => (
          <div className={`cycle-stage stage-${stage.status}`} key={`${stage.key}-${index}`}>
            <span className="cycle-stage-dot" />
            <strong>{stageLabel(stage.key)}</strong>
            <span>{stage.detail}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function BenchmarkCard({
  comparison,
  stale = false,
  staleSuite = false,
  suiteVersion,
}: {
  comparison: ProfileComparison
  /** The measured pair no longer matches what is in force, so don't quote it as current. */
  stale?: boolean
  /** Measured against another task-library revision: the numbers cannot be
   * compared with the current ruler at all, so "no clear difference" would lie. */
  staleSuite?: boolean
  /** Current task-library revision, for the stale note. */
  suiteVersion?: number
}) {
  const voided = stale || staleSuite
  const tone =
    voided ? 'even' : comparison.verdict === 'better'
      ? 'pass'
      : comparison.verdict === 'worse'
        ? 'fail'
        : 'even'
  const label = voided
    ? t('实测已失效')
    : comparison.verdict === 'better'
      ? t('实测更优')
      : comparison.verdict === 'worse'
        ? t('实测更差')
        : comparison.verdict === 'inconclusive'
          ? t('实测无明显差异')
          : t('样本不足')
  const percent = (value: number) => `${Math.round(value * 100)}%`
  return (
    <div className={`benchmark-card benchmark-${tone}`}>
      <div className="benchmark-head">
        <strong>{label}</strong>
        <span className="benchmark-count">
          {t('候选 {v1} 胜 / {v2} 负 / {v3} 平', {
            v1: comparison.wins,
            v2: comparison.losses,
            v3: comparison.ties,
          })}
        </span>
      </div>
      {stale ? (
        <p className="benchmark-judges">
          {t('这组数据测的是另一个版本组合，当前生效版本已经变了；重新跑一次实测才有参考价值。')}
        </p>
      ) : null}
      {staleSuite ? (
        <p className="benchmark-judges">
          {comparison.suiteVersion === undefined
            ? t('这份数据没有记录是哪一版题库量的，无法和当前题库 v{v1} 比较；重新实测才有参考价值。', {
                v1: suiteVersion ?? '-',
              })
            : t('这份数据是在题库 v{v2} 上量的，当前题库已经是 v{v1}；两者不能直接比较，重新实测才有参考价值。', {
                v1: suiteVersion ?? '-',
                v2: comparison.suiteVersion,
              })}
        </p>
      ) : null}
      {comparison.suiteVersion ? (
        <p className="benchmark-judges">
          {comparison.suiteSaturated
            ? t(
                '题库 v{v1}：最难的 {v2} 任务两侧全部通过，题库已经饱和——「无明显差异」只说明题不够难，不代表能力相同；下一版题库需要加难度。',
                { v1: comparison.suiteVersion, v2: comparison.ceilingTier ?? '-' },
              )
            : t('题库 v{v1}：最难的 {v2} 任务通过率 {v3}%，仍有未解决的难度空间。', {
                v1: comparison.suiteVersion,
                v2: comparison.ceilingTier ?? '-',
                v3:
                  typeof comparison.ceilingPassRate === 'number'
                    ? Math.round(comparison.ceilingPassRate * 100)
                    : '-',
              })}
        </p>
      ) : null}
      <table className="benchmark-table">
        <thead>
          <tr>
            <th />
            <th>{t('当前版本')}</th>
            <th>{t('候选版本')}</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>{t('任务通过率')}</td>
            <td>{percent(comparison.current.successRate)}</td>
            <td>{percent(comparison.candidate.successRate)}</td>
          </tr>
          <tr>
            <td>{t('平均步数')}</td>
            <td>{comparison.current.avgSteps}</td>
            <td>{comparison.candidate.avgSteps}</td>
          </tr>
          <tr>
            <td>{t('平均 token')}</td>
            <td>{comparison.current.avgTokens}</td>
            <td>{comparison.candidate.avgTokens}</td>
          </tr>
          {comparison.current.avgJudgeScore !== undefined ||
          comparison.candidate.avgJudgeScore !== undefined ? (
            <tr>
              <td>{t('第三方评分')}</td>
              <td>{comparison.current.avgJudgeScore ?? '-'}</td>
              <td>{comparison.candidate.avgJudgeScore ?? '-'}</td>
            </tr>
          ) : null}
        </tbody>
      </table>
      {comparison.reasons.length > 0 ? (
        <ul className="benchmark-reasons">
          {comparison.reasons.map((reason, index) => (
            <li key={`${index}-${reason.slice(0, 10)}`}>{reason}</li>
          ))}
        </ul>
      ) : null}
      {comparison.judges && comparison.judges.length > 0 ? (
        <p className="benchmark-judges">
          {t('匿名评分：{v1}', { v1: comparison.judges.join('、') })}
        </p>
      ) : null}
      {comparison.judgeErrors && comparison.judgeErrors.length > 0 ? (
        <p className="benchmark-judges">
          {t('部分评审模型没有给出评分：{v1}', { v1: comparison.judgeErrors.join('；') })}
        </p>
      ) : null}
      {/* Cost of the blind grading, next to the verdict it paid for. */}
      {comparison.judgeUsage ? (
        <p className="benchmark-judges">
          {t('匿名评分消耗：输入 {v1} / 输出 {v2} / 缓存命中 {v3}，共 {v4} 次请求', {
            v1: comparison.judgeUsage.input,
            v2: comparison.judgeUsage.output,
            v3: comparison.judgeUsage.cacheHit,
            v4: comparison.judgeUsage.calls,
          })}
        </p>
      ) : null}
    </div>
  )
}
