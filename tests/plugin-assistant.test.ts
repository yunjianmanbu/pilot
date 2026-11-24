import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildDraftMessages,
  draftPlugin,
  inspectDraftEntry,
  installDraftPlugin,
  parseDraftResponse,
  validateDraft,
  type DraftMessage,
} from '../src/main/plugins/assistant'
import { PLUGIN_MANIFEST_FILE, parsePluginManifest } from '../src/main/plugins/manifest'
import { pluginDirFor, pluginOverview, setSignaturePolicy } from '../src/main/plugins/studio'

const cleanups: string[] = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDir(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `pilot-assistant-${label}-`))
  cleanups.push(dir)
  return dir
}

/** The entry the host actually accepts: emits JSON lines, handles all four methods. */
const ENTRY = `let stateDir = '.'
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: id, result: result }) + '\\n')
}
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  for (const line of String(chunk).split('\\n')) {
    if (!line.trim()) continue
    const message = JSON.parse(line)
    if (message.method === 'plugin.activate') reply(message.id, { ok: true, stateDir })
    else if (message.method === 'plugin.request') reply(message.id, { status: 200, body: { ok: true } })
    else reply(message.id, null)
  }
})
`

function manifestOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'barcode-lookup',
    name: '条码查商品',
    version: 1,
    api: 1,
    runtime: 'node',
    entry: 'index.mjs',
    description: '按条码查商品档案',
    permissions: ['products:read'],
    routes: [
      {
        method: 'GET',
        path: 'lookup',
        auth: 'required',
        permission: 'products:read',
        description: '按条码查一条商品',
      },
    ],
    ...overrides,
  }
}

function responseOf(manifest: Record<string, unknown>, entry = ENTRY, reply = '做好了'): string {
  return JSON.stringify({ reply, manifest, entry })
}

const validDraft = {
  reply: '做好了',
  manifest: manifestOf(),
  entry: ENTRY,
}

describe('plugin assistant prompt assembly', () => {
  it('rejects an empty request and caps the prompt length', () => {
    expect(() => buildDraftMessages({ prompt: '   ' })).toThrow(/描述/)
    expect(() => buildDraftMessages({ prompt: 'x'.repeat(5_000) })).toThrow(/太长/)
  })

  it('keeps only user/assistant turns from the history', () => {
    const messages = buildDraftMessages({
      prompt: '加一个路由',
      history: [
        { role: 'system', content: '注入的系统提示' },
        { role: 'user', content: '第一轮需求' },
        { role: 'assistant', content: '第一轮回答' },
      ] as never,
    })
    expect(messages[0]?.role).toBe('system')
    expect(messages[0]?.content).toContain('plugin.activate')
    // 渲染层传回来的 system 轮次必须被丢掉，否则可以被用来覆盖契约提示词。
    expect(messages.some((item) => item.content === '注入的系统提示')).toBe(false)
    expect(messages.at(-1)?.content).toContain('加一个路由')
  })
})

describe('plugin assistant response parsing', () => {
  it('reads a bare JSON object', () => {
    const parsed = parseDraftResponse(responseOf(manifestOf()))
    expect(parsed.reply).toBe('做好了')
    expect(parsed.entry).toContain('plugin.request')
  })

  it('unwraps a fenced block with chatter around it', () => {
    const parsed = parseDraftResponse(
      `好的，下面是插件：\n\`\`\`json\n${responseOf(manifestOf())}\n\`\`\`\n有需要再告诉我。`,
    )
    expect(parsed.manifest).toMatchObject({ id: 'barcode-lookup' })
  })

  it('fails loudly on prose, bad JSON and a missing manifest', () => {
    expect(() => parseDraftResponse('我不太确定你要什么')).toThrow(/没有 JSON/)
    expect(() => parseDraftResponse('{"reply": "x", }')).toThrow(/无法解析/)
    expect(() => parseDraftResponse('{"reply":"x","entry":"x"}')).toThrow(/manifest/)
  })
})

describe('plugin assistant validation', () => {
  it('normalizes the id and pins the entry file', () => {
    const draft = validateDraft({
      reply: '',
      manifest: manifestOf({ id: 'Barcode Lookup', entry: 'main.js' }),
      entry: ENTRY,
    })
    expect(draft.manifest.id).toBe('barcode-lookup')
    expect(draft.manifest.entry).toBe('index.mjs')
    expect(draft.warnings.join(' ')).toContain('规范化为')
    // 清单序列化后必须还能被宿主解析回来，否则写进工作区也加载不了。
    expect(parsePluginManifest(JSON.parse(draft.manifestJson)).id).toBe('barcode-lookup')
  })

  it('surfaces manifest errors instead of silently repairing them', () => {
    expect(() => validateDraft({ reply: '', manifest: manifestOf({ api: 2 }), entry: ENTRY })).toThrow(
      /api/,
    )
    expect(() =>
      validateDraft({
        reply: '',
        manifest: manifestOf({ routes: [{ method: 'GET', path: 'a/b', auth: 'public' }] }),
        entry: ENTRY,
      }),
    ).toThrow(/path/)
  })

  it('rejects entry code the host could never run', () => {
    expect(inspectDraftEntry('const x = require("fs")')).toContain(
      '入口必须是 ESM，不能用 require()',
    )
    expect(inspectDraftEntry('console.log("hi")')).toEqual(
      expect.arrayContaining([
        expect.stringContaining('plugin.activate'),
        expect.stringContaining('plugin.request'),
      ]),
    )
    expect(inspectDraftEntry(ENTRY)).toEqual([])
    expect(() => validateDraft({ reply: '', manifest: manifestOf(), entry: 'console.log(1)' })).toThrow(
      /plugin.activate/,
    )
  })
})

