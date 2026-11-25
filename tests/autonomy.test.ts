import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  AUTONOMY_DEFAULT_TOKEN_BUDGET,
  AUTONOMY_MIN_STEPS,
  AUTONOMY_MIN_TOKEN_BUDGET,
  autonomyAuditKind,
  autonomyBlockers,
  autonomyPathDenial,
  autonomyPolicy,
  autonomyTokenBudget,
  extraWritableRoots,
  isOwnConfigPath,
  isPrivatePath,
  isPrivateShellTarget,
} from '../src/shared/autonomy'
import { autonomyAuditEntry } from '../src/main/app-audit'
import { defaults } from '../src/main/store-schema'
import { resolveToolPolicy } from '../src/main/agent/permission-policy'
import { evaluatePermission } from '../src/main/agent/permissions'
import { bwrapArgs } from '../src/main/sandbox'
import { systemAccessPolicy } from '../src/main/agent/system-access'
import { pilotTools, withAutonomyAccess } from '../src/main/agent/tools'
import { planCommand, runCommand } from '../src/main/workspace'
import { buildSystemPrompt } from '../src/main/agent/prompt'
import { runFileTool } from '../src/main/agent/tools/files'
import { runGitTool } from '../src/main/agent/tools/git'
import type { ToolHost } from '../src/main/agent/tools/spec'
import type {
  AgentToolDefinition,
  ApprovalMode,
  PermissionRules,
  ToolCall,
} from '../src/shared/types'

const tools = new Map(pilotTools.map((tool) => [tool.name, tool]))
const WORKSPACE = process.cwd()

function tool(name: string): AgentToolDefinition {
  const found = tools.get(name)
  if (!found) throw new Error(`missing tool ${name}`)
  return found
}

function rules(): PermissionRules {
  return { allow: [], ask: [], deny: [] }
}

function evaluate(
  name: string,
  args: Record<string, unknown>,
  options: {
    mode?: ApprovalMode
    fullAutonomy?: boolean
    allowUnattendedBuild?: boolean
  } = {},
) {
  const call: ToolCall = { id: 'call-1', name, arguments: args }
  return evaluatePermission({
    mode: options.mode ?? 'auto',
    tool: tool(name),
    call,
    workspacePath: WORKSPACE,
    rules: rules(),
    sandboxed: false,
    sandboxAutoAllow: true,
    ...(options.allowUnattendedBuild === undefined
      ? {}
      : { allowUnattendedBuild: options.allowUnattendedBuild }),
    ...(options.fullAutonomy === undefined ? {} : { fullAutonomy: options.fullAutonomy }),
  })
}

describe('完全自主档的准入门槛', () => {
  it('opens nothing until every budget condition is met', () => {
    expect(
      autonomyBlockers({
        fullAutonomy: true,
        approvalMode: 'auto',
        maxTokens: AUTONOMY_MIN_TOKEN_BUDGET,
        maxSteps: AUTONOMY_MIN_STEPS,
      }),
    ).toEqual([])
  })

  it('names each missing condition', () => {
    expect(autonomyBlockers({ fullAutonomy: false, approvalMode: 'auto', maxTokens: 500_000, maxSteps: 100 })).toEqual([
      'disabled',
    ])
    expect(autonomyBlockers({ fullAutonomy: true, approvalMode: 'ask', maxTokens: 500_000, maxSteps: 100 })).toEqual([
      'manual-mode',
    ])
    expect(autonomyBlockers({ fullAutonomy: true, approvalMode: 'auto', maxTokens: 50_000, maxSteps: 100 })).toEqual([
      'token-budget',
    ])
    expect(autonomyBlockers({ fullAutonomy: true, approvalMode: 'auto', maxTokens: 500_000, maxSteps: 5 })).toEqual([
      'step-cap',
    ])
    expect(
      autonomyBlockers({ fullAutonomy: true, approvalMode: 'manual', maxTokens: 1_000, maxSteps: 1 }),
    ).toEqual(['manual-mode', 'token-budget', 'step-cap'])
  })

  it('treats 0 steps as "unlimited" rather than as a missing cap', () => {
    // 设置里的 0 会被循环换成 UNLIMITED_STEPS_FALLBACK 作阀门，预算依然是可控的；
    // 把它当「没设上限」会得出「填 0 反而不允许开启完全自主」这种自相矛盾的结论。
    expect(
      autonomyBlockers({ fullAutonomy: true, approvalMode: 'auto', maxTokens: 500_000, maxSteps: 0 }),
    ).toEqual([])
    // 负数是无效输入，不能被当成「不限」。
    expect(
      autonomyBlockers({ fullAutonomy: true, approvalMode: 'auto', maxTokens: 500_000, maxSteps: -1 }),
    ).toEqual(['step-cap'])
  })

  it('turns "no cap" into a concrete budget instead of infinity', () => {
    expect(autonomyTokenBudget(0)).toBe(AUTONOMY_DEFAULT_TOKEN_BUDGET)
    expect(autonomyTokenBudget(undefined)).toBe(AUTONOMY_DEFAULT_TOKEN_BUDGET)
    expect(autonomyTokenBudget(-5)).toBe(AUTONOMY_DEFAULT_TOKEN_BUDGET)
    expect(autonomyTokenBudget(Number.NaN)).toBe(AUTONOMY_DEFAULT_TOKEN_BUDGET)
    expect(autonomyTokenBudget(350_000)).toBe(350_000)
    expect(autonomyTokenBudget(350_000.4)).toBe(350_000)
  })
})

