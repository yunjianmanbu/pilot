import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type {
  DynamicToolInfo,
  FileNode,
  FilePreview,
  KnowledgePair,
  MemoryEntry,
  Session,
  SessionArtifact,
  SessionLink,
  ToolCatalogEntry,
  ToolRisk,
  WorkspaceSummary,
} from '../../../shared/types'
import {
  describeLink,
  excerpt,
  queryPairs,
  RESOURCE_TABS,
  sessionMemories,
  type ResourceTab,
} from '../session-resources'
import {
  ArrowUpRightIcon,
  BrainIcon,
  ChevronDownIcon,
  ChevronIcon,
  CopyIcon,
  FileIcon,
  FilesIcon,
  FolderIcon,
  HistoryIcon,
  LinkIcon,
  PopoutIcon,
  RefreshIcon,
  SearchIcon,
  TrashIcon,
  WrenchIcon,
  XIcon,
} from '../icons'
import { copyText } from '../clipboard'
import { memoryCategoryOf } from '../../../shared/memory'
import { MEMORY_CATEGORY_LABELS } from './MemoryPanel'
import { FilePreviewBody } from './FilePreviewBody'
import { Markdown } from './Markdown'
import { formatRelative } from '../ui'
import { t, getLocale } from '../i18n'
import { useEscapeClose } from './useEscapeClose'

const PAIR_LIMIT = 60

function formatBytes(size?: number): string {
  if (size === undefined) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10_240 ? 1 : 0)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function tabLabel(tab: ResourceTab): string {
  if (tab === 'links') return t('相关链接')
  if (tab === 'tools') return t('可用工具')
  if (tab === 'knowledge') return t('会话知识库')
  if (tab === 'memory') return t('会话记忆')
  if (tab === 'artifacts') return t('新增/修改文件')
  return t('工作区文件')
}

function tabIcon(tab: ResourceTab, size = 13): ReactNode {
  if (tab === 'links') return <LinkIcon width={size} height={size} />
  if (tab === 'tools') return <WrenchIcon width={size} height={size} />
  if (tab === 'knowledge') return <HistoryIcon width={size} height={size} />
  if (tab === 'memory') return <BrainIcon width={size} height={size} />
  if (tab === 'artifacts') return <FileIcon width={size} height={size} />
  return <FilesIcon width={size} height={size} />
}

function toolSourceLabel(tool: ToolCatalogEntry): string {
  if (tool.source === 'builtin') return t('内置')
  if (tool.source === 'control') return t('控制')
  if (tool.source === 'mcp') return tool.server ? `MCP · ${tool.server}` : 'MCP'
  return t('自写')
}

/**
 * 工具说明：中文界面用清单里的中文说明，英文界面与没有中文的条目用原文。
 * 自写工具只有 Agent 写的一句说明，照样显示，不留空。
 */
function toolDescription(tool: ToolCatalogEntry): string {
  if (getLocale() === 'en') return tool.description
  return tool.descriptionZh || tool.description
}

/**
 * 风险档位在数据里是 read/write/exec/control；界面统一说人话，原始值留在
 * title 里，排查问题时仍能与运行记录中的 risk 对上。
 */
function toolRiskLabel(risk: ToolRisk): string {
  if (risk === 'write') return t('写文件')
  if (risk === 'exec') return t('运行命令')
  if (risk === 'control') return t('控制设备')
  return t('只读')
}

/**
 * A file preview with its header: the workspace tab and the artifacts tab show
 * the same thing, so back, copy path, reveal and open-in-window live here once.
 */
function FilePreviewPane({
  preview,
  workspace,
  onBack,
  onNotice,
  extraMeta,
  onOpenChanges,
}: {
  preview: FilePreview
  workspace: WorkspaceSummary | null
  onBack: () => void
  onNotice: (message: string) => void
  /** Extra facts shown in the meta row, e.g. which tool wrote this file. */
  extraMeta?: ReactNode
  /** Artifacts only: jump to the diff view for the same file. */
  onOpenChanges?: () => void
}) {
  return (
    <div className="file-preview">
      <div className="preview-head">
        <button type="button" className="icon-text-button" onClick={onBack}>
          <ChevronIcon width={14} height={14} className="rotate-180" />
          {t('返回')}
        </button>
        <span className="preview-name" title={preview.path}>
          {preview.path}
        </span>
        <button
          type="button"
          className="icon-button"
          title={t('复制相对路径')}
          onClick={() => {
            void copyText(preview.path)
            onNotice?.(t('已复制路径'))
          }}
        >
          <CopyIcon width={14} height={14} />
        </button>
      </div>
      <div className="preview-meta">
        <span>{preview.language}</span>
        <span>{formatBytes(preview.size)}</span>
        {preview.truncated ? <span className="preview-truncated">{t('已截断')}</span> : null}
        {extraMeta}
        {onOpenChanges ? (
          <button
            type="button"
            className="icon-text-button"
            onClick={onOpenChanges}
            title={t('变更审阅：比较并撤销本次会话修改的文件')}
          >
            {t('看差异')}
          </button>
        ) : null}
        {workspace ? (
          <>
            <button
              type="button"
              className="icon-text-button"
              onClick={() => {
                void window.pilot.revealFile(workspace.path, preview.path)
              }}
            >
              {t('在文件夹中显示')}
            </button>
            <button
              type="button"
              className="icon-text-button"
              onClick={() => {
                void window.pilot.openDocument(workspace.path, preview.path)
              }}
            >
              {t('独立窗口打开')}
            </button>
          </>
        ) : null}
      </div>
      <FilePreviewBody
        preview={preview}
        {...(workspace
          ? {
              onOpenWindow: () => {
                void window.pilot.openDocument(workspace.path, preview.path)
              },
            }
          : {})}
      />
    </div>
  )
}

