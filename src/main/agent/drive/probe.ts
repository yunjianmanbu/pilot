import { access, readFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { listAppTargets } from '../app-control'
import { runCommand } from '../../workspace'
import { listRecipes } from './recipes'
import type {
  DriveFingerprint,
  DriveHints,
  DriveKind,
  DriveProbeContext,
  DriveProbeResult,
  DriveSurface,
  DriveSurfaceReport,
} from './types'

/**
 * Probe before acting. The goal is to describe every interface the app could
 * expose, name the failures that would force a switch, and recommend a
 * fallback order. It never mutates the app and never guesses success: a
 * surface is "available" only when a real check proved it.
 */
const CDP_SCAN_PORTS = [9_222, 9_223, 9_224, 9_225, 9_226, 9_227, 9_228, 9_229, 9_230, 9_231, 9_232]
const WEB_DEPS = ['react', 'react-dom', 'vue', 'svelte', 'next', 'vite', '@vitejs/plugin-react', 'nuxt']

interface PackageInfo {
  dependencies: Set<string>
  scripts: Record<string, string>
}

async function readPackage(root: string): Promise<PackageInfo> {
  const empty: PackageInfo = { dependencies: new Set(), scripts: {} }
  try {
    const raw = await readFile(join(root, 'package.json'), 'utf8')
    if (raw.length > 512 * 1024) return empty
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty
    const record = parsed as Record<string, unknown>
    const dependencies = new Set<string>()
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
      const group = record[field]
      if (!group || typeof group !== 'object' || Array.isArray(group)) continue
      for (const name of Object.keys(group)) dependencies.add(name)
    }
    const scripts: Record<string, string> = {}
    if (record['scripts'] && typeof record['scripts'] === 'object') {
      for (const [name, value] of Object.entries(record['scripts'] as Record<string, unknown>)) {
        if (typeof value === 'string') scripts[name] = value
      }
    }
    return { dependencies, scripts }
  } catch {
    return empty
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function topLevelNames(root: string): Promise<Set<string>> {
  try {
    return new Set(await readdir(root))
  } catch {
    return new Set()
  }
}

function fingerprint(kind: DriveKind, markers: string[]): DriveFingerprint {
  const unique = [...new Set(markers)].sort()
  return {
    kind,
    markers: unique,
    key: `${kind}:${createHash('sha256').update(unique.join('|')).digest('hex').slice(0, 12)}`,
  }
}

export async function detectFingerprint(
  root: string,
  hints: { url?: string; command?: string; processName?: string; kind?: DriveKind },
): Promise<DriveFingerprint> {
  const pkg = await readPackage(root)
  const names = await topLevelNames(root)
  const markers: string[] = []
  let kind: DriveKind = 'unknown'

  const electronMarkers = ['electron', 'electron-builder', 'electron-vite', 'electron-updater'].filter(
    (name) => pkg.dependencies.has(name),
  )
  const tauriMarkers = ['@tauri-apps/api', '@tauri-apps/cli'].filter((name) => pkg.dependencies.has(name))
  const androidMarkers = ['react-native', 'expo', '@capacitor/core', 'cordova'].filter((name) =>
    pkg.dependencies.has(name),
  )
  const webMarkers = WEB_DEPS.filter((name) => pkg.dependencies.has(name))

  if (electronMarkers.length > 0) {
    kind = 'electron'
    markers.push(...electronMarkers.map((name) => `package.json:${name}`))
  }
  if (tauriMarkers.length > 0 || names.has('src-tauri')) {
    if (kind === 'unknown') kind = 'tauri'
    markers.push(...tauriMarkers.map((name) => `package.json:${name}`))
    if (names.has('src-tauri')) markers.push('src-tauri/')
  }
  if (
    androidMarkers.length > 0 ||
    names.has('android') ||
    names.has('ios') ||
    names.has('capacitor.config.ts') ||
    names.has('capacitor.config.json')
  ) {
    if (kind === 'unknown') kind = 'android'
    markers.push(...androidMarkers.map((name) => `package.json:${name}`))
    if (names.has('android')) markers.push('android/')
    if (names.has('capacitor.config.ts') || names.has('capacitor.config.json')) {
      markers.push('capacitor.config')
    }
  }
  if (kind === 'unknown' && webMarkers.length > 0) {
    kind = 'web'
    markers.push(...webMarkers.map((name) => `package.json:${name}`))
  }
  if (kind === 'unknown' && names.has('index.html')) {
    kind = 'web'
    markers.push('index.html')
  }
  if (kind === 'unknown' && hints.url) {
    kind = 'http'
    markers.push(`url:${hints.url.slice(0, 80)}`)
  }
  if (kind === 'unknown' && hints.command) {
    kind = 'http'
    markers.push(`command:${hints.command.slice(0, 80)}`)
  }
  // A process hint describes the app being driven, while the workspace may be
  // unrelated (driving Notepad from a JS project). It only decides the kind
  // when no project marker already did.
  if (kind === 'unknown' && hints.processName) {
    kind = 'native'
    markers.push(`process:${hints.processName.slice(0, 80)}`)
  }
  // The workspace markers describe the project, not necessarily the app being
  // driven. An explicit kind (for an external native app, say) is authoritative
  // and changes the fingerprint key so recipes do not cross targets.
  if (hints.kind) {
    kind = hints.kind
    markers.push(`override:${hints.kind}`)
  }
  if (markers.length === 0) markers.push('no-known-markers')
  return fingerprint(kind, markers)
}

async function probeCdp(
  hints: DriveHints,
  fp: DriveFingerprint,
): Promise<{ report: DriveSurfaceReport; port?: number; targets: string[] }> {
  const requested = hints.port
  const envPort = Number(process.env['PILOT_DEBUG_PORT'])
  const ports = [...new Set([
    ...(requested ? [requested] : []),
    ...(Number.isInteger(envPort) && envPort > 0 ? [envPort] : []),
    ...CDP_SCAN_PORTS,
  ])]
  const results = await Promise.all(
    ports.map(async (port) => {
      try {
        const targets = await listAppTargets(port, 400)
        return { port, targets }
      } catch {
        return { port, targets: [] }
      }
    }),
  )
  const hit = results.find((result) => result.targets.length > 0)
  const enableHint =
    fp.kind === 'electron'
      ? 'Restart the app with --remote-debugging-port=9222 (pass it in start_process args).'
      : fp.kind === 'tauri'
        ? 'Restart with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 (WebView2 forwards Chromium flags).'
        : 'Launch the Chromium/Electron app with --remote-debugging-port=9222.'
  if (!hit) {
    return {
      report: {
        surface: 'cdp',
        available: false,
        evidence: requested
          ? `No DevTools endpoint on 127.0.0.1:${requested}.`
          : `No DevTools endpoint on the scanned ports (${CDP_SCAN_PORTS[0]}-${CDP_SCAN_PORTS.at(-1)}).`,
        how: 'Start the app with --remote-debugging-port, then use drive_run surface cdp.',
        enableHint,
        limitations: 'Full JS/input control, but only for Chromium/Electron/WebView2.',
      },
      targets: [],
    }
  }
  const targetLines = hit.targets
    .slice(0, 5)
    .map((target) => `${target.title || '(untitled)'} [${target.id}]`)
  return {
    report: {
      surface: 'cdp',
      available: true,
      evidence: `DevTools on 127.0.0.1:${hit.port}: ${targetLines.join(' | ')}`,
      how: `drive_run with surface cdp (port ${hit.port}); app_targets/app_control also work directly.`,
      limitations: 'Only Chromium-based targets. Requires the debugging port at launch.',
    },
    port: hit.port,
    targets: targetLines,
  }
}

async function probeHttp(hints: DriveHints, pkg: PackageInfo): Promise<DriveSurfaceReport> {
  if (!hints.url) {
    const devScript = pkg.scripts['dev'] ?? pkg.scripts['start'] ?? pkg.scripts['serve']
    return {
      surface: 'http',
      available: false,
      evidence: devScript
        ? `package.json has a dev script ("${devScript.slice(0, 80)}") but no url was given to probe.`
        : 'No url was given to probe.',
      how: 'Start the server with start_process, then call drive_probe with its url and drive_run with http steps.',
      enableHint: devScript ? 'Start it with start_process, then pass the served url.' : undefined,
      limitations: 'Assertions only; it cannot click or type in a GUI.',
    }
  }
  const startedAt = Date.now()
  try {
    const response = await fetch(hints.url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(2_000),
    })
    return {
      surface: 'http',
      available: true,
      evidence: `GET ${hints.url} returned HTTP ${response.status} in ${Date.now() - startedAt}ms.`,
      how: 'drive_run with http steps (method/url/expectStatus/expectBody) or assertText on the last response.',
      limitations: 'Assertions only; it cannot click or type in a GUI.',
    }
  } catch (error) {
    return {
      surface: 'http',
      available: false,
      evidence: `GET ${hints.url} failed: ${error instanceof Error ? error.message : String(error)}`,
      how: 'Start the server first, then re-probe.',
      limitations: 'Assertions only; it cannot click or type in a GUI.',
    }
  }
}

async function probePlaywright(root: string, pkg: PackageInfo): Promise<DriveSurfaceReport> {
  const hasDependency =
    pkg.dependencies.has('@playwright/test') ||
    pkg.dependencies.has('playwright') ||
    pkg.dependencies.has('playwright-core')
  const binary = await exists(join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'playwright.cmd' : 'playwright'))
  const available = hasDependency || binary
  return {
    surface: 'playwright',
    available,
    evidence: available
      ? `Playwright is installed${hasDependency ? ' in package.json' : ''}${binary ? ' with a local binary' : ''}.`
      : 'No Playwright dependency or local binary found.',
    how: 'Use run_e2e with a spec file. drive_run treats playwright as a capability note, not a step surface.',
    limitations: 'Requires a project test suite; not a generic driver for an arbitrary app.',
  }
}

