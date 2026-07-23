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
never enabled. The command prints the Field API URL to paste into the field app.

## 4. Wire the field app

In the field app: **Settings → Web server URL →** paste the URL from step 3 →
**Test connection**.

## 5. Troubleshooting

```bash
pnpm tailscale:doctor
```

Read-only. Emits concise `PASS`/`WARN`/`FAIL` lines for: CLI present, signed in
+ DNS name, Serve maps HTTPS → `http://127.0.0.1:3000`, Funnel off, and local +
tailnet `/api/health`. Each failure prints one exact remediation. Exits nonzero
only for actual setup failures (not a stopped web server, which is a `WARN`).

## Notes

- **Expo/Metro is separate.** `pnpm --filter @rfid/field dev` starts the JS
  bundle/HMR transport; independent of the Tailscale field API transport.
- **Funnel is intentionally not used** — the field API is private to your tailnet.
- Dev DB setup (Turso via Vercel Marketplace) is unrelated: `scripts/setup-dev-vercel.sh`.
