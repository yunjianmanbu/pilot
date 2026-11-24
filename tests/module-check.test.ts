import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildOptimizePrompt,
  buildReport,
  evaluateModule,
  moduleCheckScore,
  sanitizeModuleCheckState,
  sortRisks,
  type ModuleFileFact,
  type ModuleRisk,
} from '../src/shared/module-check'
import { ModuleCheckService } from '../src/main/module-check'
import { SPLIT_DECISIONS, splitDecisionIndex } from '../src/shared/split-decisions'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pilot-module-check-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function fact(path: string, lines: number, text = '', bytes?: number): ModuleFileFact {
  return { path, lines, bytes: bytes ?? Math.max(text.length, lines * 40), text }
}

function repeat(count: number, line: string): string {
  return Array.from({ length: count }, () => line).join('\n')
}

describe('evaluateModule', () => {
  it('把超过阈值的文件标成待量化，而不是直接判该拆', () => {
    const risks = evaluateModule({
      id: 'client',
      name: 'client',
      files: [fact('src/big.ts', 1700), fact('src/ok.ts', 120)],
    })
    const oversized = risks.find((risk) => risk.rule === 'oversized-file')
    expect(oversized).toBeDefined()
    // 行数只说明「需要量化一次」：既不是 high，也不允许自改会话自动动手。
    expect(oversized?.severity).toBe('low')
    expect(oversized?.manual).toBe(true)
    expect(oversized?.recommendation).toContain('split-candidates.mjs')
    expect(oversized?.basis).toContain('DATA')
    expect(oversized?.evidence[0]).toContain('src/big.ts')
    expect(oversized?.evidence[0]).toContain('1700')
  })

  it('已记录拆分决策的文件不再被建议拆分', () => {
    const decided = SPLIT_DECISIONS[0]
    expect(decided).toBeDefined()
    const files = [fact(decided!.path, 1700)]
    // 默认决策表就是全量：仓库里记录过的文件一开始就不该被建议。
    const withTable = evaluateModule({ id: 'm', name: 'm', files })
    expect(withTable.some((risk) => risk.rule === 'oversized-file')).toBe(false)
    // 同一份文件在没有决策时确实会被报出来，证明上面的“不报”是决策生效而不是规则失效。
    const withoutTable = evaluateModule({ id: 'm', name: 'm', files, decisions: [] })
    expect(withoutTable.some((risk) => risk.rule === 'oversized-file')).toBe(true)
  })

  it('已决策文件会作为「另有 N 个」出现在未决策文件的提示里', () => {
    const decidedPath = SPLIT_DECISIONS[0]!.path
    const risks = evaluateModule({
      id: 'm',
      name: 'm',
      files: [fact(decidedPath, 1800), fact('src/new-big.ts', 1200)],
      decisions: SPLIT_DECISIONS,
    })
    const oversized = risks.find((risk) => risk.rule === 'oversized-file')
    expect(oversized).toBeDefined()
    expect(oversized?.count).toBe(1)
    expect(oversized?.detail).toContain('另有 1 个同类文件已有拆分决策')
    expect(oversized?.evidence.join(' ')).not.toContain(decidedPath)
  })

  it('已有判据码但未决策时，建议按判据收尾而不是重新量化', () => {
    // src/main/agent/loop.ts 在实测判据表里是 METHOD（已有判据，但仓库里已记录 keep）。
    // 这里用一份没有决策的表，单独看“有判据、无决策”这一类的措辞。
    const risks = evaluateModule({
      id: 'm',
      name: 'm',
      files: [fact('src/main/agent/loop.ts', 1483)],
      decisions: [],
    })
    const oversized = risks.find((risk) => risk.rule === 'oversized-file')
    expect(oversized?.detail).toContain('1 个已有判据码')
    expect(oversized?.detail).toContain('0 个还没量过')
    expect(oversized?.detail).toContain('METHOD')
    expect(oversized?.evidence[0]).toContain('判据 METHOD')
    expect(oversized?.recommendation).toContain('按判据码收尾')
    expect(oversized?.recommendation).not.toContain('还没量过的先量一次')
    // 即使有判据码，也不允许自改会话直接动手。
    expect(oversized?.severity).toBe('low')
    expect(oversized?.manual).toBe(true)
  })

  it('没量过的文件要求先跑脚本，不说该拆', () => {
    const risks = evaluateModule({
      id: 'm',
      name: 'm',
      files: [fact('src/main/brand-new.ts', 1200)],
      decisions: [],
    })
    const oversized = risks.find((risk) => risk.rule === 'oversized-file')
    expect(oversized?.detail).toContain('1 个还没量过')
    expect(oversized?.evidence[0]).toContain('未量化')
    expect(oversized?.recommendation).toContain('split-candidates.mjs')
    // 建议文本里不得出现“直接拆”的说法：拆不拆必须由判据码 + 人决策。
    expect(oversized?.recommendation).not.toContain('建议拆分')
    expect(oversized?.basis).toContain('SPLIT_SCAN')
  })

  it('决策表里的路径写法与扫描路径写法不同也能匹配', () => {
    const index = splitDecisionIndex([
      { path: './src/main/agent/loop.ts', kind: 'keep', reason: 'x', evidence: [] },
    ])
    expect(index.has('src/main/agent/loop.ts')).toBe(true)
  })

  it('没有超过阈值的文件时不报告超大文件', () => {
    const risks = evaluateModule({
      id: 'client',
      name: 'client',
      files: [fact('src/a.ts', 200), fact('src/b.ts', 300)],
    })
    expect(risks.some((risk) => risk.rule === 'oversized-file')).toBe(false)
  })

  it('只在 TODO 达到阈值时才报告待办积压', () => {
    const few = evaluateModule({
      id: 'm',
      name: 'm',
      files: [fact('src/a.ts', 3, '// TODO: one\n// FIXME: two\nconst a = 1')],
    })
    expect(few.some((risk) => risk.rule === 'todo-backlog')).toBe(false)

    const many = evaluateModule({
      id: 'm',
      name: 'm',
      files: [fact('src/a.ts', 4, '// TODO: one\n// FIXME: two\n// HACK: three\nconst a = 1')],
    })
    const backlog = many.find((risk) => risk.rule === 'todo-backlog')
    expect(backlog?.count).toBe(3)
    expect(backlog?.evidence).toContain('src/a.ts:1')
  })

  it('跳过测试文件里的 console 输出，但统计生产代码里的', () => {
    const risks = evaluateModule({
      id: 'm',
      name: 'm',
      files: [
        fact('src/tests/a.test.ts', 2, "console.log('debug')\n"),
        fact('src/app.ts', 2, "console.log('debug')\n"),
      ],
    })
    const logging = risks.find((risk) => risk.rule === 'debug-logging')
    expect(logging?.count).toBe(1)
    expect(logging?.evidence).toEqual(['src/app.ts:1'])
  })

  it('源文件够多且完全没有测试时才报缺少测试', () => {
    const files = Array.from({ length: 8 }, (_unused, index) => fact(`src/f${index}.ts`, 10))
    const risks = evaluateModule({ id: 'm', name: 'm', files })
    const missing = risks.find((risk) => risk.rule === 'missing-tests')
    expect(missing?.severity).toBe('medium')
    expect(missing?.count).toBe(8)

    const withTest = evaluateModule({
      id: 'm',
      name: 'm',
      files: [...files, fact('src/tests/a.test.ts', 5)],
    })
    expect(withTest.some((risk) => risk.rule === 'missing-tests')).toBe(false)
  })

  it('疑似凭据只记录位置，绝不把命中内容写进报告', () => {
    const secretLine = 'const key = "sk-abcdefghijklmnopqrstuvwxyz012345"'
    const risks = evaluateModule({
      id: 'm',
      name: 'm',
      files: [fact('src/config.ts', 1, secretLine)],
    })
    const secret = risks.find((risk) => risk.rule === 'secret-like')
    expect(secret?.severity).toBe('high')
    expect(secret?.manual).toBe(true)
    expect(secret?.evidence).toEqual(['src/config.ts:1'])
    const serialized = JSON.stringify(secret)
    expect(serialized).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345')
  })

  it('文档里的示例路径不计入硬编码路径，代码里的计入', () => {
    const risks = evaluateModule({
      id: 'm',
      name: 'm',
      files: [
        fact('docs/readme.md', 1, 'C:\\Users\\someone\\project\\file.ts'),
        fact('src/io.ts', 1, 'const dir = "C:\\Users\\someone\\project"'),
      ],
    })
    const hardcoded = risks.find((risk) => risk.rule === 'hardcoded-path')
    expect(hardcoded?.count).toBe(1)
    expect(hardcoded?.evidence).toEqual(['src/io.ts:1'])
  })

  it('同名同大小的散落拷贝会被识别，同一目录里的同名文件不算', () => {
    const risks = evaluateModule({
      id: 'm',
      name: 'm',
      files: [
        fact('a/feed.ts', 100, 'x', 9000),
        fact('b/feed.ts', 100, 'x', 9000),
        fact('c/other.ts', 10, 'y', 5000),
      ],
    })
    const duplicates = risks.find((risk) => risk.rule === 'duplicate-file')
    expect(duplicates?.count).toBe(1)
    expect(duplicates?.evidence).toContain('a/feed.ts')
  })

  it('package.json 没有 test/typecheck 脚本时给出提示，有脚本时不提', () => {
    const missing = evaluateModule({
      id: 'm',
      name: 'm',
      files: [fact('package.json', 3, '{"name":"x","scripts":{"build":"tsc"}}')],
    })
    expect(missing.some((risk) => risk.rule === 'missing-verification-script')).toBe(true)

    const present = evaluateModule({
      id: 'm',
      name: 'm',
      files: [fact('package.json', 3, '{"scripts":{"test":"vitest run"}}')],
    })
    expect(present.some((risk) => risk.rule === 'missing-verification-script')).toBe(false)
  })

  it('风险 id 稳定，同一模块同一规则只有一条', () => {
    const files = [fact('src/a.ts', 900), fact('src/b.ts', 1000)]
    const first = evaluateModule({ id: 'mod', name: 'mod', files })
    const second = evaluateModule({ id: 'mod', name: 'mod', files })
    expect(first.map((risk) => risk.id)).toEqual(second.map((risk) => risk.id))
    expect(new Set(first.map((risk) => risk.id)).size).toBe(first.length)
    expect(first.every((risk) => risk.id.startsWith('mod:'))).toBe(true)
  })

  // 以下四条都是真实误报的回归用例：改规则前，它们会把锁文件、构建产物、URL、
  // 字符串里的示例和注释里的词算成风险，导致报告里真正的几行被埋掉。
  it('锁文件与构建产物不参与规则判定', () => {
    const risks = evaluateModule({
      id: 'm',
      name: 'm',
      files: [
        fact('src/a.ts', 10, 'const a = 1'),
        fact('pnpm-lock.yaml', 4000, 'C:\\Users\\someone\\x'.repeat(400)),
        fact('unpackage/dist/app.js', 3000, 'console.log("x")'),
      ],
    })
    expect(risks.some((risk) => risk.rule === 'oversized-file')).toBe(false)
    expect(risks.some((risk) => risk.rule === 'hardcoded-path')).toBe(false)
    expect(risks.some((risk) => risk.rule === 'debug-logging')).toBe(false)
  })

  it('不含代码也没有清单的目录（会话记录、缓存）不套任何规则', () => {
    const risks = evaluateModule({
      id: 'history',
      name: 'history',
      files: [
        fact('file-history/a/708d2bcc75d1fa5c@v1', 1000, 'console.log(1)'),
        fact('file-history/b/708d2bcc75d1fa5c@v1', 1000),
      ],
    })
    expect(risks).toEqual([])
  })

  it('URL 不算硬编码路径，真正的本机绝对路径才算', () => {
    const risks = evaluateModule({
      id: 'm',
      name: 'm',
      files: [
        fact('src/update.ts', 3, "export const URL = 'https://download.example.com/app/'"),
        fact('src/tar.ts', 3, "const tar = 'C:\\\\Windows\\\\System32\\\\tar.exe'"),
      ],
    })
    const hardcoded = risks.find((risk) => risk.rule === 'hardcoded-path')
    expect(hardcoded?.count).toBe(1)
    expect(hardcoded?.evidence).toEqual(['src/tar.ts:1'])
  })

  it('注释与字符串里提到的 console.log / TODO 不算残留', () => {
    const risks = evaluateModule({
      id: 'm',
      name: 'm',
      files: [
        fact('src/bench.ts', 2, '  "console.log(\'ok\')",\n// console.log 已被移除'),
        fact('src/doc.ts', 2, '// 规则说明：TODO/FIXME 词本身不算标记\nconst a = 1'),
      ],
    })
    expect(risks.some((risk) => risk.rule === 'debug-logging')).toBe(false)
    expect(risks.some((risk) => risk.rule === 'todo-backlog')).toBe(false)
  })

  it('独立服务脚本的 stdout 不算调试残留，源码目录里的算', () => {
    const risks = evaluateModule({
      id: 'm',
      name: 'm',
      files: [
        fact('pilot-connector/server.mjs', 2, "console.log('listening')"),
        fact('src/main/ipc.ts', 2, "console.log('leaked arg')"),
      ],
    })
    const logging = risks.find((risk) => risk.rule === 'debug-logging')
    expect(logging?.count).toBe(1)
    expect(logging?.evidence).toEqual(['src/main/ipc.ts:1'])
  })
})

