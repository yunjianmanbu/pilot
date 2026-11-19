import { useMemo } from 'react'
import type { ProfileExplanation, ProfileReview, ProfileVersion, RunRecord } from '../../../shared/types'
import {
  describeStrategyChanges,
  diffAddendum,
  normalize,
  similarity,
} from '../../../shared/profile-diff'
import { compareVersions } from '../../../shared/version-stats'
import { t } from '../i18n'

/**
 * The part of a profile the user actually decides on.
 *
 * Everything above the fold is plain language: what changes, what they will
 * notice, what could go wrong and whether to enable it. Rule text, scores and
 * evidence stay below, collapsed, for the reader who wants to check the work.
 */

interface DecisionProps {
  profile: ProfileVersion
  /** The version currently in use, used to build a before/after view. */
  baseline: ProfileVersion | null
  scope: 'workspace' | 'global'
  busy: boolean
  /** An active version is already running, so a recommendation makes no sense. */
  mode?: 'draft' | 'active'
  /** Recorded runs, used to compare what each version actually did. */
  runs?: RunRecord[]
  onExplain: () => void
  /** Opens the settings section where separate reviewer models are configured. */
  onOpenSettings?: () => void
}

type Row = { label: string; base: string; next: string }

function pctText(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`
}

/** Reviewer notes are free text; drop their closing punctuation so the sentence join does not double it. */
function trimSentence(text: string): string {
  return text.trim().replace(/[。！？.!?；;，,\s]+$/u, '')
}

/**
 * "Is it actually better?" answered with recorded behaviour instead of prose.
 *
 * A draft has usually never run, so the honest answer is often "not measurable
 * yet"; we say that and show what will be filled in, rather than inventing a
 * comparison out of nothing.
 */
function CapabilityCompare({ runs, baseline, candidate }: {
  runs: RunRecord[]
  baseline: ProfileVersion | null
  candidate: ProfileVersion
}) {
  const comparison = useMemo(
    () =>
      baseline
        ? compareVersions(runs, baseline.version, candidate.version)
        : null,
    [runs, baseline, candidate.version],
  )
  if (!baseline || !comparison) {
    return (
      <p className="compare-note">
        {t('这是第一个版本，没有旧版本可以对比。')}
      </p>
    )
  }
  const { baseline: base, candidate: next, verdict, findings, minRuns } = comparison
  const rows: Row[] = [
    {
      label: t('跑过几次'),
      base: String(base.finished),
      next: String(next.finished),
    },
    {
      label: t('完成比例'),
      base: pctText(base.successRate),
      next: pctText(next.successRate),
    },
    {
      label: t('撞步数上限'),
      base: pctText(base.maxStepRate),
      next: pctText(next.maxStepRate),
    },
    {
      label: t('平均步数'),
      base: base.avgSteps === null ? '—' : base.avgSteps.toFixed(1),
      next: next.avgSteps === null ? '—' : next.avgSteps.toFixed(1),
    },
    {
      label: t('每次命令报错'),
      base: base.avgToolErrors === null ? '—' : base.avgToolErrors.toFixed(1),
      next: next.avgToolErrors === null ? '—' : next.avgToolErrors.toFixed(1),
    },
    {
      label: t('收尾前做过验证'),
      base: pctText(base.checkedRate),
      next: pctText(next.checkedRate),
    },
    {
      label: t('你的评价（好评 / 差评）'),
      base: `${base.ratingUp} / ${base.ratingDown}`,
      next: `${next.ratingUp} / ${next.ratingDown}`,
    },
  ]
  return (
    <div className="compare-block">
      <h5>
        {t('实测对比：现在用的 v{v1} 和这一版 v{v2}', {
          v1: String(base.version),
          v2: String(next.version),
        })}
      </h5>
      <table className="compare-table">
        <thead>
          <tr>
            <th>{t('看什么')}</th>
            <th>{t('v{v1}（现在）', { v1: String(base.version) })}</th>
            <th>{t('v{v1}（新版）', { v1: String(next.version) })}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <td>{row.label}</td>
              <td>{row.base}</td>
              <td className="compare-next">{row.next}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {verdict === 'untested' ? (
        <p className="compare-note">
          {t('新版还没真正跑过，所以现在无法比较强弱。启用后它会自动记录上面的数字，两个版本一放就能看出差别。')}
        </p>
      ) : null}
      {verdict === 'too-few' ? (
        <p className="compare-note">
          {t('两边的跑次都还不到 {v1} 次，数字波动大，先别据此下结论。', {
            v1: String(minRuns),
          })}
        </p>
      ) : null}
      {verdict === 'ready' && findings.length > 0 ? (
        <ul className="compare-findings">
          {findings.map((item) => (
            <li key={item.slice(0, 12)}>{item}</li>
          ))}
        </ul>
      ) : null}
      {verdict === 'ready' && findings.length === 0 ? (
        <p className="compare-note">
          {t('两版在这些指标上差别不明显，看不出谁更强。')}
        </p>
      ) : null}
    </div>
  )
}

function RecommendBadge({ explanation }: { explanation: ProfileExplanation }) {
  const enable = explanation.recommend === 'enable'
  return (
    <span className={`decision-verdict ${enable ? 'decision-enable' : 'decision-observe'}`}>
      {enable
        ? t('建议启用')
        : t('建议先别启用，继续观察')}
    </span>
  )
}

/**
 * Who checked this change, in everyday words.
 *
 * "Independent review" only means something if the reader can see that the
 * checker was not the same model that wrote the change; when no separate
 * reviewer is configured we say so instead of implying a second opinion.
 */
function checkerText(review: ProfileReview | undefined): { label: string; text: string; weak: boolean } | null {
  if (!review) return null
  const judges = review.judges ?? []
  const external = judges.filter((judge) => judge.external)
  if (external.length > 0 && review.independent !== false) {
    return {
      label: t('谁检查过'),
      text: t('{v1} 个独立的模型各自看过一遍（{v2}），结论一致才会建议启用。', {
        v1: external.length,
        v2: external.map((judge) => judge.label).join('、'),
      }),
      weak: false,
    }
  }
  if (external.length > 0) {
    return {
      label: t('谁检查过'),
      text: t('部分模型独立检查过（{v1}），但另一些与写这条规则的模型相同，结论可能相互影响。', {
        v1: external.map((judge) => judge.label).join('、'),
      }),
      weak: true,
    }
  }
  return {
    label: t('谁检查过'),
    text: t('只有当前模型自己检查，没有第二个模型参与；在设置的评估模型里选择另一个模型后才会真正独立。'),
    weak: true,
  }
}
export function ProfileDecision({
  profile,
  baseline,
  scope,
  busy,
  mode = 'draft',
  runs = [],
  onExplain,
  onOpenSettings,
}: DecisionProps) {
  const explanation = profile.explanation
  /**
   * A summary written before the check ran must not tell the user to enable a
   * change the check then rejected. The verdict wins; the summary only adds
   * colour.
   */
  const vetoed = Boolean(profile.review && !profile.review.pass)
  const effective = useMemo<ProfileExplanation | undefined>(() => {
    if (!explanation) return undefined
    if (!vetoed || explanation.recommend === 'observe') return explanation
    return { ...explanation, recommend: 'observe' }
  }, [explanation, vetoed])
  const diff = useMemo(
    () => diffAddendum(baseline?.promptAddendum ?? '', profile.promptAddendum),
    [baseline?.promptAddendum, profile.promptAddendum],
  )
  const settings = useMemo(
    () => describeStrategyChanges(baseline?.strategy, profile.strategy),
    [baseline?.strategy, profile.strategy],
  )
  const moved = diff.added.length + diff.changed.length + diff.removed.length + settings.length
  const checker = checkerText(profile.review)

  if (!explanation) {
    return (
      <div className="decision-card decision-empty">
        <p className="decision-empty-text">
          {moved === 0
            ? t('这个版本没有改动任何规则，只是重新保存了一次，可以直接忽略。')
            : t(
                '这次改了什么还没翻译成日常说法。点下面的按钮，Pilot 会用大白话说明：改了什么、你会感觉到什么变化、有什么风险、要不要启用。',
              )}
        </p>
        {moved > 0 ? (
          <button type="button" className="button small" disabled={busy} onClick={onExplain}>
            {busy ? t('正在解释…') : t('用大白话解释这次改动')}
          </button>
        ) : null}
      </div>
    )
  }

  const shown: ProfileExplanation = effective ?? explanation

  return (
    <div
      className={`decision-card decision-${shown.recommend === 'enable' ? 'enable' : 'observe'}`}
    >
      <div className="decision-head">
        {mode === 'draft' ? <RecommendBadge explanation={shown} /> : null}
        <span className="decision-scope">
          {mode === 'active'
            ? t('这就是现在生效的规则')
            : scope === 'global'
              ? t('作用于这台电脑上的所有项目')
              : t('只作用于当前项目')}
        </span>
      </div>

      <h4 className="decision-headline">{shown.headline}</h4>

      {moved > 0 ? (
        <p className="decision-diff-summary">
          {t('相比{v1}：新增 {v2} 条 · 改写 {v3} 条 · 删去 {v4} 条', {
            v1: baseline ? t('正在使用的 v{v}', { v: baseline.version }) : t('初始设置'),
            v2: String(diff.added.length),
            v3: String(diff.changed.length),
            v4: String(diff.removed.length),
          })}
          {settings.length > 0 ? t(' · 调整 {v1} 项设置', { v1: String(settings.length) }) : ''}
        </p>
      ) : null}

      {vetoed ? (
        <p className="decision-veto">
          {t('检查认为这次改动还不该启用：{v1}。下面仍保留原本的说明，供你对照。', {
            v1: trimSentence(profile.review?.notes || t('没有通过')),
          })}
        </p>
      ) : null}

      {explanation.changes.length > 0 ? (
        <ul className="decision-changes">
          {explanation.changes.map((item, index) => (
            <li key={`change-${index}`}>{item}</li>
          ))}
        </ul>
      ) : null}

      <div className="decision-row">
        <span className="decision-label">{t('你会感觉到')}</span>
        <span>{explanation.impact}</span>
      </div>

      {explanation.risks.length > 0 ? (
        <div className="decision-row decision-row-risk">
          <span className="decision-label">{t('风险 / 需要留意的')}</span>
          <ul className="decision-risks">
            {explanation.risks.map((item, index) => (
              <li key={`risk-${index}`}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {explanation.reason ? (
        <div className="decision-row">
          <span className="decision-label">{t('为什么这么建议')}</span>
          <span>{explanation.reason}</span>
        </div>
      ) : null}

      {checker ? (
        <div className={`decision-row decision-row-checker${checker.weak ? ' decision-row-weak' : ''}`}>
          <span className="decision-label">{checker.label}</span>
          <span>
            {checker.text}
            {checker.weak && onOpenSettings ? (
              <button type="button" className="button ghost small decision-inline-action" onClick={onOpenSettings}>
                {t('去配置评估模型')}
              </button>
            ) : null}
          </span>
        </div>
      ) : null}

      {mode === 'draft' ? (
        <CapabilityCompare runs={runs} baseline={baseline} candidate={profile} />
      ) : null}

      <div className="decision-foot">
        {explanation.model ? (
          <span className="decision-source">
            {t('由 {v1} 生成，可重新生成', { v1: explanation.model })}
          </span>
        ) : (
          <span className="decision-source">{t('自动生成的摘要')}</span>
        )}
        <button type="button" className="button ghost small" disabled={busy} onClick={onExplain}>
          {busy ? t('正在重新解释…') : t('重新解释')}
        </button>
      </div>
    </div>
  )
}

/** Literal before/after view, so the summary above can be checked. */
export function ProfileRuleDiff({
  profile,
  baseline,
}: {
  profile: ProfileVersion
  baseline: ProfileVersion | null
}) {
  const diff = useMemo(
    () => diffAddendum(baseline?.promptAddendum ?? '', profile.promptAddendum),
    [baseline?.promptAddendum, profile.promptAddendum],
  )
  const settings = useMemo(
    () => describeStrategyChanges(baseline?.strategy, profile.strategy),
    [baseline?.strategy, profile.strategy],
  )
  const reviewed = Boolean(profile.review)
  /** Each deleted rule is paired with the reviewer's reason, when there is one. */
  const removals = useMemo(
    () =>
      diff.removed.map((rule) => ({
        rule,
        verdict: (profile.review?.removals ?? []).find(
          (entry) =>
            normalize(entry.rule) === normalize(rule) ||
            similarity(entry.rule, rule) >= 0.75,
        ),
      })),
    [diff, profile.review?.removals],
  )

  if (diff.unchanged && settings.length === 0) return null

  return (
    <details className="rule-diff">
      <summary>
        {t('逐条对照：{v1} 处变化（{v2}）', {
          v1: diff.added.length + diff.changed.length + diff.removed.length + settings.length,
          v2: baseline ? t('对比正在使用的 v{v}', { v: baseline.version }) : t('对比初始设置'),
        })}
      </summary>
      {settings.length > 0 ? (
        <div className="rule-diff-block">
          <h5>{t('设置变化')}</h5>
          <ul>
            {settings.map((entry) => (
              <li key={entry.field}>
                <code>{entry.label}</code> {entry.from} → {entry.to}
                <p className="rule-diff-note">{entry.plain}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {diff.added.length > 0 ? (
        <div className="rule-diff-block">
          <h5>{t('新增（{v1}）', { v1: diff.added.length })}</h5>
          <ul>
            {diff.added.map((rule, index) => (
              <li key={`added-${index}`}>{rule}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {diff.changed.length > 0 ? (
        <div className="rule-diff-block">
          <h5>{t('改写（{v1}）', { v1: diff.changed.length })}</h5>
          <ul>
            {diff.changed.map((entry, index) => (
              <li key={`changed-${index}`}>
                <span className="rule-before">{entry.before}</span>
                <span className="rule-after">{entry.after}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {diff.removed.length > 0 ? (
        <div className="rule-diff-block">
          <h5>{t('删去（{v1}）', { v1: diff.removed.length })}</h5>
          <ul>
            {removals.map(({ rule, verdict }, index) => (
              <li key={`removed-${index}`} className="rule-removed">
                <span>{rule}</span>
                {verdict?.justified && verdict.reason.trim() ? (
                  <p className="rule-diff-note">
                    {t('评审理由：{v1}', { v1: verdict.reason })}
                  </p>
                ) : (
                  <p className="rule-diff-note rule-diff-missing">
                    {reviewed
                      ? t('评审没有为这条删除给出可用理由，这一版不能启用。')
                      : t('删除旧规则必须由评审逐条说明理由，否则不能启用。')}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {diff.kept.length > 0 ? (
        <div className="rule-diff-block">
          <h5>{t('保持不变（{v1}）', { v1: diff.kept.length })}</h5>
          <ul>
            {diff.kept.map((rule, index) => (
              <li key={`kept-${index}`} className="rule-kept">
                {rule}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </details>
  )
}