describe('autonomyPolicy', () => {
  it('opens every functional boundary once active', () => {
    const policy = autonomyPolicy({
      fullAutonomy: true,
      approvalMode: 'auto',
      maxTokens: 400_000,
      maxSteps: 80,
    })
    expect(policy).toEqual({
      active: true,
      tokenBudget: 400_000,
      readOutsideWorkspace: true,
      writeOwnConfig: true,
      unsupervisedBuild: true,
      autoSystemAccess: true,
      network: 'allow',
    })
  })

  it('stays fully closed rather than half open', () => {
    const policy = autonomyPolicy({
      fullAutonomy: true,
      approvalMode: 'auto',
      maxTokens: 40_000,
      maxSteps: 80,
    })
    expect(policy.active).toBe(false)
    expect(policy.tokenBudget).toBe(0)
    expect(policy.readOutsideWorkspace).toBe(false)
    expect(policy.writeOwnConfig).toBe(false)
    expect(policy.network).toBe('inherit')
  })

  it('gives a capped budget even when the user asked for no cap', () => {
    const policy = autonomyPolicy({
      fullAutonomy: true,
      approvalMode: 'auto',
      maxTokens: 0,
      maxSteps: 200,
    })
    expect(policy.active).toBe(true)
    expect(policy.tokenBudget).toBe(AUTONOMY_DEFAULT_TOKEN_BUDGET)
  })
})

describe('隐私硬边界', () => {
  it('covers credentials, keys, browser sessions and password stores', () => {
    for (const candidate of [
      'C:/Users/me/.ssh/id_rsa',
      'C:/Users/me/.ssh/config',
      '/home/me/.gnupg/private-keys-v1.d/x.key',
      '/home/me/.aws/credentials',
      '/home/me/.kube/config',
      'C:/work/.env',
      'C:/work/.env.local',
      '/home/me/.npmrc',
      '/home/me/.git-credentials',
      '/home/me/.pgpass',
      'C:/Users/me/AppData/Local/Google/Chrome/User Data/Default/Login Data',
      'C:/Users/me/AppData/Local/Google/Chrome/User Data/Default/Cookies',
      '/home/me/vault.kdbx',
      '/home/me/certs/server.pem',
      '/home/me/.pilot/secrets/token.txt',
      // 自身状态文件里的 keyCipher 可逆，读到它就等于拿到用户的模型 key。
      'C:/Users/me/AppData/Roaming/Pilot/pilot-state.json',
      '/home/me/AppData/Roaming/Pilot/pilot-state.json.bak',
    ]) {
      expect(isPrivatePath(candidate), candidate).toBe(true)
      expect(autonomyPathDenial(candidate), candidate).not.toBeNull()
    }
  })

  it('leaves ordinary source and data paths alone', () => {
    for (const candidate of [
      '/home/me/project/src/main.ts',
      'C:/code/agent/manbu-agent-workspace/pilot/pilot/package.json',
      '/var/log/syslog',
      '/home/me/.pilot/skills/split/SKILL.md',
      '/tmp/cookies-recipe.md',
      // 会话数据与日志是用户要求放开的「资源与日志」，不属于凭据。
      'C:/Users/me/AppData/Roaming/Pilot/logs/app.log',
      'C:/Users/me/AppData/Roaming/Pilot/sessions/abc.messages.jsonl',
    ]) {
      expect(isPrivatePath(candidate), candidate).toBe(false)
      expect(autonomyPathDenial(candidate), candidate).toBeNull()
    }
  })

  it('only inspects path-shaped shell tokens', () => {
    expect(isPrivateShellTarget('sqlite3 /home/me/.config/google-chrome/Default/Cookies .dump')).toBe(true)
    expect(isPrivateShellTarget('cat ~/.ssh/id_ed25519')).toBe(true)
    expect(isPrivateShellTarget('grep -rn "cookies" src')).toBe(false)
    expect(isPrivateShellTarget('node scripts/collect-env.mjs')).toBe(false)
  })
})

