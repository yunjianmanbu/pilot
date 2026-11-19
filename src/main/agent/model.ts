import { isEmptyAssistant } from './message-guard'
import type { AgentMessage, AgentToolDefinition, AgentUsage, ToolCall } from '../../shared/types'
import { effectiveOutputTokens } from '../../shared/modelLimits'
import { providerLabel } from '../../shared/provider'
import type { ModelClient, ModelRequest, ModelResponse } from './loop'

export interface DeepSeekConfig {
  apiKey: string
  baseUrl: string
  model: string
  maxOutputTokens: number
  temperature: number
}

export class ModelError extends Error {
  readonly status: number | null

  constructor(message: string, status: number | null = null) {
    super(message)
    this.name = 'ModelError'
    this.status = status
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '') || 'https://api.deepseek.com'
}

function endpoint(baseUrl: string, path: string): string {
  return `${normalizeBaseUrl(baseUrl)}${path}`
}

interface OpenAIToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

type OpenAIMessage =
  | { role: 'system' | 'user'; content: string | OpenAIContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

function toOpenAIContent(message: AgentMessage): string | OpenAIContentPart[] {
  if (!message.images || message.images.length === 0) return message.content
  const parts: OpenAIContentPart[] = []
  if (message.content.trim()) parts.push({ type: 'text', text: message.content })
  for (const url of message.images) {
    parts.push({ type: 'image_url', image_url: { url } })
  }
  return parts
}

/**
 * A model turn that carried only reasoning ends up as an assistant message with
 * no content and no tool calls. Sending it makes the provider reject the whole
 * request (see `isEmptyAssistant`), which poisons every later turn of a session.
 */
function toOpenAIMessages(messages: AgentMessage[]): OpenAIMessage[] {
  const callIds = new Set<string>()
  for (const message of messages) {
    if (isEmptyAssistant(message)) continue
    for (const call of message.toolCalls ?? []) callIds.add(call.id)
  }
  const result: OpenAIMessage[] = []
  for (const message of messages) {
    if (isEmptyAssistant(message)) continue
    // A tool result whose call is no longer in the request is an orphan the
    // provider rejects, so it is dropped together with its assistant turn.
    if (message.role === 'tool' && message.toolCallId && !callIds.has(message.toolCallId)) {
      continue
    }
    result.push(toOpenAIMessage(message))
  }
  return result
}

function toOpenAIMessage(message: AgentMessage): OpenAIMessage {
  if (message.role === 'assistant') {
    return {
      role: 'assistant',
      content: message.content || null,
      ...(message.toolCalls && message.toolCalls.length > 0
        ? {
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: 'function' as const,
              function: {
                name: call.name,
                arguments: JSON.stringify(call.arguments ?? {}),
              },
            })),
          }
        : {}),
    }
  }
  if (message.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: message.toolCallId ?? '',
      content: message.content,
    }
  }
  return {
    role: message.role,
    content:
      message.role === 'user' ? toOpenAIContent(message) : message.content,
  }
}

function toOpenAITools(tools: AgentToolDefinition[]): Array<{
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}> {
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }))
}

function parseArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Surface invalid JSON to the tool layer instead of dropping the call.
  }
  return { _raw: raw }
}

function friendlyHttpError(status: number, body: string, provider: string): string {
  let detail = body.trim().slice(0, 500)
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } }
    if (parsed.error?.message) detail = parsed.error.message
  } catch {
    // Keep the text body.
  }
  if (status === 401) {
    return `${provider} rejected the API key (401). Check it in Settings. ${detail}`
  }
  if (status === 402) return `${provider} reports insufficient balance (402). ${detail}`
  if (status === 429) {
    return `${provider} rate limit reached (429). Wait a moment and retry. ${detail}`
  }
  if (status === 400) return `${provider} rejected the request (400): ${detail}`
  if (status >= 500) return `${provider} is unavailable (${status}): ${detail}`
  return `${provider} request failed (${status}): ${detail}`
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  return Boolean(
    signal?.aborted ||
      (error instanceof Error &&
        (error.name === 'AbortError' || error.message.toLowerCase().includes('aborted'))),
  )
}

