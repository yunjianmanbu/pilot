import type { FilePreview } from '../../../shared/types'
import { t } from '../i18n'

/**
 * Shared body of the file preview drawer. Media and web pages come from the
 * `pilot-media` protocol, so the renderer never receives a raw local path and
 * a file outside the open workspace simply fails to load.
 */
export function FilePreviewBody({ preview }: { preview: FilePreview }) {
  const url = preview.url ?? ''

  if (preview.kind === 'image' && url) {
    return (
      <div className="preview-media">
        <img src={url} alt={preview.path} />
      </div>
    )
  }

  if (preview.kind === 'video' && url) {
    return (
      <div className="preview-media">
        <video src={url} controls preload="metadata" playsInline />
      </div>
    )
  }

  if (preview.kind === 'audio' && url) {
    return (
      <div className="preview-media audio">
        <audio src={url} controls preload="metadata" />
        <span className="preview-media-hint">{t("音频文件，可在应用内直接播放和拖动进度。")}</span>
      </div>
    )
  }

  if (preview.kind === 'html' && url) {
    return (
      <div className="preview-web">
        <button
          type="button"
          className="primary-button"
          onClick={() => {
            void window.pilot.openLink(url)
          }}
        >
          {t("预览网页")}
        </button>
        <span className="preview-media-hint">
          {t("网页在独立预览窗口打开，与主界面隔离，拿不到本机文件。")}
        </span>
      </div>
    )
  }

  return <pre className="preview-code">{preview.content}</pre>
}