async function probeCli(root: string): Promise<DriveSurfaceReport> {
  return {
    surface: 'cli',
    available: true,
    evidence: 'run_command is available; cli steps execute in the workspace jail with a bounded output buffer.',
    how: 'drive_run with cli steps (command/args/expectExit/expectOutput) or assertText on the last stdout.',
    limitations: 'Only for apps that expose a CLI; it cannot see a GUI.',
  }
}

async function probeUia(root: string, signal: AbortSignal): Promise<DriveSurfaceReport> {
  if (process.platform !== 'win32') {
    return {
      surface: 'uia',
      available: false,
      evidence: `Windows UI Automation is not available on ${process.platform}.`,
      how: 'Use the platform accessibility API through a dynamic tool.',
      enableHint: 'Windows only.',
      limitations: 'Platform-specific.',
    }
  }
  const version = await runCommand(
    root,
    {
      command: 'powershell',
      args: ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'],
      timeoutMs: 3_000,
    },
    signal,
  ).catch(() => null)
  const available = Boolean(version?.ok)
  return {
    surface: 'uia',
    available,
    evidence: available
      ? `PowerShell ${version?.output.trim() || ''} is available for UI Automation.`
      : 'PowerShell is not available, so Windows UI Automation cannot be used.',
    how: 'drive_run with uia steps: read (dump control names), invoke (press by name), setText (by name).',
    enableHint: available ? undefined : 'Install PowerShell / enable Windows UI Automation.',
    limitations:
      'Requires the app to expose an accessibility tree; control names must match exactly. Actions are not covered by the unit suite.',
  }
}

