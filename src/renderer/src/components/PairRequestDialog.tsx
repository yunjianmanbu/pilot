import { useEffect, useState, type ReactElement } from 'react'
import type { CompanionPairRequest } from '../../../shared/types'
import { ClockIcon, GlobeIcon, PhoneIcon, XIcon } from '../icons'
import { t } from '../i18n'

interface PairRequestDialogProps {
  request: CompanionPairRequest | null
  onDecide: (requestId: string, approved: boolean, role?: 'host' | 'client') => void
}

/** Whole seconds left before the phone gives up on its own. */
function remainingSeconds(expiresAt: string): number {
  const at = Date.parse(expiresAt)
  if (!Number.isFinite(at)) return 0
  return Math.max(0, Math.ceil((at - Date.now()) / 1000))
}

/** Below this the countdown turns urgent: the answer is about to be lost. */
const URGENT_SECONDS = 15

/**
 * One line describing where the request came from.
 *
 * A browser is named after the page it opened (`网页服务 10.0.0.2`), so the
 * address is already in the title; listing it again reads like a second
 * device. Phones report a model name and no address of their own, so there the
 * address is the only useful part and stays.
 */
function deviceSubtitle(request: CompanionPairRequest, browser: boolean): string {
  const via = request.via === 'relay' ? t('云端中继') : t('局域网')
  if (browser) return `${t('浏览器')} · ${via}`
  const where = request.via === 'relay' || !request.address ? via : `${via} · ${request.address}`
  return `${request.platform} · ${where}`
}

/**
 * A phone scanned the pairing QR code and is waiting. Nothing is paired until
 * the person at this keyboard answers, so the prompt names the phone, where it
 * connected from and how long is left.
 *
 * A browser that opened the URL without a QR code asks the same way. The
 * browser page is this desktop's own interface talking over `/bridge`, and that
 * channel serves host identities only (`bridge.ts` refuses a client level), so
 * browser access is always granted as a host user. The prompt says so instead of
 * offering an identity that could not load the page.
 */
export function PairRequestDialog({ request, onDecide }: PairRequestDialogProps): ReactElement | null {
  // 首帧就按 `expiresAt` 算出秒数：以前初始化成 0，第一帧会先渲染成
  // 「已超时」再被 effect 纠正，弹框刚出现时闪一下错误的红字。
  const [remaining, setRemaining] = useState(() =>
    request ? remainingSeconds(request.expiresAt) : 0,
  )

  useEffect(() => {
    if (!request) return
    setRemaining(remainingSeconds(request.expiresAt))
    const timer = window.setInterval(() => {
      setRemaining(remainingSeconds(request.expiresAt))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [request])

  if (!request) return null

  const browser = request.mode === 'browser'
  const expired = remaining <= 0
  const title = browser ? t('浏览器请求访问这台电脑') : t('手机请求连接这台电脑')

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal pair-request-modal" role="alertdialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <div>
            <h2>{title}</h2>
            <p>
              {browser
                ? t('确认之后这台浏览器才能打开工作台。')
                : t('扫码不会自动配对：确认之后，这台手机才能读取会话、查看文件并驱动 Agent。')}
            </p>
          </div>
          <button
            type="button"
            className="modal-close"
            aria-label={t('拒绝')}
            onClick={() => onDecide(request.requestId, false)}
          >
            <XIcon />
          </button>
        </div>
        <div className="modal-body">
          {/* 设备一行说清「谁在请求」，倒计时贴着它，因为那是唯一会自己变化的信息。 */}
          <div className="pair-request-device">
            <span className="pair-request-icon" aria-hidden="true">
              {browser ? <GlobeIcon /> : <PhoneIcon />}
            </span>
            <div className="pair-request-device-text">
              <strong>{request.name}</strong>
              <span>{deviceSubtitle(request, browser)}</span>
            </div>
            <span
              className={`pair-request-timer${!expired && remaining <= URGENT_SECONDS ? ' is-urgent' : ''}`}
              title={expired ? t('已超时，将自动拒绝') : t('{v1} 秒后自动拒绝', { v1: remaining })}
            >
              <ClockIcon width={12} height={12} />
              {expired ? t('已超时') : t('{v1} 秒', { v1: remaining })}
            </span>
          </div>
          {/* 浏览器页面走的是 `/bridge` 那条 IPC 通道，而它只认主机身份
              （`bridge.ts` 的 `usableLevel` 要求 `canManageHost`）：批成客户机
              时页面连不上主进程，只剩一张空壳。所以这里不再摆一个必然失败
              的选项，只说明固定身份。 */}
          {browser ? (
            <div className="pair-request-identity">
              <span className="pair-request-identity-label">{t('身份')}</span>
              <div className="pair-request-identity-text">
                <strong>{t('主机用户')}</strong>
                <span>{t('浏览器页面必须与本机共用同一份会话、工作区与设置，因此浏览器访问固定为主机用户。')}</span>
              </div>
            </div>
          ) : null}
          <p className="pair-request-warning">
            {browser
              ? t('只给本人使用的浏览器放行。若你没有在别的设备上打开过这个地址，请选拒绝。')
              : t('只在你本人刚刚扫描了电脑上的二维码时允许。若你没有拿出手机扫码，请选拒绝；拒绝后手机需要重新扫码。')}
          </p>
        </div>
        <div className="modal-footer">
          <span className="pair-request-note">
            {browser
              ? t('你可以随时在电脑上解除这次授权。')
              : t('这台手机还可以随时在电脑上解除授权。')}
          </span>
          <div className="modal-actions">
            <button
              type="button"
              className="button danger ghost"
              onClick={() => onDecide(request.requestId, false)}
            >
              {t('拒绝')}
            </button>
            <button
              type="button"
              className="button primary"
              onClick={() => onDecide(request.requestId, true, browser ? 'host' : undefined)}
            >
              {browser ? t('允许访问') : t('允许连接')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
