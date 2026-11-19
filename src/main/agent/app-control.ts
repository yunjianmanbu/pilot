import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import WebSocket, { type RawData } from 'ws'

/**
 * Drive a running Chromium/Electron app through the DevTools protocol.
 *
 * This is the generic "operate what you just started" capability: list targets,
 * evaluate JavaScript, click, type, press keys, wait for UI state, read console
 * output and capture the rendered frame. It is deliberately process-agnostic:
 * anything that exposes a remote debugging port works, including a second
 * Pilot instance launched with its own PILOT_USER_DATA_DIR.
 *
 * The connection is per call and closes at the end. There is no background
 * daemon and no state that outlives the tool call.
 */
const DEFAULT_PORT = 9_222
const MAX_IMAGE_DATA_URL_CHARS = 110_000
const MAX_OUTPUT_CHARS = 32_000
const MAX_CONSOLE_EVENTS = 250
const MAX_KEPT_SCREENSHOTS = 40

export interface AppTarget {
  id: string
  title: string
  url: string
  type: string
  webSocketDebuggerUrl: string
}

export interface AppActionInput {
  action: 'evaluate' | 'screenshot' | 'click' | 'type' | 'press' | 'wait' | 'console'
  port?: unknown
  targetId?: unknown
  targetTitle?: unknown
  targetUrl?: unknown
  expression?: unknown
  selector?: unknown
  nth?: unknown
  text?: unknown
  clear?: unknown
  key?: unknown
  timeoutMs?: unknown
  durationMs?: unknown
  quality?: unknown
  label?: unknown
  saveDir: string
}

export interface AppActionOutcome {
  output: string
  metadata: Record<string, unknown>
  images?: string[]
}

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

type CdpEventListener = (method: string, params: Record<string, unknown>) => void

