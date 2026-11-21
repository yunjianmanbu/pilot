import { useEffect, useRef, useState } from 'react'
import type { ResourceUsage } from '../../../shared/types'
import {
  formatBytes,
  usageLevel,
  usagePercent,
} from '../../../shared/system-info'
import { t } from '../i18n'

/** 采样间隔：顶栏是常驻信息，2s 够看出趋势，又不会把主进程拖成轮询机。 */
const POLL_MS = 2000
/** 连续失败超过这个时长才把读数退成「—」：偶发一次 IO 抖动不该让条闪空。 */
const KEEP_STALE_MS = 12_000
/** 失败计数换算成时长，用计数而不是时间戳，才能靠每次失败的重渲染自然过期。 */
const STALE_AFTER_FAILURES = Math.ceil(KEEP_STALE_MS / POLL_MS)

interface Meter {
  key: 'cpu' | 'memory' | 'disk'
  label: string
  /** 0..100；null 表示这次读不到，画空槽 + 「—」。 */
  percent: number | null
  /** 悬停说明：数值 + 绝对量。 */
  title: string
}

function percentText(percent: number | null): string {
  return percent === null ? '—' : `${Math.round(percent)}%`
}

/**
 * 顶栏的本机资源条：CPU、内存、磁盘各一条迷你进度条。
 *
 * 数据来自 `resourceUsage()`（主进程一次 ~120ms 的 CPU 差分采样），这里只负责
 * 轮询与绘制。窗口隐藏时停表——后台窗口继续采样 CPU 本身就是它想报告的那种浪费。
 * 读不到的一路留空槽并显示「—」，不用 0% 或满格冒充读数。
 */
export function ResourceMeters({ workspacePath }: { workspacePath?: string }) {
  const [usage, setUsage] = useState<ResourceUsage | null>(null)
  const [failures, setFailures] = useState(0)
  const targetRef = useRef(workspacePath ?? '')
  targetRef.current = workspacePath ?? ''

  useEffect(() => {
    let cancelled = false
    let timer: number | null = null

    const tick = async (): Promise<void> => {
      if (document.hidden) return
      try {
        const next = await window.pilot.resourceUsage(targetRef.current || undefined)
        if (cancelled) return
        setUsage(next)
        setFailures(0)
      } catch {
        // 采样失败只影响这一次；保留上一次读数，连续失败太久再退成「—」。
        if (!cancelled) setFailures((current) => current + 1)
      }
    }

    const schedule = (): void => {
      timer = window.setTimeout(() => {
        void tick().finally(() => {
          if (!cancelled) schedule()
        })
      }, POLL_MS)
    }

    // 切回窗口时立刻补一帧：否则回来要先看两秒的旧数字。
    const onVisible = (): void => {
      if (!document.hidden) void tick()
    }

    void tick()
    schedule()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [workspacePath])

  const stale = failures >= STALE_AFTER_FAILURES
  const live = stale ? null : usage

  const cpu = live?.cpuPercent ?? null
  const memory = usagePercent(live?.memoryUsedBytes ?? null, live?.memoryTotalBytes ?? null)
  const disk = usagePercent(live?.diskUsedBytes ?? null, live?.diskTotalBytes ?? null)

  const meters: Meter[] = [
    {
      key: 'cpu',
      label: t('CPU'),
      percent: cpu,
      title:
        cpu === null
          ? t('CPU 占用：暂时读不到')
          : t('CPU 占用 {v1}%', { v1: Math.round(cpu) }),
    },
    {
      key: 'memory',
      label: t('内存'),
      percent: memory,
      title:
        live === null || live.memoryUsedBytes === null
          ? t('内存占用：暂时读不到')
          : t('内存 {v1} 已用 / {v2}，占 {v3}%', {
              v1: formatBytes(live.memoryUsedBytes),
              v2: formatBytes(live.memoryTotalBytes),
              v3: memory === null ? '—' : Math.round(memory),
            }),
    },
    {
      key: 'disk',
      label: t('磁盘'),
      percent: disk,
      title:
        live === null || live.diskUsedBytes === null
          ? t('工作区所在卷占用：暂时读不到')
          : t('工作区所在卷 {v1} 已用 / {v2}，占 {v3}%', {
              v1: formatBytes(live.diskUsedBytes),
              v2: formatBytes(live.diskTotalBytes),
              v3: disk === null ? '—' : Math.round(disk),
            }),
    },
  ]

  return (
    <div className="resource-meters" role="group" aria-label={t('本机资源使用')}>
      {meters.map((meter) => {
        const level = usageLevel(meter.percent)
        return (
          <div
            key={meter.key}
            className={`resource-meter is-${meter.key} level-${level}`}
            title={meter.title}
          >
            <span className="resource-meter-label">{meter.label}</span>
            <span
              className="resource-meter-track"
              role="progressbar"
              aria-label={meter.label}
              aria-valuemin={0}
              aria-valuemax={100}
              {...(meter.percent === null ? {} : { 'aria-valuenow': Math.round(meter.percent) })}
            >
              <i style={{ width: `${meter.percent ?? 0}%` }} />
            </span>
            {/* 数字放在条尾而不是条内：条很短，压字会看不清，也不跟随长度跳动。 */}
            <span className="resource-meter-value">{percentText(meter.percent)}</span>
          </div>
        )
      })}
    </div>
  )
}