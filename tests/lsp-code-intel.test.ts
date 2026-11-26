/**
 * 多语言 code_intel 的全链路测试。
 *
 * 覆盖三层，全部跑真实子进程（不是 mock）：
 * 1. LspClient 自己：Content-Length 分帧（含跨 chunk 与 >64KB 单帧）、握手、
 *    MethodNotFound、请求超时、server 崩溃、dispose。
 * 2. 发现与启动：项目 node_modules/.bin 优先于 PATH，Windows 的 .cmd shim 交给
 *    cmd.exe，SKIP_DIRS 真的被跳过。
 * 3. runCodeIntel 的四个 action：假 python server 走 LSP、pull 诊断不可用时回退到
 *    push、server 起不来时降到结构化搜索、TS 文件仍走进程内引擎。
 *
 * 假 server 见 tests/fixtures/fake-lsp-server.mjs；它只实现 code_intel 用到的
 * LSP 子集，真实 server（pyright/gopls/jdtls）的行为不在覆盖范围内。
 */
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { disposeAllCodeIntel, runCodeIntel } from '../src/main/agent/code-intel'
import { LspClient, isMethodNotFound } from '../src/main/agent/lsp/client'
import { runHeuristicCodeIntel } from '../src/main/agent/lsp/fallback'
import { lspStatus } from '../src/main/agent/lsp/intel'
import {
  extensionOf,
  findServer,
  isTypeScriptFile,
  languageById,
  languageForFile,
  launchFor,
  resetServerDiscovery,
  scanSources,
  type LanguageSpec,
} from '../src/main/agent/lsp/servers'
import { runCodeIntelTool, codeIntelTools } from '../src/main/agent/tools/code-intel'
import type { ToolHost } from '../src/main/agent/tools/spec'

const SERVER = join(process.cwd(), 'tests', 'fixtures', 'fake-lsp-server.mjs')
const PY_SERVER = 'pyright-langserver'

const cleanups: string[] = []

afterEach(async () => {
  await disposeAllCodeIntel()
  resetServerDiscovery()
  while (cleanups.length) {
    const dir = cleanups.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

async function tempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(root)
  return root
}

/**
 * 在临时工作区的 node_modules/.bin 里放一个假 server 的启动器。
 *
 * Windows 上必须写成 .cmd：npm 安装的 launcher 就是这种 shim，而 Node 从
 * CVE-2024-27980 修复后拒绝直接 spawn .cmd，所以这条路径同时验证了
 * servers.ts 的 launchFor 把 shim 交给 cmd.exe。
 */
async function writeShim(root: string, name: string, mode: string): Promise<void> {
  const bin = join(root, 'node_modules', '.bin')
  await mkdir(bin, { recursive: true })
  if (process.platform === 'win32') {
    await writeFile(
      join(bin, `${name}.cmd`),
      `@echo off\r\n"${process.execPath}" "${SERVER}" --stdio --mode=${mode}\r\n`,
      'utf8',
    )
    return
  }
  const script = join(bin, name)
  await writeFile(
    script,
    `#!/bin/sh\nexec "${process.execPath}" "${SERVER}" --stdio --mode=${mode}\n`,
    'utf8',
  )
  await chmod(script, 0o755)
}

/**
 * 两个互相引用的 Python 文件。行号是断言的一部分：
 *   app/main.py:4  -> `    return helpers.greet("x")`   greet 在 1-based 第 20 列
 *   app/helpers.py:1 -> `def greet(name):`               greet 在第 5 列
 */
async function pythonProject(): Promise<string> {
  const root = await tempDir('pilot-lsp-')
  await mkdir(join(root, 'app'), { recursive: true })
  await writeFile(
    join(root, 'app', 'main.py'),
    [
      'import helpers',
      '',
      'def main():',
      '    return helpers.greet("x")',
      '',
      '',
      'class Service:',
      '    def run(self):',
      '        return main()',
      '',
    ].join('\n'),
    'utf8',
  )
  await writeFile(
    join(root, 'app', 'helpers.py'),
    ['def greet(name):', '    return f"hi {name}"', ''].join('\n'),
    'utf8',
  )
  return root
}

function host(root: string): ToolHost {
  // rootFor() 只读 host.roots / host.rootKey，其余字段 code_intel 用不到。
  return { root, roots: [] } as unknown as ToolHost
}

/** 进程退出是异步事件，断言前要等到状态真的翻转。 */
async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 40))
  }
  throw new Error(`condition not met within ${timeoutMs}ms`)
}

