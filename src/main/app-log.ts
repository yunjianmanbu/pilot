import { appendFile, mkdir, readdir, readFile, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { redactSecrets } from './agent/redact'

/**
 * 应用级日志：把「自检 / 内视 / 自改 / 运行结束」这类事件写成按天滚动的 JSONL，
 * 供内视与用户事后复盘，而不是只活在内存里的最后一份报告。
 *
 * 边界：
 * - 只记元数据（时间、领域、事件名、少量计数与短摘要），**绝不**记消息正文、
 *   提问文本、命令输出原文、密钥；写盘前统一走 `redactSecrets` 并截断。
 * - 任何写入失败都被吞掉：日志是辅助信息，不能反过来让功能失败。
 * - 文件落在 userData 下，不进工作区，因此不会污染用户仓库、也不会被自改。
 */

export type AppLogLevel = 'info' | 'warn' | 'error'

export interface AppLogEntry {
  /** 领域，例如 `module-check` / `self-check` / `run` / `self-modify`。 */
  area: string
  /** 事件名，稳定短语，便于 grep 与聚合。 */
  event: string
  level?: AppLogLevel
  /** 少量结构化细节；只允许短字符串、数字、布尔值。 */
  detail?: Record<string, unknown>
}

export interface AppLogRecord extends AppLogEntry {
  at: string
}

export interface AppLog {
  /** 同步返回、异步落盘；调用方不需要 await，也拿不到异常。 */
  write(entry: AppLogEntry): void
  /** 读回最近的记录，用于内视与问题定位。 */
  recent(limit?: number): Promise<AppLogRecord[]>
  /** 按保留策略清理过期文件（写日志时会自动触发，也可手动调用）。 */
  prune(): Promise<void>
  /** 当前日志目录。 */
  dir: string
}

/** 细节字段名的黑名单：即便调用方手滑也不能把正文写进日志。 */
const SENSITIVE_KEY = /pass(word)?|secret|token|api[-_]?key|authorization|cookie|credential|prompt|content|message|stdout|stderr/i

const MAX_DETAIL_STRING = 240
const MAX_DETAIL_KEYS = 24
const MAX_DEPTH = 3
const DEFAULT_RECENT = 200
const KEEP_FILES = 14
/**
 * 保留策略：日志用于复盘而非归档。超过 30 天的按天文件直接删掉，总量压到 20MB
 * 以内（先删最旧的）。写日志时每小时最多触发一次，避免每次 append 都扫目录。
 */
const KEEP_DAYS = 30
const MAX_TOTAL_BYTES = 20 * 1024 * 1024
const PRUNE_INTERVAL_MS = 60 * 60 * 1000
const APP_LOG_FILE = /^app-\d{4}-\d{2}-\d{2}\.jsonl$/

export function redactDetailValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return redactSecrets(value).slice(0, MAX_DETAIL_STRING)
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean' || value === null) return value
  if (depth >= MAX_DEPTH) return '<truncated>'
  if (Array.isArray(value)) {
    return value.slice(0, 8).map((item) => redactDetailValue(item, depth + 1))
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, MAX_DETAIL_KEYS)) {
      out[key] = SENSITIVE_KEY.test(key) ? '<redacted>' : redactDetailValue(item, depth + 1)
    }
    return out
  }
  return null
}

export function dayStamp(date: Date): string {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function appLogFileName(date: Date): string {
  return `app-${dayStamp(date)}.jsonl`
}

/** 把一条记录序列化成单行 JSON；不可序列化的部分已被 `redactDetailValue` 摘掉。 */
export function serializeEntry(entry: AppLogEntry, now: Date): string {
  const record: AppLogRecord = {
    at: now.toISOString(),
    area: entry.area.slice(0, 40),
    event: entry.event.slice(0, 80),
    level: entry.level ?? 'info',
  }
  if (entry.detail) record.detail = redactDetailValue(entry.detail) as Record<string, unknown>
  return `${JSON.stringify(record)}\n`
}

export function createAppLog(options: { dir: string; now?: () => Date }): AppLog {
  const now = options.now ?? (() => new Date())
  // 串行化写入：并发 append 同一文件在 Windows 上仍然安全，但顺序会乱。
  let chain: Promise<void> = Promise.resolve()
  let lastPrune = Number.NEGATIVE_INFINITY

  const enqueue = (task: () => Promise<void>): Promise<void> => {
    chain = chain.then(task).catch(() => undefined)
    return chain
  }

  /** 删掉超过 KEEP_DAYS 天的文件，再把总量压到 MAX_TOTAL_BYTES 以内（从最旧删起）。 */
  const prune = (): Promise<void> =>
    enqueue(async () => {
      let names: string[] = []
      try {
        names = (await readdir(options.dir)).filter((name) => APP_LOG_FILE.test(name)).sort()
      } catch {
        return
      }
      // 文件名形如 app-2026-01-05.jsonl，日期可以直接按字符串比较。
      const cutoff = dayStamp(new Date(now().getTime() - KEEP_DAYS * 86_400_000))
      const kept: string[] = []
      for (const name of names) {
        if (name.slice(4, 14) >= cutoff) {
          kept.push(name)
          continue
        }
        try {
          await unlink(join(options.dir, name))
        } catch {
          // 已被别处删掉或权限不足：清理失败不该影响功能。
        }
      }
      let total = 0
      for (let index = kept.length - 1; index >= 0; index -= 1) {
        const name = kept[index]!
        let size = 0
        try {
          size = (await stat(join(options.dir, name))).size
        } catch {
          continue
        }
        total += size
        if (total <= MAX_TOTAL_BYTES) continue
        try {
          await unlink(join(options.dir, name))
        } catch {
          // 同上。
        }
      }
    })

  const write = (entry: AppLogEntry): void => {
    const moment = now()
    const line = serializeEntry(entry, moment)
    const target = join(options.dir, appLogFileName(moment))
    void enqueue(async () => {
      await mkdir(options.dir, { recursive: true })
      await appendFile(target, line, { encoding: 'utf8', mode: 0o600 })
    })
    const stamp = moment.getTime()
    if (stamp - lastPrune >= PRUNE_INTERVAL_MS) {
      lastPrune = stamp
      void prune()
    }
  }

  return {
    dir: options.dir,
    write,
    prune,
    recent: async (limit = DEFAULT_RECENT) => {
      const capped = Math.max(1, Math.min(2_000, Math.round(limit)))
      await chain.catch(() => undefined)
      let names: string[] = []
      try {
        names = (await readdir(options.dir)).filter((name) => APP_LOG_FILE.test(name)).sort()
      } catch {
        return []
      }
      // 只读最近几次滚动的文件，避免把整年的日志都读进内存。
      const files = names.slice(-KEEP_FILES)
      const records: AppLogRecord[] = []
      for (const name of files) {
        let text = ''
        try {
          text = await readFile(join(options.dir, name), 'utf8')
        } catch {
          continue
        }
        for (const line of text.split('\n')) {
          if (!line.trim()) continue
          try {
            records.push(JSON.parse(line) as AppLogRecord)
          } catch {
            // 半行/坏行直接跳过：日志不该因为一行损坏而整体失败。
          }
        }
      }
      return records.slice(-capped)
    },
  }
}