/**
 * One drawer for everything a session produced or referenced: the workspace
 * tree, the links its transcript mentions, the tools a run could use, the
 * session knowledge pairs and the files the agent wrote. Every list previews on
 * the right, so the sidebar, the top bar and the session menu no longer need a
 * separate drawer each.
 */
export function SessionResourcesPanel({
  workspace,
  session,
  tab,
  onTabChange,
  artifactSeed,
  onOpenMessage,
  onOpenChanges,
  memory = [],
  onAddMemory,
  onDeleteMemory,
  onOpenMemoryPanel,
  onClose,
  onError,
  onNotice,
}: {
  workspace: WorkspaceSummary | null
  session: Session | null
  tab: ResourceTab
  onTabChange: (tab: ResourceTab) => void
  /** A file named by an answer's change bar; `key` makes repeats distinct. */
  artifactSeed?: { path: string; key: number } | null
  /** Jump back to the message a link or a knowledge pair came from. */
  onOpenMessage?: (sessionId: string, messageId: string) => void
  /** Artifacts tab: open the diff view for the files this session changed. */
  onOpenChanges?: () => void
  /** Workspace project memory; the memory tab narrows it down to this session. */
  memory?: MemoryEntry[]
  onAddMemory?: (content: string) => Promise<void>
  onDeleteMemory?: (memoryId: string) => Promise<void>
  /** Open the full workspace memory page from the empty state. */
  onOpenMemoryPanel?: () => void
  onClose: () => void
  onError: (message: string) => void
  onNotice: (message: string) => void
}) {
  const [cwd, setCwd] = useState('.')
  const [nodes, setNodes] = useState<FileNode[]>([])
  const [filesLoading, setFilesLoading] = useState(false)
  const [filePreview, setFilePreview] = useState<FilePreview | null>(null)

  const [links, setLinks] = useState<SessionLink[] | null>(null)
  const [activeUrl, setActiveUrl] = useState<string | null>(null)

  const [tools, setTools] = useState<ToolCatalogEntry[] | null>(null)
  const [activeTool, setActiveTool] = useState<string | null>(null)
  // Dynamic tools carry the approval and run statistics the catalog omits;
  // enable/disable, promote and delete act on these records.
  const [dynamicTools, setDynamicTools] = useState<DynamicToolInfo[] | null>(null)
  const [toolBusy, setToolBusy] = useState('')

  const [pairs, setPairs] = useState<KnowledgePair[] | null>(null)
  const [pairTotal, setPairTotal] = useState(0)
  const [activePairKey, setActivePairKey] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  const [artifacts, setArtifacts] = useState<SessionArtifact[] | null>(null)
  const [artifactPreview, setArtifactPreview] = useState<FilePreview | null>(null)
  const [activeMemoryId, setActiveMemoryId] = useState<string | null>(null)
  const [memoryBusy, setMemoryBusy] = useState<string | null>(null)

  const [previewLoading, setPreviewLoading] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  // 抽屉默认宽 920px；全屏时铺满整个界面区域，代码和表格才有足够宽度。
  const [expanded, setExpanded] = useState(false)
  const filesSeq = useRef(0)

  const sessionId = session?.id ?? null
  const workspacePath = workspace?.path ?? null

  const refresh = useCallback(() => {
    setFilePreview(null)
    setArtifactPreview(null)
    setLinks(null)
    setTools(null)
    setDynamicTools(null)
    setPairs(null)
    setArtifacts(null)
    setRefreshKey((value) => value + 1)
  }, [])
  useEscapeClose(onClose)

  // Workspace files load only while that tab is open, one directory at a time.
  useEffect(() => {
    if (tab !== 'files' || !workspacePath) return
    const seq = ++filesSeq.current
    setFilesLoading(true)
    window.pilot
      .listFiles(workspacePath, cwd)
      .then((entries) => {
        if (seq !== filesSeq.current) return
        setNodes(
          [...entries].sort((left, right) => {
            if (left.type !== right.type) return left.type === 'dir' ? -1 : 1
            return left.name.localeCompare(right.name, 'zh-CN')
          }),
        )
      })
      .catch((reason: unknown) => {
        if (seq !== filesSeq.current) return
        onError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (seq === filesSeq.current) setFilesLoading(false)
      })
  }, [tab, workspacePath, cwd, refreshKey, onError])

  useEffect(() => {
    setCwd('.')
    setFilePreview(null)
    setNodes([])
  }, [workspacePath])

  // Links, tools, knowledge and artifacts each fetch once per session, on demand.
  useEffect(() => {
    if (tab !== 'links' || !sessionId || links) return
    let cancelled = false
    window.pilot
      .sessionLinks(sessionId)
      .then((list) => {
        if (!cancelled) setLinks(list)
      })
      .catch((reason: unknown) => {
        if (!cancelled) onError(reason instanceof Error ? reason.message : String(reason))
      })
    return () => {
      cancelled = true
    }
  }, [tab, sessionId, links, onError])

  useEffect(() => {
    if (tab !== 'tools' || !sessionId || tools) return
    let cancelled = false
    window.pilot
      .toolsCatalog(sessionId)
      .then((list) => {
        if (!cancelled) setTools(list)
      })
      .catch((reason: unknown) => {
        if (!cancelled) onError(reason instanceof Error ? reason.message : String(reason))
      })
    return () => {
      cancelled = true
    }
  }, [tab, sessionId, tools, onError])

  // The catalog says what a run may call; the dynamic list is what the user can
  // still enable, promote or delete, so the tools tab loads both.
  useEffect(() => {
    if (tab !== 'tools' || !workspacePath || dynamicTools) return
    let cancelled = false
    window.pilot
      .listTools(workspacePath)
      .then((list) => {
        if (!cancelled) setDynamicTools(list)
      })
      .catch(() => {
        if (!cancelled) setDynamicTools([])
      })
    return () => {
      cancelled = true
    }
  }, [tab, workspacePath, dynamicTools, refreshKey])

  useEffect(() => {
    if (tab !== 'tools' || !workspacePath) return undefined
    return window.pilot.onEvent((event) => {
      if (event.type !== 'tools.changed' || event.workspacePath !== workspacePath) return
      setDynamicTools(null)
      setTools(null)
    })
  }, [tab, workspacePath])

  useEffect(() => {
    if (tab !== 'knowledge' || !sessionId || pairs) return
    let cancelled = false
    window.pilot
      .knowledgePairs(sessionId, '', PAIR_LIMIT)
      .then((result) => {
        if (cancelled) return
        setPairs(result.pairs)
        setPairTotal(result.total)
      })
      .catch((reason: unknown) => {
        if (!cancelled) onError(reason instanceof Error ? reason.message : String(reason))
      })
    return () => {
      cancelled = true
    }
  }, [tab, sessionId, pairs, onError])

  useEffect(() => {
    if (tab !== 'artifacts' || !sessionId || artifacts) return
    let cancelled = false
    window.pilot
      .getSessionArtifacts(sessionId)
      .then((list) => {
        if (!cancelled) setArtifacts(list)
      })
      .catch((reason: unknown) => {
        if (!cancelled) onError(reason instanceof Error ? reason.message : String(reason))
      })
    return () => {
      cancelled = true
    }
  }, [tab, sessionId, artifacts, onError])

  // A change bar row names one file: preview it straight away on the artifacts tab.
  const seedKey = artifactSeed?.key
  const seedPath = artifactSeed?.path
  useEffect(() => {
    if (!seedPath || !workspacePath || !sessionId) return
    let cancelled = false
    setPreviewLoading(true)
    window.pilot
      .previewFile(workspacePath, seedPath)
      .then((file) => {
        if (!cancelled) setArtifactPreview(file)
      })
      .catch((reason: unknown) => {
        if (!cancelled) onError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [seedKey, seedPath, workspacePath, sessionId, onError])

  const openWorkspaceFile = async (node: FileNode): Promise<void> => {
    if (!workspacePath) return
    setPreviewLoading(true)
    try {
      setFilePreview(await window.pilot.previewFile(workspacePath, node.path))
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setPreviewLoading(false)
    }
  }

  const openArtifact = async (artifact: SessionArtifact): Promise<void> => {
    if (!workspacePath) return
    setPreviewLoading(true)
    try {
      setArtifactPreview(await window.pilot.previewFile(workspacePath, artifact.path))
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setPreviewLoading(false)
    }
  }

  /** Reload both tool views after an enable/promote/delete action. */
  const reloadTools = async (): Promise<void> => {
    const [catalog, dynamic] = await Promise.all([
      sessionId ? window.pilot.toolsCatalog(sessionId) : Promise.resolve([]),
      workspacePath ? window.pilot.listTools(workspacePath) : Promise.resolve([]),
    ])
    setTools(catalog)
    setDynamicTools(dynamic)
  }

  const toolAction = async (key: string, run: () => Promise<unknown>): Promise<void> => {
    if (toolBusy) return
    setToolBusy(key)
    try {
      await run()
      await reloadTools()
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setToolBusy('')
    }
  }

  const parts = cwd === '.' ? [] : cwd.split('/')
  const crumbs = parts.map((part, index) => ({
    name: part,
    path: parts.slice(0, index + 1).join('/'),
  }))

  const activeLink = useMemo(() => {
    if (!links || links.length === 0) return null
    return links.find((link) => link.url === activeUrl) ?? links[0] ?? null
  }, [activeUrl, links])

  const activeToolEntry = useMemo(() => {
    if (!tools || tools.length === 0) return null
    return tools.find((tool) => tool.name === activeTool) ?? tools[0] ?? null
  }, [activeTool, tools])

  /** The editable record behind the selected catalog entry, if it has one. */
  const activeDynamicTool = useMemo(() => {
    if (!activeToolEntry || activeToolEntry.source !== 'dynamic' || !dynamicTools) return null
    return dynamicTools.find((tool) => tool.name === activeToolEntry.name) ?? null
  }, [activeToolEntry, dynamicTools])

  const needle = query.trim().toLowerCase()
  const visiblePairs = useMemo(() => {
    if (!pairs) return null
    if (!needle) return pairs
    return pairs.filter(
      (pair) =>
        pair.instruction.toLowerCase().includes(needle) || pair.reply.toLowerCase().includes(needle),
    )
  }, [needle, pairs])

  const activePair = useMemo(() => {
    if (!visiblePairs || visiblePairs.length === 0) return null
    return visiblePairs.find((pair) => pair.key === activePairKey) ?? visiblePairs[0] ?? null
  }, [activePairKey, visiblePairs])

  // The workspace store keeps the only copy of every entry; this session only
  // records which ids its prompt carried. Written-but-unread entries are added
  // so a remember call shows up immediately, before the next run re-injects it.
  const memoryRows = useMemo(() => sessionMemories(memory, session), [memory, session])
  const visibleMemoryRows = useMemo(() => {
    if (!needle) return memoryRows
    return memoryRows.filter((row) => row.entry.content.toLowerCase().includes(needle))
  }, [memoryRows, needle])
  const activeMemoryRow = useMemo(() => {
    if (visibleMemoryRows.length === 0) return null
    return (
      visibleMemoryRows.find((row) => row.entry.id === activeMemoryId) ?? visibleMemoryRows[0] ?? null
    )
  }, [activeMemoryId, visibleMemoryRows])

  const counts: Record<ResourceTab, number | null> = {
    files: null,
    links: links?.length ?? null,
    tools: tools?.length ?? null,
    knowledge: pairs ? pairTotal : null,
    memory: session ? memoryRows.length : null,
    artifacts: artifacts?.length ?? null,
  }

  const jumpToMessage = (messageId: string): void => {
    if (!sessionId || !onOpenMessage) return
    onOpenMessage(sessionId, messageId)
    onClose()
  }

  const emptyState = (icon: ReactNode, title: string, hint: string): ReactNode => (
    <div className="empty-panel compact resources-empty">
      {icon}
      <strong>{title}</strong>
      <span>{hint}</span>
    </div>
  )

  const loadingRow = (label: string): ReactNode => (
    <div className="drawer-loading">
      <i className="spinner" />
      {label}
    </div>
  )

  const renderFilesList = (): ReactNode => {
    if (!workspace) {
      return emptyState(
        <FolderIcon width={26} height={26} />,
        t('没有打开的工作区'),
        t('先从侧边栏选择一个本地文件夹。'),
      )
    }
    if (filesLoading && nodes.length === 0) return loadingRow(t('加载中…'))
    if (nodes.length === 0) {
      return emptyState(
        <FolderIcon width={26} height={26} />,
        t('这个文件夹是空的'),
        t('也可能是内容都被忽略规则隐藏了。'),
      )
    }
    return (
      <div className="file-list">
        {cwd !== '.' ? (
          <button
            type="button"
            className="file-row"
            onClick={() => {
              setFilePreview(null)
              setCwd(parts.slice(0, -1).join('/') || '.')
            }}
          >
            <span className="file-icon folder">
              <ChevronDownIcon width={14} height={14} className="rotate-90" />
            </span>
            <span className="file-name">..</span>
          </button>
        ) : null}
        {nodes.map((node) => (
          <button
            type="button"
            className={`file-row${node.type === 'dir' ? ' is-dir' : ''}`}
            key={node.path}
            onClick={() => {
              if (node.type === 'dir') {
                setFilePreview(null)
                setCwd(node.path)
              } else {
                void openWorkspaceFile(node)
              }
            }}
            title={node.path}
          >
            <span className={`file-icon ${node.type}`}>
              {node.type === 'dir' ? (
                <FolderIcon width={15} height={15} />
              ) : (
                <FileIcon width={15} height={15} />
              )}
            </span>
            <span className="file-name">{node.name}</span>
            {node.size !== undefined ? (
              <span className="file-size">{formatBytes(node.size)}</span>
            ) : null}
            {node.type === 'dir' ? (
              <ChevronIcon width={13} height={13} className="file-chevron" />
            ) : null}
          </button>
        ))}
      </div>
    )
  }

  const renderLinksList = (): ReactNode => {
    if (!session) {
      return emptyState(
        <LinkIcon width={26} height={26} />,
        t('还没有选中的会话'),
        t('选择会话后，这里会列出对话里出现过的链接。'),
      )
    }
    if (!links) return loadingRow(t('正在收集链接…'))
    if (links.length === 0) {
      return emptyState(
        <LinkIcon width={26} height={26} />,
        t('这个会话还没有链接'),
        t('对话里出现 http(s) 链接后，会自动汇总到这里。'),
      )
    }
    return (
      <div className="file-list">
        {links.map((link) => (
          <button
            type="button"
            className={`resource-row${link.url === activeLink?.url ? ' is-active' : ''}`}
            key={link.url}
            onClick={() => setActiveUrl(link.url)}
            title={link.url}
          >
            <span className="file-icon link">
              <LinkIcon width={15} height={15} />
            </span>
            <span className="resource-row-main">
              <span className="resource-row-title">{link.host || link.url}</span>
              <span className="resource-row-sub">{link.context || link.url}</span>
            </span>
            {link.count > 1 ? <span className="resource-row-badge">×{link.count}</span> : null}
          </button>
        ))}
      </div>
    )
  }

  const renderToolsList = (): ReactNode => {
    if (!session) {
      return emptyState(
        <WrenchIcon width={26} height={26} />,
        t('还没有选中的会话'),
        t('选择会话后，这里会列出这次运行可用的工具。'),
      )
    }
    if (!tools) return loadingRow(t('载入工具…'))
    if (tools.length === 0) {
      return emptyState(
        <WrenchIcon width={26} height={26} />,
        t('这个会话还没有可用工具'),
        t('内置、MCP 与自写工具一旦对这次运行开放，就会出现在这里。'),
      )
    }
    return (
      <div className="file-list">
        {tools.map((tool) => (
          <button
            type="button"
            className={`resource-row tool-row${tool.name === activeToolEntry?.name ? ' is-active' : ''}`}
            key={`${tool.source}:${tool.name}`}
            onClick={() => setActiveTool(tool.name)}
            title={`${tool.name}\n${toolDescription(tool)}`}
          >
            <span className="file-icon tool">
              <WrenchIcon width={15} height={15} />
            </span>
            <span className="resource-row-main">
              <span className="tool-row-head">
                <span className="resource-row-title">{tool.name}</span>
                <span className="resource-row-badge" title={toolSourceLabel(tool)}>
                  {`${toolSourceLabel(tool)} · ${tool.calls ?? 0}`}
                </span>
                <span className={`resource-chip risk-${tool.risk}`} title={`risk: ${tool.risk}`}>
                  {toolRiskLabel(tool.risk)}
                </span>
              </span>
              <span className="resource-row-desc">
                {toolDescription(tool) || t('这个工具没有写说明。')}
              </span>
            </span>
          </button>
        ))}
      </div>
    )
  }

  const renderKnowledgeList = (): ReactNode => {
    if (!session) {
      return emptyState(
        <HistoryIcon width={26} height={26} />,
        t('还没有选中的会话'),
        t('选择会话后，这里会按轮次整理提问与回复。'),
      )
    }
    if (!visiblePairs) return loadingRow(t('正在整理轮次…'))
    if (visiblePairs.length === 0) {
      return emptyState(
        <SearchIcon width={26} height={26} />,
        needle ? t('没有匹配的轮次') : t('这个会话还没有问答'),
        needle
          ? t('换一个关键词，或清空搜索查看全部轮次。')
          : t('完成一轮问答后，这里会列出「我的指令 → Pilot 回复」。'),
      )
    }
    return (
      <div className="file-list">
        {visiblePairs.map((pair) => (
          <button
            type="button"
            className={`resource-row${pair.key === activePair?.key ? ' is-active' : ''}`}
            key={pair.key}
            onClick={() => setActivePairKey(pair.key)}
            title={excerpt(pair.instruction, 400)}
          >
            <span className="file-icon knowledge">
              <HistoryIcon width={15} height={15} />
            </span>
            <span className="resource-row-main">
              <span className="resource-row-title">{t('第 {v1} 轮', { v1: pair.index })}</span>
              <span className="resource-row-sub">{excerpt(pair.instruction, 90)}</span>
            </span>
          </button>
        ))}
      </div>
    )
  }

  const renderMemoryList = (): ReactNode => {
    if (!session) {
      return emptyState(
        <BrainIcon width={26} height={26} />,
        t('还没有选中的会话'),
        t('选择会话后，这里会列出这轮任务用到的项目记忆。'),
      )
    }
    if (visibleMemoryRows.length === 0) {
      return emptyState(
        <BrainIcon width={26} height={26} />,
        needle ? t('没有匹配的记忆') : t('这个会话还没有记忆'),
        needle
          ? t('换一个关键词，或清空搜索查看全部条目。')
          : t('运行会把工作区里相关的记忆写进提示词，Pilot 也可以用 remember 记录新事实。'),
      )
    }
    return (
      <div className="file-list">
        {visibleMemoryRows.map((row) => (
          <button
            type="button"
            className={`resource-row${row.entry.id === activeMemoryRow?.entry.id ? ' is-active' : ''}`}
            key={row.entry.id}
            onClick={() => setActiveMemoryId(row.entry.id)}
            title={excerpt(row.entry.content, 400)}
          >
            <span className="file-icon memory">
              <BrainIcon width={15} height={15} />
            </span>
            <span className="resource-row-main">
              <span className="resource-row-title">{excerpt(row.entry.content, 48)}</span>
              <span className="resource-row-sub">
                {MEMORY_CATEGORY_LABELS[memoryCategoryOf(row.entry)]}
                {row.written ? ` · ${t('本会话写入')}` : ''}
              </span>
            </span>
          </button>
        ))}
      </div>
    )
  }

  const renderArtifactsList = (): ReactNode => {
    if (!session) {
      return emptyState(
        <FileIcon width={26} height={26} />,
        t('还没有选中的会话'),
        t('选择一个会话后，这里会列出 Pilot 写入或修改过的文件。'),
      )
    }
    if (!artifacts) return loadingRow(t('加载中…'))
    if (artifacts.length === 0) {
      return emptyState(
        <FileIcon width={26} height={26} />,
        t('这个会话还没有产出文件'),
        t('Pilot 成功写入或修改的文件会自动收集到这里。'),
      )
    }
    return (
      <div className="file-list">
        {artifacts.map((artifact) => (
          <button
            type="button"
            className={`resource-row${artifactPreview?.path === artifact.path ? ' is-active' : ''}`}
            key={artifact.path}
            onClick={() => void openArtifact(artifact)}
            title={artifact.path}
          >
            <span className="file-icon file">
              <FileIcon width={15} height={15} />
            </span>
            <span className="resource-row-main">
              <span className="resource-row-title">{artifact.name}</span>
              <span className="resource-row-sub">{artifact.path}</span>
            </span>
            <span className={`artifact-action ${artifact.action}`}>
              {artifact.action === 'write' ? t('新建') : t('修改')}
            </span>
          </button>
        ))}
      </div>
    )
  }

  const renderLinksPreview = (): ReactNode => {
    if (!activeLink) return <div className="resource-hint">{t('从左侧选择一条链接。')}</div>
    const partsOfUrl = describeLink(activeLink.url)
    const params = queryPairs(partsOfUrl.query)
    return (
      <div className="resource-detail">
        <div className="resource-detail-head">
          <span className="resource-detail-title">{activeLink.host || activeLink.url}</span>
          <span className="resource-detail-actions">
            <button
              type="button"
              className="button ghost small"
              onClick={() => {
                void copyText(activeLink.url)
                onNotice(t('链接已复制'))
              }}
            >
              <CopyIcon width={13} height={13} />
              {t('复制')}
            </button>
            <button
              type="button"
              className="button small"
              onClick={() => {
                // 默认走内置浏览器：不离开当前窗口就能看原文。
                void window.pilot.openLink(activeLink.url, false)
              }}
            >
              <PopoutIcon width={13} height={13} />
              {t('在内置浏览器打开')}
            </button>
            <button
              type="button"
              className="button ghost small"
              onClick={() => {
                void window.pilot.openLink(activeLink.url, true)
              }}
              title={t('交给系统默认浏览器')}
            >
              <ArrowUpRightIcon width={13} height={13} />
              {t('系统浏览器')}
            </button>
          </span>
        </div>
        <code className="resource-url">{activeLink.url}</code>
        <div className="resource-facts">
          <span>{t('出现 {v1} 次', { v1: activeLink.count })}</span>
          <span>{activeLink.role === 'user' ? t('来自我的提问') : t('来自 Pilot 的回复')}</span>
          <span>{formatRelative(activeLink.createdAt)}</span>
        </div>
        <dl className="resource-kv">
          {partsOfUrl.scheme ? (
            <>
              <dt>{t('协议')}</dt>
              <dd>{partsOfUrl.scheme}</dd>
            </>
          ) : null}
          {partsOfUrl.host ? (
            <>
              <dt>{t('域名')}</dt>
              <dd>{partsOfUrl.host}</dd>
            </>
          ) : null}
          {partsOfUrl.path ? (
            <>
              <dt>{t('路径')}</dt>
              <dd className="mono">{partsOfUrl.path}</dd>
            </>
          ) : null}
          {partsOfUrl.hash ? (
            <>
              <dt>{t('锚点')}</dt>
              <dd className="mono">{partsOfUrl.hash}</dd>
            </>
          ) : null}
        </dl>
        {params.length > 0 ? (
          <div className="resource-section">
            <div className="resource-section-head">{t('查询参数')}</div>
            <dl className="resource-kv">
              {params.map((param, index) => (
                <span className="resource-kv-pair" key={`${param.key}-${index}`}>
                  <dt>{param.key}</dt>
                  <dd className="mono">{param.value || t('（空）')}</dd>
                </span>
              ))}
            </dl>
          </div>
        ) : null}
        <div className="resource-section">
          <div className="resource-section-head">{t('提到它的消息')}</div>
          <p className="resource-context">{activeLink.context || t('（这句里只有链接本身）')}</p>
          {onOpenMessage ? (
            <button
              type="button"
              className="icon-text-button"
              onClick={() => jumpToMessage(activeLink.messageId)}
            >
              <ChevronIcon width={13} height={13} className="rotate-180" />
              {t('跳到原始消息')}
            </button>
          ) : null}
        </div>
        <div className="resource-note">
          {t('链接只从会话正文里收集，不抓取内容：这里看到的是提过哪些链接。')}
        </div>
      </div>
    )
  }

  const renderToolsPreview = (): ReactNode => {
    if (!activeToolEntry) return <div className="resource-hint">{t('从左侧选择一个工具。')}</div>
    const tool = activeToolEntry
    const schema = tool.inputSchema ? JSON.stringify(tool.inputSchema, null, 2) : ''
    return (
      <div className="resource-detail">
        <div className="resource-detail-head">
          <span className="resource-detail-title">{tool.name}</span>
          <span className="resource-detail-actions">
            <span className="resource-chip">{toolSourceLabel(tool)}</span>
            <span className={`resource-chip risk-${tool.risk}`} title={`risk: ${tool.risk}`}>
              {toolRiskLabel(tool.risk)}
            </span>
            <span className={`resource-chip ${tool.enabled === false ? 'warn' : 'ok'}`}>
              {tool.enabled === false ? t('未开放') : t('已开放')}
            </span>
          </span>
        </div>
        <p className="resource-context">{toolDescription(tool) || t('这个工具没有写说明。')}</p>
        {tool.targets && tool.targets.length > 0 ? (
          <div className="resource-section">
            <div className="resource-section-head">{t('可访问目标')}</div>
            <div className="resource-targets">
              {tool.targets.map((target) => (
                <code key={target}>{target}</code>
              ))}
            </div>
          </div>
        ) : null}
        {schema ? (
          <div className="resource-section">
            <div className="resource-section-head">{t('输入结构')}</div>
            <pre className="resource-code">{schema}</pre>
          </div>
        ) : null}
        {tool.version !== undefined ? (
          <div className="resource-facts">
            <span>{t('版本 {v1}', { v1: tool.version })}</span>
          </div>
        ) : null}
        <div className="resource-facts">
          <span>{t('当前会话调用 {v1} 次', { v1: tool.calls ?? 0 })}</span>
        </div>
        {activeDynamicTool ? (
          <div className="resource-section">
            <div className="resource-section-head">{t('工具')}</div>
            <div className="resource-facts">
              <span>
                {t('成功 {v1} · 失败 {v2}', {
                  v1: activeDynamicTool.successCount,
                  v2: activeDynamicTool.failureCount,
                })}
              </span>
              <span>
                {activeDynamicTool.lastRunAt
                  ? t('上次运行 {v1}', { v1: formatRelative(activeDynamicTool.lastRunAt) })
                  : t('尚未运行')}
              </span>
            </div>
            <div className="resource-actions">
              {activeDynamicTool.source === 'workspace' && activeDynamicTool.approved ? (
                <button
                  type="button"
                  className="button small"
                  disabled={Boolean(toolBusy)}
                  onClick={() => {
                    if (
                      !window.confirm(
                        t("把「{v1}」复制到全局工具目录？之后每个工作区都能使用它。", {
                          v1: activeDynamicTool.name,
                        }),
                      )
                    ) {
                      return
                    }
                    void toolAction(activeDynamicTool.name, () =>
                      window.pilot.promoteTool(workspacePath ?? '', activeDynamicTool.name),
                    )
                  }}
                >
                  {t('提升为全局')}
                </button>
              ) : null}
              <button
                type="button"
                className="button small"
                disabled={Boolean(toolBusy)}
                onClick={() =>
                  void toolAction(activeDynamicTool.name, () =>
                    window.pilot.setToolEnabled(
                      workspacePath ?? '',
                      activeDynamicTool.source,
                      activeDynamicTool.name,
                      !activeDynamicTool.enabled,
                    ),
                  )
                }
              >
                {activeDynamicTool.enabled ? t('停用') : t('启用')}
              </button>
              <button
                type="button"
                className="button danger small"
                disabled={Boolean(toolBusy)}
                onClick={() => {
                  if (
                    !window.confirm(
                      t("删除工具「{v1}」及其代码？这个操作不可撤销。", {
                        v1: activeDynamicTool.name,
                      }),
                    )
                  ) {
                    return
                  }
                  void toolAction(activeDynamicTool.name, () =>
                    window.pilot.removeTool(
                      workspacePath ?? '',
                      activeDynamicTool.source,
                      activeDynamicTool.name,
                    ),
                  )
                }}
              >
                {t('删除')}
              </button>
            </div>
            {!activeDynamicTool.approved ? (
              <div className="resource-note">
                {t("代码在登记后发生了变化或自测未通过。Pilot 不能运行它，需重新调用 register_tool 登记。")}
              </div>
            ) : null}
            {activeDynamicTool.lastError ? (
              <div className="resource-note">{activeDynamicTool.lastError}</div>
            ) : null}
          </div>
        ) : null}
        <div className="resource-note">
          {t('清单与运行时一致：这里看到的就是这次运行真实可用的工具集合。')}
        </div>
      </div>
    )
  }

  const renderKnowledgePreview = (): ReactNode => {
    if (!activePair) return <div className="resource-hint">{t('从左侧选择一轮问答。')}</div>
    return (
      <div className="resource-detail knowledge-preview">
        <div className="resource-detail-head">
          <span className="resource-detail-title">
            {t('第 {v1} 轮 · {v2} 条回复', { v1: activePair.index, v2: activePair.replyCount })}
          </span>
          <span className="resource-detail-actions">
            <span className="resource-chip">{formatRelative(activePair.instructionAt)}</span>
            {onOpenMessage ? (
              <button
                type="button"
                className="icon-text-button"
                onClick={() => jumpToMessage(activePair.replyId)}
              >
                <ChevronIcon width={13} height={13} className="rotate-180" />
                {t('跳到这条回复')}
              </button>
            ) : null}
          </span>
        </div>
        <div className="resource-section">
          <div className="resource-section-head">{t('我的指令')}</div>
          <div className="preview-doc">
            <Markdown content={activePair.instruction} />
          </div>
          {activePair.instructionTruncated ? (
            <div className="resource-note">{t('这条指令在知识库里是截断后的版本。')}</div>
          ) : null}
        </div>
        <div className="resource-section">
          <div className="resource-section-head">Pilot</div>
          <div className="preview-doc">
            <Markdown content={activePair.reply || t('（这一轮没有文字回复）')} />
          </div>
          {activePair.replyTruncated ? (
            <div className="resource-note">{t('这条回复在知识库里是截断后的版本。')}</div>
          ) : null}
        </div>
      </div>
    )
  }

  const renderMemoryPreview = (): ReactNode => {
    if (!activeMemoryRow) {
      return (
        <div className="resource-hint">
          {needle
            ? t('没有匹配的记忆，清空搜索可查看这个会话的全部记忆。')
            : t('从左侧选择一条记忆查看内容。')}
        </div>
      )
    }
    const entry = activeMemoryRow.entry
    return (
      <div className="resource-detail memory-preview">
        <div className="resource-detail-head">
          <span className="resource-detail-title">
            {MEMORY_CATEGORY_LABELS[memoryCategoryOf(entry)]}
          </span>
          <span className="resource-detail-actions">
            {activeMemoryRow.written ? (
              <span className="resource-chip">{t('本会话写入')}</span>
            ) : null}
            {activeMemoryRow.injected ? (
              <span className="resource-chip">{t('本轮提示词已注入')}</span>
            ) : null}
            <span className="resource-chip">{formatRelative(entry.createdAt)}</span>
            {onDeleteMemory ? (
              <button
                type="button"
                className="icon-button danger"
                title={t('删除这条记忆')}
                aria-label={t('删除这条记忆')}
                disabled={memoryBusy === entry.id}
                onClick={() => {
                  if (!window.confirm(t('删除这条记忆？Pilot 之后不会再使用它。'))) return
                  setMemoryBusy(entry.id)
                  void onDeleteMemory(entry.id)
                    .catch(() => {
                      // The app surfaces the error as a toast.
                    })
                    .finally(() => setMemoryBusy(null))
                }}
              >
                {memoryBusy === entry.id ? (
                  <i className="spinner small" />
                ) : (
                  <TrashIcon width={13} height={13} />
                )}
              </button>
            ) : null}
          </span>
        </div>
        <div className="preview-doc memory-preview-body">
          <Markdown content={entry.content} />
        </div>
        <div className="resource-note">
          {t('提示词注入 {v1} 次 · 复现 {v2} 次', {
            v1: entry.injected ?? 0,
            v2: entry.reinforced ?? 0,
          })}
          {entry.source === 'user'
            ? ` · ${t('你写入的长期偏好')}`
            : entry.source === 'reflection'
              ? ` · ${t('运行复盘产生')}`
              : ` · ${t('Pilot 运行时记录')}`}
        </div>
        {onOpenMemoryPanel ? (
          <div className="resource-actions">
            <button type="button" className="button small" onClick={onOpenMemoryPanel}>
              <BrainIcon width={14} height={14} />
              {t('打开项目记忆')}
            </button>
          </div>
        ) : null}
      </div>
    )
  }

  const renderPreview = (): ReactNode => {
    if (tab === 'links') return renderLinksPreview()
    if (tab === 'tools') return renderToolsPreview()
    if (tab === 'knowledge') return renderKnowledgePreview()
    if (tab === 'memory') return renderMemoryPreview()
    if (previewLoading) return loadingRow(t('打开文件…'))
    if (tab === 'artifacts') {
      if (!artifactPreview) {
        return <div className="resource-hint">{t('从左侧选择一个文件查看内容。')}</div>
      }
      const seed = artifacts?.find((entry) => entry.path === artifactPreview.path)
      return (
        <FilePreviewPane
          preview={artifactPreview}
          workspace={workspace}
          onBack={() => setArtifactPreview(null)}
          onNotice={onNotice}
          {...(seed
            ? {
                extraMeta: (
                  <span className={`artifact-action ${seed.action}`}>
                    {seed.action === 'write' ? t('新建') : t('修改')}
                    {seed.tool ? ` · ${seed.tool}` : ''}
                  </span>
                ),
              }
            : {})}
          {...(onOpenChanges ? { onOpenChanges } : {})}
        />
      )
    }
    if (!filePreview) {
      return <div className="resource-hint">{t('从左侧选择一个文件查看内容。')}</div>
    }
    return (
      <FilePreviewPane
        preview={filePreview}
        workspace={workspace}
        onBack={() => setFilePreview(null)}
        onNotice={onNotice}
      />
    )
  }

  const footNote =
    tab === 'files'
      ? t('只读预览 · 修改请通过对话完成')
      : tab === 'links'
        ? t('链接来自本次会话正文 · 只汇总不抓取')
        : tab === 'tools'
          ? t('清单与运行时一致 · 只读展示')
          : tab === 'knowledge'
            ? t('按轮次整理的会话知识库 · 只读预览')
            : tab === 'memory'
              ? t('项目记忆按工作区共享 · 这里只列出本会话用到的条目')
              : t('只汇总本次会话成功写入的文件 · 只读预览')

  return (
    <div className="resources-panel-shell">
      <div className="drawer-backdrop" onMouseDown={onClose} />
      <aside
        className={`files-drawer resources-drawer${expanded ? ' is-expanded' : ''}`}
        aria-label={t('会话资源')}
      >
        <div className="drawer-head">
          <div>
            <div className="drawer-eyebrow">
              <FilesIcon width={13} height={13} />
              {t('会话资源')}
            </div>
            <h2>{session?.title || workspace?.name || t('未选择会话')}</h2>
          </div>
          <div className="drawer-head-actions">
            <button
              type="button"
              className={`icon-button${expanded ? ' is-selected' : ''}`}
              title={expanded ? t('还原窗口') : t('展开到整个界面')}
              aria-label={expanded ? t('还原窗口') : t('展开到整个界面')}
              onClick={() => setExpanded((value) => !value)}
            >
              <PopoutIcon width={15} height={15} />
            </button>
            <button type="button" className="icon-button" title={t('刷新')} onClick={refresh}>
              <RefreshIcon width={15} height={15} />
            </button>
            <button type="button" className="modal-close" onClick={onClose} aria-label={t('关闭')}>
              <XIcon width={17} height={17} />
            </button>
          </div>
        </div>
        <div className="resources-tabs" role="tablist" aria-label={t('会话资源分类')}>
          {RESOURCE_TABS.map((entry) => {
            const count = counts[entry]
            return (
              <button
                type="button"
                role="tab"
                key={entry}
                aria-selected={entry === tab}
                className={`resources-tab${entry === tab ? ' is-active' : ''}`}
                onClick={() => onTabChange(entry)}
              >
                {tabIcon(entry)}
                <span>{tabLabel(entry)}</span>
                {count !== null ? <span className="resources-tab-count">{count}</span> : null}
              </button>
            )
          })}
        </div>

        <div className="drawer-body resources-body">
          <div className="resources-list">
            {tab === 'files' ? (
              <div className="file-breadcrumb">
                <button
                  type="button"
                  className={`crumb${cwd === '.' ? ' is-current' : ''}`}
                  onClick={() => {
                    setFilePreview(null)
                    setCwd('.')
                  }}
                >
                  <FolderIcon width={13} height={13} />
                  {workspace?.name || t('工作区')}
                </button>
                {crumbs.map((crumb, index) => (
                  <button
                    type="button"
                    className={`crumb${index === crumbs.length - 1 ? ' is-current' : ''}`}
                    key={crumb.path}
                    onClick={() => {
                      setFilePreview(null)
                      setCwd(crumb.path)
                    }}
                  >
                    <ChevronIcon width={12} height={12} className="rotate-90" />
                    {crumb.name}
                  </button>
                ))}
              </div>
            ) : null}

            {tab === 'knowledge' || tab === 'memory' ? (
              <label className="resources-search">
                <SearchIcon width={13} height={13} />
                <input
                  type="search"
                  value={query}
                  placeholder={
                    tab === 'memory' ? t('搜索本会话的记忆') : t('搜索这个会话的问答')
                  }
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
            ) : null}

            {tab === 'files'
              ? renderFilesList()
              : tab === 'links'
                ? renderLinksList()
                : tab === 'tools'
                  ? renderToolsList()
                  : tab === 'knowledge'
                    ? renderKnowledgeList()
                    : tab === 'memory'
                      ? renderMemoryList()
                      : renderArtifactsList()}
          </div>
          <div className="resources-preview">{renderPreview()}</div>
        </div>

        <div className="drawer-foot">
          <span>{footNote}</span>
        </div>
      </aside>
    </div>
  )
}
