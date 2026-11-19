import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  cachedSourceFingerprint,
  configureFingerprintCache,
  resetFingerprintMemo,
  sourceFingerprint,
} from '../src/main/personal'

const temporary: string[] = []

afterEach(async () => {
  configureFingerprintCache(null)
  resetFingerprintMemo()
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function temporaryDir(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  temporary.push(path)
  return path
}

async function write(root: string, path: string, content: string): Promise<void> {
  const target = join(root, ...path.split('/'))
  await mkdir(join(target, '..'), { recursive: true })
  await writeFile(target, content)
}

describe('cached source fingerprint', () => {
  it('returns the same hash a plain fingerprint would, and reuses it while the tree is untouched', async () => {
    const root = await temporaryDir('pilot-fingerprint-')
    await write(root, 'src/a.ts', 'export const a = 1\n')
    await write(root, 'src/b.ts', 'export const b = 2\n')

    const plain = await sourceFingerprint(root)
    expect(await cachedSourceFingerprint(root)).toBe(plain)

    // Second call hits the memo: it must still report the same hash.
    expect(await cachedSourceFingerprint(root)).toBe(plain)
  })

  it('recomputes when a file changes', async () => {
    const root = await temporaryDir('pilot-fingerprint-')
    await write(root, 'src/a.ts', 'export const a = 1\n')
    const before = await cachedSourceFingerprint(root)

    await write(root, 'src/a.ts', 'export const a = 1000\n')
    const after = await cachedSourceFingerprint(root)

    expect(after).not.toBe(before)
    expect(after).toBe(await sourceFingerprint(root))
  })

  it('trusts the memo inside the window only when a trust window is asked for', async () => {
    const root = await temporaryDir('pilot-fingerprint-')
    await write(root, 'src/a.ts', 'first\n')
    const before = await cachedSourceFingerprint(root, 30_000)

    await write(root, 'src/a.ts', 'second\n')

    // App-managed trees may reuse the confirmed value for a short window...
    expect(await cachedSourceFingerprint(root, 30_000)).toBe(before)
    // ...but a user-writable tree is always re-checked.
    expect(await cachedSourceFingerprint(root)).not.toBe(before)
  })

  it('survives a process restart through the cache file', async () => {
    const root = await temporaryDir('pilot-fingerprint-')
    const cache = join(await temporaryDir('pilot-fingerprint-cache-'), 'fingerprints.json')
    await write(root, 'src/a.ts', 'export const a = 1\n')
    configureFingerprintCache(cache)

    const first = await cachedSourceFingerprint(root)
    expect(JSON.parse(await readFile(cache, 'utf8'))[root].hash).toBe(first)

    // A new process starts with an empty in-memory memo and reads the file.
    resetFingerprintMemo()
    configureFingerprintCache(cache)
    expect(await cachedSourceFingerprint(root)).toBe(first)
  })

  it('ignores a stale cache file when the tree moved on', async () => {
    const root = await temporaryDir('pilot-fingerprint-')
    const cache = join(await temporaryDir('pilot-fingerprint-cache-'), 'fingerprints.json')
    await write(root, 'src/a.ts', 'first\n')
    configureFingerprintCache(cache)
    await cachedSourceFingerprint(root)

    await write(root, 'src/a.ts', 'second\n')
    resetFingerprintMemo()
    configureFingerprintCache(cache)

    expect(await cachedSourceFingerprint(root)).toBe(await sourceFingerprint(root))
  })

  it('uses the persisted hash only while the tree signature still matches', async () => {
    const root = await temporaryDir('pilot-fingerprint-')
    const cache = join(await temporaryDir('pilot-fingerprint-cache-'), 'fingerprints.json')
    await write(root, 'src/a.ts', 'first\n')
    configureFingerprintCache(cache)
    const managed = await cachedSourceFingerprint(root, 30_000)
    expect(managed).toBe(await sourceFingerprint(root))

    // A new process reuses the persisted hash, so it does not re-read the files.
    resetFingerprintMemo()
    configureFingerprintCache(cache)
    expect(await cachedSourceFingerprint(root, 30_000)).toBe(managed)

    // An outside edit (installer upgrade, manual change) wins over the cache.
    await write(root, 'src/a.ts', 'second\n')
    resetFingerprintMemo()
    configureFingerprintCache(cache)
    expect(await cachedSourceFingerprint(root, 30_000)).not.toBe(managed)
  })
})
