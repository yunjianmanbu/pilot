import { createPublicKey } from 'node:crypto'
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type {
  PluginCreateInput,
  PluginCreateResult,
  PluginInstallInput,
  PluginInstallResult,
  PluginMarketItem,
  PluginOverview,
  PluginRecordView,
  PluginSignaturePolicy,
  PluginSignatureView,
  PluginTemplateId,
  PluginTemplateView,
  PluginTrustedKeyView,
} from '../../shared/types'
import {
  addTrustedKey,
  assessPluginSignature,
  generateSigningKey,
  keyIdForPublicKey,
  readSignaturePolicy,
  readTrustStore,
  removeTrustedKey,
  signPluginDir,
  writePluginSignature,
  writeSignaturePolicy,
  type PluginSignature,
  type SignaturePolicy,
  type TrustedKey,
} from './integrity'
import {
  loadPluginManifests,
  MAX_PLUGINS,
  parsePluginManifest,
  PLUGIN_API_VERSION,
  PLUGIN_MANIFEST_FILE,
  PLUGINS_DIR,
  type PluginManifest,
} from './manifest'
import { findTemplate, PLUGIN_TEMPLATES, type PluginTemplate } from './templates'

/**
 * Plugin market + plugin assistant.
 *
 * The desktop app previously only *ran* plugins (through the phone companion
 * server). This module gives it the other half: a curated market list, a
 * scaffolding assistant that writes a plugin into a directory the user picks,
 * and the file operations (install, sign, trust, enable, remove) that used to
 * require the `pilot plugin …` CLI.
 *
 * Everything is plain filesystem work under `<workspace>/.pilot/plugins`, so the
 * same code is usable from a headless test.
 */

const ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/
const GRANTS_FILE = 'grants.json'
const LOCAL_KEY_SLUG = 'pilot-local'
const LOCAL_KEY_LABEL = 'Pilot 本机签名'
const MAX_INSTALL_FILES = 400
const MAX_INSTALL_BYTES = 8 * 1024 * 1024
/** Never copied into a workspace: VCS, dependencies, keys and runtime state. */
const SKIP_COPY = new Set(['.git', 'node_modules', '.keys', '.state'])

export interface PluginGrants {
  [id: string]: { enabled: boolean; permissions: string[] }
}

export interface CreatePluginOptions extends PluginCreateInput {
  /** Workspace path, used only to resolve relative ids and for messages. */
  workspace?: string
}

export interface InstallPluginOptions extends PluginInstallInput {
  workspace: string
}

/** Curated market list. Bundled with the app: no network round trip. */
const MARKET: Omit<PluginMarketItem, 'installed'>[] = [
  {
    id: 'member-points',
    name: '会员积分',
    summary: '门店会员的积分增减与余额查询，自带 HTTP 路由和权限声明。',
    category: 'business',
    publisher: 'Pilot 内置市场',
    version: 1,
    permissions: ['items:read', 'items:write'],
    template: 'http',
    routeCount: 3,
  },
  {
    id: 'inventory-sync',
    name: '库存同步',
    summary: '把仓库库存变更记录成事件流，Agent 可以按条读取后再对齐 ERP。',
    category: 'data',
    publisher: 'Pilot 内置市场',
    version: 1,
    permissions: ['events:read', 'events:write'],
    template: 'webhook',
    routeCount: 2,
  },
  {
    id: 'staff-login',
    name: '员工登录',
    summary: '以 session 提供者身份接管登录，其他插件据此拿到角色和权限。',
    category: 'identity',
    publisher: 'Pilot 内置市场',
    version: 1,
    permissions: [],
    template: 'session',
    routeCount: 2,
  },
  {
    id: 'order-events',
    name: '订单事件',
    summary: '订单创建、支付、退款事件的接收端，先落盘再交给后续流程处理。',
    category: 'ops',
    publisher: 'Pilot 内置市场',
    version: 1,
    permissions: ['events:read', 'events:write'],
    template: 'webhook',
    routeCount: 2,
  },
]

export function pluginsRoot(workspace: string): string {
  return resolve(workspace, PLUGINS_DIR)
}

export function assertPluginId(value: string): string {
  const id = String(value ?? '').trim()
  if (!ID_PATTERN.test(id)) {
    throw new Error('插件 id 需为 2-32 位小写字母、数字或短横线，且以字母开头')
  }
  return id
}

/** `<workspace>/.pilot/plugins/<id>`, refusing anything that escapes the root. */
export function pluginDirFor(workspace: string, id: string): string {
  const root = pluginsRoot(workspace)
  const dir = resolve(root, assertPluginId(id))
  if (!dir.startsWith(root + sep)) throw new Error('插件目录越界')
  return dir
}

