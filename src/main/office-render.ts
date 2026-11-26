/**
 * High-fidelity document preview: hand a Word / Excel / PowerPoint file to the
 * office suite installed on this machine and take back a PDF.
 *
 * Why not parse the file in the renderer: mammoth, read-excel-file and our own
 * pptx reader only recover *semantics*. Column widths, page breaks, headers and
 * footers, theme fonts, shapes and slide layout all disappear — and the whole
 * point of looking at a document inside Pilot is to decide how to change it, so
 * the layout itself is content. Rendering through the real office application
 * is the only way to see the same pages the user will see.
 *
 * Why a PDF and not HTML: the PDF is a closed page description. It cannot run
 * script, cannot reach the network and cannot reference anything outside the
 * machine, so the renderer keeps drawing it through the same jailed PDF.js path
 * it already uses for `.pdf` files.
 *
 * Engine order is WPS → Microsoft Office → LibreOffice. The first engine that
 * produced a PDF is remembered for the rest of the process: on the machine this
 * was written on, every Office COM call failed with RPC_E_CALL_REJECTED while
 * WPS converted the same files, so always trying Office first would cost ~10s
 * per file before falling through.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, open, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { access } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { app } from 'electron'
import type { DocumentRender, DocumentRenderEngine } from '../shared/types'
import { log } from './diagnostics'

/** Which office application family a document belongs to. */
export type OfficeFamily = 'word' | 'excel' | 'ppt'

/**
 * Extensions each application family can open. Legacy binary formats (`doc`,
 * `xls`, `ppt`) are here on purpose: they are exactly the ones the in-app
 * parsers cannot read and the office application can.
 */
const FAMILY_BY_EXTENSION: Record<string, OfficeFamily> = {
  doc: 'word',
  docx: 'word',
  docm: 'word',
  dot: 'word',
  dotx: 'word',
  rtf: 'word',
  odt: 'word',
  xls: 'excel',
  xlsx: 'excel',
  xlsm: 'excel',
  xlsb: 'excel',
  ods: 'excel',
  ppt: 'ppt',
  pptx: 'ppt',
  pptm: 'ppt',
  pps: 'ppt',
  ppsx: 'ppt',
  odp: 'ppt',
}

const PROBE_TTL_MS = 10 * 60 * 1000
/** One conversion is allowed this long before the engine is treated as hung. */
const CONVERT_TIMEOUT_MS = 90_000
/** Sources past this are not worth a 90s conversion; the renderer says so. */
const MAX_SOURCE_BYTES = 64 * 1024 * 1024
/** Cached PDFs kept on disk; older ones are pruned after each new render. */
const CACHE_KEEP_FILES = 80

/** Family for a file name, or null when this module cannot render it. */
export function officeFamilyOf(name: string): OfficeFamily | null {
  const matched = /\.([^./\\]+)$/.exec(String(name || '').trim())
  const extension = matched?.[1]?.toLowerCase() ?? ''
  return FAMILY_BY_EXTENSION[extension] ?? null
}

/**
 * True when the host can drive any office application at all.
 *
 * `pilot serve` runs on plain Node and could convert, but the PDF bytes would
 * have to travel to the browser as one WebSocket frame; the browser side then
 * falls back to its own parsers, which is what it does today for every file.
 */
export function officeRenderSupported(): boolean {
  return typeof process.versions.electron === 'string'
}

/* ── engine discovery ───────────────────────────────────────────────────── */

const SOFFICE_CANDIDATES: Record<string, string[]> = {
  win32: [
    'C:/Program Files/LibreOffice/program/soffice.exe',
    'C:/Program Files (x86)/LibreOffice/program/soffice.exe',
  ],
  darwin: ['/Applications/LibreOffice.app/Contents/MacOS/soffice'],
  linux: [
    '/usr/bin/soffice',
    '/usr/bin/libreoffice',
    '/usr/lib/libreoffice/program/soffice',
    '/snap/bin/libreoffice',
  ],
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function findSoffice(): Promise<string | null> {
  const candidates = SOFFICE_CANDIDATES[process.platform] ?? []
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate
  }
  return null
}

