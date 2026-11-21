import { useCallback, useEffect, useState } from 'react'
import type { SelfSourceMode, SelfSourceSettings, SourceBaseKind, SourceProvenance } from '../../../shared/types'
import { t } from '../i18n'
import { RefreshIcon, TerminalIcon, CheckIcon, InfoIcon, ArrowUpRightIcon } from '../icons'
import { formatRelative } from '../ui'

/**
 * Where the evolution loop gets both sides of its comparison.
 *
 * The loop is only closed when the official baseline is a real commit of the
 * official repository and matches its tip. Built-in mode points the editable
 * copy at that commit; custom mode points the whole loop at the user's own
 * checkout. The panel never asserts closure on its own — it renders the
 * backend verdict and the reason behind it.
 */
function baseKindLabel(kind: SourceBaseKind): string {
  switch (kind) {
    case 'official-git':
      return t('官方 git 提交')
    case 'custom-git':
      return t('自定义仓库提交')
    case 'installer-copy':
      return t('安装包内置快照')
    case 'git-head':
      return t('git HEAD')
    default:
      return t('未建立')
  }
}

/**
 * The four public repositories this product is split into. The panel links out
 * to them so the checkout behind "personal source" is one click away; nothing
 * here is fetched, and the official git address stays empty until the user
 * decides to fill it in.
 */
const OFFICIAL_REPOS: Array<{ name: string; label: string; hint: string }> = [
  {
    name: 'yunjianmanbu/pilot',
    label: t('Pilot 桌面端'),
    hint: t('主仓库：桌面端、中继与官网都在这里'),
  },
  { name: 'yunjianmanbu/pilot-link', label: t('移动控制端'), hint: t('手机控制电脑的 uni-app 端') },
  { name: 'yunjianmanbu/pilot-client', label: t('手机被控端'), hint: t('电脑控制手机的反控端') },
  {
    name: 'yunjianmanbu/pilot-connector',
    label: t('中继器'),
    hint: t('自建中继，用来跨网络连接'),
  },
]