/** 直接连接假 server（不经发现逻辑），用来测客户端本身。 */
async function withClient<T>(mode: string, run: (client: LspClient) => Promise<T>): Promise<T> {
  const cwd = await tempDir('pilot-lspc-')
  const client = new LspClient(
    { file: process.execPath, args: [SERVER, '--stdio', `--mode=${mode}`] },
    { cwd, requestTimeoutMs: 3_000, initTimeoutMs: 8_000 },
  )
  try {
    return await run(client)
  } finally {
    await client.dispose()
  }
}

describe('LspClient', () => {
  it('completes the initialize handshake and answers a request', async () => {
    const cwd = await tempDir('pilot-lsp-root-')
    await withClient('full', async (client) => {
      await client.initialize(pathToFileURL(cwd).toString(), 'root')
      const symbols = await client.request<Array<{ name: string; kind: number }>>(
        'workspace/symbol',
        { query: 'greet' },
      )
      expect(symbols).toHaveLength(1)
      expect(symbols[0]?.name).toBe('greet')
      expect(symbols[0]?.kind).toBe(12)
    })
  })

  it('reassembles a frame that arrives in two chunks', async () => {
    const cwd = await tempDir('pilot-lsp-root-')
    await withClient('split', async (client) => {
      await client.initialize(pathToFileURL(cwd).toString(), 'root')
      const refs = await client.request<unknown[]>('textDocument/references', {
        textDocument: { uri: pathToFileURL(join(cwd, 'app', 'main.py')).toString() },
        position: { line: 3, character: 19 },
        context: { includeDeclaration: true },
      })
      expect(refs).toHaveLength(2)
    })
  })

  it('reassembles a single frame larger than 64KB', async () => {
    const cwd = await tempDir('pilot-lsp-root-')
    await withClient('big', async (client) => {
      await client.initialize(pathToFileURL(cwd).toString(), 'root')
      const symbols = await client.request<Array<{ name: string }>>('workspace/symbol', {
        query: 'sym',
      })
      expect(symbols).toHaveLength(200)
      // 单帧远超 64KB，说明多次 data 事件之间没有丢字节。
      expect(JSON.stringify(symbols).length).toBeGreaterThan(65_536)
    })
  })

  it('surfaces MethodNotFound as a typed error', async () => {
    const cwd = await tempDir('pilot-lsp-root-')
    await withClient('full', async (client) => {
      await client.initialize(pathToFileURL(cwd).toString(), 'root')
      const error = await client
        .request('textDocument/hover', { textDocument: { uri: 'file:///x.py' }, position: { line: 0, character: 0 } })
        .then(() => null)
        .catch((caught: unknown) => caught)
      expect(error).not.toBeNull()
      expect(isMethodNotFound(error)).toBe(true)
    })
  })

  it('times out a request the server never answers', async () => {
    const cwd = await tempDir('pilot-lsp-root-')
    await withClient('slow', async (client) => {
      await client.initialize(pathToFileURL(cwd).toString(), 'root')
      const error = await client
        .request('textDocument/definition', { textDocument: { uri: 'file:///x.py' }, position: { line: 0, character: 0 } }, 250)
        .then(() => null)
        .catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain('did not answer')
      expect((error as Error).message).toContain('250ms')
    })
  })

  it('rejects a pending request when the server crashes, with its stderr', async () => {
    const cwd = await tempDir('pilot-lsp-root-')
    await withClient('crash', async (client) => {
      const error = await client
        .initialize(pathToFileURL(cwd).toString(), 'root')
        .then(() => null)
        .catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain('refused to start')
    })
  })

  it('refuses requests after dispose', async () => {
    const cwd = await tempDir('pilot-lsp-root-')
    const client = new LspClient(
      { file: process.execPath, args: [SERVER, '--stdio', '--mode=full'] },
      { cwd, requestTimeoutMs: 2_000 },
    )
    await client.initialize(pathToFileURL(cwd).toString(), 'root')
    await client.dispose()
    await expect(client.request('workspace/symbol', { query: 'x' })).rejects.toThrow(/disposed/)
  })
})

