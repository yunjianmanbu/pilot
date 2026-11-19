import { describe, expect, it } from 'vitest'
import {
  MAX_IMAGE_DATA_URL_CHARS,
  MAX_IMAGES,
  MAX_REFERENCES,
  sanitizeImages,
  sanitizeReferences,
} from '../src/main/agent/attachments'

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

describe('sanitizeImages', () => {
  it('accepts PNG and JPEG data URLs and drops empty entries', () => {
    expect(sanitizeImages([PNG, '', '  '])).toEqual([PNG])
    expect(
      sanitizeImages(['data:image/jpeg;base64,/9j/4AAQSkZJRg==']),
    ).toHaveLength(1)
  })

  it('treats missing values as no attachments', () => {
    expect(sanitizeImages(undefined)).toEqual([])
    expect(sanitizeImages(null)).toEqual([])
    expect(sanitizeImages([])).toEqual([])
  })

  it('rejects non-image payloads and remote URLs', () => {
    expect(() => sanitizeImages('data:image/png;base64,AAAA')).toThrow('图片格式不正确')
    expect(() => sanitizeImages(['https://example.com/a.png'])).toThrow('只支持')
    expect(() => sanitizeImages(['data:image/svg+xml;base64,AAAA'])).toThrow('只支持')
    expect(() => sanitizeImages([42])).toThrow('图片格式不正确')
  })

  it('enforces the per-message image count', () => {
    const many = Array.from({ length: MAX_IMAGES + 1 }, () => PNG)
    expect(() => sanitizeImages(many)).toThrow(`最多发送 ${MAX_IMAGES} 张图片`)
  })

  it('rejects oversized images', () => {
    const huge = `data:image/png;base64,${'A'.repeat(MAX_IMAGE_DATA_URL_CHARS)}`
    expect(() => sanitizeImages([huge])).toThrow('单张图片太大')
  })
})

describe('sanitizeReferences', () => {
  it('normalizes separators, trims and dedupes', () => {
    expect(
      sanitizeReferences([' src\\main\\index.ts ', 'src/main/index.ts', 'README.md']),
    ).toEqual(['src/main/index.ts', 'README.md'])
  })

  it('accepts dotted file names inside the workspace', () => {
    expect(sanitizeReferences(['.github/workflows/ci.yml'])).toEqual([
      '.github/workflows/ci.yml',
    ])
  })

  it('accepts other workspace paths and rejects parent traversal in relative ones', () => {
    expect(sanitizeReferences(['/home/me/other', 'C:\\work\\other'])).toEqual([
      '/home/me/other',
      'C:/work/other',
    ])
    expect(() => sanitizeReferences(['../secrets.txt'])).toThrow('相对路径')
    expect(() => sanitizeReferences(['src/../../secrets.txt'])).toThrow('相对路径')
  })

  it('dedupes absolute paths case-insensitively on Windows', () => {
    const result = sanitizeReferences(['C:/Work/Other', 'c:/work/other'])
    expect(result).toHaveLength(process.platform === 'win32' ? 1 : 2)
  })

  it('rejects malformed payloads and too many references', () => {
    expect(() => sanitizeReferences('src/a.ts')).toThrow('格式不正确')
    expect(() => sanitizeReferences([true])).toThrow('格式不正确')
    const many = Array.from({ length: MAX_REFERENCES + 1 }, (_, index) => `src/${index}.ts`)
    expect(() => sanitizeReferences(many)).toThrow(`最多参照 ${MAX_REFERENCES} 个项目`)
  })
})
