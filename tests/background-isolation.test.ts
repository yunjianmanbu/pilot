import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 副线隔离的源码契约。
 *
 * `background-scheduler.test.ts` 证明的是队列自身的行为；这里守的是另一条
 * 纪律：**以后新加的副线也要满足同样的条件**，否则「副线不影响对话」只在
 * 今天成立。规则只有两条：
 *
 * 1. 每个 `schedule(` 调用点都必须显式写 `whenIdle: true` 和 `timeoutMs`：
 *    前者是让路开关（默认值也能生效，但显式写出来才看得出这是有意的），
 *    后者保证一次卡死的副线不会永久占住单并发队列。
 * 2. `void this.xxx(...)` 这种 fire-and-forget 必须链 `.catch(`：唯一例外是
 *    `execute`，它是每一次运行的总入口，异常在内部逐个节点兜住。
 */

const MAIN = path.join(__dirname, '..', 'src', 'main')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(full))
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

/** 跳过字符串字面量，把 `from` 处的括号找到配对的闭括号（不含自身）。 */
function matchingParen(code: string, from: number): number {
  let depth = 0
  for (let index = from; index < code.length; index += 1) {
    const char = code[index]
    if (char === '"' || char === "'" || char === '`') {
      const quote = char
      index += 1
      while (index < code.length && code[index] !== quote) {
        if (code[index] === '\\') index += 1
        index += 1
      }
      continue
    }
    if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/** 从调用表达式结束处往后收集链式调用名，例如 ['.then', '.catch']。 */
function chainedCalls(code: string, endIndex: number): string[] {
  const names: string[] = []
  let index = endIndex + 1
  for (;;) {
    while (index < code.length && /\s/.test(code[index] as string)) index += 1
    if (code[index] !== '.') return names
    const match = /^\.\s*([A-Za-z_$][\w$]*)/.exec(code.slice(index))
    if (!match) return names
    names.push(match[1] as string)
    index += match[0].length
    while (index < code.length && /\s/.test(code[index] as string)) index += 1
    if (code[index] !== '(') return names
    const close = matchingParen(code, index)
    if (close < 0) return names
    // +1：跳过闭括号自身，否则下一轮会读到 ')' 而直接判定链结束，
    // `.then(…).catch(…)` 里的 catch 就永远看不到。
    index = close + 1
  }
}

/**
 * 标记为 `@background-isolated` 的函数：异常已在函数体内收口，调用点因此不需要再链
 * `.catch`。标记必须真的伴随函数体内的 try/catch，否则这里直接判失败——避免拿标记
 * 糊弄契约。
 */
function isolatedFunctions(
  code: string,
  rel: string,
): { names: Set<string>; unguarded: string[] } {
  const names = new Set<string>()
  const unguarded: string[] = []
  const pattern =
    /@background-isolated[\s\S]{0,200}?\*\/\s*(?:export\s+)?(?:private\s+|public\s+|protected\s+)?(?:async\s+)?(?:function\s+)?([A-Za-z_$][\w$]*)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(code))) {
    const name = match[1] as string
    names.add(name)
    const body = code.slice(match.index, match.index + 4000)
    if (!/catch\s*[({]/.test(body)) unguarded.push(`${rel}:${name}`)
  }
  return { names, unguarded }
}

describe('副线隔离：源码契约', () => {
  it('every schedule() call lets a running conversation go first, and has a timeout', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(MAIN)) {
      // 队列自身不调用 schedule：只有调用方需要遵守这条规则。
      if (path.basename(file) === 'background.ts') continue
      const code = fs.readFileSync(file, 'utf8')
      const pattern = /\.schedule\s*\(/g
      let match: RegExpExecArray | null
      while ((match = pattern.exec(code))) {
        const open = match.index + match[0].length - 1
        const close = matchingParen(code, open)
        if (close < 0) continue
        const args = code.slice(open, close)
        const line = code.slice(0, match.index).split('\n').length
        const where = `${path.relative(MAIN, file)}:${line}`
        if (!/whenIdle:\s*true/.test(args)) offenders.push(`${where} 缺少 whenIdle: true`)
        if (!/timeoutMs:/.test(args)) offenders.push(`${where} 缺少 timeoutMs`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('every fire-and-forget background call handles its rejection', () => {
    const offenders: string[] = []
    const unguarded: string[] = []
    for (const file of sourceFiles(MAIN)) {
      const code = fs.readFileSync(file, 'utf8')
      const rel = path.relative(MAIN, file)
      const isolated = isolatedFunctions(code, rel)
      unguarded.push(...isolated.unguarded)
      const pattern = /void\s+this\.([A-Za-z_$][\w$]*)\s*\(/g
      let match: RegExpExecArray | null
      while ((match = pattern.exec(code))) {
        const name = match[1] as string
        // `execute` 是运行的唯一入口，内部每个节点各自兜异常；其余 fire-and-forget
        // 都必须自己链 catch，或由被调函数用 `@background-isolated` 声明已收口。
        if (name === 'execute') continue
        const open = match.index + match[0].length - 1
        const close = matchingParen(code, open)
        if (close < 0) continue
        const chain = chainedCalls(code, close)
        if (chain.includes('catch') || isolated.names.has(name)) continue
        const line = code.slice(0, match.index).split('\n').length
        offenders.push(`${rel}:${line} void this.${name}(…)`)
      }
    }
    expect(unguarded).toEqual([])
    expect(offenders).toEqual([])
  })

  it('diagnostics survives an unreadable log file', async () => {
    // 面板要答的是「主进程是否被堵」，日志只是附加证据：读失败就降级为空。
    const { collectDiagnostics } = await import('../src/main/diagnostics')
    const snapshot = await collectDiagnostics(10)
    expect(Array.isArray(snapshot.records)).toBe(true)
    expect(snapshot.health).toBeTruthy()
  })
})
