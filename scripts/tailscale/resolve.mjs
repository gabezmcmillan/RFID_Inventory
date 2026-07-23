// Pure resolver for picking which `tailscale` binary to invoke.
// No Node platform side effects — safe to unit-test with an injected probe.
//
// On macOS the standalone (Homebrew/PATH) CLI and the GUI-app-bundled CLI talk
// to different daemons (different sockets). The PATH CLI can fail with
// "failed to connect to local Tailscale service" even when the Mac app is
// running fine. So we prefer a candidate whose `status --json` actually
// connects, falling back to the first existing binary when none connect (so
// callers can still emit install/open-vs-sign-in remediation).
//
// `candidates` is an ordered list of `{ path, source }` (source: "app"|"path").
// `probe(cmd)` must return `{ exists: boolean, connects: boolean }` where
// `connects` means `<cmd> status --json` exits 0 (daemon reachable).

/**
 * Pick the best Tailscale binary from `candidates` using `probe`.
 *
 * Ranking:
 *   1. First candidate that exists AND connects (prefers app-bundled CLIs on
 *      darwin, then PATH `tailscale`).
 *   2. If none connect but some exist, the first existing one (with
 *      `connects: false`) so callers can run `--version` and give precise
 *      install/open-vs-sign-in guidance.
 *   3. If none exist, `{ command: null, anyExists: false }`.
 *
 * @returns {{ command: string|null, source: string|null, connects: boolean,
 *            anyExists: boolean, probed: Array<{path:string,source:string,exists:boolean,connects:boolean}> }}
 */
export function resolveTailscaleCommand(candidates, probe) {
  const probed = candidates.map((c) => {
    const r = probe(c) || { exists: false, connects: false };
    return { path: c.path, source: c.source, exists: !!r.exists, connects: !!r.connects };
  });

  const working = probed.find((c) => c.exists && c.connects);
  if (working) {
    return { command: working.path, source: working.source, connects: true, anyExists: true, probed };
  }

  const existing = probed.find((c) => c.exists);
  if (existing) {
    return { command: existing.path, source: existing.source, connects: false, anyExists: true, probed };
  }

  return { command: null, source: null, connects: false, anyExists: false, probed };
}

/**
 * True iff a non-connecting PATH CLI was skipped because an app-bundled CLI
 * connected — the "fell back to the Mac app" case that deserves one INFO line
 * (not a false sign-in error).
 */
export function fellBackFromPathToApp(resolution) {
  if (!resolution || resolution.source !== "app" || !resolution.connects) return false;
  const pathCli = resolution.probed.find((c) => c.source === "path");
  return !!(pathCli && pathCli.exists && !pathCli.connects);
}
