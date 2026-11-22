import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent,
} from 'react'
import type {
  MessageDelivery,
  ProjectInstructionFile,
  ScheduledTask,
  ScheduledTaskInput,
  Session,
  TodoItem,
  TodoPriority,
  WorkspaceSummary,
} from '../../../../shared/types'
import {
  isImageUpload,
  MAX_UPLOAD_FILES,
  MAX_UPLOAD_IMAGES,
  mergeReferences,
  planUpload,
} from '../../../../shared/uploads'
import {
  FileIcon,
  FilesIcon,
  FolderIcon,
  ImageIcon,
  InfoIcon,
  PauseIcon,
  SendIcon,
  StopIcon,
  XIcon,
} from '../../icons'
import { formatNumber, stripIpcWrapper } from '../../ui'
import type { TranscriptUsage } from '../../tokens'
import { t } from '../../i18n'
import { SessionSchedulePanel } from '../SessionSchedulePanel'
import { ReferencePicker } from '../ReferencePicker'
import { PlanPanel } from './plan'
import { TodoPanel } from './panels'
import {
  APPROVAL_LABELS,
  formatFileSize,
  readComposerDraft,
  readInputHistory,
  rememberInput,
  saveComposerDraft,
  type ComposerDraftState,
} from './composer-state'

// Seeded prompts must only fill the composer once: remounting ChatView (view
// switch) restores the draft instead of replaying a stale seed. Seed keys are
// monotonic across the app, so a single module-level marker is enough.
let lastAppliedComposerSeed = 0

