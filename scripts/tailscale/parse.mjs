// Pure helpers for parsing `tailscale status/serve/funnel --json` output.
// No Node platform side effects, no npm deps — safe to unit-test with fixtures.
//
// Source of truth for the serve/funnel JSON is the Tailscale `ipn.ServeConfig`
// struct (github.com/tailscale/tailscale/ipn/serve.go), whose Go fields marshal
// with their capitalized names because they use `json:",omitempty"` (no tag):
//   ServeConfig { TCP, Web, Services, AllowFunnel, Foreground }
//     TCP  map[uint16]*TCPPortHandler  -> {"443": {"HTTPS": true}}
//     Web  map[HostPort]*WebServerConfig
//          -> {"host:443": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:3000"}}}}
//     Services map[name]*ServiceConfig -> each has its own TCP/Web
//     AllowFunnel map[HostPort]bool     -> {"host:443": true}  (true = Funnel ON)
//     Foreground map[session]*ServeConfig -> nested serve configs (non --bg)
// ServiceConfig has TCP/Web/Tun but NO AllowFunnel (funnel is node-scoped).

/** Strip a single trailing dot from a DNS name (Tailscale DNSNames end with "."). */
export function stripTrailingDot(name) {
  if (typeof name !== "string") return "";
  return name.endsWith(".") ? name.slice(0, -1) : name;
}

/**
 * Derive the Field API origin (https URL) from `tailscale status --json`.
 * Returns { ok, origin, reason }.
 */
export function discoverFieldOrigin(statusJson) {
  if (!statusJson || typeof statusJson !== "object") {
    return { ok: false, reason: "no status object" };
  }
  const state = statusJson.BackendState;
  if (state !== "Running") {
    return { ok: false, reason: `tailscale backend is ${state || "unknown"} (not Running)` };
  }
  const userMap = statusJson.User;
  const loggedIn = userMap && typeof userMap === "object" && Object.keys(userMap).length > 0;
  if (!loggedIn) {
    return { ok: false, reason: "not signed in to Tailscale" };
  }
  const dnsName = statusJson.Self && statusJson.Self.DNSName;
  const host = stripTrailingDot(dnsName);
  if (!host) {
    return { ok: false, reason: "no Self.DNSName in status" };
  }
  return { ok: true, origin: `https://${host}` };
}

const LOCAL_3000_SCHEME = /^https?:\/\/(127\.0\.0\.1|localhost):3000\/?$/;
const LOCAL_3000_BARE = /^(127\.0\.0\.1|localhost):3000$/;

/** True iff a serve Proxy string targets exactly localhost/127.0.0.1:3000. */
export function proxiesToLocal3000(proxy) {
  if (typeof proxy !== "string") return false;
  const p = proxy.trim();
  return LOCAL_3000_SCHEME.test(p) || LOCAL_3000_BARE.test(p);
}

/** A "scope" is any config with TCP/Web maps: root ServeConfig, a ServiceConfig, or a Foreground ServeConfig. */
function scopeHasTls443(cfg) {
  const tcp = cfg && cfg.TCP;
  return !!(tcp && tcp["443"] && tcp["443"].HTTPS === true);
}

function scopeProxiesToLocal3000(cfg) {
  if (!scopeHasTls443(cfg)) return false;
  const web = cfg && cfg.Web;
  if (!web || typeof web !== "object") return false;
  return Object.values(web).some((wsc) => {
    if (!wsc || !wsc.Handlers || typeof wsc.Handlers !== "object") return false;
    return Object.values(wsc.Handlers).some((h) => h && proxiesToLocal3000(h.Proxy));
  });
}

function scopeHasMapping(cfg) {
  if (!cfg || typeof cfg !== "object") return false;
  const tcp = cfg.TCP, web = cfg.Web;
  const tcpHas = tcp && typeof tcp === "object" && Object.keys(tcp).length > 0;
  const webHas = web && typeof web === "object" && Object.keys(web).length > 0;
  return !!(tcpHas || webHas);
}

/** Collect root + every Services entry + every Foreground entry as scopes. */
function collectScopes(serveJson) {
  const scopes = [];
  if (serveJson && typeof serveJson === "object" && !Array.isArray(serveJson)) {
    scopes.push(serveJson);
    if (serveJson.Services && typeof serveJson.Services === "object") {
      Object.values(serveJson.Services).forEach((s) => scopes.push(s));
    }
    if (serveJson.Foreground && typeof serveJson.Foreground === "object") {
      Object.values(serveJson.Foreground).forEach((f) => scopes.push(f));
    }
  }
  return scopes.filter((s) => s && typeof s === "object");
}

/**
 * Classify `tailscale serve status --json` (official ServeConfig shape).
 * Returns { hasMapping, mapsToLocal3000, conflict }.
 *  - hasMapping: any serve config (TCP/Web) exists in any scope
 *  - mapsToLocal3000: some scope has TCP 443 HTTPS + a Web handler proxying to
 *    exactly http://(127.0.0.1|localhost):3000 (trailing slash ok)
 *  - conflict: hasMapping && !mapsToLocal3000  (any existing non-matching config)
 * Empty object / no config -> hasMapping=false (absent, not conflict).
 */
export function classifyServe(serveJson) {
  const scopes = collectScopes(serveJson);
  const hasMapping = scopes.some(scopeHasMapping);
  const mapsToLocal3000 = scopes.some(scopeProxiesToLocal3000);
  return { hasMapping, mapsToLocal3000, conflict: hasMapping && !mapsToLocal3000 };
}

/**
 * Classify Funnel state from `tailscale funnel status --json` (a ServeConfig,
 * possibly empty `{}`). Returns { state: "off"|"on"|"unknown", reason }.
 *
 * `cliOk` is whether the `funnel status` command exited 0. A nonzero exit or
 * unparseable output is "unknown" (NOT silently "off") — per the safety rule that
 * an error must not be treated as Funnel-off when the daemon may be running.
 */
export function classifyFunnel(funnelJson, cliOk) {
  if (cliOk === false) {
    return { state: "unknown", reason: "tailscale funnel status failed (nonzero exit)" };
  }
  if (funnelJson === null || funnelJson === undefined) {
    return { state: "unknown", reason: "no JSON from tailscale funnel status" };
  }
  if (typeof funnelJson === "object") {
    const isEmpty =
      (Array.isArray(funnelJson) && funnelJson.length === 0) ||
      (!Array.isArray(funnelJson) && Object.keys(funnelJson).length === 0);
    if (isEmpty) return { state: "off" };
    // AllowFunnel: map[HostPort]bool — any true => Funnel ON.
    const allow = funnelJson.AllowFunnel;
    if (allow && typeof allow === "object") {
      if (Object.values(allow).some((v) => v === true)) {
        return { state: "on" };
      }
    }
    // Foreground configs may carry their own AllowFunnel.
    const fg = funnelJson.Foreground;
    if (fg && typeof fg === "object") {
      const onInFg = Object.values(fg).some((sub) => {
        if (!sub || !sub.AllowFunnel) return false;
        return Object.values(sub.AllowFunnel).some((v) => v === true);
      });
      if (onInFg) return { state: "on" };
    }
    // Non-empty config with no AllowFunnel entry => Funnel is off.
    return { state: "off" };
  }
  return { state: "unknown", reason: "unrecognized funnel status shape" };
}
