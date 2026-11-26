/**
 * In-app document preview: PDF, Word, Excel and PowerPoint.
 *
 * Everything here is parsed inside the renderer from bytes fetched over the same
 * workspace-jailed URL the media previews use, so a document outside the open
 * workspace behaves exactly like a missing file. Each parser is imported
 * lazily, which keeps the three heavy libraries out of the bundle a user pays
 * for until they open a document.
 *
 * Failure is a first-class state: a scan without a text layer, an encrypted
 * `.docx`, a spreadsheet with merged cells everywhere — the drawer shows what
 * went wrong and offers the same escape hatch as before (open it with the
 * system application), instead of rendering a blank page.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DocumentRender, DocumentRenderEngine, FilePreview } from '../../../shared/types'
import { isDocumentKind, isParsedDocumentKind } from '../../../shared/media'
import type { PptxDeck } from '../preview/pptx'
import type { OpenedPdf, PageRender } from '../preview/pdf'
import type { SheetTable } from '../preview/xlsx'
import { t } from '../i18n'

/** Past this the browser would stutter long before the parser saw the data. */
const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024

type Loaded =
  | { kind: 'docx'; html: string; messages: string[] }
  | { kind: 'xlsx'; sheets: SheetTable[] }
  | { kind: 'pptx'; deck: PptxDeck }
  | { kind: 'pdf'; pages: number; opened: OpenedPdf }

interface Failure {
  message: string
  hint?: string
}

