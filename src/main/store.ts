import { app, safeStorage } from 'electron'
import { realpath, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { normalizeModelTag } from '../shared/model-label'
import type { BillingAccount } from './billing'
import { resolveLocale, AppLocale } from '../shared/i18n'
import type { ApprovalMode, EvolutionCycle, EvolutionPolicy, EvolutionPolicyVersion, EvolutionState, JudgeProvider, JudgeProviderInput, MemoryCategory, MemoryEntry, ModelResource, ModelResourceInput, ModelSettingsView, MessageSearchFilter, MessageSearchHit, ProfileEvidence, ProfileExplanation, ProfileReview, ProfileStrategy, ProfileVersion, QualityCandidate, QualityState, QuickCommand, QuickCommandInput, ReviewReport, ReviewScope, RunFeedback, RunRecord, ScheduleKind, ScheduledTask, ScheduledTaskGroup, ScheduledTaskInput, Session, SessionKind, SessionSummary, SettingsUpdate, SettingsView, StoredMessage, TodoGroup, TodoItem, TodoPriority, WorkspaceDetail, WorkspaceSummary } from '../shared/types'
import { normalizeTodoPriority } from '../shared/todos'
import { evolutionPolicyKey } from '../shared/evolution'
import { sanitizeCandidate, sanitizeQualityState } from '../shared/quality'
import { pruneProfiles } from '../core/profile-archive'
import { MEMORY_ENTRY_MAX_CHARS, MEMORY_STORE_LIMIT, inferMemoryCategory } from '../shared/memory'
import { shellInterpreterStatus } from './shell'
import { localizeMain, localizeSessionTitle } from './localize'
import { applySettingsUpdate } from './settings-update'
import { searchSessionMessages } from './search'
import { SHARD_VERSION, SessionStorage, emptySearchIndex, indexEntryFor, searchRecordsFor, searchRecordsForMessages, sessionFromSearchRecords, SearchIndexFile, SessionIndexEntry } from './session-store'

import {
  JudgeTarget,
  PersistedModelResource,
  PersistedSettings,
  PersistedWorkspace,
  PersistedState,
  STATE_VERSION,
  MAX_QUICK_COMMANDS,
  MAX_QUICK_COMMAND_CHARS,
  MAX_PHONE_ROOTS,
  MAX_WORKSPACES,
  SECRET_PATTERN,
  WEAKEN_PATTERN,
  now,
  defaults,
  normalizeText,
  normalizeOptionalText,
  isWithin,
  clampNumber,
  SECRET_LIKE_COMMAND,
  sanitizeCommandList,
  sanitizeEvolutionPolicy,
  sanitizeEvolutionCycle,
  sanitizeReviewScope,
  sanitizeReviewReport,
  sanitizeSession,
  cleanTimeOfDay,
  nextDailyRun,
  MAX_JUDGE_PROVIDERS,
  MAX_MODEL_RESOURCES,
  MAX_EVALUATION_MODELS,
  validateJudgeProviders,
  validateModelResources,
  resourceId,
  normalizeProviderBaseUrl,
  sanitize,
  validApprovalMode,
  BODY_KEYS,
  CONTEXT_SUMMARY_MAX_CHARS,
  SEARCH_INDEX_MIN_INTERVAL_MS,
  SessionBodyRef,
} from './store-schema'

// 公开 API 仍在 store.ts 导出：调用方不需要知道内部怎么分层。
// 类型必须用 `export type`：打包器（rolldown）会按运行时导出解析，漏了就直接报
// MISSING_EXPORT，而 tsc 因为类型擦除发现不了。
export type { JudgeTarget } from './store-schema'
export {
  MAX_QUICK_COMMANDS,
  MAX_QUICK_COMMAND_CHARS,
  MAX_PHONE_ROOTS,
  MAX_TEST_TARGETS,
  normalizeTestTarget,
  normalizeApprovalMode,
  sanitizeReviewScope,
  sanitizeReviewReport,
  MAX_MODEL_RESOURCES,
  MAX_EVALUATION_MODELS,
} from './store-schema'

export class Store {
  private state: PersistedState = defaults()
  private loaded = false
  private saving: Promise<void> = Promise.resolve()
  private dirty = false
  private storageRef: SessionStorage | null = null
  /** Which sessions already have their transcript in memory (and may be dirty). */
  private readonly bodies = new WeakMap<Session, SessionBodyRef>()
  /** Session ids known to have a shard on disk. */
  private readonly shards = new Set<string>()
  private searchIndex: SearchIndexFile = emptySearchIndex()
  private searchIndexDirty = false
  private searchIndexWrittenAt = 0
  private readonly running = new Set<string>()
  private readonly runInfo = new Map<
    string,
    { runId: string; instruction: string; startedAt: string }
  >()

  async load(): Promise<void> {
    if (this.loaded) return
    await this.readFromDisk()
    this.loaded = true
    for (const workspace of this.state.workspaces) {
      for (const profile of workspace.profiles) {
        if (profile.status === 'active') {
          const activeCount = workspace.profiles.filter((item) => item.status === 'active').length
          if (activeCount > 1 && profile !== workspace.profiles.find((item) => item.status === 'active')) {
            profile.status = 'retired'
          }
        }
      }
    }
    // The global profile is a single active version too; repair a hand-edited
    // or crashed store that somehow contains more than one.
    const activeGlobalCount = this.state.globalProfiles.filter(
      (profile) => profile.status === 'active',
    ).length
    if (activeGlobalCount > 1) {
      const firstActive = this.state.globalProfiles.find((profile) => profile.status === 'active')
      for (const profile of this.state.globalProfiles) {
        if (profile.status === 'active' && profile !== firstActive) profile.status = 'retired'
      }
    }
    // Keep the live policy in sync with the active meta-evolution version.
    const activePolicyVersion = this.state.evolutionPolicyVersions.find(
      (version) => version.status === 'active',
    )
    if (activePolicyVersion) {
      this.state.evolutionPolicy = {
        ...activePolicyVersion.policy,
        ...(this.state.evolutionPolicy.updatedAt
          ? { updatedAt: this.state.evolutionPolicy.updatedAt }
          : {}),
      }
    }
    for (const version of this.state.evolutionPolicyVersions) {
      if (version.status === 'active' && version !== activePolicyVersion) version.status = 'retired'
    }
    if (
      !this.state.activeWorkspace ||
      !this.state.workspaces.some((workspace) => workspace.path === this.state.activeWorkspace)
    ) {
      this.state.activeWorkspace = this.state.workspaces[0]?.path ?? null
    }
    const activeSession = this.state.activeSession
      ? this.state.sessions.find((session) => session.id === this.state.activeSession)
      : null
    if (
      !activeSession ||
      (this.state.activeWorkspace && activeSession.workspacePath !== this.state.activeWorkspace)
    ) {
      this.state.activeSession =
        this.sessions(this.state.activeWorkspace ?? '')[0]?.id ?? null
    }
    await this.save()
  }

  private storage(): SessionStorage {
    if (!this.storageRef) this.storageRef = new SessionStorage(app.getPath('userData'))
    return this.storageRef
  }

  /**
   * Startup reads the small core file plus the summary index; transcripts stay
   * on disk until something actually reads `session.messages`.
   */
  private async readFromDisk(): Promise<void> {
    const storage = this.storage()
    const [core, index, derived] = await Promise.all([
      storage.readCore(),
      storage.readIndex(),
      storage.readSearchIndex(),
    ])
    if (derived && derived.version === SHARD_VERSION) this.searchIndex = derived
    if (core) {
      const sessions: Session[] = []
      const known = new Set<string>()
      for (const raw of index && index.version === SHARD_VERSION ? index.sessions : []) {
        const entry = sanitizeSession(raw)
        if (!entry || known.has(entry.id)) continue
        this.backfillInstructionCount(entry)
        known.add(entry.id)
        sessions.push(this.lazySession(entry))
        this.shards.add(entry.id)
      }
      // A crash between the shard and the index write leaves shards the index
      // does not know about; recover them instead of silently losing sessions.
      for (const raw of await storage.readOrphanShards(known)) {
        const entry = sanitizeSession(raw)
        if (!entry || known.has(entry.id)) continue
        this.backfillInstructionCount(entry)
        known.add(entry.id)
        sessions.push(this.lazySession(entry))
        this.shards.add(entry.id)
      }
      this.applyRecord(core, sessions)
      return
    }
    const legacy = await storage.readLegacy()
    if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) {
      this.applyRecord(legacy as Record<string, unknown>)
      await this.migrateLegacy()
      return
    }
    this.state = defaults()
  }

  private applyRecord(record: Record<string, unknown>, sessions?: Session[]): void {
    const state = sanitize(record, sessions)
    const previousVersion = Number(record['version'])
    if ((Number.isFinite(previousVersion) ? previousVersion : 1) < STATE_VERSION) {
      // v2 switches Shell mode on by default. Flip the old default once;
      // users can still turn it off afterwards without being overridden.
      state.settings.shellMode = true
    }
    this.state = state
  }

  /** Wrap a summary entry so its transcript is read from the shard on demand. */
  private lazySession(entry: Session): Session {
    const ref: SessionBodyRef = { loaded: false }
    this.bodies.set(entry, ref)
    let body: Pick<Session, (typeof BODY_KEYS)[number]> | null = null
    const hydrate = (): Pick<Session, (typeof BODY_KEYS)[number]> => {
      if (body) return body
      body = { messages: [], queue: [], todos: [] }
      ref.loaded = true
      try {
        const parsed = sanitizeSession(this.storage().readSessionSync(entry.id))
        if (parsed) {
          body = {
            messages: parsed.messages,
            queue: parsed.queue,
            todos: parsed.todos,
            ...(parsed.memoryIds ? { memoryIds: parsed.memoryIds } : {}),
          }
          ref.messagesOnDisk = parsed.messages.length
          // Old shards kept the transcript inline; the next save migrates it.
          ref.legacyMessages = !this.storage().hasMessagesFile(entry.id)
        }
      } catch {
        // Missing or unreadable shard: keep the summary, start the body empty,
        // but leave the file alone on save so a transient read error is not
        // promoted into data loss.
        ref.broken = true
      }
      return body
    }
    for (const key of BODY_KEYS) {
      Object.defineProperty(entry, key, {
        enumerable: true,
        configurable: true,
        get: () => hydrate()[key],
        set: (value: Session[typeof key]) => {
          ;(hydrate() as unknown as Record<string, unknown>)[key] = value
        },
      })
    }
    return entry
  }

  /** Mark a session created in this process as having its body in memory. */
  private track(session: Session): Session {
    this.bodies.set(session, { loaded: true, messagesOnDisk: 0, legacyMessages: false })
    return session
  }

  /** One-shot migration from the legacy single file to the sharded layout. */
  private async migrateLegacy(): Promise<void> {
    for (const session of this.state.sessions) this.track(session)
    this.loaded = true
    await this.writeSnapshot()
    await this.storage().archiveLegacy()
  }

  /**
   * Counts for the sidebar. A session whose transcript was never read uses the
   * numbers recorded in the index, so listing sessions does not load shards.
   */
  private counts(session: Session): {
    messageCount: number
    instructionCount?: number
    queueCount: number
    todoCount: number
  } {
    const ref = this.bodies.get(session)
    if (!ref?.loaded || ref.broken) {
      return {
        messageCount: session.messageCount,
        // Unknown for summaries written before the field existed: omit it so
        // the phone can hide the value instead of rendering a false zero.
        ...(typeof session.instructionCount === 'number'
          ? { instructionCount: session.instructionCount }
          : {}),
        queueCount: session.queueCount,
        todoCount: session.todoCount,
      }
    }
    let instructionCount = 0
    for (const message of session.messages) {
      // Continuation markers are stored as user messages but are not things the
      // user typed; counting them would overstate the session's work.
      if (message.role === 'user' && !message.control) instructionCount += 1
    }
    return {
      messageCount: session.messages.length,
      instructionCount,
      queueCount: session.queue.length,
      todoCount: session.todos.filter((todo) => todo.status === 'pending').length,
    }
  }

  /**
   * Index files written before `instructionCount` existed have no value for it.
   * The derived search cache already holds every searchable user message (and
   * excludes continuation prompts), so backfill from it without reading any
   * transcript. Sessions missing from the cache stay unknown until loaded.
   */
  private backfillInstructionCount(entry: Session): void {
    if (typeof entry.instructionCount === 'number') return
    const cached = this.searchIndex.sessions[entry.id]
    if (!cached || !Array.isArray(cached.messages)) return
    entry.instructionCount = cached.messages.filter((message) => message.role === 'user').length
  }

  private indexEntry(session: Session): SessionIndexEntry {
    return indexEntryFor(session, this.counts(session))
  }

  /**
   * Persist transcript changes incrementally: appends touch only the new
   * messages, while edits, truncation and version-1 migration rewrite the
   * whole JSONL file once.
   */
  private async persistSessionMessages(
    storage: SessionStorage,
    session: Session,
    ref: SessionBodyRef,
  ): Promise<{ kind: 'append' | 'rewrite'; from: number } | null> {
    const count = session.messages.length
    const onDisk = ref.messagesOnDisk ?? 0
    if (ref.legacyMessages || ref.rewriteMessages || count < onDisk) {
      await storage.writeSessionMessages(session.id, session.messages)
      ref.messagesOnDisk = count
      ref.legacyMessages = false
      ref.rewriteMessages = false
      return { kind: 'rewrite', from: 0 }
    }
    if (count > onDisk) {
      await storage.appendSessionMessages(session.id, session.messages.slice(onDisk))
      ref.messagesOnDisk = count
      return { kind: 'append', from: onDisk }
    }
    return null
  }

  /** Flag an in-place history change so the next save rewrites the transcript. */
  private markMessagesRewrite(session: Session): void {
    const ref = this.bodies.get(session)
    if (ref) ref.rewriteMessages = true
  }

  /**
   * Persists the core file and the summary index on every save, but only the
   * shards whose transcript is in memory: an edit now costs one small write
   * instead of rewriting every session in the store.
   */
  private async writeSnapshot(): Promise<void> {
    const storage = this.storage()
    const live = new Set(this.state.sessions.map((session) => session.id))
    for (const session of this.state.sessions) {
      const ref = this.bodies.get(session)
      if (!ref?.loaded || ref.broken) continue
      const change = await this.persistSessionMessages(storage, session, ref)
      await storage.writeSessionShard(session)
      this.shards.add(session.id)
      if (change?.kind === 'append') {
        const existing = this.searchIndex.sessions[session.id]
        if (existing) {
          existing.messages.push(
            ...searchRecordsForMessages(session.messages.slice(change.from)),
          )
          existing.updatedAt = session.updatedAt
        } else {
          this.searchIndex.sessions[session.id] = {
            updatedAt: session.updatedAt,
            messages: searchRecordsFor(session),
          }
        }
        this.searchIndexDirty = true
      } else if (change?.kind === 'rewrite') {
        this.searchIndex.sessions[session.id] = {
          updatedAt: session.updatedAt,
          messages: searchRecordsFor(session),
        }
        this.searchIndexDirty = true
      }
    }
    for (const id of [...this.shards]) {
      if (live.has(id)) continue
      this.shards.delete(id)
      await storage.deleteSessionShard(id)
      delete this.searchIndex.sessions[id]
      this.searchIndexDirty = true
    }
    await storage.writeIndex({
      version: SHARD_VERSION,
      updatedAt: now(),
      sessions: this.state.sessions.map((session) => this.indexEntry(session)),
    })
    await storage.writeCore({
      version: STATE_VERSION,
      settings: this.state.settings,
      workspaces: this.state.workspaces,
      globalProfiles: this.state.globalProfiles,
      evolutionPolicy: this.state.evolutionPolicy,
      evolutionPolicyVersions: this.state.evolutionPolicyVersions,
      evolutionCycles: this.state.evolutionCycles,
      quality: this.state.quality,
      scheduled: this.state.scheduled,
      quickCommands: this.state.quickCommands,
      activeWorkspace: this.state.activeWorkspace,
      activeSession: this.state.activeSession,
    })
    await this.writeSearchIndex()
  }

  /** The search cache is one big file, so defer its rewrite outside a burst of saves. */
  private async writeSearchIndex(force = false): Promise<void> {
    if (!this.searchIndexDirty) return
    if (!force && Date.now() - this.searchIndexWrittenAt < SEARCH_INDEX_MIN_INTERVAL_MS) return
    this.searchIndexDirty = false
    this.searchIndexWrittenAt = Date.now()
    this.searchIndex.builtAt = now()
    await this.storage().writeSearchIndex(this.searchIndex)
  }

  /** Flush everything pending; call before the app quits. */
  async flush(): Promise<void> {
    await this.saving
    await this.writeSearchIndex(true)
  }

  async save(): Promise<void> {
    if (!this.loaded) return
    this.dirty = true
    this.saving = this.saving
      .catch(() => undefined)
      .then(async () => {
        // Saves issued while a write is in flight collapse into that write (or
        // the next one), so a burst of edits becomes at most two disk writes.
        if (!this.dirty) return
        this.dirty = false
        try {
          await this.writeSnapshot()
        } catch (error) {
          this.dirty = true
          throw error
        }
      })
    await this.saving
  }

  private workspaceRecord(path: string): PersistedWorkspace | undefined {
    return this.state.workspaces.find((workspace) => workspace.path === path)
  }

  private keyOf(holder: { keyCipher: string | null; keyPlain: boolean }): string | null {
    if (!holder.keyCipher) return null
    try {
      const buffer = Buffer.from(holder.keyCipher, 'base64')
      return holder.keyPlain ? buffer.toString('utf8') : safeStorage.decryptString(buffer)
    } catch {
      return null
    }
  }

  private setKeyOf(holder: { keyCipher: string | null; keyPlain: boolean }, key: string | null): void {
    if (!key) {
      holder.keyCipher = null
      holder.keyPlain = false
      return
    }
    if (safeStorage.isEncryptionAvailable()) {
      holder.keyCipher = safeStorage.encryptString(key).toString('base64')
      holder.keyPlain = false
    } else {
      holder.keyCipher = Buffer.from(key, 'utf8').toString('base64')
      holder.keyPlain = true
    }
  }

  /**
   * The selected session resource. A task may pin its own model; otherwise the
   * global session model applies.
   */
  private sessionResource(sessionId?: string): PersistedModelResource | null {
    const settings = this.state.settings
    // 任务级模型最具体：同一个工作区里不同任务可以跑在不同端点上。
    if (sessionId) {
      const session = this.state.sessions.find((entry) => entry.id === sessionId)
      const pinned = session?.sessionModelId ? this.resourceById(session.sessionModelId) : null
      if (pinned) return pinned
    }
    return (
      settings.modelResources.find((resource) => resource.id === settings.sessionModelId) ??
      settings.modelResources[0] ??
      null
    )
  }

  /**
   * 给单个任务指定会话模型（空串清除，回到全局设置）。
   * 只影响下一次请求；任务运行中切换也不会改掉当前这一轮。
   */
  async setSessionModel(sessionId: string, modelId: string): Promise<SessionSummary> {
    const session = this.state.sessions.find((entry) => entry.id === sessionId)
    if (!session) throw new Error('Session not found')
    const next = typeof modelId === 'string' ? modelId.trim() : ''
    if (next && !this.resourceById(next)) throw new Error('指定的模型不存在')
    session.sessionModelId = next
    session.updatedAt = now()
    await this.save()
    return this.summary(session)
  }

  private resourceById(id: string): PersistedModelResource | null {
    return this.state.settings.modelResources.find((resource) => resource.id === id) ?? null
  }

  getApiKey(): string | null {
    const resource = this.sessionResource()
    if (resource) return this.keyOf(resource)
    const { apiKeyCipher, apiKeyPlain } = this.state.settings
    if (!apiKeyCipher) return null
    try {
      const buffer = Buffer.from(apiKeyCipher, 'base64')
      if (apiKeyPlain) return buffer.toString('utf8')
      return safeStorage.decryptString(buffer)
    } catch {
      return null
    }
  }

  /** Update the session resource's key; the legacy mirror follows on save. */
  setApiKey(key: string | null): void {
    const resource = this.sessionResource()
    if (resource) {
      this.setKeyOf(resource, key)
      this.syncLegacyModelFields()
      return
    }
    if (!key) {
      this.state.settings.apiKeyCipher = null
      this.state.settings.apiKeyPlain = false
      return
    }
    const holder = { keyCipher: null as string | null, keyPlain: false }
    this.setKeyOf(holder, key)
    this.state.settings.apiKeyCipher = holder.keyCipher
    this.state.settings.apiKeyPlain = holder.keyPlain
  }

  /** Mirror the selected session/evaluation resources into legacy fields. */
  private syncLegacyModelFields(): void {
    const settings = this.state.settings
    const session = this.sessionResource()
    if (session) {
      settings.baseUrl = session.baseUrl
      settings.model = session.model
      // The classifier shares the session endpoint, so it must follow its model.
      settings.classifierModel = session.model
      settings.apiKeyCipher = session.keyCipher
      settings.apiKeyPlain = session.keyPlain
    }
    const evaluation = settings.evaluationModelIds
      .map((id) => this.resourceById(id))
      .filter((resource): resource is PersistedModelResource => Boolean(resource))
    settings.judgeProviders = evaluation.map((resource) => ({
      id: resource.id,
      label: resource.label,
      baseUrl: resource.baseUrl,
      model: resource.model,
      enabled: resource.enabled,
      keyCipher: resource.keyCipher,
      keyPlain: resource.keyPlain,
    }))
    // Keep the legacy mirror honest: clearing the selection must not let an
    // older build (or the next migration pass) resurrect the previous model.
    settings.reviewModel = settings.reviewModelId
      ? (this.resourceById(settings.reviewModelId)?.model ?? '')
      : ''
  }

  /** Public resource list with key hints only. */
  modelResources(): ModelResource[] {
    return this.state.settings.modelResources.map((resource) => {
      const key = this.keyOf(resource)
      return {
        id: resource.id,
        label: resource.label,
        baseUrl: resource.baseUrl,
        model: resource.model,
        tag: resource.tag,
        enabled: resource.enabled,
        hasKey: Boolean(key),
        keyHint: key ? `••••${key.slice(-4)}` : '',
      }
    })
  }

  /** Session, evaluation and review selections for renderer and phone. */
  modelSettingsView(): ModelSettingsView {
    return {
      resources: this.modelResources(),
      sessionModelId: this.state.settings.sessionModelId,
      evaluationModelIds: [...this.state.settings.evaluationModelIds],
      reviewModelId: this.state.settings.reviewModelId,
    }
  }

  private targetOf(resource: PersistedModelResource): JudgeTarget | null {
    const apiKey = this.keyOf(resource)
    if (!apiKey) return null
    return {
      id: resource.id,
      label: resource.label,
      baseUrl: resource.baseUrl,
      model: resource.model,
      apiKey,
    }
  }

  /** Resource used by ordinary sessions; null when it has no usable key. */
  sessionModelTarget(sessionId?: string): JudgeTarget | null {
    const resource = this.sessionResource(sessionId)
    return resource ? this.targetOf(resource) : null
  }

  /** Review-session resource; falls back to the session resource. */
  reviewModelTarget(): JudgeTarget | null {
    const review = this.state.settings.reviewModelId
      ? this.resourceById(this.state.settings.reviewModelId)
      : null
    return review ? this.targetOf(review) : this.sessionModelTarget()
  }

  /** Evaluation resources with keys replaced by hints, safe for the renderer. */
  judgeProviders(): JudgeProvider[] {
    const resources = this.modelResources()
    return this.state.settings.evaluationModelIds
      .map((id) => resources.find((resource) => resource.id === id))
      .filter((resource): resource is ModelResource => Boolean(resource))
  }

  /** One model resource with its decrypted key, for testing or reviewing. */
  judgeTarget(id: string): JudgeTarget | null {
    const resource = this.resourceById(id)
    return resource ? this.targetOf(resource) : null
  }

  /**
   * Every configured model endpoint whose provider balance can be queried:
   * the execution model first, then saved reviewers (disabled ones included,
   * marked so the caller can grey them out).
   */
  billingAccounts(): BillingAccount[] {
    const settings = this.state.settings
    // Session resource first so the compact balance card stays on the model
    // that ordinary runs actually use.
    const ordered = [
      ...settings.modelResources.filter((resource) => resource.id === settings.sessionModelId),
      ...settings.modelResources.filter((resource) => resource.id !== settings.sessionModelId),
    ]
    return ordered.map((resource) => ({
      id: resource.id,
      label: resource.label || resource.model,
      role: resource.id === settings.sessionModelId ? ('primary' as const) : ('judge' as const),
      baseUrl: resource.baseUrl,
      model: resource.model,
      enabled: resource.enabled,
      apiKey: this.keyOf(resource) ?? '',
    }))
  }

  /** Enabled evaluation resources that can actually authenticate, in order. */
  judgeTargets(): JudgeTarget[] {
    return this.evaluationTargets()
  }

  evaluationTargets(): JudgeTarget[] {
    return this.state.settings.evaluationModelIds
      .map((id) => this.resourceById(id))
      .filter((resource): resource is PersistedModelResource =>
        Boolean(resource && resource.enabled),
      )
      .map((resource) => this.targetOf(resource))
      .filter((target): target is JudgeTarget => Boolean(target))
  }

  /**
   * Replace the resource list. Existing ids keep their stored key unless the
   * payload explicitly clears it; new ids start without one.
   */
  private applyModelResources(input: ModelResourceInput[]): void {
    const seen = new Set<string>()
    const next: PersistedModelResource[] = []
    for (const entry of input) {
      if (next.length >= MAX_MODEL_RESOURCES) break
      if (!entry || typeof entry !== 'object') continue
      const baseUrl = normalizeProviderBaseUrl(entry.baseUrl)
      const model = normalizeOptionalText(entry.model, 200)
      if (!baseUrl || !model) continue
      const existing = entry.id ? this.resourceById(entry.id) : undefined
      const resource: PersistedModelResource = existing
        ? { ...existing, baseUrl, model, enabled: entry.enabled !== false }
        : {
            id: resourceId(entry.id, seen),
            label: model,
            baseUrl,
            model,
            tag: normalizeModelTag(entry.tag),
            enabled: entry.enabled !== false,
            keyCipher: null,
            keyPlain: false,
          }
      // An empty name falls back to the model instead of resurrecting an old label.
      resource.label = normalizeOptionalText(entry.label, 40) || model
      // Tag is display-only and capped at four characters; over-long input is
      // truncated rather than rejected so a paste never loses the whole save.
      resource.tag = normalizeModelTag(entry.tag)
      // An empty string keeps the stored key; null clears it.
      if (entry.apiKey === null) this.setKeyOf(resource, null)
      else if (typeof entry.apiKey === 'string' && entry.apiKey.trim()) {
        this.setKeyOf(resource, entry.apiKey.trim())
      }
      if (seen.has(resource.id)) continue
      seen.add(resource.id)
      next.push(resource)
    }
    if (next.length === 0) throw new Error('至少保留一个模型资源。')
    this.state.settings.modelResources = next
    this.normalizeModelSelection()
  }

  /** Point session/evaluation/review roles at existing, enabled resources. */
  private normalizeModelSelection(): void {
    const settings = this.state.settings
    if (!this.resourceById(settings.sessionModelId) || !this.resourceById(settings.sessionModelId)!.enabled) {
      settings.sessionModelId =
        settings.modelResources.find((resource) => resource.enabled)?.id ??
        settings.modelResources[0]!.id
    }
    const evaluation: string[] = []
    for (const id of settings.evaluationModelIds) {
      if (evaluation.includes(id)) continue
      if (!this.resourceById(id)) continue
      evaluation.push(id)
      if (evaluation.length >= MAX_EVALUATION_MODELS) break
    }
    settings.evaluationModelIds = evaluation
    const review = settings.reviewModelId
      ? this.resourceById(settings.reviewModelId)
      : null
    if (settings.reviewModelId && (!review || !review.enabled)) {
      settings.reviewModelId = ''
    }
    this.syncLegacyModelFields()
  }

  /** Apply explicit role selections after validating every referenced id. */
  private applyModelSelection(input: SettingsUpdate): void {
    const settings = this.state.settings
    if (input.sessionModelId !== undefined) {
      const id = typeof input.sessionModelId === 'string' ? input.sessionModelId.trim() : ''
      const resource = this.resourceById(id)
      if (!resource) throw new Error('会话模型必须选择一个已配置的模型资源。')
      if (!resource.enabled) throw new Error('会话模型不能使用已停用的模型资源。')
      settings.sessionModelId = resource.id
    }
    if (input.evaluationModelIds !== undefined) {
      if (!Array.isArray(input.evaluationModelIds)) throw new Error('评估模型格式不正确。')
      const selected: string[] = []
      for (const raw of input.evaluationModelIds) {
        const id = typeof raw === 'string' ? raw.trim() : ''
        if (!id || selected.includes(id)) continue
        const resource = this.resourceById(id)
        if (!resource) throw new Error('评估模型必须来自已配置的模型资源。')
        selected.push(id)
        if (selected.length >= MAX_EVALUATION_MODELS) break
      }
      settings.evaluationModelIds = selected
    }
    if (input.reviewModelId !== undefined) {
      const id = typeof input.reviewModelId === 'string' ? input.reviewModelId.trim() : ''
      if (id) {
        const resource = this.resourceById(id)
        if (!resource) throw new Error('复盘模型必须选择一个已配置的模型资源。')
        if (!resource.enabled) throw new Error('复盘模型不能使用已停用的模型资源。')
      }
      settings.reviewModelId = id
    }
  }

  /** Legacy reviewer payload: upsert resources and select them as evaluators. */
  private applyJudgeProviders(input: JudgeProviderInput[]): void {
    if (!Array.isArray(input)) return
    const selected: string[] = []
    for (const entry of input) {
      if (selected.length >= MAX_JUDGE_PROVIDERS) break
      if (!entry || typeof entry !== 'object') continue
      const baseUrl = normalizeProviderBaseUrl(entry.baseUrl)
      const model = normalizeOptionalText(entry.model, 200)
      if (!baseUrl || !model) continue
      const existing = entry.id ? this.resourceById(entry.id) : undefined
      const resource: PersistedModelResource = existing
        ? { ...existing, baseUrl, model, enabled: entry.enabled !== false }
        : {
            id: resourceId(entry.id, new Set(this.state.settings.modelResources.map((item) => item.id))),
            label: model,
            baseUrl,
            model,
            tag: '',
            enabled: entry.enabled !== false,
            keyCipher: null,
            keyPlain: false,
          }
      // An empty name falls back to the model instead of resurrecting an old label.
      resource.label = normalizeOptionalText(entry.label, 40) || model
      if (entry.apiKey === null) this.setKeyOf(resource, null)
      else if (typeof entry.apiKey === 'string' && entry.apiKey.trim()) {
        this.setKeyOf(resource, entry.apiKey.trim())
      }
      if (existing) {
        const index = this.state.settings.modelResources.findIndex((item) => item.id === existing.id)
        if (index >= 0) this.state.settings.modelResources[index] = resource
      } else {
        this.state.settings.modelResources.push(resource)
      }
      if (!selected.includes(resource.id)) selected.push(resource.id)
    }
    // The old payload represented the full reviewer list.
    this.state.settings.evaluationModelIds = selected.slice(0, MAX_EVALUATION_MODELS)
    this.normalizeModelSelection()
  }

  /**
   * 测试环境验证码固定值。只用于用户自己的测试环境，随 run_tool 注入到
   * 通过 testTargets 白名单的调用，绝不写进工具代码或日志。
   */
  getTestCaptcha(): string | null {
    const { testCaptchaCipher, testCaptchaPlain } = this.state.settings
    if (!testCaptchaCipher) return null
    try {
      const buffer = Buffer.from(testCaptchaCipher, 'base64')
      if (testCaptchaPlain) return buffer.toString('utf8')
      return safeStorage.decryptString(buffer)
    } catch {
      return null
    }
  }

  setTestCaptcha(value: string | null): void {
    if (!value) {
      this.state.settings.testCaptchaCipher = null
      this.state.settings.testCaptchaPlain = false
      return
    }
    if (safeStorage.isEncryptionAvailable()) {
      this.state.settings.testCaptchaCipher = safeStorage.encryptString(value).toString('base64')
      this.state.settings.testCaptchaPlain = false
    } else {
      this.state.settings.testCaptchaCipher = Buffer.from(value, 'utf8').toString('base64')
      this.state.settings.testCaptchaPlain = true
    }
  }

  settingsView(): SettingsView {
    const key = this.getApiKey()
    return {
      baseUrl: this.state.settings.baseUrl,
      model: this.state.settings.model,
      maxSteps: this.state.settings.maxSteps,
      maxTokens: this.state.settings.maxTokens,
      maxContextTokens: this.state.settings.maxContextTokens,
      maxOutputTokens: this.state.settings.maxOutputTokens,
      temperature: this.state.settings.temperature,
      autoReflect: this.state.settings.autoReflect,
      autoEvolve: this.state.settings.autoEvolve,
      autoContinue: this.state.settings.autoContinue,
      autoContinueLimit: this.state.settings.autoContinueLimit,
      screenshotFeedback: this.state.settings.screenshotFeedback,
      testTargets: [...this.state.settings.testTargets],
      testCaptchaMode: this.state.settings.testCaptchaMode,
      hasTestCaptcha: Boolean(this.getTestCaptcha()),
      approvalTimeoutSec: this.state.settings.approvalTimeoutSec,
      shellMode: this.state.settings.shellMode,
      shellInterpreter: this.state.settings.shellInterpreter,
      shellInterpreterDetail: localizeMain(
        shellInterpreterStatus(this.state.settings.shellInterpreter).detail,
        this.uiLocale(),
      ),
      defaultApprovalMode: this.state.settings.defaultApprovalMode,
      permissionRules: {
        allow: [...this.state.settings.permissionRules.allow],
        ask: [...this.state.settings.permissionRules.ask],
        deny: [...this.state.settings.permissionRules.deny],
      },
      trustedCommands: [...this.state.settings.trustedCommands],
      classifierModel: this.state.settings.classifierModel,
      reviewModel: this.state.settings.reviewModel,
      sandboxMode: this.state.settings.sandboxMode,
      sandboxNetwork: this.state.settings.sandboxNetwork,
      sandboxAutoAllow: this.state.settings.sandboxAutoAllow,
      allowUnattendedBuild: this.state.settings.allowUnattendedBuild,
      learningMode: this.state.settings.learningMode,
      learningHosts: [...this.state.settings.learningHosts],
      learningShellIsolation: this.state.settings.learningShellIsolation,
      selfSourceMode: this.state.settings.selfSourceMode,
      selfSourceGitUrl: this.state.settings.selfSourceGitUrl,
      selfSourceGitRef: this.state.settings.selfSourceGitRef,
      selfSourceGitPath: this.state.settings.selfSourceGitPath,
      selfSourceCustomPath: this.state.settings.selfSourceCustomPath,
      qualityGate: this.state.settings.qualityGate,
      qualityPublishTarget: this.state.settings.qualityPublishTarget,
      qualityTuneEvery: this.state.settings.qualityTuneEvery,
      checkpointRetention: this.state.settings.checkpointRetention,
      checkpointMaxBytes: this.state.settings.checkpointMaxBytes,
      checkpointShell: this.state.settings.checkpointShell,
      checkpointIgnore: [...this.state.settings.checkpointIgnore],
      notifyDesktop: this.state.settings.notifyDesktop,
      hooksEnabled: this.state.settings.hooksEnabled,
      mcpEnabled: this.state.settings.mcpEnabled,
      relayUrl: this.state.settings.relayUrl,
      globalInstructionsPath: join(app.getPath('userData'), 'PILOT.md'),
      theme: this.state.settings.theme,
      fontSize: this.state.settings.fontSize,
      contrast: this.state.settings.contrast,
      saturation: this.state.settings.saturation,
      locale: this.state.settings.locale,
      systemLocale: app.getLocale(),
      hasKey: Boolean(key),
      keyHint: key ? `••••${key.slice(-4)}` : '',
      modelResources: this.modelResources(),
      sessionModelId: this.state.settings.sessionModelId,
      evaluationModelIds: [...this.state.settings.evaluationModelIds],
      reviewModelId: this.state.settings.reviewModelId,
      judgeProviders: this.judgeProviders(),
    }
  }

  settings(): PersistedSettings {
    return { ...this.state.settings }
  }

  /** Effective UI language for main-process messages, resolved against the OS. */
  uiLocale(): AppLocale {
    return resolveLocale(this.state.settings.locale, app.getLocale())
  }

  async updateSettings(input: SettingsUpdate): Promise<SettingsView> {
    // Model resources and reviewer endpoints are validated before anything is
    // mutated: a bad entry must not leave half of the settings applied.
    if (input.judgeProviders !== undefined) validateJudgeProviders(input.judgeProviders)
    if (input.modelResources !== undefined) validateModelResources(input.modelResources)
    if (input.modelResources !== undefined) this.applyModelResources(input.modelResources)
    if (input.judgeProviders !== undefined) this.applyJudgeProviders(input.judgeProviders)
    if (input.baseUrl !== undefined || input.model !== undefined) {
      const session = this.sessionResource()
      if (session) {
        if (input.baseUrl !== undefined) {
          session.baseUrl = normalizeText(input.baseUrl, session.baseUrl, 500)
        }
        if (input.model !== undefined) {
          session.model = normalizeText(input.model, session.model, 200)
        }
      }
    }
    applySettingsUpdate(this.state.settings, input, {
      setTestCaptcha: (value) => this.setTestCaptcha(value),
      setApiKey: (value) => this.setApiKey(value),
    })
    if (
      input.sessionModelId !== undefined ||
      input.evaluationModelIds !== undefined ||
      input.reviewModelId !== undefined
    ) {
      this.applyModelSelection(input)
    }
    this.normalizeModelSelection()
    await this.save()
    return this.settingsView()
  }

  /**
   * Remember one exact command line for future approval prompts. Returns false
   * when the value is invalid or already present, so callers can skip a write.
   */
  async addTrustedCommand(command: string): Promise<boolean> {
    const [value] = sanitizeCommandList([command])
    if (!value) return false
    // Never persist something that looks like a credential. The user can still
    // allow that one call; it just will not be remembered in the settings file.
    if (SECRET_LIKE_COMMAND.test(value)) return false
    const list = this.state.settings.trustedCommands
    if (list.includes(value)) return false
    list.push(value)
    if (list.length > 100) list.splice(0, list.length - 100)
    await this.save()
    return true
  }

  activeWorkspace(): string | null {
    return this.state.activeWorkspace
  }

  activeSession(): string | null {
    return this.state.activeSession
  }

  setActiveWorkspace(path: string | null): void {
    this.state.activeWorkspace = path
  }

  setActiveSession(id: string | null): void {
    this.state.activeSession = id
  }

  workspaces(): WorkspaceSummary[] {
    return this.state.workspaces
      .map((workspace) => ({
        path: workspace.path,
        name: workspace.name,
        addedAt: workspace.addedAt,
        lastOpenedAt: workspace.lastOpenedAt,
        sessionCount: this.state.sessions.filter(
          (session) => session.workspacePath === workspace.path,
        ).length,
        hasMemory: workspace.memory.length > 0,
      }))
      .sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt))
  }

  /**
   * 手机端可以新建工作区的授权根目录。只保存目录本身，手机端每次请求
   * 都由电脑端重新 realpath 校验，不信任手机传来的路径。
   */
  phoneRoots(): string[] {
    return [...this.state.settings.phoneRoots]
  }

  async addPhoneRoot(pathInput: string): Promise<string[]> {
    const info = await stat(pathInput)
    if (!info.isDirectory()) throw new Error('选择的路径不是文件夹')
    const path = await realpath(resolve(pathInput))
    const roots = this.state.settings.phoneRoots
    if (roots.includes(path) || roots.some((root) => isWithin(root, path))) {
      // 已经覆盖（相同目录或更外层的授权），不重复添加。
      return this.phoneRoots()
    }
    // 新授权目录更外层时，内层的旧授权是多余的。
    const next = roots.filter((root) => !isWithin(path, root))
    if (next.length >= MAX_PHONE_ROOTS) {
      throw new Error(`最多授权 ${MAX_PHONE_ROOTS} 个目录`)
    }
    next.push(path)
    this.state.settings.phoneRoots = next
    await this.save()
    return this.phoneRoots()
  }

  async removePhoneRoot(pathInput: string): Promise<string[]> {
    const target = resolve(pathInput)
    this.state.settings.phoneRoots = this.state.settings.phoneRoots.filter(
      (root) => root !== target && root !== pathInput,
    )
    await this.save()
    return this.phoneRoots()
  }

  async addWorkspace(
    pathInput: string,
    options: { activate?: boolean } = {},
  ): Promise<WorkspaceSummary> {
    const info = await stat(pathInput)
    if (!info.isDirectory()) throw new Error('Selected path is not a directory')
    const path = await realpath(resolve(pathInput))
    const existing = this.workspaceRecord(path)
    if (existing) {
      existing.lastOpenedAt = now()
    } else {
      if (this.state.workspaces.length >= MAX_WORKSPACES) {
        throw new Error(`工作区数量已达上限（${MAX_WORKSPACES}）`)
      }
      this.state.workspaces.push({
        path,
        name: basename(path) || path,
        addedAt: now(),
        lastOpenedAt: now(),
        memory: [],
        profiles: [],
        runs: [],
      })
    }
    // 手机端创建的工作区不抢电脑端当前打开的目录。
    if (options.activate !== false) this.state.activeWorkspace = path
    await this.save()
    return this.workspaces().find((workspace) => workspace.path === path)!
  }

  async removeWorkspace(path: string): Promise<void> {
    this.state.workspaces = this.state.workspaces.filter((workspace) => workspace.path !== path)
    const removedIds = new Set(
      this.state.sessions
        .filter((session) => session.workspacePath === path)
        .map((session) => session.id),
    )
    this.state.sessions = this.state.sessions.filter((session) => session.workspacePath !== path)
    this.state.scheduled = this.state.scheduled.filter((task) => !removedIds.has(task.sessionId))
    if (this.state.activeWorkspace === path) {
      this.state.activeWorkspace = this.state.workspaces[0]?.path ?? null
    }
    await this.save()
  }

  /**
   * Search rows for one session. The derived search index is preferred, so a
   * query never pulls transcripts off disk; a missing or stale entry (first run
   * after the cache was deleted, or a session edited without a save yet) is
   * rebuilt from the shard once and cached for the next query.
   */
  private searchView(session: Session): Session {
    const cached = this.searchIndex.sessions[session.id]
    if (cached && cached.updatedAt === session.updatedAt) {
      return sessionFromSearchRecords(session, cached.messages)
    }
    const records = searchRecordsFor(session)
    this.searchIndex.sessions[session.id] = { updatedAt: session.updatedAt, messages: records }
    this.searchIndexDirty = true
    return sessionFromSearchRecords(session, records)
  }

  /** Full-text search across every workspace, newest sessions first. */
  searchSessions(
    query: string,
    limit = 40,
    filter: MessageSearchFilter = {},
  ): MessageSearchHit[] {
    if (!query.trim()) return []
    const candidates = filter.sessionId
      ? this.state.sessions.filter((session) => session.id === filter.sessionId)
      : this.state.sessions
    return searchSessionMessages(candidates.map((session) => this.searchView(session)), query, limit, filter)
  }

  sessions(workspacePath: string): SessionSummary[] {
    return this.state.sessions
      .filter((session) => session.workspacePath === workspacePath)
      .map((session) => this.summary(session))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  private latestRunStatus(sessionId: string): RunRecord['status'] | null {
    let latest: RunRecord | null = null
    for (const workspace of this.state.workspaces) {
      for (const run of workspace.runs) {
        if (run.sessionId !== sessionId) continue
        if (!latest || run.startedAt > latest.startedAt) latest = run
      }
    }
    return latest?.status ?? null
  }

  private summary(session: Session): SessionSummary {
    const running = this.running.has(session.id)
    const info = this.runInfo.get(session.id)
    const lastStatus = this.latestRunStatus(session.id)
    const canContinue =
      !running &&
      (session.paused ||
        lastStatus === 'failed' ||
        lastStatus === 'interrupted' ||
        lastStatus === 'max_steps')
    return {
      id: session.id,
      title: localizeSessionTitle(session.title, this.uiLocale()),
      workspacePath: session.workspacePath,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      running,
      paused: session.paused,
      ...(session.pausedAt ? { pausedAt: session.pausedAt } : {}),
      ...(session.pauseInstruction ? { pauseInstruction: session.pauseInstruction } : {}),
      canContinue,
      ...this.counts(session),
      ...(info && info.instruction
        ? { runInstruction: info.instruction.slice(0, 180), runStartedAt: info.startedAt }
        : {}),
      approvalMode: session.approvalMode,
      sessionModelId: session.sessionModelId,
      plan: session.plan,
      kind: session.kind,
      review: session.review,
      reviewReport: session.reviewReport,
    }
  }

  session(id: string): Session | null {
    const session = this.state.sessions.find((entry) => entry.id === id)
    if (!session) return null
    return {
      ...this.summary(session),
      messages: session.messages,
      queue: session.queue,
      todos: session.todos,
      plan: session.plan,
      ...(session.memoryIds?.length ? { memoryIds: [...session.memoryIds] } : {}),
      ...(session.summary ? { summary: session.summary } : {}),
    }
  }

  /**
   * Remember the model-written compaction summary of the last run.
   *
   * Without this the summary died with the run: the next run rebuilt the same
   * compact view from raw history, so a long session paid for a summarizer call
   * on every turn and lost whatever the model had already distilled.
   */
  async setContextSummary(sessionId: string, summary: string | null): Promise<void> {
    const session = this.state.sessions.find((entry) => entry.id === sessionId)
    if (!session) throw new Error('Session not found')
    const clean = typeof summary === 'string' ? summary.trim() : ''
    if (!clean) {
      if (!session.summary) return
      session.summary = undefined
    } else if (clean === session.summary) {
      return
    } else {
      session.summary = clean.slice(0, CONTEXT_SUMMARY_MAX_CHARS)
    }
    session.updatedAt = now()
    await this.save()
  }

  /** The stored compaction summary, read without hydrating the transcript. */
  contextSummary(sessionId: string): string | null {
    const session = this.state.sessions.find((entry) => entry.id === sessionId)
    return session?.summary ?? null
  }

  setRunning(id: string, running: boolean): void {
    if (running) this.running.add(id)
    else this.running.delete(id)
  }

  isRunning(id: string): boolean {
    return this.running.has(id)
  }

  /** True while any session is executing; used to keep heavy upkeep off the
   * critical path of a run. */
  anyRunning(): boolean {
    return this.running.size > 0
  }

  setRunInfo(
    id: string,
    info: { runId: string; instruction: string; startedAt: string } | null,
  ): void {
    if (info) this.runInfo.set(id, info)
    else this.runInfo.delete(id)
  }

  async createSession(
    workspacePath: string,
    options: { kind?: SessionKind; review?: ReviewScope; title?: string } = {},
  ): Promise<Session> {
    if (!this.workspaceRecord(workspacePath)) throw new Error('Workspace is not open')
    const review = options.kind === 'review' ? sanitizeReviewScope(options.review) : null
    if (options.kind === 'review' && !review) {
      throw new Error('A review session needs at least one allowed root')
    }
    const kind: SessionKind = review ? 'review' : 'coding'
    const session: Session = {
      id: randomUUID(),
      title: (options.title ?? '').trim().slice(0, 120) || (kind === 'review' ? '复盘评估' : '新任务'),
      workspacePath,
      createdAt: now(),
      updatedAt: now(),
      running: false,
      paused: false,
      canContinue: false,
      messageCount: 0,
      queueCount: 0,
      todoCount: 0,
      // A review session is read-only; the execution mode only affects its
      // read tools, so start in read-only-auto to avoid approval noise.
      approvalMode: kind === 'review' ? 'manual' : this.state.settings.defaultApprovalMode,
      // 空串表示跟随全局会话模型；具体模型在任务会话里选择。
      sessionModelId: '',
      kind,
      review,
      reviewReport: null,
      messages: [],
      queue: [],
      todos: [],
      plan: null,
    }
    this.state.sessions.push(this.track(session))
    this.state.activeSession = session.id
    const workspaceSessions = this.state.sessions
      .filter((entry) => entry.workspacePath === workspacePath)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    if (workspaceSessions.length > 200) {
      const removable = workspaceSessions
        .filter((entry) => !this.running.has(entry.id))
        .slice(0, workspaceSessions.length - 200)
      const removeIds = new Set(removable.map((entry) => entry.id))
      this.state.sessions = this.state.sessions.filter((entry) => !removeIds.has(entry.id))
      this.state.scheduled = this.state.scheduled.filter(
        (task) => !removeIds.has(task.sessionId),
      )
    }
    await this.save()
    return this.session(session.id)!
  }

  async updateSession(
    id: string,
    input: { title?: string; approvalMode?: ApprovalMode },
  ): Promise<SessionSummary> {
    const session = this.state.sessions.find((entry) => entry.id === id)
    if (!session) throw new Error('Session not found')
    if (input.title !== undefined) {
      session.title = input.title.trim().slice(0, 120) || '新任务'
    }
    if (input.approvalMode !== undefined) {
      session.approvalMode =
        session.kind === 'review'
          ? 'manual'
          : validApprovalMode(input.approvalMode) ?? session.approvalMode
    }
    session.updatedAt = now()
    await this.save()
    return this.summary(session)
  }

  async deleteSession(id: string): Promise<void> {
    this.state.sessions = this.state.sessions.filter((session) => session.id !== id)
    this.state.scheduled = this.state.scheduled.filter((task) => task.sessionId !== id)
    if (this.state.activeSession === id) {
      this.state.activeSession = this.sessions(this.state.activeWorkspace ?? '')[0]?.id ?? null
    }
    await this.save()
  }

  async addMessage(sessionId: string, message: StoredMessage): Promise<void> {
    const session = this.state.sessions.find((entry) => entry.id === sessionId)
    if (!session) throw new Error('Session not found')
    session.messages.push(message)
    session.updatedAt = now()
    if (
      message.role === 'user' &&
      (session.title === 'New chat' || session.title === '新任务')
    ) {
      session.title = message.content.trim().replace(/\s+/g, ' ').slice(0, 60) || '新任务'
    }
    await this.save()
  }

  async addMessages(sessionId: string, messages: StoredMessage[]): Promise<void> {
    const session = this.state.sessions.find((entry) => entry.id === sessionId)
    if (!session) throw new Error('Session not found')
    session.messages.push(...messages)
    session.updatedAt = now()
    await this.save()
  }

  /**
   * Rewrite one user message and drop everything after it. This is the edit
   * and regenerate primitive: the caller supplies the new run id so the
   * rewritten message belongs to the run that is about to start.
   */
  async rewriteUserMessage(
    sessionId: string,
    messageId: string,
    content: string,
    runId: string,
  ): Promise<StoredMessage> {
    const session = this.state.sessions.find((entry) => entry.id === sessionId)
    if (!session) throw new Error('Session not found')
    const index = session.messages.findIndex((message) => message.id === messageId)
    if (index < 0) throw new Error('Message not found')
    const message = session.messages[index]!
    if (message.role !== 'user') throw new Error('Only user messages can be edited')
    if (message.control) throw new Error('Continuation markers cannot be edited')
    const text = content.trim()
    if (!text) throw new Error('Message is empty')
    message.content = text.slice(0, 32_000)
    message.runId = runId
    session.messages = session.messages.slice(0, index + 1)
    this.markMessagesRewrite(session)
    session.updatedAt = now()
    await this.save()
    return message
  }

  /**
   * Remove a user instruction that has not been answered yet. Only the final
   * message can be removed: once anything follows it the turn already produced
   * output, and edit/regenerate is the correct path instead.
   */
  async removeUnansweredMessage(sessionId: string, messageId: string): Promise<void> {
    const session = this.state.sessions.find((entry) => entry.id === sessionId)
    if (!session) throw new Error('Session not found')
    const index = session.messages.findIndex((message) => message.id === messageId)
    if (index < 0) throw new Error('Message not found')
    const message = session.messages[index]!
    if (message.role !== 'user') throw new Error('Only user messages can be deleted')
    if (message.control) throw new Error('Continuation markers cannot be deleted')
    if (index !== session.messages.length - 1) {
      throw new Error('This instruction already has a reply')
    }
    session.messages.splice(index, 1)
    this.markMessagesRewrite(session)
    session.updatedAt = now()
    await this.save()
  }

  /** Rewind the transcript to a checkpoint boundary. */
  async truncateMessages(sessionId: string, keep: number): Promise<number> {
    const session = this.state.sessions.find((entry) => entry.id === sessionId)
    if (!session) throw new Error('Session not found')
    const limit = Math.max(0, Math.min(session.messages.length, Math.round(keep)))
    const removed = session.messages.length - limit
    if (removed > 0) {
      session.messages = session.messages.slice(0, limit)
      this.markMessagesRewrite(session)
      session.updatedAt = now()
      await this.save()
    }
    return removed
  }

  async setQueue(sessionId: string, queue: Session['queue']): Promise<void> {
    const session = this.state.sessions.find((entry) => entry.id === sessionId)
    if (!session) throw new Error('Session not found')
    session.queue = queue
    session.updatedAt = now()
    await this.save()
  }

  async setPlan(sessionId: string, plan: Session['plan']): Promise<void> {
    const session = this.state.sessions.find((entry) => entry.id === sessionId)
    if (!session) throw new Error('Session not found')
    session.plan = plan
    session.updatedAt = now()
    await this.save()
  }

  async setReviewReport(sessionId: string, report: ReviewReport): Promise<void> {
    const session = this.state.sessions.find((entry) => entry.id === sessionId)
    if (!session) throw new Error('Session not found')
    if (session.kind !== 'review') throw new Error('Only review sessions can record a report')
    const clean = sanitizeReviewReport(report)
    if (!clean) throw new Error('The review report is empty')
    session.reviewReport = clean
    session.updatedAt = now()
    await this.save()
  }

  async setPaused(sessionId: string, instruction: string | null): Promise<void> {
    const session = this.state.sessions.find((entry) => entry.id === sessionId)
    if (!session) return
    if (instruction === null) {
      if (!session.paused) return
      session.paused = false
      delete session.pausedAt
      delete session.pauseInstruction
    } else {
      session.paused = true
      session.pausedAt = now()
      session.pauseInstruction = instruction.replace(/\s+/g, ' ').trim().slice(0, 4_000)
    }
    session.updatedAt = now()
    await this.save()
  }

  todos(sessionId: string): TodoItem[] {
    return this.state.sessions.find((entry) => entry.id === sessionId)?.todos ?? []
  }

  /**
   * 所有会话的待办，按「有未发送待办 → 会话最近更新」排序。
   * 左侧面板用它一次取全量，避免逐会话去问。
   */
  allTodos(): TodoGroup[] {
    return this.state.sessions
      .filter((session) => session.todos.length > 0)
      .map((session) => ({
        sessionId: session.id,
        sessionTitle: session.title,
        workspacePath: session.workspacePath,
        sessionUpdatedAt: session.updatedAt,
        todos: session.todos,
      }))
      .sort((a, b) => b.sessionUpdatedAt.localeCompare(a.sessionUpdatedAt))
  }

  todo(sessionId: string, todoId: string): TodoItem | null {
    return this.todos(sessionId).find((todo) => todo.id === todoId) ?? null
  }

  async addTodo(
    sessionId: string,
    text: string,
    source: TodoItem['source'] = 'user',
    clientId?: string,
    priority: TodoPriority = 'normal',
  ): Promise<TodoItem> {
    const session = this.state.sessions.find((entry) => entry.id === sessionId)
    if (!session) throw new Error('Session not found')
    const cleaned = text.replace(/\s+/g, ' ').trim().slice(0, 4_000)
    if (!cleaned) throw new Error('待办内容不能为空')
    const dedupeId = clientId?.trim().slice(0, 120)
    if (dedupeId) {
      const existing = session.todos.find((todo) => todo.clientId === dedupeId)
      if (existing) return existing
    }
    const todo: TodoItem = {
      id: randomUUID(),
      sessionId,
      text: cleaned,
      status: 'pending',
      priority: normalizeTodoPriority(priority),
      source,
      ...(dedupeId ? { clientId: dedupeId } : {}),
      createdAt: now(),
    }
    session.todos.unshift(todo)
    session.todos = session.todos.slice(0, 200)
    session.updatedAt = now()
    await this.save()
    return todo
  }

  async updateTodo(
    sessionId: string,
    todoId: string,
    text: string,
    priority?: TodoPriority,
  ): Promise<TodoItem> {
    const session = this.state.sessions.find((entry) => entry.id === sessionId)
    const todo = session?.todos.find((entry) => entry.id === todoId)
    if (!session || !todo) throw new Error('待办不存在')
    if (todo.status === 'sent') throw new Error('已发送的待办不能编辑')
    const cleaned = text.replace(/\s+/g, ' ').trim().slice(0, 4_000)
    if (!cleaned) throw new Error('待办内容不能为空')
    todo.text = cleaned
    if (priority) todo.priority = normalizeTodoPriority(priority)
    session.updatedAt = now()
    await this.save()
    return todo
  }

  /** 只改优先级：不动内容，也不会因文字校验失败而拒绝。 */
  async setTodoPriority(
    sessionId: string,
    todoId: string,
    priority: TodoPriority,
  ): Promise<TodoItem> {
    const session = this.state.sessions.find((entry) => entry.id === sessionId)
    const todo = session?.todos.find((entry) => entry.id === todoId)
    if (!session || !todo) throw new Error('待办不存在')
    todo.priority = normalizeTodoPriority(priority)
    session.updatedAt = now()
    await this.save()
    return todo
  }

  async removeTodo(sessionId: string, todoId: string): Promise<void> {
    const session = this.state.sessions.find((entry) => entry.id === sessionId)
    if (!session) return
    session.todos = session.todos.filter((todo) => todo.id !== todoId)
    session.updatedAt = now()
    await this.save()
  }

  async clearSentTodos(sessionId: string): Promise<void> {
    const session = this.state.sessions.find((entry) => entry.id === sessionId)
    if (!session) return
    session.todos = session.todos.filter((todo) => todo.status !== 'sent')
    session.updatedAt = now()
    await this.save()
  }

  /** Turn a pending todo into a scheduled task. The todo is removed only after
   * the schedule was written, so a validation error never loses the todo. */
  async convertTodoToSchedule(
    sessionId: string,
    todoId: string,
    input: ScheduledTaskInput,
  ): Promise<ScheduledTask> {
    const session = this.state.sessions.find((entry) => entry.id === sessionId)
    const todo = session?.todos.find((entry) => entry.id === todoId)
    if (!session || !todo) throw new Error('待办不存在')
    if (todo.status === 'sent') throw new Error('已发送的待办不能再转为定时任务')
    const task = await this.addScheduledTask(sessionId, {
      ...input,
      content: input.content?.trim() || todo.text,
    })
    await this.removeTodo(sessionId, todoId)
    return task
  }

  /** Move a scheduled task back to the todo list as a pending item. */
  async convertScheduledTaskToTodo(sessionId: string, taskId: string): Promise<TodoItem> {
    const task = this.scheduledTask(taskId)
    if (!task || task.sessionId !== sessionId) throw new Error('定时任务不存在')
    const todo = await this.addTodo(sessionId, task.content, 'user')
    await this.removeScheduledTask(sessionId, taskId)
    return todo
  }

  async markTodoSent(
    sessionId: string,
    todoId: string,
    runId?: string,
  ): Promise<TodoItem | null> {
    const session = this.state.sessions.find((entry) => entry.id === sessionId)
    const todo = session?.todos.find((entry) => entry.id === todoId)
    if (!session || !todo) return null
    todo.status = 'sent'
    todo.sentAt = now()
    if (runId) todo.sentRunId = runId
    session.updatedAt = now()
    await this.save()
    return todo
  }

  async forkSession(sessionId: string): Promise<Session> {
    const source = this.state.sessions.find((entry) => entry.id === sessionId)
    if (!source) throw new Error('Session not found')
    const titleBase = source.title.replace(/\s*·\s*副本\s*$/, '').trim() || '新任务'
    const fork: Session = {
      ...source,
      id: randomUUID(),
      title: `${titleBase} · 副本`.slice(0, 120),
      createdAt: now(),
      updatedAt: now(),
      running: false,
      paused: false,
      canContinue: false,
      messageCount: source.messages.length,
      queueCount: 0,
      todoCount: 0,
      approvalMode: source.approvalMode,
      messages: source.messages.map((message) => ({ ...message, id: randomUUID() })),
      queue: [],
      todos: [],
      plan: source.plan ? { ...source.plan, items: source.plan.items.map((item) => ({ ...item })) } : null,
    }
    delete fork.pausedAt
    delete fork.pauseInstruction
    delete fork.runInstruction
    delete fork.runStartedAt
    this.state.sessions.push(this.track(fork))
    this.state.activeSession = fork.id
    await this.save()
    return this.session(fork.id)!
  }

  /** null until the user saves their own list for the first time. */
  quickCommands(): QuickCommand[] | null {
    return this.state.quickCommands?.map((command) => ({ ...command })) ?? null
  }

  async saveQuickCommands(items: QuickCommandInput[]): Promise<QuickCommand[]> {
    const contents = new Set<string>()
    const ids = new Set<string>()
    const next: QuickCommand[] = []
    for (const item of Array.isArray(items) ? items : []) {
      const content =
        typeof item?.content === 'string'
          ? item.content.trim().slice(0, MAX_QUICK_COMMAND_CHARS)
          : ''
      if (!content || contents.has(content)) continue
      contents.add(content)
      const provided = typeof item?.id === 'string' ? item.id.trim().slice(0, 80) : ''
      const id = provided && !ids.has(provided) ? provided : randomUUID()
      ids.add(id)
      next.push({ id, content })
      if (next.length >= MAX_QUICK_COMMANDS) break
    }
    this.state.quickCommands = next
    await this.save()
    return next.map((command) => ({ ...command }))
  }

  scheduledTasks(sessionId: string): ScheduledTask[] {
    return this.state.scheduled
      .filter((task) => task.sessionId === sessionId)
      .map((task) => ({ ...task }))
      .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt))
  }

  /** Every scheduled task across sessions; the panel sorts and groups them. */
  allScheduledTasks(): ScheduledTask[] {
    return this.state.scheduled
      .map((task) => ({ ...task }))
      .sort((left, right) => left.nextRunAt.localeCompare(right.nextRunAt))
  }

  /** The same list grouped by session, for the cross-session overview panel. */
  allScheduledTaskGroups(): ScheduledTaskGroup[] {
    const groups = new Map<string, ScheduledTaskGroup>()
    for (const task of this.allScheduledTasks()) {
      const session = this.state.sessions.find((entry) => entry.id === task.sessionId)
      if (!session) continue
      const group = groups.get(session.id) ?? {
        sessionId: session.id,
        sessionTitle: session.title,
        workspacePath: session.workspacePath,
        sessionUpdatedAt: session.updatedAt,
        tasks: [],
      }
      group.tasks.push(task)
      groups.set(session.id, group)
    }
    return [...groups.values()].sort((a, b) => {
      const left = a.tasks[0]?.nextRunAt ?? ''
      const right = b.tasks[0]?.nextRunAt ?? ''
      return left.localeCompare(right)
    })
  }

  private scheduledTask(taskId: string): ScheduledTask | undefined {
    return this.state.scheduled.find((task) => task.id === taskId)
  }

  private scheduleNext(
    kind: ScheduleKind,
    input: { intervalMinutes?: number; timeOfDay?: string; delayMinutes?: number },
    from = new Date(),
  ): { nextRunAt: string; intervalMinutes?: number; timeOfDay?: string } {
    if (kind === 'daily') {
      const timeOfDay = cleanTimeOfDay(input.timeOfDay)
      if (!timeOfDay) throw new Error('请选择每天执行的时间')
      return { timeOfDay, nextRunAt: nextDailyRun(timeOfDay, from) }
    }
    const minutes =
      kind === 'interval'
        ? Math.round(clampNumber(input.intervalMinutes, 60, 1, 10_080))
        : Math.round(clampNumber(input.delayMinutes, 10, 1, 10_080))
    return {
      nextRunAt: new Date(from.getTime() + minutes * 60_000).toISOString(),
      ...(kind === 'interval' ? { intervalMinutes: minutes } : {}),
    }
  }

  async addScheduledTask(
    sessionId: string,
    input: ScheduledTaskInput,
  ): Promise<ScheduledTask> {
    const session = this.state.sessions.find((entry) => entry.id === sessionId)
    if (!session) throw new Error('Session not found')
    const content = input.content.replace(/\s+/g, ' ').trim().slice(0, 4_000)
    if (!content) throw new Error('定时任务内容不能为空')
    const kind: ScheduleKind =
      input.kind === 'interval' || input.kind === 'daily' ? input.kind : 'once'
    const schedule = this.scheduleNext(kind, input)
    const task: ScheduledTask = {
      id: randomUUID(),
      sessionId,
      content,
      kind,
      ...(schedule.intervalMinutes !== undefined
        ? { intervalMinutes: schedule.intervalMinutes }
        : {}),
      ...(schedule.timeOfDay ? { timeOfDay: schedule.timeOfDay } : {}),
      nextRunAt: schedule.nextRunAt,
      enabled: true,
      createdAt: now(),
    }
    this.state.scheduled = [task, ...this.state.scheduled].slice(0, 500)
    session.updatedAt = now()
    await this.save()
    return { ...task }
  }

  async updateScheduledTask(
    sessionId: string,
    taskId: string,
    input: Partial<ScheduledTaskInput> & { enabled?: boolean },
  ): Promise<ScheduledTask> {
    const task = this.scheduledTask(taskId)
    if (!task || task.sessionId !== sessionId) throw new Error('定时任务不存在')
    if (input.content !== undefined) {
      const content = input.content.replace(/\s+/g, ' ').trim().slice(0, 4_000)
      if (!content) throw new Error('定时任务内容不能为空')
      task.content = content
    }
    const nextKind: ScheduleKind =
      input.kind === 'interval' || input.kind === 'daily'
        ? input.kind
        : input.kind === 'once'
          ? 'once'
          : task.kind
    const scheduleChanged =
      input.kind !== undefined ||
      input.delayMinutes !== undefined ||
      input.intervalMinutes !== undefined ||
      input.timeOfDay !== undefined
    if (scheduleChanged) {
      const schedule = this.scheduleNext(nextKind, {
        ...(input.delayMinutes !== undefined ? { delayMinutes: input.delayMinutes } : {}),
        ...(input.intervalMinutes !== undefined ? { intervalMinutes: input.intervalMinutes } : {}),
        ...(input.timeOfDay !== undefined ? { timeOfDay: input.timeOfDay } : {}),
      })
      task.kind = nextKind
      task.nextRunAt = schedule.nextRunAt
      delete task.intervalMinutes
      delete task.timeOfDay
      if (schedule.intervalMinutes !== undefined) task.intervalMinutes = schedule.intervalMinutes
      if (schedule.timeOfDay) task.timeOfDay = schedule.timeOfDay
    }
    if (input.enabled !== undefined) {
      if (input.enabled && !task.enabled) {
        if (task.kind === 'once') {
          if (Date.parse(task.nextRunAt) <= Date.now()) {
            task.nextRunAt = new Date(Date.now() + 10 * 60_000).toISOString()
          }
        } else {
          const schedule = this.scheduleNext(task.kind, task)
          task.nextRunAt = schedule.nextRunAt
        }
      }
      task.enabled = input.enabled
    }
    await this.save()
    return { ...task }
  }

  async removeScheduledTask(sessionId: string, taskId: string): Promise<void> {
    this.state.scheduled = this.state.scheduled.filter(
      (task) => !(task.id === taskId && task.sessionId === sessionId),
    )
    await this.save()
  }

  dueScheduledTasks(at = Date.now()): ScheduledTask[] {
    return this.state.scheduled
      .filter(
        (task) => task.enabled && Date.parse(task.nextRunAt) <= at,
      )
      .map((task) => ({ ...task }))
  }

  async completeScheduledRun(
    taskId: string,
    status: 'queued' | 'failed',
    error?: string,
  ): Promise<ScheduledTask | null> {
    const task = this.scheduledTask(taskId)
    if (!task) return null
    task.lastRunAt = now()
    task.lastStatus = status
    if (error) task.lastError = error.slice(0, 1_000)
    else delete task.lastError
    if (task.kind === 'once') {
      task.enabled = false
    } else {
      const schedule = this.scheduleNext(task.kind, task)
      task.nextRunAt = schedule.nextRunAt
      if (schedule.intervalMinutes !== undefined) task.intervalMinutes = schedule.intervalMinutes
      if (schedule.timeOfDay) task.timeOfDay = schedule.timeOfDay
    }
    await this.save()
    return { ...task }
  }

  workspacePathForSession(sessionId: string): string {
    const session = this.state.sessions.find((entry) => entry.id === sessionId)
    if (!session) throw new Error('Session not found')
    return session.workspacePath
  }

  async addMemory(
    workspacePath: string,
    content: string,
    source: MemoryEntry['source'],
    runId?: string,
    category?: MemoryCategory,
    sessionId?: string,
  ): Promise<MemoryEntry> {
    const workspace = this.workspaceRecord(workspacePath)
    if (!workspace) throw new Error('Workspace not found')
    const cleaned = content.replace(/\s+/g, ' ').trim().slice(0, MEMORY_ENTRY_MAX_CHARS)
    if (!cleaned) throw new Error('Memory entry is empty')
    if (SECRET_PATTERN.test(cleaned)) throw new Error('Memory entry appears to contain a secret')
    const existing = workspace.memory.find(
      (entry) => entry.content.toLowerCase() === cleaned.toLowerCase(),
    )
    // Re-deriving an insight we already hold is the strongest usefulness signal:
    // count it instead of dropping it, so ranking can prefer what keeps paying off.
    if (existing) {
      existing.reinforced = (existing.reinforced ?? 0) + 1
      existing.lastUsedAt = now()
      if (!existing.category) existing.category = category ?? inferMemoryCategory(cleaned, source)
      if (!existing.sessionId && sessionId) existing.sessionId = sessionId
      await this.save()
      return existing
    }
    const entry: MemoryEntry = {
      id: randomUUID(),
      content: cleaned,
      source,
      category: category ?? inferMemoryCategory(cleaned, source),
      createdAt: now(),
      reinforced: 0,
      injected: 0,
      lastUsedAt: now(),
      ...(runId ? { runId } : {}),
      ...(sessionId ? { sessionId } : {}),
    }
    workspace.memory.unshift(entry)
    workspace.memory = workspace.memory.slice(0, MEMORY_STORE_LIMIT)
    await this.save()
    return entry
  }

  /**
   * Records that these entries were placed into a system prompt.
   *
   * With a `sessionId` the ids are also stamped on the session, which is what
   * lets 「会话资源 → 会话记忆」answer "what did THIS task remember" — the
   * workspace store itself stays the single copy of the entries.
   */
  async noteMemoryInjected(
    workspacePath: string,
    memoryIds: string[],
    sessionId?: string,
  ): Promise<void> {
    if (memoryIds.length === 0) return
    const workspace = this.workspaceRecord(workspacePath)
    if (!workspace) return
    const wanted = new Set(memoryIds)
    const stamp = now()
    let changed = false
    for (const entry of workspace.memory) {
      if (!wanted.has(entry.id)) continue
      entry.injected = (entry.injected ?? 0) + 1
      entry.lastUsedAt = stamp
      changed = true
    }
    if (sessionId) {
      const session = this.state.sessions.find((entry) => entry.id === sessionId)
      if (session) {
        // Newest first, and an id only appears once no matter how many runs use it.
        const merged = [...memoryIds.filter((id) => !session.memoryIds?.includes(id))]
        const seen = new Set(merged)
        const kept = (session.memoryIds ?? []).filter((id) => !seen.has(id))
        const next = [...merged, ...kept].slice(0, 200)
        if (next.join('\n') !== (session.memoryIds ?? []).join('\n')) {
          session.memoryIds = next
          session.updatedAt = stamp
          changed = true
        }
      }
    }
    if (changed) await this.save()
  }

  async deleteMemory(workspacePath: string, memoryId: string): Promise<void> {
    const workspace = this.workspaceRecord(workspacePath)
    if (!workspace) throw new Error('Workspace not found')
    workspace.memory = workspace.memory.filter((entry) => entry.id !== memoryId)
    await this.save()
  }

  memory(workspacePath: string): MemoryEntry[] {
    return this.workspaceRecord(workspacePath)?.memory ?? []
  }

  workspaceDetail(path: string): WorkspaceDetail {
    const workspace = this.workspaceRecord(path)
    if (!workspace) throw new Error('Workspace not found')
    return {
      workspace: this.workspaces().find((entry) => entry.path === path)!,
      memory: [...workspace.memory],
      profiles: [...workspace.profiles].sort((a, b) => b.version - a.version),
      activeProfile: workspace.profiles.find((profile) => profile.status === 'active') ?? null,
      globalProfiles: this.globalProfiles(),
      activeGlobalProfile: this.activeGlobalProfile(),
      runs: [...workspace.runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
      evolution: this.evolutionState(path),
      quality: this.qualityState(path),
    }
  }

  /**
   * 质量闸门的状态。候选版本记在工作区维度（每个项目自己的质量基线），
   * 所以这里按路径过滤，而不是像进化周期那样全量返回。
   */
  qualityState(path: string): QualityState {
    const all = this.state.quality
    return {
      metricSet: all.metricSet,
      baseline: all.baseline,
      candidates: all.candidates.filter((candidate) => candidate.workspacePath === path),
    }
  }

  /** 替换指标集并把版本号推进一步（调优与人工重置都走这里）。 */
  async setQualityMetricSet(metricSet: QualityState['metricSet']): Promise<void> {
    this.state.quality.metricSet = metricSet
    await this.save()
  }

  async setQualityBaseline(score: QualityState['baseline']): Promise<void> {
    this.state.quality.baseline = score
    await this.save()
  }

  /** 新候选排在最前，总数封顶避免状态文件无限膨胀。 */
  async addQualityCandidate(candidate: QualityCandidate): Promise<QualityCandidate> {
    const cleaned = sanitizeQualityState({
      metricSet: this.state.quality.metricSet,
      candidates: [candidate, ...this.state.quality.candidates],
    }).candidates.find((entry) => entry.id === candidate.id)
    if (!cleaned) throw new Error('Invalid quality candidate')
    this.state.quality.candidates = [
      cleaned,
      ...this.state.quality.candidates.filter((entry) => entry.id !== cleaned.id),
    ].slice(0, 40)
    await this.save()
    return cleaned
  }

  async updateQualityCandidate(
    id: string,
    patch: Partial<QualityCandidate>,
  ): Promise<QualityCandidate> {
    const current = this.state.quality.candidates.find((entry) => entry.id === id)
    if (!current) throw new Error('质量候选不存在')
    const next: QualityCandidate = {
      ...current,
      ...patch,
      id: current.id,
      workspacePath: current.workspacePath,
      createdAt: current.createdAt,
    }
    const cleaned =
      sanitizeCandidate(next) ?? (() => {
        throw new Error('Invalid quality candidate')
      })()
    this.state.quality.candidates = this.state.quality.candidates.map((entry) =>
      entry.id === id ? cleaned : entry,
    )
    await this.save()
    return cleaned
  }

  /** 版本号按工作区独立递增，铃声里显示「第 N 个候选」。 */
  nextQualityVersion(workspacePath: string): number {
    const versions = this.state.quality.candidates
      .filter((candidate) => candidate.workspacePath === workspacePath)
      .map((candidate) => candidate.version)
    return versions.length === 0 ? 1 : Math.max(...versions) + 1
  }

  evolutionState(workspacePath: string): EvolutionState {
    return {
      policy: { ...this.state.evolutionPolicy },
      policyVersions: this.state.evolutionPolicyVersions.map((version) => ({ ...version })),
      // The full history goes out; the panel decides what to show first.
      cycles: this.state.evolutionCycles
        .filter((cycle) => cycle.workspacePath === workspacePath)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    }
  }

  evolutionPolicy(): EvolutionPolicy {
    return { ...this.state.evolutionPolicy }
  }

  activeProfile(workspacePath: string): ProfileVersion | null {
    return this.workspaceRecord(workspacePath)?.profiles.find((profile) => profile.status === 'active') ?? null
  }

  globalProfiles(): ProfileVersion[] {
    return [...this.state.globalProfiles].sort((a, b) => b.version - a.version)
  }

  globalProfile(profileId: string): ProfileVersion | undefined {
    return this.state.globalProfiles.find((profile) => profile.id === profileId)
  }

  activeGlobalProfile(): ProfileVersion | null {
    return this.state.globalProfiles.find((profile) => profile.status === 'active') ?? null
  }

  runs(workspacePath: string): RunRecord[] {
    return this.workspaceRecord(workspacePath)?.runs ?? []
  }

  run(workspacePath: string, runId: string): RunRecord | undefined {
    return this.workspaceRecord(workspacePath)?.runs.find((run) => run.id === runId)
  }

  async startRun(workspacePath: string, run: RunRecord): Promise<void> {
    const workspace = this.workspaceRecord(workspacePath)
    if (!workspace) throw new Error('Workspace not found')
    workspace.runs.unshift(run)
    workspace.runs = workspace.runs.slice(0, 200)
    await this.save()
  }

  async finishRun(workspacePath: string, runId: string, patch: Partial<RunRecord>): Promise<void> {
    const workspace = this.workspaceRecord(workspacePath)
    if (!workspace) return
    const run = workspace.runs.find((entry) => entry.id === runId)
    if (!run) return
    Object.assign(run, patch)
    await this.save()
  }

  async setFeedback(
    workspacePath: string,
    runId: string,
    feedback: RunFeedback,
  ): Promise<RunRecord | null> {
    const run = this.workspaceRecord(workspacePath)?.runs.find((entry) => entry.id === runId)
    if (!run) return null
    run.feedback = feedback
    await this.save()
    return run
  }

  evidence(workspacePath: string, limit = 30): ProfileEvidence {
    const runs = this.runs(workspacePath).slice(0, limit)
    const failures = runs.filter(
      (run) => run.status === 'failed' || run.status === 'interrupted' || run.status === 'max_steps',
    ).length
    const positive = runs.filter((run) => run.feedback?.rating === 'up').length
    const negative = runs.filter((run) => run.feedback?.rating === 'down').length
    const verified = runs.filter(
      (run) => (run.filesChanged ?? 0) > 0 && run.checked === true,
    ).length
    return {
      runs: runs.length,
      failures,
      avgSteps: runs.length
        ? Math.round((runs.reduce((total, run) => total + run.steps, 0) / runs.length) * 10) / 10
        : 0,
      avgTokens: runs.length
        ? Math.round(runs.reduce((total, run) => total + run.totalTokens, 0) / runs.length)
        : 0,
      positive,
      negative,
      verified,
    }
  }

  async createProfileDraft(
    workspacePath: string,
    input: {
      promptAddendum: string
      rationale: string
      source: ProfileVersion['source']
      strategy?: ProfileStrategy
      evidence?: ProfileEvidence
      explanation?: ProfileExplanation
      /**
       * Variant this draft mutates. The loop samples it from the measured
       * archive, so it is not always the version currently in force.
       */
      basedOnVersion?: number
    },
  ): Promise<ProfileVersion> {
    const workspace = this.workspaceRecord(workspacePath)
    if (!workspace) throw new Error('Workspace not found')
    const addendum = input.promptAddendum.replace(/\r\n/g, '\n').trim()
    if (!addendum) throw new Error('The proposed operating rules are empty')
    if (addendum.length > 4_000) throw new Error('The proposed operating rules exceed 4000 characters')
    if (SECRET_PATTERN.test(addendum) || SECRET_PATTERN.test(input.rationale)) {
      throw new Error('The proposal appears to contain a credential; drafts cannot store secrets')
    }
    if (WEAKEN_PATTERN.test(addendum)) {
      throw new Error('The proposal appears to weaken safety or approval rules; it was rejected')
    }
    // A new draft should refine existing rules, not silently replace them.
    const active = workspace.profiles.find((profile) => profile.status === 'active')
    if (active && active.promptAddendum.trim() === addendum) {
      throw new Error('The proposal is identical to the active profile')
    }
    const version = Math.max(0, ...workspace.profiles.map((profile) => profile.version)) + 1
    // An explicit parent wins so a draft branched from an older archive variant
    // records the lineage it actually came from; otherwise fall back to the
    // incumbent exactly as before.
    const requestedParent =
      typeof input.basedOnVersion === 'number' &&
      workspace.profiles.some((profile) => profile.version === input.basedOnVersion)
        ? input.basedOnVersion
        : null
    const basedOnVersion =
      requestedParent ?? (active && active.version < version ? active.version : null)
    const profile: ProfileVersion = {
      id: randomUUID(),
      version,
      status: 'draft',
      promptAddendum: addendum,
      scope: 'workspace',
      strategy: {
        ...(typeof input.strategy?.maxSteps === 'number'
          ? { maxSteps: clampNumber(input.strategy.maxSteps, 200, 20, 500) }
          : {}),
        ...(typeof input.strategy?.temperature === 'number'
          ? { temperature: clampNumber(input.strategy.temperature, 0.2, 0, 1) }
          : {}),
      },
      rationale: input.rationale.trim().slice(0, 4_000),
      source: input.source,
      evidence: input.evidence ?? this.evidence(workspacePath),
      ...(input.explanation ? { explanation: input.explanation } : {}),
      ...(basedOnVersion !== null ? { basedOnVersion } : {}),
      createdAt: now(),
    }
    workspace.profiles.unshift(profile)
    // Keep measured winners and undecided drafts alive; drop the oldest variants
    // that never proved anything rather than the oldest ancestors of everything.
    workspace.profiles = pruneProfiles(workspace.profiles)
    await this.save()
    return profile
  }

  /** Attach or refresh the plain-language explanation of a workspace draft. */
  async setProfileExplanation(
    workspacePath: string,
    profileId: string,
    explanation: ProfileExplanation,
  ): Promise<ProfileVersion> {
    const workspace = this.workspaceRecord(workspacePath)
    if (!workspace) throw new Error('Workspace not found')
    const profile = workspace.profiles.find((entry) => entry.id === profileId)
    if (!profile) throw new Error('Profile not found')
    profile.explanation = explanation
    await this.save()
    return profile
  }

  async setProfileReview(
    workspacePath: string,
    profileId: string,
    review: ProfileReview,
  ): Promise<ProfileVersion> {
    const workspace = this.workspaceRecord(workspacePath)
    if (!workspace) throw new Error('Workspace not found')
    const profile = workspace.profiles.find((entry) => entry.id === profileId)
    if (!profile) throw new Error('Profile not found')
    profile.review = review
    await this.save()
    return profile
  }

  async activateProfile(
    workspacePath: string,
    profileId: string,
    options: { auto?: boolean } = {},
  ): Promise<ProfileVersion> {
    const workspace = this.workspaceRecord(workspacePath)
    if (!workspace) throw new Error('Workspace not found')
    const profile = workspace.profiles.find((entry) => entry.id === profileId)
    if (!profile) throw new Error('Profile not found')
    if (profile.status === 'active') return profile
    for (const entry of workspace.profiles) {
      if (entry.status === 'active') {
        entry.status = 'retired'
        entry.retiredAt = now()
      }
    }
    profile.status = 'active'
    profile.activatedAt = now()
    profile.retiredAt = undefined
    profile.autoActivated = options.auto === true
    await this.save()
    return profile
  }

  async rollbackProfile(workspacePath: string): Promise<ProfileVersion | null> {
    const workspace = this.workspaceRecord(workspacePath)
    if (!workspace) throw new Error('Workspace not found')
    const active = workspace.profiles.find((profile) => profile.status === 'active')
    const previous = workspace.profiles
      .filter((profile) => profile.status === 'retired' && profile.activatedAt)
      .sort((a, b) => (b.activatedAt ?? '').localeCompare(a.activatedAt ?? ''))[0]
    if (!previous) return null
    if (active) {
      active.status = 'retired'
      active.retiredAt = now()
      active.activatedAt = undefined
    }
    previous.status = 'active'
    previous.activatedAt = now()
    previous.retiredAt = undefined
    await this.save()
    return previous
  }

  /** Retire the active profile without falling back to an older version. */
  async deactivateProfile(workspacePath: string): Promise<ProfileVersion | null> {
    const workspace = this.workspaceRecord(workspacePath)
    if (!workspace) throw new Error('Workspace not found')
    const active = workspace.profiles.find((profile) => profile.status === 'active')
    if (!active) return null
    active.status = 'retired'
    active.retiredAt = now()
    active.activatedAt = undefined
    active.autoActivated = false
    await this.save()
    return active
  }

  async deleteProfile(workspacePath: string, profileId: string): Promise<void> {
    const workspace = this.workspaceRecord(workspacePath)
    if (!workspace) throw new Error('Workspace not found')
    const profile = workspace.profiles.find((entry) => entry.id === profileId)
    if (!profile) return
    if (profile.status === 'active') throw new Error('Deactivate the profile before deleting it')
    workspace.profiles = workspace.profiles.filter((entry) => entry.id !== profileId)
    await this.save()
  }

  async createGlobalProfileDraft(input: {
    promptAddendum: string
    rationale: string
    source: ProfileVersion['source']
    strategy?: ProfileStrategy
    evidence?: ProfileEvidence
    explanation?: ProfileExplanation
  }): Promise<ProfileVersion> {
    const addendum = input.promptAddendum.replace(/\r\n/g, '\n').trim()
    if (!addendum) throw new Error('The proposed operating rules are empty')
    if (addendum.length > 4_000) throw new Error('The proposed operating rules exceed 4000 characters')
    if (SECRET_PATTERN.test(addendum) || SECRET_PATTERN.test(input.rationale)) {
      throw new Error('The proposal appears to contain a credential; drafts cannot store secrets')
    }
    if (WEAKEN_PATTERN.test(addendum)) {
      throw new Error('The proposal appears to weaken safety or approval rules; it was rejected')
    }
    const active = this.activeGlobalProfile()
    if (active && active.promptAddendum.trim() === addendum) {
      throw new Error('The proposal is identical to the active global profile')
    }
    const version =
      Math.max(0, ...this.state.globalProfiles.map((profile) => profile.version)) + 1
    const profile: ProfileVersion = {
      id: randomUUID(),
      version,
      status: 'draft',
      promptAddendum: addendum,
      scope: 'global',
      strategy: {
        ...(typeof input.strategy?.maxSteps === 'number'
          ? { maxSteps: clampNumber(input.strategy.maxSteps, 200, 20, 500) }
          : {}),
        ...(typeof input.strategy?.temperature === 'number'
          ? { temperature: clampNumber(input.strategy.temperature, 0.2, 0, 1) }
          : {}),
      },
      rationale: input.rationale.trim().slice(0, 4_000),
      source: input.source,
      evidence: input.evidence ?? {
        runs: 0,
        failures: 0,
        avgSteps: 0,
        avgTokens: 0,
        positive: 0,
        negative: 0,
      },
      ...(input.explanation ? { explanation: input.explanation } : {}),
      ...(active && active.version < version ? { basedOnVersion: active.version } : {}),
      createdAt: now(),
    }
    this.state.globalProfiles.unshift(profile)
    this.state.globalProfiles = this.state.globalProfiles.slice(0, 40)
    await this.save()
    return profile
  }

  async setGlobalProfileExplanation(
    profileId: string,
    explanation: ProfileExplanation,
  ): Promise<ProfileVersion> {
    const profile = this.globalProfile(profileId)
    if (!profile) throw new Error('Global profile not found')
    profile.explanation = explanation
    await this.save()
    return profile
  }

  async setGlobalProfileReview(profileId: string, review: ProfileReview): Promise<ProfileVersion> {
    const profile = this.globalProfile(profileId)
    if (!profile) throw new Error('Global profile not found')
    profile.review = review
    await this.save()
    return profile
  }

  async activateGlobalProfile(profileId: string): Promise<ProfileVersion> {
    const profile = this.globalProfile(profileId)
    if (!profile) throw new Error('Global profile not found')
    if (profile.status === 'active') return profile
    for (const entry of this.state.globalProfiles) {
      if (entry.status === 'active') {
        entry.status = 'retired'
        entry.retiredAt = now()
      }
    }
    profile.status = 'active'
    profile.activatedAt = now()
    profile.retiredAt = undefined
    await this.save()
    return profile
  }

  async rollbackGlobalProfile(): Promise<ProfileVersion | null> {
    const active = this.activeGlobalProfile()
    const previous = this.state.globalProfiles
      .filter((profile) => profile.status === 'retired' && profile.activatedAt)
      .sort((a, b) => (b.activatedAt ?? '').localeCompare(a.activatedAt ?? ''))[0]
    if (!previous) return null
    if (active) {
      active.status = 'retired'
      active.retiredAt = now()
      active.activatedAt = undefined
    }
    previous.status = 'active'
    previous.activatedAt = now()
    previous.retiredAt = undefined
    await this.save()
    return previous
  }

  async deleteGlobalProfile(profileId: string): Promise<void> {
    const profile = this.globalProfile(profileId)
    if (!profile) return
    if (profile.status === 'active') throw new Error('Deactivate the global profile before deleting it')
    this.state.globalProfiles = this.state.globalProfiles.filter((entry) => entry.id !== profileId)
    await this.save()
  }

  /**
   * Store a meta-evolution proposal. Every field is clamped, so the proposal
   * can change cadence and strictness but cannot disable the review gate.
   */
  async createEvolutionPolicyDraft(input: {
    policy: EvolutionPolicy
    rationale: string
    evidence?: ProfileEvidence
  }): Promise<EvolutionPolicyVersion> {
    const policy = sanitizeEvolutionPolicy(input.policy, this.state.evolutionPolicy)
    const rationale = input.rationale.replace(/\r\n/g, '\n').trim().slice(0, 4_000)
    if (!rationale) throw new Error('The evolution-policy proposal needs a rationale')
    if (SECRET_PATTERN.test(rationale)) {
      throw new Error('The proposal appears to contain a credential; drafts cannot store secrets')
    }
    if (evolutionPolicyKey(policy) === evolutionPolicyKey(this.state.evolutionPolicy)) {
      throw new Error('The proposed evolution policy is identical to the active policy')
    }
    const version =
      Math.max(0, ...this.state.evolutionPolicyVersions.map((entry) => entry.version)) + 1
    const draft: EvolutionPolicyVersion = {
      id: randomUUID(),
      version,
      status: 'draft',
      policy,
      rationale,
      evidence: input.evidence ?? this.aggregateEvidenceForPolicy(),
      createdAt: now(),
    }
    this.state.evolutionPolicyVersions.unshift(draft)
    // No automatic trimming: a version disappears only when the user clears it.
    await this.save()
    return draft
  }

  async setEvolutionPolicyReview(
    id: string,
    review: ProfileReview,
  ): Promise<EvolutionPolicyVersion> {
    const draft = this.state.evolutionPolicyVersions.find((entry) => entry.id === id)
    if (!draft) throw new Error('Evolution policy version not found')
    draft.review = review
    await this.save()
    return draft
  }

  async activateEvolutionPolicy(id: string): Promise<EvolutionPolicyVersion> {
    const version = this.state.evolutionPolicyVersions.find((entry) => entry.id === id)
    if (!version) throw new Error('Evolution policy version not found')
    if (version.status === 'active') return version
    for (const entry of this.state.evolutionPolicyVersions) {
      if (entry.status === 'active') {
        entry.status = 'retired'
        entry.retiredAt = now()
      }
    }
    version.status = 'active'
    version.activatedAt = now()
    version.retiredAt = undefined
    this.state.evolutionPolicy = { ...version.policy, updatedAt: now() }
    await this.save()
    return version
  }

  async rollbackEvolutionPolicy(): Promise<EvolutionPolicyVersion | null> {
    const active = this.state.evolutionPolicyVersions.find((entry) => entry.status === 'active')
    const previous = this.state.evolutionPolicyVersions
      .filter((entry) => entry.status === 'retired' && entry.activatedAt)
      .sort((a, b) => (b.activatedAt ?? '').localeCompare(a.activatedAt ?? ''))[0]
    if (!previous) return null
    if (active) {
      active.status = 'retired'
      active.retiredAt = now()
    }
    previous.status = 'active'
    previous.activatedAt = now()
    previous.retiredAt = undefined
    this.state.evolutionPolicy = { ...previous.policy, updatedAt: now() }
    await this.save()
    return previous
  }

  async addEvolutionCycle(cycle: EvolutionCycle): Promise<EvolutionCycle> {
    const stored = sanitizeEvolutionCycle(cycle)
    if (!stored) throw new Error('Invalid evolution cycle')
    this.state.evolutionCycles.unshift(stored)
    // Kept until the user clears the history; see clearEvolutionHistory().
    await this.save()
    return stored
  }

  /**
   * The only path that removes evolution records. Cycles all go, retired policy
   * versions all go, and the version currently in force stays: dropping it would
   * silently fall back to built-in defaults, which is not what "clear history"
   * asks for.
   */
  async clearEvolutionHistory(): Promise<void> {
    this.state.evolutionCycles = []
    this.state.evolutionPolicyVersions = this.state.evolutionPolicyVersions.filter(
      (version) => version.status === 'active',
    )
    await this.save()
  }

  /** Aggregate evidence used when a meta proposal does not carry its own. */
  private aggregateEvidenceForPolicy(): ProfileEvidence {
    let runs = 0
    let failures = 0
    let steps = 0
    let tokens = 0
    let positive = 0
    let negative = 0
    let verified = 0
    for (const workspace of this.state.workspaces) {
      const evidence = this.evidence(workspace.path)
      runs += evidence.runs
      failures += evidence.failures
      steps += evidence.avgSteps * evidence.runs
      tokens += evidence.avgTokens * evidence.runs
      positive += evidence.positive
      negative += evidence.negative
      verified += evidence.verified ?? 0
    }
    return {
      runs,
      failures,
      avgSteps: runs ? Math.round((steps / runs) * 10) / 10 : 0,
      avgTokens: runs ? Math.round(tokens / runs) : 0,
      positive,
      negative,
      verified,
    }
  }
}
