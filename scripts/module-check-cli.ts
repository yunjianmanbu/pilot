/**
 * 无头模块自检 CLI：在终端里跑与界面完全相同的扫描与规则，产出可对比的 JSON。
 *
 * 用途：
 * - 迭代优化时先跑一次基线、改完再跑一次，用 `--compare` 对比得分与风险变化；
 * - CI 里用 `--fail-on-high` 把高优先级风险变成红灯，而不是靠人肉看报告。
 *
 * 与界面共享同一个 `ModuleCheckService`，所以模块划分、文件预算、规则判定都
 * 不会和面板里显示的结果不一致；这里只把 userData 换成一个临时目录，避免污染
 * 用户真实的报告历史。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ModuleCheckService } from '../src/main/module-check'
import { ruleLabel, severityLabel, type ModuleCheckReport } from '../src/shared/module-check'

interface CliOptions {
  /** 要扫的根目录（默认当前目录）：CLI 是开发工具，默认扫本仓代码本身。 */
  root: string
  modules: string[] | null
  json: string | null
  compare: string | null
  failOnHigh: boolean
  quiet: boolean
}

function parseArgs(argv: string[]): CliOptions {
  const value = (name: string): string | null => {
    const index = argv.indexOf(`--${name}`)
    if (index === -1) return null
    const next = argv[index + 1]
    return next && !next.startsWith('--') ? next : ''
  }
  const modules = value('modules')
  return {
    root: resolve(value('root') || value('workspace') || process.cwd()),
    modules:
      modules === null
        ? null
        : modules
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean),
    json: value('json') || null,
    compare: value('compare') || null,
    failOnHigh: argv.includes('--fail-on-high'),
    quiet: argv.includes('--quiet'),
  }
}

function formatReport(report: ModuleCheckReport): string {
  const lines: string[] = []
  lines.push(
    `自检 ${report.id} · ${report.trigger} · 得分 ${report.score}/100 · ` +
      `${report.scannedFiles} 文件 / ${report.scannedLines} 行 · ${report.modules.length} 模块`,
  )
  const worstFirst = [...report.targets].sort((left, right) => right.lines - left.lines)
  for (const target of worstFirst) {
    lines.push(
      `  ${target.name.padEnd(24)} ${String(target.files).padStart(5)} 文件 ` +
        `${String(target.lines).padStart(7)} 行  源文件 ${target.sourceFiles}  测试 ${target.testFiles}`,
    )
  }
  if (report.risks.length === 0) {
    lines.push('  没有发现风险点。')
    return lines.join('\n')
  }
  lines.push(`风险点 ${report.risks.length} 条：`)
  for (const risk of report.risks) {
    const manual = risk.manual ? ' [需人工]' : ''
    lines.push(`  - [${severityLabel(risk.severity)}] ${risk.moduleName} · ${ruleLabel(risk.rule)}${manual}`)
    lines.push(`    ${risk.title}`)
    for (const item of risk.evidence.slice(0, 4)) lines.push(`      ${item}`)
  }
  return lines.join('\n')
}

function compareReports(before: ModuleCheckReport, after: ModuleCheckReport): string {
  // 按“模块＋规则”对齐：标题里带着计数，用标题做键会让同一问题的数量变化
  // 被误报成“消除一条 + 新增一条”，对比就失去意义。
  const key = (risk: ModuleCheckReport['risks'][number]): string => `${risk.moduleId}|${risk.rule}`
  const beforeMap = new Map(before.risks.map((risk) => [key(risk), risk]))
  const afterMap = new Map(after.risks.map((risk) => [key(risk), risk]))
  const gone = [...beforeMap.values()].filter((risk) => !afterMap.has(key(risk)))
  const fresh = [...afterMap.values()].filter((risk) => !beforeMap.has(key(risk)))
  const moved = [...afterMap.values()].filter((risk) => {
    const old = beforeMap.get(key(risk))
    return old !== undefined && (old.severity !== risk.severity || old.count !== risk.count)
  })
  const lines = [
    `对比 ${before.id} → ${after.id}`,
    `  得分 ${before.score} → ${after.score}（${after.score - before.score >= 0 ? '+' : ''}${after.score - before.score}）`,
    `  风险 ${before.risks.length} → ${after.risks.length}（消除 ${gone.length}，新增 ${fresh.length}，变化 ${moved.length}）`,
  ]
  for (const risk of gone) {
    lines.push(`  ✓ 消除 ${risk.moduleName} · ${ruleLabel(risk.rule)}（原有 ${risk.count}）`)
  }
  for (const risk of fresh) {
    lines.push(`  + 新增 ${risk.moduleName} · ${ruleLabel(risk.rule)}（${risk.count}）`)
  }
  for (const risk of moved) {
    const old = beforeMap.get(key(risk))
    if (!old) continue
    lines.push(
      `  ~ 变化 ${risk.moduleName} · ${ruleLabel(risk.rule)}：` +
        `${severityLabel(old.severity)} ${old.count} → ${severityLabel(risk.severity)} ${risk.count}`,
    )
  }
  return lines.join('\n')
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const startedAt = performance.now()
  const userDataDir = await mkdtemp(join(tmpdir(), 'pilot-module-check-'))
  try {
    const service = new ModuleCheckService({
      userDataDir,
      // 界面里自检固定扫内置源码；CLI 允许用 `--root` 指定一份源码做对比。
      sourceRoot: () => options.root,
      emit: () => undefined,
      startSession: async () => {
        throw new Error('CLI 不创建会话')
      },
    })
    const discovered = await service.discover()
    if (discovered.length === 0) {
      console.error(`目录里没有可自检的模块：${options.root}`)
      process.exitCode = 2
      return
    }
    if (!options.quiet) {
      console.log(`目录 ${options.root} · 发现 ${discovered.length} 个模块`)
    }
    const report = await service.run(options.modules ?? undefined, 'manual')
    console.log(formatReport(report))
    // 扫描成本本身就是瓶颈指标：文件数不变而耗时变长，说明规则在退步。
    if (!options.quiet) {
      const elapsed = Math.round(performance.now() - startedAt)
      console.log(`扫描耗时 ${elapsed} ms（${(report.scannedFiles / Math.max(elapsed, 1) * 1000).toFixed(0)} 文件/秒）`)
    }
    if (options.json) {
      await writeFile(options.json, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
      if (!options.quiet) console.log(`报告已写入 ${options.json}`)
    }
    if (options.compare) {
      const { readFile } = await import('node:fs/promises')
      const before = JSON.parse(await readFile(options.compare, 'utf8')) as ModuleCheckReport
      console.log(compareReports(before, report))
    }
    if (options.failOnHigh && report.risks.some((risk) => risk.severity === 'high')) {
      process.exitCode = 1
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
