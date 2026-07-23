#!/usr/bin/env node
// Minimal Tailscale setup/doctor for local development.
// No npm dependencies — Node built-ins only.
//
//   node scripts/tailscale/tailscale.mjs setup   -> configure `tailscale serve` for localhost:3000
//   node scripts/tailscale/tailscale.mjs doctor  -> read-only verification (PASS/WARN/FAIL)
import { spawnSync } from "node:child_process";
import { discoverFieldOrigin, classifyServe, classifyFunnel } from "./parse.mjs";

const LOCAL_WEB = "http://127.0.0.1:3000";
const HEALTH_PATH = "/api/health";
const FETCH_TIMEOUT_MS = 3000;

function runTailscale(args) {
  const res = spawnSync("tailscale", args, { encoding: "utf8", maxBuffer: 1 << 24 });
  if (res.error) {
    return { ok: false, missing: res.error.code === "ENOENT", error: res.error };
  }
  return { ok: res.status === 0, status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function parseJsonOr(text, fallback) {
  if (!text || !text.trim()) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

async function fetchWithTimeout(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: "application/json" } });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: e?.name === "AbortError" ? "timeout" : "unreachable" };
  } finally {
    clearTimeout(t);
  }
}

function line(level, msg) {
  const tag = level === "PASS" ? "PASS" : level === "WARN" ? "WARN" : level === "FAIL" ? "FAIL" : "INFO";
  process.stdout.write(`${tag}  ${msg}\n`);
}

// Check Funnel state. Returns { state, reason } and prints FAIL for on/unknown.
// Returns true if safe to continue (Funnel off), false if setup must abort.
function checkFunnelOrFail() {
  const fr = runTailscale(["funnel", "status", "--json"]);
  const fun = classifyFunnel(parseJsonOr(fr.stdout, null), fr.ok);
  if (fun.state === "on") {
    line("FAIL", "Funnel is ON. Plan 011 uses the private tailnet only — Funnel exposes the node to the public internet.");
    line("INFO", "Remediation: `tailscale funnel off`, then re-run `pnpm tailscale:setup`.");
    return false;
  }
  if (fun.state === "unknown") {
    line("FAIL", `Funnel state could not be confirmed: ${fun.reason}.`);
    line("INFO", "Remediation: ensure Tailscale is running; if Funnel is on run `tailscale funnel off`, then re-run.");
    return false;
  }
  line("PASS", "Funnel is off (private tailnet only).");
  return true;
}

// ---------------------------------------------------------------------------
// SETUP
// ---------------------------------------------------------------------------
async function setup() {
  const cli = runTailscale(["--version"]);
  if (!cli.ok && cli.missing) {
    line("FAIL", "tailscale CLI not found. Install: https://tailscale.com/download/mac");
    process.exit(1);
  }

  const statusRes = runTailscale(["status", "--json"]);
  const status = parseJsonOr(statusRes.stdout, null);
  const origin = discoverFieldOrigin(status);
  if (!origin.ok) {
    line("FAIL", `Cannot derive Field API URL: ${origin.reason}.`);
    line("INFO", "Remediation: sign in with `tailscale up`, then re-run `pnpm tailscale:setup`.");
    process.exit(1);
  }

  // Funnel must be OFF before we touch Serve — never auto-disable it.
  if (!checkFunnelOrFail()) process.exit(1);

  const serveRes = runTailscale(["serve", "status", "--json"]);
  const serve = parseJsonOr(serveRes.stdout, null);
  const cls = classifyServe(serve);

  if (cls.mapsToLocal3000) {
    line("PASS", `Tailscale Serve already proxies HTTPS -> ${LOCAL_WEB}`);
  } else if (cls.conflict) {
    line("FAIL", "Tailscale Serve has a conflicting mapping; refusing to overwrite it.");
    line("INFO", "Remediation: review with `tailscale serve status`, then run:");
    line("INFO", "  tailscale serve reset && tailscale serve --bg http://127.0.0.1:3000");
    process.exit(1);
  } else {
    const add = runTailscale(["serve", "--bg", LOCAL_WEB]);
    if (!add.ok) {
      line("FAIL", `Failed to enable Tailscale Serve: ${(add.stderr || "").trim() || "unknown error"}`);
      process.exit(1);
    }
    line("PASS", `Tailscale Serve now proxies HTTPS -> ${LOCAL_WEB}`);
  }

  // Optional health probe (a stopped web server is a warning, not a mutation).
  const probe = await fetchWithTimeout(`${origin.origin}${HEALTH_PATH}`);
  if (probe.ok) {
    line("PASS", `Health check OK at ${origin.origin}${HEALTH_PATH}`);
  } else {
    line("WARN", `Could not reach ${origin.origin}${HEALTH_PATH} (${probe.error || probe.status || "no response"}).`);
    line("WARN", "Keep the web app running at http://localhost:3000 (pnpm --filter @rfid/web dev).");
  }

  process.stdout.write("\n");
  line("INFO", `Field API URL:  ${origin.origin}`);
  line("INFO", "Keep the web app running at http://localhost:3000.");
  line("INFO", "In the Field app: Settings -> Web server URL -> paste the URL above -> Test connection.");
}

