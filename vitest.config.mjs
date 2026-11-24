/**
 * Vitest configuration for the desktop test suite.
 *
 * Two knobs, both measured on a 16-core Windows machine where a full run used
 * to fail with a different "Test timed out in 5000ms" file on almost every
 * attempt:
 *
 * `maxWorkers: 8` — vitest defaults to one worker per core (16 here) and every
 * test file gets a fresh worker (~1.35s startup). Several cases do real work
 * instead of faking it: `sandbox.status` launches `wsl.exe` to probe bubblewrap,
 * `runShell` spawns a shell, the checkpoint watcher waits out a retry budget.
 * All of them pass alone (1.2–3.4s) but starve under 16-way parallel load and
 * cross the 5s default: companion-server, checkpoint-watch and workspace.runShell
 * were each observed failing this way. Halving the pool took the full run from
 * 52s/1 failed to 58s/0 failed, so the 6s is the price of a deterministic run.
 *
 * `testTimeout: 15_000` — a safety net, not the fix: it is 3x the slowest
 * observed single-file runtime and does not relax a single assertion. The
 * companion tests keep their own tighter waits (8s per WebSocket frame, 30s for
 * the sandbox probe), so a genuine hang still fails quickly and loudly.
 */
export default {
  test: {
    maxWorkers: 8,
    testTimeout: 15_000,
  },
}
