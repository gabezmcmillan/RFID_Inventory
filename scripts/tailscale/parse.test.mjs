import { test } from "node:test";
import assert from "node:assert/strict";
import {
  stripTrailingDot,
  discoverFieldOrigin,
  classifyServe,
  classifyFunnel,
  proxiesToLocal3000,
} from "./parse.mjs";

// --- status / origin -------------------------------------------------------

test("stripTrailingDot removes a single trailing dot", () => {
  assert.equal(stripTrailingDot("machine.tailnet.ts.net."), "machine.tailnet.ts.net");
  assert.equal(stripTrailingDot("machine.ts.net"), "machine.ts.net");
  assert.equal(stripTrailingDot(""), "");
  assert.equal(stripTrailingDot(null), "");
});

test("discoverFieldOrigin derives https URL when running + signed in", () => {
  const status = {
    BackendState: "Running",
    User: { "1": { LoginName: "me@example.com" } },
    Self: { DNSName: "jamess-macbook-pro.tailc66d9.ts.net." },
  };
  const r = discoverFieldOrigin(status);
  assert.equal(r.ok, true);
  assert.equal(r.origin, "https://jamess-macbook-pro.tailc66d9.ts.net");
});

test("discoverFieldOrigin fails when backend not Running", () => {
  const r = discoverFieldOrigin({ BackendState: "Stopped", User: { "1": {} }, Self: { DNSName: "x.ts.net." } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /Stopped/);
});

test("discoverFieldOrigin fails when not signed in", () => {
  const r = discoverFieldOrigin({ BackendState: "Running", User: {}, Self: { DNSName: "x.ts.net." } });
  assert.equal(r.ok, false);
  assert.match(r.reason, /signed in/);
});

test("discoverFieldOrigin fails when no DNSName", () => {
  const r = discoverFieldOrigin({ BackendState: "Running", User: { "1": {} }, Self: {} });
  assert.equal(r.ok, false);
  assert.match(r.reason, /DNSName/);
});

// --- proxiesToLocal3000 ----------------------------------------------------

test("proxiesToLocal3000 accepts scheme + optional trailing slash + bare host:port", () => {
  assert.equal(proxiesToLocal3000("http://127.0.0.1:3000"), true);
  assert.equal(proxiesToLocal3000("http://127.0.0.1:3000/"), true);
  assert.equal(proxiesToLocal3000("http://localhost:3000/"), true);
  assert.equal(proxiesToLocal3000("127.0.0.1:3000"), true);
  assert.equal(proxiesToLocal3000("localhost:3000"), true);
  assert.equal(proxiesToLocal3000("http://127.0.0.1:8080"), false);
  assert.equal(proxiesToLocal3000("http://example.com:3000"), false);
  assert.equal(proxiesToLocal3000("3000"), false);
  assert.equal(proxiesToLocal3000(null), false);
});

// --- classifyServe: official root legacy shapes ----------------------------

test("classifyServe: empty config is absent (not conflict)", () => {
  const r = classifyServe({});
  assert.equal(r.hasMapping, false);
  assert.equal(r.mapsToLocal3000, false);
  assert.equal(r.conflict, false);
});

test("classifyServe: null is absent", () => {
  const r = classifyServe(null);
  assert.equal(r.hasMapping, false);
  assert.equal(r.conflict, false);
});

test("classifyServe: root legacy healthy config (TCP 443 HTTPS + Web proxy to 127.0.0.1:3000)", () => {
  const serve = {
    TCP: { "443": { HTTPS: true } },
    Web: { "machine.tailnet.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } },
  };
  const r = classifyServe(serve);
  assert.equal(r.hasMapping, true);
  assert.equal(r.mapsToLocal3000, true);
  assert.equal(r.conflict, false);
});

test("classifyServe: root legacy healthy config with trailing slash + localhost", () => {
  const serve = {
    TCP: { "443": { HTTPS: true } },
    Web: { "machine.ts.net:443": { Handlers: { "/": { Proxy: "http://localhost:3000/" } } } },
  };
  const r = classifyServe(serve);
  assert.equal(r.mapsToLocal3000, true);
  assert.equal(r.conflict, false);
});

test("classifyServe: root legacy conflicting proxy (wrong backend)", () => {
  const serve = {
    TCP: { "443": { HTTPS: true } },
    Web: { "machine.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8080" } } } },
  };
  const r = classifyServe(serve);
  assert.equal(r.hasMapping, true);
  assert.equal(r.mapsToLocal3000, false);
  assert.equal(r.conflict, true);
});