describe('分数与排序', () => {
  const risk = (severity: ModuleRisk['severity'], id: string): ModuleRisk => ({
    id,
    moduleId: 'm',
    moduleName: 'm',
    rule: 'debug-logging',
    severity,
    title: id,
    detail: '',
    recommendation: '',
    count: 1,
    evidence: [],
    manual: false,
  })

  it('分数随严重程度下降，并且不会低于 0 或高于 100', () => {
    expect(moduleCheckScore([])).toBe(100)
    expect(moduleCheckScore([risk('low', 'a')])).toBe(98)
    expect(moduleCheckScore([risk('high', 'a')])).toBe(88)
    const heavy = Array.from({ length: 40 }, (_unused, index) => risk('high', `h${index}`))
    expect(moduleCheckScore(heavy)).toBe(0)
  })

  it('高优先级排在最前', () => {
    const sorted = sortRisks([risk('low', 'c'), risk('high', 'a'), risk('medium', 'b')])
    expect(sorted.map((item) => item.severity)).toEqual(['high', 'medium', 'low'])
  })
})

describe('buildOptimizePrompt', () => {
  const report = buildReport({
    id: 'mc_test',
    trigger: 'manual',
    workspace: 'E:/repo',
    startedAt: new Date(0).toISOString(),
    finishedAt: new Date(1000).toISOString(),
    targets: [
      { id: 'client', name: 'client', path: 'client', files: 3, sourceFiles: 2, testFiles: 1, lines: 40 },
    ],
    risks: [
      {
        id: 'client:debug-logging',
        moduleId: 'client',
        moduleName: 'client',
        rule: 'debug-logging',
        severity: 'low',
        title: '2 处 console.log 残留',
        detail: '',
        recommendation: '删掉调试输出',
        count: 2,
        evidence: ['src/a.ts:3'],
        manual: false,
      },
      {
        id: 'client:secret-like',
        moduleId: 'client',
        moduleName: 'client',
        rule: 'secret-like',
        severity: 'high',
        title: '疑似凭据',
        detail: '',
        recommendation: '吊销并轮换',
        count: 1,
        evidence: ['src/key.ts:9'],
        manual: true,
      },
    ],
    scannedFiles: 3,
    scannedLines: 40,
  })

  it('把可自动处理的问题写成带位置与验证要求的任务', () => {
    const prompt = buildOptimizePrompt(report, report.risks)
    expect(prompt).toContain('已确认的优化项')
    expect(prompt).toContain('client')
    expect(prompt).toContain('src/a.ts:3')
    expect(prompt).toContain('删掉调试输出')
    expect(prompt).toContain('完成标准')
    expect(prompt).toContain('每项改动后运行对应的单测或类型检查')
  })

  it('人工处理项单独列出，并明确要求不要自动修改', () => {
    const prompt = buildOptimizePrompt(report, report.risks)
    expect(prompt).toContain('不要自动修改')
    expect(prompt).toContain('src/key.ts:9')
    const accepted = prompt.split('不要自动修改')[0]
    expect(accepted).not.toContain('src/key.ts:9')
  })
})