describe('plugin assistant generation', () => {
  it('returns the draft without touching the disk', async () => {
    const workspace = await tempDir('draft')
    const view = await draftPlugin(
      { prompt: '按条码查商品' },
      { workspace, modelLabel: 'test-model', complete: async () => responseOf(manifestOf()) },
    )
    expect(view.id).toBe('barcode-lookup')
    expect(view.model).toBe('test-model')
    expect(view.attempts).toBe(1)
    expect(view.routes).toHaveLength(1)
    expect(view.permissions).toEqual(['products:read'])
    await expect(stat(join(workspace, '.pilot', 'plugins'))).rejects.toThrow()
  })

  it('feeds the validation error back once, then accepts the repair', async () => {
    const seen: DraftMessage[][] = []
    const view = await draftPlugin(
      { prompt: '按条码查商品' },
      {
        complete: async (messages) => {
          seen.push([...messages])
          if (seen.length === 1) return responseOf(manifestOf({ api: 9 }))
          return responseOf(manifestOf())
        },
      },
    )
    expect(view.attempts).toBe(2)
    expect(seen[1]?.at(-1)?.content).toContain('api')
  })

  it('gives up after two unusable answers and names the reason', async () => {
    await expect(
      draftPlugin({ prompt: '按条码查商品' }, { complete: async () => '我不会' }),
    ).rejects.toThrow(/连续 2 轮/)
  })

  it('warns when the id is already installed', async () => {
    const workspace = await tempDir('clash')
    await installDraftPlugin(workspace, {
      id: 'barcode-lookup',
      manifestJson: JSON.stringify(manifestOf()),
      entry: ENTRY,
      enable: false,
      sign: false,
    })
    const view = await draftPlugin(
      { prompt: '再来一个' },
      { workspace, complete: async () => responseOf(manifestOf()) },
    )
    expect(view.warnings.join(' ')).toContain('已经有 barcode-lookup')
  })
})

describe('plugin assistant install', () => {
  it('writes the manifest, entry and README, then enables the plugin', async () => {
    const workspace = await tempDir('install')
    const result = await installDraftPlugin(workspace, {
      id: 'barcode-lookup',
      manifestJson: JSON.stringify(manifestOf()),
      entry: ENTRY,
      enable: true,
      sign: false,
    })
    const dir = pluginDirFor(workspace, 'barcode-lookup')
    expect(result.dir).toBe(dir)
    expect(result.enabled).toBe(true)
    expect(result.files).toEqual(
      expect.arrayContaining([PLUGIN_MANIFEST_FILE, 'index.mjs', 'README.md', '.gitignore']),
    )
    const onDisk = await readFile(join(dir, 'index.mjs'), 'utf8')
    expect(onDisk.endsWith('\n')).toBe(true)
    expect(await readFile(join(dir, 'README.md'), 'utf8')).toContain('GET /api/plugins/')
    const enabled = result.overview.plugins.find((item) => item.id === 'barcode-lookup')
    expect(enabled?.enabled).toBe(true)
    expect(enabled?.routes[0]?.path).toBe('lookup')
  })

  it('re-validates the manifest instead of trusting the page', async () => {
    const workspace = await tempDir('tamper')
    await expect(
      installDraftPlugin(workspace, {
        id: 'barcode-lookup',
        manifestJson: JSON.stringify(manifestOf({ id: 'other-plugin' })),
        entry: ENTRY,
      }),
    ).rejects.toThrow(/does not match/)
    await expect(
      installDraftPlugin(workspace, {
        id: 'barcode-lookup',
        manifestJson: 'not json',
        entry: ENTRY,
      }),
    ).rejects.toThrow(/不是合法的 JSON/)
  })

  it('refuses to overwrite an installed plugin or a bad entry', async () => {
    const workspace = await tempDir('duplicate')
    const input = {
      id: 'barcode-lookup',
      manifestJson: JSON.stringify(manifestOf()),
      entry: ENTRY,
    }
    await installDraftPlugin(workspace, { ...input, enable: false })
    await expect(installDraftPlugin(workspace, input)).rejects.toThrow(/已经安装了/)
    await expect(
      installDraftPlugin(workspace, {
        id: 'fresh-plugin',
        manifestJson: JSON.stringify(manifestOf({ id: 'fresh-plugin' })),
        entry: 'export const nothing = 1',
      }),
    ).rejects.toThrow(/plugin.activate/)
  })

  it('signs automatically when the workspace policy is required', async () => {
    const workspace = await tempDir('required')
    await setSignaturePolicy(workspace, 'required')
    const result = await installDraftPlugin(workspace, {
      id: 'barcode-lookup',
      manifestJson: JSON.stringify(manifestOf()),
      entry: ENTRY,
      enable: true,
    })
    expect(result.signed).toBe(true)
    expect(result.files).toContain('plugin.sig')
    const overview = await pluginOverview(workspace)
    expect(overview.plugins[0]?.signature?.state).toBe('trusted')
  })

  it('leaves nothing behind when writing fails midway', async () => {
    const workspace = await tempDir('rollback')
    // entry 里塞一个会让 normalizeEntry 之后仍然失败的东西：清单合法但入口被拒绝。
    await expect(
      installDraftPlugin(workspace, {
        id: 'barcode-lookup',
        manifestJson: JSON.stringify(manifestOf()),
        entry: 'require("fs")',
      }),
    ).rejects.toThrow()
    await expect(stat(pluginDirFor(workspace, 'barcode-lookup'))).rejects.toThrow()
  })
})
