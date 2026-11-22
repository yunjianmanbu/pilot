/**
 * macOS side of the in-app updater.
 *
 * Windows hands the downloaded NSIS installer to a silent `/S` run. macOS has
 * no equivalent: the app bundle cannot overwrite itself while it is running and
 * a dmg is a read-only volume image. So the updater stages the new bundle next
 * to the installed one and lets a small shell script do the swap after Pilot
 * exits, rolling back if the swap fails.
 *
 * Everything here is pure path/string logic so it can be unit tested on any
 * platform; the downloading and spawning live in `updater.ts`.
 */

import { basename, dirname, join } from 'node:path'

/** `/Applications/Pilot.app/Contents/MacOS/Pilot` → `/Applications/Pilot.app` */
export function appBundleForExecutable(execPath: string): string | null {
  const macos = dirname(execPath)
  const contents = dirname(macos)
  if (basename(contents) !== 'Contents') return null
  if (basename(macos) !== 'MacOS') return null
  const bundle = dirname(contents)
  return bundle.toLowerCase().endsWith('.app') ? bundle : null
}

/** A bundle opened straight from a mounted dmg lives on a read-only volume. */
export function isMountedVolume(appBundle: string): boolean {
  const normalized = appBundle.replace(/\\/g, '/')
  return normalized === '/Volumes' || normalized.startsWith('/Volumes/')
}

/** Picks the staged bundle out of a directory listing. */
export function pickStagedApp(entries: readonly string[], expectedName: string): string | null {
  if (entries.includes(expectedName)) return expectedName
  const bundles = entries.filter((name) => name.toLowerCase().endsWith('.app') && !name.startsWith('.'))
  return bundles.length === 1 ? (bundles[0] ?? null) : null
}

/** Staging directory must share a volume with the installed bundle so `mv` is a rename. */
export function stagingDirFor(appBundle: string, token: string): string {
  return join(dirname(appBundle), `.pilot-update-${token}`)
}

/**
 * The swap runs detached, after Pilot quits. Arguments:
 *   1 current bundle  2 staged bundle  3 backup path  4 log file
 * Ordering matters: the old bundle is moved aside first, the new one is moved
 * in, and any failure puts the old one back so the user never ends up with a
 * half-installed app.
 */
export const MAC_SWAP_SCRIPT = `#!/bin/sh
# Written by Pilot's updater. Swaps a staged app bundle over the installed one
# after Pilot exits, then relaunches it. A failed swap rolls the old bundle back.
set -u
TARGET="$1"
STAGED="$2"
BACKUP="$3"
LOG="$4"
exec >>"$LOG" 2>&1
echo "== start $(date) =="
# Give the quitting process a moment to release its bundle and the instance lock.
sleep 1
if [ ! -d "$STAGED" ]; then
  echo "staged bundle missing: $STAGED"
  exit 1
fi
rm -rf "$BACKUP"
if ! mv "$TARGET" "$BACKUP"; then
  echo "cannot move the installed bundle; is it on a read-only volume?"
  exit 1
fi
if mv "$STAGED" "$TARGET"; then
  echo "swapped in $TARGET"
  xattr -dr com.apple.quarantine "$TARGET" >/dev/null 2>&1 || true
  rm -rf "$BACKUP"
  open "$TARGET"
  exit 0
fi
echo "swap failed, rolling back"
mv "$BACKUP" "$TARGET"
exit 1
`
