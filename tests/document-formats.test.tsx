import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  contentTypeFor,
  isDocumentKind,
  isParsedDocumentKind,
  isTextKind,
  mediaUrlFor,
  previewKindOf,
} from '../src/shared/media'
import { FilePreviewBody } from '../src/renderer/src/components/FilePreviewBody'
import { tidyParserMessage } from '../src/renderer/src/components/DocumentPreview'
import { columnLabel, formatCell, XLSX_LIMITS } from '../src/renderer/src/preview/xlsx'
import {
  decodeXmlText,
  parseRelationships,
  slideAspect,
  slideParagraphs,
  slideSizeLabel,
} from '../src/renderer/src/preview/pptx'
import { docxFrameDocument, safeColor } from '../src/renderer/src/preview/docx'
import type { PreviewKind } from '../src/shared/media'
import type { FilePreview } from '../src/shared/types'

function preview(partial: Partial<FilePreview>): FilePreview {
  return {
    path: 'docs/report.pdf',
    size: 1024,
    content: '',
    language: 'PDF',
    truncated: false,
    kind: 'pdf',
    url: mediaUrlFor('docs/report.pdf'),
    ...partial,
  }
}

describe('document kinds', () => {
  it('routes the four parsable formats to their own renderer', () => {
    expect(previewKindOf('report.pdf')).toBe('pdf')
    expect(previewKindOf('Report.PDF')).toBe('pdf')
    expect(previewKindOf('contract.docx')).toBe('docx')
    expect(previewKindOf('budget.xlsx')).toBe('xlsx')
    expect(previewKindOf('macro.xlsm')).toBe('xlsx')
    expect(previewKindOf('deck.pptx')).toBe('pptx')
    expect(previewKindOf('deck.pptm')).toBe('pptx')
  })

  it('never misreads a legacy office file as UTF-8 text', () => {
    for (const name of ['old.doc', 'old.xls', 'old.ppt', 'notes.rtf', 'a.odt', 'b.ods', 'c.odp']) {
      expect(previewKindOf(name)).toBe('document')
    }
  })

  it('keeps the two predicates in sync with the parser list', () => {
    const parsed: PreviewKind[] = ['pdf', 'docx', 'xlsx', 'pptx']
    for (const kind of parsed) {
      expect(isParsedDocumentKind(kind)).toBe(true)
      expect(isDocumentKind(kind)).toBe(true)
      expect(isTextKind(kind)).toBe(false)
    }
    expect(isDocumentKind('document')).toBe(true)
    expect(isParsedDocumentKind('document')).toBe(false)
    for (const kind of ['text', 'markdown', 'image', 'video', 'audio', 'html'] as PreviewKind[]) {
      expect(isDocumentKind(kind)).toBe(false)
    }
  })

  it('serves the office content types so a stream is labelled honestly', () => {
    expect(contentTypeFor('a.pdf')).toBe('application/pdf')
    expect(contentTypeFor('a.docx')).toContain('wordprocessingml.document')
    expect(contentTypeFor('a.xlsm')).toContain('macroEnabled')
    expect(contentTypeFor('a.pptx')).toContain('presentationml.presentation')
  })
})

describe('FilePreviewBody with a document', () => {
  it('draws the document renderer instead of a text body', () => {
    const html = renderToStaticMarkup(<FilePreviewBody preview={preview({})} />)
    expect(html).toContain('doc-state')
    expect(html).toContain('正在解析文档')
    expect(html).not.toContain('preview-code')
  })

  it('explains a format it cannot parse and offers the system app', () => {
    const html = renderToStaticMarkup(
      <FilePreviewBody
        preview={preview({ path: 'docs/old.doc', kind: 'document', language: 'DOC' })}
        onOpenExternal={() => undefined}
      />,
    )
    expect(html).toContain('这类文档还不支持应用内预览')
    expect(html).toContain('用系统应用打开')
  })

  it('hides the escape hatch when no workspace is open', () => {
    const html = renderToStaticMarkup(
      <FilePreviewBody preview={preview({ path: 'docs/old.doc', kind: 'document' })} />,
    )
    expect(html).not.toContain('用系统应用打开')
  })
})