export class CdpConnection {
  private readonly pending = new Map<number, PendingCall>()
  private readonly listeners = new Set<CdpEventListener>()
  private nextId = 0
  private closed = false

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', (data: RawData) => this.handleMessage(data.toString()))
    socket.on('close', () => {
      this.closed = true
      this.failAll(new Error('DevTools connection closed'))
    })
    socket.on('error', (error: Error) => {
      this.failAll(error instanceof Error ? error : new Error(String(error)))
    })
  }

  static open(url: string, timeoutMs = 5_000): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, {
        maxPayload: 64 * 1024 * 1024,
        handshakeTimeout: timeoutMs,
      })
      const timer = setTimeout(() => {
        socket.terminate()
        reject(new Error(`Timed out connecting to DevTools at ${url}`))
      }, timeoutMs)
      socket.once('open', () => {
        clearTimeout(timer)
        resolve(new CdpConnection(socket))
      })
      socket.once('error', (error: Error) => {
        clearTimeout(timer)
        reject(error)
      })
    })
  }

  onEvent(listener: CdpEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 15_000,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error('DevTools connection is closed'))
    this.nextId += 1
    const id = this.nextId
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`DevTools ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      })
      try {
        this.socket.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.socket.close()
    } catch {
      // Already closed.
    }
    this.failAll(new Error('DevTools connection closed'))
  }

  private handleMessage(raw: string): void {
    let payload: unknown
    try {
      payload = JSON.parse(raw)
    } catch {
      return
    }
    if (!payload || typeof payload !== 'object') return
    const record = payload as Record<string, unknown>
    const id = record['id']
    if (typeof id === 'number') {
      const pending = this.pending.get(id)
      if (!pending) return
      this.pending.delete(id)
      clearTimeout(pending.timer)
      const error = record['error']
      if (error && typeof error === 'object') {
        const detail = error as Record<string, unknown>
        const message =
          typeof detail['message'] === 'string' ? detail['message'] : 'DevTools command failed'
        pending.reject(new Error(message))
        return
      }
      const result = record['result']
      pending.resolve(result && typeof result === 'object' ? result : {})
      return
    }
    const method = record['method']
    if (typeof method !== 'string') return
    const params =
      record['params'] && typeof record['params'] === 'object'
        ? (record['params'] as Record<string, unknown>)
        : {}
    for (const listener of this.listeners) {
      try {
        listener(method, params)
      } catch {
        // A broken listener must not tear down the connection.
      }
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

export function normalizePort(value: unknown, fallback = DEFAULT_PORT): number {
  if (value === undefined || value === null || value === '') return fallback
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('port must be an integer between 1 and 65535 (the app\'s --remote-debugging-port)')
  }
  return port
}

export async function listAppTargets(port: number, timeoutMs = 3_000): Promise<AppTarget[]> {
  let response: Response
  try {
    response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    throw new Error(
      `No DevTools endpoint on 127.0.0.1:${port}. Start the app with --remote-debugging-port=${port} (for Electron: an extra flag after the app entry).`,
    )
  }
  if (!response.ok) {
    throw new Error(`DevTools endpoint on 127.0.0.1:${port} returned HTTP ${response.status}`)
  }
  const payload: unknown = await response.json().catch(() => null)
  const entries = Array.isArray(payload) ? payload : []
  return entries.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const record = entry as Record<string, unknown>
    const wsUrl = typeof record['webSocketDebuggerUrl'] === 'string' ? record['webSocketDebuggerUrl'] : ''
    if (!wsUrl) return []
    return [
      {
        id: String(record['id'] ?? ''),
        title: String(record['title'] ?? ''),
        url: String(record['url'] ?? ''),
        type: String(record['type'] ?? ''),
        webSocketDebuggerUrl: wsUrl,
      },
    ]
  })
}

export function pickTarget(
  targets: AppTarget[],
  selector: { targetId?: string; targetTitle?: string; targetUrl?: string },
): AppTarget {
  if (selector.targetId) {
    const exact = targets.find((target) => target.id === selector.targetId)
    if (exact) return exact
    throw new Error(`No DevTools target with id "${selector.targetId}". ${describeTargets(targets)}`)
  }
  const pages = targets.filter((target) => target.type === 'page' || target.type === 'webview')
  const pool = pages.length > 0 ? pages : targets
  if (selector.targetTitle) {
    const needle = selector.targetTitle.toLowerCase()
    const match = pool.find((target) => target.title.toLowerCase().includes(needle))
    if (match) return match
    throw new Error(`No target whose title contains "${selector.targetTitle}". ${describeTargets(targets)}`)
  }
  if (selector.targetUrl) {
    const needle = selector.targetUrl.toLowerCase()
    const match = pool.find((target) => target.url.toLowerCase().includes(needle))
    if (match) return match
    throw new Error(`No target whose URL contains "${selector.targetUrl}". ${describeTargets(targets)}`)
  }
  const first = pool[0]
  if (!first) {
    throw new Error(`The DevTools endpoint returned no page targets. ${describeTargets(targets)}`)
  }
  return first
}

export function describeTargets(targets: AppTarget[]): string {
  if (targets.length === 0) return 'No targets available.'
  return `Available targets: ${targets
    .map((target) => `[${target.type}] "${target.title}" ${target.url} (id ${target.id})`)
    .join(' | ')}`
}

function formatRemoteObject(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  if ('value' in record) return record['value']
  if (typeof record['unserializableValue'] === 'string') return record['unserializableValue']
  if (typeof record['description'] === 'string') return record['description']
  return null
}

function describeException(details: unknown): string {
  if (!details || typeof details !== 'object') return 'Evaluation failed'
  const record = details as Record<string, unknown>
  const exception = record['exception']
  if (exception && typeof exception === 'object') {
    const description = (exception as Record<string, unknown>)['description']
    if (typeof description === 'string' && description) return description
  }
  return typeof record['text'] === 'string' ? record['text'] : 'Evaluation failed'
}

function toStringOutput(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    const text = JSON.stringify(value, null, 2)
    return typeof text === 'string' ? text : String(value)
  } catch {
    return String(value)
  }
}

function truncate(text: string): string {
  return text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n… (truncated at ${MAX_OUTPUT_CHARS} characters)`
    : text
}

async function evaluateExpression(
  connection: CdpConnection,
  expression: string,
  options: { awaitPromise?: boolean; timeoutMs?: number } = {},
): Promise<unknown> {
  const response = await connection.send<{
    result?: unknown
    exceptionDetails?: unknown
  }>(
    'Runtime.evaluate',
    {
      expression,
      awaitPromise: options.awaitPromise ?? true,
      returnByValue: true,
      userGesture: true,
    },
    options.timeoutMs ?? 15_000,
  )
  if (response.exceptionDetails) throw new Error(describeException(response.exceptionDetails))
  return formatRemoteObject(response.result)
}

