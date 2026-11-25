/**
 * `.pdf` → pages drawn on a canvas by PDF.js.
 *
 * The renderer never hands the PDF to Chromium's built-in viewer: that needs the
 * `plugins` web preference, which is off in this app on purpose. PDF.js draws
 * into a `<canvas>` we own, so the document still goes through the same
 * workspace-jailed URL and the same sandboxed renderer as everything else.
 *
 * The worker source is bundled as text and started from a `blob:` URL instead of
 * a `file://` asset path: the packaged renderer is loaded from `file://`, whose
 * null origin cannot construct a Worker from another `file://` URL. The CSP in
 * `index.html` / `doc.html` allows exactly that (`worker-src 'self' blob:`), and
 * if the worker still cannot start PDF.js falls back to parsing on the main
 * thread, so a preview always renders — just slower.
 */

import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import workerSource from 'pdfjs-dist/build/pdf.worker.min.mjs?raw'

let workerConfigured = false

function configureWorker(): void {
  if (workerConfigured) return
  workerConfigured = true
  try {
    if (!workerSource) throw new Error('empty worker source')
    // One blob per process: PDF.js reuses the URL for every later document.
    pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(
      new Blob([workerSource], { type: 'text/javascript' }),
    )
  } catch {
    // No bundled worker: PDF.js runs the parser inline on the main thread.
  }
}

/** A parsed PDF plus the handle that releases its worker transport. */
export interface OpenedPdf {
  doc: PDFDocumentProxy
  /** `PDFDocumentProxy.destroy` is not in the shipped typings; the task owns it. */
  destroy(): Promise<void>
}

/** Open a PDF from raw bytes. The caller owns it and must call `destroy()`. */
export async function openPdfDocument(data: ArrayBuffer): Promise<OpenedPdf> {
  configureWorker()
  const task = pdfjsLib.getDocument({
    data: new Uint8Array(data),
    // `isEvalSupported` was removed in PDF.js 6; the CSP keeps `unsafe-eval`
    // unused for this bundle anyway, so a crafted font program cannot JIT.
    useSystemFonts: true,
    /*
      PDF.js 6 paints through a renderer worker by default, into an
      OffscreenCanvas it then blits onto the page canvas. In this build that
      blit lands 180° rotated (measured: text upside down and the page's top
      content at the bottom), so the drawing stays on the main thread. Parsing
      still happens in the worker; only the paint is inline.
    */
    disableWorkerRendering: true,
  })
  const doc = await task.promise
  return { doc, destroy: () => task.destroy() }
}

export interface RenderedPage {
  /** CSS width the page wants at the given scale. */
  width: number
  height: number
}

/**
 * A render in flight. PDF.js refuses a second `render()` on a canvas whose
 * previous task has not settled ("Cannot use the same canvas during multiple
 * render() operations"), and the drawer resizes while it opens — so the caller
 * gets a handle to stop the old paint before starting the next one.
 */
export interface PageRender {
  /** Settles once the pixels are on the canvas; rejects when cancelled. */
  done: Promise<RenderedPage>
  /** Stop the render task. Reuse the canvas only after `done` settles. */
  cancel(): void
}

/** Thrown by `done` when the caller cancelled; never a user-facing failure. */
export class PdfRenderCancelled extends Error {
  constructor() {
    super('pdf render cancelled')
    this.name = 'PdfRenderCancelled'
  }
}

/**
 * Draw one page into a canvas, sized for the device pixel ratio so text stays
 * crisp on HiDPI screens.
 */
export function renderPdfPage(
  doc: PDFDocumentProxy,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  cssWidth: number,
): PageRender {
  let cancelled = false
  let task: { cancel(): void; promise: Promise<void> } | null = null

  const done = (async (): Promise<RenderedPage> => {
    const page = await doc.getPage(pageNumber)
    try {
      if (cancelled) throw new PdfRenderCancelled()
      const unscaled = page.getViewport({ scale: 1 })
      const ratio = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
      const width = Math.max(120, Math.round(cssWidth))
      const scale = (width / unscaled.width) * ratio
      const viewport = page.getViewport({ scale })
      canvas.width = Math.max(1, Math.floor(viewport.width))
      canvas.height = Math.max(1, Math.floor(viewport.height))
      canvas.style.width = `${width}px`
      canvas.style.height = `${Math.round(viewport.height / ratio)}px`
      const context = canvas.getContext('2d')
      if (!context) throw new Error('画布不可用')
      task = page.render({ canvas, canvasContext: context, viewport })
      await task.promise
      if (cancelled) throw new PdfRenderCancelled()
      return { width, height: Math.round(viewport.height / ratio) }
    } finally {
      page.cleanup()
    }
  })()

  return {
    done,
    cancel() {
      cancelled = true
      task?.cancel()
    },
  }
}