export function Composer({
  session,
  workspaces,
  running,
  planSettled,
  hasKey,
  contextUsage,
  projectInstructions,
  composerSeed,
  onSend,
  onStop,
  onPause,
  onOpenSettings,
  onAddTodo,
  onUpdateTodo,
  onRemoveTodo,
  onSendTodo,
  onSendAllTodos,
  onClearSentTodos,
  onScheduleTodo,
  onSetTodoPriority,
  scheduleSeed,
  onScheduleSeedUsed,
  onConvertTodoToSchedule,
  onConvertScheduleToTodo,
  onNotice,
}: {
  session: Session | null
  workspaces: WorkspaceSummary[]
  running: boolean
  planSettled: boolean
  hasKey: boolean
  /** Estimated prompt footprint shown above the composer; null hides the readout. */
  contextUsage: TranscriptUsage | null
  projectInstructions: ProjectInstructionFile[]
  composerSeed: { key: number; text: string } | null
  onSend: (
    text: string,
    delivery: MessageDelivery,
    options?: { images?: string[]; references?: string[] },
  ) => Promise<boolean>
  onStop: () => void
  onPause: () => void
  onOpenSettings: () => void
  onAddTodo: (text: string, priority?: TodoPriority) => Promise<void>
  onUpdateTodo: (todoId: string, text: string) => Promise<void>
  onRemoveTodo: (todoId: string) => Promise<void>
  onSendTodo: (todoId: string) => Promise<void>
  onSendAllTodos: () => Promise<void>
  onClearSentTodos: () => Promise<void>
  onScheduleTodo: (todo: TodoItem) => void
  onSetTodoPriority: (todoId: string, priority: TodoPriority) => Promise<void>
  /** 待办时钟按钮带进来的内容：面板收到后自行展开并预填表单。 */
  scheduleSeed: { content: string; todoId?: string } | null
  onScheduleSeedUsed: () => void
  onConvertTodoToSchedule: (
    todoId: string,
    input: ScheduledTaskInput,
  ) => Promise<ScheduledTask | null>
  onConvertScheduleToTodo: (taskId: string) => Promise<void>
  onNotice: (message: string) => void
}) {
  const [draft, setDraft] = useState(() => readComposerDraft(session?.id).text)
  const [delivery, setDelivery] = useState<MessageDelivery>('queue')
  const [submitting, setSubmitting] = useState(false)
  const [images, setImages] = useState<string[]>(() => readComposerDraft(session?.id).images)
  const [references, setReferences] = useState<string[]>(
    () => readComposerDraft(session?.id).references,
  )
  const [refOpen, setRefOpen] = useState(false)
  const [picking, setPicking] = useState(false)
  const [filing, setFiling] = useState(false)
  // 拖拽计数：光标从子元素进出会重复触发 enter/leave，只靠布尔值会闪。
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const sessionIdRef = useRef<string | null>(session?.id ?? null)
  const historyIndex = useRef(-1)
  const historyDraft = useRef('')

  const persistDraft = (patch: Partial<ComposerDraftState>) => {
    const id = sessionIdRef.current
    saveComposerDraft(id, { ...readComposerDraft(id), ...patch })
  }
  const changeDraft = (value: string) => {
    setDraft(value)
    persistDraft({ text: value })
  }
  const changeImages = (value: string[]) => {
    setImages(value)
    persistDraft({ images: value })
  }
  const changeReferences = (value: string[]) => {
    setReferences(value)
    persistDraft({ references: value })
  }

  useEffect(() => {
    if (sessionIdRef.current !== (session?.id ?? null)) {
      sessionIdRef.current = session?.id ?? null
      const restored = readComposerDraft(session?.id)
      setDraft(restored.text)
      setImages(restored.images)
      setReferences(restored.references)
      setRefOpen(false)
      historyIndex.current = -1
      historyDraft.current = ''
    }
  }, [session?.id])

  useEffect(() => {
    const element = textareaRef.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 220)}px`
  }, [draft])

  useEffect(() => {
    if (!composerSeed || composerSeed.key <= lastAppliedComposerSeed) return
    lastAppliedComposerSeed = composerSeed.key
    changeDraft(composerSeed.text)
    changeImages([])
    changeReferences([])
    window.setTimeout(() => textareaRef.current?.focus(), 30)
  }, [composerSeed])

  useEffect(() => {
    if (!running) setDelivery('queue')
  }, [running])

  // 主进程的拒绝理由（体积超限、工作区外、同名太多）要原样说清楚，
  // 但要先剥掉 Electron 的「Error invoking remote method '/pilot:xxx': Error:」外壳。
  const errorText = (error: unknown): string =>
    stripIpcWrapper(error instanceof Error ? error.message : String(error))

  const pickImages = async () => {
    if (picking || running) return
    setPicking(true)
    try {
      const picked = await window.pilot.pickImages()
      if (picked.length > 0) {
        changeImages([...images, ...picked].slice(0, 3))
      }
    } catch (error) {
      // Surfacing the reason matters when an image is too large.
      window.alert(errorText(error))
    } finally {
      setPicking(false)
    }
  }

  const pickFiles = async () => {
    if (filing || running) return
    const workspacePath = session?.workspacePath || ''
    if (!workspacePath) {
      window.alert(t("当前会话没有工作区，无法上传文件"))
      return
    }
    setFiling(true)
    try {
      const uploaded = await window.pilot.pickFiles(workspacePath)
      if (uploaded.length > 0) {
        const merged = mergeReferences(
          references,
          uploaded.map((file) => file.path).filter(Boolean),
        )
        if (merged.dropped > 0) window.alert(t("最多参照 8 个项目"))
        changeReferences(merged.references)
      }
    } catch (error) {
      // A rejected file (too large, outside the workspace) has to say why.
      window.alert(errorText(error))
    } finally {
      setFiling(false)
    }
  }

  const attachFiles = async (files: File[]) => {
    if (files.length === 0) return
    if (running) {
      window.alert(t("任务结束后可添加文件"))
      return
    }
    const notices: string[] = []
    const imageFiles = files.filter((file) => isImageUpload(file))
    const otherFiles = files.filter((file) => !isImageUpload(file))
    setFiling(true)
    try {
      if (imageFiles.length > 0) {
        const room = Math.max(0, MAX_UPLOAD_IMAGES - images.length)
        if (room === 0) {
          notices.push(t("最多附图 {v1} 张", { v1: MAX_UPLOAD_IMAGES }))
        } else {
          // 图片要变成 data URL，所以即使能拿到磁盘路径也直接读字节。
          const plan = await planUpload(imageFiles, () => '', { limit: room, readBytes: true })
          const added: string[] = []
          for (const blob of plan.blobs) {
            added.push(await window.pilot.pasteImage({ name: blob.name, data: blob.data }))
          }
          if (added.length > 0) changeImages([...images, ...added].slice(0, MAX_UPLOAD_IMAGES))
          if (plan.overflow > 0) {
            notices.push(t("最多附图 {v1} 张", { v1: MAX_UPLOAD_IMAGES }))
          }
        }
      }
      if (otherFiles.length > 0) {
        const workspacePath = session?.workspacePath || ''
        if (!workspacePath) {
          notices.push(t("当前会话没有工作区，无法上传文件"))
        } else {
          const plan = await planUpload(otherFiles, (file) =>
            window.pilot.pathForFile(file as unknown),
          )
          if (plan.paths.length + plan.blobs.length > 0) {
            const uploaded = await window.pilot.uploadFiles(workspacePath, {
              paths: plan.paths,
              blobs: plan.blobs,
            })
            const merged = mergeReferences(
              references,
              uploaded.map((file) => file.path).filter(Boolean),
            )
            changeReferences(merged.references)
            if (merged.dropped > 0) {
              notices.push(t("最多参照 8 个项目"))
            }
          }
          if (plan.overflow > 0) {
            notices.push(t("一次最多上传 {v1} 个文件", { v1: MAX_UPLOAD_FILES }))
          }
        }
      }
    } catch (error) {
      // 体积超限、工作区外、同名太多等理由必须说清楚。
      notices.push(errorText(error))
    } finally {
      setFiling(false)
    }
    if (notices.length > 0) window.alert(notices.join('\n'))
  }

  const draggedFiles = (event: ReactDragEvent<HTMLElement>): boolean =>
    Array.from(event.dataTransfer?.types ?? []).includes('Files')

  const onDragEnter = (event: ReactDragEvent<HTMLElement>) => {
    if (!draggedFiles(event)) return
    event.preventDefault()
    dragDepth.current += 1
    setDragging(true)
  }

  const onDragOver = (event: ReactDragEvent<HTMLElement>) => {
    if (!draggedFiles(event)) return
    // 不阻止默认行为的话，Electron 会把整个窗口导航到被拖入的文件。
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }

  const onDragLeave = (event: ReactDragEvent<HTMLElement>) => {
    if (!draggedFiles(event)) return
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }

  const onDrop = (event: ReactDragEvent<HTMLElement>) => {
    if (!draggedFiles(event)) return
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    void attachFiles(Array.from(event.dataTransfer.files))
  }

  const onPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData?.files ?? [])
    // 普通文本粘贴必须照常进入 textarea，只有带文件时才接管。
    if (files.length === 0) return
    event.preventDefault()
    void attachFiles(files)
  }

  const toggleReference = (path: string) => {
    changeReferences(
      references.includes(path)
        ? references.filter((entry) => entry !== path)
        : [...references, path].slice(0, 8),
    )
  }
  const referenceLabel = (path: string): string =>
    workspaces.find((entry) => entry.path === path)?.name ||
    path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ||
    path

  const submit = async () => {
    const text = draft.trim()
    if ((!text && images.length === 0 && references.length === 0) || submitting) return
    if (!hasKey) {
      onOpenSettings()
      return
    }
    setSubmitting(true)
    try {
      const sent = await onSend(text, delivery, { images, references })
      if (sent) {
        if (text) rememberInput(text)
        historyIndex.current = -1
        historyDraft.current = ''
        changeDraft('')
        changeImages([])
        changeReferences([])
        window.setTimeout(() => textareaRef.current?.focus(), 30)
      }
    } finally {
      setSubmitting(false)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void submit()
      return
    }
    if (
      (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') ||
      event.shiftKey ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.nativeEvent.isComposing
    ) {
      return
    }
    const history = readInputHistory()
    if (history.length === 0) return
    const element = event.currentTarget
    if (event.key === 'ArrowUp') {
      // Only walk history when the caret is at the very start; otherwise let
      // the textarea move between the user's own lines.
      if (element.selectionStart !== 0 || element.selectionEnd !== 0) return
      event.preventDefault()
      if (historyIndex.current < 0) historyDraft.current = draft
      historyIndex.current = Math.min(historyIndex.current + 1, history.length - 1)
      changeDraft(history[historyIndex.current] ?? '')
      return
    }
    if (historyIndex.current < 0) return
    event.preventDefault()
    historyIndex.current -= 1
    changeDraft(
      historyIndex.current < 0 ? historyDraft.current : (history[historyIndex.current] ?? ''),
    )
  }

  return (
    <div
      className={`composer-wrap${dragging ? ' is-dragging' : ''}`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragging ? (
        <div className="composer-drop-hint">
          <FilesIcon width={18} height={18} />
          <span>{t("松开即可附件：图片随消息发送，其它文件上传到工作区")}</span>
        </div>
      ) : null}
      {!hasKey ? (
        <button type="button" className="composer-warning" onClick={onOpenSettings}>
          <InfoIcon width={14} height={14} />
          {t("尚未配置 API Key，点击设置后即可开始。")}</button>
      ) : null}

      <div className={`composer${running ? ' is-running' : ''}`}>
        <div className="composer-main">
          {session ? (
            <TodoPanel
              todos={session.todos}
              onAdd={onAddTodo}
              onUpdate={onUpdateTodo}
              onRemove={onRemoveTodo}
              onSend={onSendTodo}
              onSendAll={onSendAllTodos}
              onClearSent={onClearSentTodos}
              onSchedule={onScheduleTodo}
              onPriority={onSetTodoPriority}
            />
          ) : null}
          {session ? (
            <SessionSchedulePanel
              sessionId={session.id}
              seed={scheduleSeed}
              onSeedUsed={onScheduleSeedUsed}
              onConvertTodoToSchedule={onConvertTodoToSchedule}
              onConvertToTodo={onConvertScheduleToTodo}
              onNotice={onNotice}
            />
          ) : null}
          {session?.plan ? (
            <PlanPanel plan={session.plan} running={running} settled={planSettled} />
          ) : null}
          {images.length > 0 || references.length > 0 ? (
            <div className="attachment-strip">
              {references.map((path) => (
                <span className="attachment-chip" key={path} title={path}>
                  <FolderIcon width={12} height={12} />
                  <span>{referenceLabel(path)}</span>
                  <button
                    type="button"
                    aria-label={t("移除参照")}
                    onClick={() => changeReferences(references.filter((entry) => entry !== path))}
                  >
                    <XIcon width={10} height={10} />
                  </button>
                </span>
              ))}
              {images.map((url, index) => (
                <span className="attachment-thumb" key={`image-${index}`}>
                  <img src={url} alt={t("待发送图片")} />
                  <button
                    type="button"
                    aria-label={t("移除图片")}
                    onClick={() => changeImages(images.filter((_, at) => at !== index))}
                  >
                    <XIcon width={10} height={10} />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <textarea
            ref={textareaRef}
            className="composer-input"
            value={draft}
            rows={1}
            onChange={(event) => changeDraft(event.target.value)}
            placeholder={
              running
                ? t("继续补充任务；可排队，或插入当前任务在下一步生效…")
                : t("描述任务，Pilot 会读取工作区并自主执行…")
            }
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            spellCheck={false}
          />
        </div>

        <div className="composer-footer">
          <div className="composer-left">
            <button
              type="button"
              className="composer-attach"
              onClick={() => void pickImages()}
              disabled={running || picking}
              title={running ? t("任务结束后可添加图片") : t("添加图片")}
            >
              {picking ? <i className="spinner tiny" /> : <ImageIcon width={14} height={14} />}
              {t("图片")}</button>
            <button
              type="button"
              className="composer-attach"
              onClick={() => void pickFiles()}
              disabled={running || filing || !session?.workspacePath}
              title={
                running
                  ? t("任务结束后可添加文件")
                  : t("上传文件到工作区，作为参照发送；也可以直接拖进来或粘贴")
              }
            >
              {filing ? <i className="spinner tiny" /> : <FilesIcon width={14} height={14} />}
              {t("文件")}</button>
            <button
              type="button"
              className="composer-attach"
              onClick={() => setRefOpen(true)}
              disabled={running || !session}
              title={running ? t("任务结束后可参照其他项目") : t("参照其他项目")}
            >
              <FileIcon width={14} height={14} />
              {t("参照")}{references.length > 0 ? <span className="attach-count">{references.length}</span> : null}
            </button>
            {running ? (
              <div className="delivery-toggle" role="group" aria-label={t("消息投递方式")}>
                <button
                  type="button"
                  className={delivery === 'queue' ? 'is-active' : ''}
                  onClick={() => setDelivery('queue')}
                  title={t("当前任务结束后自动开始")}
                >
                  {t("排队")}</button>
                <button
                  type="button"
                  className={delivery === 'insert' ? 'is-active' : ''}
                  onClick={() => setDelivery('insert')}
                  title={t("在下一步将消息插入当前任务")}
                >
                  {t("插入当前任务")}</button>
              </div>
            ) : (
              <span className="composer-hint">
                {session
                  ? session.kind === 'review'
                    ? t("只读复盘 · 不写入、不执行命令")
                    : t("{v1} · 本地工作区", {
                        v1: APPROVAL_LABELS[session.approvalMode] ?? session.approvalMode,
                      })
                  : t("全部自动 · 本地工作区")}
              </span>
            )}
            {projectInstructions.length > 0 ? (
              <span
                className="project-instruction-chip"
                title={projectInstructions
                  .map((file) => t("{v1} · {v2}{v3}", { v1: file.name, v2: formatFileSize(file.bytes), v3: file.truncated ? t(" · 已截断") : '' }))
                  .join('\n')}
              >
                {t("项目指令 ·")}{projectInstructions.map((file) => file.name).join(' / ')}
              </span>
            ) : null}
            {contextUsage && contextUsage.tokens > 0 ? (
              <span
                className="context-tokens"
                title={t("按对话内容估算的上下文用量 · {v1} 条消息", { v1: formatNumber(contextUsage.messages) })}
              >
                {t("上下文 ≈ {v1} tokens", { v1: formatNumber(contextUsage.tokens) })}
              </span>
            ) : null}
          </div>

          <div className="composer-right">
            <span className="key-hint">{t("Enter 发送 · Shift+Enter 换行 · 可附图/参照")}</span>
            {running ? (
              <>
                <button
                  type="button"
                  className="composer-pause"
                  onClick={onPause}
                  title={t("暂停当前任务，可随时继续")}
                >
                  <PauseIcon width={14} height={14} />
                </button>
                <button
                  type="button"
                  className="composer-stop"
                  onClick={onStop}
                  title={t("停止当前任务（不会自动继续）")}
                >
                  <StopIcon width={14} height={14} />
                </button>
              </>
            ) : null}
            <button
              type="button"
              className="composer-send"
              onClick={() => void submit()}
              disabled={(!draft.trim() && images.length === 0 && references.length === 0) || submitting}
              title={hasKey ? t("发送") : t("先配置 API Key")}
            >
              {submitting ? <i className="spinner" /> : <SendIcon width={16} height={16} />}
            </button>
          </div>
        </div>
      </div>
      {refOpen && session ? (
        <ReferencePicker
          workspacePath={session.workspacePath}
          workspaces={workspaces}
          selected={references}
          onClose={() => setRefOpen(false)}
          onToggle={toggleReference}
        />
      ) : null}
    </div>
  )
}
