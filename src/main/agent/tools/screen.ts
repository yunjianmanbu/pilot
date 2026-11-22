// 界面观测与驱动工具：截图、窗口、DevTools、drive_*、端到端测试。
// 工具定义与执行放在一起：改一个工具只动这一个文件。
import type { AgentToolDefinition, ToolResult } from '../../../shared/types'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runE2E } from '../e2e'
import { listAppTargets, normalizePort, runAppAction } from '../app-control'
import { listRecipes, probeTarget, runDrive, validateSteps } from '../drive'
import type { DriveHints, DriveStep, DriveSurface } from '../drive'
import { SCREENSHOT, LIST_WINDOWS, APP_TARGETS, APP_CONTROL, DRIVE_PROBE, DRIVE_RECIPES, DRIVE_RUN, RUN_E2E, DRIVE_STEP_SCHEMA } from './spec'
import type { ToolHost } from './spec'
import { driveHints } from './host'

export const screenTools: AgentToolDefinition[] = [
{
    name: SCREENSHOT,
    description:
      'Capture a screenshot so you can visually check the UI you just changed or started. Default target is a single window: pass windowId (exact id from list_windows), windowTitle (part of the title) or omit it to capture Pilot own window. Use windowId when two windows share a title. target "screen" captures the primary display and is only for cases where a window cannot be identified. For a Chromium/Electron app with --remote-debugging-port, prefer app_control action "screenshot": it captures the rendered frame directly and is not affected by window stacking. The compressed image is attached to the conversation as an observation; the tool output also reports the saved file path. Requires the configured model to accept image input. Use this after starting an app and after a visible UI edit; do not take screenshots in a loop.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          enum: ['window', 'screen'],
          description: 'window (default) or screen. Prefer window.',
        },
        windowTitle: {
          type: 'string',
          description: 'Case-insensitive part of the target window title.',
        },
        windowId: {
          type: 'string',
          description:
            'Exact desktopCapturer id from list_windows, e.g. "window:12345:0". Use this when two windows share a title (two Pilot instances).',
        },
        label: { type: 'string', description: 'Short label used in the saved file name.' },
        maxWidth: { type: 'number', description: 'Maximum width in pixels, 480-2560. Default 1440.' },
      },
      additionalProperties: false,
    },
    risk: 'exec',
    source: 'builtin',
  },
{
    name: LIST_WINDOWS,
    description:
      'List capturable desktop windows with their stable ids and titles. Call this before screenshot when more than one window could match a title (for example two running Pilot instances). The ids are desktopCapturer source ids and can be passed straight to screenshot as windowId.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    risk: 'read',
    source: 'builtin',
  },
{
    name: APP_TARGETS,
    description:
      'List DevTools targets (pages, webviews) exposed by a running Chromium/Electron app. Start the app with start_process and add --remote-debugging-port=<port>; for Electron the flag comes after the app entry, e.g. ["." , "--remote-debugging-port=9222"]. Returns each target id, title, URL and whether it is a page. Use it before app_control when several windows exist.',
    inputSchema: {
      type: 'object',
      properties: {
        port: {
          type: 'number',
          description: 'The --remote-debugging-port the app was started with. Default 9222.',
        },
      },
      additionalProperties: false,
    },
    risk: 'read',
    source: 'builtin',
  },
{
    name: APP_CONTROL,
    description:
      'Drive a running Chromium/Electron app through the DevTools protocol: evaluate JavaScript, click, type, press keys, wait for UI state, capture the rendered frame and read console output. This is the general "operate and verify the app" tool, including a second Pilot instance started with its own PILOT_USER_DATA_DIR. Actions: evaluate (expression, optional await), screenshot (attached as an observation), click (selector + nth), type (selector + text, clear replaces the current value), press (Enter/Tab/Escape/arrows/etc. in the focused element), wait (selector or expression until truthy), console (attach for durationMs and collect console messages, logs and uncaught exceptions; events before attachment are not replayed). Target selection: targetId from app_targets, else targetTitle/targetUrl substring, else the first page. Screenshots are saved under the app screenshot directory. When the target is another Pilot, `window.pilot.onEvent` streams every RunEvent (model deltas, tool calls, approvals, completion): buffer it in a page array with evaluate and read that array later. This tool executes code inside the target app: in manual approval modes every call asks first.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['evaluate', 'screenshot', 'click', 'type', 'press', 'wait', 'console'],
        },
        port: {
          type: 'number',
          description: 'The --remote-debugging-port the app was started with. Default 9222.',
        },
        targetId: { type: 'string', description: 'Exact DevTools target id from app_targets.' },
        targetTitle: { type: 'string', description: 'Case-insensitive part of the target title.' },
        targetUrl: { type: 'string', description: 'Case-insensitive part of the target URL.' },
        expression: {
          type: 'string',
          description: 'JavaScript for evaluate, or the condition for wait. Runs in the page context.',
        },
        selector: { type: 'string', description: 'CSS selector for click, type, press focus or wait.' },
        nth: { type: 'number', description: 'Zero-based match index for selector actions. Default 0.' },
        text: { type: 'string', description: 'Text to insert for type.' },
        clear: { type: 'boolean', description: 'For type: select the current value first so it is replaced.' },
        key: {
          type: 'string',
          description: 'For press: Enter, Tab, Escape, Backspace, Delete, Arrow*, Home, End, PageUp, PageDown, Space.',
        },
        timeoutMs: {
          type: 'number',
          description: 'evaluate: max 120000, default 15000. wait: max 60000, default 5000.',
        },
        durationMs: {
          type: 'number',
          description: 'console: how long to listen, 200-15000. Default 2000.',
        },
        quality: { type: 'number', description: 'screenshot JPEG quality, 10-100. Default 72.' },
        label: { type: 'string', description: 'screenshot: short label in the saved file name.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    risk: 'exec',
    source: 'builtin',
  },
{
    name: DRIVE_PROBE,
    description:
      'Inspect an app before driving it. Detects the app kind from package.json markers (electron, tauri, web, android, http, unknown), checks which interfaces actually work right now (DevTools/CDP, HTTP, CLI, Windows UI Automation, adb, screenshots, dynamic tools), reports the evidence for each, the exact enable hint when a surface is missing, the recommended surface order and matching saved recipes. Use this first when the target is new or when a previous approach failed; it also discovers an already-open DevTools port. Read-only: it never mutates the app.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL of a running HTTP target or web app.' },
        port: { type: 'number', description: 'A DevTools port to check (other common ports are scanned too).' },
        processName: { type: 'string', description: 'Process name hint, e.g. "Pilot.exe" or "myapp".' },
        windowTitle: { type: 'string', description: 'Visible window title hint.' },
        command: { type: 'string', description: 'CLI command that drives the app, when it has one.' },
        deep: {
          type: 'boolean',
          description: 'Also check every platform surface (powershell/adb) even when the fingerprint makes it unlikely. Default true for this tool.',
        },
        kind: {
          type: 'string',
          enum: ['electron', 'tauri', 'web', 'native', 'android', 'http', 'unknown'],
          description: 'Explicit target kind when driving an app outside this workspace (for example native). Overrides project markers.',
        },
      },
      additionalProperties: false,
    },
    risk: 'read',
    source: 'builtin',
  },
{
    name: DRIVE_RECIPES,
    description:
      'List saved drive recipes under .pilot/recipes. A recipe is a previously verified step sequence plus the surface order that worked, keyed by app fingerprint. Use it to see what already works for this or a similar app before writing steps again; drive_run with recipe reuses one.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    risk: 'read',
    source: 'builtin',
  },
{
    name: DRIVE_RUN,
    description:
      'Drive and verify any app through a generic surface router instead of one fixed tool per app kind. Give steps (or a saved recipe); the router probes the app, picks the recommended surface, keeps using the surface that worked, and on a specific failure signature (debug port gone, selector missing, timeout, target closed) switches to the next surface that supports that step. Surfaces: cdp (Chromium/Electron/WebView2 via DevTools), http (requests/assertions), cli (stdout/exit code), uia (Windows UI Automation by control name), adb (Android dump/tap/text/shell), screenshot (visual observation), custom (a registered dynamic tool for an interface none of these cover). Step kinds: evaluate, click, type, press, wait, screenshot, console, assertText, assertValue, http, cli, uia, adb, tool. Every step reports ok/fail and every surface switch is reported with its failure signature. Assertion failures stop the run: they describe app state, not a broken surface. Use drive_probe first when unsure; use saveAs only after a run that actually passed. If no surface fits, write a dynamic tool (toolsmith) and use a tool step: this is how an unseen app variant gets supported without a new built-in tool. Templates ${port}, ${url}, ${root}, ${windowTitle}, ${command} are substituted into string fields. Requires approval in manual modes: steps can execute code, commands and clicks.',
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          items: DRIVE_STEP_SCHEMA,
          description: 'Steps to execute in order. Omit when using recipe.',
        },
        recipe: { type: 'string', description: 'Saved recipe name to run (steps from the recipe).' },
        surfaceOrder: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['cdp', 'http', 'cli', 'uia', 'adb', 'screenshot', 'custom'],
          },
          description: 'Force the surface order. Default: the recipe order, else the probe recommendation.',
        },
        allowFallback: {
          type: 'boolean',
          description: 'Switch surfaces on a known failure signature. Default true.',
        },
        saveAs: {
          type: 'string',
          description: 'Recipe name (lowercase, dashes, 2-64 chars). Saved only when every step passed.',
        },
        note: { type: 'string', description: 'Recipe note: what this sequence proves.' },
        url: { type: 'string', description: 'HTTP target url (also a ${url} template value).' },
        port: { type: 'number', description: 'DevTools port (also a ${port} template value).' },
        processName: { type: 'string', description: 'Process name hint.' },
        windowTitle: { type: 'string', description: 'Window title hint for uia/screenshot.' },
        command: { type: 'string', description: 'CLI command hint (also a ${command} template value).' },
        targetId: { type: 'string', description: 'Pin the DevTools target id from app_targets.' },
        targetTitle: {
          type: 'string',
          description: 'Pin the DevTools target by a case-insensitive part of its title (use when another app also exposes a debug port).',
        },
        targetUrl: { type: 'string', description: 'Pin the DevTools target by part of its URL.' },
        kind: {
          type: 'string',
          enum: ['electron', 'tauri', 'web', 'native', 'android', 'http', 'unknown'],
          description: 'Explicit target kind when driving an app outside this workspace.',
        },
      },
      additionalProperties: false,
    },
    risk: 'exec',
    source: 'builtin',
  },
{
    name: RUN_E2E,
    description:
      'Run the project\'s end-to-end tests through the runner it already uses (Playwright, Cypress, WebdriverIO, or a test:e2e/e2e package script). Prefer one spec file over the whole suite. Playwright stops after maxFailures failures and uses the line reporter; failure screenshots are attached as observations. Never installs browsers or runners: if one is missing, report the exact install step to the user. Use run_command for unit tests and typecheck.',
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'Relative spec file or directory, e.g. "e2e/login.spec.ts".',
        },
        grep: { type: 'string', description: 'Playwright only: test title pattern.' },
        project: { type: 'string', description: 'Playwright only: project name.' },
        maxFailures: {
          type: 'number',
          description: 'Playwright only: stop after this many failures (1-50, default 1).',
        },
        timeoutMs: { type: 'number', description: 'Wall-clock timeout, 10000-600000. Default 600000.' },
        cwd: { type: 'string', description: 'Relative working directory.' },
      },
      additionalProperties: false,
    },
    risk: 'exec',
    source: 'builtin',
  },
]