function selectorExpression(selector: string, nth: number): string {
  if (!selector.trim()) throw new Error('selector must be a non-empty CSS selector')
  const index = Math.max(0, Math.trunc(nth))
  return `document.querySelectorAll(${JSON.stringify(selector)})[${index}]`
}

function safeLabel(value: string | undefined): string {
  const text = (value ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return text.slice(0, 48) || 'app'
}

async function prune(dir: string): Promise<void> {
  try {
    const names = (await readdir(dir)).filter((name) => /\.jpg$/i.test(name)).sort()
    const excess = names.length - MAX_KEPT_SCREENSHOTS
    for (const name of names.slice(0, Math.max(0, excess))) {
      await rm(join(dir, name), { force: true }).catch(() => undefined)
    }
  } catch {
    // Retention is best-effort.
  }
}

async function screenshot(
  connection: CdpConnection,
  input: { saveDir: string; label?: string; quality: number; target: AppTarget },
): Promise<AppActionOutcome> {
  const qualities = [...new Set([input.quality, 60, 45, 30])]
  let data = ''
  let usedQuality = input.quality
  for (const quality of qualities) {
    const response = await connection.send<{ data?: unknown }>(
      'Page.captureScreenshot',
      { format: 'jpeg', quality, fromSurface: true },
      20_000,
    )
    if (typeof response.data !== 'string' || !response.data) {
      throw new Error('DevTools returned an empty screenshot')
    }
    data = response.data
    usedQuality = quality
    if (`data:image/jpeg;base64,${data}`.length <= MAX_IMAGE_DATA_URL_CHARS) break
  }
  const dataUrl = `data:image/jpeg;base64,${data}`
  if (dataUrl.length > MAX_IMAGE_DATA_URL_CHARS) {
    throw new Error(
      `Screenshot is too large to attach (limit ${MAX_IMAGE_DATA_URL_CHARS} characters). Resize the window or capture a smaller target.`,
    )
  }

  const metrics = await connection
    .send<{ cssLayoutViewport?: { clientWidth?: number; clientHeight?: number } }>(
      'Page.getLayoutMetrics',
      {},
      5_000,
    )
    .catch(() => null)
  const viewport = metrics?.cssLayoutViewport ?? {}
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = join(input.saveDir, `${stamp}-app-${safeLabel(input.label)}.jpg`)
  let saved: string | null = null
  try {
    await mkdir(input.saveDir, { recursive: true })
    await prune(input.saveDir)
    await writeFile(file, Buffer.from(data, 'base64'))
    saved = file
  } catch {
    saved = null
  }

  return {
    output: `Captured ${input.target.title || input.target.url} via DevTools (quality ${usedQuality}).${saved ? `\nSaved: ${saved}` : ''}`,
    metadata: {
      screenshot: {
        target: `app:${input.target.title || input.target.id}`,
        width: viewport.clientWidth ?? null,
        height: viewport.clientHeight ?? null,
        path: saved,
      },
    },
    images: [dataUrl],
  }
}

const KEY_CODES: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  Space: { code: 'Space', keyCode: 32, text: ' ' },
}

async function pressKey(
  connection: CdpConnection,
  input: { selector?: string; nth: number; key: string },
): Promise<string> {
  const definition = KEY_CODES[input.key]
  if (!definition) {
    throw new Error(`Unsupported key "${input.key}". Supported: ${Object.keys(KEY_CODES).join(', ')}`)
  }
  let focused: unknown = null
  if (input.selector) {
    focused = await evaluateExpression(
      connection,
      `(() => {
        const el = ${selectorExpression(input.selector, input.nth)};
        if (!el) return { ok: false, error: 'selector matched no element' };
        el.scrollIntoView({ block: 'center' });
        el.focus();
        return { ok: true, tag: el.tagName };
      })()`,
    )
    if (focused && typeof focused === 'object' && (focused as Record<string, unknown>)['ok'] === false) {
      return toStringOutput(focused)
    }
  }
  const base = {
    key: input.key,
    code: definition.code,
    windowsVirtualKeyCode: definition.keyCode,
    nativeVirtualKeyCode: definition.keyCode,
  }
  await connection.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    ...base,
    ...(definition.text ? { text: definition.text } : {}),
  })
  await connection.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  return `Pressed ${input.key}${input.selector ? ` in ${input.selector}` : ''}.`
}

