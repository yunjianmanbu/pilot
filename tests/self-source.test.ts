import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareSelfSource, selfSourceRoot } from '../src/main/self-source'

const temporary: string[] = []

async function workspace(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  temporary.push(path)
  return path
}

async function fakeSource(root: string, marker: string): Promise<void> {
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'pilot-agent' }))
  await writeFile(join(root, 'src', 'main.ts'), marker)
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('self source paths', () => {
  it('uses the live repository in development and resources/source when packaged', () => {
    expect(
      selfSourceRoot({ packaged: false, appPath: 'C:\\repo\\client', resourcesPath: 'ignored' }),
    ).toBe('C:\\repo\\client')
    expect(
      selfSourceRoot({
        packaged: true,
        appPath: 'C:\\app\\resources\\app.asar',
        resourcesPath: 'C:\\app\\resources',
      }),
    ).toBe(join('C:\\app\\resources', 'source'))
  })
})

describe('prepareSelfSource', () => {
  it('returns the live repository without copying in development', async () => {
    const root = await workspace('pilot-self-dev-')
    await fakeSource(root, 'dev')
    const result = await prepareSelfSource({
      packaged: false,
      appPath: root,
      resourcesPath: join(root, 'resources'),
      userDataPath: join(root, 'userData'),
    })
    expect(result).toEqual({ path: root, copied: false, packaged: false })
  })

  it('copies the embedded source into userData on first use and reuses it afterwards', async () => {
    const root = await workspace('pilot-self-packaged-')
    const source = join(root, 'resources', 'source')
    const userData = join(root, 'userData')
    await fakeSource(source, 'packaged')

    const first = await prepareSelfSource({
      packaged: true,
      appPath: join(root, 'app.asar'),
      resourcesPath: join(root, 'resources'),
      userDataPath: userData,
    })
    expect(first).toEqual({
      path: join(userData, 'self-src'),
      copied: true,
      packaged: true,
    })
    expect(await readFile(join(userData, 'self-src', 'src', 'main.ts'), 'utf8')).toBe('packaged')

    const second = await prepareSelfSource({
      packaged: true,
      appPath: join(root, 'app.asar'),
      resourcesPath: join(root, 'resources'),
      userDataPath: userData,
    })
    expect(second.copied).toBe(false)
    expect(second.path).toBe(first.path)
  })

  it('explains when the installer does not contain source', async () => {
    const root = await workspace('pilot-self-missing-')
    await expect(
      prepareSelfSource({
        packaged: true,
        appPath: join(root, 'app.asar'),
        resourcesPath: join(root, 'resources'),
        userDataPath: join(root, 'userData'),
      }),
    ).rejects.toThrow('当前安装包没有内置源码')
  })
})
