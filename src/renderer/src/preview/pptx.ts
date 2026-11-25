/**
 * `.pptx` → an outline the preview can draw.
 *
 * There is no in-app layout engine for Office shapes, so this reads the deck
 * as a ZIP (`pptx` is OPC/XML) and reports, per slide, the paragraphs in
 * reading order plus the pictures it references. That is an honest outline: a
 * reader sees the words and the images on every page, but not the exact
 * positions. Parsing is pure — no DOM, no React — so the unit tests can run it
 * against a ZIP built on the fly.
 */

import JSZip from 'jszip'

/** One picture of a slide, already inlined as a `data:` URL. */
export interface PptxImage {
  src: string
  /** `wdith`/`height` come from the file name suffix when PowerPoint wrote one. */
  name: string
}

export interface PptxSlide {
  /** 1-based page number shown in the header. */
  number: number
  paragraphs: string[]
  images: PptxImage[]
  /** Notes text when the deck carries speaker notes. */
  notes: string[]
}

export interface PptxDeck {
  slides: PptxSlide[]
  /** Slide size in EMU, used to keep the page aspect ratio. */
  width: number
  height: number
  /** True when the deck has more slides than the preview draws. */
  truncated: boolean
}

/** A deck this large is a brochure, not something a drawer previews. */
const MAX_SLIDES = 200
/** Total bytes of inlined pictures; past this the rest are skipped by name. */
const MAX_INLINE_BYTES = 24 * 1024 * 1024
const MAX_PARAGRAPHS = 400

const EMU_PER_INCH = 914_400
const DEFAULT_WIDTH = 12_192_000
const DEFAULT_HEIGHT = 6_858_000

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

/** Decode the five XML entities plus numeric references. */
export function decodeXmlText(value: string): string {
  return String(value ?? '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    return XML_ENTITIES[body.toLowerCase()] ?? whole
  })
}

/**
 * Paragraphs of one slide, in document order.
 *
 * A paragraph is `<a:p>` … `</a:p>`; each visible character sits in an `<a:t>`
 * run, and PowerPoint splits a sentence across runs whenever the formatting
 * changes, so the runs of one paragraph are concatenated. `<a:br/>` becomes a
 * newline inside the paragraph.
 */
export function slideParagraphs(xml: string): string[] {
  const out: string[] = []
  for (const raw of String(xml ?? '').split(/<\/a:p>/)) {
    const runs: string[] = []
    for (const matched of raw.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)) {
      runs.push(decodeXmlText(matched[1] ?? ''))
    }
    if (runs.length === 0) continue
    const text = runs.join('').replace(/\u000b/g, '\n').trim()
    if (!text) continue
    out.push(text)
    if (out.length >= MAX_PARAGRAPHS) break
  }
  return out
}

/** Absolute ZIP paths are the only thing we accept from a relationship. */
function resolvePartPath(fromPart: string, target: string): string | null {
  const clean = String(target ?? '').replace(/\\/g, '/').trim()
  if (!clean || /^[a-z][a-z0-9+.-]*:/i.test(clean)) return null
  const base = fromPart.split('/').slice(0, -1)
  for (const segment of clean.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (base.length === 0) return null
      base.pop()
      continue
    }
    base.push(segment)
  }
  return base.join('/')
}

interface Relationship {
  type: string
  target: string
}

/** `rId5 → { type, target }` from one `*.rels` part. */
export function parseRelationships(xml: string): Map<string, Relationship> {
  const map = new Map<string, Relationship>()
  for (const matched of String(xml ?? '').matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const attrs = matched[1] ?? ''
    const id = /\bId="([^"]*)"/.exec(attrs)?.[1]
    const target = /\bTarget="([^"]*)"/.exec(attrs)?.[1]
    const type = /\bType="([^"]*)"/.exec(attrs)?.[1] ?? ''
    if (id && target) map.set(id, { type, target: decodeXmlText(target) })
  }
  return map
}

/** Order of the slides as the deck presents them, from `sldIdLst`. */
function slideOrder(presentationXml: string, rels: Map<string, Relationship>): string[] {
  const order: string[] = []
  for (const matched of String(presentationXml ?? '').matchAll(/<p:sldId\b([^>]*)\/?>/g)) {
    const id = /\br:id="([^"]*)"/.exec(matched[1] ?? '')?.[1]
    const rel = id ? rels.get(id) : undefined
    if (!rel) continue
    const part = resolvePartPath('ppt/presentation.xml', rel.target)
    if (part) order.push(part)
  }
  return order
}

function slideSize(presentationXml: string): { width: number; height: number } {
  const matched = /<p:sldSz\b([^>]*)\/?>/.exec(String(presentationXml ?? ''))
  const attrs = matched?.[1] ?? ''
  const width = Number(/\bcx="(\d+)"/.exec(attrs)?.[1])
  const height = Number(/\bcy="(\d+)"/.exec(attrs)?.[1])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT }
  }
  return { width, height }
}

