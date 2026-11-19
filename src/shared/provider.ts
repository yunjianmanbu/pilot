/**
 * Vendor naming for user-facing copy.
 *
 * Pilot talks to any OpenAI-compatible endpoint: DeepSeek, Qwen/DashScope,
 * Zhipu GLM, OpenAI, or a self-hosted vLLM / Ollama / relay. Error and status
 * messages therefore have to name the endpoint the user actually configured.
 * Hardcoding one vendor makes a Qwen key rejection read as "DeepSeek rejected
 * the API key", which is the fastest way to lose a user's trust in the build.
 */

export type ProviderId = 'deepseek' | 'qwen' | 'glm' | 'openai' | 'moonshot' | 'custom'

export interface ProviderInfo {
  id: ProviderId
  /**
   * Sentence-initial display name: a known vendor name ("DeepSeek", "Qwen"),
   * the endpoint host for anything else ("10.0.0.7:8000"), or a neutral
   * fallback when the URL cannot be parsed.
   */
  label: string
}

/** Shown when no vendor is recognised and the host is unknown too. */
const NEUTRAL_LABEL = 'The model service'

/** Host of an OpenAI-compatible base URL (port kept), or '' when unparseable. */
export function providerHost(baseUrl: string): string {
  const raw = (baseUrl ?? '').trim()
  if (!raw) return ''
  try {
    return new URL(raw).host.toLowerCase()
  } catch {
    return ''
  }
}

/** Identify the endpoint behind a base URL, falling back to the model name. */
export function providerInfo(baseUrl: string, model?: string): ProviderInfo {
  const host = providerHost(baseUrl)
  if (host.includes('deepseek')) return { id: 'deepseek', label: 'DeepSeek' }
  if (host.includes('dashscope') || host.includes('aliyuncs.com')) {
    return { id: 'qwen', label: 'Qwen' }
  }
  if (host.includes('bigmodel.cn') || host === 'z.ai' || host.endsWith('.z.ai')) {
    return { id: 'glm', label: 'GLM' }
  }
  if (host.includes('moonshot')) return { id: 'moonshot', label: 'Moonshot' }
  if (host.includes('openai.com')) return { id: 'openai', label: 'OpenAI' }
  // A custom relay, an intranet gateway or a local server: the host itself is
  // the most useful thing to print, because that is what the user configured.
  if (host) return { id: 'custom', label: host }

  const name = (model ?? '').trim().toLowerCase()
  if (name.startsWith('deepseek')) return { id: 'deepseek', label: 'DeepSeek' }
  if (name.startsWith('qwen')) return { id: 'qwen', label: 'Qwen' }
  if (name.startsWith('glm')) return { id: 'glm', label: 'GLM' }
  return { id: 'custom', label: NEUTRAL_LABEL }
}

/** Convenience wrapper for message templates. */
export function providerLabel(baseUrl: string, model?: string): string {
  return providerInfo(baseUrl, model).label
}
