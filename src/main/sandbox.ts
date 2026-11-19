import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { platform } from 'node:os'
import type { SandboxBackend, SandboxStatus } from '../shared/types'

export interface SandboxPlan {
  backend: Exclude<SandboxBackend, 'none'>
  file: string
  args: string[]
  cwd: string
  display: string
}

interface ProbeResult {
  ok: boolean
  stdout: string
  stderr: string
}

let cached: SandboxStatus | null = null
let detecting: Promise<SandboxStatus> | null = null

function probe(file: string, args: string[], timeoutMs = 8_000): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let child
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok, stdout: stdout.trim(), stderr: stderr.trim() })
    }
    try {
      child = spawn(file, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({
        ok: false,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
      })
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // Ignore a process that already exited.
      }
      finish(false)
    }, timeoutMs)
    timer.unref?.()
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      stderr += error.message
      finish(false)
    })
    child.on('close', (code) => finish(code === 0))
  })
}

async function detect(): Promise<SandboxStatus> {
  const off: SandboxStatus = {
    mode: 'off',
    available: false,
    backend: 'none',
    detail: '沙箱未启用。',
    networkIsolation: false,
  }
  if (platform() === 'win32') {
    const wsl = await probe('wsl.exe', ['-e', 'bash', '-lc', 'command -v bwrap >/dev/null 2>&1 && bwrap --ro-bind / / --unshare-net -- /bin/true >/dev/null 2>&1 && printf pilot-ok'])
    if (!wsl.ok || !wsl.stdout.includes('pilot-ok')) {
      return {
        ...off,
        detail:
          '未检测到可用的 WSL2 + bubblewrap。Windows 原生环境没有 Claude Code 式的 OS 沙箱；命令会以普通权限运行并逐次请求确认。',
      }
    }
    return {
      mode: 'auto',
      available: true,
      backend: 'wsl-bwrap',
      detail:
        '已检测到 WSL2 + bubblewrap：命令在 WSL 中运行，工作区可写、其余文件系统只读，可按设置关闭网络。Windows 项目依赖在该环境中可能不兼容，请先验证。',
      networkIsolation: true,
    }
  }
  if (platform() === 'linux') {
    const bwrap = await probe('bash', ['-lc', 'command -v bwrap >/dev/null 2>&1 && bwrap --ro-bind / / --unshare-net -- /bin/true >/dev/null 2>&1 && printf pilot-ok'])
    if (!bwrap.ok || !bwrap.stdout.includes('pilot-ok')) {
      return {
        ...off,
        detail: '未检测到可用的 bubblewrap；命令会以普通权限运行并逐次请求确认。',
      }
    }
    return {
      mode: 'auto',
      available: true,
      backend: 'bwrap',
      detail: '已检测到 bubblewrap：工作区可写、其余文件系统只读，可按设置关闭网络。',
      networkIsolation: true,
    }
  }
  if (platform() === 'darwin' && existsSync('/usr/bin/sandbox-exec')) {
    return {
      mode: 'auto',
      available: true,
      backend: 'seatbelt',
      detail: '已检测到 macOS Seatbelt：工作区可写、其余文件系统只读，可按设置关闭网络。',
      networkIsolation: true,
    }
  }
  return off
}

export async function sandboxStatus(): Promise<SandboxStatus> {
  if (cached) return cached
  if (!detecting) detecting = detect().then((status) => (cached = status))
  return detecting
}

export function cachedSandboxStatus(): SandboxStatus | null {
  return cached
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function bwrapArgs(workspace: string, cwd: string, command: string, network: boolean): string[] {
  return [
    '--ro-bind',
    '/',
    '/',
    '--bind',
    workspace,
    workspace,
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--tmpfs',
    '/tmp',
    ...(network ? [] : ['--unshare-net']),
    '--unshare-pid',
    '--die-with-parent',
    '--new-session',
    '--chdir',
    cwd,
    '--',
    '/bin/bash',
    '-lc',
    command,
  ]
}

export async function buildSandboxPlan(input: {
  workspacePath: string
  cwd: string
  command: string
  network: boolean
}): Promise<SandboxPlan | null> {
  const status = await sandboxStatus()
  if (!status.available) return null

  if (status.backend === 'wsl-bwrap') {
    const script = [
      'set -e',
      `ROOT="$(wslpath -a ${shellQuote(input.workspacePath)})"`,
      `CWD="$(wslpath -a ${shellQuote(input.cwd)})"`,
      'export PILOT_WORKSPACE="$ROOT"',
      `exec bwrap ${bwrapArgs('"$ROOT"', '"$CWD"', input.command, input.network)
        .map((part) => {
          if (part === '"$ROOT"' || part === '"$CWD"') return part
          return shellQuote(part)
        })
        .join(' ')}`,
    ].join('\n')
    return {
      backend: 'wsl-bwrap',
      file: 'wsl.exe',
      args: ['-e', 'bash', '-lc', script],
      cwd: input.workspacePath,
      display: 'WSL2 + bubblewrap',
    }
  }

  if (status.backend === 'bwrap') {
    return {
      backend: 'bwrap',
      file: 'bwrap',
      args: bwrapArgs(input.workspacePath, input.cwd, input.command, input.network),
      cwd: input.cwd,
      display: 'bubblewrap',
    }
  }

  if (status.backend === 'seatbelt') {
    const rules = [
      '(version 1)',
      '(allow default)',
      ...(input.network ? [] : ['(deny network*)']),
      '(deny file-write*)',
      `(allow file-write* (subpath ${JSON.stringify(input.workspacePath)}) (subpath "/tmp") (subpath "/private/tmp"))`,
    ].join('\n')
    return {
      backend: 'seatbelt',
      file: '/usr/bin/sandbox-exec',
      args: ['-p', rules, '/bin/sh', '-lc', input.command],
      cwd: input.cwd,
      display: 'macOS Seatbelt',
    }
  }

  return null
}
