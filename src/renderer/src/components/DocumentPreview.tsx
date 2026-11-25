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
import type { FilePreview } from '../../../shared/types'
import { isParsedDocumentKind } from '../../../shared/media'
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

export function DocumentPreview({
  preview,
  onOpenFallback,
}: {
  preview: FilePreview
  /** Opens the file with the system application; omitted when unavailable. */
  onOpenFallback?: () => void
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [loading, setLoading] = useState(true)

  const url = preview.url ?? ''
  const parsable = isParsedDocumentKind(preview.kind)

  useEffect(() => {
    if (!parsable) {
      setLoading(false)
      setLoaded(null)
      setFailure(null)
      return
    }
    if (!url) {
      setLoading(false)
      setFailure({ message: t('没有拿到这个文件的读取地址。') })
      return
    }
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

    void (async () => {
      try {
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
  }, [parsable, preview.kind, preview.path, preview.size, url])

  if (!parsable) {
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
        <p>{t('正在解析文档…')}</p>
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

  if (loaded.kind === 'pdf') return <PdfPager doc={loaded.opened.doc} pages={loaded.pages} />
  if (loaded.kind === 'docx') return <DocxFrame html={loaded.html} messages={loaded.messages} />
  if (loaded.kind === 'xlsx') return <SheetTables sheets={loaded.sheets} />
  return <SlideDeck deck={loaded.deck} />
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
