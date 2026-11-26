import { describe, expect, it } from 'vitest'
import {
  extensionOf,
  isOfficeDocument,
  officeDocumentKind,
} from '../src/shared/office-documents'

// 「全局文档」的分类只看扩展名，所以这份白名单就是那个入口的全部判定：
// 漏一个办公扩展名会让文档消失，多收一个源码扩展名会让代码混进文档列表。

describe('extensionOf', () => {
  it('reads the extension of a path with either separator', () => {
    expect(extensionOf('reports/季度总结.DOCX')).toBe('docx')
    expect(extensionOf('reports\\季度总结.Md')).toBe('md')
  })

  it('ignores dots in directory names and query strings', () => {
    expect(extensionOf('v1.2/report')).toBe('')
    expect(extensionOf('https://example.com/a/report.docx?download=1')).toBe('docx')
  })

  it('treats a dotfile as having no extension', () => {
    expect(extensionOf('.gitignore')).toBe('')
  })
})

describe('officeDocumentKind', () => {
  it('classifies the office formats users actually produce', () => {
    expect(officeDocumentKind('a/b/方案.docx')).toBe('word')
    expect(officeDocumentKind('a/b/预算.xlsx')).toBe('excel')
    expect(officeDocumentKind('a/b/汇报.pptx')).toBe('powerpoint')
    expect(officeDocumentKind('a/b/白皮书.pdf')).toBe('pdf')
  })

  it('includes Markdown reports', () => {
    expect(officeDocumentKind('docs/周报.md')).toBe('markdown')
    expect(officeDocumentKind('docs/周报.MARKDOWN')).toBe('markdown')
    expect(officeDocumentKind('docs/周报.mkdn')).toBe('markdown')
  })

  it('leaves code, scripts and data files out', () => {
    for (const path of [
      'src/main/index.ts',
      'src/main/index.tsx',
      'scripts/deploy.sh',
      'scripts/deploy.ps1',
      'lib/util.py',
      'pilot-core.json',
      'config.yml',
      'notes.txt',
      'package.lock',
      'Pilot.exe',
    ]) {
      expect(officeDocumentKind(path), `${path} 不该算作文档`).toBeNull()
      expect(isOfficeDocument(path)).toBe(false)
    }
  })
})
