import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

let userDataDir = ''

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataDir,
    getLocale: () => 'zh-CN',
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error('not available in tests')
    },
    decryptString: () => {
      throw new Error('not available in tests')
    },
  },
}))

import { Store } from '../src/main/store'
import { applyModelEnv, readModelEnv, type ModelEnvTarget } from '../src/server/env'

const cleanups: string[] = []

afterEach(async () => {
  while (cleanups.length) {
    const dir = cleanups.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

function recorder(): { target: ModelEnvTarget; calls: unknown[] } {
  const calls: unknown[] = []
  return {
    calls,
    target: {
      async updateSettings(input) {
        calls.push(input)
        return {}
      },
    },
  }
}

describe('server model environment', () => {
  it('reports nothing to do when no related variable is set', () => {
    expect(readModelEnv({})).toBeNull()
    expect(readModelEnv({ PILOT_API_KEY: '   ' })).toBeNull()
  })

  it('trims whitespace and keeps only the variables that are present', () => {
    expect(readModelEnv({ PILOT_API_KEY: ' sk-test ', PILOT_MODEL: '  ' })).toEqual({
      apiKey: 'sk-test',
    })
  })

  it('writes the key without requiring an endpoint or model', async () => {
    const { target, calls } = recorder()
    const applied = await applyModelEnv(target, { PILOT_API_KEY: 'sk-live-1' })
    expect(applied).toEqual({ apiKey: 'sk-live-1' })
    expect(calls).toEqual([{ apiKey: 'sk-live-1' }])
  })

  it('leaves the store untouched when nothing is configured', async () => {
    const { target, calls } = recorder()
    expect(await applyModelEnv(target, { PATH: '/usr/bin' })).toBeNull()
    expect(calls).toEqual([])
  })

  it('forwards endpoint and model overrides for self-hosted gateways', async () => {
    const { target, calls } = recorder()
    await applyModelEnv(target, {
      PILOT_API_KEY: 'sk-x',
      PILOT_BASE_URL: 'https://gateway.example.com/v1',
      PILOT_MODEL: 'deepseek-chat',
    })
    expect(calls).toEqual([
      {
        apiKey: 'sk-x',
        baseUrl: 'https://gateway.example.com/v1',
        model: 'deepseek-chat',
      },
    ])
  })
})

describe('headless store model configuration', () => {
  it('keeps an environment key across a restart of the same data directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pilot-server-env-'))
    cleanups.push(root)
    userDataDir = root

    const first = new Store()
    await first.load()
    await applyModelEnv(first, {
      PILOT_API_KEY: 'sk-headless-test',
      PILOT_BASE_URL: 'https://gateway.example.com/v1',
      PILOT_MODEL: 'deepseek-chat',
    })
    expect(first.getApiKey()).toBe('sk-headless-test')

    const second = new Store()
    await second.load()
    expect(second.getApiKey()).toBe('sk-headless-test')
    expect(second.settings().model).toBe('deepseek-chat')
    expect(second.settings().baseUrl).toBe('https://gateway.example.com/v1')
    // The stored key must never be readable through the renderer/phone view.
    const view = JSON.stringify(second.modelSettingsView())
    expect(view).not.toContain('sk-headless-test')
  })
})