async function typeText(
  connection: CdpConnection,
  input: { selector: string; nth: number; text: string; clear: boolean },
): Promise<string> {
  const clear = input.clear ? 'true' : 'false'
  const focused = await evaluateExpression(
    connection,
    `(() => {
      const el = ${selectorExpression(input.selector, input.nth)};
      if (!el) return { ok: false, error: 'selector matched no element' };
      el.scrollIntoView({ block: 'center' });
      el.focus();
      if (${clear}) {
        if (typeof el.select === 'function') el.select();
        else if (el.isContentEditable) {
          el.textContent = '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
      return { ok: true, tag: el.tagName, type: el.type || '' };
    })()`,
  )
  if (focused && typeof focused === 'object' && (focused as Record<string, unknown>)['ok'] === false) {
    throw new Error(String((focused as Record<string, unknown>)['error'] ?? 'Selector matched no element'))
  }
  await connection.send('Input.insertText', { text: input.text })
  const after = await evaluateExpression(
    connection,
    `(() => {
      const el = ${selectorExpression(input.selector, input.nth)};
      if (!el) return null;
      if (typeof el.value === 'string') return { value: el.value.slice(0, 500) };
      return { value: (el.textContent || '').slice(0, 500) };
    })()`,
    { awaitPromise: false },
  )
  return `Typed ${input.text.length} characters into ${input.selector}${input.clear ? ' (replaced existing value)' : ''}. Current value: ${toStringOutput(after)}`
}

async function waitFor(
  connection: CdpConnection,
  input: { selector?: string; expression?: string; timeoutMs: number },
): Promise<string> {
  if (!input.selector && !input.expression) {
    throw new Error('wait needs either selector or expression')
  }
  const probe = input.selector
    ? `!!(${selectorExpression(input.selector, 0)})`
    : String(input.expression)
  const deadline = Date.now() + input.timeoutMs
  let lastError = ''
  let attempts = 0
  while (Date.now() < deadline) {
    attempts += 1
    try {
      const value = await evaluateExpression(connection, probe, {
        awaitPromise: false,
        timeoutMs: 2_000,
      })
      if (value) {
        return `Condition met after ${attempts} probe(s): ${input.selector ? `selector "${input.selector}" exists` : `expression returned ${toStringOutput(value)}`}.`
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 150))
  }
  throw new Error(
    `wait timed out after ${input.timeoutMs}ms (${attempts} probes).${
      lastError ? ` Last error: ${lastError}` : ''
    }`,
  )
}

function remoteObjectText(value: unknown): string {
  if (!value || typeof value !== 'object') return String(value)
  const record = value as Record<string, unknown>
  if ('value' in record) return typeof record['value'] === 'string' ? record['value'] : toStringOutput(record['value'])
  if (typeof record['unserializableValue'] === 'string') return record['unserializableValue']
  if (typeof record['description'] === 'string') return record['description']
  return String(record['type'] ?? 'unknown')
}

async function collectConsole(
  connection: CdpConnection,
  durationMs: number,
): Promise<string> {
  const events: string[] = []
  const push = (kind: string, text: string): void => {
    const time = new Date().toISOString().slice(11, 23)
    events.push(`${time} ${kind} ${text}`)
    if (events.length > MAX_CONSOLE_EVENTS) events.shift()
  }
  connection.onEvent((method, params) => {
    if (method === 'Runtime.consoleAPICalled') {
      const type = typeof params['type'] === 'string' ? params['type'] : 'log'
      const args = Array.isArray(params['args']) ? params['args'] : []
      push(type, args.map(remoteObjectText).join(' '))
      return
    }
    if (method === 'Runtime.exceptionThrown') {
      push('exception', describeException(params['exceptionDetails']))
      return
    }
    if (method === 'Log.entryAdded') {
      const entry = params['entry']
      if (!entry || typeof entry !== 'object') return
      const record = entry as Record<string, unknown>
      const level = typeof record['level'] === 'string' ? record['level'] : 'log'
      const text = typeof record['text'] === 'string' ? record['text'] : ''
      const url = typeof record['url'] === 'string' ? record['url'] : ''
      push(level, `${text}${url ? ` (${url})` : ''}`)
    }
  })
  await connection.send('Runtime.enable')
  await connection.send('Log.enable')
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, durationMs))
  const header = `Listened for ${durationMs}ms. ${events.length} console/exception/log event(s) received (events before attachment are not replayed).`
  return truncate(events.length > 0 ? `${header}\n${events.join('\n')}` : `${header}\n(no console output)`)
}

