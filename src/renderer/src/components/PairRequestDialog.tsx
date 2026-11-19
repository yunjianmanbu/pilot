import { useEffect, useState, type ReactElement } from 'react'
import type { CompanionPairRequest } from '../../../shared/types'
import { PhoneIcon, XIcon } from '../icons'
import { t } from '../i18n'

interface PairRequestDialogProps {
  request: CompanionPairRequest | null
  onDecide: (requestId: string, approved: boolean) => void
}

/** Whole seconds left before the phone gives up on its own. */
function remainingSeconds(expiresAt: string): number {
  const at = Date.parse(expiresAt)
  if (!Number.isFinite(at)) return 0
  return Math.max(0, Math.ceil((at - Date.now()) / 1000))
}

/**
 * A phone scanned the pairing QR code and is waiting. Nothing is paired until
 * the person at this keyboard answers, so the prompt names the phone, where it
 * connected from and how long is left.
 */
export function PairRequestDialog({ request, onDecide }: PairRequestDialogProps): ReactElement | null {
  const [remaining, setRemaining] = useState(0)

  useEffect(() => {
    if (!request) return
    setRemaining(remainingSeconds(request.expiresAt))
    const timer = window.setInterval(() => {
      setRemaining(remainingSeconds(request.expiresAt))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [request])

  if (!request) return null

  const from =
    request.via === 'relay'
      ? t('云端中继')
      : t('局域网 · {v1}', { v1: request.address ?? t('未知地址') })

  return (
    <div className="modal-backdrop" role="presentation">
      <div
        className="modal pair-request-modal"
        role="alertdialog"
        aria-modal="true"
        aria-label={t('手机请求连接这台电脑')}
      >
        <div className="modal-head">
          <div>
            <h2>{t('手机请求连接这台电脑')}</h2>
            <p>{t('扫码不会自动配对：确认之后，这台手机才能读取会话、查看文件并驱动 Agent。')}</p>
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
          <div className="pair-request-device">
            <span className="pair-request-icon" aria-hidden="true">
              <PhoneIcon />
            </span>
            <div>
              <strong>{request.name}</strong>
              <span>{request.platform}</span>
            </div>
          </div>
          <dl className="pair-request-meta">
            <div>
              <dt>{t('连接方式')}</dt>
              <dd>{from}</dd>
            </div>
            <div>
              <dt>{t('等待时间')}</dt>
              <dd>
                {remaining > 0 ?
                  t('{v1} 秒后自动拒绝', { v1: remaining })
                : t('已超时，将自动拒绝')}
              </dd>
            </div>
          </dl>
          <p className="pair-request-warning">
            {t('只在你本人刚刚扫描了电脑上的二维码时允许。若你没有拿出手机扫码，请选拒绝；拒绝后手机需要重新扫码。')}
          </p>
        </div>
        <div className="modal-footer">
          <span className="pair-request-note">{t('这台手机还可以随时在电脑上解除授权。')}</span>
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
              onClick={() => onDecide(request.requestId, true)}
            >
              {t('允许连接')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