describe('language registry and server discovery', () => {
  it('maps extensions to languages and keeps TS/JS on the in-process engine', () => {
    expect(extensionOf('a/b/C.PY')).toBe('py')
    expect(extensionOf('Makefile')).toBe('')
    expect(languageForFile('x.py')?.id).toBe('python')
    expect(languageForFile('x.go')?.id).toBe('go')
    expect(languageForFile('x.java')?.id).toBe('java')
    expect(languageForFile('x.rs')?.id).toBe('rust')
    expect(languageForFile('x.cpp')?.id).toBe('cpp')
    expect(languageForFile('x.cs')?.id).toBe('csharp')
    expect(languageForFile('x.txt')).toBeNull()
    expect(isTypeScriptFile('a.tsx')).toBe(true)
    expect(isTypeScriptFile('a.py')).toBe(false)
  })

  it('prefers a project-local launcher over PATH', async () => {
    const root = await pythonProject()
    await writeShim(root, PY_SERVER, 'full')
    const server = findServer(root, languageById('python') as LanguageSpec)
    expect(server).not.toBeNull()
    expect(server?.command).toContain('node_modules')
    expect(server?.language).toBe('python')
  })

  it('returns null when no candidate is installed', async () => {
    const root = await pythonProject()
    const spec: LanguageSpec = {
      id: 'python',
      label: 'Python',
      extensions: ['py'],
      servers: [{ command: 'pilot-not-a-real-server-xyz', args: [], install: 'none' }],
    }
    expect(findServer(root, spec)).toBeNull()
  })

  it('routes Windows .cmd launchers through cmd.exe, verbatim', () => {
    if (process.platform === 'win32') {
      const launch = launchFor('C:\\tools\\pyright-langserver.cmd', ['--stdio'])
      expect(launch.file.toLowerCase()).toContain('cmd.exe')
      expect(launch.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
      expect(launch.args[3]).toContain('--stdio')
      expect(launch.args[3]).toContain('pyright-langserver')
      // 没这个标记，Node 会再按 MSVCRT 规则转义一次，cmd 把整串当成程序名：
      // '"\"C:\\tools\\x.cmd\" \"--stdio\""' 不是内部或外部命令。
      expect(launch.verbatim).toBe(true)
      // 整个命令行不能出现被二次转义的反斜杠引号，那是崩溃时的特征。
      expect(launch.args[3]).not.toContain('\\"')
      expect(launch.args[3]?.endsWith('"')).toBe(true)
      return
    }
    expect(launchFor('/usr/bin/gopls', ['-remote=auto'])).toEqual({
      file: '/usr/bin/gopls',
      args: ['-remote=auto'],
      verbatim: false,
    })
    // .cmd 只在 Windows 上才有意义；其它平台不应该把参数改写。
    expect(launchFor('/usr/bin/pyright-langserver.cmd', ['--stdio'])).toEqual({
      file: '/usr/bin/pyright-langserver.cmd',
      args: ['--stdio'],
      verbatim: false,
    })
  })

  it('skips node_modules and .git when scanning sources', async () => {
    const root = await pythonProject()
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true })
    await writeFile(join(root, 'node_modules', 'pkg', 'skip.py'), 'def nope():\n    pass\n', 'utf8')
    await mkdir(join(root, '.git'), { recursive: true })
    await writeFile(join(root, '.git', 'skip.py'), 'def nope():\n    pass\n', 'utf8')
    const scan = await scanSources(root, new Set(['py']), 100)
    expect(scan.files.every((file) => !file.includes('node_modules') && !file.includes('.git'))).toBe(true)
    expect(scan.files).toHaveLength(2)
    expect(scan.byExtension).toEqual([{ ext: 'py', count: 2 }])
  })
})

