#!/usr/bin/env node
// electron-builder treats package.json as an app file, so it cannot also be
// listed directly in extraResources: the asar would lose it. Write a copy
// under build/ and ship that as source/package.json instead.
//
// The same pass records where this checkout came from (remote URL + the
// subdirectory that holds this client), so an installed build can pin its
// evolution baseline to the commit it was built from instead of guessing.
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const clientDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = await readFile(join(clientDir, 'package.json'), 'utf8')
const target = join(clientDir, 'build', 'self-source-package.json')
await mkdir(dirname(target), { recursive: true })
await writeFile(target, source)
console.log(`✓ 已生成 ${target}`)

function git(args, cwd) {
  const result = execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  return result.trim()
}

/** Empty when the build happens outside a checkout: the user fills it in later. */
function provenance() {
  try {
    const top = git(['rev-parse', '--show-toplevel'], clientDir)
    const gitPath = relative(top, clientDir).split(sep).join('/')
    let gitUrl = ''
    try {
      gitUrl = git(['remote', 'get-url', 'origin'], top)
    } catch {
      gitUrl = ''
    }
    let gitRef = 'main'
    try {
      gitRef = git(['rev-parse', '--abbrev-ref', 'HEAD'], top) || 'main'
    } catch {
      gitRef = 'main'
    }
    return { gitUrl, gitRef, gitPath }
  } catch {
    return { gitUrl: '', gitRef: 'main', gitPath: '' }
  }
}

const info = provenance()
const gitTarget = join(clientDir, 'build', 'self-source-git.json')
await writeFile(gitTarget, `${JSON.stringify(info, null, 2)}\n`)
console.log(
  info.gitUrl
    ? `✓ 官方源码来源：${info.gitUrl}${info.gitPath ? ` (${info.gitPath})` : ''} @ ${info.gitRef}`
    : '· 当前目录不在 git 仓库里，安装版需要用户自行填写官方 git 地址',
)
