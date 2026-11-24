#!/usr/bin/env node
/**
 * Pilot 片段速查插件。
 *
 * 为什么这么写：
 * - 片段是「少而常用」的东西，整份存一个 JSON（<stateDir>/snippets.json）比
 *   追加日志更好用：一次读写就能排序、累加命中次数；
 * - 命中次数是排序依据，所以 search 会顺手给命中的片段 +1，让最常用的排前面；
 * - 定时触发器只做一件事：按「使用次数最少、最久没动」裁到上限，避免文件无限长。
 *
 * 协议：stdin/stdout 每行一个 JSON。宿主发 `plugin.activate`、`plugin.request`、
 * `plugin.event`，插件回 `{ id, result }` 或 `{ id, error }`；插件要宿主做事时
 * 自己发 `{ id, method: 'host.call', params: { capability, payload } }`。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const MAX_TEXT = 8000
const MAX_NAME = 80

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
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'host.call',
        params: { capability, payload },
      }) + '\n',
    )
  })
}

async function notify(message) {
  try {
    await hostCall('host.notify', { message })
  } catch {
    // 提醒失败不该让清理本身失败。
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

function configFlag(key, fallback) {
  const value = config[key]
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true'
  return fallback
}

function snippetsFile() {
  return join(stateDir, 'snippets.json')
}

/** 文件坏了就当空的：片段可以重存，报错只会让人没法继续用。 */
async function readAll() {
  try {
    const parsed = JSON.parse(await readFile(snippetsFile(), 'utf8'))
    const items = parsed && Array.isArray(parsed.items) ? parsed.items : []
    const out = []
    for (const item of items) {
      if (!item || typeof item !== 'object') continue
      if (typeof item.name !== 'string' || typeof item.text !== 'string') continue
      out.push({
        name: item.name,
        text: item.text,
        tags: Array.isArray(item.tags) ? item.tags.filter((tag) => typeof tag === 'string') : [],
        at: typeof item.at === 'string' ? item.at : new Date(0).toISOString(),
        hits: Number.isFinite(item.hits) ? Math.max(0, Math.trunc(item.hits)) : 0,
      })
    }
    return out
  } catch {
    return []
  }
}

async function writeAll(items) {
  await mkdir(stateDir, { recursive: true })
  await writeFile(snippetsFile(), JSON.stringify({ version: 1, items }, null, 2) + '\n', 'utf8')
}

function splitTags(raw) {
  if (typeof raw !== 'string') return []
  return [...new Set(raw.split(/[,;\s]+/).map((tag) => tag.trim()).filter(Boolean))].slice(0, 8)
}

function deadline() {
  return configNumber('maxSnippets', 200, 10, 2000)
}

/** 工具 `save`：同名覆盖正文与标签，但保留命中次数。 */
async function save(body) {
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, MAX_NAME) : ''
  const text = typeof body.text === 'string' ? body.text.trim().slice(0, MAX_TEXT) : ''
  if (!name) return { status: 400, body: { error: 'name is required' } }
  if (!text) return { status: 400, body: { error: 'text is required' } }
  const tags = splitTags(body.tags)
  if (!tags.length) tags.push(configText('defaultTag', 'general'))

  const items = await readAll()
  const at = new Date().toISOString()
  const existing = items.find((item) => item.name === name)
  if (existing) {
    existing.text = text
    existing.tags = tags
    existing.at = at
  } else {
    if (items.length >= deadline()) await trim(items, 1)
    items.push({ name, text, tags, at, hits: 0 })
  }
  await writeAll(items)
  return { status: 200, body: { saved: name, total: items.length, updated: Boolean(existing) } }
}

/** 工具 `search`：命中名字、正文或标签；命中项 +1 次使用。 */
async function search(body) {
  const query = typeof body.query === 'string' ? body.query.trim().toLowerCase() : ''
  const tag = typeof body.tag === 'string' ? body.tag.trim().toLowerCase() : ''
  const limit = Math.min(30, Math.max(1, Math.trunc(Number(body.limit) || 10)))
  const items = await readAll()

  const matched = items.filter((item) => {
    if (tag && !item.tags.some((entry) => entry.toLowerCase() === tag)) return false
    if (!query) return true
    const haystack = `${item.name}\n${item.text}\n${item.tags.join(' ')}`.toLowerCase()
    return haystack.includes(query)
  })
  matched.sort((left, right) => {
    if (right.hits !== left.hits) return right.hits - left.hits
    return String(right.at).localeCompare(String(left.at))
  })
  const picked = matched.slice(0, limit)
  if (picked.length) {
    const hitNames = new Set(picked.map((item) => item.name))
    for (const item of items) if (hitNames.has(item.name)) item.hits += 1
    await writeAll(items)
  }
  return {
    status: 200,
    body: {
      total: items.length,
      matched: matched.length,
      snippets: picked,
      text: picked.length
        ? picked.map((item) => `【${item.name}】(${item.tags.join('/')})\n${item.text}`).join('\n\n')
        : '没有匹配的片段。',
    },
  }
}

/** 按「用得最少、最久没动」删掉 keep 条以外的部分，返回被删的名字。 */
async function trim(items, keepAtLeast) {
  const limit = Math.max(0, deadline() - keepAtLeast)
  if (items.length <= limit) return []
  const ordered = [...items].sort((left, right) => {
    if (left.hits !== right.hits) return left.hits - right.hits
    return String(left.at).localeCompare(String(right.at))
  })
  const drop = new Set(ordered.slice(0, items.length - limit).map((item) => item.name))
  const removed = items.filter((item) => drop.has(item.name)).map((item) => item.name)
  items.length = 0
  items.push(...ordered.filter((item) => !drop.has(item.name)))
  return removed
}

async function activate(params) {
  const dir = params && typeof params.stateDir === 'string' ? params.stateDir : ''
  if (dir) stateDir = dir
  config = params && params.config && typeof params.config === 'object' ? params.config : {}
  await mkdir(stateDir, { recursive: true })
  readyAt = new Date().toISOString()
  return { ok: true, plugin: params && params.plugin ? params.plugin.id : null, readyAt }
}

async function request(params) {
  const route = params && params.route && typeof params.route === 'object' ? params.route : {}
  const body = params && params.body && typeof params.body === 'object' ? params.body : {}
  if (route.path === 'save' && route.method === 'POST') return save(body)
  if (route.path === 'search' && route.method === 'POST') return search(body)
  if (route.path === 'health' && route.method === 'GET') {
    return { status: 200, body: { ok: true, readyAt, snippets: (await readAll()).length } }
  }
  return {
    status: 404,
    body: { error: 'unknown route ' + String(route.method) + ' ' + String(route.path) },
  }
}

/** 定时清理：裁剪到上限，按需通知删了哪些。 */
async function onSchedule() {
  const items = await readAll()
  const before = items.length
  const removed = await trim(items, 0)
  if (removed.length) await writeAll(items)
  if (removed.length && configFlag('notifyOnTrim', false)) {
    await notify(`片段清理：${before} → ${items.length} 条，删掉了 ${removed.slice(0, 5).join('、')}${removed.length > 5 ? ' 等' : ''}。`)
  }
  return { ok: true, before, after: items.length, removed: removed.length }
}

async function event(params) {
  const name = params && typeof params.event === 'string' ? params.event : ''
  if (name === 'schedule') return onSchedule()
  return { ok: true, ignored: name }
}

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}

function replyError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n')
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
// 队列后面时，正在等它的请求会一直占着队列，双方互相等待到 4 秒超时。
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
      } catch {
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