describe('runCodeIntel over a language server (python)', () => {
  it('resolves a definition and converts 0-based LSP positions to 1-based', async () => {
    const root = await pythonProject()
    await writeShim(root, PY_SERVER, 'full')
    const result = await runCodeIntel(root, { action: 'definition', path: 'app/main.py', symbol: 'greet' })
    expect(result.ok).toBe(true)
    expect(result.metadata['engine']).toBe('lsp')
    expect(result.metadata['language']).toBe('python')
    expect(result.output).toContain('app/helpers.py:1:5')
    expect(result.output).toContain('def greet(name):')
  })

  it('lists every reference with its source line', async () => {
    const root = await pythonProject()
    await writeShim(root, PY_SERVER, 'full')
    const result = await runCodeIntel(root, { action: 'references', path: 'app/main.py', symbol: 'greet' })
    expect(result.metadata['count']).toBe(2)
    expect(result.output).toContain('app/main.py:4:20')
    expect(result.output).toContain('return helpers.greet("x")')
  })

  it('maps workspace symbols with readable kinds', async () => {
    const root = await pythonProject()
    await writeShim(root, PY_SERVER, 'full')
    const result = await runCodeIntel(root, { action: 'symbols', query: 'greet' })
    expect(result.metadata['engine']).toBe('lsp')
    expect(result.output).toContain('[Function greet]')
    expect(result.output).toContain('app/helpers.py:1:5')
  })

  it('reports diagnostics for one file and for the workspace', async () => {
    const root = await pythonProject()
    await writeShim(root, PY_SERVER, 'full')
    const single = await runCodeIntel(root, { action: 'diagnostics', path: 'app/main.py' })
    expect(single.metadata['scope']).toBe('file')
    expect(single.output).toContain('app/main.py:4:20')
    expect(single.output).toContain('fake type error')

    const clean = await runCodeIntel(root, { action: 'diagnostics', path: 'app/helpers.py' })
    expect(clean.output).toContain('No diagnostics')

    const workspace = await runCodeIntel(root, { action: 'diagnostics', scope: 'workspace' })
    expect(workspace.metadata['scope']).toBe('workspace')
    expect(workspace.output).toContain('fake type error')
  })

  it('falls back to publishDiagnostics when the server has no pull support', async () => {
    const root = await pythonProject()
    await writeShim(root, PY_SERVER, 'push')
    const result = await runCodeIntel(root, { action: 'diagnostics', path: 'app/main.py' })
    expect(result.ok).toBe(true)
    expect(result.output).toContain('fake type error')
  })

  it('reuses one server process for repeated queries', async () => {
    const root = await pythonProject()
    await writeShim(root, PY_SERVER, 'full')
    await runCodeIntel(root, { action: 'definition', path: 'app/main.py', symbol: 'greet' })
    await runCodeIntel(root, { action: 'symbols', query: 'main' })
    const status = lspStatus()
    expect(status).toHaveLength(1)
    expect(status[0]?.alive).toBe(true)
    // 第一次 definition 已经 didOpen 过 app/main.py
    expect(status[0]?.opened).toBeGreaterThan(0)
  })

  it('degrades to a structural search when the server cannot start', async () => {
    const root = await pythonProject()
    await writeShim(root, PY_SERVER, 'crash')
    const result = await runCodeIntel(root, { action: 'definition', path: 'app/main.py', symbol: 'greet' })
    expect(result.ok).toBe(true)
    expect(result.metadata['engine']).toBe('heuristic')
    expect(result.output).toContain('Note:')
    expect(result.output).toContain('refused to start')
  })

  // LSP 规范说 definition 的结果是 `Location | Location[] | LocationLink[]`。
  // pyright / gopls / jdtls 三种形状都会返回；只认其中一种就会把「找到了」当成「没找到」。
  it('accepts Location[] and LocationLink[] definition results', async () => {
    for (const mode of ['array', 'link']) {
      const root = await pythonProject()
      await writeShim(root, PY_SERVER, mode)
      const result = await runCodeIntel(root, {
        action: 'definition',
        path: 'app/main.py',
        symbol: 'greet',
      })
      expect(result.metadata['engine']).toBe('lsp')
      expect(result.metadata['count']).toBe(1)
      expect(result.output).toContain('app/helpers.py:1:5')
      expect(result.output).toContain('def greet(name):')
    }
  })

  // pyright 会报 typeshed、gopls 会报 GOROOT 里的定义。这类路径不在工作区，
  // 读出文件内容会把 stdlib 源码当成用户代码，但也不该让整个查询报错。
  it('keeps an out-of-workspace definition addressable', async () => {
    const root = await pythonProject()
    await writeShim(root, PY_SERVER, 'external')
    const result = await runCodeIntel(root, { action: 'definition', path: 'app/main.py', symbol: 'greet' })
    expect(result.ok).toBe(true)
    expect(result.metadata['count']).toBe(1)
    expect(result.output).toContain('/opt/vendor/lib.py:10:3')
  })

  it('starts a fresh server after the previous one exits', async () => {
    const root = await pythonProject()
    await writeShim(root, PY_SERVER, 'die-once')
    const first = await runCodeIntel(root, { action: 'symbols', query: 'greet' })
    expect(first.metadata['engine']).toBe('lsp')

    await waitFor(() => lspStatus().every((entry) => !entry.alive), 5_000)

    const second = await runCodeIntel(root, { action: 'symbols', query: 'greet' })
    expect(second.metadata['engine']).toBe('lsp')
    expect(lspStatus().some((entry) => entry.alive)).toBe(true)
  })

  it('keeps one server process per language', async () => {
    const root = await pythonProject()
    await writeFile(
      join(root, 'server.go'),
      ['package main', '', 'type Server struct{}', '', 'func (s *Server) Start() error {', '\treturn nil', '}', ''].join('\n'),
      'utf8',
    )
    await writeShim(root, PY_SERVER, 'full')
    await writeShim(root, 'gopls', 'full')

    const py = await runCodeIntel(root, { action: 'symbols', query: 'greet', language: 'python' })
    const go = await runCodeIntel(root, { action: 'symbols', query: 'greet', language: 'go' })
    expect(py.metadata['language']).toBe('python')
    expect(go.metadata['language']).toBe('go')

    const status = lspStatus()
    expect(status.map((entry) => entry.language).sort()).toEqual(['go', 'python'])
    expect(status.every((entry) => entry.alive)).toBe(true)
  })
})

