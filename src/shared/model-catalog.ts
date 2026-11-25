/**
 * 模型目录：把「厂商 → 可用模型名」这件事收成纯数据 + 纯函数。
 *
 * 为什么需要它：厂商和 base URL 长期不变，模型名却随版本频繁调整，让用户
 * 背 `qwen3-coder-plus-2025-07-22` 这种字符串既容易打错、也容易停在旧版本上。
 *
 * 三层来源，优先级从高到低：
 * 1. live —— 用用户自己的 key 打厂商的 `GET {baseUrl}/models`，这是唯一权威来源；
 * 2. cache —— 上一次 live 的结果缓存在本机，离线或厂商临时不可用时继续可用；
 * 3. preset —— 下面这张内置清单，只在没有 key、或前两者都没有时出现。
 *
 * 任何一层都不能阻断手填：厂商可能不提供 `/models`、也可能刚发布还没进清单，
 * 所以输入框永远可以直接敲名字。
 */

/** 一个厂商的内置模型清单。`hosts` 只用于识别，不参与请求。 */
export interface ModelPresetProvider {
  id: string
  label: string
  /** 小写 host 片段，`contains` 匹配；越靠前的预设优先。 */
  hosts: string[]
  baseUrl: string
  /** 按推荐程度排列。可能过期，只作离线兜底，不覆盖 live 结果。 */
  models: string[]
}

/**
 * 内置清单。live 结果永远优先，这里只保证「没网、没 key、厂商不提供
 * `/models`」时也有东西可点，不至于退回全盲输入。
 */
export const PROVIDER_PRESETS: ModelPresetProvider[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    hosts: ['api.deepseek.com'],
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    id: 'qwen',
    label: '通义千问',
    hosts: ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com'],
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: [
      'qwen-max',
      'qwen-plus',
      'qwen-turbo',
      'qwen-long',
      'qwen3-coder-plus',
      'qwen-vl-max',
    ],
  },
  {
    id: 'glm',
    label: '智谱 GLM',
    hosts: ['open.bigmodel.cn', 'bigmodel.cn', 'api.z.ai'],
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4.6', 'glm-4.5', 'glm-4.5-air', 'glm-4-plus', 'glm-4-flash'],
  },
  {
    id: 'moonshot',
    label: 'Moonshot Kimi',
    hosts: ['api.moonshot.cn', 'api.moonshot.ai'],
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['kimi-k2-0905-preview', 'moonshot-v1-128k', 'moonshot-v1-32k', 'moonshot-v1-8k'],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    hosts: ['api.openai.com'],
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini', 'o3', 'o4-mini'],
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    hosts: ['api.anthropic.com'],
    baseUrl: 'https://api.anthropic.com/v1',
    models: ['claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-opus-4-1'],
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    hosts: ['generativelanguage.googleapis.com'],
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
  },
  {
    id: 'xai',
    label: 'xAI Grok',
    hosts: ['api.x.ai'],
    baseUrl: 'https://api.x.ai/v1',
    models: ['grok-4', 'grok-3', 'grok-3-mini'],
  },
  {
    id: 'mistral',
    label: 'Mistral',
    hosts: ['api.mistral.ai'],
    baseUrl: 'https://api.mistral.ai/v1',
    models: ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest'],
  },
  {
    id: 'siliconflow',
    label: 'SiliconFlow',
    hosts: ['api.siliconflow.cn'],
    baseUrl: 'https://api.siliconflow.cn/v1',
    // 聚合平台模型上千个，静态清单没有意义，只认 live。
    models: [],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    hosts: ['openrouter.ai'],
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [],
  },
  {
    id: 'ollama',
    label: 'Ollama（本地）',
    hosts: ['localhost:11434', '127.0.0.1:11434'],
    baseUrl: 'http://localhost:11434/v1',
    models: [],
  },
]

/** 明显不是对话模型的名称片段：仍然列出，但排到「其它」组里。 */
const NON_CHAT_PATTERN =
  /(embed|rerank|tts|whisper|transcri|speech|moderation|dall-e|stable-diffusion|\bflux\b|\bocr\b|audio|video|guard|sentinel|upscal|clip|bge-|gte-|m3e)/i

export function isNonChatModel(id: string): boolean {
  return NON_CHAT_PATTERN.test(id)
}

export function normalizeModelBaseUrl(baseUrl: string): string {
  return (baseUrl ?? '').trim().replace(/\/+$/, '')
}

/**
 * 本机端点（Ollama、LM Studio、各种本地推理服务）。
 *
 * 这类服务通常不校验密钥，所以「没有填 Key」不该成为拿不到列表的理由；
 * 反之远程端点在没有 Key 时发请求既没用也可能被判成异常访问，仍然不发。
 */
export function isLocalEndpoint(baseUrl: string): boolean {
  const normalized = normalizeModelBaseUrl(baseUrl).toLowerCase()
  if (!normalized) return false
  let host = ''
  try {
    host = new URL(normalized).hostname.toLowerCase()
  } catch {
    return false
  }
  if (!host) return false
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '0.0.0.0' || host === '[::1]' || host === '::1') return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

