import React from 'react'
import ReactDOM from 'react-dom/client'
import { DocumentWindow } from './DocumentWindow'
import { t } from './i18n'
import './styles.css'

/**
 * Entry point of the standalone document window (`doc.html`).
 *
 * The main window keeps `index.html` → `main.tsx` → `App`; this one renders a
 * single file and nothing else, so a preview can never start a run or read a
 * session. Both share `styles.css`, so the palette and the markdown styles are
 * the same in the drawer and in the window.
 */
const params = new URLSearchParams(window.location.search)
const workspace = params.get('workspace') ?? ''
const path = params.get('path') ?? ''

function reportRendererError(summary: string, stack?: string): void {
  void window.pilot
    ?.reportRendererError({
      summary: `doc: ${summary.slice(0, 220)}`,
      stack: stack?.split('\n').slice(0, 4).join('\n').slice(0, 400),
    })
    .catch(() => undefined)
}

window.addEventListener('error', (event) => {
  const error = event.error instanceof Error ? event.error : undefined
  reportRendererError(error ? `${error.name}: ${error.message}` : String(event.message || ''), error?.stack)
})

document.documentElement.dataset['doc'] = '1'
document.title = path ? `Pilot · ${path.split(/[\\/]/).pop() ?? path}` : 'Pilot'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {workspace && path ? (
      <DocumentWindow workspace={workspace} path={path} />
    ) : (
      <div className="doc-window-error">{t('缺少文件参数，请从主界面重新打开。')}</div>
    )}
  </React.StrictMode>,
)