/** 界面观测与驱动工具：截图、窗口、DevTools、drive_*、端到端测试。 返回 null 表示本域没有这个工具。 */
export async function runScreenTool(
  name: string,
  args: Record<string, unknown>,
  host: ToolHost,
  signal: AbortSignal,
): Promise<ToolResult | null> {
  if (name === SCREENSHOT) {
  {
        if (!host.screenshot) throw new Error('Screenshot capture is not available in this context')
        return host.screenshot({
          ...(args['target'] === 'screen' ? { target: 'screen' as const } : {}),
          ...(typeof args['windowTitle'] === 'string' && args['windowTitle'].trim()
            ? { windowTitle: args['windowTitle'].trim() }
            : {}),
          ...(typeof args['windowId'] === 'string' && args['windowId'].trim()
            ? { windowId: args['windowId'].trim() }
            : {}),
          ...(typeof args['label'] === 'string' && args['label'].trim()
            ? { label: args['label'].trim() }
            : {}),
          ...(typeof args['maxWidth'] === 'number' ? { maxWidth: args['maxWidth'] } : {}),
        })
      }
  }
  if (name === LIST_WINDOWS) {
  {
        if (!host.listWindows) throw new Error('Window listing is not available in this context')
        const windows = await host.listWindows()
        if (windows.length === 0) return { ok: true, output: 'No capturable windows found.' }
        return {
          ok: true,
          output: windows.map((entry) => `${entry.id} | ${entry.title}`).join('\n'),
          metadata: { count: windows.length },
        }
      }
  }
  if (name === APP_TARGETS) {
  {
        const port = normalizePort(args['port'])
        const targets = await listAppTargets(port)
        if (targets.length === 0) {
          return {
            ok: true,
            output: `No DevTools targets on 127.0.0.1:${port}. Start the app with --remote-debugging-port=${port}.`,
          }
        }
        return {
          ok: true,
          output: targets
            .map((target) => `[${target.type}] ${target.title}\n  url: ${target.url}\n  id: ${target.id}`)
            .join('\n'),
          metadata: { count: targets.length, port },
        }
      }
  }
  if (name === APP_CONTROL) {
  {
        const action = args['action']
        if (
          action !== 'evaluate' &&
          action !== 'screenshot' &&
          action !== 'click' &&
          action !== 'type' &&
          action !== 'press' &&
          action !== 'wait' &&
          action !== 'console'
        ) {
          throw new Error('action must be one of evaluate, screenshot, click, type, press, wait, console')
        }
        const outcome = await runAppAction({
          action,
          ...(args['port'] !== undefined ? { port: args['port'] } : {}),
          ...(args['targetId'] !== undefined ? { targetId: args['targetId'] } : {}),
          ...(args['targetTitle'] !== undefined ? { targetTitle: args['targetTitle'] } : {}),
          ...(args['targetUrl'] !== undefined ? { targetUrl: args['targetUrl'] } : {}),
          ...(args['expression'] !== undefined ? { expression: args['expression'] } : {}),
          ...(args['selector'] !== undefined ? { selector: args['selector'] } : {}),
          ...(args['nth'] !== undefined ? { nth: args['nth'] } : {}),
          ...(args['text'] !== undefined ? { text: args['text'] } : {}),
          ...(args['clear'] !== undefined ? { clear: args['clear'] } : {}),
          ...(args['key'] !== undefined ? { key: args['key'] } : {}),
          ...(args['timeoutMs'] !== undefined ? { timeoutMs: args['timeoutMs'] } : {}),
          ...(args['durationMs'] !== undefined ? { durationMs: args['durationMs'] } : {}),
          ...(args['quality'] !== undefined ? { quality: args['quality'] } : {}),
          ...(args['label'] !== undefined ? { label: args['label'] } : {}),
          saveDir: host.screenshotDir ?? join(tmpdir(), 'pilot-app-screenshots'),
        })
        return {
          ok: true,
          output: outcome.output,
          metadata: {
            ...outcome.metadata,
            ...(outcome.images ? { images: outcome.images } : {}),
          },
        }
      }
  }
  if (name === DRIVE_PROBE) {
  {
        const hints = driveHints(host.root, args)
        const probe = await probeTarget(
          hints,
          {
            canScreenshot: Boolean(host.screenshot),
            canCustom: Boolean(host.toolRegistry),
            canTool: Boolean(host.toolRegistry),
            deep: args['deep'] !== false,
          },
          signal,
        )
        const lines: string[] = []
        lines.push(`${probe.fingerprint.kind} app (${probe.fingerprint.key})`)
        if (probe.fingerprint.markers.length > 0) {
          lines.push(`Markers: ${probe.fingerprint.markers.join(', ')}`)
        }
        lines.push('Surfaces:')
        for (const report of probe.surfaces) {
          lines.push(
            `  ${report.available ? '[available]' : '[missing]'} ${report.surface}: ${report.evidence}`,
          )
          if (report.enableHint) lines.push(`    enable: ${report.enableHint}`)
        }
        lines.push(`Recommendation: ${probe.recommendation.reason}`)
        if (probe.recommendation.selfExtend) {
          lines.push(`Self-extend: ${probe.recommendation.selfExtend}`)
        }
        if (probe.recipes.length > 0) {
          lines.push('Recipes:')
          for (const recipe of probe.recipes) {
            lines.push(
              `  ${recipe.name} (${recipe.match}, ${recipe.stepCount} steps, ok ${recipe.successCount}/fail ${recipe.failureCount})${recipe.note ? ` — ${recipe.note}` : ''}`,
            )
          }
        } else {
          lines.push('Recipes: none for this fingerprint or kind.')
        }
        return {
          ok: true,
          output: lines.join('\n').slice(0, 32_000),
          metadata: {
            fingerprint: probe.fingerprint,
            surfaces: probe.surfaces,
            recommendation: probe.recommendation,
            recipes: probe.recipes,
            ...(probe.discoveredPort ? { port: probe.discoveredPort } : {}),
          },
        }
      }
  }
  if (name === DRIVE_RECIPES) {
  {
        const summaries = await listRecipes(host.root)
        if (summaries.length === 0) {
          return { ok: true, output: 'No recipes saved under .pilot/recipes yet.' }
        }
        return {
          ok: true,
          output: summaries
            .map(
              (recipe) =>
                `${recipe.name} | ${recipe.kind} ${recipe.fingerprintKey} | ${recipe.stepCount} steps | ok ${recipe.successCount} fail ${recipe.failureCount} | ${recipe.updatedAt}${recipe.note ? ` | ${recipe.note}` : ''}`,
            )
            .join('\n'),
          metadata: { count: summaries.length },
        }
      }
  }
  if (name === DRIVE_RUN) {
  {
        const recipeName =
          typeof args['recipe'] === 'string' && args['recipe'].trim() ? args['recipe'].trim() : undefined
        const rawSteps = args['steps']
        const steps: DriveStep[] | undefined =
          rawSteps === undefined ? undefined : validateSteps(rawSteps)
        if (!steps && !recipeName) throw new Error('drive_run needs steps or a recipe name')
        const surfaces: DriveSurface[] = ['cdp', 'http', 'cli', 'uia', 'adb', 'screenshot', 'custom']
        const requestedOrder = Array.isArray(args['surfaceOrder'])
          ? args['surfaceOrder'].filter(
              (surface): surface is DriveSurface =>
                typeof surface === 'string' && surfaces.includes(surface as DriveSurface),
            )
          : []
        const screenshot = host.screenshot
        const dynamicRun = host.toolRegistry
        const outcome = await runDrive({
          root: host.root,
          ...(steps ? { steps } : {}),
          ...(recipeName ? { recipe: recipeName } : {}),
          ...(requestedOrder.length > 0 ? { surfaceOrder: requestedOrder } : {}),
          hints: {
            ...(typeof args['url'] === 'string' && args['url'].trim() ? { url: args['url'].trim() } : {}),
            ...(typeof args['port'] === 'number' ? { port: args['port'] } : {}),
            ...(typeof args['processName'] === 'string' && args['processName'].trim()
              ? { processName: args['processName'].trim() }
              : {}),
            ...(typeof args['windowTitle'] === 'string' && args['windowTitle'].trim()
              ? { windowTitle: args['windowTitle'].trim() }
              : {}),
            ...(typeof args['command'] === 'string' && args['command'].trim()
              ? { command: args['command'].trim() }
              : {}),
            ...(typeof args['targetId'] === 'string' && args['targetId'].trim()
              ? { targetId: args['targetId'].trim() }
              : {}),
            ...(typeof args['targetTitle'] === 'string' && args['targetTitle'].trim()
              ? { targetTitle: args['targetTitle'].trim() }
              : {}),
            ...(typeof args['targetUrl'] === 'string' && args['targetUrl'].trim()
              ? { targetUrl: args['targetUrl'].trim() }
              : {}),
            ...(typeof args['kind'] === 'string' && args['kind'] !== 'unknown'
              ? { kind: args['kind'] as NonNullable<DriveHints['kind']> }
              : {}),
          },
          allowFallback: args['allowFallback'] !== false,
          signal,
          ...(typeof args['saveAs'] === 'string' && args['saveAs'].trim()
            ? { saveAs: args['saveAs'].trim() }
            : {}),
          ...(typeof args['note'] === 'string' && args['note'].trim() ? { note: args['note'].trim() } : {}),
          screenshotDir: host.screenshotDir ?? join(tmpdir(), 'pilot-drive'),
          ...(screenshot
            ? {
                captureScreenshot: async (request) => {
                  const result = await screenshot(request)
                  return {
                    ok: result.ok,
                    output: result.output,
                    ...(result.metadata ? { metadata: result.metadata } : {}),
                  }
                },
              }
            : {}),
          ...(dynamicRun
            ? {
                runDynamicTool: async (nameLocal: string, toolArgs: Record<string, unknown>) => {
                  const result = await dynamicRun.run(nameLocal, toolArgs)
                  return {
                    ok: result.ok,
                    output: result.output,
                    ...(result.error ? { error: result.error } : {}),
                  }
                },
              }
            : {}),
        })
        return {
          ok: outcome.ok,
          output: outcome.output,
          ...(outcome.error ? { error: outcome.error } : {}),
          metadata: {
            fingerprint: outcome.fingerprint,
            surfaceOrder: outcome.surfaceOrder,
            usedSurfaces: outcome.usedSurfaces,
            fallbacks: outcome.fallbacks,
            steps: outcome.steps,
            ...(outcome.recipe ? { recipe: outcome.recipe } : {}),
            ...(outcome.images.length > 0 ? { images: outcome.images } : {}),
          },
        }
      }
  }
  if (name === RUN_E2E) {
  {
        return runE2E(host.root, args, signal, {
          sandbox: host.sandbox ?? null,
          shellInterpreter: host.shellInterpreter ?? 'auto',
          shellEnabled: host.shellEnabled !== false,
        })
      }
  }
  return null
}