async function readGrants(workspace: string): Promise<PluginGrants> {
  try {
    const parsed = JSON.parse(await readFile(join(pluginsRoot(workspace), GRANTS_FILE), 'utf8'))
    const record = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
    const grants: PluginGrants = {}
    for (const [id, value] of Object.entries(record)) {
      const entry = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
      grants[id] = {
        enabled: entry.enabled === true,
        permissions: Array.isArray(entry.permissions)
          ? entry.permissions.filter((item): item is string => typeof item === 'string')
          : [],
      }
    }
    return grants
  } catch {
    return {}
  }
}

async function writeGrants(workspace: string, grants: PluginGrants): Promise<void> {
  await mkdir(pluginsRoot(workspace), { recursive: true })
  await writeFile(
    join(pluginsRoot(workspace), GRANTS_FILE),
    `${JSON.stringify(grants, null, 2)}\n`,
    'utf8',
  )
}

function toSignatureView(signature: PluginSignature): PluginSignatureView {
  return {
    state: signature.state,
    policy: signature.policy,
    digest: signature.digest,
    keyId: signature.keyId,
    label: signature.label,
    detail: signature.detail,
  }
}

async function readManifestFrom(dir: string): Promise<PluginManifest> {
  let raw: string
  try {
    raw = await readFile(join(dir, PLUGIN_MANIFEST_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`目录里没有 ${PLUGIN_MANIFEST_FILE}`)
    }
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`${PLUGIN_MANIFEST_FILE} 不是合法 JSON`)
  }
  return parsePluginManifest(parsed)
}

function templateViews(): PluginTemplateView[] {
  return PLUGIN_TEMPLATES.map((template) => ({
    id: template.id,
    name: template.name,
    summary: template.summary,
    permissions: template.permissions,
    providesSession: template.provides === 'session',
    routeCount: template.routes.length,
  }))
}

/** Everything the Plugins panel needs, in one round trip. */
export async function pluginOverview(workspace: string): Promise<PluginOverview> {
  const root = resolve(workspace)
  const grants = await readGrants(root)
  const store = await readTrustStore(root)
  const policy = await readSignaturePolicy(root)
  const loaded = await loadPluginManifests(root)

  const plugins: PluginRecordView[] = []
  const invalid: { id: string; error: string }[] = []
  for (const entry of loaded) {
    if (!entry.manifest) {
      invalid.push({ id: entry.id, error: entry.error ?? '无法读取 plugin.json' })
      continue
    }
    const manifest = entry.manifest
    const signature = await assessPluginSignature(entry.dir, manifest, store, policy)
    plugins.push({
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      dir: entry.dir,
      entry: manifest.entry,
      permissions: manifest.permissions,
      roles: manifest.roles,
      routes: manifest.routes,
      providesSession: manifest.provides === 'session',
      enabled: grants[manifest.id]?.enabled === true,
      granted: grants[manifest.id]?.permissions ?? [],
      signature: toSignatureView(signature),
      error: null,
    })
  }
  plugins.sort((left, right) => left.id.localeCompare(right.id))

  const trustedKeys: PluginTrustedKeyView[] = store.keys.map((key) => ({
    keyId: key.keyId,
    label: key.label,
    addedAt: key.addedAt,
    publicKey: key.publicKey,
    pluginIds: plugins
      .filter((plugin) => plugin.signature?.keyId === key.keyId)
      .map((plugin) => plugin.id),
  }))

  return {
    workspace: root,
    pluginsDir: pluginsRoot(root),
    plugins,
    invalid,
    market: MARKET.map((item) => ({
      ...item,
      installed: plugins.some((plugin) => plugin.id === item.id),
    })),
    trustedKeys,
    policy,
    templates: templateViews(),
    maxPlugins: MAX_PLUGINS,
  }
}

function manifestFor(
  template: PluginTemplate,
  input: { id: string; name: string; description: string },
): Record<string, unknown> {
  const namespaces = [...new Set(template.permissions.map((item) => item.split(':')[0]))]
  return {
    id: input.id,
    name: input.name,
    version: 1,
    api: PLUGIN_API_VERSION,
    runtime: 'node',
    entry: 'index.mjs',
    description: input.description,
    provides: template.provides,
    permissions: template.permissions,
    roles: [
      { id: 'owner', permissions: namespaces.map((name) => `${name}:*`) },
      { id: 'member', permissions: [] },
    ],
    routes: template.routes,
    limits: { timeoutMs: 5000, rateLimitPerMinute: 60, maxBodyBytes: 65536 },
  }
}

