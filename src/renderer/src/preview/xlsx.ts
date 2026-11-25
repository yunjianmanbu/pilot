/**
 * `.xlsx` → plain tables the preview can draw.
 *
 * `read-excel-file` already parses the OPC package, the shared string table and
 * the cell types, so this module only adds the two things a preview needs: a
 * hard cap so a 200k-row export cannot freeze the renderer, and a formatter for
 * the values that are not plain strings (numbers, booleans, dates).
 */

import readXlsxFile from 'read-excel-file/universal'

export type CellValue = string | number | boolean | Date | null | undefined

export interface SheetTable {
  name: string
  /** Rows already formatted for display; short rows are padded by the renderer. */
  rows: string[][]
  /** Total rows/columns in the file, before the cap. */
  totalRows: number
  totalCols: number
  truncatedRows: boolean
  truncatedCols: boolean
}

export interface XlsxLimits {
  rows: number
  cols: number
}

/**
 * Caps chosen so that the biggest file we still draw stays around 12k cells:
 * beyond that a preview is a scrollbar, not a document.
 */
export const XLSX_LIMITS: XlsxLimits = { rows: 400, cols: 30 }

/** `1` → `1`, `1.5` → `1.5`, dates as `YYYY-MM-DD` (time only when present). */
export function formatCell(value: CellValue): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return ''
    const pad = (input: number): string => String(input).padStart(2, '0')
    const date = `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`
    const hours = value.getUTCHours()
    const minutes = value.getUTCMinutes()
    const seconds = value.getUTCSeconds()
    if (hours === 0 && minutes === 0 && seconds === 0) return date
    return `${date} ${pad(hours)}:${pad(minutes)}${seconds ? `:${pad(seconds)}` : ''}`
  }
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  return String(value)
}

/** Cut every row to the column cap and drop trailing empty cells. */
function normalizeSheet(name: string, data: CellValue[][], limits: XlsxLimits): SheetTable {
  const totalRows = data.length
  const totalCols = data.reduce((widest, row) => Math.max(widest, row.length), 0)
  const rows = data.slice(0, limits.rows).map((row) => {
    const cells = row.slice(0, limits.cols).map(formatCell)
    while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop()
    return cells
  })
  // A sheet that is one empty column wide should not paint a table header row.
  while (rows.length > 0 && (rows[rows.length - 1]?.length ?? 0) === 0) rows.pop()
  return {
    name,
    rows,
    totalRows,
    totalCols,
    truncatedRows: totalRows > limits.rows,
    truncatedCols: totalCols > limits.cols,
  }
}

/**
 * Parse every sheet of a workbook.
 *
 * `read-excel-file/universal` is used instead of the `/browser` entry: the
 * latter spawns a Web Worker for parsing, which is pointless for a preview that
 * hands the result straight to React, and the universal build runs in both the
 * renderer and the Node unit test.
 */
export async function parseXlsx(
  data: ArrayBuffer,
  limits: XlsxLimits = XLSX_LIMITS,
): Promise<SheetTable[]> {
  const sheets = (await readXlsxFile(data)) as { sheet: string; data: CellValue[][] }[]
  return sheets
    .map((sheet, index) => normalizeSheet(String(sheet.sheet ?? `Sheet${index + 1}`), sheet.data ?? [], limits))
    .filter((sheet) => sheet.rows.length > 0)
}

/** Spreadsheet column label for index 0: `A`, `Z`, `AA`. */
export function columnLabel(index: number): string {
  let remaining = Math.max(0, Math.trunc(index))
  let label = ''
  while (true) {
    label = String.fromCharCode(65 + (remaining % 26)) + label
    remaining = Math.floor(remaining / 26) - 1
    if (remaining < 0) break
  }
  return label
}