function mimeForPart(name: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? ''
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'svg') return 'image/svg+xml'
  if (ext === 'bmp') return 'image/bmp'
  if (ext === 'tif' || ext === 'tiff') return 'image/tiff'
  if (ext === 'emf' || ext === 'wmf') return 'image/emf'
  return 'image/png'
}

/** Speaker notes of one slide, flattened to plain paragraphs. */
function notesParagraphs(xml: string): string[] {
  return slideParagraphs(xml).slice(0, 40)
}

/**
 * Read a deck. `data` is the raw `.pptx` bytes.
 *
 * A slide whose XML cannot be read is kept as an empty page instead of failing
 * the whole preview: one broken page must not hide the other forty.
 */
export async function parsePptx(data: ArrayBuffer): Promise<PptxDeck> {
  const zip = await JSZip.loadAsync(data)
  const readText = async (path: string): Promise<string> => {
    const entry = zip.file(path)
    return entry ? entry.async('string') : ''
  }

  const presentationXml = await readText('ppt/presentation.xml')
  const presentationRels = parseRelationships(await readText('ppt/_rels/presentation.xml.rels'))
  let order = slideOrder(presentationXml, presentationRels)
  if (order.length === 0) {
    // A deck without `sldIdLst` is malformed; fall back to the file names so
    // the pages still show up in numeric order.
    order = Object.keys(zip.files)
      .filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
      .sort((left, right) => {
        const a = Number(/slide(\d+)\.xml$/.exec(left)?.[1] ?? 0)
        const b = Number(/slide(\d+)\.xml$/.exec(right)?.[1] ?? 0)
        return a - b
      })
  }

  const { width, height } = slideSize(presentationXml)
  const slides: PptxSlide[] = []
  let inlined = 0

  for (const part of order.slice(0, MAX_SLIDES)) {
    const xml = await readText(part)
    const relsPath = `${part.replace(/[^/]+$/, '')}_rels/${part.split('/').pop() ?? ''}.rels`
    const rels = parseRelationships(await readText(relsPath))
    const images: PptxImage[] = []
    let notesPart = ''
    for (const rel of rels.values()) {
      if (/\/notesSlide$/i.test(rel.type)) {
        notesPart = resolvePartPath(part, rel.target) ?? ''
        continue
      }
      if (!/\/image$/i.test(rel.type)) continue
      const mediaPart = resolvePartPath(part, rel.target)
      if (!mediaPart) continue
      const entry = zip.file(mediaPart)
      if (!entry) continue
      const bytes = await entry.async('uint8array')
      if (inlined + bytes.byteLength > MAX_INLINE_BYTES) continue
      inlined += bytes.byteLength
      images.push({
        src: `data:${mimeForPart(mediaPart)};base64,${bytesToBase64(bytes)}`,
        name: mediaPart.split('/').pop() ?? '',
      })
    }
    slides.push({
      number: slides.length + 1,
      paragraphs: slideParagraphs(xml),
      images,
      notes: notesPart ? notesParagraphs(await readText(notesPart)) : [],
    })
  }

  return {
    slides,
    width,
    height,
    truncated: order.length > MAX_SLIDES,
  }
}

/** Base64 of raw bytes, without depending on `Buffer` or `btoa`. */
export function bytesToBase64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let out = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0
    const second = bytes[index + 1]
    const third = bytes[index + 2]
    out += alphabet.charAt(first >> 2)
    out += alphabet.charAt(((first & 0b11) << 4) | ((second ?? 0) >> 4))
    out += second === undefined ? '=' : alphabet.charAt(((second & 0b1111) << 2) | ((third ?? 0) >> 6))
    out += third === undefined ? '=' : alphabet.charAt(third & 0b111111)
  }
  return out
}

/** Slide aspect ratio, clamped so a corrupt `sldSz` cannot produce a 0-height page. */
export function slideAspect(width: number, height: number): number {
  const ratio = width / height
  if (!Number.isFinite(ratio) || ratio <= 0) return DEFAULT_WIDTH / DEFAULT_HEIGHT
  return Math.min(3, Math.max(0.5, ratio))
}

/** Inches shown next to the page number; EMU is the unit PowerPoint stores. */
export function slideSizeLabel(width: number, height: number): string {
  const w = width > 0 ? width / EMU_PER_INCH : DEFAULT_WIDTH / EMU_PER_INCH
  const h = height > 0 ? height / EMU_PER_INCH : DEFAULT_HEIGHT / EMU_PER_INCH
  return `${w.toFixed(1)} × ${h.toFixed(1)} in`
}