function readmeFor(manifest: Record<string, unknown>, template: PluginTemplate): string {
  const id = String(manifest.id)
  return [
    `# ${String(manifest.name)}`,
    '',
    String(manifest.description || template.about),
    '',
    '## 这个插件做什么',
    '',
    template.about,
    '',
    '## 文件',
    '',
    '- `plugin.json`：清单（id、权限、路由、限额）',
    '- `index.mjs`：入口，按行收发 JSON-RPC，不进入宿主进程',
    '- `.keys/`：签名私钥，**不要提交**（`.gitignore` 已忽略）',
    '',
    '## 开发',
    '',
    '```bash',
    `pilot plugin verify ${id}    # 校验签名与文件一致性`,
    `pilot plugin sign ${id}      # 改动后重新签名`,
    '```',
    '',
    '安装：把整个目录导入 Pilot 的插件市场面板，或复制到',
    '`<workspace>/.pilot/plugins/<id>/` 后勾选启用。',
    '',
  ].join('\n')
}

/** Writes the scaffold. The caller has already checked the directory is empty. */
async function writeScaffold(
  dir: string,
  input: { id: string; name: string; description: string; template: PluginTemplateId },
): Promise<string[]> {
  const template = findTemplate(input.template)
  const manifest = manifestFor(template, input)
  const files: { name: string; data: string }[] = [
    { name: PLUGIN_MANIFEST_FILE, data: `${JSON.stringify(manifest, null, 2)}\n` },
    { name: 'index.mjs', data: template.entry },
    { name: 'README.md', data: readmeFor(manifest, template) },
    { name: '.gitignore', data: ['.keys/', 'node_modules/', '.state/', ''].join('\n') },
  ]
  for (const file of files) await writeFile(join(dir, file.name), file.data, 'utf8')
  return files.map((file) => file.name)
}

async function assertEmptyTarget(dir: string): Promise<void> {
  if (!existsSync(dir)) return
  const info = await stat(dir)
  if (!info.isDirectory()) throw new Error('选中的路径不是目录')
  const entries = await readdir(dir)
  if (entries.includes(PLUGIN_MANIFEST_FILE)) {
    throw new Error('该目录里已经有 plugin.json，请换一个空目录，或先移走旧插件')
  }
  if (entries.length > 0) {
    throw new Error('该目录不是空目录，请选择一个空目录，避免覆盖已有文件')
  }
}

interface LocalKey {
  privateKeyFile: string
  publicKeyFile: string
  privateKey: string
  publicKey: string
  keyId: string
}

/**
 * Writes an ed25519 key pair through the shared integrity helper, so the
 * `keyId` is derived exactly the way `pilot plugin keygen` derives it.
 */
async function writeKeyPair(keyDir: string, slug: string): Promise<LocalKey> {
  const pair = generateSigningKey()
  await mkdir(keyDir, { recursive: true })
  const privateKeyFile = join(keyDir, `${slug}.private.pem`)
  const publicKeyFile = join(keyDir, `${slug}.public.pem`)
  await writeFile(privateKeyFile, pair.privateKey, { encoding: 'utf8', mode: 0o600 })
  await writeFile(publicKeyFile, pair.publicKey, 'utf8')
  return {
    privateKeyFile,
    publicKeyFile,
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    keyId: pair.keyId,
  }
}

/** Scaffold a plugin into a directory the user picked. */
export async function createPlugin(input: CreatePluginOptions): Promise<PluginCreateResult> {
  const id = assertPluginId(input.id)
  const name = String(input.name ?? '').trim()
  if (name.length < 2 || name.length > 60) throw new Error('插件名称需为 2-60 个字符')
  if (!input.targetDir || !String(input.targetDir).trim()) throw new Error('请先选择插件创建目录')
  const targetDir = resolve(String(input.targetDir).trim())
  await assertEmptyTarget(targetDir)
  await mkdir(targetDir, { recursive: true })

  const description = String(input.description ?? '').trim().slice(0, 400)
  const files = await writeScaffold(targetDir, { id, name, description, template: input.template })

  if (!input.sign) {
    return {
      dir: targetDir,
      id,
      files,
      signed: false,
      keyId: null,
      publicKey: null,
      privateKeyFile: null,
      publicKeyFile: null,
      signature: null,
    }
  }

  const key = await writeKeyPair(join(targetDir, '.keys'), id)
  const manifest = await readManifestFrom(targetDir)
  // `signPluginDir` only computes the signature; writing plugin.sig is a
  // separate step so a caller can inspect the digest before committing.
  const signatureFile = await signPluginDir(targetDir, manifest, key.privateKey)
  await writePluginSignature(targetDir, signatureFile)
  files.push(`.keys/${id}.private.pem`, `.keys/${id}.public.pem`, 'plugin.sig')
  return {
    dir: targetDir,
    id,
    files,
    signed: true,
    keyId: signatureFile.keyId,
    publicKey: key.publicKey,
    privateKeyFile: key.privateKeyFile,
    publicKeyFile: key.publicKeyFile,
    signature: toSignatureView(
      await assessPluginSignature(targetDir, manifest, { keys: [] }, 'off'),
    ),
  }
}

