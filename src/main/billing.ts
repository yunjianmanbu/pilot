/**
 * Model billing for the saved API key: the provider's own balance, plus a cost
 * estimate for the token usage Pilot recorded locally.
 *
 * The provider exposes a balance endpoint but no per-key spend endpoint, so the
 * spend number is an estimate: tokens come from `RunRecord`s, prices from
 * `shared/billing.ts`. Nothing here reads or returns the API key.
 *
 * Balance APIs differ by provider:
 * - DeepSeek (and DeepSeek-style relays): `GET /user/balance`.
 * - Zhipu GLM: the console's account report, with the legacy
 *   `/api/paas/v4/balance` as a fallback.
 * - DashScope (Qwen): a `sk-` model key has no balance endpoint. A relay may
 *   still expose `/user/balance`; the official host is reported as unsupported
 *   instead of inventing a number.
 */

import {
  PRICE_SOURCE,
  PRICE_UPDATED_AT,
  summarizeUsage,
  type BillingRun,
} from '../shared/billing'
import type {
  ModelBalanceEntry,
  ModelBalanceState,
  ModelBillingAccount,
  ModelBillingReport,
} from '../shared/types'

/**
 * One endpoint whose balance should be reported. Carries the key so the main
 * process can call the provider; never returned to the renderer or the phone.
 */
export interface BillingAccount {
  id: string
  label: string
  role: 'primary' | 'judge'
  baseUrl: string
  model: string
  enabled: boolean
  apiKey: string
}

/** Store surface this module needs; keeps the module testable without Electron. */
export interface BillingStore {
  getApiKey(): string | null
  settings(): { baseUrl: string; model: string }
  workspaces(): Array<{ path: string }>
  runs(workspacePath: string): BillingRun[]
  /** Every configured model endpoint, primary first. */
  billingAccounts?(): BillingAccount[]
}

export interface BillingOptions {
  store: BillingStore
  fetchImpl?: typeof fetch
  /** Balance cache lifetime; a manual refresh bypasses it. */
  ttlMs?: number
  now?: () => Date
}

const DEFAULT_TTL_MS = 60_000
const REQUEST_TIMEOUT_MS = 12_000
const DASHSCOPE_BALANCE_NOTE =
  'DashScope 的 sk- API Key 不提供余额接口；请在阿里云费用中心查看，或使用具有 bss:QueryAccountBalance 权限的 RAM AccessKey。'

interface BalancePayload {
  is_available?: boolean
  balance_infos?: Array<{
    currency?: string
    total_balance?: string
    granted_balance?: string
    topped_up_balance?: string
  }>
}

interface GlmAccountPayload {
  success?: boolean
  code?: number | string
  msg?: string
  data?: {
    balance?: number | string | null
    availableBalance?: number | string | null
    frozenBalance?: number | string | null
    rechargeAmount?: number | string | null
    giveAmount?: number | string | null
    totalSpendAmount?: number | string | null
    currency?: string | null
  } | null
}

interface GlmLegacyPayload {
  data?: {
    total_balance?: number | string | null
    available_balance?: number | string | null
    currency?: string | null
  } | null
}

export type BalanceFlavor = 'deepseek' | 'qwen' | 'glm'

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '') || 'https://api.deepseek.com'
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(normalizeBaseUrl(baseUrl)).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** Pick the balance protocol from the endpoint and, when known, the model. */
export function balanceFlavor(baseUrl: string, model?: string): BalanceFlavor {
  const host = hostOf(baseUrl)
  // The host decides for official providers. For a third-party relay, fall
  // back to the DeepSeek-style `/user/balance` convention regardless of the
  // model name; deriving a vendor console route on an unknown host would send
  // the key to a path that does not exist and hide a working relay endpoint.
  if (host.includes('bigmodel.cn') || host.endsWith('z.ai')) return 'glm'
  if (host.includes('dashscope') || host.includes('aliyuncs.com')) return 'qwen'
  if (!host) {
    const name = (model ?? '').trim().toLowerCase()
    if (name.startsWith('glm-')) return 'glm'
    if (name.startsWith('qwen')) return 'qwen'
  }
  return 'deepseek'
}

function sourceFor(baseUrl: string, flavor: BalanceFlavor): string {
  const base = normalizeBaseUrl(baseUrl)
  if (flavor === 'glm') {
    try {
      return `${new URL(base).origin}/api/biz/account/query-customer-account-report`
    } catch {
      return 'https://open.bigmodel.cn/api/biz/account/query-customer-account-report'
    }
  }
  return `${base}/user/balance`
}

function redact(text: string, secret: string): string {
  const key = secret.trim()
  return key ? text.split(key).join('[redacted]') : text
}

