import type { CheckpointPreview } from '../../../shared/types'
import { formatBytes } from '../../../shared/system-info'
import { t } from '../i18n'

/**
 * The line under 「快照范围」 that answers "how much do I keep if I follow the source".
 *
 * Both numbers come from the same read-only preview, so they describe one walk of
 * the same workspace — comparing them is the point, and a second request would let
 * the two disagree while the user is deciding.
 */
export function CheckpointScopeSummary({
  preview,
  error,
  busy,
}: {
  preview: CheckpointPreview | null
  error: string
  busy: boolean
}) {
  const text = error
    ? t('无法统计这个工作区：{v1}', { v1: error })
    : preview
      ? t('按当前跳过路径估算：全部文件 {v1} 个 / {v2}；仅源码、文档与配置 {v3} 个 / {v4}。', {
          v1: preview.files.toLocaleString(),
          v2: formatBytes(preview.bytes),
          v3: preview.codeFiles.toLocaleString(),
          v4: formatBytes(preview.codeBytes),
        }) + (preview.truncated ? t('只扫描了一部分，实际数字会更大。') : '')
      : busy
        ? t('正在统计这个工作区的文件…')
        : ''
  return <p className="settings-hint checkpoint-preview-hint">{text}</p>
}