async function measure(dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0
  let bytes = 0
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (SKIP_COPY.has(entry.name)) continue
      const path = join(current, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) {
        files += 1
        bytes += (await stat(path)).size
      }
    }
  }
  await walk(dir)
  return { files, bytes }
}

async function publicKeyFromSource(sourceDir: string, keyId: string | null): Promise<string | null> {
  const keyDir = join(sourceDir, '.keys')
  if (!existsSync(keyDir)) return null
  for (const name of await readdir(keyDir)) {
    if (!/\.(pem|pub)$/i.test(name)) continue
    try {
      const pem = await readFile(join(keyDir, name), 'utf8')
      if (!keyId || keyIdForPublicKey(pem) === keyId) return pem
    } catch {
      // Not a usable PEM file; keep looking.
    }
  }
  return null
}

/** Copy a plugin directory into `<workspace>/.pilot/plugins/<id>`. */
export async function installPlugin(options: InstallPluginOptions): Promise<PluginInstallResult> {
  const workspace = resolve(options.workspace)
  const sourceDir = resolve(String(options.sourceDir ?? '').trim())
  if (!sourceDir) throw new Error('请先选择要导入的插件目录')
  if (!existsSync(sourceDir)) throw new Error('选择的插件目录不存在')
  const manifest = await readManifestFrom(sourceDir)
  if (!existsSync(join(sourceDir, manifest.entry))) {
    throw new Error(`清单里的入口文件不存在：${manifest.entry}`)
  }

  const existing = await loadPluginManifests(workspace)
  const clash = existing.some((entry) => entry.id === manifest.id)
  if (clash && !options.force) {
    throw new Error(`工作区里已安装 ${manifest.id}；重新导入时请选择覆盖`)
  }
  if (!clash && existing.length >= MAX_PLUGINS) {
    throw new Error(`一个工作区最多 ${MAX_PLUGINS} 个插件，请先卸载不用的插件`)
  }

  const { files, bytes } = await measure(sourceDir)
  if (files > MAX_INSTALL_FILES) throw new Error(`插件文件过多（${files} > ${MAX_INSTALL_FILES}）`)
  if (bytes > MAX_INSTALL_BYTES) throw new Error('插件体积超过 8 MB，请先清理构建产物')

  const dest = pluginDirFor(workspace, manifest.id)
  if (existsSync(dest)) await rm(dest, { recursive: true, force: true })
  await mkdir(dest, { recursive: true })
  await cp(sourceDir, dest, {
    recursive: true,
    filter: (source) => {
      const name = source.split(/[\\/]/).pop() ?? ''
      return !SKIP_COPY.has(name)
    },
  })

  const policy = await readSignaturePolicy(workspace)
  let store = await readTrustStore(workspace)
  let signature = await assessPluginSignature(dest, manifest, store, policy)

  let trustedKey: PluginTrustedKeyView | null = null
  if (options.trust) {
    const pem =
      String(options.publicKey ?? '').trim() ||
      (await publicKeyFromSource(sourceDir, signature.keyId))
    if (!pem) {
      throw new Error('插件目录里没有可用公钥，请先粘贴供应商的公钥再信任')
    }
    const key = await addTrustedKey(workspace, pem, options.label || `${manifest.name}（导入）`)
    trustedKey = {
      keyId: key.keyId,
      label: key.label,
      addedAt: key.addedAt,
      publicKey: key.publicKey,
      pluginIds: [manifest.id],
    }
    store = await readTrustStore(workspace)
    signature = await assessPluginSignature(dest, manifest, store, policy)
  }

  return { id: manifest.id, dir: dest, signature: toSignatureView(signature), trustedKey }
}