function powershellPath(): string {
  const root = process.env['SystemRoot'] ?? process.env['windir'] ?? 'C:\\Windows'
  return join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/**
 * Which COM applications are registered. `Test-Path` on the ProgID is cheap and
 * does not start the application, so this stays a probe instead of a launch.
 */
const COM_PROBE_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "$ids = 'KWps.Application','Ket.Application','Kwpp.Application','Word.Application','Excel.Application','PowerPoint.Application'",
  'foreach ($id in $ids) {',
  '  if (Test-Path -LiteralPath "Registry::HKEY_CLASSES_ROOT\\$id") { Write-Output $id }',
  '}',
].join('\n')

interface ProbeState {
  at: number
  engines: DocumentRenderEngine[]
  soffice: string | null
}

let probe: ProbeState | null = null
/** Remembered across documents: the engine that last produced a PDF. */
let preferredEngine: DocumentRenderEngine | null = null

async function detectEngines(): Promise<ProbeState> {
  if (probe && Date.now() - probe.at < PROBE_TTL_MS) return probe
  const engines: DocumentRenderEngine[] = []
  const soffice = await findSoffice()
  if (process.platform === 'win32') {
    const { output } = await runProcess(
      powershellPath(),
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encodePowerShell(COM_PROBE_SCRIPT),
      ],
      15_000,
    )
    const lines = output.split(/\r?\n/).map((line) => line.trim())
    if (lines.includes('KWps.Application')) engines.push('wps')
    if (lines.includes('Word.Application') || lines.includes('Excel.Application')) {
      engines.push('office')
    }
  }
  if (soffice) engines.push('libreoffice')
  probe = { at: Date.now(), engines, soffice }
  return probe
}

function orderedEngines(available: DocumentRenderEngine[]): DocumentRenderEngine[] {
  if (!preferredEngine || !available.includes(preferredEngine)) return available
  return [preferredEngine, ...available.filter((engine) => engine !== preferredEngine)]
}

/* ── process helpers ───────────────────────────────────────────────────── */

function encodePowerShell(script: string): string {
  // PowerShell reads `-EncodedCommand` as UTF-16LE base64, which is also how a
  // Chinese file name survives the trip without any quoting rules.
  return Buffer.from(script, 'utf16le').toString('base64')
}

interface ProcessOutcome {
  code: number
  output: string
  timedOut: boolean
}

function runProcess(command: string, args: string[], timeoutMs: number): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const timedOut = Boolean((error as { killed?: boolean } | null)?.killed)
        const code = error ? Number((error as { code?: unknown }).code ?? 1) || 1 : 0
        resolve({ code, output: `${stdout ?? ''}\n${stderr ?? ''}`, timedOut })
      },
    )
  })
}

/** Single-quoted PowerShell literal: a lone quote is doubled, nothing else. */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/* ── conversion ────────────────────────────────────────────────────────── */

const PROG_IDS: Record<'wps' | 'office', Record<OfficeFamily, string>> = {
  wps: {
    word: 'KWps.Application',
    excel: 'Ket.Application',
    ppt: 'Kwpp.Application',
  },
  office: {
    word: 'Word.Application',
    excel: 'Excel.Application',
    ppt: 'PowerPoint.Application',
  },
}

