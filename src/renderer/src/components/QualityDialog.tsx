import type { ReactElement } from 'react'
import type { QualityPublishTarget, QualityState } from '../../../shared/types'
import { t } from '../i18n'
import { QualityBellPanel } from './QualityBell'
import { useEscapeClose } from './useEscapeClose'

export interface QualityDialogProps {
  state: QualityState | null
  /** 批准后要跑的打包目标；未配置时面板会把按钮改成「仅更新基线」。 */
  publishTarget: QualityPublishTarget
  workspacePath: string | null
  busy: boolean
  onClose: () => void
  onDecide: (candidateId: string, decision: 'approve' | 'reject') => void
  onPublish: (candidateId: string) => void
  onEvaluate: () => void
  onTune: () => void
}

/**
 * 产出质量的裁决面板，入口在顶栏「三个点」菜单里。
 *
 * 不再占用通知中心的页签：通知中心回答「刚才发生过什么」，这里回答「这份产出
 * 要不要收」，阅读节奏不同，挤在同一层弹层里会让人把裁决当成又一条可以划走的
 * 通知。面板本体仍由 `QualityBellPanel` 负责，所以既有文案测试逐字有效。
 */
export function QualityDialog({
  state,
  publishTarget,
  workspacePath,
  busy,
  onClose,
  onDecide,
  onPublish,
  onEvaluate,
  onTune,
}: QualityDialogProps): ReactElement {
  useEscapeClose(onClose)

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal quality-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('产出质量')}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-body quality-modal-body">
          {state && workspacePath ? (
            <QualityBellPanel
              state={state}
              publishTarget={publishTarget}
              busy={busy}
              onClose={onClose}
              onDecide={onDecide}
              onPublish={onPublish}
              onEvaluate={onEvaluate}
              onTune={onTune}
            />
          ) : (
            <div className="quality-empty quality-modal-empty">
              <p>{t('还没有质量数据：先选择一个工作区，再让评估模型打分。')}</p>
              <button type="button" className="button ghost small" onClick={onClose}>
                {t('关闭')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