describe('自身配置边界', () => {
  it('recognises the writable self-config roots', () => {
    for (const candidate of [
      '.pilot/skills/x/SKILL.md',
      'C:/ws/.pilot/memory/facts.json',
      'C:/ws/.pilot/tools/bulk/tool.json',
      'C:/ws/.pilot/recipes/run.json',
      'C:/ws/.pilot/hooks.json',
      'C:/ws/.mcp.json',
      'C:/ws/.pilot/learning/ledger.jsonl',
    ]) {
      expect(isOwnConfigPath(candidate), candidate).toBe(true)
    }
    expect(isOwnConfigPath('src/main/agent/runner.ts')).toBe(false)
    expect(isOwnConfigPath('C:/ws/README.md')).toBe(false)
  })
})

describe('越界留痕', () => {
  it('flags unattended builds before anything else', () => {
    expect(
      autonomyAuditKind(
        { name: 'run_shell', risk: 'exec' },
        { command: 'node pilot/scripts/self-build.mjs' },
        WORKSPACE,
      ),
    ).toBe('unattended-build')
    expect(
      autonomyAuditKind(
        { name: 'run_shell', risk: 'exec' },
        { command: 'npm run package:win' },
        WORKSPACE,
      ),
    ).toBe('unattended-build')
  })

  it('flags reads that leave the workspace', () => {
    expect(
      autonomyAuditKind({ name: 'read_file', risk: 'read' }, { path: '/etc/hosts' }, '/ws'),
    ).toBe('read-outside')
    expect(
      autonomyAuditKind({ name: 'read_file', risk: 'read' }, { path: '/ws/src/a.ts' }, '/ws'),
    ).toBeNull()
    expect(
      autonomyAuditKind(
        { name: 'run_shell', risk: 'exec' },
        { command: 'cat /etc/hosts' },
        '/ws',
      ),
    ).toBe('read-outside')
    expect(
      autonomyAuditKind(
        { name: 'run_shell', risk: 'exec' },
        { command: 'ls -la src' },
        '/ws',
      ),
    ).toBeNull()
  })

  it('flags writes into Pilot own config', () => {
    expect(
      autonomyAuditKind(
        { name: 'write_file', risk: 'write' },
        { path: '.pilot/skills/x/SKILL.md' },
        '/ws',
      ),
    ).toBe('write-own-config')
    expect(
      autonomyAuditKind(
        { name: 'write_file', risk: 'write' },
        { path: 'src/main/agent/runner.ts' },
        '/ws',
      ),
    ).toBeNull()
    // Reads of the same paths are not a write and stay unlogged.
    expect(
      autonomyAuditKind({ name: 'read_file', risk: 'read' }, { path: '.pilot/skills/x/SKILL.md' }, '/ws'),
    ).toBeNull()
  })

  it('writes an audit record without leaking content', () => {
    const entry = autonomyAuditEntry({
      kind: 'read-outside',
      tool: 'read_file',
      detail: '/etc/hosts',
      budget: 400_000,
      steps: 80,
    })
    expect(entry.area).toBe('autonomy')
    expect(entry.event).toBe('autonomy.read-outside')
    expect(entry.level).toBe('info')
    expect(entry.detail).toMatchObject({ tool: 'read_file', summary: '/etc/hosts', budget: 400_000, steps: 80 })
    expect(Object.keys(entry.detail ?? {})).not.toContain('token')
    expect(
      autonomyAuditEntry({
        kind: 'unattended-build',
        tool: 'run_shell',
        detail: 'node',
        budget: 400_000,
        steps: 80,
      }).level,
    ).toBe('warn')
  })
})