/**
 * The export calls, in the order that works for each suite.
 *
 * Measured on this machine with WPS:
 * - Word: `SaveAs2(file, 17)` produced the PDF; `ExportAsFixedFormat` did not.
 * - Excel: `Workbook.ExportAsFixedFormat(0, file)` (type first) produced a PDF
 *   that can be read immediately, while `SaveAs(file, 17)` writes the same
 *   bytes but keeps the file handle open, so the caller cannot verify it. The
 *   export call therefore comes first for the spreadsheet family.
 * - PowerPoint: `SaveAs(file, 32)` produced the PDF.
 *
 * Real Office keeps the documented argument order, where the explicit export
 * call is the reliable one:
 * - Word: `ExportAsFixedFormat(OutputFileName, ExportFormat)`, 17 = wdExportFormatPDF
 * - Excel: `ExportAsFixedFormat(Type, Filename)`, 0 = xlTypePDF
 * - PowerPoint: `ExportAsFixedFormat(Path, FixedFormatType)`, 2 = ppFixedFormatTypePDF
 */
function exportAttempts(family: OfficeFamily, engine: DocumentRenderEngine): string[] {
  if (family === 'word') {
    return engine === 'wps'
      ? ['$doc.SaveAs2($out, 17)', '$doc.SaveAs($out, 17)', '$doc.ExportAsFixedFormat($out, 17)']
      : ['$doc.ExportAsFixedFormat($out, 17)', '$doc.SaveAs2($out, 17)', '$doc.SaveAs($out, 17)']
  }
  if (family === 'excel') {
    return engine === 'wps'
      ? ['$doc.ExportAsFixedFormat(0, $out)', '$doc.SaveAs($out, 17)', '$app.ActiveSheet.PrintOut(1, 1, 1, $false, $null, $false, $false, $out)']
      : ['$doc.ExportAsFixedFormat(0, $out)', '$doc.SaveAs($out, 57)', '$doc.SaveAs($out, 17)']
  }
  return [
    '$doc.SaveAs($out, 32)',
    '$doc.ExportAsFixedFormat($out, 2)',
    '$doc.ExportAsFixedFormat($out)',
  ]
}

function officeScript(
  engine: 'wps' | 'office',
  family: OfficeFamily,
  source: string,
  out: string,
): string {
  const progId = PROG_IDS[engine][family]
  const openCall =
    family === 'word'
      ? '$doc = $app.Documents.Open($src, $false, $true)'
      : family === 'excel'
        ? '$doc = $app.Workbooks.Open($src)'
        : '$doc = $app.Presentations.Open($src, $true, $false, $false)'
  const attempts = exportAttempts(family, engine)
  return [
    "$ErrorActionPreference = 'Continue'",
    `$src = ${psQuote(source)}`,
    `$out = ${psQuote(out)}`,
    `$attempts = @(${attempts.map((body) => `{ ${body} }`).join(', ')})`,
    '$app = $null',
    '$doc = $null',
    'try {',
    `  $app = New-Object -ComObject '${progId}'`,
    // Neither property exists on every suite/version; a missing one is not fatal.
    '  try { $app.Visible = $false } catch { }',
    '  try { $app.DisplayAlerts = 0 } catch { }',
    `  ${openCall}`,
    '  if ($doc -eq $null) { throw "open returned nothing" }',
    '  Write-Output "OPENED"',
    '} catch {',
    '  Write-Output ("OPENFAIL " + $_.Exception.Message)',
    '  if ($app -ne $null) { try { $app.Quit() } catch { } }',
    '  exit 3',
    '}',
    // Each attempt clears the target first, so a stale file cannot be mistaken
    // for a fresh success.
    'foreach ($attempt in $attempts) {',
    '  if (Test-Path -LiteralPath $out) { Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue }',
    '  try {',
    '    & $attempt',
    '    Start-Sleep -Milliseconds 300',
    '    if (Test-Path -LiteralPath $out) {',
    '      if ((Get-Item -LiteralPath $out).Length -gt 1024) { Write-Output "SAVED"; break }',
    '    }',
    '  } catch { Write-Output ("STEPFAIL " + $_.Exception.Message) }',
    '}',
    // WPS reports DISP_E_NOTACOLLECTION when closing a presentation it opened
    // read-only; the PDF is already on disk at that point, so it is ignored.
    'if ($doc -ne $null) { try { $doc.Close($false) } catch { } }',
    'if ($app -ne $null) { try { $app.Quit() } catch { } }',
    'if (Test-Path -LiteralPath $out) { Write-Output "DONE" } else { Write-Output "NOFILE"; exit 4 }',
  ].join('\n')
}