describe('sanitizeModuleCheckState', () => {
  it('空值退回安全默认值', () => {
    const state = sanitizeModuleCheckState(null)
    expect(state.settings).toEqual({ enabled: false, intervalHours: 24, modules: [] })
    expect(state.history).toEqual([])
    expect(state.decisions).toEqual([])
  })

  it('丢弃不合法的风险与报告，而不是抛错', () => {
    const state = sanitizeModuleCheckState({
      settings: { enabled: 'yes', intervalHours: 'soon', modules: [1, 'client'] },
      history: [
        { id: 'ok', workspace: 'E:/r', startedAt: 'a', finishedAt: 'b', risks: [{ rule: 'nope' }] },
        { id: '', workspace: '', startedAt: '', finishedAt: '' },
      ],
      decisions: [{ reportId: 'ok', sessionId: 's1', at: 'now', riskIds: ['x', 3] }],
    })
    expect(state.settings.enabled).toBe(false)
    expect(state.settings.intervalHours).toBe(24)
    expect(state.settings.modules).toEqual(['client'])
    expect(state.history).toHaveLength(1)
    expect(state.history[0]?.risks).toEqual([])
    expect(state.decisions).toHaveLength(1)
    expect(state.decisions[0]?.riskIds).toEqual(['x'])
    expect(state.lastReport?.id).toBe('ok')
  })

  it('把间隔限制在合理范围内', () => {
    expect(sanitizeModuleCheckState({ settings: { intervalHours: 0 } }).settings.intervalHours).toBe(1)
    expect(sanitizeModuleCheckState({ settings: { intervalHours: 99999 } }).settings.intervalHours).toBe(720)
  })
})

