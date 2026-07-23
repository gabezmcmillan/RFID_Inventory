# Local development — Tailscale field API

The field (iPhone) app talks to the local web app over a **private Tailscale
tailnet**, not the public internet. This file is the only setup you need.

## 1. Install & sign in to Tailscale

- **Mac** (runs the web app): install from <https://tailscale.com/download/mac>
  and sign in.
- **iPhone** (runs the field app): install the Tailscale app from the App Store
  and sign in to the **same tailnet**.

Both devices must be on the same tailnet. Nothing here uses Tailscale Funnel —
the field API stays private to your tailnet.

## 2. Run the web app on localhost

```bash
pnpm --filter @rfid/web dev
```

Keep this running at `http://localhost:3000`. Web/SSO (cookies, Entra callback)
stays on `localhost`; only the field API uses the Tailscale URL below.

## 3. One-time setup

```bash
pnpm tailscale:setup
```

This confirms the `tailscale` CLI, requires you to be signed in/running, derives
your Field API URL (`https://<mac>.<tailnet>.ts.net`), and runs exactly:

```bash
tailscale serve --bg http://127.0.0.1:3000
```

If a **conflicting** Serve mapping already exists, setup refuses to overwrite it
and prints the one exact remediation (it never resets automatically). Funnel is
never enabled. After Serve is configured it also writes
`EXPO_PUBLIC_DEFAULT_SERVER_URL=<origin>` into `apps/field/.env.local` (the field
app's gitignored Expo env), preserving any other values, and prints
`Restart Metro to load the updated Expo env.`

## 4. Wire the field app

The field app reads its default server origin from the typed env seam
(`apps/field/src/config/env.ts` → `EXPO_PUBLIC_DEFAULT_SERVER_URL` in
`apps/field/.env.local`), falling back to `http://localhost:3000` for the
simulator. After `pnpm tailscale:setup`, restart Metro so the new env is
inlined. You can still override per-device in the field app: **Settings → Web
server URL** (runtime Settings wins over the env default).

## 5. Troubleshooting

```bash
pnpm tailscale:doctor
```

Read-only. Emits concise `PASS`/`WARN`/`FAIL` lines for: CLI present, signed in
+ DNS name, Serve maps HTTPS → `http://127.0.0.1:3000`, Funnel off, local +
tailnet `/api/health`, and the field env key matching the discovered origin.
Each failure prints one exact remediation. Exits nonzero only for actual setup
failures (not a stopped web server, a not-yet-restarted Metro, or a missing/stale
env key — those are `WARN`).

## Notes

- **Expo/Metro is separate.** `pnpm --filter @rfid/field dev` starts the JS
  bundle/HMR transport; independent of the Tailscale field API transport.
- **Field app default server URL** lives in `apps/field/.env.local` as
  `EXPO_PUBLIC_DEFAULT_SERVER_URL` (gitignored; see `apps/field/.env.example`).
  `pnpm tailscale:setup` writes it; restart Metro to load it. Runtime Settings
  still override it per-device.
- **Funnel is intentionally not used** — the field API is private to your tailnet.
- Dev DB setup (Turso via Vercel Marketplace) is unrelated: `scripts/setup-dev-vercel.sh`.