test("classifyServe: root TCP HTTPS with no Web handler -> conflict", () => {
  const serve = { TCP: { "443": { HTTPS: true } } };
  const r = classifyServe(serve);
  assert.equal(r.hasMapping, true);
  assert.equal(r.mapsToLocal3000, false);
  assert.equal(r.conflict, true);
});

test("classifyServe: Web proxy without TCP 443 HTTPS -> conflict (not a valid HTTPS mapping)", () => {
  const serve = {
    TCP: { "80": { HTTP: true } },
    Web: { "machine.ts.net:80": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } },
  };
  const r = classifyServe(serve);
  assert.equal(r.hasMapping, true);
  assert.equal(r.mapsToLocal3000, false);
  assert.equal(r.conflict, true);
});

// --- classifyServe: nested Services shapes --------------------------------

test("classifyServe: nested Services healthy config", () => {
  const serve = {
    Services: {
      "svc:web": {
        TCP: { "443": { HTTPS: true } },
        Web: { "svc:web.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } },
      },
    },
  };
  const r = classifyServe(serve);
  assert.equal(r.hasMapping, true);
  assert.equal(r.mapsToLocal3000, true);
  assert.equal(r.conflict, false);
});

test("classifyServe: nested Services conflicting proxy", () => {
  const serve = {
    Services: {
      "svc:web": {
        TCP: { "443": { HTTPS: true } },
        Web: { "svc:web.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:9090" } } } },
      },
    },
  };
  const r = classifyServe(serve);
  assert.equal(r.hasMapping, true);
  assert.equal(r.mapsToLocal3000, false);
  assert.equal(r.conflict, true);
});

test("classifyServe: Foreground (non --bg) healthy config is detected", () => {
  const serve = {
    Foreground: {
      "sess-1": {
        TCP: { "443": { HTTPS: true } },
        Web: { "machine.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } },
      },
    },
  };
  const r = classifyServe(serve);
  assert.equal(r.hasMapping, true);
  assert.equal(r.mapsToLocal3000, true);
  assert.equal(r.conflict, false);
});

// --- classifyFunnel: official AllowFunnel shapes --------------------------

test("classifyFunnel: empty object + cliOk => off", () => {
  assert.equal(classifyFunnel({}, true).state, "off");
});

test("classifyFunnel: AllowFunnel host:443 true => on", () => {
  const f = { AllowFunnel: { "machine.ts.net:443": true } };
  assert.equal(classifyFunnel(f, true).state, "on");
});

test("classifyFunnel: AllowFunnel present but false => off", () => {
  const f = { AllowFunnel: { "machine.ts.net:443": false } };
  assert.equal(classifyFunnel(f, true).state, "off");
});

test("classifyFunnel: full ServeConfig with AllowFunnel true => on", () => {
  const f = {
    TCP: { "443": { HTTPS: true } },
    Web: { "machine.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } },
    AllowFunnel: { "machine.ts.net:443": true },
  };
  assert.equal(classifyFunnel(f, true).state, "on");
});

test("classifyFunnel: Foreground config with AllowFunnel true => on", () => {
  const f = { Foreground: { "s1": { AllowFunnel: { "machine.ts.net:443": true } } } };
  assert.equal(classifyFunnel(f, true).state, "on");
});

test("classifyFunnel: ServeConfig without AllowFunnel => off", () => {
  const f = { TCP: { "443": { HTTPS: true } }, Web: { "machine.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } } };
  assert.equal(classifyFunnel(f, true).state, "off");
});

test("classifyFunnel: nonzero CLI exit => unknown (NOT off)", () => {
  const r = classifyFunnel(null, false);
  assert.equal(r.state, "unknown");
  assert.match(r.reason, /nonzero/);
});

test("classifyFunnel: cliOk but null JSON => unknown (NOT off)", () => {
  // Daemon may be running but produced no parseable JSON — must not assume off.
  const r = classifyFunnel(null, true);
  assert.equal(r.state, "unknown");
  assert.match(r.reason, /no JSON/);
});

test("classifyFunnel: unrecognized shape => unknown", () => {
  const r = classifyFunnel("not-an-object", true);
  assert.equal(r.state, "unknown");
});
