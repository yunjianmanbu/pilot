import { describe, expect, it } from 'vitest'
import { DEFAULT_HOST, DEFAULT_PORT, helpText, parseArgs } from '../src/server/args'

const env = {} as NodeJS.ProcessEnv

describe('headless CLI arguments', () => {
  it('defaults to the documented port and bind address', () => {
    const parsed = parseArgs(['serve'], env)
    expect(parsed.command).toBe('serve')
    expect(parsed.options.port).toBe(DEFAULT_PORT)
    expect(parsed.options.host).toBe(DEFAULT_HOST)
    
    expect(parsed.errors).toEqual([])
  })

  it('reads port, host, data dir and repeated workspaces', () => {
    const parsed = parseArgs(
      ['serve', '-p', '8080', '--host', '127.0.0.1', '-d', '/srv/pilot', '-w', '/srv/app', '--workspace', '/srv/lib'],
      env,
    )
    expect(parsed.errors).toEqual([])
    expect(parsed.options.port).toBe(8080)
    expect(parsed.options.host).toBe('127.0.0.1')
    expect(parsed.options.dataDir).toBe('/srv/pilot')
    expect(parsed.options.workspaces).toEqual(['/srv/app', '/srv/lib'])
  })

  it('lets the environment provide the port and data dir', () => {
    const parsed = parseArgs(['serve'], {
      PILOT_PORT: '7000',
      PILOT_USER_DATA_DIR: '/var/lib/pilot',
    } as NodeJS.ProcessEnv)
    expect(parsed.options.port).toBe(7000)
    expect(parsed.options.dataDir).toBe('/var/lib/pilot')
  })

  it('rejects a port outside 1-65535 instead of clamping silently', () => {
    for (const value of ['0', '70000', 'abc']) {
      const parsed = parseArgs(['serve', '--port', value], env)
      expect(parsed.errors.join()).toContain('端口')
    }
    const fromEnv = parseArgs(['serve'], { PILOT_PORT: '99999' } as NodeJS.ProcessEnv)
    expect(fromEnv.errors.join()).toContain('PILOT_PORT')
  })

  it('validates the public URL scheme and normalizes it', () => {
    const ok = parseArgs(['serve', '--public-url', 'https://pilot.example.com'], env)
    expect(ok.errors).toEqual([])
    expect(ok.options.publicUrl).toBe('https://pilot.example.com/')

    const bad = parseArgs(['serve', '--public-url', 'ftp://pilot.example.com'], env)
    expect(bad.errors.join()).toContain('--public-url')
  })

  it('validates the relay URL scheme', () => {
    const ok = parseArgs(['serve', '--relay-url', 'wss://relay.example.com/ws'], env)
    expect(ok.errors).toEqual([])
    expect(ok.options.relayUrl).toBe('wss://relay.example.com/ws')

    const bad = parseArgs(['serve', '--relay-url', 'https://relay.example.com/ws'], env)
    expect(bad.errors.join()).toContain('--relay-url')
  })

  it('reports unknown flags and missing values', () => {
    expect(parseArgs(['serve', '--nope'], env).errors.join()).toContain('未知选项')
    expect(parseArgs(['serve', '--port'], env).errors.join()).toContain('需要一个值')
  })

  it('supports --check, --help and --version without starting a server', () => {
    expect(parseArgs(['serve', '--check'], env).options.checkOnly).toBe(true)
    expect(parseArgs(['--help'], env).command).toBe('help')
    expect(parseArgs(['-v'], env).command).toBe('version')
    expect(helpText()).toContain('pilot serve')
  })

  it('accepts a scriptable update command and documents it', () => {
    expect(parseArgs(['update'], env).command).toBe('update')
    expect(parseArgs(['update'], env).errors).toEqual([])
    expect(helpText()).toContain('pilot update')
    expect(helpText()).toContain('PILOT_SERVER_UPDATE_URL')
  })
})