/** Read the file through the protocol handler; the main side re-applies the jail. */
async function fetchBytes(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
  // The first preview right after a workspace opens can race the main-side
  // protocol registration and answer 404; one short retry makes it a non-event.
  let response = await fetch(url, { signal })
  if (!response.ok && response.status === 404) {
    await new Promise((resolve) => setTimeout(resolve, 150))
    if (signal.aborted) throw new DOMException('aborted', 'AbortError')
    response = await fetch(url, { signal })
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.arrayBuffer()
}

/** Human message for the exceptions the parsers actually throw. */
function explain(error: unknown): Failure {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  const message = raw.trim() || '未知错误'
  if (/password|encrypt/i.test(message)) {
    return { message: t('这个文档有密码保护，无法在应用内打开。'), hint: tidyParserMessage(message) }
  }
  if (/zip|central directory|end of data|corrupt/i.test(message)) {
    return {
      message: t('文件结构损坏，或者扩展名和真实格式对不上。'),
      hint: tidyParserMessage(message),
    }
  }
  if (/Invalid PDF|PDF structure|Missing PDF/i.test(message)) {
    return { message: t('PDF 文件不完整，或者不是标准的 PDF。'), hint: tidyParserMessage(message) }
  }
  return { message: t('这个文件暂时无法在应用内渲染。'), hint: tidyParserMessage(message) }
}

/**
 * Keep the parser's own words as evidence, but not the library's help links or
 * a wall of text: this line is read by the person using the app, not by us.
 */
export function tidyParserMessage(raw: string): string {
  const oneLine = raw.replace(/\s+/g, ' ').replace(/https?:\/\/\S+/gi, '').trim()
  const cut = oneLine.replace(/[\s:;,]+$/, '')
  return cut.length > 160 ? `${cut.slice(0, 157)}…` : cut
}

/** Name of the office application that produced a PDF, as users know it. */
export function renderEngineLabel(engine: DocumentRenderEngine | null): string {
  if (engine === 'wps') return 'WPS'
  if (engine === 'office') return 'Microsoft Office'
  if (engine === 'libreoffice') return 'LibreOffice'
  return ''
}

/**
 * What to tell the user when the native layout was not used.
 *
 * The title is written to stand on its own, because it is shown twice: as the
 * only explanation when the built-in parser cannot read the format either, and
 * as a thin line above the parsed result when the document could still be read.
 */
export function renderFallbackCopy(result: DocumentRender | null): {
  title: string
  detail?: string
} {
  if (result?.reason === 'no-engine') {
    return {
      title: t('这台电脑上没有找到 WPS、Office 或 LibreOffice。'),
      detail: t('装其中任意一个，文档就会按它自己的排版显示；现在用的是应用内置解析。'),
    }
  }
  if (result?.reason === 'failed') {
    return {
      title: t('本机办公软件没能把这份文档转成 PDF。'),
      detail: t('现在用的是应用内置解析；要看真正的排版，可以用系统应用直接打开。'),
    }
  }
  if (result?.reason === 'large') {
    return {
      title: t('文件太大，没有交给本机办公软件排版。'),
      detail: t('现在用的是应用内置解析；用系统应用打开可以保留完整排版。'),
    }
  }
  return { title: t('本机办公软件不可用，现在用的是应用内置解析。') }
}

export function DocumentPreview({
  preview,
  workspacePath,
  onOpenFallback,
}: {
  preview: FilePreview
  /**
   * Absolute root of the open workspace. With it, an Office document is first
   * converted by the office application on this machine and shown as the pages
   * that application would print; without it (a browser tab, or no workspace)
   * only the built-in parsers are available.
   */
  workspacePath?: string
  /** Opens the file with the system application; omitted when unavailable. */
  onOpenFallback?: () => void
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [loading, setLoading] = useState(true)
  /** Shown above the document: which engine laid it out, or why it did not. */
  const [note, setNote] = useState<string | null>(null)
  /** 'render' means an office application is running — it takes seconds. */
  const [stage, setStage] = useState<'render' | 'parse'>('parse')
  /**
   * The user chose the built-in parser instead of waiting for the office
   * application. Keyed by path, so opening another file tries the native layout
   * again without a second effect racing the loader.
   */
  const [skipped, setSkipped] = useState<{ path: string; value: boolean }>({
    path: '',
    value: false,
  })

  const url = preview.url ?? ''
  const parsable = isParsedDocumentKind(preview.kind)
  const skipNative = skipped.path === preview.path && skipped.value
  // A PDF is already a layout, so it goes straight to the pager; everything
  // else in the document family is worth handing to the office application.
  const renderable = Boolean(workspacePath) && preview.kind !== 'pdf' && !skipNative

  useEffect(() => {
    if (!isDocumentKind(preview.kind)) {
      setLoading(false)
      setLoaded(null)
      setFailure(null)
      return
    }
    if (!parsable && !renderable) return
    if (preview.size > MAX_DOCUMENT_BYTES) {
      setLoading(false)
      setFailure({ message: t('文件超过 64 MB，应用内预览会拖慢界面，请用系统应用打开。') })
      return
    }

    const controller = new AbortController()
    let cancelled = false
    let opened: OpenedPdf | null = null
    setLoading(true)
    setFailure(null)
    setLoaded(null)
    setNote(null)
    setStage(renderable ? 'render' : 'parse')

    void (async () => {
      try {
        if (renderable && workspacePath) {
          // A failure here is not an error the user has to fix: it only decides
          // whether the page shows native layout or the built-in parsers.
          const rendered = await window.pilot
            .renderFile(workspacePath, preview.path)
            .catch(() => null)
          if (cancelled) return
          if (rendered?.pdf && rendered.pdf.byteLength > 0) {
            const { openPdfDocument } = await import('../preview/pdf')
            // Copy out of the transferred view: PDF.js detaches its input.
            const bytes = rendered.pdf.slice()
            const pdf = await openPdfDocument(bytes.buffer as ArrayBuffer)
            if (cancelled) {
              void pdf.destroy()
              return
            }
            opened = pdf
            const label = renderEngineLabel(rendered.engine)
            if (label) {
              setNote(t('由本机 {v1} 排版，与它自己打印出来的一致。', { v1: label }))
            }
            setLoaded({ kind: 'pdf', pages: pdf.doc.numPages, opened: pdf })
            return
          }
          if (!parsable) {
            const copy = renderFallbackCopy(rendered)
            setFailure({
              message: copy.title,
              ...(copy.detail ? { hint: copy.detail } : {}),
            })
            return
          }
          setNote(renderFallbackCopy(rendered).title)
        }
        if (!url) {
          setFailure({ message: t('没有拿到这个文件的读取地址。') })
          return
        }
        setStage('parse')
        const data = await fetchBytes(url, controller.signal)
        if (cancelled) return
        if (preview.kind === 'docx') {
          const { docxToHtml } = await import('../preview/docx')
          const result = await docxToHtml(data)
          if (cancelled) return
          setLoaded({ kind: 'docx', html: result.html, messages: result.messages })
        } else if (preview.kind === 'xlsx') {
          const { parseXlsx } = await import('../preview/xlsx')
          const sheets = await parseXlsx(data)
          if (cancelled) return
          if (sheets.length === 0) {
            setFailure({ message: t('这个表格没有可预览的内容（可能是空的或被隐藏了）。') })
          } else {
            setLoaded({ kind: 'xlsx', sheets })
          }
        } else if (preview.kind === 'pptx') {
          const { parsePptx } = await import('../preview/pptx')
          const deck = await parsePptx(data)
          if (cancelled) return
          if (deck.slides.length === 0) {
            setFailure({ message: t('这个演示文稿里没有找到幻灯片。') })
          } else {
            setLoaded({ kind: 'pptx', deck })
          }
        } else if (preview.kind === 'pdf') {
          const { openPdfDocument } = await import('../preview/pdf')
          const pdf = await openPdfDocument(data)
          if (cancelled) {
            void pdf.destroy()
            return
          }
          opened = pdf
          setLoaded({ kind: 'pdf', pages: pdf.doc.numPages, opened: pdf })
        }
      } catch (error) {
        if (cancelled || controller.signal.aborted) return
        setFailure(explain(error))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
      controller.abort()
      // PDF.js keeps a worker and decoded page buffers alive until destroyed.
      void opened?.destroy()
    }
  }, [parsable, renderable, skipNative, workspacePath, preview.kind, preview.path, preview.size, url])

  if (!parsable && !renderable) {
    return (
      <Unavailable
        title={t('这类文档还不支持应用内预览')}
        detail={t('可以在系统应用里打开查看（.doc / .xls / .ppt / .odt 等旧格式请用系统应用）。')}
        onOpenFallback={onOpenFallback}
      />
    )
  }

  if (loading) {
    return (
      <div className="doc-state">
        <span className="doc-spinner" aria-hidden />
        <p>{stage === 'render' ? t('正在用本机办公软件排版…') : t('正在解析文档…')}</p>
        {stage === 'render' ? (
          <p className="doc-state-detail">
            {t('第一次打开要等几秒，之后同一个文件会直接读缓存。')}
          </p>
        ) : null}
        {/*
          A damaged file can keep the office application busy until the timeout,
          so waiting is never the only option: the parsed view is available at
          once, and the system application always is.
        */}
        {stage === 'render' ? (
          <div className="doc-state-actions">
            {parsable ? (
              <button
                type="button"
                className="doc-open-external"
                onClick={() => setSkipped({ path: preview.path, value: true })}
              >
                {t('先看内置版式')}
              </button>
            ) : null}
            {onOpenFallback ? (
              <button type="button" className="doc-open-external" onClick={onOpenFallback}>
                {t('用系统应用打开')}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    )
  }

  if (failure) {
    return (
      <Unavailable
        title={failure.message}
        detail={failure.hint}
        onOpenFallback={onOpenFallback}
      />
    )
  }

  if (!loaded) return null

  const body =
    loaded.kind === 'pdf' ? (
      <PdfPager doc={loaded.opened.doc} pages={loaded.pages} />
    ) : loaded.kind === 'docx' ? (
      <DocxFrame html={loaded.html} messages={loaded.messages} />
    ) : loaded.kind === 'xlsx' ? (
      <SheetTables sheets={loaded.sheets} />
    ) : (
      <SlideDeck deck={loaded.deck} />
    )

  return (
    <div className="doc-rendered">
      {note ? <p className="doc-render-note">{note}</p> : null}
      {body}
    </div>
  )
}

function Unavailable({
  title,
  detail,
  onOpenFallback,
}: {
  title: string
  detail?: string
  onOpenFallback?: () => void
}) {
  return (
    <div className="doc-state doc-state-error">
      <p className="doc-state-title">{title}</p>
      {detail ? <p className="doc-state-detail">{detail}</p> : null}
      {onOpenFallback ? (
        <button type="button" className="doc-open-external" onClick={onOpenFallback}>
          {t('用系统应用打开')}
        </button>
      ) : null}
    </div>
  )
}

/* ---------------------------------------------------------------- PDF ---- */

function PdfPager({ doc, pages }: { doc: import('pdfjs-dist').PDFDocumentProxy; pages: number }) {
  const [page, setPage] = useState(1)
  const [error, setError] = useState<string | null>(null)
  const [rendering, setRendering] = useState(true)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const holderRef = useRef<HTMLDivElement>(null)
  const pendingRef = useRef<PageRender | null>(null)
  const [width, setWidth] = useState(0)

  // Track the pane width so the page is redrawn when the drawer is resized.
  useEffect(() => {
    const node = holderRef.current
    if (!node) return
    const measure = (): void => setWidth(node.clientWidth)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || width <= 0) return
    let cancelled = false
    setRendering(true)
    setError(null)
    void (async () => {
      try {
        const { renderPdfPage, PdfRenderCancelled } = await import('../preview/pdf')
        /*
          The drawer resizes while it opens, so a render is often replaced
          mid-paint. PDF.js refuses a second paint on a canvas whose previous
          task has not settled, hence the wait on the cancelled handle.
        */
        await pendingRef.current?.done.catch(() => undefined)
        pendingRef.current = null
        if (cancelled) return
        // 32px keeps the page off the scrollbar; 900px is the reading width.
        const handle = renderPdfPage(doc, page, canvas, Math.min(900, Math.max(240, width - 32)))
        pendingRef.current = handle
        await handle.done
        if (!cancelled) setRendering(false)
      } catch (caught) {
        if (cancelled) return
        const { PdfRenderCancelled } = await import('../preview/pdf')
        if (cancelled || caught instanceof PdfRenderCancelled) return
        const failure = explain(caught)
        setError(failure.hint ?? failure.message)
        setRendering(false)
      }
    })()
    return () => {
      cancelled = true
      pendingRef.current?.cancel()
    }
  }, [doc, page, width])

  const go = useCallback(
    (delta: number) => setPage((current) => Math.min(pages, Math.max(1, current + delta))),
    [pages],
  )

  return (
    <div className="doc-pdf">
      <div className="doc-toolbar">
        <button type="button" disabled={page <= 1} onClick={() => go(-1)} title={t('上一页')}>
          ‹
        </button>
        <span className="doc-toolbar-label">
          {page} / {pages}
        </span>
        <button type="button" disabled={page >= pages} onClick={() => go(1)} title={t('下一页')}>
          ›
        </button>
        {rendering ? <span className="doc-toolbar-hint">{t('渲染中…')}</span> : null}
      </div>
      <div className="doc-canvas-holder" ref={holderRef}>
        <canvas ref={canvasRef} className="doc-pdf-canvas" />
      </div>
      {error ? <p className="doc-state-detail doc-pdf-error">{error}</p> : null}
    </div>
  )
}

/* --------------------------------------------------------------- Word ---- */

function DocxFrame({ html, messages }: { html: string; messages: string[] }) {
  const [source, setSource] = useState('')

  // The frame document is built off the render thread: a 2 MB conversion would
  // otherwise block the first paint of the drawer.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const { docxFrameDocument } = await import('../preview/docx')
      const theme = readThemeColors()
      if (!cancelled) setSource(docxFrameDocument(html, theme))
    })()
    return () => {
      cancelled = true
    }
  }, [html])

  return (
    <div className="doc-docx">
      <div className="doc-frame-holder">
        {source ? (
          /*
            `sandbox=""` is the whole point: no scripts, no forms, no
            same-origin access, no navigation. The parent CSP is inherited on
            top of it, so even an inline handler cannot run.
          */
          <iframe className="doc-docx-frame" title={t('文档预览')} sandbox="" srcDoc={source} />
        ) : null}
      </div>
      {messages.length > 0 ? (
        <p className="doc-note">{messages.slice(0, 3).join('；')}</p>
      ) : null}
    </div>
  )
}

/** Theme colours for the frame, read from the app's own CSS variables. */
function readThemeColors(): { fg?: string; bg?: string } {
  try {
    const style = getComputedStyle(document.documentElement)
    return {
      fg: style.getPropertyValue('--text').trim() || undefined,
      bg: style.getPropertyValue('--bg-elev').trim() || undefined,
    }
  } catch {
    return {}
  }
}

/* -------------------------------------------------------------- Excel ---- */

function SheetTables({ sheets }: { sheets: SheetTable[] }) {
  const [active, setActive] = useState(0)
  const sheet = sheets[Math.min(active, sheets.length - 1)]
  const columns = useMemo(() => {
    if (!sheet) return 0
    return sheet.rows.reduce((widest, row) => Math.max(widest, row.length), 0)
  }, [sheet])

  if (!sheet) return null

  return (
    <div className="doc-sheets">
      {sheets.length > 1 ? (
        <div className="doc-sheet-tabs" role="tablist">
          {sheets.map((entry, index) => (
            <button
              key={`${entry.name}-${index}`}
              type="button"
              role="tab"
              aria-selected={index === active}
              className={index === active ? 'active' : ''}
              onClick={() => setActive(index)}
            >
              {entry.name}
            </button>
          ))}
        </div>
      ) : null}
      <div className="doc-sheet-scroll">
        <table className="doc-sheet">
          <thead>
            <tr>
              <th className="doc-sheet-gutter" />
              {Array.from({ length: columns }, (_, index) => (
                <th key={index}>{columnName(index)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sheet.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                <th className="doc-sheet-gutter">{rowIndex + 1}</th>
                {Array.from({ length: columns }, (_, columnIndex) => (
                  <td key={columnIndex}>{row[columnIndex] ?? ''}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sheet.truncatedRows || sheet.truncatedCols ? (
        <p className="doc-note">
          {t('表格较大，只显示前 {v1} 行 × {v2} 列（共 {v3} 行 × {v4} 列）。', {
            v1: sheet.rows.length,
            v2: columns,
            v3: sheet.totalRows,
            v4: sheet.totalCols,
          })}
        </p>
      ) : null}
    </div>
  )
}

/** `A`, `Z`, `AA` — duplicated from `preview/xlsx` so the table stays sync-loaded. */
function columnName(index: number): string {
  let remaining = index
  let label = ''
  while (true) {
    label = String.fromCharCode(65 + (remaining % 26)) + label
    remaining = Math.floor(remaining / 26) - 1
    if (remaining < 0) return label
  }
}

/* --------------------------------------------------------- PowerPoint ---- */

function SlideDeck({ deck }: { deck: PptxDeck }) {
  const [index, setIndex] = useState(0)
  const slide = deck.slides[Math.min(index, deck.slides.length - 1)]
  const total = deck.slides.length

  if (!slide) return null
  const ratio = deck.width > 0 && deck.height > 0 ? deck.width / deck.height : 16 / 9

  return (
    <div className="doc-slides">
      <div className="doc-toolbar">
        <button
          type="button"
          disabled={index <= 0}
          onClick={() => setIndex((current) => Math.max(0, current - 1))}
          title={t('上一页')}
        >
          ‹
        </button>
        <span className="doc-toolbar-label">
          {slide.number} / {total}
        </span>
        <button
          type="button"
          disabled={index >= total - 1}
          onClick={() => setIndex((current) => Math.min(total - 1, current + 1))}
          title={t('下一页')}
        >
          ›
        </button>
        <span className="doc-toolbar-hint">{t('大纲预览：文字与图片按阅读顺序排列，不含原版式')}</span>
      </div>
      <div className="doc-slide-scroll">
        <div className="doc-slide" style={{ aspectRatio: String(ratio) }}>
          <div className="doc-slide-body">
            {slide.paragraphs.length === 0 && slide.images.length === 0 ? (
              <p className="doc-slide-empty">{t('这一页没有可提取的文字或图片。')}</p>
            ) : null}
            {slide.paragraphs.map((paragraph, paragraphIndex) => (
              <p key={paragraphIndex}>{paragraph}</p>
            ))}
            {slide.images.map((image, imageIndex) => (
              <img key={imageIndex} src={image.src} alt={image.name} />
            ))}
          </div>
        </div>
        {slide.notes.length > 0 ? (
          <div className="doc-slide-notes">
            <p className="doc-slide-notes-title">{t('备注')}</p>
            {slide.notes.map((note, noteIndex) => (
              <p key={noteIndex}>{note}</p>
            ))}
          </div>
        ) : null}
        {deck.truncated ? <p className="doc-note">{t('演示文稿页数较多，只显示前 200 页。')}</p> : null}
      </div>
    </div>
  )
}
