/**
 * Pilot 渲染进程桥的定义。
 *
 * 桌面端由 preload 用 Electron 的 ipcRenderer 实现，服务器模式由浏览器端用
 * WebSocket 实现，两边共用这一份通道名与参数顺序，因此「网页版和客户端功能
 * 一致」不是靠两套代码对齐，而是同一个对象。
 *
 * 这里只能出现纯 JS：不 import electron，也不碰 node 内置模块。
 */
import type {
  ApprovalMode,
  CheckpointRestoreMode,
  ContributionEvidence,
  MessageDelivery,
  MessageOptions,
  MessageSearchFilter,
  ModuleCheckSettings,
  PilotBridge,
  PluginCreateInput,
  PluginInstallInput,
  PluginSignaturePolicy,
  ReviewSessionInput,
  RunEvent,
  SettingsUpdate,
  SelfSourceSettings,
  ThemeMode,
  TodoPriority,
  UpdateState,
} from '../shared/types'

/**
 * `undefined` 在 JSON 里会变成 `null`，而 IPC 里两者并不等价：`options` 位置传
 * `null` 时 handler 里的 `options.images` 会直接抛 TypeError，桌面端同样的调用却
 * 因为 `undefined` 走默认值而正常。所以 `undefined` 用哨兵键原样带上，服务端还原。
 */
export const BRIDGE_UNDEFINED_MARK = '__pilot_undefined__'

/**
 * `ArrayBuffer` 在 JSON 里会变成 `{}`：浏览器里「上传文件」「粘贴图片」这些
 * 带字节的调用会静默丢掉内容（主进程读到空数据才报「没有要上传的文件」）。
 * 用 base64 哨兵把字节原样带过去。
 */
export const BRIDGE_BYTES_MARK = '__pilot_bytes__'

/**
 * 浏览器到服务器的单帧上限，也是服务器 `WebSocketServer.maxPayload` 的取值。
 * 一帧装不下时 ws 会直接关连接，所以双方得用同一个数做预检。
 */
export const BRIDGE_MAX_FRAME_BYTES = 1024 * 1024

/** 参数里允许走的嵌套层数；再深就原样交给 JSON，不让编码器自己爆栈。 */
const MAX_VALUE_DEPTH = 6

function bytesFrame(bytes: Uint8Array): Record<string, unknown> {
  let binary = ''
  // 一次 8 KB：`String.fromCharCode(...)` 的参数太多会撑爆调用栈。
  const chunk = 0x2000
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk))
  }
  return { [BRIDGE_BYTES_MARK]: btoa(binary) }
}

function bytesText(value: object): string | null {
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== 1 || keys[0] !== BRIDGE_BYTES_MARK) return null
  const text = record[BRIDGE_BYTES_MARK]
  return typeof text === 'string' ? text : null
}