describe('沙箱可写根', () => {
  it('adds only roots outside the workspace', () => {
    expect(extraWritableRoots('/ws', '/opt/pilot-src')).toEqual(['/opt/pilot-src'])
    expect(extraWritableRoots('/ws', '/ws/src')).toEqual([])
    expect(extraWritableRoots('/ws', '/ws')).toEqual([])
    expect(extraWritableRoots('/ws', undefined)).toEqual([])
    expect(extraWritableRoots('/ws', '   ')).toEqual([])
    expect(extraWritableRoots('C:\\ws', 'C:\\ws\\src')).toEqual([])
  })

  it('binds the extra roots writable in bwrap', () => {
    const plain = bwrapArgs('/ws', '/ws', 'ls', false)
    expect(plain.join(' ')).not.toContain('/opt/pilot-src')
    expect(plain).toContain('--unshare-net')

    const extra = bwrapArgs('/ws', '/ws', 'ls', true, ['/opt/pilot-src'])
    const text = extra.join(' ')
    expect(text).toContain('--bind /opt/pilot-src /opt/pilot-src')
    // 工作区那一条绑定仍然在，额外根不替代它。
    expect(text).toContain('--bind /ws /ws')
    // 完全自主档要求能联网，因此不再 unshare 网络命名空间。
    expect(extra).not.toContain('--unshare-net')
  })
})

describe('权限层的放开与保留', () => {
  it('refuses privacy paths even in the fully autonomous tier', () => {
    const ssh = evaluate('read_file', { path: 'C:/Users/me/.ssh/id_rsa' }, { fullAutonomy: true })
    expect(ssh.action).toBe('deny')
    expect(ssh.source).toBe('protected')
    expect(ssh.reason).toContain('隐私')

    const cookies = evaluate(
      'run_shell',
      { command: 'sqlite3 /home/me/.config/google-chrome/Default/Cookies .dump' },
      { fullAutonomy: true },
    )
    expect(cookies.action).toBe('deny')
    expect(cookies.source).toBe('protected')
  })

  it('lets the tier write Pilot own config but never .git or shell startup files', () => {
    const skill = evaluate('write_file', { path: '.pilot/skills/x/SKILL.md', content: 'x' }, { fullAutonomy: true })
    expect(skill.action).toBe('allow')
    // 未开档时同一个写入仍被当作受保护配置拒绝。
    expect(evaluate('write_file', { path: '.pilot/skills/x/SKILL.md', content: 'x' }).action).toBe('deny')

    const git = evaluate('write_file', { path: '.git/config', content: 'x' }, { fullAutonomy: true })
    expect(git.action).toBe('deny')
    expect(git.source).toBe('protected')

    const rc = evaluate('run_shell', { command: 'echo x >> ~/.bashrc' }, { fullAutonomy: true })
    expect(rc.action).toBe('deny')
  })

  it('runs unattended personal builds without the extra setting', () => {
    const build = evaluate('run_shell', { command: 'npm run package:win' }, { fullAutonomy: true })
    expect(build.action).toBe('allow')
    expect(build.reason).toContain('完全自主档')

    // 未开档且没打开「允许无人值守的个人构建」时仍要人确认。
    const manual = evaluate('run_shell', { command: 'npm run package:win' })
    expect(manual.action).toBe('ask')
  })

  it('reads outside the workspace in auto mode', () => {
    const outside = evaluate('read_file', { path: 'C:/code/other-project/notes.md' }, { fullAutonomy: true })
    expect(outside.action).toBe('allow')
  })
})

