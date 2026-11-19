import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  dirOf,
  encodeMediaPath,
  decodeMediaPath,
  joinMediaPath,
  mediaDirUrlFor,
  mediaFileUrlFor,
  mediaPathFromUrl,
  mediaUrlFor,
  parseMediaUrl,
  previewKindOf,
  resolveMediaRef,
  stepZoom,
  zoomLabel,
  zoomShortcut,
  ZOOM_MAX,
  ZOOM_MIN,
} from '../src/shared/media'
import { FilePreviewBody } from '../src/renderer/src/components/FilePreviewBody'
import { Markdown } from '../src/renderer/src/components/Markdown'
import type { FilePreview } from '../src/shared/types'

function preview(partial: Partial<FilePreview>): FilePreview {
  return {
    path: 'demo/a.txt',
    size: 10,
    content: '',
    language: 'plaintext',
    truncated: false,
    kind: 'text',
    ...partial,
  }
}

describe('preview kinds', () => {
  it('treats markdown as text with its own renderer', () => {
    expect(previewKindOf('README.md')).toBe('markdown')
    expect(previewKindOf('docs/guide.markdown')).toBe('markdown')
    expect(previewKindOf('notes.MD')).toBe('markdown')
    expect(previewKindOf('a.ts')).toBe('text')
  })

  it('keeps html and media classification', () => {
    expect(previewKindOf('report.html')).toBe('html')
    expect(previewKindOf('shot.png')).toBe('image')
    expect(previewKindOf('clip.mp4')).toBe('video')
    expect(previewKindOf('track.mp3')).toBe('audio')
  })

  it('knows the folder of a file', () => {
    expect(dirOf('docs/guide.md')).toBe('docs')
    expect(dirOf('docs/deep/guide.md')).toBe('docs/deep')
    expect(dirOf('guide.md')).toBe('')
  })
})

describe('media urls', () => {
  it('round-trips the workspace-relative path', () => {
    for (const path of ['a.md', 'docs/中文 名称/index.html', 'x/y/z.png']) {
      expect(decodeMediaPath(encodeMediaPath(path))).toBe(path)
      expect(mediaPathFromUrl(mediaUrlFor(path))).toBe(path)
    }
  })

  it('serves a file from inside its own folder so relative assets resolve', () => {
    const url = mediaFileUrlFor('site/index.html')
    expect(url.startsWith(mediaDirUrlFor('site'))).toBe(true)
    expect(mediaPathFromUrl(url)).toBe('site/index.html')
    expect(parseMediaUrl(url)).toEqual({ base: 'site', tail: 'index.html' })
  })

  it('maps a nested asset of a served page back to a workspace path', () => {
    const target = parseMediaUrl(`${mediaDirUrlFor('site')}img/logo%20v2.png`)
    expect(target).toEqual({ base: 'site', tail: 'img/logo v2.png' })
    expect(mediaPathFromUrl(`${mediaDirUrlFor('site')}img/logo%20v2.png`)).toBe(
      'site/img/logo v2.png',
    )
  })

  it('refuses a path that climbs out of its folder', () => {
    expect(joinMediaPath('site', '../secret.txt')).toBeNull()
    expect(mediaPathFromUrl(`${mediaDirUrlFor('site')}../secret.txt`)).toBeNull()
  })

  it('refuses hosts that are not the local one', () => {
    expect(mediaPathFromUrl('https://example.com/a.md')).toBeNull()
    expect(mediaPathFromUrl('pilot-media://evil/abc')).toBeNull()
  })

  it('rewrites only references inside the folder', () => {
    const base = mediaDirUrlFor('docs')
    const folder = parseMediaUrl(base)?.base ?? ''
    expect(folder).toBe('docs')
    expect(resolveMediaRef(folder, 'img/a.png')).toBe(mediaUrlFor('docs/img/a.png'))
    expect(resolveMediaRef(folder, './img/a.png')).toBe(mediaUrlFor('docs/img/a.png'))
    expect(resolveMediaRef(folder, '/root.png')).toBe(mediaUrlFor('root.png'))
    expect(resolveMediaRef(folder, '../outside.png')).toBeNull()
    expect(resolveMediaRef(folder, 'https://example.com/a.png')).toBeNull()
    expect(resolveMediaRef(folder, 'file:///etc/passwd')).toBeNull()
    expect(resolveMediaRef(folder, '#anchor')).toBeNull()
    expect(resolveMediaRef(folder, 'img/a.png?raw=1#x')).toBe(mediaUrlFor('docs/img/a.png'))
  })
})

describe('preview zoom', () => {
  it('steps through presets and stops at the ends', () => {
    expect(stepZoom(1, 1)).toBe(1.25)
    expect(stepZoom(1, -1)).toBe(0.8)
    expect(stepZoom(ZOOM_MAX, 1)).toBe(ZOOM_MAX)
    expect(stepZoom(ZOOM_MIN, -1)).toBe(ZOOM_MIN)
    expect(stepZoom(0.9, 1)).toBe(1)
  })

  it('labels the factor as a percentage', () => {
    expect(zoomLabel(1)).toBe('100%')
    expect(zoomLabel(1.25)).toBe('125%')
    expect(zoomLabel(99)).toBe('300%')
  })

  it('only reacts to modified +/-/0', () => {
    expect(zoomShortcut('=', true)).toBe(1)
    expect(zoomShortcut('+', true)).toBe(1)
    expect(zoomShortcut('-', true)).toBe(-1)
    expect(zoomShortcut('0', true)).toBe(0)
    expect(zoomShortcut('=', false)).toBeNull()
    expect(zoomShortcut('a', true)).toBeNull()
  })
})

describe('FilePreviewBody', () => {
  it('puts zoom controls on every zoomable kind', () => {
    const html = renderToStaticMarkup(<FilePreviewBody preview={preview({ content: 'x' })} />)
    expect(html).toContain('preview-zoom-value')
    expect(html).toContain('100%')
    expect(html).toContain('preview-zoom-step')
  })

  it('renders markdown instead of the raw source', () => {
    const html = renderToStaticMarkup(
      <FilePreviewBody
        preview={preview({
          path: 'docs/readme.md',
          kind: 'markdown',
          content: '# 标题\n\n正文 **加粗**',
          baseUrl: mediaDirUrlFor('docs'),
        })}
      />,
    )
    expect(html).toContain('<h1>标题</h1>')
    expect(html).toContain('<strong>加粗</strong>')
    expect(html).not.toContain('preview-code')
  })

  it('resolves a relative image of a markdown file', () => {
    const html = renderToStaticMarkup(
      <Markdown content={'![shot](img/shot.png)'} baseDir="docs" />,
    )
    expect(html).toContain(mediaUrlFor('docs/img/shot.png'))
  })

  it('leaves a chat answer without a base dir untouched', () => {
    const html = renderToStaticMarkup(<Markdown content={'![shot](img/shot.png)'} />)
    expect(html).toContain('src="img/shot.png"')
  })
})
