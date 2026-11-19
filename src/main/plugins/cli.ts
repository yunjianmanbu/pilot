import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
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
} from './integrity'
import {
  loadPluginManifests,
  PLUGIN_MANIFEST_FILE,
  PLUGINS_DIR,
  parsePluginManifest,
  type PluginManifest,
} from './manifest'
import { installSolution, loadSolutionPack, planSolution, verifySolutionLock } from './solution'

/**
 * `pilot plugin …` and `pilot solution …`.
 *
 * These commands exist so a business partner can ship code without a Pilot
 * release: generate a key pair, sign the plugin, hand the public key to the
 * customer, and let `pilot solution install` put the whole pack in place.
 * Everything is offline and self-signed.
 */

type FlagSpec = Record<string, 'string' | 'boolean'>

interface ParsedCommand {
  positionals: string[]
  flags: Record<string, string | boolean>
  errors: string[]
}

function parseCommandLine(argv: string[], spec: FlagSpec, aliases: Record<string, string> = {}): ParsedCommand {
  const positionals: string[] = []
  const flags: Record<string, string | boolean> = {}
  const errors: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === undefined) continue
    if (!arg.startsWith('-')) {
      positionals.push(arg)
      continue
    }
    const trimmed = arg.replace(/^--?/, '')
    const [rawName, inlineValue] = trimmed.includes('=')
      ? [trimmed.slice(0, trimmed.indexOf('=')), trimmed.slice(trimmed.indexOf('=') + 1)]
      : [trimmed, null]
    const name = aliases[rawName] ?? rawName
    const kind = spec[name]
    if (!kind) {
      errors.push(`无法识别的参数：${arg}`)
      continue
    }
    if (kind === 'boolean') {
      flags[name] = inlineValue === null ? true : inlineValue !== 'false'
      continue
    }
    if (inlineValue !== null) {
      flags[name] = inlineValue
      continue
    }
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('-')) {
      errors.push(`--${name} 需要一个值`)
      continue
    }
    flags[name] = next
    index += 1
  }
  return { positionals, flags, errors }
}

function workspaceOf(flags: Record<string, string | boolean>): string {
  const value = flags['workspace']
  return value ? resolve(String(value)) : process.cwd()
}

async function readManifest(dir: string): Promise<PluginManifest> {
  const raw = await readFile(join(dir, PLUGIN_MANIFEST_FILE), 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`${join(dir, PLUGIN_MANIFEST_FILE)} 不是合法 JSON`)
  }
  return parsePluginManifest(parsed)
}

function describe(signature: PluginSignature | null): string {
  if (!signature) return 'unknown'
  return signature.state
}

function signatureExitCode(signatures: PluginSignature[]): number {
  return signatures.some((signature) => signature.state !== 'trusted') ? 1 : 0
}

export interface PluginCliIo {
  out: (line: string) => void
  err: (line: string) => void
}

const defaultIo: PluginCliIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
}

async function pluginKeygen(argv: string[], io: PluginCliIo): Promise<number> {
  const parsed = parseCommandLine(argv, { label: 'string', out: 'string', workspace: 'string' })
  if (parsed.errors.length > 0) return fail(parsed.errors, io)
  const workspace = workspaceOf(parsed.flags)
  const outDir = parsed.flags['out']
    ? resolve(String(parsed.flags['out']))
    : join(workspace, '.pilot', 'keys')
  const label = parsed.flags['label'] ? String(parsed.flags['label']) : 'vendor'
  const slug =
    label
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'vendor'
  const pair = generateSigningKey()
  await mkdir(outDir, { recursive: true })
  const privateFile = join(outDir, `${slug}.private.pem`)
  const publicFile = join(outDir, `${slug}.public.pem`)
  await writeFile(privateFile, pair.privateKey, { encoding: 'utf8', mode: 0o600 })
  await writeFile(publicFile, pair.publicKey, 'utf8')
  io.out(`已生成 ed25519 密钥对（自签名，无需 CA）`)
  io.out(`  keyId:   ${pair.keyId}`)
  io.out(`  私钥:    ${privateFile}   ← 只留在自己手里，不要提交、不要发给客户`)
  io.out(`  公钥:    ${publicFile}`)
  io.out(`下一步：pilot plugin sign <插件目录> --key ${privateFile}`)
  return 0
}