describe('策略层（runner 真正调用的入口）', () => {
  function policyInput(
    name: string,
    args: Record<string, unknown>,
    overrides: { fullAutonomy?: boolean; maxTokens?: number; maxSteps?: number; mode?: ApprovalMode } = {},
  ) {
    const settings = defaults().settings
    return {
      tool: tool(name),
      call: { id: 'call-1', name, arguments: args } as ToolCall,
      review: null,
      approvalMode: () => overrides.mode ?? (settings.defaultApprovalMode as ApprovalMode),
      workspacePath: WORKSPACE,
      settings: {
        ...settings,
        // 测试不碰凭证、模型与外部服务，只关心准入与放开点。
        defaultApprovalMode: 'auto' as ApprovalMode,
        fullAutonomy: overrides.fullAutonomy === true,
        maxSteps: overrides.maxSteps ?? settings.maxSteps,
        maxTokens: overrides.maxTokens ?? settings.maxTokens,
      },
      sandboxEnabled: false,
      learningEnabled: false,
      classify: async () => ({ decision: 'allow' as const, reason: 'test', failed: false }),
      classifierModel: 'test-model',
      prompt: 'test',
      transcript: () => [],
      signal: new AbortController().signal,
      onClassifierAllow: () => undefined,
      onClassifierBlock: () => ({ consecutive: 0, total: 0, pause: false }),
      onPauseAllAuto: async () => undefined,
    }
  }

  it('hands introspection to the tool without a human once the tier is active', async () => {
    const request = {
      scopes: ['execution_records'],
      purpose: 'inspect my own runs',
      workspaces: 'current',
    }
    const off = await resolveToolPolicy(policyInput('request_system_access', request))
    expect(off.decision).not.toBe('auto')

    const active = await resolveToolPolicy(
      policyInput('request_system_access', request, { fullAutonomy: true }),
    )
    expect(active.decision).toBe('auto')
    expect(active.reason).toContain('完全自主档')
  })

  it('keeps privacy paths denied through the same entry point', async () => {
    const verdict = await resolveToolPolicy(
      policyInput(
        'write_file',
        { path: 'C:/Users/me/.ssh/id_ed25519', content: 'x' },
        { fullAutonomy: true },
      ),
    )
    expect(verdict.decision).toBe('deny')
  })

  it('does not activate when the session is not fully automatic', async () => {
    // 设置里开着完全自主，但本次会话不是全部自动：构建这最后一道人工确认仍在。
    const build = { command: 'npm run package:win' }
    const manual = await resolveToolPolicy(
      policyInput('run_shell', build, { fullAutonomy: true, mode: 'manual' }),
    )
    expect(manual.decision).toBe('ask')

    const auto = await resolveToolPolicy(policyInput('run_shell', build, { fullAutonomy: true }))
    expect(auto.decision).toBe('auto')
  })
})

describe('系统信息授权', () => {
  it('auto-approves introspection only inside the tier', () => {
    const request = {
      scopes: ['execution_records'],
      purpose: 'inspect my own runs',
      workspaces: 'current',
    }
    expect(systemAccessPolicy('auto', undefined, request)?.decision).toBe('ask')
    const auto = systemAccessPolicy('auto', undefined, request, true)
    expect(auto?.decision).toBe('auto')
    expect(auto?.reason).toContain('完全自主档')
    // 计划模式连完全自主档也不能拿到系统信息。
    expect(systemAccessPolicy('plan', undefined, request, true)?.decision).toBe('deny')
  })
})