function encodeValue(value: unknown, depth: number): unknown {
  if (value instanceof ArrayBuffer) return bytesFrame(new Uint8Array(value))
  if (ArrayBuffer.isView(value)) {
    return bytesFrame(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
  }
  if (!value || typeof value !== 'object' || depth >= MAX_VALUE_DEPTH) return value
  if (Array.isArray(value)) return value.map((item) => encodeValue(item, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = encodeValue(item, depth + 1)
  }
  return out
}

function decodeValue(value: unknown, depth: number): unknown {
  if (!value || typeof value !== 'object') return value
  const encoded = bytesText(value)
  if (encoded !== null) {
    try {
      const binary = atob(encoded)
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
      return bytes.buffer
    } catch {
      return value
    }
  }
  if (depth >= MAX_VALUE_DEPTH) return value
  if (Array.isArray(value)) return value.map((item) => decodeValue(item, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = decodeValue(item, depth + 1)
  }
  return out
}

/** 浏览器侧发帧前调用：裁掉尾部的 `undefined`，其余位置打成哨兵对象。 */
export function encodeBridgeArgs(args: unknown[]): unknown[] {
  let end = args.length
  while (end > 0 && args[end - 1] === undefined) end -= 1
  return args
    .slice(0, end)
    .map((value) => (value === undefined ? { [BRIDGE_UNDEFINED_MARK]: true } : encodeValue(value, 0)))
}

/** 服务端收帧后调用：把哨兵对象还原成真正的 `undefined` 与 `ArrayBuffer`。 */
export function decodeBridgeArgs(args: unknown[]): unknown[] {
  return args.map((value) => {
    if (value && typeof value === 'object' && (value as Record<string, unknown>)[BRIDGE_UNDEFINED_MARK] === true) {
      return undefined
    }
    return decodeValue(value, 0)
  })
}

/** 一次 RPC 调用的最小能力面；桌面端是 ipcRenderer，网页版是 /bridge WebSocket。 */
export interface BridgeRpc {
  invoke(channel: string, ...args: unknown[]): Promise<any>
  on(channel: string, listener: (payload: unknown) => void): () => void
  /** 桌面端由 webUtils 提供；浏览器拿不到磁盘路径，返回空串。 */
  pathForFile?(file: unknown): string
}

export function createBridge(rpc: BridgeRpc): PilotBridge {
  const invoke = rpc.invoke.bind(rpc)
  return {
    bootstrap: () => invoke('pilot:bootstrap'),
    updateSettings: (input: SettingsUpdate) => invoke('pilot:settings-update', input),
    reflectNow: () => invoke('pilot:reflect-now'),
    reflectionReports: () => invoke('pilot:reflection-reports'),
    clearReflectionReports: () => invoke('pilot:reflection-reports-clear'),
    setReflectionFindingStatus: (reportId: string, findingId: string, status: string) =>
      invoke('pilot:reflection-finding-status', reportId, findingId, status),
    testReflectionMail: (to: string) => invoke('pilot:reflection-mail-test', to),
    testConnection: (input) => invoke('pilot:test-connection', input),
    modelBilling: (refresh?: boolean) => invoke('pilot:model-billing', refresh),
    judgeBalance: (input) => invoke('pilot:judge-balance', input),
    setTheme: (theme: ThemeMode) => invoke('pilot:set-theme', theme),
    previewTheme: (input) => invoke('pilot:preview-theme', input),

    submitFeedback: (input, workspacePath?: string) =>
      invoke('pilot:feedback-submit', input, workspacePath),
    openFeedbackFolder: () => invoke('pilot:feedback-folder'),

    companionStatus: () => invoke('pilot:companion-status'),
    setCompanionEnabled: (enabled: boolean) =>
      invoke('pilot:companion-enabled', enabled),
    setCompanionRelay: (url: string) => invoke('pilot:companion-relay', url),
    createCompanionPairing: () => invoke('pilot:companion-pairing'),
    companionPairDecision: (requestId: string, approved: boolean, role?: 'host' | 'client') =>
      invoke('pilot:companion-pair-decision', requestId, approved, role),
    revokeCompanion: (phoneId: string) => invoke('pilot:companion-revoke', phoneId),
    companionLocalUrl: () => invoke('pilot:companion-local-url'),
    companionAppQr: () => invoke('pilot:companion-app-qr'),
    companionRoots: () => invoke('pilot:companion-roots'),
    addCompanionRoot: (path: string) => invoke('pilot:companion-root-add', path),
    removeCompanionRoot: (path: string) => invoke('pilot:companion-root-remove', path),

    pickFolder: (title?: string) => invoke('pilot:pick-folder', title),
    openWorkspace: (path: string) => invoke('pilot:workspace-open', path),
    removeWorkspace: (path: string) => invoke('pilot:workspace-remove', path),
    setSessionModel: (sessionId: string, modelId: string) =>
      invoke('pilot:session-model', sessionId, modelId),
    openWorkspaceFolder: (path: string) => invoke('pilot:workspace-reveal', path),
    prepareSelfSource: () => invoke('pilot:self-source-prepare'),
    personalEvolution: () => invoke('pilot:personal-state'),
    selfSource: {
      status: () => invoke('pilot:self-source-status'),
      configure: (input) => invoke('pilot:self-source-configure', input),
      sync: () => invoke('pilot:self-source-sync'),
      pick: () => invoke('pilot:self-source-pick'),
    },
    savePersonalVersion: (input: { name: string; note?: string }) =>
      invoke('pilot:personal-save-version', input),
    restorePersonalVersion: (versionId: string) =>
      invoke('pilot:personal-restore-version', versionId),
    submitPersonalVersion: (versionId: string, note: string, evidence?: ContributionEvidence) =>
      invoke('pilot:personal-submit', versionId, note, evidence),
    revealPersonalContribution: (contributionId: string) =>
      invoke('pilot:personal-reveal-contribution', contributionId),
    preparePersonalUpgrade: () => invoke('pilot:personal-upgrade-plan'),
    applyPersonalUpgrade: () => invoke('pilot:personal-upgrade-apply'),
    validatePersonalUpgrade: () => invoke('pilot:personal-upgrade-validate'),
    rollbackPersonalUpgrade: () => invoke('pilot:personal-upgrade-rollback'),

    listSessions: (workspacePath: string) => invoke('pilot:sessions-list', workspacePath),
    getSession: (sessionId: string) => invoke('pilot:session-get', sessionId),
    getSessionPage: (
      sessionId: string,
      before?: string,
      limit?: number,
      options?: { dialogue?: boolean },
    ) => invoke('pilot:session-page', sessionId, before, limit, options),
    getSessionProcess: (sessionId: string, runId: string, limit?: number) =>
      invoke('pilot:session-process', sessionId, runId, limit),
    getSessionAround: (sessionId: string, messageId: string, limit?: number) =>
      invoke('pilot:session-around', sessionId, messageId, limit),
    searchMessages: (query: string, limit?: number, filter?: MessageSearchFilter) =>
      invoke('pilot:search', query, limit, filter),
    knowledgePairs: (sessionId: string, query?: string, limit?: number) => {
      return invoke('pilot:knowledge-pairs', sessionId, query, limit)
    },
    sessionLinks: (sessionId: string) => invoke('pilot:session-links', sessionId),
    toolsCatalog: (sessionId: string) => invoke('pilot:tools-catalog', sessionId),
    toolsCatalogForWorkspace: (workspacePath: string) =>
      invoke('pilot:tools-catalog-workspace', workspacePath),
    getSessionTranscript: (sessionId: string) =>
      invoke('pilot:session-transcript', sessionId),
    writeClipboard: (text: string) => invoke('pilot:clipboard-write', text),
    createSession: (workspacePath: string) => invoke('pilot:session-create', workspacePath),
    createReviewSession: (input: ReviewSessionInput) =>
      invoke('pilot:review-create', input),
    handoffReview: (sessionId: string) => invoke('pilot:review-handoff', sessionId),
    moduleCheckState: () => invoke('pilot:module-check-state'),
    moduleCheckDiscover: () => invoke('pilot:module-check-discover'),
    moduleCheckRun: (moduleIds?: string[]) => invoke('pilot:module-check-run', moduleIds),
    moduleCheckSettings: (input) => invoke('pilot:module-check-settings', input),
    moduleCheckAccept: (input) => invoke('pilot:module-check-accept', input),
    supervisorState: () => invoke('pilot:supervisor-state'),
    supervisorRun: () => invoke('pilot:supervisor-run'),
    supervisorSettings: (input) => invoke('pilot:supervisor-settings', input),
    deleteSession: (sessionId: string) => invoke('pilot:session-delete', sessionId),
    updateSession: (sessionId: string, input: { title?: string; approvalMode?: ApprovalMode }) =>
      invoke('pilot:session-update', sessionId, input),

    sendMessage: (
      sessionId: string,
      content: string,
      delivery: MessageDelivery,
      options?: MessageOptions,
    ) => invoke('pilot:message-send', sessionId, content, delivery, options),
    pickImages: () => invoke('pilot:pick-images'),
    pickFiles: (workspacePath: string) => invoke('pilot:pick-files', workspacePath),
    uploadFiles: (workspacePath: string, input) =>
      invoke('pilot:upload-files', workspacePath, input),
    pasteImage: (input) => invoke('pilot:paste-image', input),
    // 拖拽/粘贴来的 File 在渲染进程里拿不到真实路径，只能由 preload 问 Chromium
    // 要；没有磁盘来源的（剪贴板虚拟文件）会返回空串。
    pathForFile: (file: unknown) => rpc.pathForFile?.(file) ?? '',
    cancelRun: (sessionId: string) => invoke('pilot:run-cancel', sessionId),
    pauseRun: (sessionId: string) => invoke('pilot:run-pause', sessionId),
    continueRun: (sessionId: string) => invoke('pilot:run-continue', sessionId),
    editMessage: (sessionId: string, messageId: string, content: string) =>
      invoke('pilot:message-edit', sessionId, messageId, content),
    deleteMessage: (sessionId: string, messageId: string) =>
      invoke('pilot:message-delete', sessionId, messageId),
    regenerate: (sessionId: string) => invoke('pilot:run-regenerate', sessionId),
    retryRun: (sessionId: string) => invoke('pilot:run-retry', sessionId),
    projectInstructions: (workspacePath: string) =>
      invoke('pilot:project-instructions', workspacePath),
    removeQueueItem: (sessionId: string, taskId: string) =>
      invoke('pilot:queue-remove', sessionId, taskId),
    insertQueueItem: (sessionId: string, taskId: string) =>
      invoke('pilot:queue-insert', sessionId, taskId),
    updateQueueItem: (sessionId: string, taskId: string, content: string) =>
      invoke('pilot:queue-update', sessionId, taskId, content),
    convertQueueItemToTodo: (sessionId: string, taskId: string) =>
      invoke('pilot:queue-to-todo', sessionId, taskId),
    decideApproval: (callId: string, approved: boolean, reason?: string, remember?: boolean) =>
      invoke('pilot:approval-decide', callId, approved, reason, remember),

    forkSession: (sessionId: string) => invoke('pilot:session-fork', sessionId),
    getSessionArtifacts: (sessionId: string) =>
      invoke('pilot:session-artifacts', sessionId),
    reviewSessionChanges: (sessionId: string) =>
      invoke('pilot:changes-list', sessionId),
    revertSessionFile: (sessionId: string, path: string) =>
      invoke('pilot:change-revert', sessionId, path),

    sandboxStatus: () => invoke('pilot:sandbox-status'),
    systemInfo: (workspacePath?: string) => invoke('pilot:system-info', workspacePath),
    resourceUsage: (workspacePath?: string) =>
      invoke('pilot:resource-usage', workspacePath),
    recentLogs: (limit?: number) => invoke('pilot:logs-recent', limit),
    logDir: () => invoke('pilot:logs-dir'),
    openLogs: () => invoke('pilot:logs-open'),
    reportRendererError: (input: { summary: string; stack?: string; source?: string }) =>
      invoke('pilot:renderer-error', input),
    selfCheck: () => invoke('pilot:self-check-run'),
    qualityEvaluate: (path: string) => invoke('pilot:quality-evaluate', path),
    qualityDecide: (path: string, candidateId: string, decision: 'approve' | 'reject') =>
      invoke('pilot:quality-decide', path, candidateId, decision),
    qualityPublish: (path: string, candidateId: string) =>
      invoke('pilot:quality-publish', path, candidateId),
    qualityTune: (path: string) => invoke('pilot:quality-tune', path),
    listCheckpoints: (sessionId: string) =>
      invoke('pilot:checkpoints-list', sessionId),
    createCheckpoint: (sessionId: string, label?: string) =>
      invoke('pilot:checkpoint-create', sessionId, label),
    restoreCheckpoint: (
      sessionId: string,
      checkpointId: string,
      mode: CheckpointRestoreMode,
    ) => invoke('pilot:checkpoint-restore', sessionId, checkpointId, mode),

    quickCommands: () => invoke('pilot:quick-commands-list'),
    saveQuickCommands: (items) => invoke('pilot:quick-commands-save', items),

    listScheduledTasks: (sessionId: string) =>
      invoke('pilot:scheduled-list', sessionId),
    allScheduledTasks: () => invoke('pilot:scheduled-all'),
    addScheduledTask: (sessionId: string, input) =>
      invoke('pilot:scheduled-add', sessionId, input),
    updateScheduledTask: (sessionId: string, taskId: string, input) =>
      invoke('pilot:scheduled-update', sessionId, taskId, input),
    removeScheduledTask: (sessionId: string, taskId: string) =>
      invoke('pilot:scheduled-remove', sessionId, taskId),
    convertTodoToSchedule: (sessionId: string, todoId: string, input) =>
      invoke('pilot:todo-to-schedule', sessionId, todoId, input),
    convertScheduledTaskToTodo: (sessionId: string, taskId: string) =>
      invoke('pilot:scheduled-to-todo', sessionId, taskId),

    listTodos: (sessionId: string) => invoke('pilot:todos-list', sessionId),
    allTodos: () => invoke('pilot:todos-all'),
    addTodo: (sessionId: string, text: string, clientId?: string, priority?: TodoPriority) =>
      invoke('pilot:todo-add', sessionId, text, clientId, priority),
    updateTodo: (sessionId: string, todoId: string, text: string, priority?: TodoPriority) =>
      invoke('pilot:todo-update', sessionId, todoId, text, priority),
    setTodoPriority: (sessionId: string, todoId: string, priority: TodoPriority) =>
      invoke('pilot:todo-priority', sessionId, todoId, priority),
    removeTodo: (sessionId: string, todoId: string) =>
      invoke('pilot:todo-remove', sessionId, todoId),
    clearSentTodos: (sessionId: string) =>
      invoke('pilot:todos-clear-sent', sessionId),
    sendTodo: (sessionId: string, todoId: string) =>
      invoke('pilot:todo-send', sessionId, todoId),
    sendAllTodos: (sessionId: string) => invoke('pilot:todos-send-all', sessionId),

    getWorkspaceDetail: (path: string) => invoke('pilot:workspace-detail', path),
    addMemory: (path: string, content: string) => invoke('pilot:memory-add', path, content),
    deleteMemory: (path: string, memoryId: string) =>
      invoke('pilot:memory-delete', path, memoryId),
    setFeedback: (sessionId: string, runId: string, rating: 'up' | 'down', note?: string) =>
      invoke('pilot:feedback-set', sessionId, runId, rating, note),
    reflectRun: (sessionId: string, runId: string) =>
      invoke('pilot:run-reflect', sessionId, runId),

    proposeEvolution: (path: string) => invoke('pilot:evolution-propose', path),
    runSystemEvolution: (path: string) =>
      invoke('pilot:evolution-run-cycle', path),
    improveEvolutionFlow: () => invoke('pilot:evolution-improve-policy'),
    rollbackEvolutionPolicy: () => invoke('pilot:evolution-policy-rollback'),
    clearEvolutionHistory: () => invoke('pilot:evolution-clear-history'),
    reviewProfile: (path: string, profileId: string) =>
      invoke('pilot:profile-review', path, profileId),
    benchmarkProfile: (path: string, profileId: string) =>
      invoke('pilot:profile-benchmark', path, profileId),
    activateProfile: (path: string, profileId: string, force?: boolean) =>
      invoke('pilot:profile-activate', path, profileId, force),
    rollbackProfile: (path: string) => invoke('pilot:profile-rollback', path),
    deleteProfile: (path: string, profileId: string) =>
      invoke('pilot:profile-delete', path, profileId),

    promoteProfile: (path: string, profileId: string) =>
      invoke('pilot:evolution-promote-global', path, profileId),
    localizeProfile: (scope: 'workspace' | 'global', path: string, profileId: string) =>
      invoke('pilot:profile-localize', scope, path, profileId),
    explainProfile: (scope: 'workspace' | 'global', path: string, profileId: string) =>
      invoke('pilot:profile-explain', scope, path, profileId),
    benchmarkGlobalProfile: (profileId: string) =>
      invoke('pilot:global-profile-benchmark', profileId),
    reviewGlobalProfile: (profileId: string) =>
      invoke('pilot:global-profile-review', profileId),
    activateGlobalProfile: (profileId: string, force?: boolean) =>
      invoke('pilot:global-profile-activate', profileId, force),
    rollbackGlobalProfile: () => invoke('pilot:global-profile-rollback'),
    deleteGlobalProfile: (profileId: string) =>
      invoke('pilot:global-profile-delete', profileId),
    openGlobalInstructions: () => invoke('pilot:global-instructions-open'),

    listTools: (path: string) => invoke('pilot:tools-list', path),
    setToolEnabled: (path: string, source, name: string, enabled: boolean) =>
      invoke('pilot:tool-enabled', path, source, name, enabled),
    removeTool: (path: string, source, name: string) =>
      invoke('pilot:tool-remove', path, source, name),
    promoteTool: (path: string, name: string) =>
      invoke('pilot:tool-promote', path, name),

    plugins: {
      overview: (workspace: string) => invoke('pilot:plugins-overview', workspace),
      create: (input) => invoke('pilot:plugin-create', input),
      install: (workspace: string, input) =>
        invoke('pilot:plugin-install', workspace, input),
      installMarket: (workspace: string, id: string) =>
        invoke('pilot:plugin-install-market', workspace, id),
      installBuiltin: (workspace: string, id: string) =>
        invoke('pilot:plugin-install-builtin', workspace, id),
      draft: (workspace: string, input) => invoke('pilot:plugin-draft', workspace, input),
      draftInstall: (workspace: string, input) =>
        invoke('pilot:plugin-draft-install', workspace, input),
      remove: (workspace: string, id: string) => invoke('pilot:plugin-remove', workspace, id),
      setEnabled: (workspace: string, id: string, enabled: boolean) =>
        invoke('pilot:plugin-enabled', workspace, id, enabled),
      setConfig: (workspace: string, id: string, config: Record<string, unknown>) =>
        invoke('pilot:plugin-config', workspace, id, config),
      sign: (workspace: string, id: string) => invoke('pilot:plugin-sign', workspace, id),
      trust: (workspace: string, publicKey: string, label?: string) =>
        invoke('pilot:plugin-trust', workspace, publicKey, label),
      untrust: (workspace: string, keyId: string) =>
        invoke('pilot:plugin-untrust', workspace, keyId),
      setPolicy: (workspace: string, policy) =>
        invoke('pilot:plugin-policy', workspace, policy),
      pickDir: (title?: string) => invoke('pilot:plugin-pick-dir', title),
      reveal: (dir: string) => invoke('pilot:plugin-reveal', dir),
    },

    listFiles: (path: string, directory: string) =>
      invoke('pilot:files-list', path, directory),
    previewFile: (path: string, file: string) => invoke('pilot:file-preview', path, file),
    revealFile: (path: string, file: string) => invoke('pilot:file-reveal', path, file),
    openDocument: (workspace: string, file: string) =>
      invoke('pilot:doc-open', workspace, file),
    documentState: () => invoke('pilot:doc-state'),
    closeDocument: () => invoke('pilot:doc-close'),
    openLink: (url: string, external?: boolean) => invoke('pilot:open-link', url, external),

    updates: {
      state: () => invoke('pilot:update-state'),
      check: () => invoke('pilot:update-check'),
      download: () => invoke('pilot:update-download'),
      install: () => invoke('pilot:update-install'),
      onState: (listener: (state: UpdateState) => void) => {
        return rpc.on('pilot:update-state', (payload) => listener(payload as UpdateState))
      },
    },

    onEvent: (listener: (event: RunEvent) => void) => {
      return rpc.on('pilot:event', (payload) => listener(payload as RunEvent))
    },

    onFocusSession: (listener: (sessionId: string) => void) => {
      return rpc.on('pilot:focus-session', (payload) => listener(payload as string))
    },
    onFocusQuality: (listener: (workspacePath: string) => void) => {
      return rpc.on('pilot:focus-quality', (payload) => listener(payload as string))
    },
  }
}