describe('heuristic fallback without a language server', () => {
  const python = languageById('python') as LanguageSpec

  it('does not mistake a call site for a declaration', async () => {
    const root = await pythonProject()
    // main.py 里的 greet 只出现在调用行，所以「定义」不该命中它。
    const result = await runHeuristicCodeIntel(root, python, {
      action: 'definition',
      path: 'app/main.py',
      symbol: 'greet',
    })
    expect(result.metadata['count']).toBe(0)
    expect(result.output).toContain('No definition of "greet"')
    expect(result.output).toContain('Heuristic Python search')
  })

  it('finds declarations by language syntax across the workspace', async () => {
    const root = await pythonProject()
    const result = await runHeuristicCodeIntel(root, python, { action: 'symbols', query: 'main' })
    expect(result.metadata['engine']).toBe('heuristic')
    expect(result.output).toContain('def main():')
    expect(result.output).toContain('app/main.py:3:')
  })

  it('counts references by word boundary and skips comment lines', async () => {
    const root = await pythonProject()
    await writeFile(
      join(root, 'app', 'notes.py'),
      ['# greet is mentioned in a comment', 'greeting = "not a match"', ''].join('\n'),
      'utf8',
    )
    const result = await runHeuristicCodeIntel(root, python, { action: 'references', symbol: 'greet' })
    // 声明 1 处 + 调用 1 处；注释行与 greeting 都不算。
    expect(result.metadata['count']).toBe(2)
  })

  it('refuses diagnostics instead of guessing', async () => {
    const root = await pythonProject()
    const result = await runHeuristicCodeIntel(root, python, { action: 'diagnostics', path: 'app/main.py' })
    expect(result.ok).toBe(false)
    expect(result.metadata['needsServer']).toBe(true)
    expect(result.output).toContain('need a language server')
  })

  // 降级不是「只服务 Python」：模型后面还要看 Go / Java，没有 server 时至少要知道
  // func / type / class / method 这些声明长什么样，而不是 grep 名字。
  it('recognises Go declarations', async () => {
    const root = await tempDir('pilot-heur-go-')
    await writeFile(
      join(root, 'server.go'),
      ['package main', '', 'type Server struct{}', '', 'func (s *Server) Start() error {', '\treturn nil', '}', ''].join('\n'),
      'utf8',
    )
    const go = languageById('go') as LanguageSpec
    const symbols = await runHeuristicCodeIntel(root, go, { action: 'symbols', query: 'Start' })
    expect(symbols.metadata['engine']).toBe('heuristic')
    expect(symbols.output).toContain('server.go:5:')

    const definition = await runHeuristicCodeIntel(root, go, {
      action: 'definition',
      path: 'server.go',
      symbol: 'Server',
    })
    expect(definition.metadata['count']).toBe(1)
    expect(definition.output).toContain('server.go:3:')
  })

  it('recognises Java declarations', async () => {
    const root = await tempDir('pilot-heur-java-')
    await writeFile(
      join(root, 'Greeter.java'),
      [
        'package demo;',
        '',
        'public class Greeter {',
        '    public String greet(String name) {',
        '        return "hi " + name;',
        '    }',
        '}',
        '',
      ].join('\n'),
      'utf8',
    )
    const java = languageById('java') as LanguageSpec
    const result = await runHeuristicCodeIntel(root, java, {
      action: 'definition',
      path: 'Greeter.java',
      symbol: 'Greeter',
    })
    expect(result.metadata['count']).toBe(1)
    expect(result.output).toContain('Greeter.java:3:')
  })
})