export async function runAppAction(input: AppActionInput): Promise<AppActionOutcome> {
  const port = normalizePort(input.port)
  const targets = await listAppTargets(port)
  const target = pickTarget(targets, {
    ...(typeof input.targetId === 'string' ? { targetId: input.targetId } : {}),
    ...(typeof input.targetTitle === 'string' ? { targetTitle: input.targetTitle } : {}),
    ...(typeof input.targetUrl === 'string' ? { targetUrl: input.targetUrl } : {}),
  })
  const connection = await CdpConnection.open(target.webSocketDebuggerUrl)
  const metadata: Record<string, unknown> = {
    action: input.action,
    port,
    targetId: target.id,
    targetTitle: target.title,
    targetUrl: target.url,
  }

  try {
    switch (input.action) {
      case 'evaluate': {
        if (typeof input.expression !== 'string' || !input.expression.trim()) {
          throw new Error('evaluate needs a non-empty expression')
        }
        const value = await evaluateExpression(connection, input.expression, {
          awaitPromise: true,
          timeoutMs: clampInteger(input.timeoutMs, 15_000, 500, 120_000),
        })
        return { output: truncate(toStringOutput(value)), metadata }
      }
      case 'screenshot': {
        const outcome = await screenshot(connection, {
          saveDir: input.saveDir,
          ...(typeof input.label === 'string' ? { label: input.label } : {}),
          quality: clampInteger(input.quality, 72, 10, 100),
          target,
        })
        return { ...outcome, metadata: { ...metadata, ...outcome.metadata } }
      }
      case 'click': {
        if (typeof input.selector !== 'string' || !input.selector.trim()) {
          throw new Error('click needs a CSS selector')
        }
        const nth = clampInteger(input.nth, 0, 0, 10_000)
        const value = await evaluateExpression(
          connection,
          `(() => {
            const el = ${selectorExpression(input.selector, nth)};
            if (!el) return { ok: false, error: 'selector matched no element' };
            el.scrollIntoView({ block: 'center', inline: 'center' });
            if (typeof el.click === 'function') el.click();
            else el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            return { ok: true, tag: el.tagName, text: (el.innerText || el.value || '').trim().slice(0, 200) };
          })()`,
          { awaitPromise: false },
        )
        return { output: truncate(toStringOutput(value)), metadata }
      }
      case 'type': {
        if (typeof input.selector !== 'string' || !input.selector.trim()) {
          throw new Error('type needs a CSS selector')
        }
        if (typeof input.text !== 'string') throw new Error('type needs text')
        const output = await typeText(connection, {
          selector: input.selector,
          nth: clampInteger(input.nth, 0, 0, 10_000),
          text: input.text,
          clear: input.clear === true,
        })
        return { output, metadata }
      }
      case 'press': {
        if (typeof input.key !== 'string' || !input.key.trim()) throw new Error('press needs key')
        const output = await pressKey(connection, {
          ...(typeof input.selector === 'string' && input.selector.trim()
            ? { selector: input.selector }
            : {}),
          nth: clampInteger(input.nth, 0, 0, 10_000),
          key: input.key.trim(),
        })
        return { output, metadata }
      }
      case 'wait': {
        const output = await waitFor(connection, {
          ...(typeof input.selector === 'string' && input.selector.trim()
            ? { selector: input.selector }
            : {}),
          ...(typeof input.expression === 'string' && input.expression.trim()
            ? { expression: input.expression }
            : {}),
          timeoutMs: clampInteger(input.timeoutMs, 5_000, 200, 60_000),
        })
        return { output, metadata }
      }
      case 'console': {
        const output = await collectConsole(
          connection,
          clampInteger(input.durationMs, 2_000, 200, 15_000),
        )
        return { output, metadata }
      }
      default:
        throw new Error(`Unknown app action: ${String(input.action)}`)
    }
  } finally {
    connection.close()
  }
}
