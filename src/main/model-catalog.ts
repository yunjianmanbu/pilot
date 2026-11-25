/**
 * 模型目录的主进程一侧：用用户自己的 key 问厂商要最新模型名，并缓存到本机。
 *
 * 这里只做三件事：挑正确的 URL（有些厂商的 base URL 不带 `/v1`）、解析返回体、
 * 把结果存进一份会过期的缓存。任何一步失败都不抛错 —— 一律降级成
 * 「缓存 / 内置清单 + 一句说明」，因为拉不到模型列表不该挡住保存配置。
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  buildCatalog,
  isLocalEndpoint,
  normalizeModelBaseUrl,
  parseModelList,
  providerFor,
  type ModelCatalog,
} from '../shared/model-catalog'

/** 同一次 live 结果在 6 小时内视为新鲜，打开设置页不再重复打厂商接口。 */
export const MODEL_CATALOG_TTL_MS = 6 * 60 * 60 * 1000
const REQUEST_TIMEOUT_MS = 15_000
const MAX_CACHE_ENTRIES = 20

interface CacheEntry {
  models: string[]
  at: string
  /** 毫秒时间戳，便于比较。 */
  atMs: number
  providerId: string | null
}

interface CacheFile {
  version: 1
  entries: Record<string, CacheEntry>
}

export interface DiscoverModelsInput {
  baseUrl: string
  apiKey?: string
  /** 资源里当前填写的模型名：不在任何清单里时也要留在下拉第一位。 */
  current?: string
  /** 界面的「刷新」：忽略新鲜缓存，真的打一次厂商接口。 */
  refresh?: boolean
  // 以下三项只为测试注入，生产调用不传。
  doFetch?: typeof fetch
  now?: () => number
  cacheFile?: string | null
}

/** 缓存键：端点 + key 的指纹。不同 key 的可见模型可能不同，所以分开存。 */
function cacheKey(baseUrl: string, apiKey: string): string {
  const fingerprint = apiKey
    ? createHash('sha256').update(apiKey).digest('hex').slice(0, 12)
    : 'anon'
  return `${normalizeModelBaseUrl(baseUrl)}::${fingerprint}`
}

async function userDataDir(): Promise<string | null> {
  try {
    const mod = (await import('electron')) as unknown as {
      app?: { getPath?: (name: string) => string }
      default?: { app?: { getPath?: (name: string) => string } }
    }
    const app = mod.app ?? mod.default?.app
    const dir = app?.getPath?.('userData')
    return typeof dir === 'string' && dir ? dir : null
  } catch {
    // 纯 Node 环境（单测、headless）：不落盘，只走内存。
    return null
  }
}

/** 内存缓存：同一次会话里反复打开设置页不重复读盘。 */
const memory = new Map<string, CacheEntry>()

async function readCacheFile(file: string | null): Promise<CacheFile> {
  if (!file) return { version: 1, entries: {} }
  try {
    const raw = await readFile(file, 'utf8')
    const parsed = JSON.parse(raw) as CacheFile
    if (!parsed || parsed.version !== 1 || typeof parsed.entries !== 'object') {
      return { version: 1, entries: {} }
    }
    return parsed
  } catch {
    return { version: 1, entries: {} }
  }
}

async function writeCacheFile(file: string | null, data: CacheFile): Promise<void> {
  if (!file) return
  try {
    // 只保留最近 MAX_CACHE_ENTRIES 条，避免文件无限增长。
    const entries = Object.entries(data.entries)
      .sort(([, left], [, right]) => right.atMs - left.atMs)
      .slice(0, MAX_CACHE_ENTRIES)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify({ version: 1, entries: Object.fromEntries(entries) }), 'utf8')
  } catch {
    // 缓存写不进去只影响下一次启动的离线可用性，不影响本次结果。
  }
}

/** 有些厂商的 base URL 到 `/v1` 为止，有些（如 GLM 的 `/api/paas/v4`）不带。 */
function modelEndpoints(baseUrl: string): string[] {
  const base = normalizeModelBaseUrl(baseUrl)
  if (!base) return []
  const list = [`${base}/models`]
  if (!/\/v\d+[a-z]*$/i.test(base)) list.push(`${base}/v1/models`)
  return list
}

function headersFor(baseUrl: string, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  // 本机端点（Ollama 等）不校验密钥，空 key 时不带鉴权头，也别带空 Bearer。
  if (!apiKey) return headers
  headers.Authorization = `Bearer ${apiKey}`
  // Anthropic 的原生端点只认 x-api-key，且缺少 anthropic-version 会直接 400；
  // 多带这两个头对其它厂商无副作用。
  if (normalizeModelBaseUrl(baseUrl).toLowerCase().includes('anthropic')) {
    headers['x-api-key'] = apiKey
    headers['anthropic-version'] = '2023-06-01'
  }
  return headers
}

