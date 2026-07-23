# Plan 011: Make local development phone-reachable over Tailscale

> **Executor instructions**: This plan was radically narrowed on 2026-07-23 from
> its original "one-command, stable, phone-reachable" design to **only** an easy,
> dependency-free way to confirm Tailscale is set up so a physical iPhone can
> reach the local web app. Follow the "Delivered scope" below. When done, update
> this plan's status row in `plans/README.md`.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: satisfied — commit `9d5dbe9` provisioned and verified the
  isolated `rfid-warehouse-dev` + `rfid-auth-dev` resources through Vercel
  Marketplace at Development scope; does **not** depend on Plan 010
- **Category**: dx
- **Planned at**: commit `151a536`, 2026-07-23 (original); narrowed 2026-07-23
- **Current status**: IN PROGRESS — setup implemented and deterministic tests
  pass; physical iPhone reachability confirmation pending

## Why this matters

The physical iPhone receives its JS bundle from Metro, but it must independently
reach the local web app's API for auth + sync. The simplest stable path is a
private Tailscale tailnet: `tailscale serve` proxies HTTPS
(`https://<mac>.<tailnet>.ts.net`) to the local web app
(`http://127.0.0.1:3000`), and the phone — on the same tailnet — points its
Web server URL at that HTTPS origin. This plan makes that setup trivial to
configure and verify.

## Delivered scope (the whole feature)

Two root scripts, a tiny `scripts/tailscale/` module, a short doc, and this
plan. **No npm dependencies** — Node built-ins (`child_process`, `node:test`)
only.

### `pnpm tailscale:setup`

`node scripts/tailscale/tailscale.mjs setup`:

1. Confirms the `tailscale` CLI exists.
2. Parses `tailscale status --json`; requires `BackendState === "Running"` and a
   non-empty `User` map (signed in); derives `https://<Self.DNSName without
   trailing dot>`. Never prints peer inventory.
3. Checks `tailscale serve status --json`:
   - no Serve mapping → runs exactly `tailscale serve --bg http://127.0.0.1:3000`;
   - mapping already targets `http://127.0.0.1:3000` over TLS/443 → idempotent
     no-op (PASS);
   - conflicting mapping → refuses to overwrite, prints one exact remediation
     (`tailscale serve reset && tailscale serve --bg http://127.0.0.1:3000`),
     exits nonzero. Never resets automatically.
4. Checks `tailscale funnel status --json`; Funnel must be off. **Never enables
   Funnel.** If it is on, prints a WARN with `tailscale funnel off`.
5. Prints only: the Field API URL, "keep the web app running at
   localhost:3000", and "set this URL in Field Settings → Web server URL, then
   Test connection".
6. Optionally probes `<origin>/api/health`. A stopped local web server is a
   clear WARN/action, never a mutation.

### `pnpm tailscale:doctor` (read-only)

`node scripts/tailscale/tailscale.mjs doctor`:

1. Checks CLI present, signed in, DNS name.
2. Checks Serve maps HTTPS → `http://127.0.0.1:3000`.
3. Checks Funnel off.
4. Checks `http://127.0.0.1:3000/api/health` and
   `https://<origin>/api/health` with short (3s) timeouts.
5. Emits concise `PASS`/`WARN`/`FAIL` lines, one exact remediation per failure.
   Exits nonzero only for actual setup failures (CLI missing, not signed in,
   conflicting Serve) — a stopped web server is a WARN. No secrets or raw JSON.

### Module layout

- `scripts/tailscale/parse.mjs` — pure parsers: `stripTrailingDot`,
  `discoverFieldOrigin`, `serveEntries`, `classifyServe`, `funnelIsConfigured`.
  Handles array- and object-map-shaped `serve status --json` and several
  `config.tcp`/`config.web`/`backend`/`Backend` entry shapes.
- `scripts/tailscale/tailscale.mjs` — the `setup`/`doctor` CLI.
- `scripts/tailscale/parse.test.mjs` — `node:test` fixtures (no live
  Tailscale/network).

### Docs

- `docs/local-development.md` (≤60 lines): install/sign into Tailscale on Mac +
  iPhone (same tailnet), run web on localhost:3000, `pnpm tailscale:setup` once,
  `pnpm tailscale:doctor` when troubleshooting, Expo/Metro is separate, Funnel
  intentionally not used.

### Root scripts

`package.json` gains only `tailscale:setup`, `tailscale:doctor`, and the
tailscale `node:test` run is prepended to the root `test` script. **No new
dependencies, no `devDependencies`, no lockfile changes.**

## Explicitly out of scope (dropped from the original 011 design)

The original plan was much larger. All of the following were **removed** and
must not be re-introduced under this plan:

- A `pnpm dev` supervisor and `dev:bypass` / `dev:native` / `dev:smoke` profiles.
- A redesigned versioned QR origin-handoff protocol.
- A `FIELD_DEVICE_API_ORIGIN` / `FIELD_DEVICE_API_TRANSPORT` env schema in
  `apps/web/src/lib/env.ts`.
- A shared `@rfid/device-link-protocol` workspace package.
- New runtime/dev dependencies (`tsx`, `vitest`, `execa`, `@types/node`) at the
  root or in any workspace.
- CI expansion.
- Any auth or UI changes (Better Auth, link-device, settings screen).
- ngrok or Cloudflare fallbacks.

## History

- `c48db91` added the oversized Step 1 work (shared package, env schema, root
  deps, supervisor scripts, credential re-export).
- `7051353` reverted the contents of `c48db91` (normal inverse commit; no
  history reset) to restore the narrowed scope.
- `2839583` separately fixed a real `scripts/setup-dev-vercel.sh` backtick /
  command-substitution bug (independent of 011 scope).
- The minimal Tailscale setup/doctor feature is then added on top.

The operator's personal `DEFAULT_SERVER_URL` in
`apps/field/src/auth/credential.ts` is a working-tree-only change and is
intentionally **not** committed (it encodes a specific machine name).

## Verification (deterministic gates)

```bash
node --test scripts/tailscale/*.test.mjs   # pure parser fixtures
pnpm tailscale:doctor                        # read-only; may report live state
pnpm -r typecheck
pnpm test                                    # includes the node:test run
git diff --check
```

`pnpm tailscale:doctor` is read-only and may report the operator's live
Tailscale/web state; it must not change state.

## Done criteria

- `pnpm tailscale:setup` configures Serve and prints the Field API URL; on a
  conflicting mapping it refuses and prints the exact remediation.
- `pnpm tailscale:doctor` emits PASS/WARN/FAIL with one remediation per failure
  and exits nonzero only for real setup failures.
- All deterministic gates pass with no new dependencies.
- `docs/local-development.md` and this plan reflect the narrowed scope.
- `plans/README.md` row 011 updated.

## STOP conditions

Stop and report (do not improvise) if:

- The operator's working-tree `DEFAULT_SERVER_URL` change would be staged or
  lost.
- `tailscale` is unavailable and setup cannot be exercised live (still allow
  the deterministic gates to run).
- A conflicting Serve mapping exists that the operator does not want reset.
- Any gate introduces a new dependency or requires an install.
