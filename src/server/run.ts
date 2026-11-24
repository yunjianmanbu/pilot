/**
 * `pilot run "<task>"` — one prompt, one process, no terminal UI.
 *
 * Built on the same assembly path as the desktop window and the headless server
 * (`src/core/engine.ts`), so an unattended run gets the same sandbox, checkpoints,
 * approval policy and audit trail as a task typed into the panel. What differs is
 * only the host: nothing to click, so the exit code carries the outcome.
 *
 * The model key is read from `PILOT_API_KEY` (see `env.ts`) and written into the
 * store through `updateSettings`, which seals it with safeStorage — the same
 * encrypted field the settings page writes. A CI job can therefore pass a key
 * without the key ever being persisted in clear text.
 */
import { readFile } from 'node:fs/promises'
import { createEngine } from '../core/engine'
import { Store } from '../main/store'
import type { RunEvent } from '../shared/types'
import type { RunOptions } from './args'
import { applyModelEnv } from './env'
import { applyDataDir } from './paths'

/** Exit codes are part of the CLI contract; keep them stable. */
export const RUN_EXIT = {
  completed: 0,
  failed: 1,
  usage: 2,
  unfinished: 3,
  timeout: 4,
} as const

interface Outcome {
  status: 'completed' | 'paused' | 'cancelled' | 'max_steps' | 'token_limit' | 'failed'
  steps: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  message: string
  error?: string
}

function writeOut(text: string): void {
  process.stdout.write(text)
}

function writeErr(text: string): void {
  process.stderr.write(text)
}

/** Prompt from argv, a file, or stdin (`--prompt-file -`). */
async function resolvePrompt(options: RunOptions): Promise<string> {
  if (options.promptFile) {
    if (options.promptFile === '-') {
      const chunks: Buffer[] = []
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
      return Buffer.concat(chunks).toString('utf8').trim()
    }
    return (await readFile(options.promptFile, 'utf8')).trim()
  }
  return options.prompt.trim()
}

/** The final assistant message is the answer a caller wants on stdout. */
function finalText(store: Store, sessionId: string): string {
  const session = store.session(sessionId)
  const messages = session?.messages ?? []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message && message.role === 'assistant' && message.content.trim()) {
      return message.content.trim()
    }
  }
  return ''
}

/**
 * Run one task and return the process exit code.
 *
 * Every failure path writes a readable reason to stderr: an unattended caller
 * only sees the exit code and the log.
 */
