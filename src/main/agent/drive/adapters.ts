import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAppAction } from '../app-control'
import { runCommand } from '../../workspace'
import type {
  DriveHints,
  DriveStep,
  DriveStepDo,
  DriveSurface,
} from './types'

export interface AdapterState {
  lastHttpBody?: string
  lastHttpUrl?: string
  lastStdout?: string
  lastUiaText?: string
  lastAdbDump?: string
  lastToolOutput?: string
  images: string[]
}

export interface AdapterContext {
  root: string
  hints: DriveHints
  port?: number
  signal: AbortSignal
  screenshotDir?: string
  captureScreenshot?: (request: {
    target?: 'window' | 'screen'
    windowTitle?: string
    windowId?: string
    label?: string
    maxWidth?: number
  }) => Promise<{ ok: boolean; output: string; metadata?: Record<string, unknown> }>
  runDynamicTool?: (name: string, args: Record<string, unknown>) => Promise<{
    ok: boolean
    output: string
    error?: string
  }>
  state: AdapterState
}

export interface AdapterStepResult {
  ok: boolean
  output: string
  error?: string
  images?: string[]
}

const SUPPORT: Record<DriveSurface, Set<DriveStepDo>> = {
  cdp: new Set([
    'evaluate',
    'click',
    'type',
    'press',
    'wait',
    'screenshot',
    'console',
    'assertText',
    'assertValue',
  ]),
  http: new Set(['http', 'assertText', 'wait']),
  cli: new Set(['cli', 'assertText']),
  playwright: new Set(),
  uia: new Set(['uia', 'assertText']),
  adb: new Set(['adb', 'assertText']),
  screenshot: new Set(['screenshot']),
  custom: new Set(['tool', 'assertText']),
}

export function surfaceSupports(surface: DriveSurface, step: DriveStep): boolean {
  return SUPPORT[surface].has(step.do)
}

export function supportedStepKinds(surface: DriveSurface): DriveStepDo[] {
  return [...SUPPORT[surface]]
}

function requireString(value: string | undefined, field: string): string {
  if (!value || !value.trim()) throw new Error(`${field} is required for this step`)
  return value
}

function timeoutOf(step: DriveStep, fallback: number): number {
  const value = Number(step.timeoutMs)
  if (!Number.isFinite(value)) return fallback
  return Math.min(120_000, Math.max(500, Math.round(value)))
}