export function SelfSourceSection({
  onError,
  onChanged,
}: {
  onError: (message: string) => void
  /** Called after the baseline moves, so the fork state is re-read. */
  onChanged?: () => void | Promise<void>
}) {
  const [status, setStatus] = useState<SourceProvenance | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [form, setForm] = useState<SelfSourceSettings>({
    mode: 'builtin',
    gitUrl: '',
    gitRef: 'main',
    gitPath: '',
    customPath: '',
  })

  const adopt = useCallback((next: SourceProvenance) => {
    setStatus(next)
    setForm({
      mode: next.mode,
      gitUrl: next.gitUrl,
      gitRef: next.gitRef,
      gitPath: next.gitPath,
      customPath: next.customPath,
    })
  }, [])

  useEffect(() => {
    void window.pilot.selfSource
      .status()
      .then(adopt)
      .catch(() => undefined)
  }, [adopt])

  const run = async (label: string, action: () => Promise<SourceProvenance>, done?: string) => {
    if (busy) return
    setBusy(label)
    setNotice('')
    try {
      const next = await action()
      adopt(next)
      await onChanged?.()
      if (done) setNotice(done)
    } catch (caught) {
      onError(
        `${t('读取源码来源失败')}：${caught instanceof Error ? caught.message : String(caught)}`,
      )
    } finally {
      setBusy(null)
    }
  }

  const save = () =>
    run(
      'save',
      () => window.pilot.selfSource.configure(form),
      t('已保存，基线已按新设置重新解析。'),
    )

  const sync = () =>
    run(
      'sync',
      () => window.pilot.selfSource.sync(),
      status?.mode === 'custom' ? t('基线已按当前分支提交重建。') : t('同步完成，基线已指向最新官方提交。'),
    )

  /** Fill the official address from one of the repository links. */
  const useOfficial = (repo: string) => {
    setForm({
      ...form,
      mode: 'builtin',
      gitUrl: `https://github.com/${repo}`,
      gitRef: form.gitRef || 'main',
      gitPath: repo === 'yunjianmanbu/pilot' ? 'pilot/pilot' : '',
    })
    setNotice(t('已填入地址，点「保存并检查」后生效。'))
  }

  const openRepo = (repo: string) => {
    void window.pilot
      .openLink(`https://github.com/${repo}`, true)
      .catch((caught) =>
        onError(caught instanceof Error ? caught.message : String(caught)),
      )
  }

  const pick = async () => {
    if (busy) return
    setBusy('pick')
    try {
      const picked = await window.pilot.selfSource.pick()
      if (!picked) return
      const next = { ...form, mode: 'custom' as SelfSourceMode, customPath: picked }
      setForm(next)
      adopt(await window.pilot.selfSource.configure(next))
      setNotice(t('已保存，基线已按新设置重新解析。'))
      await onChanged?.()
    } catch (caught) {
      onError(`${t('读取源码来源失败')}：${caught instanceof Error ? caught.message : String(caught)}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="self-source">
      <div className="self-source-head">
        <div>
          <strong>{t('源码来源与进化闭环')}</strong>
          <p>{t('只读：这些设置只决定进化闭环拿哪份源码当官方基线，不会改动任何源码文件。')}</p>
        </div>
        {status && (
          <span className={`self-source-pill ${status.closed ? 'ok' : 'open'}`}>
            {status.closed ? <CheckIcon width={12} height={12} /> : <InfoIcon width={12} height={12} />}
            {status.closed ? t('已闭环') : t('未闭环')}
          </span>
        )}
      </div>

      {!status ? (
        <p className="self-source-note">{t('正在读取源码来源…')}</p>
      ) : (
        <>
          <p className={`self-source-reason ${status.closed ? 'ok' : 'open'}`}>{status.reason}</p>

          <div className="self-source-modes">
            <button
              type="button"
              className={`button small ${form.mode === 'builtin' ? 'primary' : 'ghost'}`}
              onClick={() => setForm({ ...form, mode: 'builtin' })}
            >
              {t('内置源码（官方 git）')}</button>
            <button
              type="button"
              className={`button small ${form.mode === 'custom' ? 'primary' : 'ghost'}`}
              onClick={() => setForm({ ...form, mode: 'custom' })}
            >
              {t('自定义源码目录')}</button>
          </div>

          <div className="self-source-repos">
            <span className="self-source-repos-title">{t('官方仓库')}</span>
            <div className="self-source-repo-list">
              {OFFICIAL_REPOS.map((repo) => (
                <div className="self-source-repo" key={repo.name}>
                  <button
                    type="button"
                    className="self-source-repo-open"
                    onClick={() => openRepo(repo.name)}
                    title={t('在浏览器打开 {v1}', { v1: repo.name })}
                  >
                    <strong>{repo.label}</strong>
                    <small>{repo.hint}</small>
                    <code>{repo.name}</code>
                    <ArrowUpRightIcon width={12} height={12} />
                  </button>
                  <button
                    type="button"
                    className="button ghost small"
                    onClick={() => useOfficial(repo.name)}
                  >
                    {t('用作官方 git')}</button>
                </div>
              ))}
            </div>
          </div>

          {form.mode === 'builtin' ? (
            <div className="self-source-grid">
              <label>
                <span>{t('官方 git 地址')}</span>
                <input
                  value={form.gitUrl}
                  placeholder="https://example.com/pilot.git"
                  onChange={(event) => setForm({ ...form, gitUrl: event.target.value })}
                />
                <small>{t('安装版默认留空：不填时基线就是安装包内的源码快照；填仓库根地址后，内置源码会与这个仓库的提交比较。')}</small>
              </label>
              <label>
                <span>{t('分支或标签')}</span>
                <input
                  value={form.gitRef}
                  placeholder="main"
                  onChange={(event) => setForm({ ...form, gitRef: event.target.value })}
                />
              </label>
              <label>
                <span>{t('仓库内路径')}</span>
                <input
                  value={form.gitPath}
                  placeholder="pilot/pilot"
                  onChange={(event) => setForm({ ...form, gitPath: event.target.value })}
                />
                <small>{t('填源码在仓库里的相对目录，例如 pilot/pilot；留空表示仓库根就是客户端源码。')}</small>
              </label>
            </div>
          ) : (
            <div className="self-source-grid">
              <label>
                <span>{t('源码目录')}</span>
                <div className="self-source-path">
                  <input readOnly value={form.customPath} placeholder="D:\\code\\Pilot" />
                  <button
                    type="button"
                    className="button ghost small"
                    onClick={() => void pick()}
                    disabled={busy === 'pick'}
                  >
                    {busy === 'pick' ? <i className="spinner" /> : <TerminalIcon width={14} height={14} />}
                    {t('选择目录')}</button>
                </div>
                <small>{t('选择你自己的源码仓库（需含 .git）；个人版本会以该分支当前提交为基线。')}</small>
              </label>
              <label>
                <span>{t('仓库内路径')}</span>
                <input
                  value={form.gitPath}
                  placeholder="pilot/pilot"
                  onChange={(event) => setForm({ ...form, gitPath: event.target.value })}
                />
              </label>
            </div>
          )}

          <div className="self-source-actions">
            <button type="button" className="button primary small" onClick={() => void save()} disabled={!!busy}>
              {busy === 'save' ? <i className="spinner" /> : <CheckIcon width={14} height={14} />}
              {t('保存并检查')}</button>
            <button type="button" className="button ghost small" onClick={() => void sync()} disabled={!!busy}>
              {busy === 'sync' ? <i className="spinner" /> : <RefreshIcon width={14} height={14} />}
              {status.mode === 'custom' ? t('重建基线') : t('同步官方基线')}</button>
            {!status.gitAvailable && <span className="self-source-warn">{t('本机没有可用的 git')}</span>}
            {notice && <span className="self-source-notice">{notice}</span>}
          </div>

          <dl className="self-source-facts">
            <div>
              <dt>{t('基线类型')}</dt>
              <dd>{baseKindLabel(status.baseKind)}</dd>
            </div>
            <div>
              <dt>{t('基线提交')}</dt>
              <dd title={status.revision}>{status.revision ? status.revision.slice(0, 12) : '—'}</dd>
            </div>
            <div>
              <dt>{t('提交时间')}</dt>
              <dd>{status.committedAt ? formatRelative(status.committedAt) : '—'}</dd>
            </div>
            <div>
              <dt>{t('落后官方')}</dt>
              <dd>
                {status.behind === null
                  ? '—'
                  : status.behind === 0
                    ? t('已是最新')
                    : t('落后 {v1} 个提交', { v1: status.behind })}
              </dd>
            </div>
            <div>
              <dt>{t('上次核对')}</dt>
              <dd>{status.fetchedAt ? formatRelative(status.fetchedAt) : '—'}</dd>
            </div>
            <div>
              <dt>{t('提交说明')}</dt>
              <dd className="self-source-summary">{status.summary || '—'}</dd>
            </div>
          </dl>

          <p className="self-source-note">
            {t('源码目录')}：<code>{status.sourcePath || '—'}</code>
          </p>
          <p className="self-source-note">
            {t('官方基线')}：<code>{status.basePath || '—'}</code>
          </p>
        </>
      )}
    </div>
  )
}
