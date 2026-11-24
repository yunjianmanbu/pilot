#!/usr/bin/env node
/**
 * Pilot 接口巡检插件。
 *
 * 为什么这么写：
 * - 结果一行一条 JSON 落在 <stateDir>/checks.jsonl，追加成本恒定，坏了也只丢一行；
 * - 只读响应体的前 64 KB 就取消，避免把一个大文件整个读进内存；
 * - 定时巡检自己发起网络请求（插件进程是独立的 Node 子进程），失败时通过
 *   host.notify 发一条通知，所以手机和桌面看到的是同一条提示。
 *
 * 协议：stdin/stdout 每行一个 JSON。宿主发 `plugin.activate`、`plugin.request`、
 * `plugin.event`，插件回 `{ id, result }` 或 `{ id, error }`；插件要宿主做事时
 * 自己发 `{ id, method: 'host.call', params: { capability, payload } }`。
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 只读这么多字节就够判断可用性，再读下去只是浪费。 */
const READ_LIMIT_BYTES = 64 * 1024
/** 结果文件不做无限增长：超过这个条数就只保留最近的。 */
const MAX_LINES = 2000

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
    // 提醒失败不该让巡检本身失败。
  }
}

function configFlag(key, fallback) {
  const value = config[key]
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true'
  return fallback
}

function configNumber(key, fallback, min, max) {
  const raw = config[key]
  const value = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim())
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/** 设置里的地址：逗号、分号、空白或换行都当分隔符，去掉重复与非法项。 */
function targets() {
  const raw = typeof config.targets === 'string' ? config.targets : ''
  const out = []
  for (const piece of raw.split(/[,;\s]+/)) {
    const url = piece.trim()
    if (!url || out.includes(url)) continue
    if (!/^https?:\/\//i.test(url)) continue
    out.push(url)
  }
  return out.slice(0, 20)
}

function checksFile() {
  return join(stateDir, 'checks.jsonl')
}

async function readChecks() {
  try {
    const raw = await readFile(checksFile(), 'utf8')
    const out = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line)
        if (parsed && typeof parsed === 'object') out.push(parsed)
      } catch {
        // 单行坏掉不影响其余记录。
      }
    }
    return out
  } catch {
    return []
  }
}

/** 读一个地址：状态码 + 耗时；出错时把 message 带回去当原因。 */
async function probe(url, timeoutMs) {
  const started = Date.now()
  const record = { at: new Date().toISOString(), url, ok: false, status: 0, ms: 0 }
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'Pilot-Healthcheck/1', accept: '*/*' },
    })
    record.status = response.status
    record.ok = response.ok
    // 读一小段就取消：有些服务端只有在读 body 时才会真正走完响应。
    const body = response.body
    if (body) {
      try {
        const reader = body.getReader()
        let read = 0
        while (read < READ_LIMIT_BYTES) {
          const step = await reader.read()
          if (step.done) break
          read += step.value ? step.value.length : 0
        }
        await reader.cancel().catch(() => undefined)
      } catch {
        // body 读不到不影响状态码已经到手。
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    record.error = message.slice(0, 300)
  }
  record.ms = Date.now() - started
  return record
}

async function record(entries) {
  if (!entries.length) return
  await mkdir(stateDir, { recursive: true })
  const text = entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
  await appendFile(checksFile(), text, 'utf8')
  const all = await readChecks()
  if (all.length > MAX_LINES) {
    const kept = all.slice(-MAX_LINES)
    // 直接覆写：巡检记录是日志，不需要精确的追加语义。
    const { writeFile } = await import('node:fs/promises')
    await writeFile(checksFile(), kept.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8')
  }
}

function timeoutOf() {
  return configNumber('timeoutMs', 5000, 500, 30000)
}

function summarize(records) {
  if (!records.length) return '没有可检查的地址：请在插件页的「巡检地址」里填写，多个地址用逗号分隔。'
  return records
    .map((item) => {
      const head = `${item.ok ? '正常' : '异常'} ${item.status || '-'} ${item.ms}ms`
      return `${item.url} → ${head}${item.error ? `（${item.error}）` : ''}`
    })
    .join('\n')
}

/** 工具 `check`：给 url 就查一个，不给就巡检配置里的全部地址。 */
async function check(body) {
  const one = typeof body.url === 'string' ? body.url.trim() : ''
  let list = []
  if (one) {
    if (!/^https?:\/\//i.test(one)) {
      return { status: 400, body: { error: 'url 必须以 http:// 或 https:// 开头' } }
    }
    list = [one]
  } else {
    list = targets()
  }
  if (!list.length) {
    return { status: 400, body: { error: '没有要检查的地址：给 url，或在插件设置里填写巡检地址' } }
  }
  const timeout = timeoutOf()
  const records = []
  for (const url of list) records.push(await probe(url, timeout))
  await record(records)
  const failed = records.filter((item) => !item.ok)
  return {
    status: 200,
    body: {
      checked: records.length,
      failed: failed.length,
      ok: failed.length === 0,
      text: summarize(records),
      results: records,
    },
  }
}

/** 工具 `status`：按地址聚合最近一次结果与近 24 小时失败数。 */
async function status(body) {
  const limit = Math.min(100, Math.max(1, Math.trunc(Number(body.limit) || 20)))
  const all = await readChecks()
  const since = Date.now() - 24 * 60 * 60 * 1000
  const perUrl = new Map()
  for (const item of all) {
    const url = typeof item.url === 'string' ? item.url : ''
    if (!url) continue
    const bucket = perUrl.get(url) ?? { url, last: null, failures24h: 0, checks24h: 0 }
    const at = Date.parse(String(item.at ?? ''))
    if (Number.isFinite(at) && at >= since) {
      bucket.checks24h += 1
      if (!item.ok) bucket.failures24h += 1
    }
    bucket.last = item
    perUrl.set(url, bucket)
  }
  const urls = [...perUrl.values()]
  return {
    status: 200,
    body: {
      configured: targets(),
      total: all.length,
      recent: all.slice(-limit).reverse(),
      urls,
    },
  }
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
  if (route.path === 'check' && route.method === 'POST') return check(body)
  if (route.path === 'status' && route.method === 'POST') return status(body)
  if (route.path === 'health' && route.method === 'GET') {
    return { status: 200, body: { ok: true, readyAt, targets: targets().length } }
  }
  return {
    status: 404,
    body: { error: 'unknown route ' + String(route.method) + ' ' + String(route.path) },
  }
}

/** 定时巡检：查配置里的全部地址，只在失败且用户没关提醒时发通知。 */
async function onSchedule() {
  const list = targets()
  if (!list.length) return { ok: true, skipped: 'no targets' }
  const timeout = timeoutOf()
  const records = []
  for (const url of list) records.push(await probe(url, timeout))
  await record(records)
  const failed = records.filter((item) => !item.ok)
  if (failed.length && configFlag('notifyOnFailure', true)) {
    await notify(`巡检发现 ${failed.length} 个地址异常：\n${failed.map((item) => `· ${item.url}（${item.status || item.error || '无响应'}）`).join('\n')}`)
  }
  return { ok: true, checked: records.length, failed: failed.length }
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
  process.stdout.write(
    JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n',
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
