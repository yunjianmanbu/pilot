import { contextBridge, ipcRenderer, webUtils } from 'electron'
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
  UpdateState,
} from '../shared/types'

const bridge: PilotBridge = {
  bootstrap: () => ipcRenderer.invoke('pilot:bootstrap'),
  updateSettings: (input: SettingsUpdate) => ipcRenderer.invoke('pilot:settings-update', input),
  testConnection: (input) => ipcRenderer.invoke('pilot:test-connection', input),
  modelBilling: (refresh?: boolean) => ipcRenderer.invoke('pilot:model-billing', refresh),
  judgeBalance: (input) => ipcRenderer.invoke('pilot:judge-balance', input),
  setTheme: (theme: ThemeMode) => ipcRenderer.invoke('pilot:set-theme', theme),
  previewTheme: (input) => ipcRenderer.invoke('pilot:preview-theme', input),

  submitFeedback: (input, workspacePath?: string) =>
    ipcRenderer.invoke('pilot:feedback-submit', input, workspacePath),
  openFeedbackFolder: () => ipcRenderer.invoke('pilot:feedback-folder'),

  companionStatus: () => ipcRenderer.invoke('pilot:companion-status'),
  setCompanionEnabled: (enabled: boolean) =>
    ipcRenderer.invoke('pilot:companion-enabled', enabled),
  setCompanionRelay: (url: string) => ipcRenderer.invoke('pilot:companion-relay', url),
  createCompanionPairing: () => ipcRenderer.invoke('pilot:companion-pairing'),
  companionPairDecision: (requestId: string, approved: boolean) =>
    ipcRenderer.invoke('pilot:companion-pair-decision', requestId, approved),
  revokeCompanion: (phoneId: string) => ipcRenderer.invoke('pilot:companion-revoke', phoneId),
  companionLocalUrl: () => ipcRenderer.invoke('pilot:companion-local-url'),
  companionAppQr: () => ipcRenderer.invoke('pilot:companion-app-qr'),
  companionRoots: () => ipcRenderer.invoke('pilot:companion-roots'),
  addCompanionRoot: (path: string) => ipcRenderer.invoke('pilot:companion-root-add', path),
  removeCompanionRoot: (path: string) => ipcRenderer.invoke('pilot:companion-root-remove', path),

  pickFolder: (title?: string) => ipcRenderer.invoke('pilot:pick-folder', title),
  openWorkspace: (path: string) => ipcRenderer.invoke('pilot:workspace-open', path),
  removeWorkspace: (path: string) => ipcRenderer.invoke('pilot:workspace-remove', path),
  setSessionModel: (sessionId: string, modelId: string) =>
    ipcRenderer.invoke('pilot:session-model', sessionId, modelId),
  openWorkspaceFolder: (path: string) => ipcRenderer.invoke('pilot:workspace-reveal', path),
  prepareSelfSource: () => ipcRenderer.invoke('pilot:self-source-prepare'),
  personalEvolution: () => ipcRenderer.invoke('pilot:personal-state'),
  selfSource: {
    status: () => ipcRenderer.invoke('pilot:self-source-status'),
    configure: (input) => ipcRenderer.invoke('pilot:self-source-configure', input),
    sync: () => ipcRenderer.invoke('pilot:self-source-sync'),
    pick: () => ipcRenderer.invoke('pilot:self-source-pick'),
  },
  savePersonalVersion: (input: { name: string; note?: string }) =>
    ipcRenderer.invoke('pilot:personal-save-version', input),
  restorePersonalVersion: (versionId: string) =>
    ipcRenderer.invoke('pilot:personal-restore-version', versionId),
  submitPersonalVersion: (versionId: string, note: string, evidence?: ContributionEvidence) =>
    ipcRenderer.invoke('pilot:personal-submit', versionId, note, evidence),
  revealPersonalContribution: (contributionId: string) =>
    ipcRenderer.invoke('pilot:personal-reveal-contribution', contributionId),
  preparePersonalUpgrade: () => ipcRenderer.invoke('pilot:personal-upgrade-plan'),
  applyPersonalUpgrade: () => ipcRenderer.invoke('pilot:personal-upgrade-apply'),
  validatePersonalUpgrade: () => ipcRenderer.invoke('pilot:personal-upgrade-validate'),
  rollbackPersonalUpgrade: () => ipcRenderer.invoke('pilot:personal-upgrade-rollback'),

  listSessions: (workspacePath: string) => ipcRenderer.invoke('pilot:sessions-list', workspacePath),
  getSession: (sessionId: string) => ipcRenderer.invoke('pilot:session-get', sessionId),
  getSessionPage: (
    sessionId: string,
    before?: string,
    limit?: number,
    options?: { dialogue?: boolean },
  ) => ipcRenderer.invoke('pilot:session-page', sessionId, before, limit, options),
  getSessionProcess: (sessionId: string, runId: string, limit?: number) =>
    ipcRenderer.invoke('pilot:session-process', sessionId, runId, limit),
  getSessionAround: (sessionId: string, messageId: string, limit?: number) =>
    ipcRenderer.invoke('pilot:session-around', sessionId, messageId, limit),
  searchMessages: (query: string, limit?: number, filter?: MessageSearchFilter) =>
    ipcRenderer.invoke('pilot:search', query, limit, filter),
  knowledgePairs: (sessionId: string, query?: string, limit?: number) => {
    return ipcRenderer.invoke('pilot:knowledge-pairs', sessionId, query, limit)
  },
  sessionLinks: (sessionId: string) => ipcRenderer.invoke('pilot:session-links', sessionId),
  toolsCatalog: (sessionId: string) => ipcRenderer.invoke('pilot:tools-catalog', sessionId),
  getSessionTranscript: (sessionId: string) =>
    ipcRenderer.invoke('pilot:session-transcript', sessionId),
  writeClipboard: (text: string) => ipcRenderer.invoke('pilot:clipboard-write', text),
  createSession: (workspacePath: string) => ipcRenderer.invoke('pilot:session-create', workspacePath),
  createReviewSession: (input: ReviewSessionInput) =>
    ipcRenderer.invoke('pilot:review-create', input),
  handoffReview: (sessionId: string) => ipcRenderer.invoke('pilot:review-handoff', sessionId),
  moduleCheckState: () => ipcRenderer.invoke('pilot:module-check-state'),
  moduleCheckDiscover: () => ipcRenderer.invoke('pilot:module-check-discover'),
  moduleCheckRun: (moduleIds?: string[]) => ipcRenderer.invoke('pilot:module-check-run', moduleIds),
  moduleCheckSettings: (input) => ipcRenderer.invoke('pilot:module-check-settings', input),
  moduleCheckAccept: (input) => ipcRenderer.invoke('pilot:module-check-accept', input),
  deleteSession: (sessionId: string) => ipcRenderer.invoke('pilot:session-delete', sessionId),
  updateSession: (sessionId: string, input: { title?: string; approvalMode?: ApprovalMode }) =>
    ipcRenderer.invoke('pilot:session-update', sessionId, input),

  sendMessage: (
    sessionId: string,
    content: string,
    delivery: MessageDelivery,
    options?: MessageOptions,
  ) => ipcRenderer.invoke('pilot:message-send', sessionId, content, delivery, options),
  pickImages: () => ipcRenderer.invoke('pilot:pick-images'),
  pickFiles: (workspacePath: string) => ipcRenderer.invoke('pilot:pick-files', workspacePath),
  uploadFiles: (workspacePath: string, input) =>
    ipcRenderer.invoke('pilot:upload-files', workspacePath, input),
  pasteImage: (input) => ipcRenderer.invoke('pilot:paste-image', input),
  // 拖拽/粘贴来的 File 在渲染进程里拿不到真实路径，只能由 preload 问 Chromium
  // 要；没有磁盘来源的（剪贴板虚拟文件）会返回空串。
  pathForFile: (file: unknown) => webUtils.getPathForFile(file as never),
  cancelRun: (sessionId: string) => ipcRenderer.invoke('pilot:run-cancel', sessionId),
  pauseRun: (sessionId: string) => ipcRenderer.invoke('pilot:run-pause', sessionId),
  continueRun: (sessionId: string) => ipcRenderer.invoke('pilot:run-continue', sessionId),
  editMessage: (sessionId: string, messageId: string, content: string) =>
    ipcRenderer.invoke('pilot:message-edit', sessionId, messageId, content),
  deleteMessage: (sessionId: string, messageId: string) =>
    ipcRenderer.invoke('pilot:message-delete', sessionId, messageId),
  regenerate: (sessionId: string) => ipcRenderer.invoke('pilot:run-regenerate', sessionId),
  retryRun: (sessionId: string) => ipcRenderer.invoke('pilot:run-retry', sessionId),
  projectInstructions: (workspacePath: string) =>
    ipcRenderer.invoke('pilot:project-instructions', workspacePath),
  removeQueueItem: (sessionId: string, taskId: string) =>
    ipcRenderer.invoke('pilot:queue-remove', sessionId, taskId),
  insertQueueItem: (sessionId: string, taskId: string) =>
    ipcRenderer.invoke('pilot:queue-insert', sessionId, taskId),
  updateQueueItem: (sessionId: string, taskId: string, content: string) =>
    ipcRenderer.invoke('pilot:queue-update', sessionId, taskId, content),
  convertQueueItemToTodo: (sessionId: string, taskId: string) =>
    ipcRenderer.invoke('pilot:queue-to-todo', sessionId, taskId),
  decideApproval: (callId: string, approved: boolean, reason?: string, remember?: boolean) =>
    ipcRenderer.invoke('pilot:approval-decide', callId, approved, reason, remember),

  forkSession: (sessionId: string) => ipcRenderer.invoke('pilot:session-fork', sessionId),
  getSessionArtifacts: (sessionId: string) =>
    ipcRenderer.invoke('pilot:session-artifacts', sessionId),
  reviewSessionChanges: (sessionId: string) =>
    ipcRenderer.invoke('pilot:changes-list', sessionId),
  revertSessionFile: (sessionId: string, path: string) =>
    ipcRenderer.invoke('pilot:change-revert', sessionId, path),

  sandboxStatus: () => ipcRenderer.invoke('pilot:sandbox-status'),
  systemInfo: (workspacePath?: string) => ipcRenderer.invoke('pilot:system-info', workspacePath),
  resourceUsage: (workspacePath?: string) =>
    ipcRenderer.invoke('pilot:resource-usage', workspacePath),
  recentLogs: (limit?: number) => ipcRenderer.invoke('pilot:logs-recent', limit),
  logDir: () => ipcRenderer.invoke('pilot:logs-dir'),
  openLogs: () => ipcRenderer.invoke('pilot:logs-open'),
  reportRendererError: (input: { summary: string; stack?: string; source?: string }) =>
    ipcRenderer.invoke('pilot:renderer-error', input),
  selfCheck: () => ipcRenderer.invoke('pilot:self-check-run'),
  qualityEvaluate: (path: string) => ipcRenderer.invoke('pilot:quality-evaluate', path),
  qualityDecide: (path: string, candidateId: string, decision: 'approve' | 'reject') =>
    ipcRenderer.invoke('pilot:quality-decide', path, candidateId, decision),
  qualityPublish: (path: string, candidateId: string) =>
    ipcRenderer.invoke('pilot:quality-publish', path, candidateId),
  qualityTune: (path: string) => ipcRenderer.invoke('pilot:quality-tune', path),
  listCheckpoints: (sessionId: string) =>
    ipcRenderer.invoke('pilot:checkpoints-list', sessionId),
  createCheckpoint: (sessionId: string, label?: string) =>
    ipcRenderer.invoke('pilot:checkpoint-create', sessionId, label),
  restoreCheckpoint: (
    sessionId: string,
    checkpointId: string,
    mode: CheckpointRestoreMode,
  ) => ipcRenderer.invoke('pilot:checkpoint-restore', sessionId, checkpointId, mode),

  quickCommands: () => ipcRenderer.invoke('pilot:quick-commands-list'),
  saveQuickCommands: (items) => ipcRenderer.invoke('pilot:quick-commands-save', items),

  listScheduledTasks: (sessionId: string) =>
    ipcRenderer.invoke('pilot:scheduled-list', sessionId),
  addScheduledTask: (sessionId: string, input) =>
    ipcRenderer.invoke('pilot:scheduled-add', sessionId, input),
  updateScheduledTask: (sessionId: string, taskId: string, input) =>
    ipcRenderer.invoke('pilot:scheduled-update', sessionId, taskId, input),
  removeScheduledTask: (sessionId: string, taskId: string) =>
    ipcRenderer.invoke('pilot:scheduled-remove', sessionId, taskId),
  convertTodoToSchedule: (sessionId: string, todoId: string, input) =>
    ipcRenderer.invoke('pilot:todo-to-schedule', sessionId, todoId, input),
  convertScheduledTaskToTodo: (sessionId: string, taskId: string) =>
    ipcRenderer.invoke('pilot:scheduled-to-todo', sessionId, taskId),

  listTodos: (sessionId: string) => ipcRenderer.invoke('pilot:todos-list', sessionId),
  addTodo: (sessionId: string, text: string, clientId?: string) =>
    ipcRenderer.invoke('pilot:todo-add', sessionId, text, clientId),
  updateTodo: (sessionId: string, todoId: string, text: string) =>
    ipcRenderer.invoke('pilot:todo-update', sessionId, todoId, text),
  removeTodo: (sessionId: string, todoId: string) =>
    ipcRenderer.invoke('pilot:todo-remove', sessionId, todoId),
  clearSentTodos: (sessionId: string) =>
    ipcRenderer.invoke('pilot:todos-clear-sent', sessionId),
  sendTodo: (sessionId: string, todoId: string) =>
    ipcRenderer.invoke('pilot:todo-send', sessionId, todoId),
  sendAllTodos: (sessionId: string) => ipcRenderer.invoke('pilot:todos-send-all', sessionId),

  getWorkspaceDetail: (path: string) => ipcRenderer.invoke('pilot:workspace-detail', path),
  addMemory: (path: string, content: string) => ipcRenderer.invoke('pilot:memory-add', path, content),
  deleteMemory: (path: string, memoryId: string) =>
    ipcRenderer.invoke('pilot:memory-delete', path, memoryId),
  setFeedback: (sessionId: string, runId: string, rating: 'up' | 'down', note?: string) =>
    ipcRenderer.invoke('pilot:feedback-set', sessionId, runId, rating, note),
  reflectRun: (sessionId: string, runId: string) =>
    ipcRenderer.invoke('pilot:run-reflect', sessionId, runId),

  proposeEvolution: (path: string) => ipcRenderer.invoke('pilot:evolution-propose', path),
  runSystemEvolution: (path: string) =>
    ipcRenderer.invoke('pilot:evolution-run-cycle', path),
  improveEvolutionFlow: () => ipcRenderer.invoke('pilot:evolution-improve-policy'),
  rollbackEvolutionPolicy: () => ipcRenderer.invoke('pilot:evolution-policy-rollback'),
  reviewProfile: (path: string, profileId: string) =>
    ipcRenderer.invoke('pilot:profile-review', path, profileId),
  benchmarkProfile: (path: string, profileId: string) =>
    ipcRenderer.invoke('pilot:profile-benchmark', path, profileId),
  activateProfile: (path: string, profileId: string, force?: boolean) =>
    ipcRenderer.invoke('pilot:profile-activate', path, profileId, force),
  rollbackProfile: (path: string) => ipcRenderer.invoke('pilot:profile-rollback', path),
  deleteProfile: (path: string, profileId: string) =>
    ipcRenderer.invoke('pilot:profile-delete', path, profileId),

  promoteProfile: (path: string, profileId: string) =>
    ipcRenderer.invoke('pilot:evolution-promote-global', path, profileId),
  localizeProfile: (scope: 'workspace' | 'global', path: string, profileId: string) =>
    ipcRenderer.invoke('pilot:profile-localize', scope, path, profileId),
  explainProfile: (scope: 'workspace' | 'global', path: string, profileId: string) =>
    ipcRenderer.invoke('pilot:profile-explain', scope, path, profileId),
  benchmarkGlobalProfile: (profileId: string) =>
    ipcRenderer.invoke('pilot:global-profile-benchmark', profileId),
  reviewGlobalProfile: (profileId: string) =>
    ipcRenderer.invoke('pilot:global-profile-review', profileId),
  activateGlobalProfile: (profileId: string, force?: boolean) =>
    ipcRenderer.invoke('pilot:global-profile-activate', profileId, force),
  rollbackGlobalProfile: () => ipcRenderer.invoke('pilot:global-profile-rollback'),
  deleteGlobalProfile: (profileId: string) =>
    ipcRenderer.invoke('pilot:global-profile-delete', profileId),
  openGlobalInstructions: () => ipcRenderer.invoke('pilot:global-instructions-open'),

  listTools: (path: string) => ipcRenderer.invoke('pilot:tools-list', path),
  setToolEnabled: (path: string, source, name: string, enabled: boolean) =>
    ipcRenderer.invoke('pilot:tool-enabled', path, source, name, enabled),
  removeTool: (path: string, source, name: string) =>
    ipcRenderer.invoke('pilot:tool-remove', path, source, name),
  promoteTool: (path: string, name: string) =>
    ipcRenderer.invoke('pilot:tool-promote', path, name),

  plugins: {
    overview: (workspace: string) => ipcRenderer.invoke('pilot:plugins-overview', workspace),
    create: (input) => ipcRenderer.invoke('pilot:plugin-create', input),
    install: (workspace: string, input) =>
      ipcRenderer.invoke('pilot:plugin-install', workspace, input),
    installMarket: (workspace: string, id: string) =>
      ipcRenderer.invoke('pilot:plugin-install-market', workspace, id),
    remove: (workspace: string, id: string) => ipcRenderer.invoke('pilot:plugin-remove', workspace, id),
    setEnabled: (workspace: string, id: string, enabled: boolean) =>
      ipcRenderer.invoke('pilot:plugin-enabled', workspace, id, enabled),
    sign: (workspace: string, id: string) => ipcRenderer.invoke('pilot:plugin-sign', workspace, id),
    trust: (workspace: string, publicKey: string, label?: string) =>
      ipcRenderer.invoke('pilot:plugin-trust', workspace, publicKey, label),
    untrust: (workspace: string, keyId: string) =>
      ipcRenderer.invoke('pilot:plugin-untrust', workspace, keyId),
    setPolicy: (workspace: string, policy) =>
      ipcRenderer.invoke('pilot:plugin-policy', workspace, policy),
    pickDir: (title?: string) => ipcRenderer.invoke('pilot:plugin-pick-dir', title),
    reveal: (dir: string) => ipcRenderer.invoke('pilot:plugin-reveal', dir),
  },

  listFiles: (path: string, directory: string) =>
    ipcRenderer.invoke('pilot:files-list', path, directory),
  previewFile: (path: string, file: string) => ipcRenderer.invoke('pilot:file-preview', path, file),
  revealFile: (path: string, file: string) => ipcRenderer.invoke('pilot:file-reveal', path, file),
  openDocument: (workspace: string, file: string) =>
    ipcRenderer.invoke('pilot:doc-open', workspace, file),
  documentState: () => ipcRenderer.invoke('pilot:doc-state'),
  closeDocument: () => ipcRenderer.invoke('pilot:doc-close'),
  openLink: (url: string, external?: boolean) => ipcRenderer.invoke('pilot:open-link', url, external),

  updates: {
    state: () => ipcRenderer.invoke('pilot:update-state'),
    check: () => ipcRenderer.invoke('pilot:update-check'),
    download: () => ipcRenderer.invoke('pilot:update-download'),
    install: () => ipcRenderer.invoke('pilot:update-install'),
    onState: (listener: (state: UpdateState) => void) => {
      const handler = (_event: unknown, state: UpdateState): void => listener(state)
      ipcRenderer.on('pilot:update-state', handler)
      return () => {
        ipcRenderer.removeListener('pilot:update-state', handler)
      }
    },
  },

  onEvent: (listener: (event: RunEvent) => void) => {
    const handler = (_event: unknown, event: RunEvent): void => listener(event)
    ipcRenderer.on('pilot:event', handler)
    return () => {
      ipcRenderer.removeListener('pilot:event', handler)
    }
  },

  onFocusSession: (listener: (sessionId: string) => void) => {
    const handler = (_event: unknown, sessionId: string): void => listener(sessionId)
    ipcRenderer.on('pilot:focus-session', handler)
    return () => {
      ipcRenderer.removeListener('pilot:focus-session', handler)
    }
  },
  onFocusQuality: (listener: (workspacePath: string) => void) => {
    const handler = (_event: unknown, workspacePath: string): void => listener(workspacePath)
    ipcRenderer.on('pilot:focus-quality', handler)
    return () => {
      ipcRenderer.removeListener('pilot:focus-quality', handler)
    }
  },
}

contextBridge.exposeInMainWorld('pilot', bridge)