describe('engine routing', () => {
  it('keeps TypeScript files on the in-process language service', async () => {
    const root = await tempDir('pilot-route-ts-')
    await writeFile(join(root, 'a.ts'), 'export const answer = 42\n', 'utf8')
    const result = await runCodeIntel(root, { action: 'symbols', query: 'answer' })
    expect(result.ok).toBe(true)
    expect(result.metadata['engine']).toBeUndefined()
    expect(result.metadata['count']).toBeGreaterThanOrEqual(1)
  })

  it('honours an explicit language when no path is given', async () => {
    const root = await pythonProject()
    await writeShim(root, PY_SERVER, 'full')
    const result = await runCodeIntel(root, { action: 'symbols', query: 'greet', language: 'python' })
    expect(result.metadata['engine']).toBe('lsp')
  })

  it('rejects an unsupported extension with a readable message', async () => {
    const root = await tempDir('pilot-route-txt-')
    const result = await runCodeIntel(root, { action: 'symbols', query: 'x', path: 'notes.txt' })
    expect(result.ok).toBe(false)
    expect(result.output).toContain('cannot analyse notes.txt')
  })

  it('rejects an unknown explicit language', async () => {
    const root = await tempDir('pilot-route-bad-')
    const result = await runCodeIntel(root, { action: 'symbols', query: 'x', language: 'cobol' })
    expect(result.ok).toBe(false)
    expect(result.output).toContain('Unknown language "cobol"')
  })
})

