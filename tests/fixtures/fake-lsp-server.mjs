#!/usr/bin/env node
/**
 * 测试用的假 language server。
 *
 * 只实现 code_intel 用到的那一小部分 LSP，行为完全确定，用来验证 Pilot 自己写的
 * 客户端：Content-Length 分帧、URI ↔ 路径、0-based → 1-based、pull/push 诊断、
 * 超时与崩溃。真实 server（pyright/gopls/jdtls）的行为不在这里覆盖。
 *
 * 模式（`--mode=`）：
 *   full   全部实现，诊断走 LSP 3.17 的 pull（textDocument/diagnostic）
 *   split  每条响应拆成两次 write，验证客户端能跨 chunk 拼包
 *   big    workspace/symbol 返回 200 条超长记录，单帧 > 64KB
 *   push   不实现 pull，--32601 报错，改在 didOpen 后推送 publishDiagnostics
 *   slow   除 initialize/shutdown 外一概不回应，用来测请求超时
 *   crash  收到 initialize 就写一行 stderr 并 exit(3)
 *   array  definition 返回 Location[]（规范允许的第二种形状）
 *   link   definition 返回 LocationLink[]（linkSupport:true 时 server 的常见回法）
 *   external definition 指向工作区外的文件（pyright 的 typeshed、gopls 的 GOROOT）
 *   die-once 回答一次 workspace/symbol 后自行退出，用来验证下次查询会重建进程
 *
 * 固定 fixture（测试创建）：
 *   app/main.py     line 3 -> "    return helpers.greet(\"x\")"   （greet 在第 20 列）
 *   app/helpers.py  line 0 -> "def greet(name):"
 */
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const mode = (process.argv.find((arg) => arg.startsWith('--mode=')) ?? '--mode=full').slice(
  '--mode='.length,
)

let rootDir = process.cwd()
let rootUri = pathToFileURL(rootDir).toString()

function send(message, split = mode === 'split') {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii')
  const payload = Buffer.concat([header, body])
  if (split && payload.length > 4) {
    const cut = Math.floor(payload.length / 2)
    process.stdout.write(payload.subarray(0, cut))
    setTimeout(() => process.stdout.write(payload.subarray(cut)), 5)
  } else {
    process.stdout.write(payload)
  }
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

function uriFor(rel) {
  return pathToFileURL(join(rootDir, rel)).toString()
}

/** `file:///.../app/main.py` -> `app/main.py` */
function relOf(uri) {
  try {
    return relative(rootDir, fileURLToPath(uri)).split('\\').join('/')
  } catch {
    return ''
  }
}

function position(line, character) {
  return { line, character }
}

function range(line, startChar, endChar) {
  return { start: position(line, startChar), end: position(line, endChar) }
}

function definitionResult() {
  const location = { uri: uriFor('app/helpers.py'), range: range(0, 4, 9) }
  if (mode === 'array') return [location]
  if (mode === 'link') {
    return [
      {
        targetUri: location.uri,
        targetRange: range(0, 0, 9),
        targetSelectionRange: location.range,
      },
    ]
  }
  if (mode === 'external') {
    // 工作区外的定义：真实 server 报 typeshed / JDK / module cache 时就是这样。
    return { uri: pathToFileURL('/opt/vendor/lib.py').toString(), range: range(9, 2, 7) }
  }
  return location
}

function referenceResults() {
  return [
    { uri: uriFor('app/helpers.py'), range: range(0, 4, 9) },
    { uri: uriFor('app/main.py'), range: range(3, 19, 24) },
  ]
}

const SYMBOLS = [
  { name: 'greet', kind: 12, location: { uri: uriFor('app/helpers.py'), range: range(0, 4, 9) } },
  { name: 'Service', kind: 5, location: { uri: uriFor('app/main.py'), range: range(6, 6, 13) } },
  { name: 'main', kind: 12, location: { uri: uriFor('app/main.py'), range: range(2, 4, 8) } },
]

function diagnosticsFor(uri) {
  if (!relOf(uri).endsWith('app/main.py')) return []
  return [
    {
      range: range(3, 19, 24),
      severity: 1,
      code: 80001,
      source: 'fake-lsp',
      message: 'fake type error',
    },
  ]
}

function bigSymbols() {
  const padding = 'x'.repeat(400)
  return Array.from({ length: 200 }, (_, index) => ({
    name: `sym${index}`,
    kind: 12,
    location: {
      uri: uriFor(`big/file${index}.py`),
      range: range(index, 0, 4),
    },
    padding,
  }))
}

function capabilities() {
  const caps = {
    definitionProvider: true,
    referencesProvider: true,
    documentSymbolProvider: true,
    workspaceSymbolProvider: true,
    hoverProvider: false,
  }
  if (mode !== 'push') {
    caps.diagnosticProvider = { interFileDependencies: false, workspaceDiagnostics: false }
  }
  return caps
}

function handleNotification(method, params) {
  if (method === 'textDocument/didOpen' && mode === 'push') {
    const uri = params?.textDocument?.uri
    if (!uri) return
    const items = diagnosticsFor(uri)
    if (items.length === 0) return
    setTimeout(() => {
      send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: items } })
    }, 60)
  }
}