export async function probeAdb(root: string, signal: AbortSignal): Promise<DriveSurfaceReport> {
  const version = await runCommand(
    root,
    { command: 'adb', args: ['version'], timeoutMs: 3_000 },
    signal,
  ).catch(() => null)
  if (!version?.ok) {
    return {
      surface: 'adb',
      available: false,
      evidence: 'adb is not available on PATH.',
      how: 'Install Android platform-tools, connect a device, then use drive_run adb steps.',
      enableHint: 'Install adb (Android platform-tools).',
      limitations: 'Android only.',
    }
  }
  const devices = await runCommand(
    root,
    { command: 'adb', args: ['devices'], timeoutMs: 3_000 },
    signal,
  ).catch(() => null)
  const lines = (devices?.output ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('List of devices') && !line.startsWith('*'))
  const attached = lines.filter((line) => line.endsWith('\tdevice') || /\sdevice$/.test(line))
  return {
    surface: 'adb',
    available: attached.length > 0,
    evidence:
      attached.length > 0
        ? `adb ${version.output.trim().split(/\r?\n/)[0] ?? ''}; devices: ${attached.join(' | ')}`
        : `adb is installed but no device is attached (${devices?.output.trim().slice(0, 160) || 'no output'}).`,
    how: 'drive_run with adb steps: dump (uiautomator XML), tap (x/y), text, shell.',
    enableHint: attached.length > 0 ? undefined : 'Connect a device or start an emulator.',
    limitations: 'Android only; screenshot is not exposed as an image through adb in this version.',
  }
}

function probeScreenshot(ctx: DriveProbeContext): DriveSurfaceReport {
  return {
    surface: 'screenshot',
    available: ctx.canScreenshot,
    evidence: ctx.canScreenshot
      ? 'Pilot can capture a single desktop window and attach it as an image observation.'
      : 'Screenshot capture is not available in this context.',
    how: 'Use a screenshot step (optionally windowTitle) or the screenshot tool with list_windows.',
    limitations: 'View-only: it cannot click, type or assert application state.',
  }
}