async function signOne(
  dir: string,
  keyFile: string,
  io: PluginCliIo,
  workspace: string,
): Promise<PluginSignature> {
  const manifest = await readManifest(dir)
  const privateKey = await readFile(keyFile, 'utf8')
  const signature = await signPluginDir(dir, manifest, privateKey)
  await writePluginSignature(dir, signature)
  const trust = await readTrustStore(workspace)
  const state = await assessPluginSignature(dir, manifest, trust, 'warn')
  io.out(`已签名 ${manifest.id}`)
  io.out(`  digest: ${signature.digest}`)
  io.out(`  keyId:  ${signature.keyId}`)
  io.out(`  当前工作区状态: ${state.state}${state.state === 'untrusted' ? '（本地还没 trust 这把公钥）' : ''}`)
  return state
}

async function pluginSign(argv: string[], io: PluginCliIo): Promise<number> {
  const parsed = parseCommandLine(argv, {
    key: 'string',
    all: 'boolean',
    workspace: 'string',
  })
  if (parsed.errors.length > 0) return fail(parsed.errors, io)
  const keyFile = parsed.flags['key'] ? resolve(String(parsed.flags['key'])) : ''
  if (!keyFile) {
    io.err('需要 --key <私钥路径>；没有私钥就先跑 pilot plugin keygen')
    return 2
  }
  const dirs: string[] = []
  const workspace = workspaceOf(parsed.flags)
  if (parsed.flags['all']) {
    const discovered = await loadPluginManifests(workspace)
    for (const entry of discovered) if (entry.manifest) dirs.push(join(workspace, PLUGINS_DIR, entry.id))
    if (dirs.length === 0) {
      io.err(`${join(workspace, PLUGINS_DIR)} 下没有可签名的插件`)
      return 1
    }
  } else {
    const target = parsed.positionals[0]
    if (!target) {
      io.err('用法：pilot plugin sign <插件目录> --key <私钥> [--all]')
      return 2
    }
    dirs.push(resolve(target))
  }
  for (const dir of dirs) await signOne(dir, keyFile, io, workspace)
  return 0
}

async function pluginTrust(argv: string[], io: PluginCliIo): Promise<number> {
  const parsed = parseCommandLine(argv, { label: 'string', workspace: 'string' })
  if (parsed.errors.length > 0) return fail(parsed.errors, io)
  const target = parsed.positionals[0]
  if (!target) {
    io.err('用法：pilot plugin trust <公钥文件> [--label "供应商 2026"] [--workspace <dir>]')
    return 2
  }
  const pem = await readFile(resolve(target), 'utf8')
  const keyId = keyIdForPublicKey(pem)
  const key = await addTrustedKey(workspaceOf(parsed.flags), pem, parsed.flags['label'] ? String(parsed.flags['label']) : undefined)
  io.out(`已信任 ${key.label} (${keyId})`)
  io.out('该公钥签名、且签名后未被改动的插件才会被判为 trusted。')
  return 0
}

async function pluginUntrust(argv: string[], io: PluginCliIo): Promise<number> {
  const parsed = parseCommandLine(argv, { workspace: 'string' })
  if (parsed.errors.length > 0) return fail(parsed.errors, io)
  const keyId = parsed.positionals[0]
  if (!keyId) {
    io.err('用法：pilot plugin untrust <keyId> [--workspace <dir>]')
    return 2
  }
  const removed = await removeTrustedKey(workspaceOf(parsed.flags), keyId)
  if (!removed) {
    io.err(`信任库里没有 ${keyId}`)
    return 1
  }
  io.out(`已撤销 ${keyId}；用它签名的插件会变成 untrusted`)
  return 0
}