describe('ModuleCheckService', () => {
  async function makeWorkspace(): Promise<string> {
    const workspace = join(root, 'workspace')
    await mkdir(join(workspace, 'client', 'src'), { recursive: true })
    await mkdir(join(workspace, 'client', 'tests'), { recursive: true })
    await mkdir(join(workspace, 'site'), { recursive: true })
    await writeFile(
      join(workspace, 'client', 'src', 'app.ts'),
      `${repeat(900, 'export const value = 1')}\nconsole.log('debug')\n`,
    )
    await writeFile(join(workspace, 'client', 'src', 'util.ts'), 'export const util = 1\n')
    await writeFile(join(workspace, 'client', 'tests', 'app.test.ts'), "console.log('test')\n")
    await writeFile(join(workspace, 'client', 'package.json'), '{"name":"client","scripts":{"test":"vitest"}}')
    await writeFile(join(workspace, 'site', 'index.html'), '<html></html>')
    // 必须被忽略的目录
    await mkdir(join(workspace, 'client', 'node_modules', 'dep'), { recursive: true })
    await writeFile(join(workspace, 'client', 'node_modules', 'dep', 'index.js'), 'console.log(1)')
    return workspace
  }

  it('发现模块时跳过 node_modules，并扫描出真实风险', async () => {
    const workspace = await makeWorkspace()
    const userData = join(root, 'userdata')
    await mkdir(userData, { recursive: true })
    const service = new ModuleCheckService({
      userDataDir: userData,
      sourceRoot: () => workspace,
      emit: () => undefined,
      startSession: async () => ({ sessionId: 's1' }),
    })

    const targets = await service.discover()
    expect(targets.map((target) => target.path).sort()).toEqual(['client', 'site'])

    const report = await service.run(['client'])
    expect(report.trigger).toBe('manual')
    expect(report.scannedFiles).toBeGreaterThan(0)
    expect(report.targets.map((target) => target.id)).toEqual(['client'])
    const rules = report.risks.map((risk) => risk.rule)
    expect(rules).toContain('oversized-file')
    expect(rules).toContain('debug-logging')
    expect(rules).not.toContain('missing-verification-script')

    // 报告必须落盘，且重新加载后仍然可读
    const raw = JSON.parse(await readFile(join(userData, 'module-check.json'), 'utf8'))
    expect(raw.history[0].id).toBe(report.id)
    const reloaded = new ModuleCheckService({
      userDataDir: userData,
      sourceRoot: () => workspace,
      emit: () => undefined,
      startSession: async () => ({ sessionId: 's1' }),
    })
    await reloaded.load()
    expect(reloaded.snapshot().lastReport?.id).toBe(report.id)
  })

  it('手机摘要不复制历史报告，只返回份数和最新一份', async () => {
    const workspace = await makeWorkspace()
    const userData = join(root, 'userdata')
    await mkdir(userData, { recursive: true })
    const service = new ModuleCheckService({
      userDataDir: userData,
      sourceRoot: () => workspace,
      emit: () => undefined,
      startSession: async () => ({ sessionId: 's1' }),
    })

    const report = await service.run(['client'])
    const summary = service.summary()
    expect(summary.historyCount).toBe(1)
    expect(summary.lastReport?.id).toBe(report.id)
    // 历史报告不随摘要交给手机，否则每次读状态都要深拷贝整份历史。
    expect(summary).not.toHaveProperty('history')
    expect(summary.settings.enabled).toBe(false)
  })

  it('确认自改后才创建会话并发送指令，自检本身不直接改文件', async () => {
    const workspace = await makeWorkspace()
    const userData = join(root, 'userdata')
    await mkdir(userData, { recursive: true })
    const calls: Array<{ workspacePath: string; prompt: string }> = []
    const service = new ModuleCheckService({
      userDataDir: userData,
      sourceRoot: () => workspace,
      emit: () => undefined,
      startSession: async (workspacePath, prompt) => {
        calls.push({ workspacePath, prompt })
        return { sessionId: 'session-1' }
      },
    })
    const before = await readFile(join(workspace, 'client', 'src', 'app.ts'), 'utf8')
    const report = await service.run(['client'])
    const target = report.risks.find((risk) => !risk.manual)
    expect(target).toBeDefined()
    // 扫描本身绝不建会话。
    expect(calls).toHaveLength(0)
    const result = await service.accept(report.id, [target!.id], { selfModify: true })

    expect(result.sessionId).toBe('session-1')
    expect(result.queued).toBe(false)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.workspacePath).toBe(workspace)
    expect(calls[0]?.prompt).toContain('模块自检')
    const after = await readFile(join(workspace, 'client', 'src', 'app.ts'), 'utf8')
    expect(after).toBe(before)
    expect(service.snapshot().decisions[0]?.sessionId).toBe('session-1')
  })

  it('拒绝空选择，以及只有人工处理项的选择', async () => {
    const workspace = await makeWorkspace()
    const userData = join(root, 'userdata')
    await mkdir(userData, { recursive: true })
    const service = new ModuleCheckService({
      userDataDir: userData,
      sourceRoot: () => workspace,
      emit: () => undefined,
      startSession: async () => ({ sessionId: 's1' }),
    })
    const report = await service.run(['site'])
    await expect(service.accept(report.id, [])).rejects.toThrow('请先勾选要优化的风险点')
    const manualOnly: ModuleRisk = {
      id: 'manual:secret-like',
      moduleId: 'site',
      moduleName: 'site',
      rule: 'secret-like',
      severity: 'high',
      title: '疑似凭据',
      detail: '',
      recommendation: '',
      count: 1,
      evidence: ['site/key.js:1'],
      manual: true,
    }
    const withManual = { ...report, risks: [manualOnly] }
    const state = sanitizeModuleCheckState({ history: [withManual], lastReport: withManual })
    expect(state.history[0]?.risks[0]?.manual).toBe(true)
  })

  it('模型未配置时把清单留在队列里，仍然返回会话 id', async () => {
    const workspace = await makeWorkspace()
    const userData = join(root, 'userdata')
    await mkdir(userData, { recursive: true })
    const service = new ModuleCheckService({
      userDataDir: userData,
      sourceRoot: () => workspace,
      emit: () => undefined,
      startSession: async () => ({ sessionId: 'session-2', queued: true }),
    })
    const report = await service.run(['client'])
    const target = report.risks.find((risk) => !risk.manual)
    const result = await service.accept(report.id, [target!.id], { selfModify: true })
    expect(result.sessionId).toBe('session-2')
    expect(result.queued).toBe(true)
    expect(result.selfModify).toBe(true)
  })

  it('不勾选自改时只生成提案：不建会话、不改文件', async () => {
    const workspace = await makeWorkspace()
    const userData = join(root, 'userdata')
    await mkdir(userData, { recursive: true })
    const sessions: string[] = []
    const logs: Array<{ area: string; event: string }> = []
    const service = new ModuleCheckService({
      userDataDir: userData,
      sourceRoot: () => workspace,
      emit: () => undefined,
      log: (entry) => logs.push({ area: entry.area, event: entry.event }),
      startSession: async () => {
        sessions.push('created')
        return { sessionId: 'should-not-happen' }
      },
    })
    const before = await readFile(join(workspace, 'client', 'src', 'app.ts'), 'utf8')
    const report = await service.run(['client'])
    const target = report.risks.find((risk) => !risk.manual)!

    const result = await service.accept(report.id, [target.id])
    expect(result.selfModify).toBe(false)
    expect(result.sessionId).toBeUndefined()
    expect(result.prompt).toContain('模块自检')
    // 关键：没有开会话、文件未动，但提案与决策已经落盘。
    expect(sessions).toHaveLength(0)
    expect(await readFile(join(workspace, 'client', 'src', 'app.ts'), 'utf8')).toBe(before)
    const state = service.snapshot()
    expect(state.proposals).toHaveLength(1)
    expect(state.proposals[0]?.id).toBe(result.proposalId)
    expect(state.proposals[0]?.riskIds).toEqual([target.id])
    expect(state.decisions[0]?.selfModify).toBe(false)
    expect(logs.map((item) => item.event)).toContain('proposal.created')
  })

  it('勾选自改才建会话，并在会话结束后自动重跑自检刷新提案', async () => {
    const workspace = await makeWorkspace()
    const userData = join(root, 'userdata')
    await mkdir(userData, { recursive: true })
    let sessions = 0
    const service = new ModuleCheckService({
      userDataDir: userData,
      sourceRoot: () => workspace,
      emit: () => undefined,
      startSession: async () => {
        sessions += 1
        return { sessionId: 'self-session' }
      },
    })
    const report = await service.run(['client'])
    const target = report.risks.find((risk) => !risk.manual)!
    const accepted = await service.accept(report.id, [target.id], { selfModify: true })
    expect(accepted.selfModify).toBe(true)
    expect(accepted.sessionId).toBe('self-session')
    expect(sessions).toBe(1)
    expect(service.snapshot().decisions[0]?.selfModify).toBe(true)

    const refreshed = await service.noteRunSettled('self-session')
    expect(refreshed).not.toBeNull()
    expect(refreshed?.trigger).toBe('self-modify')
    const state = service.snapshot()
    // 新提案按时间在前，旧提案被标为已刷新。
    expect(state.proposals[0]?.refreshedAt).toBeUndefined()
    expect(state.proposals[0]?.selfModify).toBe(false)
    expect(state.proposals[0]?.id).not.toBe(accepted.proposalId)
    expect(state.proposals[1]?.id).toBe(accepted.proposalId)
    expect(state.proposals[1]?.refreshedAt).toBeTruthy()
    // 只有自改会话会触发刷新：无关会话什么也不做，也不会多建会话。
    expect(await service.noteRunSettled('other-session')).toBeNull()
    expect(sessions).toBe(1)
  })

  it('重扫失败时不上抛，只记一条告警日志', async () => {
    const userData = join(root, 'userdata')
    await mkdir(userData, { recursive: true })
    const logs: Array<{ event: string; level?: string }> = []
    const workspaceSource = await makeWorkspace()
    const service = new ModuleCheckService({
      userDataDir: userData,
      sourceRoot: () => workspaceSource,
      emit: () => undefined,
      log: (entry) => logs.push({ event: entry.event, ...(entry.level ? { level: entry.level } : {}) }),
      startSession: async () => ({ sessionId: 'self-session' }),
    })
    const report = await service.run(['client'])
    const target = report.risks.find((risk) => !risk.manual)!
    await service.accept(report.id, [target.id], { selfModify: true })
    // 源码目录在会话期间消失（例如被删/被移走），重扫会失败。
    await rm(workspaceSource, { recursive: true, force: true })
    await expect(service.noteRunSettled('self-session')).resolves.toBeNull()
    expect(logs.map((item) => item.event)).toContain('refresh.failed')
  })

  it('内置源码目录不可读时给出明确错误，而不是静默成功', async () => {
    const service = new ModuleCheckService({
      userDataDir: root,
      // 模拟安装包缺少内置源码：目录不存在。
      sourceRoot: () => join(root, 'no-such-source'),
      emit: () => undefined,
      startSession: async () => ({ sessionId: 's1' }),
    })
    await expect(service.run()).rejects.toThrow('内置源码里没有发现可自检的模块')
    await expect(service.discover()).resolves.toEqual([])
  })
})