function errorState(
  source: string,
  fetchedAt: string,
  error: NonNullable<ModelBalanceState['error']>,
  detail?: string,
): ModelBalanceState {
  return {
    ok: false,
    available: false,
    entries: [],
    source,
    fetchedAt,
    error,
    ...(detail ? { errorDetail: detail } : {}),
  }
}

type RawResult =
  | { ok: true; response: Response }
  | { ok: false; detail: string }

async function requestBalance(
  url: string,
  apiKey: string,
  auth: 'bearer' | 'raw',
  doFetch: typeof fetch,
): Promise<RawResult> {
  try {
    const response = await doFetch(url, {
      headers: {
        Authorization: auth === 'raw' ? apiKey : `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    return { ok: true, response }
  } catch (error) {
    return {
      ok: false,
      detail: redact(error instanceof Error ? error.message : String(error), apiKey),
    }
  }
}

async function httpFailure(
  response: Response,
  apiKey: string,
): Promise<NonNullable<ModelBalanceState['error']>> {
  if (response.status === 401 || response.status === 403) return 'unauthorized'
  if (response.status === 404 || response.status === 405) return 'unsupported'
  return 'error'
}

async function responseDetail(response: Response, apiKey: string): Promise<string> {
  const body = await response.text().catch(() => '')
  return redact(body.trim(), apiKey).slice(0, 300)
}

function entryFromDeepSeek(
  payload: BalancePayload,
): { entries: ModelBalanceEntry[]; available: boolean } {
  const entries: ModelBalanceEntry[] = (payload.balance_infos ?? [])
    .filter(
      (entry) =>
        typeof entry?.total_balance === 'string' || typeof entry?.currency === 'string',
    )
    .map((entry) => ({
      currency: String(entry.currency ?? '').trim() || 'CNY',
      totalBalance: String(entry.total_balance ?? '').trim(),
      grantedBalance: String(entry.granted_balance ?? '').trim(),
      toppedUpBalance: String(entry.topped_up_balance ?? '').trim(),
    }))
  return { entries, available: payload.is_available !== false }
}

async function fetchDeepSeekBalance(input: {
  apiKey: string
  baseUrl: string
  source: string
  at: string
  doFetch: typeof fetch
}): Promise<ModelBalanceState> {
  const result = await requestBalance(input.source, input.apiKey, 'bearer', input.doFetch)
  if (!result.ok) {
    return errorState(input.source, input.at, 'network', result.detail)
  }
  const { response } = result
  if (!response.ok) {
    const code = await httpFailure(response, input.apiKey)
    return errorState(
      input.source,
      input.at,
      code,
      `${response.status} ${await responseDetail(response, input.apiKey)}`.trim(),
    )
  }

  let payload: BalancePayload
  try {
    payload = (await response.json()) as BalancePayload
  } catch {
    return errorState(input.source, input.at, 'invalid-response')
  }
  const { entries, available } = entryFromDeepSeek(payload)
  if (entries.length === 0) return errorState(input.source, input.at, 'invalid-response')
  return {
    ok: true,
    available,
    entries,
    source: input.source,
    fetchedAt: input.at,
  }
}

function numericText(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return ''
  const text = String(value).trim()
  if (!text) return ''
  const numeric = Number(text)
  return Number.isFinite(numeric) ? text : ''
}

function availableFromNumeric(value: string): boolean {
  if (!value) return true
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric > 0 : true
}

function glmEntry(data: NonNullable<GlmAccountPayload['data']>): ModelBalanceEntry | null {
  // The account report exposes `availableBalance`; `balance` is the fallback
  // used by older responses, and a null available value must not become 0.
  const total = numericText(data.availableBalance) || numericText(data.balance)
  if (!total) return null
  return {
    currency: (data.currency ?? '').trim() || 'CNY',
    totalBalance: total,
    grantedBalance: numericText(data.giveAmount),
    toppedUpBalance: numericText(data.rechargeAmount),
  }
}

async function parseGlmAccount(
  response: Response,
  apiKey: string,
  source: string,
  at: string,
): Promise<ModelBalanceState | 'fallback'> {
  if (!response.ok) {
    if (response.status === 404 || response.status === 405) return 'fallback'
    const code = await httpFailure(response, apiKey)
    return errorState(
      source,
      at,
      code,
      `${response.status} ${await responseDetail(response, apiKey)}`.trim(),
    )
  }

  let payload: GlmAccountPayload
  try {
    payload = (await response.json()) as GlmAccountPayload
  } catch {
    return 'fallback'
  }
  if (payload.success === false) {
    const codeText = String(payload.code ?? '')
    const code = codeText === '401' || codeText === '1001' ? 'unauthorized' : 'error'
    const detail = redact(
      [String(payload.code ?? ''), String(payload.msg ?? '')].filter(Boolean).join(' '),
      apiKey,
    ).slice(0, 300)
    return errorState(source, at, code, detail || undefined)
  }
  const entry = payload.data ? glmEntry(payload.data) : null
  if (!entry) return 'fallback'
  return {
    ok: true,
    available: availableFromNumeric(entry.totalBalance),
    entries: [entry],
    source,
    fetchedAt: at,
  }
}

async function fetchGlmBalance(input: {
  apiKey: string
  baseUrl: string
  at: string
  doFetch: typeof fetch
}): Promise<ModelBalanceState> {
  let origin = 'https://open.bigmodel.cn'
  try {
    origin = new URL(normalizeBaseUrl(input.baseUrl)).origin
  } catch {
    // Keep the official origin when the user typed something unparsable.
  }
  const accountSource = `${origin}/api/biz/account/query-customer-account-report`
  const legacySource = `${origin}/api/paas/v4/balance`
  const auth: 'bearer' | 'raw' = hostOf(input.baseUrl).endsWith('z.ai') ? 'bearer' : 'raw'
  if (normalizeBaseUrl(input.baseUrl).includes('/api/coding/')) {
    return errorState(
      accountSource,
      input.at,
      'unsupported',
      'GLM Coding Plan 使用订阅额度，不返回现金余额；请在智谱控制台查看套餐用量。',
    )
  }

  const account = await requestBalance(
    accountSource,
    input.apiKey,
    auth,
    input.doFetch,
  )
  if (!account.ok) {
    return errorState(accountSource, input.at, 'network', account.detail)
  }
  const accountState = await parseGlmAccount(
    account.response,
    input.apiKey,
    accountSource,
    input.at,
  )
  if (accountState !== 'fallback') return accountState

  const legacy = await requestBalance(legacySource, input.apiKey, auth, input.doFetch)
  if (!legacy.ok) {
    return errorState(legacySource, input.at, 'network', legacy.detail)
  }
  const { response } = legacy
  if (!response.ok) {
    const code = await httpFailure(response, input.apiKey)
    return errorState(
      legacySource,
      input.at,
      code,
      `${response.status} ${await responseDetail(response, input.apiKey)}`.trim(),
    )
  }

  let payload: GlmLegacyPayload
  try {
    payload = (await response.json()) as GlmLegacyPayload
  } catch {
    return errorState(legacySource, input.at, 'invalid-response')
  }
  const data = payload.data
  const total = numericText(data?.available_balance) || numericText(data?.total_balance)
  if (!data || !total) return errorState(legacySource, input.at, 'invalid-response')
  return {
    ok: true,
    available: availableFromNumeric(total),
    entries: [
      {
        currency: (data.currency ?? '').trim() || 'CNY',
        totalBalance: total,
        grantedBalance: '',
        toppedUpBalance: '',
      },
    ],
    source: legacySource,
    fetchedAt: input.at,
  }
}

async function fetchQwenBalance(input: {
  apiKey: string
  baseUrl: string
  source: string
  at: string
  doFetch: typeof fetch
}): Promise<ModelBalanceState> {
  // A third-party OpenAI-compatible relay may expose the DeepSeek-style
  // endpoint. The official DashScope host does not, so a 404 becomes an
  // explicit unsupported state with instructions rather than a fake number.
  const result = await requestBalance(input.source, input.apiKey, 'bearer', input.doFetch)
  if (!result.ok) {
    return errorState(input.source, input.at, 'network', result.detail)
  }
  const { response } = result
  if (!response.ok) {
    const status = response.status
    if (status === 404 || status === 405) {
      return errorState(input.source, input.at, 'unsupported', DASHSCOPE_BALANCE_NOTE)
    }
    const code = await httpFailure(response, input.apiKey)
    return errorState(
      input.source,
      input.at,
      code,
      `${status} ${await responseDetail(response, input.apiKey)}`.trim(),
    )
  }

  let payload: BalancePayload
  try {
    payload = (await response.json()) as BalancePayload
  } catch {
    return errorState(input.source, input.at, 'invalid-response')
  }
  const { entries, available } = entryFromDeepSeek(payload)
  if (entries.length === 0) return errorState(input.source, input.at, 'invalid-response')
  return {
    ok: true,
    available,
    entries,
    source: input.source,
    fetchedAt: input.at,
  }
}

/**
 * Read the balance behind one key. Any failure is reported as state, never
 * thrown: a provider without a balance endpoint must not break Settings.
 */
export async function fetchBalance(input: {
  apiKey: string
  baseUrl: string
  model?: string
  fetchImpl?: typeof fetch
  now?: () => Date
}): Promise<ModelBalanceState> {
  const at = (input.now ?? (() => new Date()))().toISOString()
  const flavor = balanceFlavor(input.baseUrl, input.model)
  const source = sourceFor(input.baseUrl, flavor)
  const apiKey = input.apiKey.trim()
  if (!apiKey) return errorState(source, at, 'missing-key')

  const doFetch = input.fetchImpl ?? fetch
  if (flavor === 'glm') {
    return fetchGlmBalance({ apiKey, baseUrl: input.baseUrl, at, doFetch })
  }
  if (flavor === 'qwen') {
    return fetchQwenBalance({ apiKey, baseUrl: input.baseUrl, source, at, doFetch })
  }
  return fetchDeepSeekBalance({ apiKey, baseUrl: input.baseUrl, source, at, doFetch })
}

/** Every run Pilot recorded locally, newest workspace first. */
export function collectRuns(store: BillingStore): BillingRun[] {
  const runs: BillingRun[] = []
  for (const workspace of store.workspaces()) {
    try {
      runs.push(...store.runs(workspace.path))
    } catch {
      // A workspace removed between the listing and the read is not an error.
    }
  }
  return runs
}

export class BillingService {
  private cached: { at: number; state: ModelBalanceState } | null = null
  private inFlight: Promise<ModelBalanceState> | null = null
  private readonly accountCache = new Map<string, { at: number; state: ModelBalanceState }>()
  private readonly accountInFlight = new Map<string, Promise<ModelBalanceState>>()

  constructor(private readonly options: BillingOptions) {}

  /** Drop the cached balance, e.g. after the key or base URL changed. */
  invalidate(): void {
    this.cached = null
    this.accountCache.clear()
  }

  private now(): Date {
    return this.options.now?.() ?? new Date()
  }

  async balance(refresh = false): Promise<ModelBalanceState> {
    const now = this.now().getTime()
    const ttl = this.options.ttlMs ?? DEFAULT_TTL_MS
    if (!refresh && this.cached && now - this.cached.at < ttl) return this.cached.state
    if (this.inFlight) return this.inFlight
    const settings = this.options.store.settings()
    const request = fetchBalance({
      apiKey: this.options.store.getApiKey() ?? '',
      baseUrl: settings.baseUrl,
      model: settings.model,
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
      now: () => this.now(),
    })
      .then((state) => {
        this.cached = { at: now, state }
        return state
      })
      .finally(() => {
        this.inFlight = null
      })
    this.inFlight = request
    return request
  }

  /** Balance for one configured endpoint. `primary` reuses the main cache. */
  private async accountBalance(
    account: BillingAccount,
    refresh: boolean,
  ): Promise<ModelBalanceState> {
    if (account.role === 'primary') return this.balance(refresh)
    const fetchedAt = this.now().toISOString()
    if (!account.apiKey.trim()) {
      return {
        ok: false,
        available: false,
        entries: [],
        source: sourceFor(account.baseUrl, balanceFlavor(account.baseUrl, account.model)),
        fetchedAt,
        error: 'missing-key',
        errorDetail: '该模型还没有保存可用的密钥。',
      }
    }
    const now = this.now().getTime()
    const ttl = this.options.ttlMs ?? DEFAULT_TTL_MS
    const cached = this.accountCache.get(account.id)
    if (!refresh && cached && now - cached.at < ttl) return cached.state
    const pending = this.accountInFlight.get(account.id)
    if (pending) return pending
    const request = fetchBalance({
      apiKey: account.apiKey,
      baseUrl: account.baseUrl,
      model: account.model,
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
      now: () => this.now(),
    })
      .then((state) => {
        this.accountCache.set(account.id, { at: now, state })
        return state
      })
      .finally(() => {
        this.accountInFlight.delete(account.id)
      })
    this.accountInFlight.set(account.id, request)
    return request
  }

  async report(refresh = false): Promise<ModelBillingReport> {
    const settings = this.options.store.settings()
    const checkedAt = this.now().toISOString()
    const accounts = this.options.store.billingAccounts?.() ?? [
      {
        id: 'primary',
        label: '',
        role: 'primary' as const,
        baseUrl: settings.baseUrl,
        model: settings.model,
        enabled: true,
        apiKey: this.options.store.getApiKey() ?? '',
      },
    ]
    const balances = await Promise.all(
      accounts.map((account) => this.accountBalance(account, refresh)),
    )
    const primaryIndex = Math.max(
      0,
      accounts.findIndex((account) => account.role === 'primary'),
    )
    const billingAccounts: ModelBillingAccount[] = accounts.map((account, index) => ({
      id: account.id,
      label: account.label,
      role: account.role,
      baseUrl: account.baseUrl,
      model: account.model,
      enabled: account.enabled,
      balance: balances[index]!,
    }))
    return {
      hasKey: Boolean(this.options.store.getApiKey()),
      baseUrl: settings.baseUrl,
      model: settings.model,
      balance: balances[primaryIndex] ?? (await this.balance(refresh)),
      usage: summarizeUsage(collectRuns(this.options.store)),
      accounts: billingAccounts,
      priceSource: `${PRICE_SOURCE} (${PRICE_UPDATED_AT})`,
      checkedAt,
    }
  }
}
