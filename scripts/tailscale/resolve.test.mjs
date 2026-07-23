import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTailscaleCommand, fellBackFromPathToApp } from "./resolve.mjs";

const APP = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const APP2 = "/Users/me/Applications/Tailscale.app/Contents/MacOS/Tailscale";

// helper: build a probe from a map of path -> { exists, connects }
function probeFrom(map) {
  return (c) => map[c.path] ?? { exists: false, connects: false };
}

// --- ranking / selection --------------------------------------------------

test("prefers the first connecting candidate (app before path)", () => {
  const candidates = [
    { path: APP, source: "app" },
    { path: "tailscale", source: "path" },
  ];
  const r = resolveTailscaleCommand(candidates, probeFrom({
    [APP]: { exists: true, connects: true },
    tailscale: { exists: true, connects: true },
  }));
  assert.equal(r.command, APP);
  assert.equal(r.source, "app");
  assert.equal(r.connects, true);
  assert.equal(r.anyExists, true);
});

test("uses app CLI when PATH CLI exists but cannot connect", () => {
  const candidates = [
    { path: APP, source: "app" },
    { path: "tailscale", source: "path" },
  ];
  const r = resolveTailscaleCommand(candidates, probeFrom({
    [APP]: { exists: true, connects: true },
    tailscale: { exists: true, connects: false },
  }));
  assert.equal(r.command, APP);
  assert.equal(r.connects, true);
});

test("falls back to PATH CLI when no app candidate exists (standalone/Linux)", () => {
  const candidates = [
    { path: APP, source: "app" },
    { path: "tailscale", source: "path" },
  ];
  const r = resolveTailscaleCommand(candidates, probeFrom({
    [APP]: { exists: false, connects: false },
    tailscale: { exists: true, connects: true },
  }));
  assert.equal(r.command, "tailscale");
  assert.equal(r.source, "path");
  assert.equal(r.connects, true);
});

test("when nothing connects, returns first existing binary with connects:false", () => {
  const candidates = [
    { path: APP, source: "app" },
    { path: "tailscale", source: "path" },
  ];
  const r = resolveTailscaleCommand(candidates, probeFrom({
    [APP]: { exists: true, connects: false },
    tailscale: { exists: true, connects: false },
  }));
  assert.equal(r.command, APP);
  assert.equal(r.source, "app");
  assert.equal(r.connects, false);
  assert.equal(r.anyExists, true);
});

test("returns command:null when no candidate exists", () => {
  const candidates = [{ path: APP, source: "app" }, { path: "tailscale", source: "path" }];
  const r = resolveTailscaleCommand(candidates, probeFrom({}));
  assert.equal(r.command, null);
  assert.equal(r.source, null);
  assert.equal(r.connects, false);
  assert.equal(r.anyExists, false);
});

test("probes user-Applications app path before PATH on darwin", () => {
  const candidates = [
    { path: APP, source: "app" },
    { path: APP2, source: "app" },
    { path: "tailscale", source: "path" },
  ];
  const r = resolveTailscaleCommand(candidates, probeFrom({
    [APP]: { exists: false, connects: false },
    [APP2]: { exists: true, connects: true },
    tailscale: { exists: true, connects: true },
  }));
  assert.equal(r.command, APP2);
  assert.equal(r.source, "app");
});

test("missing probe result is treated as not-existing", () => {
  const r = resolveTailscaleCommand(
    [{ path: "tailscale", source: "path" }],
    () => null,
  );
  assert.equal(r.command, null);
  assert.equal(r.anyExists, false);
});

// --- fellBackFromPathToApp -------------------------------------------------

test("fellBackFromPathToApp: true when app connects and PATH exists-but-broken", () => {
  const candidates = [{ path: APP, source: "app" }, { path: "tailscale", source: "path" }];
  const r = resolveTailscaleCommand(candidates, probeFrom({
    [APP]: { exists: true, connects: true },
    tailscale: { exists: true, connects: false },
  }));
  assert.equal(fellBackFromPathToApp(r), true);
});

test("fellBackFromPathToApp: false when only app exists (no PATH CLI)", () => {
  const candidates = [{ path: APP, source: "app" }, { path: "tailscale", source: "path" }];
  const r = resolveTailscaleCommand(candidates, probeFrom({
    [APP]: { exists: true, connects: true },
    tailscale: { exists: false, connects: false },
  }));
  assert.equal(fellBackFromPathToApp(r), false);
});

test("fellBackFromPathToApp: false when PATH connects (no fallback happened)", () => {
  const candidates = [{ path: APP, source: "app" }, { path: "tailscale", source: "path" }];
  const r = resolveTailscaleCommand(candidates, probeFrom({
    [APP]: { exists: false, connects: false },
    tailscale: { exists: true, connects: true },
  }));
  assert.equal(fellBackFromPathToApp(r), false);
});

test("fellBackFromPathToApp: false when nothing connects", () => {
  const candidates = [{ path: APP, source: "app" }, { path: "tailscale", source: "path" }];
  const r = resolveTailscaleCommand(candidates, probeFrom({
    [APP]: { exists: true, connects: false },
    tailscale: { exists: true, connects: false },
  }));
  assert.equal(fellBackFromPathToApp(r), false);
});
