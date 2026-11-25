/**
 * `.docx` → a self-contained HTML body, rendered inside a locked-down iframe.
 *
 * WordprocessingML is not something we can lay out ourselves, and mammoth's
 * whole job is exactly this conversion, so the work is delegated to it. The
 * resulting markup is still untrusted (it comes from a user file), which is why
 * the drawer never injects it into the app document: it goes into an iframe
 * with `sandbox=""`, so scripts, forms, navigation and top-level access are all
 * disabled, and a malformed document can at worst draw a broken page.
 */

import mammoth from 'mammoth'

export interface DocxResult {
  /** HTML body fragment produced by mammoth. */
  html: string
  /** Conversion warnings worth surfacing (unsupported styles, missing images). */
  messages: string[]
}

/** A paragraph-heavy contract is still small; past this the preview stops growing. */
const MAX_HTML_CHARS = 2_000_000

/**
 * Convert a `.docx` buffer to an HTML fragment.
 *
 * Both `arrayBuffer` and `buffer` are passed because mammoth picks the key by
 * its own build: the browser build reads `arrayBuffer`, the Node build reads
 * `buffer`. Passing both keeps the unit test (plain Node) and the renderer on
 * the same call site.
 */
export async function docxToHtml(data: ArrayBuffer): Promise<DocxResult> {
  const result = await mammoth.convertToHtml({
    arrayBuffer: data,
    buffer: new Uint8Array(data),
  })
  let html = String(result.value ?? '')
  const messages = (result.messages ?? []).map((entry) => String(entry.message ?? ''))
  if (html.length > MAX_HTML_CHARS) {
    html = `${html.slice(0, MAX_HTML_CHARS)}<p class="truncated">…</p>`
    messages.push('文档过长，预览只显示前面一部分')
  }
  return { html, messages: messages.filter(Boolean).slice(0, 12) }
}

/**
 * Wrap a converted fragment into a full document for the iframe.
 *
 * `srcdoc` documents inherit the parent CSP, so no script can run even before
 * the `sandbox` attribute does its job; the wrapper only adds typography that
 * approximates Word's page and switches to the surrounding theme via CSS
 * variables handed in as inline style values.
 */
export function docxFrameDocument(html: string, theme?: { fg?: string; bg?: string }): string {
  const fg = safeColor(theme?.fg) ?? '#1f2328'
  const bg = safeColor(theme?.bg) ?? '#ffffff'
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<style>
      :root { color-scheme: light; }
      html, body { margin: 0; padding: 0; background: transparent; }
      body {
        color: ${fg};
        background: ${bg};
        font: 15px/1.65 -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
        padding: 28px 34px 60px;
        max-width: 860px;
        margin: 0 auto;
        overflow-wrap: break-word;
      }
      h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin: 1.2em 0 0.5em; }
      h1 { font-size: 1.7em; } h2 { font-size: 1.42em; } h3 { font-size: 1.2em; }
      p { margin: 0.65em 0; }
      table { border-collapse: collapse; margin: 1em 0; max-width: 100%; }
      td, th { border: 1px solid rgba(128,128,128,0.35); padding: 6px 10px; vertical-align: top; }
      img { max-width: 100%; height: auto; }
      a { color: #2563eb; }
      blockquote { margin: 1em 0; padding-left: 14px; border-left: 3px solid rgba(128,128,128,0.4); color: inherit; opacity: 0.85; }
      pre { background: rgba(128,128,128,0.12); padding: 10px 12px; overflow: auto; }
      .truncated { opacity: 0.6; }
    </style>`,
    '</head><body>',
    html,
    '</body></html>',
  ].join('')
}

/** Only `#rgb`, `#rrggbb` and `rgb()/rgba()` pass; anything else falls back. */
export function safeColor(value: string | undefined): string | undefined {
  if (!value) return undefined
  const text = String(value).trim()
  if (/^#[0-9a-f]{3,8}$/i.test(text)) return text
  if (/^rgba?\([\d\s.,%]+\)$/i.test(text)) return text
  return undefined
}