describe('parser failure copy', () => {
  it('drops the library help link and keeps one line of evidence', () => {
    expect(
      tidyParserMessage(
        "Can't find end of central directory : is this a zip file ? If it is, see\nhttps://stuk.github.io/jszip/documentation/howto/read_zip.html",
      ),
    ).toBe("Can't find end of central directory : is this a zip file ? If it is, see")
  })

  it('caps a long message so it cannot fill the drawer', () => {
    const long = tidyParserMessage('x'.repeat(400))
    expect(long.length).toBe(158)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe('spreadsheet formatting', () => {
  it('labels columns like a spreadsheet', () => {
    expect(columnLabel(0)).toBe('A')
    expect(columnLabel(25)).toBe('Z')
    expect(columnLabel(26)).toBe('AA')
    expect(columnLabel(701)).toBe('ZZ')
  })

  it('formats the values read-excel-file returns', () => {
    expect(formatCell(null)).toBe('')
    expect(formatCell(undefined)).toBe('')
    expect(formatCell(12)).toBe('12')
    expect(formatCell(true)).toBe('TRUE')
    expect(formatCell(false)).toBe('FALSE')
    expect(formatCell(Number.NaN)).toBe('')
    expect(formatCell('文本')).toBe('文本')
    expect(formatCell(new Date(Date.UTC(2024, 0, 5)))).toBe('2024-01-05')
    expect(formatCell(new Date(Date.UTC(2024, 0, 5, 9, 30)))).toBe('2024-01-05 09:30')
  })

  it('caps the table so a huge export cannot freeze the drawer', () => {
    expect(XLSX_LIMITS.rows).toBeGreaterThan(0)
    expect(XLSX_LIMITS.cols).toBeGreaterThan(0)
    expect(XLSX_LIMITS.rows * XLSX_LIMITS.cols).toBeLessThanOrEqual(20_000)
  })
})

describe('presentation outline', () => {
  it('reads paragraphs in document order', () => {
    const xml = '<a:p><a:r><a:t>标题</a:t></a:r></a:p><a:p><a:r><a:t>第一点</a:t></a:r></a:p>'
    expect(slideParagraphs(xml)).toEqual(['标题', '第一点'])
  })

  it('decodes the entities the XML writer escapes', () => {
    expect(decodeXmlText('a &amp; b &lt;c&gt; &quot;d&quot;')).toBe('a & b <c> "d"')
  })

  it('maps a relationship id to its target', () => {
    const xml =
      '<Relationships><Relationship Id="rId2" Type="image" Target="../media/image1.png"/></Relationships>'
    expect(parseRelationships(xml).get('rId2')?.target).toBe('../media/image1.png')
  })

  it('clamps a corrupt slide size instead of producing a zero-height page', () => {
    expect(slideAspect(0, 0)).toBeCloseTo(16 / 9, 2)
    expect(slideAspect(12192000, 6858000)).toBeCloseTo(16 / 9, 2)
    expect(slideAspect(100, 10000)).toBe(0.5)
    expect(slideSizeLabel(914400, 914400)).toBe('1.0 × 1.0 in')
  })
})

describe('word conversion wrapper', () => {
  it('accepts only colours that cannot break out of the style block', () => {
    expect(safeColor('#fff')).toBe('#fff')
    expect(safeColor('rgba(1, 2, 3, 0.5)')).toBe('rgba(1, 2, 3, 0.5)')
    expect(safeColor('red; } body { display:none')).toBeUndefined()
    expect(safeColor('url(javascript:alert(1))')).toBeUndefined()
    expect(safeColor(undefined)).toBeUndefined()
  })

  it('wraps the fragment into a full document with the theme colours', () => {
    const doc = docxFrameDocument('<p>正文</p>', { fg: '#111111', bg: '#ffffff' })
    expect(doc.startsWith('<!doctype html>')).toBe(true)
    expect(doc).toContain('<p>正文</p>')
    expect(doc).toContain('color: #111111')
  })
})
