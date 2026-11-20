/**
 * The standalone document window.
 *
 * A file preview inside the main window competes with the transcript for
 * space, and a long markdown page or an HTML report is easier to read in a
 * window of its own. This window loads the *same* renderer bundle as the main
 * window, but with `?doc=1` in the query, so `doc.tsx` mounts `DocumentWindow`
 * instead of the app shell: no sidebar, no transcript, no run of its own.
 *
 * The file itself is still read through `pilot:file-preview`, which re-applies
 * the workspace jail on every call — the window never receives a raw path it
 * could turn into arbitrary disk access.
 */
import { BrowserWindow, nativeTheme, shell } from 'electron'
import { basename, join } from 'node:path'
import { windowIconOption } from './app-icon'

/** Enough for a comparison of a few files, small enough to stay bounded. */
const MAX_DOCUMENT_WINDOWS = 8

interface DocumentRecord {
  window: BrowserWindow
  contentsId: number
}

const documents: DocumentRecord[] = []

export interface OpenDocumentWindowOptions {
  /** Absolute path of the open workspace. */
  workspace: string
  /** Workspace-relative path of the file to show. */
  relativePath: string
  /** Absolute path of the preload bundle (same one the main window uses). */
  preload: string
}

function destroyable(record: DocumentRecord): boolean {
  return !record.window.isDestroyed()
}

function dropDestroyed(): void {
  for (let index = documents.length - 1; index >= 0; index -= 1) {
    const record = documents[index]
    if (!record || destroyable(record)) continue
    documents.splice(index, 1)
  }
}

/**
 * True when the IPC sender is one of our own document windows. The main window
 * has its own check; every other renderer (including the isolated HTML preview
 * window) stays rejected.
 */
export function isDocumentWindowContents(contentsId: number): boolean {
  dropDestroyed()
  return documents.some((record) => record.contentsId === contentsId)
}

/** How many document windows are open; used by the tests and the menu. */
export function documentWindowCount(): number {
  dropDestroyed()
  return documents.length
}

export function openDocumentWindow(options: OpenDocumentWindowOptions): void {
  dropDestroyed()
  // The oldest window is recycled first: previews are cheap to reopen, and an
  // unbounded number of renderers would eat memory for no benefit.
  while (documents.length >= MAX_DOCUMENT_WINDOWS) {
    const oldest = documents.shift()
    oldest?.window.destroy()
  }

  const title = basename(options.relativePath)
  const created = new BrowserWindow({
    width: 1180,
    height: 880,
    minWidth: 640,
    minHeight: 420,
    show: false,
    title,
    ...windowIconOption(),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#111111' : '#f4f4f4',
    autoHideMenuBar: true,
    webPreferences: {
      preload: options.preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      // A document window shows one file; spellchecking every word of a report
      // would only add noise (and its own dictionary download).
      spellcheck: false,
    },
  })

  const record: DocumentRecord = { window: created, contentsId: created.webContents.id }
  documents.push(record)
  created.on('closed', () => {
    const index = documents.indexOf(record)
    if (index >= 0) documents.splice(index, 1)
  })

  created.once('ready-to-show', () => created.show())
  created.webContents.setWindowOpenHandler(({ url }) => {
    // A document may not spawn more windows; web links go to the OS browser.
    if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  created.webContents.on('will-navigate', (event, url) => {
    if (url !== created.webContents.getURL()) event.preventDefault()
  })
  created.webContents.on('will-attach-webview', (event) => event.preventDefault())

  const query = `workspace=${encodeURIComponent(options.workspace)}&path=${encodeURIComponent(options.relativePath)}`
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void created.loadURL(`${devUrl.replace(/\/$/, '')}/doc.html?${query}`)
  } else {
    void created.loadFile(join(__dirname, '../renderer/doc.html'), {
      query: { workspace: options.workspace, path: options.relativePath },
    })
  }
}