async function convertWithEngine(
  engine: DocumentRenderEngine,
  family: OfficeFamily,
  source: string,
  out: string,
  soffice: string | null,
): Promise<boolean> {
  // The office application always works on a copy inside the cache directory:
  // it drops `~$` lock files next to the original, and a read-only workspace
  // file must not make the preview fail for a reason the user cannot see.
  const dir = dirnameOf(out)
  const work = join(dir, `in-${basename(out, '.pdf')}${extname(source)}`)
  try {
    await copyFile(source, work)
  } catch {
    return false
  }
  try {
    if (engine === 'libreoffice') {
      if (!soffice) return false
      const started = Date.now()
      const result = await runProcess(
        soffice,
        [
          '--headless',
          '--norestore',
          '--nolockcheck',
          `-env:UserInstallation=${pathToFileUrl(join(dir, 'lo-profile'))}`,
          '--convert-to',
          'pdf',
          '--outdir',
          dir,
          work,
        ],
        CONVERT_TIMEOUT_MS,
      )
      // LibreOffice names the output after the input, so it lands beside `work`.
      const produced = join(dir, `${basename(work, extname(work))}.pdf`)
      const ok = await moveInto(produced, out)
      logConversion(engine, family, ok, Date.now() - started, ok ? '' : firstLine(result.output))
      return ok
    }
    const started = Date.now()
    const script = officeScript(engine, family, work, out)
    const result = await runProcess(
      powershellPath(),
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encodePowerShell(script),
      ],
      CONVERT_TIMEOUT_MS,
    )
    const ok = result.output.includes('DONE') && (await isUsablePdf(out))
    const note = ok ? (result.timedOut ? 'late' : '') : conversionNote(result.output)
    logConversion(engine, family, ok, Date.now() - started, note)
    return ok
  } finally {
    await unlink(work).catch(() => undefined)
  }
}

function dirnameOf(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return index > 0 ? path.slice(0, index) : '.'
}

function pathToFileUrl(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  return `file:///${normalized.replace(/^\/+/, '')}`
}

async function moveInto(from: string, to: string): Promise<boolean> {
  if (!(await isUsablePdf(from))) return false
  try {
    const bytes = await readFile(from)
    await writeFile(to, bytes)
    await unlink(from).catch(() => undefined)
    return true
  } catch {
    return false
  }
}

/** A real PDF starts with `%PDF-`; an empty or HTML error page does not. */
async function isUsablePdf(path: string): Promise<boolean> {
  // An office application can still hold the handle right after it reports
  // success, so a locked file is retried instead of being read as a failure.
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const info = await stat(path)
      if (!info.isFile() || info.size < 1024) return false
      const handle = await open(path, 'r')
      try {
        const head = Buffer.alloc(5)
        await handle.read(head, 0, 5, 0)
        if (head.toString('latin1') === '%PDF-') return true
      } finally {
        await handle.close()
      }
      return false
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES') return false
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}

function firstLine(output: string): string {
  const line = output
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0)
  if (!line) return ''
  return line.length > 120 ? `${line.slice(0, 117)}…` : line
}

/**
 * The line worth reading when a conversion failed.
 *
 * The script prints `OPENED` first and then one line per export attempt, so the
 * first line says nothing about why it failed; the failure marker does.
 */
function conversionNote(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  const marked = lines.filter((entry) => /^(STEPFAIL|OPENFAIL|NOFILE|error|Exception)/i.test(entry))
  return firstLine(marked.length > 0 ? marked.join('\n') : output)
}

