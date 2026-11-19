import { describe, expect, it } from 'vitest'
import {
  contentTypeFor,
  isMediaKind,
  linkLabel,
  parseByteRange,
  parseOpenLink,
  previewKindOf,
} from '../src/shared/media'

describe('preview kinds', () => {
  it('classifies media and web pages by extension', () => {
    expect(previewKindOf('cover.PNG')).toBe('image')
    expect(previewKindOf('clip.mp4')).toBe('video')
    expect(previewKindOf('track.flac')).toBe('audio')
    expect(previewKindOf('report.html')).toBe('html')
    expect(previewKindOf('src/main.ts')).toBe('text')
    expect(previewKindOf('no-extension')).toBe('text')
  })

  it('marks only image, video and audio as inline media', () => {
    expect(isMediaKind('image')).toBe(true)
    expect(isMediaKind('video')).toBe(true)
    expect(isMediaKind('audio')).toBe(true)
    expect(isMediaKind('html')).toBe(false)
    expect(isMediaKind('text')).toBe(false)
  })

  it('serves the right content type for the media tags', () => {
    expect(contentTypeFor('a.mp4')).toBe('video/mp4')
    expect(contentTypeFor('a.webm')).toBe('video/webm')
    expect(contentTypeFor('a.mp3')).toBe('audio/mpeg')
    expect(contentTypeFor('a.html')).toContain('text/html')
    expect(contentTypeFor('a.bin')).toBe('application/octet-stream')
  })
})

describe('byte ranges', () => {
  it('parses explicit and open-ended ranges', () => {
    expect(parseByteRange('bytes=0-1023', 5000)).toEqual({ start: 0, end: 1023 })
    expect(parseByteRange('bytes=2000-', 5000)).toEqual({ start: 2000, end: 4999 })
    expect(parseByteRange('bytes=-500', 5000)).toEqual({ start: 4500, end: 4999 })
  })

  it('clamps an end past the file size', () => {
    expect(parseByteRange('bytes=4000-9999', 5000)).toEqual({ start: 4000, end: 4999 })
  })

  it('ignores unusable headers so the whole file is sent', () => {
    expect(parseByteRange(null, 5000)).toBeNull()
    expect(parseByteRange('', 5000)).toBeNull()
    expect(parseByteRange('bytes=-', 5000)).toBeNull()
    expect(parseByteRange('bytes=6000-', 5000)).toBeNull()
    expect(parseByteRange('bytes=1-2', 0)).toBeNull()
    expect(parseByteRange('items=0-10', 5000)).toBeNull()
  })
})

describe('link handling', () => {
  it('accepts web, mail and workspace media links', () => {
    expect(parseOpenLink('https://example.com/a?b=1')).toEqual({
      kind: 'preview',
      url: 'https://example.com/a?b=1',
    })
    expect(parseOpenLink('  http://127.0.0.1:5173/  ')?.kind).toBe('preview')
    expect(parseOpenLink('mailto:a@b.com')?.kind).toBe('external')
    expect(parseOpenLink('pilot-media://local/YWJj')?.kind).toBe('media')
  })

  it('refuses script, file and unknown schemes', () => {
    expect(parseOpenLink('javascript:alert(1)')).toBeNull()
    expect(parseOpenLink('file:///C:/Windows/win.ini')).toBeNull()
    expect(parseOpenLink('steam://run/1')).toBeNull()
    expect(parseOpenLink('')).toBeNull()
    expect(parseOpenLink(null)).toBeNull()
    expect(parseOpenLink(42)).toBeNull()
    expect(parseOpenLink(`https://example.com/${'a'.repeat(2100)}`)).toBeNull()
  })

  it('shortens long links for the chip label', () => {
    expect(linkLabel('https://example.com/docs/')).toBe('example.com/docs')
    expect(linkLabel('https://example.com/')).toBe('example.com')
    const long = linkLabel(`https://example.com/${'x'.repeat(200)}`)
    expect(long.length).toBeLessThanOrEqual(64)
    expect(long.endsWith('…')).toBe(true)
    expect(linkLabel('not a url')).toBe('not a url')
  })
})