async function waitForRetry(ms: number, signal: AbortSignal | undefined): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('Aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function postCompletion(
  config: DeepSeekConfig,
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<Response> {
  const provider = providerLabel(config.baseUrl, config.model)
  let lastError: unknown = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (signal?.aborted) throw new Error('Aborted')
    try {
      const response = await fetch(endpoint(config.baseUrl, '/chat/completions'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      })
      if (response.ok) return response
      const text = await response.text().catch(() => '')
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        await waitForRetry(700 * 2 ** attempt, signal)
        continue
      }
      throw new ModelError(friendlyHttpError(response.status, text, provider), response.status)
    } catch (error) {
      if (isAbort(error, signal)) throw error
      if (error instanceof ModelError) throw error
      lastError = error
      if (attempt < 2) {
        await waitForRetry(700 * 2 ** attempt, signal)
        continue
      }
    }
  }
  throw new ModelError(
    lastError instanceof Error
      ? `Could not reach ${provider}: ${lastError.message}`
      : `Could not reach ${provider}`,
  )
}

interface StreamState {
  content: string
  reasoning: string
  finishReason: string | null
  usage: AgentUsage | undefined
  calls: Map<number, { id: string; name: string; arguments: string }>
}

async function consumeSse(
  response: Response,
  request: ModelRequest,
  state: StreamState,
  provider: string,
): Promise<void> {
  if (!response.body) throw new ModelError(`${provider} returned an empty stream`)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // Providers split SSE events with LF, CRLF or a bare CR. Normalise before
      // looking for the blank line, otherwise a CRLF-only endpoint looks like
      // one giant event and every delta arrives only after the stream ends.
      buffer = buffer.replace(/\r\n?/g, '\n')
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        await handleSseEvent(rawEvent, request, state)
        boundary = buffer.indexOf('\n\n')
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) await handleSseEvent(buffer, request, state)
  } finally {
    reader.releaseLock()
  }
}

async function handleSseEvent(
  raw: string,
  request: ModelRequest,
  state: StreamState,
): Promise<void> {
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') continue
    let chunk: {
      choices?: Array<{
        delta?: {
          content?: string | null
          reasoning_content?: string | null
          /** Alias used by some OpenAI-compatible reasoning endpoints. */
          reasoning?: string | null
          tool_calls?: Array<{
            index?: number
            id?: string
            function?: { name?: string; arguments?: string }
          }>
        }
        finish_reason?: string | null
      }>
      usage?: {
        prompt_tokens?: number
        completion_tokens?: number
        total_tokens?: number
        /** DeepSeek context cache accounting, billed at a lower rate. */
        prompt_cache_hit_tokens?: number
        prompt_cache_miss_tokens?: number
      }
    }
    try {
      chunk = JSON.parse(data)
    } catch {
      continue
    }
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta ?? {}
      const reasoningDelta = delta.reasoning_content ?? delta.reasoning ?? ''
      if (reasoningDelta) {
        state.reasoning += reasoningDelta
        await request.onReasoningDelta?.(reasoningDelta)
      }
      if (delta.content) {
        state.content += delta.content
        await request.onTextDelta?.(delta.content)
      }
      for (const toolCall of delta.tool_calls ?? []) {
        const index = toolCall.index ?? 0
        const current = state.calls.get(index) ?? { id: '', name: '', arguments: '' }
        if (toolCall.id) current.id = toolCall.id
        if (toolCall.function?.name) current.name = toolCall.function.name
        if (toolCall.function?.arguments) current.arguments += toolCall.function.arguments
        state.calls.set(index, current)
      }
      if (choice.finish_reason) state.finishReason = choice.finish_reason
    }
    if (chunk.usage) {
      const promptTokens = chunk.usage.prompt_tokens ?? 0
      const completionTokens = chunk.usage.completion_tokens ?? 0
      const hit = chunk.usage.prompt_cache_hit_tokens
      const miss = chunk.usage.prompt_cache_miss_tokens
      state.usage = {
        promptTokens,
        completionTokens,
        totalTokens: chunk.usage.total_tokens ?? promptTokens + completionTokens,
        ...(typeof hit === 'number' ? { cacheHitTokens: hit } : {}),
        ...(typeof miss === 'number' ? { cacheMissTokens: miss } : {}),
      }
    }
  }
}

