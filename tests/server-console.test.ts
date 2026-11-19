import { describe, expect, it } from 'vitest'
import { CONSOLE_HELP, parseConsoleCommand } from '../src/server/console'

describe('server console commands', () => {
  it('ignores blank input and accepts surrounding whitespace', () => {
    expect(parseConsoleCommand('   ')).toEqual({ kind: 'empty' })
    expect(parseConsoleCommand('  status  ')).toEqual({ kind: 'status' })
  })

  it('maps the documented commands', () => {
    expect(parseConsoleCommand('pair')).toEqual({ kind: 'pair' })
    expect(parseConsoleCommand('workspaces')).toEqual({ kind: 'workspaces' })
    expect(parseConsoleCommand('help')).toEqual({ kind: 'help' })
    expect(parseConsoleCommand('?')).toEqual({ kind: 'help' })
    expect(parseConsoleCommand('quit')).toEqual({ kind: 'quit' })
    expect(parseConsoleCommand('EXIT')).toEqual({ kind: 'quit' })
    expect(CONSOLE_HELP).toContain('apikey')
  })

  it('keeps the exact case of a pasted API key', () => {
    expect(parseConsoleCommand('apikey sk-AbC123')).toEqual({
      kind: 'apikey-set',
      key: 'sk-AbC123',
    })
    expect(parseConsoleCommand('APIKEY  sk-XyZ  ')).toEqual({ kind: 'apikey-set', key: 'sk-XyZ' })
  })

  it('never treats a bare or explicit clear as a key value', () => {
    expect(parseConsoleCommand('apikey')).toEqual({ kind: 'apikey-show' })
    expect(parseConsoleCommand('apikey   ')).toEqual({ kind: 'apikey-show' })
    expect(parseConsoleCommand('apikey clear')).toEqual({ kind: 'apikey-clear' })
    expect(parseConsoleCommand('apikey CLEAR')).toEqual({ kind: 'apikey-clear' })
  })

  it('reports unknown commands verbatim instead of guessing', () => {
    expect(parseConsoleCommand('deploy now')).toEqual({ kind: 'unknown', input: 'deploy now' })
    // `apikeyish` is not the apikey command; \b keeps the match exact.
    expect(parseConsoleCommand('apikeyish')).toEqual({ kind: 'unknown', input: 'apikeyish' })
  })

  it('recognises the terminal update command', () => {
    expect(parseConsoleCommand('update')).toEqual({ kind: 'update' })
    expect(parseConsoleCommand('upgrade')).toEqual({ kind: 'update' })
    expect(CONSOLE_HELP).toContain('update')
  })

  it('accepts allow/deny for a phone waiting on the desktop', () => {
    expect(parseConsoleCommand('allow')).toEqual({ kind: 'pair-allow' })
    expect(parseConsoleCommand('APPROVE')).toEqual({ kind: 'pair-allow' })
    expect(parseConsoleCommand('deny')).toEqual({ kind: 'pair-deny' })
    expect(parseConsoleCommand('Reject')).toEqual({ kind: 'pair-deny' })
    expect(CONSOLE_HELP).toContain('allow')
    expect(CONSOLE_HELP).toContain('deny')
  })
})
