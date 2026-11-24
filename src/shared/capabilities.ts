/**
 * What a host can actually do, declared instead of inferred.
 *
 * The two hosts run the same engine but are not the same product: the desktop
 * app owns a window, an in-place updater and the bundled pristine source tree;
 * `pilot serve` has none of those and replaces files instead. The panel used to
 * learn about the gap from documentation ("screen capture and in-app updates
 * are unavailable in server mode") or from a request failing with a
 * version-too-old message, which reads like a bug. A host now states its
 * capabilities once, `device.info` carries them to the panel, and the panel
 * decides what to hide or grey out.
 */
/**
 * Which host is rendering the panel. The two hosts share one renderer, so a
 * layout or a control that only makes sense in one of them has to ask instead
 * of inferring it from the platform (both report the same `process.platform`).
 */
export type HostKind = 'desktop' | 'server'

export interface HostCapabilities {
  /** Screen capture needs a desktop session with a display attached. */
  screenshot: boolean
  /** `in-app` updates in place; `files` rewrites the install tree and restarts. */
  update: 'in-app' | 'files' | 'none'
  /** Phone-driven self-evolution controls: cycles, policy versions, profiles. */
  evolution: boolean
  /** Personal-fork versions need the pristine source tree the installer ships. */
  personal: boolean
  /** A pairing request can raise the app window. Headless hosts print instead. */
  window: boolean
}

/** Electron host: everything is available. */
export const DESKTOP_CAPABILITIES: HostCapabilities = {
  screenshot: true,
  update: 'in-app',
  evolution: true,
  personal: true,
  window: true,
}

/**
 * `pilot serve`: no desktop session, no window, no bundled source tree. Updates
 * still work, but they replace files in the install directory and need a
 * restart, so the panel must not offer the desktop flow.
 *
 * Self-evolution cycles and policy versions do work headless (they only read
 * the store), so `evolution` stays true; the personal fork does not, because
 * it diffs against the pristine source tree the installer ships.
 */
export const SERVER_CAPABILITIES: HostCapabilities = {
  screenshot: false,
  update: 'files',
  evolution: true,
  personal: false,
  window: false,
}