describe('文件工具的工作区外边界', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-autonomy-'))
  const workspace = path.join(base, 'ws')
  const source = path.join(base, 'self-src')
  const elsewhere = path.join(base, 'elsewhere')
  for (const dir of [workspace, source, elsewhere]) fs.mkdirSync(dir, { recursive: true })
  const outside = path.join(elsewhere, 'notes.md')
  fs.writeFileSync(outside, 'outside content\n')
  fs.writeFileSync(path.join(workspace, 'inner.txt'), 'inner\n')

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true })
  })

  function host(overrides: Partial<ToolHost> = {}): ToolHost {
    return {
      root: workspace,
      remember: async () => ({ id: 'memory-1' }),
      updatePlan: () => undefined,
      proposeSelfUpdate: async () => ({ version: 1 }),
      ...overrides,
    }
  }

  it('reads an absolute path outside the workspace when the tier is active', async () => {
    const result = await runFileTool(
      'read_file',
      { path: outside },
      host({ fullAutonomy: true }),
      new AbortController().signal,
    )
    expect(result?.ok).toBe(true)
    expect(result?.output).toContain('outside content')
  })

  it('refuses that same absolute path without the tier', async () => {
    await expect(
      runFileTool('read_file', { path: outside }, host(), new AbortController().signal),
    ).rejects.toThrow()
  })

  it('writes the workspace and Pilot own source, nothing else', async () => {
    const inWorkspace = path.join(workspace, 'created.txt')
    const ok = await runFileTool(
      'write_file',
      { path: inWorkspace, content: 'hello' },
      host({ fullAutonomy: true }),
      new AbortController().signal,
    )
    expect(ok?.ok).toBe(true)
    expect(fs.readFileSync(inWorkspace, 'utf8')).toBe('hello')

    const inSource = path.join(source, 'patched.ts')
    const patched = await runFileTool(
      'write_file',
      { path: inSource, content: 'export const x = 1\n' },
      host({ fullAutonomy: true, selfSourceRoot: source }),
      new AbortController().signal,
    )
    expect(patched?.ok).toBe(true)
    expect(fs.readFileSync(inSource, 'utf8')).toContain('export const x')

    await expect(
      runFileTool(
        'write_file',
        { path: path.join(elsewhere, 'escape.txt'), content: 'nope' },
        host({ fullAutonomy: true, selfSourceRoot: source }),
        new AbortController().signal,
      ),
    ).rejects.toThrow(/只允许写入工作区或 Pilot 自身源码目录/)
    expect(fs.existsSync(path.join(elsewhere, 'escape.txt'))).toBe(false)
  })
})

describe('命令与长驻进程的执行范围', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-cmd-scope-'))
  const workspace = path.join(base, 'ws')
  const outside = path.join(base, 'outside')
  const secret = path.join(base, '.ssh')
  for (const dir of [workspace, outside, secret]) fs.mkdirSync(dir, { recursive: true })

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true })
  })

  it('jails cwd and the executable inside the workspace by default', async () => {
    await expect(planCommand(workspace, { command: 'node', cwd: outside })).rejects.toThrow()
    await expect(
      planCommand(workspace, { command: path.join(outside, 'tool.exe') }),
    ).rejects.toThrow()
  })

  it('runs in any directory once the tier is active', async () => {
    const plan = await planCommand(workspace, { command: 'node', cwd: outside }, { fullAutonomy: true })
    expect(plan.cwd).toBe(fs.realpathSync(outside))
    // 工作区仍作为 PILOT_WORKSPACE 传给子进程，相对路径不会被静默改写。
    expect(plan.base).toBe(fs.realpathSync(workspace))
  })

  it('still refuses a private directory as cwd in the tier', async () => {
    await expect(
      planCommand(workspace, { command: 'node', cwd: secret }, { fullAutonomy: true }),
    ).rejects.toThrow(/隐私路径/)
  })

  it('refuses an executable under a private directory in the tier', async () => {
    const evil = path.join(secret, 'run.exe')
    fs.writeFileSync(evil, '')
    await expect(
      planCommand(workspace, { command: evil }, { fullAutonomy: true }),
    ).rejects.toThrow(/隐私路径/)
  })

  // plan 只证明校验通过；这一条真正 spawn 一次，证明跨目录 cwd 与工作区外
  // 的可执行文件在实机上是能跑的，而不是规划层与执行层各说各话。
  it('actually spawns the command in an outside cwd', async () => {
    const result = await runCommand(
      workspace,
      { command: process.execPath, args: ['-e', 'process.stdout.write(process.cwd())'], cwd: outside },
      new AbortController().signal,
      { fullAutonomy: true },
    )
    expect(result.ok).toBe(true)
    expect(fs.realpathSync(result.output.trim())).toBe(fs.realpathSync(outside))
  })
})

