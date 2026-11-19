import { describe, expect, it } from 'vitest'
import {
  parseLoginEnvironment,
  resolveShellLaunch,
  shellInterpreterStatus,
  type ShellEnvironment,
} from '../src/main/shell'

function windowsEnv(overrides: Partial<ShellEnvironment> = {}): ShellEnvironment {
  return {
    platform: 'win32',
    env: { ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
    bashPath: 'C:\\Program Files\\Git\\bin\\bash.exe',
    wslAvailable: false,
    ...overrides,
  }
}

describe('resolveShellLaunch', () => {
  it('auto prefers Git Bash and runs a non-login shell', () => {
    const launch = resolveShellLaunch('auto', 'echo $HOME && ls | head', windowsEnv())
    expect(launch).toEqual({
      file: 'C:\\Program Files\\Git\\bin\\bash.exe',
      // The login profile is captured once and merged into the child env, so
      // each command skips the ~1.8s startup-file cost.
      args: ['-c', 'echo $HOME && ls | head'],
      shell: false,
      label: 'Git Bash',
    })
  })

  it('auto falls back to WSL and then cmd.exe', () => {
    const wsl = resolveShellLaunch(
      'auto',
      'echo ok',
      windowsEnv({ bashPath: null, wslAvailable: true }),
    )
    expect(wsl.file).toBe('wsl.exe')
    expect(wsl.args).toEqual(['-e', 'bash', '-lc', 'echo ok'])
    expect(wsl.shell).toBe(false)

    const cmd = resolveShellLaunch(
      'auto',
      'echo ok > out.txt',
      windowsEnv({ bashPath: null, wslAvailable: false }),
    )
    expect(cmd.file).toBe('echo ok > out.txt')
    expect(cmd.args).toEqual([])
    expect(cmd.shell).toBe('C:\\Windows\\system32\\cmd.exe')
  })

  it('honors explicit cmd, bash and wsl selections', () => {
    const cmd = resolveShellLaunch('cmd', 'dir', windowsEnv())
    expect(cmd.file).toBe('dir')
    expect(cmd.shell).toBe('C:\\Windows\\system32\\cmd.exe')

    const bash = resolveShellLaunch('bash', 'pwd', windowsEnv())
    expect(bash.file).toBe('C:\\Program Files\\Git\\bin\\bash.exe')

    const wsl = resolveShellLaunch('wsl', 'pwd', windowsEnv({ wslAvailable: true }))
    expect(wsl.file).toBe('wsl.exe')
  })

  it('rejects an explicitly selected interpreter that is missing', () => {
    expect(() =>
      resolveShellLaunch('bash', 'pwd', windowsEnv({ bashPath: null })),
    ).toThrow(/Git Bash was not found/)
    expect(() =>
      resolveShellLaunch('wsl', 'pwd', windowsEnv({ wslAvailable: false })),
    ).toThrow(/WSL is not available/)
  })

  it('keeps the POSIX shell behavior and ignores the Windows setting', () => {
    const launch = resolveShellLaunch('wsl', 'echo ok', {
      platform: 'linux',
      env: { SHELL: '/bin/zsh' },
      bashPath: null,
      wslAvailable: false,
    })
    expect(launch.file).toBe('echo ok')
    expect(launch.args).toEqual([])
    expect(launch.shell).toBe('/bin/zsh')
    expect(launch.label).toBe('zsh')
  })
})

describe('parseLoginEnvironment', () => {
  it('parses NUL-separated env output and keeps values containing "="', () => {
    const parsed = parseLoginEnvironment(
      'PATH=/usr/bin:/c/Program Files/Git/bin\0NODE_OPTIONS=--max-old-space-size=4096\0URL=a=b\0',
    )
    expect(parsed['PATH']).toBe('/usr/bin:/c/Program Files/Git/bin')
    expect(parsed['NODE_OPTIONS']).toBe('--max-old-space-size=4096')
    expect(parsed['URL']).toBe('a=b')
  })

  it('ignores banner text printed before the first entry', () => {
    const parsed = parseLoginEnvironment('Welcome back!\nPATH=/usr/bin\0EDITOR=vim\0')
    expect(parsed).toEqual({ PATH: '/usr/bin', EDITOR: 'vim' })
  })

  it('drops per-process and Pilot variables', () => {
    const parsed = parseLoginEnvironment(
      'PWD=/old\0OLDPWD=/older\0SHLVL=3\0_=/usr/bin/env\0BASH_ENV=/tmp/hook.sh\0PILOT_API_KEY=secret\0BASH_FUNC_ls%%=() { }\0PATH=/usr/bin\0',
    )
    expect(parsed).toEqual({ PATH: '/usr/bin' })
  })

  it('drops absurdly large values', () => {
    const parsed = parseLoginEnvironment(`BLOB=${'x'.repeat(70_000)}\0PATH=/usr/bin\0`)
    expect(parsed).toEqual({ PATH: '/usr/bin' })
  })
})

describe('shellInterpreterStatus', () => {
  it('reports the detected interpreter for each mode', () => {
    expect(shellInterpreterStatus('auto', windowsEnv()).effective).toBe('bash')
    expect(
      shellInterpreterStatus('auto', windowsEnv({ bashPath: null, wslAvailable: true })).effective,
    ).toBe('wsl')
    expect(
      shellInterpreterStatus('auto', windowsEnv({ bashPath: null, wslAvailable: false })).effective,
    ).toBe('cmd')
    expect(shellInterpreterStatus('bash', windowsEnv({ bashPath: null })).effective).toBe('missing')
    expect(shellInterpreterStatus('wsl', windowsEnv({ wslAvailable: false })).effective).toBe(
      'missing',
    )
  })

  it('mentions $SHELL on non-Windows platforms', () => {
    const status = shellInterpreterStatus('auto', {
      platform: 'darwin',
      env: { SHELL: '/bin/zsh' },
      bashPath: null,
      wslAvailable: false,
    })
    expect(status.effective).toBe('posix')
    expect(status.detail).toContain('/bin/zsh')
  })
})
