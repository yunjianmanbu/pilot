import { describe, expect, it } from 'vitest'
import { MAX_IMAGES, MAX_REFERENCES } from '../src/main/agent/attachments'
import {
  extensionForType,
  isImageUpload,
  MAX_MESSAGE_REFERENCES,
  MAX_UPLOAD_FILES,
  MAX_UPLOAD_IMAGES,
  mergeReferences,
  parseUploadBatch,
  planUpload,
  UPLOAD_DIRECTORY,
  type UploadCandidate,
} from '../src/shared/uploads'

function file(name: string, type = '', size = 4): UploadCandidate {
  return {
    name,
    type,
    size,
    async arrayBuffer() {
      return new Uint8Array(size).buffer
    },
  }
}

describe('parseUploadBatch', () => {
  it('keeps paths and blobs and drops duplicate paths', () => {
    const batch = parseUploadBatch({
      paths: ['C:\\a\\one.txt', 'C:\\a\\one.txt', '  '],
      blobs: [{ name: 'clip.png', data: new Uint8Array([1, 2]).buffer }],
    })
    expect(batch.paths).toEqual(['C:\\a\\one.txt'])
    expect(batch.blobs).toHaveLength(1)
    expect(batch.blobs[0]?.name).toBe('clip.png')
  })

  it('names a blob that arrived without one', () => {
    const batch = parseUploadBatch({ blobs: [{ data: new Uint8Array([1]).buffer }] })
    expect(batch.blobs[0]?.name).toBe('upload-1.bin')
  })

  it('rejects an empty batch, a non-binary blob and too many files', () => {
    expect(() => parseUploadBatch({})).toThrow(/没有要上传的文件/)
    expect(() => parseUploadBatch(undefined)).toThrow(/没有要上传的文件/)
    expect(() =>
      parseUploadBatch({ blobs: [{ name: 'a.txt', data: 'not-bytes' }] }),
    ).toThrow(/上传内容不正确/)
    expect(() =>
      parseUploadBatch({
        paths: Array.from({ length: MAX_UPLOAD_FILES + 1 }, (_, index) => `C:\\f\\${index}.txt`),
      }),
    ).toThrow(new RegExp(`一次最多上传 ${MAX_UPLOAD_FILES} 个文件`))
  })
})

describe('planUpload', () => {
  it('sends disk-backed files by path and clipboard-only files by bytes', async () => {
    const plan = await planUpload(
      [file('report.pdf', 'application/pdf'), file('image.png', 'image/png', 10)],
      (candidate) => (candidate.name === 'report.pdf' ? 'C:\\docs\\report.pdf' : ''),
    )
    expect(plan.paths).toEqual(['C:\\docs\\report.pdf'])
    expect(plan.blobs).toHaveLength(1)
    expect(plan.blobs[0]?.name).toBe('image.png')
    expect(plan.skipped).toBe(0)
    expect(plan.overflow).toBe(0)
  })

  it('counts a zero-byte entry as skipped instead of failing an empty folder drop', async () => {
    const plan = await planUpload([file('folder', '', 0)], () => '')
    expect(plan).toMatchObject({ paths: [], blobs: [], skipped: 1, overflow: 0 })
  })

  it('stops at the limit and reports how many were dropped', async () => {
    const plan = await planUpload(
      [file('a.txt'), file('b.txt'), file('c.txt'), file('d.txt')],
      (candidate) => `C:\\f\\${candidate.name}`,
    )
    expect(plan.paths).toHaveLength(MAX_UPLOAD_FILES)
    expect(plan.overflow).toBe(1)
  })

  it('reads bytes even with a path when the caller needs content', async () => {
    const plan = await planUpload([file('shot.png', 'image/png', 8)], () => 'C:\\tmp\\shot.png', {
      limit: 1,
      readBytes: true,
    })
    expect(plan.paths).toEqual([])
    expect(plan.blobs[0]?.name).toBe('shot.png')
  })
})

describe('isImageUpload', () => {
  it('treats bitmaps as images and svg as a workspace file', () => {
    expect(isImageUpload({ name: 'a.png', type: '' })).toBe(true)
    expect(isImageUpload({ name: 'a.JPEG', type: '' })).toBe(true)
    expect(isImageUpload({ name: 'clip', type: 'image/png' })).toBe(true)
    expect(isImageUpload({ name: 'icon.svg', type: 'image/svg+xml' })).toBe(false)
    expect(isImageUpload({ name: 'notes.md', type: 'text/markdown' })).toBe(false)
  })
})

describe('mergeReferences', () => {
  it('appends without duplicates and keeps the order', () => {
    expect(mergeReferences(['a.md'], ['b.md', 'a.md', ' b.md '])).toEqual({
      references: ['a.md', 'b.md'],
      dropped: 0,
    })
  })

  it('truncates at the limit and reports the overflow', () => {
    const current = Array.from({ length: 7 }, (_, index) => `f${index}.md`)
    const merged = mergeReferences(current, ['x.md', 'y.md'])
    expect(merged.references).toHaveLength(8)
    expect(merged.dropped).toBe(1)
  })
})

describe('limits stay in sync with the sender', () => {
  // 界面文案直接写着这些数字（「最多参照 8 个项目」「最多附图 3 张」），
  // 所以上限只能改在这里和 attachments 的同一处，不能各写一份。
  it('matches the attachment limits that actually ship', () => {
    expect(MAX_MESSAGE_REFERENCES).toBe(MAX_REFERENCES)
    expect(MAX_UPLOAD_IMAGES).toBe(MAX_IMAGES)
    expect(MAX_UPLOAD_FILES).toBe(3)
    expect(UPLOAD_DIRECTORY).toBe('uploads')
  })
})

describe('extensionForType', () => {
  it('maps known MIME types and ignores unknown ones', () => {
    expect(extensionForType('image/png')).toBe('.png')
    expect(extensionForType('IMAGE/JPEG')).toBe('.jpg')
    expect(extensionForType(undefined)).toBe('')
    expect(extensionForType('application/x-unknown')).toBe('')
  })
})