// ---------------------------------------------------------------------------
// DOCTOR (read-only)
// ---------------------------------------------------------------------------
async function doctor() {
  let hardFail = 0;

  const cli = runTailscale(["--version"]);
  if (!cli.ok && cli.missing) {
    line("FAIL", "tailscale CLI not found. Install: https://tailscale.com/download/mac");
    process.exit(1);
  }
  line("PASS", "tailscale CLI found.");

  const statusRes = runTailscale(["status", "--json"]);
  const status = parseJsonOr(statusRes.stdout, null);
  const origin = discoverFieldOrigin(status);
  if (!origin.ok) {
    line("FAIL", `Tailscale not ready: ${origin.reason}`);
    line("INFO", "Remediation: `tailscale up` to sign in, then re-run `pnpm tailscale:doctor`.");
    hardFail = 1;
  } else {
    line("PASS", `Signed in; Field API URL: ${origin.origin}`);
  }

  const serveRes = runTailscale(["serve", "status", "--json"]);
  const serve = parseJsonOr(serveRes.stdout, null);
  const cls = classifyServe(serve);
  if (cls.mapsToLocal3000) {
    line("PASS", `Serve maps HTTPS -> ${LOCAL_WEB}`);
  } else if (cls.conflict) {
    line("FAIL", "Serve has a conflicting mapping (not localhost:3000 over HTTPS).");
    line("INFO", "Remediation: `tailscale serve status`, then `tailscale serve reset && tailscale serve --bg http://127.0.0.1:3000`");
    hardFail = 1;
  } else {
    line("WARN", "Serve is not configured for localhost:3000.");
    line("INFO", "Remediation: `pnpm tailscale:setup`");
  }

  // Funnel ON or unknown is a security/setup failure -> FAIL (never auto-disable).
  const funnelRes = runTailscale(["funnel", "status", "--json"]);
  const fun = classifyFunnel(parseJsonOr(funnelRes.stdout, null), funnelRes.ok);
  if (fun.state === "on") {
    line("FAIL", "Funnel is ON. Plan 011 uses the private tailnet only.");
    line("INFO", "Remediation: `tailscale funnel off`");
    hardFail = 1;
  } else if (fun.state === "unknown") {
    line("FAIL", `Funnel state unknown: ${fun.reason}.`);
    line("INFO", "Remediation: ensure Tailscale is running; if Funnel is on run `tailscale funnel off`.");
    hardFail = 1;
  } else {
    line("PASS", "Funnel is off.");
  }

  const local = await fetchWithTimeout(`http://127.0.0.1:3000${HEALTH_PATH}`);
  if (local.ok) {
    line("PASS", "Local web health OK (http://127.0.0.1:3000).");
  } else {
    line("WARN", `Local web health unreachable (${local.error || local.status || "no response"}).`);
    line("INFO", "Remediation: start the web app: `pnpm --filter @rfid/web dev`");
  }

  if (origin.ok) {
    const remote = await fetchWithTimeout(`${origin.origin}${HEALTH_PATH}`);
    if (remote.ok) {
      line("PASS", `Tailnet health OK (${origin.origin}).`);
    } else {
      line("WARN", `Tailnet health unreachable (${remote.error || remote.status || "no response"}).`);
      line("INFO", "Remediation: confirm Serve is configured and the web app is running, then re-run doctor.");
    }
  }

  process.exit(hardFail);
}

const cmd = process.argv[2];
if (cmd === "setup") {
  setup().catch((e) => { line("FAIL", `setup error: ${e?.message || e}`); process.exit(1); });
} else if (cmd === "doctor") {
  doctor().catch((e) => { line("FAIL", `doctor error: ${e?.message || e}`); process.exit(1); });
} else {
  process.stderr.write("usage: node scripts/tailscale/tailscale.mjs <setup|doctor>\n");
  process.exit(2);
}