async function pluginPolicy(argv: string[], io: PluginCliIo): Promise<number> {
  const parsed = parseCommandLine(argv, { workspace: 'string' })
  if (parsed.errors.length > 0) return fail(parsed.errors, io)
  const workspace = workspaceOf(parsed.flags)
  const value = parsed.positionals[0]
  if (!value) {
    io.out(`当前策略：${await readSignaturePolicy(workspace)}`)
    io.out('取值：off | warn | required（required 时未签名插件不会被启动）')
    return 0
  }
  if (value !== 'off' && value !== 'warn' && value !== 'required') {
    io.err('策略只能是 off、warn 或 required')
    return 2
  }
  await writeSignaturePolicy(workspace, value as SignaturePolicy)
  io.out(`已把签名策略设为 ${value}`)
  return 0
}

async function pluginList(argv: string[], io: PluginCliIo): Promise<number> {
  const parsed = parseCommandLine(argv, { workspace: 'string' })
  if (parsed.errors.length > 0) return fail(parsed.errors, io)
  const workspace = workspaceOf(parsed.flags)
  const policy = await readSignaturePolicy(workspace)
  const trust = await readTrustStore(workspace)
  const discovered = await loadPluginManifests(workspace)
  io.out(`工作区: ${workspace}`)
  io.out(`签名策略: ${policy}    信任密钥: ${trust.keys.length}`)
  for (const entry of discovered) {
    if (!entry.manifest) {
      io.out(`  ${entry.id.padEnd(16)} invalid  ${entry.error ?? ''}`)
      continue
    }
    const signature = await assessPluginSignature(entry.dir, entry.manifest, trust, policy)
    io.out(
      `  ${entry.id.padEnd(16)} ${signature.state.padEnd(10)} ${signature.keyId ?? '-'}  ${signature.policy === 'required' && signature.state !== 'trusted' ? '会被拦截' : ''}`,
    )
  }
  if (discovered.length === 0) io.out(`  （${join(workspace, PLUGINS_DIR)} 下没有插件）`)
  return 0
}

async function pluginVerify(argv: string[], io: PluginCliIo): Promise<number> {
  const parsed = parseCommandLine(argv, { workspace: 'string' })
  if (parsed.errors.length > 0) return fail(parsed.errors, io)
  const workspace = workspaceOf(parsed.flags)
  const policy = await readSignaturePolicy(workspace)
  const trust = await readTrustStore(workspace)
  const target = parsed.positionals[0]
  const dirs: string[] = []
  if (target) {
    dirs.push(resolve(target))
  } else {
    for (const entry of await loadPluginManifests(workspace)) if (entry.manifest) dirs.push(entry.dir)
  }
  if (dirs.length === 0) {
    io.err('没有可校验的插件')
    return 1
  }
  const signatures: PluginSignature[] = []
  for (const dir of dirs) {
    const manifest = await readManifest(dir)
    const signature = await assessPluginSignature(dir, manifest, trust, policy)
    signatures.push(signature)
    io.out(`${manifest.id}: ${signature.state} — ${signature.detail}`)
  }
  const code = signatureExitCode(signatures)
  io.out(code === 0 ? 'RESULT PASS：全部 trusted' : 'RESULT FAIL：存在未签名/未信任/被改动的插件')
  return code
}

async function solutionPlan(argv: string[], io: PluginCliIo): Promise<number> {
  const parsed = parseCommandLine(argv, { workspace: 'string' })
  if (parsed.errors.length > 0) return fail(parsed.errors, io)
  const packDir = parsed.positionals[0]
  if (!packDir) {
    io.err('用法：pilot solution plan <方案包目录>')
    return 2
  }
  const plan = await planSolution(workspaceOf(parsed.flags), resolve(packDir))
  io.out(`方案包: ${plan.pack.name} (${plan.pack.id} v${plan.pack.version})`)
  io.out(`行业: ${plan.pack.industry}    供应商: ${plan.pack.vendor || '-'}    签名策略: ${plan.policy}`)
  if (plan.pack.description) io.out(`说明: ${plan.pack.description}`)
  for (const item of plan.items) {
    io.out(`\n  [${item.id}] ${item.signature?.state ?? 'no-manifest'}`)
    io.out(`    目录: ${item.dir}`)
    if (item.requestedPermissions.length > 0) {
      io.out(`    申请的权限: ${item.requestedPermissions.join(', ')}`)
    }
    for (const note of item.notes) io.out(`    ${note}`)
    for (const blocker of item.blockers) io.out(`    BLOCKER ${blocker}`)
  }
  if (plan.warnings.length > 0) {
    io.out('\n警告:')
    for (const warning of plan.warnings) io.out(`  - ${warning}`)
  }
  io.out(plan.ready ? '\nRESULT PASS：可以安装' : '\nRESULT FAIL：有阻塞项')
  return plan.ready ? 0 : 1
}

