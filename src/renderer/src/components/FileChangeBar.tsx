import { useState } from 'react'
import type { SessionArtifact } from '../../../shared/types'
import { ChevronIcon, FileIcon } from '../icons'
import { t } from '../i18n'

/**
 * The change bar under one answer: it only exists when this turn actually wrote
 * or edited a file, stays collapsed by default, and expands into a list that is
 * capped at three rows of height (the rest scrolls inside). Anything bigger is a
 * job for the files area, which "查看更多" opens.
 *
 * Rows are plain buttons: preview happens through the workspace jail in the main
 * process, so this component never reads the disk itself.
 */
export function FileChangeBar({
  files,
  onOpenFile,
  onOpenAll,
}: {
  files: SessionArtifact[]
  onOpenFile: (artifact: SessionArtifact) => void
  onOpenAll: () => void
}) {
  const [open, setOpen] = useState(false)
  if (files.length === 0) return null

  return (
    <div className={`file-change-bar${open ? ' is-open' : ''}`}>
      <div className="file-change-head">
        <button
          type="button"
          className="file-change-toggle"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          <ChevronIcon width={13} height={13} className="file-change-chevron" />
          <FileIcon width={13} height={13} />
          {files.length === 1
            ? t("本轮改动 1 个文件")
            : t("本轮改动 {v1} 个文件", { v1: files.length })}
        </button>
        <button type="button" className="file-change-more" onClick={onOpenAll}>
          {t("查看更多")}
        </button>
      </div>

      {open ? (
        <div className="file-change-list" role="list">
          {files.map((file) => (
            <button
              type="button"
              className="file-change-row"
              role="listitem"
              key={file.path}
              title={file.path}
              onClick={() => onOpenFile(file)}
            >
              <span className={`artifact-action ${file.action}`}>
                {file.action === 'write' ? t("新建") : t("修改")}
              </span>
              <span className="file-change-name">{file.name}</span>
              <span className="artifact-path">{file.path}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}