async function cdpStep(step: DriveStep, ctx: AdapterContext): Promise<AdapterStepResult> {
  const port = ctx.port ?? ctx.hints.port
  if (!port) throw new Error('No DevTools port is known; run drive_probe first or pass port')
  const saveDir = ctx.screenshotDir ?? join(tmpdir(), 'pilot-drive')
  const base = {
    port,
    saveDir,
    ...(ctx.hints.targetId ? { targetId: ctx.hints.targetId } : {}),
    ...(ctx.hints.targetTitle ? { targetTitle: ctx.hints.targetTitle } : {}),
    ...(ctx.hints.targetUrl ? { targetUrl: ctx.hints.targetUrl } : {}),
  }

  switch (step.do) {
    case 'evaluate': {
      const expression = requireString(step.expression, 'expression')
      const result = await runAppAction({ action: 'evaluate', expression, ...base })
      return { ok: true, output: result.output }
    }
    case 'click': {
      const selector = requireString(step.selector, 'selector')
      const result = await runAppAction({ action: 'click', selector, nth: step.nth, ...base })
      return { ok: true, output: result.output }
    }
    case 'type': {
      const selector = requireString(step.selector, 'selector')
      const result = await runAppAction({
        action: 'type',
        selector,
        nth: step.nth,
        text: step.text ?? '',
        clear: step.clear === true,
        ...base,
      })
      return { ok: true, output: result.output }
    }
    case 'press': {
      const result = await runAppAction({
        action: 'press',
        ...(step.selector ? { selector: step.selector } : {}),
        nth: step.nth,
        key: requireString(step.key, 'key'),
        ...base,
      })
      return { ok: true, output: result.output }
    }
    case 'wait': {
      const result = await runAppAction({
        action: 'wait',
        ...(step.selector ? { selector: step.selector } : {}),
        ...(step.expression ? { expression: step.expression } : {}),
        timeoutMs: timeoutOf(step, 5_000),
        ...base,
      })
      return { ok: true, output: result.output }
    }
    case 'console': {
      const result = await runAppAction({
        action: 'console',
        durationMs: step.durationMs,
        ...base,
      })
      return { ok: true, output: result.output }
    }
    case 'screenshot': {
      const result = await runAppAction({
        action: 'screenshot',
        ...(step.label ? { label: step.label } : {}),
        ...base,
      })
      return { ok: true, output: result.output, images: result.images ?? [] }
    }
    case 'assertText': {
      const text = step.text ?? step.expectText ?? ''
      if (!text) throw new Error('assertText needs text')
      const expression = step.selector
        ? `(() => { const el = document.querySelector(${JSON.stringify(step.selector)}); return el ? ((el.innerText || el.value || '').includes(${JSON.stringify(text)})) : false })()`
        : `document.body.innerText.includes(${JSON.stringify(text)})`
      const result = await runAppAction({ action: 'evaluate', expression, ...base })
      const ok = result.output.trim() === 'true'
      return {
        ok,
        output: ok ? `Found text: ${text}` : `Text not found: ${text}`,
        ...(ok ? {} : { error: `Text not found: ${text}` }),
      }
    }
    case 'assertValue': {
      const selector = requireString(step.selector, 'selector')
      const expected = step.value ?? step.text ?? ''
      const expression = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? (typeof el.value === 'string' ? el.value : el.textContent || '') : null })()`
      const result = await runAppAction({ action: 'evaluate', expression, ...base })
      const actual = result.output
      const ok = actual === expected || actual === JSON.stringify(expected)
      return {
        ok,
        output: ok ? `Value matches: ${expected}` : `Value mismatch. Expected ${JSON.stringify(expected)}, got ${actual}`,
        ...(ok ? {} : { error: `Value mismatch. Expected ${JSON.stringify(expected)}, got ${actual}` }),
      }
    }
    default:
      throw new Error(`cdp does not support step ${step.do}`)
  }
}

async function httpStep(step: DriveStep, ctx: AdapterContext): Promise<AdapterStepResult> {
  if (step.do === 'http') {
    const url = requireString(step.url ?? ctx.hints.url, 'url')
    const method = (step.method ?? 'GET').toUpperCase()
    const timeoutMs = timeoutOf(step, 15_000)
    const response = await fetch(url, {
      method,
      ...(step.headers ? { headers: step.headers } : {}),
      ...(method === 'GET' || method === 'HEAD' ? {} : { body: step.body ?? '' }),
      redirect: 'manual',
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]),
    })
    const body = await response.text().catch(() => '')
    ctx.state.lastHttpBody = body
    ctx.state.lastHttpUrl = url
    const expectedStatus = step.expectStatus
    const statusOk = expectedStatus
      ? response.status === expectedStatus
      : response.status >= 200 && response.status < 400
    if (!statusOk) {
      return {
        ok: false,
        output: body.slice(0, 1_500),
        error: `HTTP ${response.status} (expected ${expectedStatus ?? '2xx/3xx'}) from ${url}`,
      }
    }
    if (step.expectBody && !body.includes(step.expectBody)) {
      return {
        ok: false,
        output: body.slice(0, 1_500),
        error: `Response from ${url} does not contain ${JSON.stringify(step.expectBody)}`,
      }
    }
    return {
      ok: true,
      output: `HTTP ${response.status} ${method} ${url} (${body.length} chars)${
        step.expectBody ? `; body contains ${JSON.stringify(step.expectBody)}` : ''
      }`,
    }
  }

  if (step.do === 'assertText') {
    const text = step.text ?? step.expectText ?? ''
    if (!text) throw new Error('assertText needs text')
    if (ctx.state.lastHttpBody === undefined) {
      throw new Error('No HTTP response yet; put an http step before assertText')
    }
    const ok = ctx.state.lastHttpBody.includes(text)
    return {
      ok,
      output: ok ? `Found text in HTTP response: ${text}` : `Text not found in HTTP response: ${text}`,
      ...(ok ? {} : { error: `Text not found in HTTP response: ${text}` }),
    }
  }

  if (step.do === 'wait') {
    const url = step.url ?? ctx.state.lastHttpUrl ?? ctx.hints.url
    if (!url) throw new Error('wait needs a url for the http surface')
    const deadline = Date.now() + timeoutOf(step, 10_000)
    let last = ''
    while (Date.now() < deadline) {
      try {
        const response = await fetch(url, {
          method: 'GET',
          redirect: 'manual',
          signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(1_500)]),
        })
        const body = await response.text().catch(() => '')
        const statusOk = step.expectStatus ? response.status === step.expectStatus : response.status < 500
        const bodyOk = step.expectBody ? body.includes(step.expectBody) : true
        if (statusOk && bodyOk) {
          ctx.state.lastHttpBody = body
          ctx.state.lastHttpUrl = url
          return { ok: true, output: `HTTP ${response.status} from ${url}` }
        }
        last = `HTTP ${response.status}`
      } catch (error) {
        last = error instanceof Error ? error.message : String(error)
      }
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 250))
    }
    return { ok: false, output: last, error: `wait timed out for ${url}${last ? ` (${last})` : ''}` }
  }

  throw new Error(`http does not support step ${step.do}`)
}

async function cliStep(step: DriveStep, ctx: AdapterContext): Promise<AdapterStepResult> {
  if (step.do === 'cli') {
    const command = requireString(step.command, 'command')
    const result = await runCommand(
      ctx.root,
      {
        command,
        args: step.args ?? [],
        timeoutMs: timeoutOf(step, 120_000),
      },
      ctx.signal,
    )
    ctx.state.lastStdout = result.output
    const expectedExit = step.expectExit ?? 0
    if (result.exitCode !== expectedExit) {
      return {
        ok: false,
        output: result.output,
        error: `Command exited with ${result.exitCode ?? 'no code'} (expected ${expectedExit})`,
      }
    }
    if (step.expectOutput && !result.output.includes(step.expectOutput)) {
      return {
        ok: false,
        output: result.output,
        error: `Command output does not contain ${JSON.stringify(step.expectOutput)}`,
      }
    }
    return {
      ok: true,
      output: result.output,
    }
  }
  if (step.do === 'assertText') {
    const text = step.text ?? step.expectText ?? ''
    if (!text) throw new Error('assertText needs text')
    if (ctx.state.lastStdout === undefined) {
      throw new Error('No CLI output yet; put a cli step before assertText')
    }
    const ok = ctx.state.lastStdout.includes(text)
    return {
      ok,
      output: ok ? `Found text in CLI output: ${text}` : `Text not found in CLI output: ${text}`,
      ...(ok ? {} : { error: `Text not found in CLI output: ${text}` }),
    }
  }
  throw new Error(`cli does not support step ${step.do}`)
}

function uiaScript(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
  return [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName UIAutomationClient',
    'Add-Type -AssemblyName UIAutomationTypes',
    "Add-Type @'\nusing System;\nusing System.Runtime.InteropServices;\npublic static class PilotWin32 {\n  [DllImport(\"user32.dll\", CharSet=CharSet.Auto)] public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, string lParam);\n  [DllImport(\"user32.dll\")] public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);\n  [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd);\n  [DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int X, int Y);\n  [DllImport(\"user32.dll\")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);\n}\n'@",
    `$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json`,
    'function Write-Failure($message) { @{ ok = $false; error = [string]$message } | ConvertTo-Json -Compress -Depth 3; exit 0 }',
    '$root = [Windows.Automation.AutomationElement]::RootElement',
    '$condition = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty, [string]$payload.windowTitle)',
    '$window = $root.FindFirst([Windows.Automation.TreeScope]::Children, $condition)',
    'if ($null -eq $window) { $window = $root.FindFirst([Windows.Automation.TreeScope]::Descendants, $condition) }',
    'if ($null -eq $window) { Write-Failure "window not found" }',
    'try {',
    '  if ($payload.action -eq "read") {',
    '    $items = New-Object System.Collections.ArrayList',
    '    $all = $window.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)',
    '    foreach ($element in $all) {',
    '      $name = $element.Current.Name',
    '      $aid = $element.Current.AutomationId',
    '      if ($name -or $aid) {',
    '        [void]$items.Add([pscustomobject]@{ name = $name; type = $element.Current.ControlType.ProgrammaticName; automationId = $aid; className = $element.Current.ClassName })',
    '      }',
    '      if ($items.Count -ge 200) { break }',
    '    }',
    '    @{ ok = $true; elements = @($items) } | ConvertTo-Json -Compress -Depth 4',
    '    exit 0',
    '  }',
    '  if ($payload.automationId) {',
    '    $condition = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::AutomationIdProperty, [string]$payload.automationId)',
    '  } else {',
    '    $condition = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty, [string]$payload.name)',
    '  }',
    '  $element = $window.FindFirst([Windows.Automation.TreeScope]::Descendants, $condition)',
    '  if ($null -eq $element) { Write-Failure "control not found" }',
    '  if ($payload.action -eq "invoke") {',
    '    $pattern = $null',
    '    if ($element.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {',
    '      $pattern.Invoke()',
    '      @{ ok = $true; action = "invoke"; method = "InvokePattern"; name = [string]$payload.name } | ConvertTo-Json -Compress',
    '      exit 0',
    '    }',
    '    $hwnd = $element.Current.NativeWindowHandle',
    '    if ($hwnd -ne 0 -and $element.Current.ClassName -like "*BUTTON*") {',
    '      [void][PilotWin32]::SendMessage([IntPtr]$hwnd, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)',
    '      @{ ok = $true; action = "invoke"; method = "BM_CLICK"; name = [string]$payload.name } | ConvertTo-Json -Compress',
    '      exit 0',
    '    }',
    '    $rect = $element.Current.BoundingRectangle',
    '    if ($rect.Width -gt 0 -and $rect.Height -gt 0) {',
    '      $windowHwnd = $window.Current.NativeWindowHandle',
    '      if ($windowHwnd -ne 0) { [void][PilotWin32]::SetForegroundWindow([IntPtr]$windowHwnd) }',
    '      Start-Sleep -Milliseconds 120',
    '      [void][PilotWin32]::SetCursorPos([int]($rect.Left + $rect.Width / 2), [int]($rect.Top + $rect.Height / 2))',
    '      Start-Sleep -Milliseconds 80',
    '      [PilotWin32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)',
    '      [PilotWin32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)',
    '      @{ ok = $true; action = "invoke"; method = "mouse"; name = [string]$payload.name } | ConvertTo-Json -Compress',
    '      exit 0',
    '    }',
    '    Write-Failure "element does not support invoke and has no clickable area"',
    '  }',
    '  if ($payload.action -eq "setText") {',
    '    $pattern = $null',
    '    if ($element.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {',
    '      $pattern.SetValue([string]$payload.value)',
    '      @{ ok = $true; action = "setText"; method = "ValuePattern"; name = [string]$payload.name } | ConvertTo-Json -Compress',
    '      exit 0',
    '    }',
    '    $hwnd = $element.Current.NativeWindowHandle',
    '    if ($hwnd -ne 0) {',
    '      [void][PilotWin32]::SendMessage([IntPtr]$hwnd, 0x000C, [IntPtr]::Zero, [string]$payload.value)',
    '      @{ ok = $true; action = "setText"; method = "WM_SETTEXT"; name = [string]$payload.name } | ConvertTo-Json -Compress',
    '      exit 0',
    '    }',
    '    Write-Failure "element does not support ValuePattern and has no native window handle"',
    '  }',
    '  Write-Failure "unsupported action"',
    '} catch { Write-Failure $_.Exception.Message }',
  ].join('\n')
}

async function uiaStep(step: DriveStep, ctx: AdapterContext): Promise<AdapterStepResult> {
  if (step.do === 'uia') {
    const action = step.uiaAction ?? 'read'
    if (action !== 'read' && !step.name && !step.automationId) {
      throw new Error('uia invoke/setText needs name or automationId')
    }
    const windowTitle = step.windowTitle ?? ctx.hints.windowTitle
    if (!windowTitle) throw new Error('uia needs windowTitle (or a windowTitle hint)')
    const payload = {
      action,
      windowTitle,
      ...(step.name ? { name: step.name } : {}),
      ...(step.automationId ? { automationId: step.automationId } : {}),
      ...(step.value !== undefined ? { value: step.value } : {}),
    }
    const result = await runCommand(
      ctx.root,
      {
        command: 'powershell',
        args: ['-NoProfile', '-STA', '-Command', uiaScript(payload)],
        timeoutMs: timeoutOf(step, 20_000),
      },
      ctx.signal,
    )
    if (!result.ok) {
      return { ok: false, output: result.output, error: result.error ?? 'PowerShell UI Automation failed' }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(result.output.trim().split(/\r?\n/).at(-1) ?? '')
    } catch {
      return { ok: false, output: result.output, error: 'UI Automation returned non-JSON output' }
    }
    const record = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
    if (record['ok'] !== true) {
      return { ok: false, output: result.output, error: String(record['error'] ?? 'UI Automation failed') }
    }
    if (action === 'read') {
      const elements = Array.isArray(record['elements']) ? record['elements'] : []
      const text = elements
        .map((element) => {
          if (!element || typeof element !== 'object') return ''
          const item = element as Record<string, unknown>
          const name = String(item['name'] ?? '') || '(unnamed)'
          const aid = item['automationId'] ? ` [aid=${String(item['automationId'])}]` : ''
          return `${String(item['type'] ?? '')}: ${name}${aid}`
        })
        .filter(Boolean)
        .join('\n')
      ctx.state.lastUiaText = text
      return { ok: true, output: text || '(no named controls found)' }
    }
    const target =
      String(record['name'] ?? step.name ?? '') ||
      (step.automationId ? `automationId=${step.automationId}` : '')
    const text = `${action} ${target}${
      typeof record['method'] === 'string' ? ` via ${record['method']}` : ''
    }`
    ctx.state.lastUiaText = text
    return { ok: true, output: text }
  }

  if (step.do === 'assertText') {
    const text = step.text ?? step.expectText ?? ''
    if (!text) throw new Error('assertText needs text')
    if (ctx.state.lastUiaText === undefined) {
      throw new Error('No UI Automation read yet; put a uia read step before assertText')
    }
    const ok = ctx.state.lastUiaText.includes(text)
    return {
      ok,
      output: ok ? `Found text in accessibility tree: ${text}` : `Text not found in accessibility tree: ${text}`,
      ...(ok ? {} : { error: `Text not found in accessibility tree: ${text}` }),
    }
  }
  throw new Error(`uia does not support step ${step.do}`)
}

function adbArgs(step: DriveStep, args: string[]): string[] {
  return [...(step.serial ? ['-s', step.serial] : []), ...args]
}

async function adbStep(step: DriveStep, ctx: AdapterContext): Promise<AdapterStepResult> {
  if (step.do === 'adb') {
    const action = step.adbAction ?? 'dump'
    const timeoutMs = timeoutOf(step, 20_000)
    if (action === 'dump') {
      const dump = await runCommand(
        ctx.root,
        {
          command: 'adb',
          args: adbArgs(step, ['shell', 'uiautomator', 'dump', '/sdcard/pilot-window.xml']),
          timeoutMs,
        },
        ctx.signal,
      )
      if (dump.exitCode !== 0) {
        return { ok: false, output: dump.output, error: dump.error ?? 'uiautomator dump failed' }
      }
      const read = await runCommand(
        ctx.root,
        {
          command: 'adb',
          args: adbArgs(step, ['exec-out', 'cat', '/sdcard/pilot-window.xml']),
          timeoutMs,
        },
        ctx.signal,
      )
      if (read.exitCode !== 0) {
        return { ok: false, output: read.output, error: read.error ?? 'could not read the dump' }
      }
      ctx.state.lastAdbDump = read.output
      return { ok: true, output: read.output.slice(0, 20_000) }
    }
    if (action === 'tap') {
      if (!Number.isFinite(step.x) || !Number.isFinite(step.y)) {
        throw new Error('adb tap needs x and y')
      }
      const result = await runCommand(
        ctx.root,
        {
          command: 'adb',
          args: adbArgs(step, ['shell', 'input', 'tap', String(Math.round(step.x ?? 0)), String(Math.round(step.y ?? 0))]),
          timeoutMs,
        },
        ctx.signal,
      )
      return {
        ok: result.exitCode === 0,
        output: result.output,
        ...(result.exitCode === 0 ? {} : { error: result.error ?? 'adb tap failed' }),
      }
    }
    if (action === 'text') {
      const text = requireString(step.text, 'text')
      const result = await runCommand(
        ctx.root,
        {
          command: 'adb',
          args: adbArgs(step, ['shell', 'input', 'text', text.replace(/ /g, '%s')]),
          timeoutMs,
        },
        ctx.signal,
      )
      return {
        ok: result.exitCode === 0,
        output: result.output,
        ...(result.exitCode === 0 ? {} : { error: result.error ?? 'adb text failed' }),
      }
    }
    if (action === 'shell') {
      const shell = requireString(step.shell, 'shell')
      const result = await runCommand(
        ctx.root,
        {
          command: 'adb',
          args: adbArgs(step, ['shell', shell]),
          timeoutMs,
        },
        ctx.signal,
      )
      ctx.state.lastAdbDump = result.output
      return {
        ok: result.exitCode === 0,
        output: result.output,
        ...(result.exitCode === 0 ? {} : { error: result.error ?? 'adb shell failed' }),
      }
    }
    throw new Error(`Unknown adb action: ${String(action)}`)
  }

  if (step.do === 'assertText') {
    const text = step.text ?? step.expectText ?? ''
    if (!text) throw new Error('assertText needs text')
    if (ctx.state.lastAdbDump === undefined) {
      throw new Error('No adb dump yet; put an adb dump step before assertText')
    }
    const ok = ctx.state.lastAdbDump.includes(text)
    return {
      ok,
      output: ok ? `Found text in Android UI dump: ${text}` : `Text not found in Android UI dump: ${text}`,
      ...(ok ? {} : { error: `Text not found in Android UI dump: ${text}` }),
    }
  }
  throw new Error(`adb does not support step ${step.do}`)
}

async function screenshotStep(step: DriveStep, ctx: AdapterContext): Promise<AdapterStepResult> {
  if (!ctx.captureScreenshot) throw new Error('Screenshot capture is not available')
  const result = await ctx.captureScreenshot({
    ...(step.windowTitle ?? ctx.hints.windowTitle
      ? { windowTitle: step.windowTitle ?? ctx.hints.windowTitle }
      : {}),
    ...(step.label ? { label: step.label } : {}),
  })
  if (!result.ok) return { ok: false, output: result.output, error: 'Screenshot capture failed' }
  const images = Array.isArray(result.metadata?.['images'])
    ? (result.metadata['images'] as unknown[]).filter(
        (item): item is string => typeof item === 'string' && item.startsWith('data:image/'),
      )
    : []
  return { ok: true, output: result.output, images }
}

async function customStep(step: DriveStep, ctx: AdapterContext): Promise<AdapterStepResult> {
  if (!ctx.runDynamicTool) throw new Error('Dynamic tools are not available in this context')
  if (step.do === 'tool') {
    const name = requireString(step.tool, 'tool')
    const result = await ctx.runDynamicTool(name, step.toolArgs ?? {})
    ctx.state.lastToolOutput = result.output
    if (!result.ok) {
      return { ok: false, output: result.output, error: result.error ?? `Tool ${name} failed` }
    }
    if (step.expectText && !result.output.includes(step.expectText)) {
      return {
        ok: false,
        output: result.output,
        error: `Tool ${name} output does not contain ${JSON.stringify(step.expectText)}`,
      }
    }
    return { ok: true, output: result.output }
  }
  if (step.do === 'assertText') {
    const text = step.text ?? step.expectText ?? ''
    if (!text) throw new Error('assertText needs text')
    if (ctx.state.lastToolOutput === undefined) {
      throw new Error('No tool output yet; put a tool step before assertText')
    }
    const ok = ctx.state.lastToolOutput.includes(text)
    return {
      ok,
      output: ok ? `Found text in tool output: ${text}` : `Text not found in tool output: ${text}`,
      ...(ok ? {} : { error: `Text not found in tool output: ${text}` }),
    }
  }
  throw new Error(`custom does not support step ${step.do}`)
}

export async function executeStep(
  surface: DriveSurface,
  step: DriveStep,
  ctx: AdapterContext,
): Promise<AdapterStepResult> {
  switch (surface) {
    case 'cdp':
      return cdpStep(step, ctx)
    case 'http':
      return httpStep(step, ctx)
    case 'cli':
      return cliStep(step, ctx)
    case 'uia':
      return uiaStep(step, ctx)
    case 'adb':
      return adbStep(step, ctx)
    case 'screenshot':
      return screenshotStep(step, ctx)
    case 'custom':
      return customStep(step, ctx)
    case 'playwright':
      return {
        ok: false,
        output: '',
        error: 'Playwright is a project test runner, not a drive surface; use run_e2e with a spec file.',
      }
    default:
      throw new Error(`Unknown surface: ${String(surface)}`)
  }
}