export async function runOnce(options: RunOptions): Promise<number> {
  const prompt = await resolvePrompt(options)
  if (!prompt) {
    writeErr('错误：没有任务内容。用 `pilot run "任务文字"` 或 `--prompt-file <文件>`。\n')
    return RUN_EXIT.usage
  }

  const dataDir = applyDataDir(options.dataDir)
  const store = new Store()
  await store.load()

  // Same rule as `pilot serve`: the environment supplies the key, and only when
  // it is actually set, so an existing data directory keeps its own setting.
  //
  // Applied before the workspace write below: a fresh store seeded by
  // `defaults()` holds an environment key as base64, and `addWorkspace` saves,
  // which would persist that unsealed copy. `updateSettings` seals it with
  // safeStorage first, so the plaintext never reaches the disk.
  await applyModelEnv(store)
  if (!store.getApiKey()) {
    writeErr(
      '错误：没有配置模型 API Key。请用环境变量启动：PILOT_API_KEY=... pilot run "..."\n' +
        '      （Key 由 safeStorage 加密后写入数据目录，不会以明文落盘。）\n',
    )
    return RUN_EXIT.usage
  }

  const workspaceInput = (options.workspace || process.cwd()).trim()
  // `addWorkspace` stats and realpaths the directory and de-duplicates an
  // already-open one, so a typo fails here with a clear message instead of
  // halfway through the run. Its return value is the canonical path that
  // `createSession` will accept.
  let workspace: string
  try {
    workspace = (await store.addWorkspace(workspaceInput, { activate: true })).path
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    writeErr(`错误：工作区不可用（${workspaceInput}）：${message}\n`)
    return RUN_EXIT.usage
  }

  const previousMaxSteps = store.settings().maxSteps
  if (options.maxSteps > 0) await store.updateSettings({ maxSteps: options.maxSteps })

  let settle: ((outcome: Outcome) => void) | null = null
  const finished = new Promise<Outcome>((resolve) => {
    settle = resolve
  })
  let settled = false
  const finish = (outcome: Outcome): void => {
    if (settled) return
    settled = true
    settle?.(outcome)
  }

  let runner: ReturnType<typeof createEngine>['runner'] | null = null
  const publish = (event: RunEvent): void => {
    if (options.jsonEvents) writeOut(`${JSON.stringify(event)}\n`)
    switch (event.type) {
      case 'run.completed':
        finish({
          status: event.status,
          steps: event.steps,
          promptTokens: event.usage.promptTokens,
          completionTokens: event.usage.completionTokens,
          totalTokens: event.usage.totalTokens,
          message: '',
        })
        break
      case 'run.failed':
        finish({
          status: 'failed',
          steps: 0,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          message: '',
          error: event.message,
        })
        break
      case 'tool.approval_required':
        // No human is watching, and an unattended process must never approve its
        // own writes. Deny immediately instead of waiting for the approval timeout.
        writeErr(`未批准：${event.call.name}（非交互模式不等待人工审批）\n`)
        void runner?.decideApproval(event.call.id, false, '非交互模式（pilot run）不等待人工审批')
        break
      case 'message.delta':
        // Answer text is printed once at the end; only NDJSON mode streams.
        break
      default:
        break
    }
  }

  const engine = createEngine({ store, dataDir, publish })
  runner = engine.runner

  let sessionId = ''
  let timer: NodeJS.Timeout | undefined
  try {
    const session = await store.createSession(workspace, {
      title: options.title || prompt.slice(0, 40),
    })
    sessionId = session.id
    await store.updateSession(sessionId, { approvalMode: options.approvalMode })

    if (options.timeoutSec > 0) {
      timer = setTimeout(() => {
        writeErr(`超时：${options.timeoutSec} 秒内未完成，正在取消。\n`)
        finish({
          status: 'cancelled',
          steps: 0,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          message: '',
          error: 'timeout',
        })
        void engine.runner.cancelRun(sessionId).catch(() => undefined)
      }, options.timeoutSec * 1_000)
      timer.unref?.()
    }

    await engine.runner.sendMessage(sessionId, prompt, 'queue')
    const outcome = await finished
    if (!options.json && !options.jsonEvents) writeOut('\n')
    const text = outcome.message || finalText(store, sessionId)

    if (options.json || options.jsonEvents) {
      writeOut(
        `${JSON.stringify({
          ...(options.jsonEvents ? { type: 'result' } : {}),
          status: outcome.status,
          sessionId,
          workspace,
          steps: outcome.steps,
          usage: {
            promptTokens: outcome.promptTokens,
            completionTokens: outcome.completionTokens,
            totalTokens: outcome.totalTokens,
          },
          ...(outcome.error ? { error: outcome.error } : {}),
          text,
        })}\n`,
      )
    } else {
      if (text) writeOut(`${text}\n`)
      writeErr(
        `\n状态 ${outcome.status} · ${outcome.steps} 步 · ` +
          `${outcome.promptTokens + outcome.completionTokens} token · 会话 ${sessionId}\n`,
      )
    }

    if (outcome.error === 'timeout') return RUN_EXIT.timeout
    if (outcome.status === 'failed') return RUN_EXIT.failed
    if (outcome.status === 'completed') return RUN_EXIT.completed
    return RUN_EXIT.unfinished
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    writeErr(`错误：${message}\n`)
    // A missing key surfaces here when the store accepted the write but the
    // endpoint rejects it; keep it in the usage bucket so callers can retry.
    return /API key|apiKey|401|403/i.test(message) ? RUN_EXIT.usage : RUN_EXIT.failed
  } finally {
    if (timer) clearTimeout(timer)
    if (!settled) {
      finish({
        status: 'failed',
        steps: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        message: '',
        error: 'aborted',
      })
    }
    if (options.maxSteps > 0) {
      await store.updateSettings({ maxSteps: previousMaxSteps }).catch(() => undefined)
    }
    await engine.runner.shutdown().catch(() => undefined)
    // A checkpoint watcher and the scheduler timer outlive a run by design (the
    // desktop window keeps them for the whole session), but this process is
    // about to exit: an open `FSWatcher` keeps the event loop alive and the
    // command would hang after printing its result.
    engine.checkpoints.dispose()
    engine.scheduler.stop()
  }
}