/** 按 host 认出厂商；认不出返回 null（第三方中转最常见）。 */
export function providerFor(baseUrl: string): ModelPresetProvider | null {
  const normalized = normalizeModelBaseUrl(baseUrl).toLowerCase()
  if (!normalized) return null
  let host = ''
  try {
    host = new URL(normalized).host.toLowerCase()
  } catch {
    host = normalized
  }
  return (
    PROVIDER_PRESETS.find((preset) =>
      preset.hosts.some((fragment) => host.includes(fragment.toLowerCase())),
    ) ?? null
  )
}

/** 目录来源，界面据此显示「厂商最新 / 本机缓存 / 内置清单」。 */
export type ModelCatalogSource = 'live' | 'cache' | 'preset'

export interface CatalogModel {
  id: string
  /** 对话/通用模型排前面，嵌入、语音、图像等排后面。 */
  group: 'chat' | 'other'
  /** 命中内置清单 = 已知的推荐模型，界面上排在最前并加标注。 */
  known: boolean
}

export interface ModelCatalog {
  /** 识别出的厂商；第三方中转时为 null。 */
  providerId: string | null
  providerLabel: string
  models: CatalogModel[]
  source: ModelCatalogSource
  /** live 成功拉取的时间；preset 时为空。 */
  fetchedAt?: string
  /** 需要告诉用户的一句话（key 缺失、拉取失败原因、缓存已过期）。 */
  note?: string
  /** 命中显示上限被截断。搜索仍在完整列表里进行由调用方负责。 */
  truncated: boolean
}

/** 一次最多渲染多少条：OpenRouter 这类聚合平台会返回上千个模型。 */
export const CATALOG_DISPLAY_LIMIT = 200

function uniqueModels(ids: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of ids) {
    const id = raw.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/**
 * 合并三层来源成一份可渲染的目录。
 *
 * - `live` 非空时它就是权威：内置清单里不在 live 中的旧名字不再列出，
 *   但「当前已填的值」永远保留在第一位（否则用户改不了旧模型）。
 * - `live` 为空时退回内置清单，`source` 由调用方给定。
 */
export function buildCatalog(input: {
  baseUrl: string
  current?: string
  live?: string[]
  fetchedAt?: string
  source: ModelCatalogSource
  note?: string
}): ModelCatalog {
  const provider = providerFor(input.baseUrl)
  const live = uniqueModels(input.live ?? [])
  const preset = provider?.models ?? []
  const current = (input.current ?? '').trim()

  const ordered: string[] = []
  if (current) ordered.push(current)

  if (live.length > 0) {
    // 先按内置清单的推荐顺序排已知模型，再补 live 里其余的。
    for (const id of preset) {
      if (live.includes(id)) ordered.push(id)
    }
    for (const id of live) ordered.push(id)
  } else {
    for (const id of preset) ordered.push(id)
  }

  const ids = uniqueModels(ordered)
  const knownSet = new Set(preset)
  const entries: CatalogModel[] = ids.map((id) => ({
    id,
    group: isNonChatModel(id) ? 'other' : 'chat',
    known: knownSet.has(id),
  }))

  // 当前值固定在最前；其余在组内保持来源顺序（live 顺序来自厂商，通常已是新版优先）。
  const head = current ? entries.filter((entry) => entry.id === current) : []
  const rest = entries.filter((entry) => !current || entry.id !== current)
  const chat = rest.filter((entry) => entry.group === 'chat')
  const other = rest.filter((entry) => entry.group === 'other')
  const merged = [...head, ...chat, ...other]
  const truncated = merged.length > CATALOG_DISPLAY_LIMIT

  return {
    providerId: provider?.id ?? null,
    providerLabel: provider?.label ?? '',
    models: truncated ? merged.slice(0, CATALOG_DISPLAY_LIMIT) : merged,
    source: input.source,
    ...(input.fetchedAt ? { fetchedAt: input.fetchedAt } : {}),
    ...(input.note ? { note: input.note } : {}),
    truncated,
  }
}

/** 从厂商 `/models` 的返回体里取模型名，兼容几种常见形状。 */
export function parseModelList(payload: unknown): string[] {
  if (Array.isArray(payload)) {
    return payload
      .map((item) => {
        if (typeof item === 'string') return item
        if (item && typeof item === 'object') {
          const bag = item as { id?: unknown; name?: unknown; model?: unknown }
          if (typeof bag.id === 'string') return bag.id
          if (typeof bag.name === 'string') return bag.name
          if (typeof bag.model === 'string') return bag.model
        }
        return ''
      })
      .filter((id) => id.length > 0)
  }
  if (!payload || typeof payload !== 'object') return []
  const bag = payload as { data?: unknown; models?: unknown; result?: unknown }
  for (const candidate of [bag.data, bag.models, bag.result]) {
    if (Array.isArray(candidate)) return parseModelList(candidate)
  }
  return []
}