function noteForStatus(status: number, host: string): string {
  if (status === 401 || status === 403) return `${host} 拒绝了这把密钥（${status}），先确认 Key 与地址属于同一厂商。`
  if (status === 404 || status === 405) return `${host} 这个地址不提供模型列表接口，请手动填写模型名。`
  if (status === 429) return `${host} 触发了限流（429），稍后点刷新重试。`
  return `${host} 返回 ${status}，暂时拿不到模型列表。`
}

function catalogFrom(
  entry: CacheEntry | null,
  input: DiscoverModelsInput,
  source: 'live' | 'cache' | 'preset',
  note?: string,
): ModelCatalog {
  return buildCatalog({
    baseUrl: input.baseUrl,
    current: input.current,
    live: entry?.models ?? [],
    ...(entry?.at ? { fetchedAt: entry.at } : {}),
    source,
    ...(note ? { note } : {}),
  })
}

/**
 * 拿一次模型目录。永不抛错：最差的情况是内置清单 + 一句说明。
 *
 * 顺序：新鲜的缓存 → 厂商 `/models` → 过期缓存 → 内置清单。
 */
export async function discoverModels(input: DiscoverModelsInput): Promise<ModelCatalog> {
  const baseUrl = normalizeModelBaseUrl(input.baseUrl)
  const apiKey = (input.apiKey ?? '').trim()
  if (!baseUrl) {
    return catalogFrom(null, input, 'preset', '先填写接口地址，再从下拉里选模型。')
  }

  const doFetch = input.doFetch ?? fetch
  const now = input.now ?? (() => Date.now())
  const file =
    input.cacheFile === undefined
      ? await userDataDir().then((dir) => (dir ? join(dir, 'model-catalog.json') : null))
      : input.cacheFile
  const key = cacheKey(baseUrl, apiKey)

  let entry = memory.get(key) ?? null
  // 磁盘缓存只在第一次用到时才读，避免纯内存场景每次拉列表都多一次 IO。
  let disk: CacheFile | null = null
  const loadDisk = async (): Promise<CacheFile> => {
    disk ??= await readCacheFile(file)
    return disk
  }
  if (!entry && file) {
    const stored = await loadDisk()
    const found = stored.entries[key]
    if (found && Array.isArray(found.models)) {
      entry = { ...found, atMs: found.atMs ?? (Date.parse(found.at) || 0) }
      memory.set(key, entry)
    }
  }

  const fresh = Boolean(entry && now() - entry.atMs < MODEL_CATALOG_TTL_MS)
  if (entry && fresh && !input.refresh) {
    return catalogFrom(entry, input, 'cache')
  }

  if (!apiKey && !isLocalEndpoint(baseUrl)) {
    const note = entry
      ? '没有可用密钥，先显示上次拉到的列表。'
      : '填入 API Key 后可以一键获取该厂商的最新模型名。'
    return catalogFrom(entry, input, entry ? 'cache' : 'preset', note)
  }

  let host = baseUrl
  try {
    host = new URL(baseUrl).host
  } catch {
    // 非法 URL 交给上层校验，这里只用原始串做提示。
  }

  for (const url of modelEndpoints(baseUrl)) {
    let response: Response
    try {
      response = await doFetch(url, {
        headers: headersFor(baseUrl, apiKey),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const note = entry
        ? `连不上 ${host}（${reason}），显示上次拉到的列表。`
        : `连不上 ${host}（${reason}），先用手填或内置清单。`
      return catalogFrom(entry, input, entry ? 'cache' : 'preset', note)
    }

    if (response.status === 404 || response.status === 405) {
      // 试下一个候选地址（`/models` ↔ `/v1/models`）。
      continue
    }
    if (!response.ok) {
      const note = noteForStatus(response.status, host)
      return catalogFrom(entry, input, entry ? 'cache' : 'preset', note)
    }

    let payload: unknown = null
    try {
      payload = await response.json()
    } catch {
      payload = null
    }
    const models = parseModelList(payload)
    if (models.length === 0) {
      const note = `${host} 返回了空的模型列表，先手动填写模型名。`
      return catalogFrom(entry, input, entry ? 'cache' : 'preset', note)
    }

    const at = new Date(now()).toISOString()
    const saved: CacheEntry = {
      models,
      at,
      atMs: now(),
      providerId: providerFor(baseUrl)?.id ?? null,
    }
    memory.set(key, saved)
    const stored = await loadDisk()
    stored.entries[key] = saved
    await writeCacheFile(file, stored)
    return catalogFrom(saved, input, 'live')
  }

  const note = entry
    ? `${host} 没有模型列表接口，显示上次拉到的列表；也可以直接手填模型名。`
    : `${host} 没有模型列表接口，请手动填写模型名。`
  return catalogFrom(entry, input, entry ? 'cache' : 'preset', note)
}

/** 单测用：清掉内存缓存，避免用例之间互相影响。 */
export function resetModelCatalogMemory(): void {
  memory.clear()
}
