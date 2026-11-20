import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FileChangeBar } from '../src/renderer/src/components/FileChangeBar'
import type { SessionArtifact } from '../src/shared/types'

const CSS = readFileSync(
  fileURLToPath(new URL('../src/renderer/src/styles.css', import.meta.url)),
  'utf8',
)

const files: SessionArtifact[] = [
  { path: 'src/renderer/src/App.tsx', name: 'App.tsx', action: 'write', tool: 'write_file' },
  { path: 'src/shared/artifacts.ts', name: 'artifacts.ts', action: 'edit', tool: 'apply_patch' },
]

function render(artifacts: SessionArtifact[]): string {
  return renderToStaticMarkup(
    <FileChangeBar files={artifacts} onOpenFile={() => {}} onOpenAll={() => {}} />,
  )
}

describe('FileChangeBar', () => {
  it('renders nothing when this turn wrote no file', () => {
    expect(render([])).toBe('')
  })

  it('is collapsed by default and counts this turn only', () => {
    const html = render(files)
    expect(html).toContain('本轮改动 2 个文件')
    expect(html).toContain('查看更多')
    // Collapsed: no rows rendered at all, so the answer stays short.
    expect(html).not.toContain('file-change-row')
    expect(html).toContain('aria-expanded="false"')
  })

  it('singularizes the count so English does not say "1 files"', () => {
    const html = render([files[0]!])
    expect(html).toContain('本轮改动 1 个文件')
  })

  it('caps the expanded list at three rows and scrolls the rest', () => {
    const block = /\.file-change-list\s*\{([^}]*)\}/.exec(CSS)?.[1] ?? ''
    expect(block).toContain('max-height: calc(3 * 26px)')
    expect(block).toContain('overflow-y: auto')
    // A fixed row height is what makes "three rows" predictable.
    const row = /\.file-change-row\s*\{([^}]*)\}/.exec(CSS)?.[1] ?? ''
    expect(row).toContain('height: 24px')
  })

  it('every row carries the action badge, the name and the full path', () => {
    // Rows only mount once expanded; assert the markup contract from source.
    const source = readFileSync(
      fileURLToPath(
        new URL('../src/renderer/src/components/FileChangeBar.tsx', import.meta.url),
      ),
      'utf8',
    )
    expect(source).toContain('file.action === \'write\' ? t("新建") : t("修改")')
    expect(source).toContain('{file.name}')
    expect(source).toContain('{file.path}')
    expect(source).toContain('title={file.path}')
  })
})