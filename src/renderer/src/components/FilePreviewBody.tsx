import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import type { FilePreview } from '../../../shared/types'
import {
  clampZoom,
  isDocumentKind,
  parseMediaUrl,
  stepZoom,
  zoomLabel,
  zoomShortcut,
} from '../../../shared/media'
import { DocumentPreview } from './DocumentPreview'
import { Markdown } from './Markdown'
import { PopoutIcon } from '../icons'
import { t } from '../i18n'

/** Folder a previewed document lives in, decoded from its `pilot-media:` base. */
function documentFolder(preview: FilePreview): string {
  if (!preview.baseUrl) return ''
  return parseMediaUrl(preview.baseUrl)?.base ?? ''
}

/**
 * Shared body of the file preview: the drawer inside the main window and the
 * standalone document window both render this, so a zoom control or a new
 * renderer only has to be written once.
 *
 * Media and web pages come from the `pilot-media` protocol, so the renderer
 * never receives a raw local path and a file outside the open workspace simply
 * fails to load. HTML is shown in a sandboxed frame that may not reach the
 * network; markdown is rendered by the same component the transcript uses.
 */
export function FilePreviewBody({
  preview,
  workspacePath,
  onOpenWindow,
  onOpenExternal,
}: {
  preview: FilePreview
  /**
   * Absolute path of the open workspace. The high-fidelity document render
   * needs it: the main process resolves the file inside this root and only then
   * hands it to an office application.
   */
  workspacePath?: string
  /** Omit inside the standalone window: opening a window from it would nest. */
  onOpenWindow?: () => void
  /**
   * Opens this file with the system application. Document previews offer it as
   * the way out when the bytes cannot be drawn in-app (legacy Office formats,
   * an encrypted PDF, an oversized scan).
   */
  onOpenExternal?: () => void
}) {
  const url = preview.url ?? ''
  const [zoom, setZoom] = useState(1)
  const scrollRef = useRef<HTMLDivElement>(null)
  // The wheel and key listeners are registered once per file; they read the
  // latest zoom through a ref so a fast Ctrl+wheel does not need a re-bind.
  const zoomRef = useRef(1)
  zoomRef.current = zoom

  // A new file starts at 100%: inheriting the previous zoom would make the
  // next file look like it rendered wrong.
  useEffect(() => {
    setZoom(1)
  }, [preview.path])

  // Code, prose and pictures all scale; a video or a <audio> player does not.
  const zoomable =
    preview.kind === 'text' || preview.kind === 'markdown' || preview.kind === 'image'

  const applyZoom = useCallback((next: number) => {
    setZoom(clampZoom(next))
  }, [])

  // Ctrl/Cmd + wheel is the gesture every editor uses. Registered natively
  // because React's wheel listener is passive and could not preventDefault.
  useEffect(() => {
    const node = scrollRef.current
    if (!node || !zoomable) return
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      applyZoom(stepZoom(zoomRef.current, event.deltaY < 0 ? 1 : -1))
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => node.removeEventListener('wheel', onWheel)
  }, [applyZoom, zoomable, preview.path])

  // Ctrl/Cmd + `=`, `-`, `0` while the preview is open. Same guard as the
  // wheel: only when this body is the one on screen.
  useEffect(() => {
    if (!zoomable) return
    const onKey = (event: KeyboardEvent) => {
      const intent = zoomShortcut(event.key, event.metaKey || event.ctrlKey)
      if (intent === null) return
      event.preventDefault()
      setZoom(intent === 0 ? 1 : stepZoom(zoomRef.current, intent))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zoomable])

  const folder = preview.baseUrl ? documentFolder(preview) : undefined

  return (
    <div className="preview-body">
      <div className="preview-tools">
        {zoomable ? (
          <>
            <button
              type="button"
              className="preview-zoom-step"
              title={t('缩小（Ctrl + -）')}
              aria-label={t('缩小')}
              disabled={zoom <= 0.5}
              onClick={() => applyZoom(stepZoom(zoom, -1))}
            >
              −
            </button>
            <button
              type="button"
              className="preview-zoom-value"
              title={t('重置为 100%（Ctrl + 0）')}
              onClick={() => applyZoom(1)}
            >
              {zoomLabel(zoom)}
            </button>
            <button
              type="button"
              className="preview-zoom-step"
              title={t('放大（Ctrl + =）')}
              aria-label={t('放大')}
              disabled={zoom >= 3}
              onClick={() => applyZoom(stepZoom(zoom, 1))}
            >
              +
            </button>
          </>
        ) : (
          <span className="preview-tools-hint">{preview.language}</span>
        )}
        <span className="preview-tools-gap" />
        {/*
          Always reachable, whatever the in-app renderer managed to draw: the
          layout a document will really have is sometimes only visible in the
          application that authored it.
        */}
        {isDocumentKind(preview.kind) && onOpenExternal ? (
          <button
            type="button"
            className="preview-window-button"
            title={t('用本机的 Word / Excel / PowerPoint 等软件打开')}
            onClick={onOpenExternal}
          >
            {t('本地软件打开')}
          </button>
        ) : null}
        {onOpenWindow ? (
          <button
            type="button"
            className="preview-window-button"
            title={t('在独立窗口打开，不影响正在执行的任务')}
            onClick={onOpenWindow}
          >
            <PopoutIcon width={12} height={12} />
            {t('新窗口')}
          </button>
        ) : null}
      </div>

      <div
        className={`preview-surface${zoomable ? ' zoomable' : ''}`}
        ref={scrollRef}
        style={{ '--preview-zoom': String(zoom) } as CSSProperties}
      >
        {preview.kind === 'image' && url ? (
          <div className="preview-media">
            <img src={url} alt={preview.path} />
          </div>
        ) : null}

        {preview.kind === 'video' && url ? (
          <div className="preview-media">
            <video src={url} controls preload="metadata" playsInline />
          </div>
        ) : null}

        {preview.kind === 'audio' && url ? (
          <div className="preview-media audio">
            <audio src={url} controls preload="metadata" />
            <span className="preview-media-hint">
              {t('音频文件，可在应用内直接播放和拖动进度。')}
            </span>
          </div>
        ) : null}

        {preview.kind === 'html' && url ? (
          <div className="preview-doc-html">
            {/*
              Sandboxed to inline script only: no same-origin access, no
              top-level navigation. The protocol response carries its own CSP
              as well, so a page cannot lift the restriction on itself.
            */}
            <iframe
              src={url}
              title={preview.path}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
            />
          </div>
        ) : null}

        {preview.kind === 'markdown' ? (
          <div className="preview-doc">
            <Markdown content={preview.content} baseDir={folder} />
          </div>
        ) : null}

        {isDocumentKind(preview.kind) ? (
          <DocumentPreview
            preview={preview}
            {...(workspacePath ? { workspacePath } : {})}
            onOpenFallback={onOpenExternal}
          />
        ) : null}

        {preview.kind === 'text' ? <pre className="preview-code">{preview.content}</pre> : null}
      </div>
    </div>
  )
}
