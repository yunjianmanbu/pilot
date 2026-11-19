/**
 * Generic driving layer. A "surface" is an observable/actionable interface an
 * app exposes (DevTools, HTTP, a CLI, Windows UI Automation, adb, or a dynamic
 * tool). A "recipe" is a verified sequence of steps plus the surface order
 * that worked, keyed by an app fingerprint. The router tries the recommended
 * surface first and falls back on specific failure signatures, so a variant
 * does not need a new built-in tool.
 */
export type DriveSurface =
  | 'cdp'
  | 'http'
  | 'cli'
  | 'playwright'
  | 'uia'
  | 'adb'
  | 'screenshot'
  | 'custom'

export type DriveKind = 'electron' | 'tauri' | 'web' | 'native' | 'android' | 'http' | 'unknown'

export interface DriveFingerprint {
  kind: DriveKind
  markers: string[]
  key: string
}

export interface DriveSurfaceReport {
  surface: DriveSurface
  available: boolean
  evidence: string
  how: string
  enableHint?: string
  limitations?: string
}

export interface DriveRecipeSummary {
  name: string
  note?: string
  fingerprintKey: string
  kind: DriveKind
  updatedAt: string
  successCount: number
  failureCount: number
  match: 'exact' | 'kind'
  stepCount: number
}

export interface DriveProbeResult {
  fingerprint: DriveFingerprint
  surfaces: DriveSurfaceReport[]
  recommendation: {
    primary: DriveSurface
    fallbackOrder: DriveSurface[]
    reason: string
    selfExtend: string | null
  }
  recipes: DriveRecipeSummary[]
  discoveredPort?: number
}

export type DriveStepDo =
  | 'evaluate'
  | 'click'
  | 'type'
  | 'press'
  | 'wait'
  | 'screenshot'
  | 'console'
  | 'assertText'
  | 'assertValue'
  | 'http'
  | 'cli'
  | 'uia'
  | 'adb'
  | 'tool'

export interface DriveStep {
  do: DriveStepDo
  description?: string
  selector?: string
  nth?: number
  text?: string
  clear?: boolean
  key?: string
  expression?: string
  timeoutMs?: number
  durationMs?: number
  label?: string
  method?: string
  url?: string
  headers?: Record<string, string>
  body?: string
  expectStatus?: number
  expectBody?: string
  expectText?: string
  command?: string
  args?: string[]
  expectExit?: number
  expectOutput?: string
  tool?: string
  toolArgs?: Record<string, unknown>
  uiaAction?: 'read' | 'invoke' | 'setText'
  name?: string
  /** Target a control by UIA AutomationId when it has no accessible name. */
  automationId?: string
  value?: string
  windowTitle?: string
  adbAction?: 'dump' | 'tap' | 'text' | 'shell'
  x?: number
  y?: number
  serial?: string
  shell?: string
}

export interface DriveRecipe {
  version: 1
  name: string
  note?: string
  fingerprint: DriveFingerprint
  surfaceOrder: DriveSurface[]
  steps: DriveStep[]
  createdAt: string
  updatedAt: string
  successCount: number
  failureCount: number
}

export interface DriveHints {
  root: string
  url?: string
  port?: number
  processName?: string
  windowTitle?: string
  command?: string
  /** Pin the DevTools target when several Chromium apps expose ports. */
  targetId?: string
  targetTitle?: string
  targetUrl?: string
  /** Explicit target kind when the app is external to the workspace. */
  kind?: DriveKind
}

export interface DriveProbeContext {
  canScreenshot: boolean
  canCustom: boolean
  canTool: boolean
  /** Run every platform check even when the fingerprint makes it unlikely. */
  deep?: boolean
}

export interface DriveStepResult {
  index: number
  do: DriveStepDo
  description?: string
  surface: DriveSurface
  ok: boolean
  output: string
  error?: string
  signature?: string
  durationMs: number
}

export interface DriveFallback {
  stepIndex: number
  from: DriveSurface
  to: DriveSurface
  signature: string
  reason: string
}

export interface DriveRunResult {
  ok: boolean
  fingerprint: DriveFingerprint
  surfaceOrder: DriveSurface[]
  usedSurfaces: DriveSurface[]
  fallbacks: DriveFallback[]
  steps: DriveStepResult[]
  output: string
  error?: string
  images: string[]
  recipe?: string
}

export interface DriveRunOptions {
  root: string
  steps?: DriveStep[]
  surfaceOrder?: DriveSurface[]
  recipe?: string
  hints: Omit<DriveHints, 'root'>
  allowFallback: boolean
  signal: AbortSignal
  saveAs?: string
  note?: string
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
}