describe('git 工具的作用范围', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-git-scope-'))
  const workspace = path.join(base, 'ws')
  const repo = path.join(base, 'other-repo')
  const privateRepo = path.join(base, '.ssh')
  for (const dir of [workspace, repo, privateRepo]) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(repo, 'notes.txt'), 'uncommitted\n')
  const gitAvailable =
    spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true })
  })

  function host(overrides: Partial<ToolHost> = {}): ToolHost {
    return {
      root: workspace,
      remember: async () => ({ id: 'memory-1' }),
      updatePlan: () => undefined,
      proposeSelfUpdate: async () => ({ version: 1 }),
      ...overrides,
    }
  }

  it('refuses an absolute repository outside the tier', async () => {
    await expect(
      runGitTool('git_status', { repo }, host(), new AbortController().signal),
    ).rejects.toThrow(/只能作用于工作区/)
  })

  it('still refuses a private directory as a repository', async () => {
    await expect(
      runGitTool(
        'git_status',
        { repo: privateRepo },
        host({ fullAutonomy: true }),
        new AbortController().signal,
      ),
    ).rejects.toThrow(/隐私路径/)
  })

  // 真的跑一次 git：证明「完全自主档下的跨仓库只读」不只是参数校验，
  // 而是 cwd 真能落在工作区外、命令真的执行了。
  it.skipIf(!gitAvailable)('reads another repository once the tier is active', async () => {
    const init = spawnSync('git', ['init', '--quiet'], { cwd: repo, encoding: 'utf8' })
    expect(init.status).toBe(0)
    const result = await runGitTool(
      'git_status',
      { repo },
      host({ fullAutonomy: true }),
      new AbortController().signal,
    )
    expect(result?.ok).toBe(true)
    expect(result?.output).toContain('?? notes.txt')

    const diff = await runGitTool(
      'git_diff',
      { repo, stat: true },
      host({ fullAutonomy: true }),
      new AbortController().signal,
    )
    // 未跟踪文件不出现在 diff 里：这里只要求命令跑通、没被路径校验拦下。
    expect(diff?.ok).toBe(true)
  })
})

describe('完全自主档的工具描述', () => {
  it('advertises absolute read paths only inside the tier', () => {
    const open = withAutonomyAccess(pilotTools, true)
    const read = open.find((entry) => entry.name === 'read_file')
    expect(read?.description).toContain('FULL-AUTONOMY MODE: path may also be an absolute path')

    const closed = withAutonomyAccess(pilotTools, false).find((entry) => entry.name === 'read_file')
    expect(closed?.description).not.toContain('FULL-AUTONOMY MODE')

    // 写边界没变，所以写入工具的描述不能跟着放开。
    const write = open.find((entry) => entry.name === 'write_file')
    expect(write?.description).not.toContain('FULL-AUTONOMY MODE')
  })
})

describe('提示词如实反映放开范围', () => {
  function prompt(fullAutonomy: boolean): string {
    return buildSystemPrompt({
      root: WORKSPACE,
      topLevel: '继续',
      memory: [],
      profile: null,
      plan: null,
      selfUpdate: false,
      approvalMode: 'auto',
      shellMode: true,
      fullAutonomy,
    })
  }

  it('tells the model the execution range and the two remaining hard limits', () => {
    const text = prompt(true)
    expect(text).toContain('FULL-AUTONOMY MODE')
    expect(text).toContain('cwd outside the workspace')
    expect(text).toContain('git_status / git_diff / git_log take repo=<absolute path>')
    expect(text).toContain('Writes are still limited to the workspace')
    expect(text).toContain('hard deny')
    expect(text).not.toContain('Keep respecting the workspace path jail')
  })

  it('keeps the ordinary full-auto wording without the tier', () => {
    const text = prompt(false)
    expect(text).not.toContain('FULL-AUTONOMY MODE')
    expect(text).toContain('Keep respecting the workspace path jail')
  })
})