describe('code_intel tool layer', () => {
  it('passes a python query through and reports the engine', async () => {
    const root = await pythonProject()
    await writeShim(root, PY_SERVER, 'full')
    const result = await runCodeIntelTool(
      'code_intel',
      { action: 'symbols', query: 'greet', language: 'python' },
      host(root),
      new AbortController().signal,
    )
    expect(result).not.toBeNull()
    expect(result?.metadata?.['engine']).toBe('lsp')
  })

  it('refuses a path outside the workspace', async () => {
    const root = await pythonProject()
    await expect(
      runCodeIntelTool(
        'code_intel',
        { action: 'symbols', path: '../escape.py' },
        host(root),
        new AbortController().signal,
      ),
    ).rejects.toThrow(/outside/)
  })

  // 从头到尾穿过工具入口：参数解析 → 引擎路由 → LSP 子进程 → file:line:column。
  it('runs all four actions through the tool entry point', async () => {
    const root = await pythonProject()
    await writeShim(root, PY_SERVER, 'full')
    const signal = new AbortController().signal
    const call = (args: Record<string, unknown>) =>
      runCodeIntelTool('code_intel', args, host(root), signal)

    const definition = await call({ action: 'definition', path: 'app/main.py', symbol: 'greet' })
    expect(definition?.ok).toBe(true)
    expect(definition?.metadata?.['engine']).toBe('lsp')
    expect(definition?.output).toContain('app/helpers.py:1:5')

    const references = await call({ action: 'references', path: 'app/main.py', symbol: 'greet' })
    expect(references?.metadata?.['count']).toBe(2)
    expect(references?.output).toContain('app/main.py:4:20')

    const symbols = await call({ action: 'symbols', query: 'greet' })
    expect(symbols?.output).toContain('[Function greet]')

    const diagnostics = await call({ action: 'diagnostics', path: 'app/main.py' })
    expect(diagnostics?.output).toContain('app/main.py:4:20  fake type error')
    expect(diagnostics?.metadata?.['scope']).toBe('file')
  })

  it('prefers an explicit language over the file extension', async () => {
    const root = await pythonProject()
    await writeShim(root, 'gopls', 'full')
    const result = await runCodeIntelTool(
      'code_intel',
      { action: 'symbols', query: 'greet', path: 'app/main.py', language: 'go' },
      host(root),
      new AbortController().signal,
    )
    expect(result?.metadata?.['language']).toBe('go')
    expect(result?.metadata?.['engine']).toBe('lsp')
  })

  it('declares a read-only, multi-language tool', () => {
    const spec = codeIntelTools[0]
    expect(spec?.name).toBe('code_intel')
    expect(spec?.risk).toBe('read')
    expect(spec?.inputSchema.required).toEqual(['action'])

    const properties = spec?.inputSchema.properties as unknown as
      | Record<string, { enum?: string[]; description?: string }>
      | undefined
    expect(properties?.['action']?.enum).toEqual([
      'definition',
      'references',
      'symbols',
      'diagnostics',
    ])
    expect(properties?.['scope']?.enum).toEqual(['file', 'workspace'])

    const description = `${spec?.description ?? ''} ${properties?.['language']?.description ?? ''}`
    for (const language of ['Python', 'Go', 'Java', 'Rust', 'C++', 'Ruby', 'PHP', 'C#']) {
      expect(description).toContain(language)
    }
    expect(description).toMatch(/language server/)
    expect(description).toMatch(/degrades/)
  })

  it('ignores any other tool name', async () => {
    const root = await pythonProject()
    const result = await runCodeIntelTool(
      'search_files',
      { action: 'symbols', query: 'greet' },
      host(root),
      new AbortController().signal,
    )
    expect(result).toBeNull()
  })

  it('rejects an unknown action before touching the filesystem', async () => {
    const root = await pythonProject()
    await expect(
      runCodeIntelTool('code_intel', { action: 'rename' }, host(root), new AbortController().signal),
    ).rejects.toThrow(/action must be one of/)
  })

  it('honours an already-aborted signal', async () => {
    const root = await pythonProject()
    const aborted = new AbortController()
    aborted.abort()
    await expect(
      runCodeIntelTool('code_intel', { action: 'symbols', query: 'greet' }, host(root), aborted.signal),
    ).rejects.toThrow(/aborted/)
  })
})