async function solutionInstall(argv: string[], io: PluginCliIo): Promise<number> {
  const parsed = parseCommandLine(argv, {
    workspace: 'string',
    'accept-permissions': 'boolean',
  })
  if (parsed.errors.length > 0) return fail(parsed.errors, io)
  const packDir = parsed.positionals[0]
  if (!packDir) {
    io.err('用法：pilot solution install <方案包目录> [--accept-permissions]')
    return 2
  }
  const result = await installSolution(workspaceOf(parsed.flags), resolve(packDir), {
    acceptPermissions: parsed.flags['accept-permissions'] === true,
  })
  io.out(`已安装方案包 ${result.solutionId}`)
  io.out(`  插件: ${result.installed.join(', ')}`)
  io.out(`  lock: ${result.lockPath}`)
  for (const warning of result.warnings) io.out(`  警告: ${warning}`)
  return 0
}

async function solutionVerify(argv: string[], io: PluginCliIo): Promise<number> {
  const parsed = parseCommandLine(argv, { workspace: 'string' })
  if (parsed.errors.length > 0) return fail(parsed.errors, io)
  const drift = await verifySolutionLock(workspaceOf(parsed.flags))
  if (!drift.found) {
    io.err('没有找到 solution.lock.json')
    return 1
  }
  io.out(`方案包 ${drift.solutionId} v${drift.version}`)
  for (const item of drift.items) {
    io.out(
      `  ${item.id.padEnd(16)} ${item.signature?.state ?? 'unknown'}${item.drift ? '  DRIFT（安装后被改动）' : ''}  ${item.detail}`,
    )
  }
  io.out(drift.drifted.length === 0 ? 'RESULT PASS：与安装时的签名一致' : `RESULT FAIL：${drift.drifted.join(', ')} 已偏离签名`)
  return drift.drifted.length === 0 ? 0 : 1
}

function fail(errors: string[], io: PluginCliIo): number {
  for (const error of errors) io.err(error)
  return 2
}

export async function runPluginCommand(
  command: string,
  argv: string[],
  io: PluginCliIo = defaultIo,
): Promise<number> {
  const [sub, ...rest] = argv
  try {
    if (command === 'plugin') {
      switch (sub) {
        case 'keygen':
          return await pluginKeygen(rest, io)
        case 'sign':
          return await pluginSign(rest, io)
        case 'trust':
          return await pluginTrust(rest, io)
        case 'untrust':
          return await pluginUntrust(rest, io)
        case 'policy':
          return await pluginPolicy(rest, io)
        case 'list':
          return await pluginList(rest, io)
        case 'verify':
          return await pluginVerify(rest, io)
        default:
          io.err('用法：pilot plugin <keygen|sign|trust|untrust|policy|list|verify> …')
          return 2
      }
    }
    if (command === 'solution') {
      switch (sub) {
        case 'plan':
          return await solutionPlan(rest, io)
        case 'install':
          return await solutionInstall(rest, io)
        case 'verify':
          return await solutionVerify(rest, io)
        case 'inspect': {
          const packDir = rest[0]
          if (!packDir) {
            io.err('用法：pilot solution inspect <方案包目录>')
            return 2
          }
          const pack = await loadSolutionPack(resolve(packDir))
          io.out(`${JSON.stringify(pack, null, 2)}`)
          return 0
        }
        default:
          io.err('用法：pilot solution <plan|install|verify|inspect> …')
          return 2
      }
    }
    io.err(`未知命令 ${command}`)
    return 2
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error))
    return 1
  }
}
