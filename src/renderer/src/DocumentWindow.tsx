import { useEffect, useState } from 'react'
import type { DocumentWindowState, FilePreview } from '../../shared/types'
import { resolveThemePreference } from '../../shared/theme'
import { applyLocaleSetting, t } from './i18n'
import { FilePreviewBody } from './components/FilePreviewBody'
import { RefreshIcon, XIcon } from './icons'

/**
 * A file shown in its own window.
 *
 * Why this exists: reading a generated report used to mean opening the drawer
 * over the transcript, which on a small window hid the run the user was
 * watching. This window loads the same bundle with `?doc=1`, so it can render
 * the exact same preview body while the main window keeps its layout — and
 * because it only ever calls `previewFile` / `documentState` / `closeDocument`,
 * it cannot touch a run at all.
 */
export function DocumentWindow({ workspace, path }: { workspace: string; path: string }) {
  const [preview, setPreview] = useState<FilePreview | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)

  // Paint with the same palette as the app: the settings live in the store the
  // main window writes, and this window must not read the disk itself.
  useEffect(() => {
    let cancelled = false
    void window.pilot
      .documentState()
      .then((state: DocumentWindowState) => {
        if (cancelled) return
        const root = document.documentElement
        const query = window.matchMedia('(prefers-color-scheme: dark)')
        root.dataset['theme'] = resolveThemePreference(state.theme as never, query.matches)
        root.dataset['accent'] = state.accent
        root.dataset['contrast'] = state.contrast
        root.dataset['saturation'] = state.saturation
        root.dataset['fontSize'] = state.fontSize
        root.dataset['platform'] = state.platform
        applyLocaleSetting(state.locale)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    window.pilot
      .previewFile(workspace, path)
      .then((next) => {
        if (cancelled) return
        setPreview(next)
        setError('')
      })
      .catch((reason: unknown) => {
        if (cancelled) return
        setPreview(null)
        setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [workspace, path, reloadKey])

  const name = path.split(/[\\/]/).pop() ?? path

  return (
    <div className="doc-window">
      <header className="doc-window-head">
        <span className="doc-window-name" title={path}>
          {name}
        </span>
        <button
          type="button"
          className="icon-text-button"
          title={t('重新读取文件')}
          onClick={() => setReloadKey((value) => value + 1)}
        >
          <RefreshIcon width={12} height={12} />
          {t('刷新')}
        </button>
        <button
          type="button"
          className="icon-button"
          title={t('关闭窗口')}
          aria-label={t('关闭')}
          onClick={() => {
            void window.pilot.closeDocument()
          }}
        >
          <XIcon width={14} height={14} />
        </button>
      </header>
      <main className="doc-window-body">
        {error ? <div className="doc-window-error">{error}</div> : null}
        {!error && preview ? (
          <FilePreviewBody key={preview.path} preview={preview} />
        ) : null}
        {!error && !preview && loading ? (
          <div className="preview-loading">
            <i className="spinner" />
            {t('打开文件…')}
          </div>
        ) : null}
      </main>
    </div>
  )
}