export class DeepSeekClient implements ModelClient {
  private readonly provider: string

  constructor(private readonly config: DeepSeekConfig) {
    this.provider = providerLabel(config.baseUrl, config.model)
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const state: StreamState = {
      content: '',
      reasoning: '',
      finishReason: null,
      usage: undefined,
      calls: new Map(),
    }
    const maxOutputTokens = effectiveOutputTokens(this.config.maxOutputTokens, this.config.model)
    const body: Record<string, unknown> = {
      model: this.config.model,
      stream: true,
      stream_options: { include_usage: true },
      messages: toOpenAIMessages(request.messages),
      ...(request.tools.length > 0 ? { tools: toOpenAITools(request.tools) } : {}),
      ...(maxOutputTokens > 0 ? { max_tokens: maxOutputTokens } : {}),
    }
    if (
      !this.config.model.toLowerCase().includes('reasoner') &&
      (request.temperature ?? this.config.temperature) !== undefined
    ) {
      body['temperature'] = request.temperature ?? this.config.temperature
    }

    let response: Response
    try {
      response = await postCompletion(this.config, body, request.signal)
    } catch (error) {
      // Some OpenAI-compatible endpoints reject image content parts. A
      // screenshot must not fail the whole run: retry once without images.
      const hadImages = request.messages.some((message) => (message.images?.length ?? 0) > 0)
      if (
        hadImages &&
        error instanceof ModelError &&
        error.status === 400 &&
        /image|vision|multimodal|image_url/i.test(error.message)
      ) {
        const stripped = request.messages.map((message) =>
          message.images ? { ...message, images: undefined } : message,
        )
        response = await postCompletion(
          this.config,
          { ...body, messages: toOpenAIMessages(stripped) },
          request.signal,
        )
      } else {
        throw error
      }
    }
    try {
      await consumeSse(response, request, state, this.provider)
    } catch (error) {
      if (isAbort(error, request.signal)) throw error
      if (error instanceof ModelError) throw error
      throw new ModelError(
        error instanceof Error
          ? `${this.provider} stream failed: ${error.message}`
          : `${this.provider} stream failed`,
      )
    }

    const toolCalls: ToolCall[] = [...state.calls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([index, call]) => ({
        id: call.id || `call_${Date.now()}_${index}`,
        name: call.name,
        arguments: parseArguments(call.arguments),
      }))
      .filter((call) => call.name.length > 0)

    return {
      content: state.content,
      toolCalls,
      reasoning: state.reasoning,
      usage: state.usage,
      finishReason: state.finishReason,
    }
  }
}

export async function testDeepSeekConnection(input: {
  apiKey: string
  baseUrl: string
  model: string
}): Promise<{ ok: boolean; message: string; models?: string[] }> {
  const apiKey = input.apiKey.trim()
  if (!apiKey) return { ok: false, message: 'Enter an API key first.' }
  const provider = providerLabel(input.baseUrl, input.model)
  try {
    const response = await fetch(endpoint(input.baseUrl, '/models'), {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      return { ok: false, message: friendlyHttpError(response.status, text, provider) }
    }
    const payload = (await response.json()) as { data?: Array<{ id?: string }> }
    const models = (payload.data ?? [])
      .map((item) => item.id)
      .filter((id): id is string => typeof id === 'string')
    const selected = input.model.trim()
    return {
      ok: true,
      message: selected && !models.includes(selected)
        ? `Connected. ${models.length} models available; "${selected}" was not listed, but custom model names may still work.`
        : `Connected to ${provider}. ${models.length} models available.`,
      models,
    }
  } catch (error) {
    return {
      ok: false,
      message: `Could not reach ${provider}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