function handleRequest(id, method, params) {
  if (method === 'initialize') {
    if (mode === 'crash') {
      process.stderr.write('fake server refused to start\n')
      process.exit(3)
    }
    rootUri = params?.rootUri ?? rootUri
    rootDir = fileURLToPath(rootUri)
    send({ jsonrpc: '2.0', id, result: { capabilities: capabilities(), serverInfo: { name: 'fake-lsp', version: '1' } } })
    return
  }
  if (method === 'shutdown') {
    send({ jsonrpc: '2.0', id, result: null })
    return
  }
  if (mode === 'slow') return

  switch (method) {
    case 'textDocument/definition':
      send({ jsonrpc: '2.0', id, result: definitionResult() })
      return
    case 'textDocument/references':
      send({ jsonrpc: '2.0', id, result: referenceResults() })
      return
    case 'workspace/symbol': {
      if (mode === 'big') {
        send({ jsonrpc: '2.0', id, result: bigSymbols() })
        return
      }
      const query = String(params?.query ?? '')
      const hit = SYMBOLS.filter((symbol) => symbol.name.toLowerCase().includes(query.toLowerCase()))
      send({ jsonrpc: '2.0', id, result: hit })
      // 让客户端先收到完整帧，再退出；响应很小，120ms 足够把管道写空。
      if (mode === 'die-once') setTimeout(() => process.exit(0), 120)
      return
    }
    case 'textDocument/documentSymbol': {
      const rel = relOf(params?.textDocument?.uri ?? '')
      const hit = SYMBOLS.filter((symbol) => relOf(symbol.location.uri) === rel)
      send({
        jsonrpc: '2.0',
        id,
        result: hit.map((symbol) => ({
          name: symbol.name,
          kind: symbol.kind,
          range: symbol.location.range,
          selectionRange: symbol.location.range,
        })),
      })
      return
    }
    case 'textDocument/diagnostic': {
      if (mode === 'push') {
        replyError(id, -32601, 'textDocument/diagnostic is not supported')
        return
      }
      const uri = params?.textDocument?.uri ?? ''
      send({ jsonrpc: '2.0', id, result: { kind: 'full', items: diagnosticsFor(uri) } })
      return
    }
    case 'textDocument/hover':
      replyError(id, -32601, 'hover is not supported')
      return
    default:
      replyError(id, -32601, `unhandled method ${method}`)
  }
}

let buffer = Buffer.alloc(0)
process.stdin.on('data', (chunk) => {
  buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n')
    if (headerEnd < 0) return
    const header = buffer.subarray(0, headerEnd).toString('ascii')
    const match = /Content-Length:\s*(\d+)/i.exec(header)
    const start = headerEnd + 4
    if (!match) {
      buffer = buffer.subarray(start)
      continue
    }
    const length = Number(match[1])
    if (buffer.length < start + length) return
    const body = buffer.subarray(start, start + length).toString('utf8')
    buffer = buffer.subarray(start + length)
    let message
    try {
      message = JSON.parse(body)
    } catch {
      continue
    }
    const { id, method, params } = message ?? {}
    if (method === 'exit') process.exit(0)
    if (typeof id === 'number' && typeof method === 'string') {
      handleRequest(id, method, params)
    } else if (typeof method === 'string') {
      handleNotification(method, params)
    }
  }
})

process.stdin.on('end', () => process.exit(0))
