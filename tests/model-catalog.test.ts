import { mkdtemp, rm } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CATALOG_DISPLAY_LIMIT,
  buildCatalog,
  isLocalEndpoint,
  isNonChatModel,
  parseModelList,
  providerFor,
} from '../src/shared/model-catalog'
import {
  MODEL_CATALOG_TTL_MS,
  discoverModels,
  resetModelCatalogMemory,
} from '../src/main/model-catalog'

const cleanups: string[] = []

afterEach(async () => {
  while (cleanups.length) {
    const dir = cleanups.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
  resetModelCatalogMemory()
})

async function tempCache(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pilot-model-catalog-'))
  cleanups.push(dir)
  return join(dir, 'cache.json')
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('parseModelList', () => {
  it('reads the OpenAI shape', () => {
    expect(parseModelList({ object: 'list', data: [{ id: 'a' }, { id: 'b' }] })).toEqual(['a', 'b'])
  })

  it('reads a bare array of strings or objects', () => {
    expect(parseModelList(['a', 'b'])).toEqual(['a', 'b'])
    expect(parseModelList([{ name: 'x' }, { model: 'y' }])).toEqual(['x', 'y'])
  })

  it('reads the models/result shapes', () => {
    expect(parseModelList({ models: [{ id: 'm1' }] })).toEqual(['m1'])
    expect(parseModelList({ result: ['r1'] })).toEqual(['r1'])
  })

  it('never throws on junk', () => {
    expect(parseModelList(null)).toEqual([])
    expect(parseModelList('nope')).toEqual([])
    expect(parseModelList({ data: 'nope' })).toEqual([])
    expect(parseModelList([1, null, {}, ''])).toEqual([])
  })
})

describe('providerFor', () => {
  it('recognizes official hosts regardless of trailing slash or case', () => {
    expect(providerFor('https://api.deepseek.com')?.id).toBe('deepseek')
    expect(providerFor('https://API.DeepSeek.com/')?.id).toBe('deepseek')
    expect(providerFor('https://dashscope.aliyuncs.com/compatible-mode/v1')?.id).toBe('qwen')
    expect(providerFor('https://open.bigmodel.cn/api/paas/v4')?.id).toBe('glm')
  })

  it('returns null for a third-party relay, which has no preset', () => {
    expect(providerFor('https://my-relay.example.com/v1')).toBeNull()
    expect(providerFor('')).toBeNull()
  })
})

describe('isNonChatModel', () => {
  it('flags embedding and media models but not chat models', () => {
    expect(isNonChatModel('text-embedding-3-small')).toBe(true)
    expect(isNonChatModel('bge-m3')).toBe(true)
    expect(isNonChatModel('whisper-1')).toBe(true)
    expect(isNonChatModel('deepseek-chat')).toBe(false)
    expect(isNonChatModel('qwen-plus')).toBe(false)
  })
})

describe('buildCatalog', () => {
  it('treats the live list as authoritative and drops stale preset names', () => {
    const catalog = buildCatalog({
      baseUrl: 'https://api.deepseek.com',
      live: ['deepseek-chat', 'deepseek-v9'],
      source: 'live',
    })
    const ids = catalog.models.map((entry) => entry.id)
    expect(ids).toContain('deepseek-v9')
    // deepseek-reasoner 只在预设里，live 没返回就不该再出现。
    expect(ids).not.toContain('deepseek-reasoner')
    expect(catalog.source).toBe('live')
    expect(catalog.providerId).toBe('deepseek')
  })

  it('keeps the currently typed model first even when it is not in any list', () => {
    const catalog = buildCatalog({
      baseUrl: 'https://api.deepseek.com',
      current: 'my-finetune-2025',
      live: ['deepseek-chat'],
      source: 'live',
    })
    expect(catalog.models[0]?.id).toBe('my-finetune-2025')
  })

  it('falls back to the preset list when live is empty', () => {
    const catalog = buildCatalog({ baseUrl: 'https://api.deepseek.com', source: 'preset' })
    expect(catalog.models.map((entry) => entry.id)).toEqual(['deepseek-chat', 'deepseek-reasoner'])
  })

  it('sorts chat models before embeddings and de-duplicates', () => {
    const catalog = buildCatalog({
      baseUrl: 'https://relay.example.com/v1',
      live: ['text-embedding-3-small', 'gpt-4.1', 'gpt-4.1'],
      source: 'live',
    })
    const ids = catalog.models.map((entry) => entry.id)
    expect(ids).toEqual(['gpt-4.1', 'text-embedding-3-small'])
  })

  it('caps the rendered list and reports truncation', () => {
    const live = Array.from({ length: CATALOG_DISPLAY_LIMIT + 30 }, (_, index) => `m-${index}`)
    const catalog = buildCatalog({ baseUrl: 'https://relay.example.com/v1', live, source: 'live' })
    expect(catalog.models.length).toBe(CATALOG_DISPLAY_LIMIT)
    expect(catalog.truncated).toBe(true)
  })
})

describe('isLocalEndpoint', () => {
  it('accepts loopback hosts with any port, path or scheme', () => {
    expect(isLocalEndpoint('http://localhost:11434/v1')).toBe(true)
    expect(isLocalEndpoint('http://127.0.0.1:9411/v1/')).toBe(true)
    expect(isLocalEndpoint('http://127.1.2.3:8000')).toBe(true)
    expect(isLocalEndpoint('http://[::1]:1234/v1')).toBe(true)
    expect(isLocalEndpoint('http://ollama.localhost/v1')).toBe(true)
  })

  it('rejects remote hosts, relays and junk', () => {
    expect(isLocalEndpoint('https://api.deepseek.com')).toBe(false)
    expect(isLocalEndpoint('https://relay.example.com/v1')).toBe(false)
    // 形似但不是回环地址的写法不能放行，否则等于允许无 key 外发请求。
    expect(isLocalEndpoint('https://localhost.example.com/v1')).toBe(false)
    expect(isLocalEndpoint('https://10.0.0.5/v1')).toBe(false)
    expect(isLocalEndpoint('not a url')).toBe(false)
    expect(isLocalEndpoint('')).toBe(false)
  })
})

describe('discoverModels', () => {
  const baseUrl = 'https://api.deepseek.com'

  it('returns the built-in list and a hint when no key is available', async () => {
    const cacheFile = await tempCache()
    const doFetch = vi.fn()
    const catalog = await discoverModels({ baseUrl, cacheFile, doFetch: doFetch as never })
    expect(doFetch).not.toHaveBeenCalled()
    expect(catalog.source).toBe('preset')
    expect(catalog.models.map((entry) => entry.id)).toContain('deepseek-chat')
    expect(catalog.note).toContain('API Key')
  })

  it('still fetches a loopback endpoint without a key, sending no auth header', async () => {
    const cacheFile = await tempCache()
    const doFetch = vi.fn(async () => jsonResponse({ data: [{ id: 'llama3.2:3b' }] }))
    const catalog = await discoverModels({
      baseUrl: 'http://127.0.0.1:11434/v1',
      cacheFile,
      doFetch: doFetch as never,
    })
    expect(doFetch).toHaveBeenCalledTimes(1)
    const headers = (doFetch.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<
      string,
      string
    >
    expect(headers.Authorization).toBeUndefined()
    expect(catalog.source).toBe('live')
    expect(catalog.models.map((entry) => entry.id)).toEqual(['llama3.2:3b'])
  })

  it('sends the Anthropic-native auth headers, including the required version', async () => {
    const cacheFile = await tempCache()
    const doFetch = vi.fn(async () =>
      jsonResponse({ data: [{ id: 'claude-sonnet-4-5' }], has_more: false }),
    )
    const catalog = await discoverModels({
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-ant-test',
      cacheFile,
      doFetch: doFetch as never,
    })
    const headers = (doFetch.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<
      string,
      string
    >
    expect(headers['x-api-key']).toBe('sk-ant-test')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(catalog.source).toBe('live')
    expect(catalog.models.map((entry) => entry.id)).toEqual(['claude-sonnet-4-5'])
  })

  it('fetches live models, marks them known, and caches to disk', async () => {
    const cacheFile = await tempCache()
    const doFetch = vi.fn(async () => jsonResponse({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-v9' }] }))
    const catalog = await discoverModels({ baseUrl, apiKey: 'sk-test', cacheFile, doFetch: doFetch as never })
    expect(catalog.source).toBe('live')
    expect(catalog.models.map((entry) => entry.id)).toEqual(['deepseek-chat', 'deepseek-v9'])
    // 预设里有的名字带「推荐」标记，只有 live 才有的不算。
    expect(catalog.models.find((entry) => entry.id === 'deepseek-chat')?.known).toBe(true)
    expect(catalog.models.find((entry) => entry.id === 'deepseek-v9')?.known).toBe(false)

    const stored = JSON.parse(await readFile(cacheFile, 'utf8'))
    expect(Object.values(stored.entries)).toHaveLength(1)
    // 缓存里不能出现明文密钥。
    expect(await readFile(cacheFile, 'utf8')).not.toContain('sk-test')
  })

  it('serves a fresh cache without hitting the network again', async () => {
    const cacheFile = await tempCache()
    const first = vi.fn(async () => jsonResponse({ data: [{ id: 'deepseek-chat' }] }))
    await discoverModels({ baseUrl, apiKey: 'sk-test', cacheFile, doFetch: first as never })
    resetModelCatalogMemory()
    const second = vi.fn(async () => jsonResponse({ data: [{ id: 'should-not-be-used' }] }))
    const catalog = await discoverModels({ baseUrl, apiKey: 'sk-test', cacheFile, doFetch: second as never })
    expect(second).not.toHaveBeenCalled()
    expect(catalog.source).toBe('cache')
    expect(catalog.models[0]?.id).toBe('deepseek-chat')
  })

  it('re-fetches when refresh is requested even inside the TTL', async () => {
    const cacheFile = await tempCache()
    const first = vi.fn(async () => jsonResponse({ data: [{ id: 'old' }] }))
    await discoverModels({ baseUrl, apiKey: 'sk-test', cacheFile, doFetch: first as never })
    const second = vi.fn(async () => jsonResponse({ data: [{ id: 'new' }] }))
    const catalog = await discoverModels({
      baseUrl,
      apiKey: 'sk-test',
      cacheFile,
      refresh: true,
      doFetch: second as never,
    })
    expect(second).toHaveBeenCalledTimes(1)
    expect(catalog.models.map((entry) => entry.id)).toEqual(['new'])
  })

  it('re-uses the cache after the TTL expires but the network fails', async () => {
    const cacheFile = await tempCache()
    let now = Date.now()
    const ok = vi.fn(async () => jsonResponse({ data: [{ id: 'deepseek-chat' }] }))
    await discoverModels({ baseUrl, apiKey: 'sk-test', cacheFile, doFetch: ok as never, now: () => now })
    resetModelCatalogMemory()
    now += MODEL_CATALOG_TTL_MS + 1000
    const failing = vi.fn(async () => {
      throw new Error('ECONNRESET')
    })
    const catalog = await discoverModels({
      baseUrl,
      apiKey: 'sk-test',
      cacheFile,
      doFetch: failing as never,
      now: () => now,
    })
    expect(catalog.source).toBe('cache')
    expect(catalog.models.map((entry) => entry.id)).toEqual(['deepseek-chat'])
    expect(catalog.note).toContain('ECONNRESET')
  })

  it('falls back to the preset with an actionable note on 401', async () => {
    const cacheFile = await tempCache()
    const doFetch = vi.fn(async () => jsonResponse({ error: 'bad key' }, 401))
    const catalog = await discoverModels({ baseUrl, apiKey: 'sk-wrong', cacheFile, doFetch: doFetch as never })
    expect(catalog.source).toBe('preset')
    expect(catalog.note).toContain('401')
    expect(catalog.models.map((entry) => entry.id)).toContain('deepseek-chat')
  })

  it('tries {base}/v1/models when the bare /models endpoint is missing', async () => {
    const cacheFile = await tempCache()
    const calls: string[] = []
    const doFetch = vi.fn(async (url: string) => {
      calls.push(url)
      if (url.endsWith('/v1/models')) return jsonResponse({ data: [{ id: 'glm-4.6' }] })
      return jsonResponse({}, 404)
    })
    const catalog = await discoverModels({
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'sk-test',
      cacheFile,
      doFetch: doFetch as never,
    })
    // /api/paas/v4 已经带版本号，只试一个地址；404 后不再加 /v1。
    expect(calls).toEqual(['https://open.bigmodel.cn/api/paas/v4/models'])
    expect(catalog.source).toBe('preset')
  })

  it('probes both candidates for a versionless base URL', async () => {
    const cacheFile = await tempCache()
    const calls: string[] = []
    const doFetch = vi.fn(async (url: string) => {
      calls.push(url)
      if (url.endsWith('/v1/models')) return jsonResponse({ data: [{ id: 'm' }] })
      return jsonResponse({}, 404)
    })
    const catalog = await discoverModels({
      baseUrl: 'https://relay.example.com',
      apiKey: 'sk-test',
      cacheFile,
      doFetch: doFetch as never,
    })
    expect(calls).toEqual([
      'https://relay.example.com/models',
      'https://relay.example.com/v1/models',
    ])
    expect(catalog.source).toBe('live')
  })

  it('treats an empty model list as a soft failure', async () => {
    const cacheFile = await tempCache()
    const doFetch = vi.fn(async () => jsonResponse({ data: [] }))
    const catalog = await discoverModels({ baseUrl, apiKey: 'sk-test', cacheFile, doFetch: doFetch as never })
    expect(catalog.source).toBe('preset')
    expect(catalog.note).toContain('空')
  })

  it('never throws for an unusable base URL', async () => {
    const cacheFile = await tempCache()
    const catalog = await discoverModels({ baseUrl: '   ', cacheFile, doFetch: vi.fn() as never })
    expect(catalog.source).toBe('preset')
    expect(catalog.note).toBeTruthy()
  })

  it('keeps separate caches per key, since visibility can differ', async () => {
    const cacheFile = await tempCache()
    const keyA = vi.fn(async () => jsonResponse({ data: [{ id: 'only-a' }] }))
    await discoverModels({ baseUrl, apiKey: 'sk-a', cacheFile, doFetch: keyA as never })
    const keyB = vi.fn(async () => jsonResponse({ data: [{ id: 'only-b' }] }))
    const catalog = await discoverModels({ baseUrl, apiKey: 'sk-b', cacheFile, doFetch: keyB as never })
    expect(keyB).toHaveBeenCalledTimes(1)
    expect(catalog.models.map((entry) => entry.id)).toEqual(['only-b'])
  })
})