/** Install one curated market entry: scaffold + sign + trust with a local key. */
export async function installMarketPlugin(
  workspace: string,
  id: string,
): Promise<PluginInstallResult> {
  const root = resolve(workspace)
  const item = MARKET.find((entry) => entry.id === id)
  if (!item) throw new Error(`市场里没有 ${id}`)
  const existing = await loadPluginManifests(root)
  if (existing.some((entry) => entry.id === item.id)) {
    throw new Error(`工作区里已安装 ${item.id}`)
  }
  if (existing.length >= MAX_PLUGINS) {
    throw new Error(`一个工作区最多 ${MAX_PLUGINS} 个插件，请先卸载不用的插件`)
  }
  const dest = pluginDirFor(root, item.id)
  await mkdir(dest, { recursive: true })
  await writeScaffold(dest, {
    id: item.id,
    name: item.name,
    description: item.summary,
    template: item.template,
  })
  const signed = await signInstalledPlugin(root, item.id)
  return {
    id: item.id,
    dir: dest,
    signature: toSignatureView(signed.signature),
    trustedKey: {
      keyId: signed.key.keyId,
      label: signed.key.label,
      addedAt: signed.key.addedAt,
      publicKey: signed.key.publicKey,
      pluginIds: [item.id],
    },
  }
}

/** Sign an installed plugin with this workspace's own key and trust that key. */
export async function signInstalledPlugin(
  workspace: string,
  id: string,
): Promise<{ signature: PluginSignature; publicKey: string; key: TrustedKey }> {
  const dir = pluginDirFor(workspace, id)
  const manifest = await readManifestFrom(dir)
  const keyDir = join(workspace, '.pilot', 'keys')
  const privateKeyFile = join(keyDir, `${LOCAL_KEY_SLUG}.private.pem`)
  let privateKey: string
  let publicKey: string
  if (existsSync(privateKeyFile)) {
    privateKey = await readFile(privateKeyFile, 'utf8')
    publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString()
  } else {
    const pair = await writeKeyPair(keyDir, LOCAL_KEY_SLUG)
    privateKey = pair.privateKey
    publicKey = pair.publicKey
  }
  await writePluginSignature(dir, await signPluginDir(dir, manifest, privateKey))
  const key = await addTrustedKey(workspace, publicKey, LOCAL_KEY_LABEL)
  const store = await readTrustStore(workspace)
  const policy = await readSignaturePolicy(workspace)
  const signature = await assessPluginSignature(dir, manifest, store, policy)
  return { signature, publicKey, key }
}

/** Remove a plugin directory and its grant. */
export async function removePlugin(workspace: string, id: string): Promise<void> {
  const dir = pluginDirFor(workspace, id)
  if (!existsSync(dir)) throw new Error(`没有已安装的插件 ${id}`)
  await rm(dir, { recursive: true, force: true })
  const grants = await readGrants(workspace)
  if (grants[id]) {
    delete grants[id]
    await writeGrants(workspace, grants)
  }
}

/** The user-approval step: enabled flag plus the granted permissions. */
export async function setPluginEnabled(
  workspace: string,
  id: string,
  enabled: boolean,
): Promise<void> {
  const dir = pluginDirFor(workspace, id)
  if (!existsSync(dir)) throw new Error(`没有已安装的插件 ${id}`)
  const manifest = await readManifestFrom(dir)
  if (enabled) {
    const policy = await readSignaturePolicy(workspace)
    const store = await readTrustStore(workspace)
    const signature = await assessPluginSignature(dir, manifest, store, policy)
    if (policy === 'required' && signature.state !== 'trusted') {
      throw new Error(
        `签名策略是 required，但 ${id} 当前状态是 ${signature.state}；请先信任签名密钥或重新签名`,
      )
    }
  }
  const grants = await readGrants(workspace)
  grants[id] = { enabled, permissions: enabled ? manifest.permissions.slice() : [] }
  await writeGrants(workspace, grants)
}

export async function setSignaturePolicy(
  workspace: string,
  policy: PluginSignaturePolicy,
): Promise<void> {
  if (policy !== 'off' && policy !== 'warn' && policy !== 'required') {
    throw new Error('签名策略只能是 off、warn 或 required')
  }
  await writeSignaturePolicy(workspace, policy as SignaturePolicy)
}

export async function trustPublicKey(
  workspace: string,
  publicKey: string,
  label?: string,
): Promise<TrustedKey> {
  const pem = String(publicKey ?? '').trim()
  if (!pem.includes('BEGIN PUBLIC KEY')) {
    throw new Error('请粘贴 PEM 格式的公钥（-----BEGIN PUBLIC KEY----- 开头）')
  }
  return addTrustedKey(workspace, pem, label?.trim() || undefined)
}

export async function untrustPublicKey(workspace: string, keyId: string): Promise<void> {
  const removed = await removeTrustedKey(workspace, String(keyId ?? '').trim())
  if (!removed) throw new Error(`信任库里没有 ${keyId}`)
}