function logConversion(
  engine: DocumentRenderEngine,
  family: OfficeFamily,
  ok: boolean,
  ms: number,
  note: string,
): void {
  log({
    area: 'office-render',
    event: 'convert',
    level: ok ? 'info' : 'warn',
    detail: { engine, family, ok, ms, note },
  })
}

/* ── cache ─────────────────────────────────────────────────────────────── */

async function cacheDirectory(): Promise<string> {
  const dir = join(app.getPath('userData'), 'office-pdf-cache')
  await mkdir(dir, { recursive: true })
  return dir
}

function cacheKey(source: string, size: number, mtimeMs: number, engine: string): string {
  return createHash('sha1')
    .update(`${source}|${size}|${Math.round(mtimeMs)}|${engine}|v1`)
    .digest('hex')
    .slice(0, 32)
}

async function pruneCache(dir: string): Promise<void> {
  try {
    const names = await readdir(dir)
    const files: { path: string; at: number }[] = []
    for (const name of names) {
      const path = join(dir, name)
      const info = await stat(path).catch(() => null)
      if (info?.isFile()) files.push({ path, at: info.mtimeMs })
    }
    if (files.length <= CACHE_KEEP_FILES) return
    files.sort((left, right) => left.at - right.at)
    for (const entry of files.slice(0, files.length - CACHE_KEEP_FILES)) {
      await unlink(entry.path).catch(() => undefined)
    }
  } catch {
    // Maintenance only: a locked file just stays for the next round.
  }
}

/* ── public entry ──────────────────────────────────────────────────────── */

/** In-flight conversions, so a double-click does not start two office apps. */
const inflight = new Map<string, Promise<Uint8Array | null>>()
/** Conversions are serialised: two COM instances of one suite fight over focus. */
let queue: Promise<unknown> = Promise.resolve()

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task)
  queue = next.catch(() => undefined)
  return next
}

/**
 * Render one document to PDF bytes.
 *
 * The caller passes an absolute path already resolved inside the open
 * workspace; this module never looks at a path the jail has not approved.
 */
export async function renderDocumentPdf(absolutePath: string): Promise<DocumentRender> {
  if (!officeRenderSupported()) return { engine: null, reason: 'server' }
  const family = officeFamilyOf(absolutePath)
  if (!family) return { engine: null, reason: 'unsupported' }
  const info = await stat(absolutePath).catch(() => null)
  if (!info?.isFile()) return { engine: null, reason: 'missing' }
  if (info.size > MAX_SOURCE_BYTES) return { engine: null, reason: 'large' }

  const discovered = await detectEngines()
  const engines = orderedEngines(discovered.engines)
  if (engines.length === 0) return { engine: null, reason: 'no-engine' }
  const dir = await cacheDirectory()

  for (const engine of engines) {
    const key = cacheKey(absolutePath, info.size, info.mtimeMs, engine)
    const out = join(dir, `${key}.pdf`)
    if (await isUsablePdf(out)) {
      const bytes = await readFile(out).catch(() => null)
      if (bytes) {
        preferredEngine = engine
        return { engine, pdf: new Uint8Array(bytes), cached: true }
      }
    }
    if (!inflight.has(key)) {
      inflight.set(
        key,
        serialize(async () => {
          const ok = await convertWithEngine(engine, family, absolutePath, out, discovered.soffice)
          if (!ok) return null
          void pruneCache(dir)
          return readFile(out).then(
            (bytes) => new Uint8Array(bytes),
            () => null,
          )
        }).finally(() => inflight.delete(key)),
      )
    }
    const produced = await inflight.get(key)
    if (produced) {
      preferredEngine = engine
      return { engine, pdf: produced, cached: false }
    }
  }

  return { engine: null, reason: 'failed' }
}

/** Test seam: forget the probe so a changed machine is re-read. */
export function resetOfficeRenderState(): void {
  probe = null
  preferredEngine = null
}