function probeCustom(ctx: DriveProbeContext): DriveSurfaceReport {
  return {
    surface: 'custom',
    available: ctx.canCustom,
    evidence: ctx.canCustom
      ? 'The dynamic tool registry is available, so a missing adapter can be written and tested.'
      : 'Dynamic tools are not available in this context.',
    how: 'Write a tool under .pilot/tools, register_tool it, then use drive_run step {do:"tool", tool:"name"}.',
    enableHint: ctx.canCustom
      ? 'Use the toolsmith subagent, then register_tool before referencing the tool in a recipe.'
      : 'Dynamic tools are disabled in this context.',
  }
}

function recommend(
  fp: DriveFingerprint,
  reports: DriveSurfaceReport[],
  ctx: DriveProbeContext,
): DriveProbeResult['recommendation'] {
  const available = new Set(reports.filter((report) => report.available).map((report) => report.surface))
  const preference: DriveSurface[] =
    fp.kind === 'android'
      ? ['adb', 'http', 'cli', 'screenshot', 'custom']
      : fp.kind === 'native'
        ? ['uia', 'cli', 'screenshot', 'custom']
        : fp.kind === 'http'
          ? ['http', 'cli', 'screenshot', 'custom']
          : ['cdp', 'http', 'cli', 'screenshot', 'custom']
  const fallbackOrder = preference.filter((surface) => available.has(surface))
  const primary: DriveSurface =
    fallbackOrder[0] ?? (ctx.canCustom ? 'custom' : ctx.canScreenshot ? 'screenshot' : 'custom')
  const actionable = fallbackOrder.some((surface) =>
    ['cdp', 'http', 'cli', 'uia', 'adb', 'custom'].includes(surface),
  )
  const selfExtend = actionable
    ? null
    : 'No actionable surface is available. Write a dynamic tool under .pilot/tools that speaks to this app, run its declared test, register_tool it, then use drive_run step {do:"tool"}.'
  const reason =
    fallbackOrder.length > 0
      ? `First available surface for a ${fp.kind} app: ${primary}. Fallback order: ${fallbackOrder.join(' -> ')}.`
      : `No surface is currently available for a ${fp.kind} app.`
  return { primary, fallbackOrder: fallbackOrder.length > 0 ? fallbackOrder : [primary], reason, selfExtend }
}

export async function probeTarget(
  hints: DriveHints,
  ctx: DriveProbeContext,
  signal: AbortSignal,
): Promise<DriveProbeResult> {
  const pkg = await readPackage(hints.root)
  const fp = await detectFingerprint(hints.root, {
    ...(hints.url ? { url: hints.url } : {}),
    ...(hints.command ? { command: hints.command } : {}),
    ...(hints.processName ? { processName: hints.processName } : {}),
    ...(hints.kind ? { kind: hints.kind } : {}),
  })
  // Probing adb and UI Automation costs a subprocess each. During drive_run
  // (no deep flag) only check them when the fingerprint suggests they matter;
  // drive_probe asks for the deep pass so its report is complete.
  const checkUia =
    ctx.deep === true || (process.platform === 'win32' && (fp.kind === 'native' || fp.kind === 'unknown'))
  const checkAdb = ctx.deep === true || fp.kind === 'android'
  const skipped = (surface: DriveSurface, reason: string): DriveSurfaceReport => ({
    surface,
    available: false,
    evidence: `Not checked: ${reason}.`,
    how: surface === 'adb' ? 'Call drive_probe to check adb and list devices.' : 'Call drive_probe to check Windows UI Automation.',
    limitations: surface === 'adb' ? 'Android only.' : 'Windows only; depends on the app accessibility tree.',
  })
  const [cdp, http, playwright, cli, uia, adb] = await Promise.all([
    probeCdp(hints, fp),
    probeHttp(hints, pkg),
    probePlaywright(hints.root, pkg),
    probeCli(hints.root),
    checkUia ? probeUia(hints.root, signal) : Promise.resolve(skipped('uia', `a ${fp.kind} fingerprint does not suggest a native Windows app`)),
    checkAdb ? probeAdb(hints.root, signal) : Promise.resolve(skipped('adb', `a ${fp.kind} fingerprint does not suggest an Android target`)),
  ])
  const reports: DriveSurfaceReport[] = [
    cdp.report,
    http,
    cli,
    playwright,
    uia,
    adb,
    probeScreenshot(ctx),
    probeCustom(ctx),
  ]
  const recipes = await listRecipes(hints.root, fp)
  return {
    fingerprint: fp,
    surfaces: reports,
    recommendation: recommend(fp, reports, ctx),
    recipes,
    ...(cdp.port ? { discoveredPort: cdp.port } : {}),
  }
}
