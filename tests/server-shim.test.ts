import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const dirs: string[] = []

async function loadShim(dir: string): Promise<typeof import('../src/server/electron-shim')> {
  process.env['PILOT_USER_DATA_DIR'] = dir
  vi.resetModules()
  return import('../src/server/electron-shim')
}

afterEach(async () => {
  delete process.env['PILOT_USER_DATA_DIR']
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pilot-shim-'))
  dirs.push(dir)
  return dir
}

describe('headless electron shim', () => {
  it('resolves the user data directory from PILOT_USER_DATA_DIR', async () => {
    const dir = await tempDir()
    const shim = await loadShim(dir)
    expect(shim.app.getPath('userData')).toBe(dir)
    expect(shim.app.getLocale()).not.toBe('')
  })

  it('falls back to the OS locale when no POSIX variable is set', async () => {
    const dir = await tempDir()
    const saved = {
      LC_ALL: process.env['LC_ALL'],
      LC_MESSAGES: process.env['LC_MESSAGES'],
      LANG: process.env['LANG'],
    }
    delete process.env['LC_ALL']
    delete process.env['LC_MESSAGES']
    delete process.env['LANG']
    try {
      const shim = await loadShim(dir)
      // A console started by double-clicking on Windows has no LANG at all;
      // the shim must report the OS region, not a hard-coded en-US.
      const icu = new Intl.DateTimeFormat().resolvedOptions().locale
      expect(shim.app.getLocale()).toBe(icu)
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  it('prefers a POSIX locale variable over the OS locale', async () => {
    const dir = await tempDir()
    const saved = { LC_ALL: process.env['LC_ALL'] }
    process.env['LC_ALL'] = 'zh_CN.UTF-8'
    try {
      const shim = await loadShim(dir)
      expect(shim.app.getLocale()).toBe('zh-CN')
    } finally {
      if (saved.LC_ALL === undefined) delete process.env['LC_ALL']
      else process.env['LC_ALL'] = saved.LC_ALL
    }
  })

  it('seals secrets with a key file instead of the OS keychain', async () => {
    const dir = await tempDir()
    const shim = await loadShim(dir)
    expect(shim.safeStorage.isEncryptionAvailable()).toBe(true)

    const sealed = shim.safeStorage.encryptString('sk-test-secret-value')
    expect(sealed.toString('utf8')).not.toContain('sk-test-secret-value')
    expect(shim.safeStorage.decryptString(sealed)).toBe('sk-test-secret-value')

    const keyFile = await readFile(join(dir, 'secure-storage.key'), 'utf8')
    expect(Buffer.from(keyFile.trim(), 'base64')).toHaveLength(32)
  })

  it('refuses ciphertext sealed by the desktop OS keychain', async () => {
    const dir = await tempDir()
    const shim = await loadShim(dir)
    expect(() => shim.safeStorage.decryptString(Buffer.from('AAAA', 'base64'))).toThrow()
  })

  it('reports desktop-only features as unavailable instead of crashing', async () => {
    const dir = await tempDir()
    const shim = await loadShim(dir)
    expect(() => shim.nativeImage.createFromBuffer()).toThrow(/服务器模式/)
    await expect(shim.desktopCapturer.getSources()).rejects.toThrow(/服务器模式/)
  })

  it('reuses an existing key file so restarting the server keeps sessions readable', async () => {
    const dir = await tempDir()
    const first = await loadShim(dir)
    const sealed = first.safeStorage.encryptString('sk-stable')
    await writeFile(join(dir, 'unused.txt'), 'x')

    const second = await loadShim(dir)
    expect(second.safeStorage.decryptString(sealed)).toBe('sk-stable')
  })
})
