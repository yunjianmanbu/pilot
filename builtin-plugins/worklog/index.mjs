#!/usr/bin/env node
/**
 * Pilot 工作日志插件。
 *
 * 为什么这么写：
 * - 一条日志一行 JSON，落在 <stateDir>/entries.jsonl，追加成本恒定，坏了也只丢一行；
 * - 时间戳取本地时区当天的日期键，跨天判断不需要再存别的状态；
 * - 每日提醒走 `host.notify`（需要 host:notify 权限），插件自己不发 HTTP，
 *   所以手机、桌面看到的都是同一条通知。
 *
 * 协议：stdin/stdout 每行一个 JSON。宿主发 `plugin.activate`、`plugin.request`、
 * `plugin.event`，插件回 `{ id, result }` 或 `{ id, error }`；插件要宿主做事时
 * 自己发 `{ id, method: 'host.call', params: { capability, payload } }`，
 * 宿主用同一个 id 把结果写回 stdin，这里的 pendingCalls 负责配对。
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

let stateDir = '.'
let config = {}
let readyAt = null

const pendingCalls = new Map()
let hostCallSeq = 0

function hostCall(capability, payload) {
  const id = `plugin-host-${++hostCallSeq}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCalls.delete(id)
      reject(new Error(`host.call ${capability} timed out`))
    }, 4000)
    timer.unref?.()
    pendingCalls.set(id, {
      resolve: (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      reject: (error) => {
        clearTimeout(timer)
        reject(error)
      },
    })
    process.stdout.write(
      JSON.stringify({ jsonrpc: '2.0', id: id, method: 'host.call', params: { capability: capability, payload: payload } }) + '\n',
    )
  })
}

async function notify(message) {
  try {
    await hostCall('host.notify', { message: message })
  } catch (error) {
    // 通知失败不该让日志本身失败。
  }
}

function configText(key, fallback) {
  const value = config[key]
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function configNumber(key, fallback, min, max) {
  const raw = config[key]
  const value = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim())
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function entriesFile() {
  return join(stateDir, 'entries.jsonl')
}

function dayKey(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

async function readEntries() {
  try {
    const raw = await readFile(entriesFile(), 'utf8')
    const out = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line)
        if (parsed && typeof parsed === 'object') out.push(parsed)
      } catch (error) {
        // 单行坏掉不影响其余记录。
      }
    }
    return out
  } catch (error) {
    return []
  }
}

async function activate(params) {
  const dir = params && typeof params.stateDir === 'string' ? params.stateDir : ''
  if (dir) stateDir = dir
  config = params && params.config && typeof params.config === 'object' ? params.config : {}
  await mkdir(stateDir, { recursive: true })
  readyAt = new Date().toISOString()
  return { ok: true, plugin: params && params.plugin ? params.plugin.id : null, readyAt: readyAt }
}

async function addEntry(body) {
  const text = typeof body.text === 'string' ? body.text.trim().slice(0, 2000) : ''
  if (!text) return { status: 400, body: { error: 'text is required' } }
  const tag =
    (typeof body.tag === 'string' && body.tag.trim().slice(0, 32)) || configText('tag', 'general')
  const at = new Date()
  const entry = { at: at.toISOString(), day: dayKey(at), tag: tag, text: text }
  await mkdir(stateDir, { recursive: true })
  await appendFile(entriesFile(), JSON.stringify(entry) + '\n', 'utf8')
  const today = (await readEntries()).filter((item) => item.day === entry.day).length
  return { status: 201, body: { entry: entry, todayCount: today } }
}

async function recent(body) {
  const limit = Math.min(50, Math.max(1, Math.trunc(Number(body.limit) || 10)))
  const all = await readEntries()
  return {
    status: 200,
    body: { total: all.length, entries: all.slice(-limit).reverse() },
  }
}

async function request(params) {
  const route = params && params.route && typeof params.route === 'object' ? params.route : {}
  const body = params && params.body && typeof params.body === 'object' ? params.body : {}
  if (route.path === 'entries' && route.method === 'POST') return addEntry(body)
  if (route.path === 'recent' && route.method === 'POST') return recent(body)
  if (route.path === 'health' && route.method === 'GET') {
    return { status: 200, body: { ok: true, readyAt: readyAt, entries: (await readEntries()).length } }
  }
  return {
    status: 404,
    body: { error: 'unknown route ' + String(route.method) + ' ' + String(route.path) },
  }
}

/** 每天 18:00：今天没记就提醒，记过就报一句进度。 */
async function onSchedule() {
  if (config.quiet === true || config.quiet === 'true') return { ok: true, skipped: 'quiet' }
  const all = await readEntries()
  const todayKey = dayKey(new Date())
  const today = all.filter((item) => item.day === todayKey)
  const digestSize = configNumber('digestSize', 5, 1, 20)
  if (today.length === 0) {
    await notify('今天还没有工作日志。用 pending 的一句「本轮做了什么」补一条，明天就不用回忆了。')
    return { ok: true, notified: 'empty' }
  }
  const lines = today
    .slice(-digestSize)
    .map((item) => `· [${item.tag}] ${item.text}`)
    .join('\n')
  await notify(`今天记了 ${today.length} 条：\n${lines}`)
  return { ok: true, notified: 'digest', count: today.length }
}

async function event(params) {
  const name = params && typeof params.event === 'string' ? params.event : ''
  if (name === 'schedule') return onSchedule()
  return { ok: true, ignored: name }
}

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: id, result: result }) + '\n')
}

function replyError(id, code, message) {
  process.stdout.write(
    JSON.stringify({ jsonrpc: '2.0', id: id, error: { code: code, message: message } }) + '\n',
  )
}

async function handleMessage(message) {
  const id = message.id
  // 没有 method 的入站消息是宿主对 host.call 的回复。
  if (message.method === undefined && pendingCalls.has(id)) {
    const pending = pendingCalls.get(id)
    pendingCalls.delete(id)
    if (message.error) pending.reject(new Error(message.error.message ?? 'host.call failed'))
    else pending.resolve(message.result)
    return
  }
  const params = message.params && typeof message.params === 'object' ? message.params : {}
  try {
    if (message.method === 'plugin.activate') return reply(id, await activate(params))
    if (message.method === 'plugin.request') return reply(id, await request(params))
    if (message.method === 'plugin.event') return reply(id, await event(params))
    if (message.method === 'plugin.deactivate') return reply(id, { ok: true })
    return replyError(id, 400, 'unknown method ' + String(message.method))
  } catch (error) {
    return replyError(id, 500, error instanceof Error ? error.message : String(error))
  }
}

let buffer = ''
// 请求按到达顺序串行处理，activate 设置的 config 因此不会被后来的请求越过。
// 例外是宿主对 host.call 的回复（没有 method）：它必须插队立刻处理。排在
// 队列后面时，正在等它的请求会一直占着队列，双方互相等待到 4 秒超时，
// 于是每一次 host.store / host.notify 都变成「结果拿不到」。
let queue = Promise.resolve()
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index = buffer.indexOf('\n')
  while (index >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line) {
      let parsed = null
      try {
        parsed = JSON.parse(line)
      } catch (error) {
        parsed = null
      }
      if (parsed && typeof parsed === 'object') {
        if (parsed.method === undefined) void handleMessage(parsed)
        else queue = queue.then(() => handleMessage(parsed))
      }
    }
    index = buffer.indexOf('\n')
  }
})
process.stdin.on('end', () => {
  // stdout 是管道，直接 process.exit() 会丢掉还没刷出去的回复。
  queue.then(() => {
    process.exitCode = 0
  })
})
