import { useEffect, useState } from 'react'
import type { ResourceUsage, SystemInfo } from '../../../shared/types'
import { formatBytes, usageLevel, usagePercent } from '../../../shared/system-info'
import { XIcon } from '../icons'
import { t } from '../i18n'
import { useEscapeClose } from './useEscapeClose'

interface Row {
  key: string
  label: string
  /** 0..100；null 表示这次读不到。 */
  percent: number | null
  detail: string
}

/**
 * 顶栏资源条的详情弹框：条上只放百分比，这里补绝对量与本机信息。
 *
 * 每次打开单独取一次 `resourceUsage()` 与 `systemInfo()`，不挂轮询：
 * 用户点开就是要一个当时的读数，开着弹框继续每 2 秒采样没有意义。
 */
export function SystemResourceDialog({
  workspacePath,
  onClose,
}: {
  workspacePath?: string
  onClose: () => void
}) {
  const [usage, setUsage] = useState<ResourceUsage | null>(null)
  const [info, setInfo] = useState<SystemInfo | null>(null)
  const [error, setError] = useState('')
  useEscapeClose(onClose)

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      window.pilot.resourceUsage(workspacePath).catch(() => null),
      window.pilot.systemInfo(workspacePath).catch(() => null),
    ]).then(([usageResult, infoResult]) => {
      if (cancelled) return
      setUsage(usageResult)
      setInfo(infoResult)
      if (!usageResult && !infoResult) setError(t('这次读不到系统资源，稍后再试。'))
    })
    return () => {
      cancelled = true
    }
  }, [workspacePath])

  const memoryPercent = usagePercent(
    usage?.memoryUsedBytes ?? null,
    usage?.memoryTotalBytes ?? null,
  )
  const diskPercent = usagePercent(
    usage?.diskUsedBytes ?? null,
    usage?.diskTotalBytes ?? null,
  )

  const rows: Row[] = [
    {
      key: 'cpu',
      label: t('CPU'),
      percent: usage?.cpuPercent ?? null,
      detail:
        usage?.cpuPercent == null
          ? t('暂时读不到')
          : info
            ? t('{v1} 个逻辑核心 · {v2}', {
                v1: info.cpuCount,
                v2: info.cpuModel || t('型号未知'),
              })
            : t('整机占用'),
    },
    {
      key: 'memory',
      label: t('内存'),
      percent: memoryPercent,
      detail:
        usage?.memoryUsedBytes == null
          ? t('暂时读不到')
          : t('{v1} 已用 / {v2} 总量 · 空闲 {v3}', {
              v1: formatBytes(usage.memoryUsedBytes),
              v2: formatBytes(usage.memoryTotalBytes),
              v3: formatBytes(info?.memoryFreeBytes ?? null),
            }),
    },
    {
      key: 'disk',
      label: t('磁盘'),
      percent: diskPercent,
      detail:
        usage?.diskUsedBytes == null
          ? t('工作区所在卷暂时读不到')
          : t('工作区所在卷 {v1} 已用 / {v2}', {
              v1: formatBytes(usage.diskUsedBytes),
              v2: formatBytes(usage.diskTotalBytes),
            }),
    },
  ]

  const sampledAt = usage ? new Date(usage.measuredAt).toLocaleTimeString('zh-CN') : ''

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal system-resource-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('系统资源详情')}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <h2>{t('系统资源详情')}</h2>
            <p>{t('这台电脑当前的负载与本机信息，和顶栏那条读数是同一份数据。')}</p>
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label={t('关闭')}>
            <XIcon width={17} height={17} />
          </button>
        </div>

        <div className="modal-body">
          {error ? <div className="tools-error">{error}</div> : null}

          <div className="usage-panel">
            <h3 className="usage-section-head">
              {t('系统负载')}
              {sampledAt ? <small>{t('采样于 {v1}', { v1: sampledAt })}</small> : null}
            </h3>

            <div className="usage-detail">
              {rows.map((row) => {
                const level = usageLevel(row.percent)
                return (
                  <div className={`usage-detail-row level-${level}`} key={row.key}>
                    <strong>{row.label}</strong>
                    <span
                      className="usage-detail-track"
                      role="progressbar"
                      aria-label={row.label}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={row.percent == null ? undefined : Math.round(row.percent)}
                    >
                      <i style={{ width: `${row.percent ?? 0}%` }} />
                    </span>
                    <span className="usage-detail-value">
                      {row.percent === null ? '—' : `${Math.round(row.percent)}%`}
                    </span>
                    <span className="usage-detail-text">{row.detail}</span>
                  </div>
                )
              })}
            </div>

            <h3 className="usage-section-head">{t('本机信息')}</h3>
            <dl className="usage-facts">
              <div>
                <dt>{t('系统')}</dt>
                <dd>{info ? `${info.platform} ${info.osRelease}` : '—'}</dd>
              </div>
              <div>
                <dt>{t('架构')}</dt>
                <dd>{info?.arch ?? '—'}</dd>
              </div>
              <div>
                <dt>{t('总内存')}</dt>
                <dd>{formatBytes(info?.memoryTotalBytes ?? null) || '—'}</dd>
              </div>
              <div>
                <dt>Electron</dt>
                <dd>{info?.electron ?? '—'}</dd>
              </div>
              <div>
                <dt>Node</dt>
                <dd>{info?.node ?? '—'}</dd>
              </div>
              <div>
                <dt>Chrome</dt>
                <dd>{info?.chrome ?? '—'}</dd>
              </div>
              <div className="wide">
                <dt>{t('工作区')}</dt>
                <dd className="mono">{workspacePath || '—'}</dd>
              </div>
            </dl>
          </div>
        </div>
      </div>
    </div>
  )
}
