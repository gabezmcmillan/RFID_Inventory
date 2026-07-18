// ---------------------------------------------------------------------------
// RFID Inventory frontend
// ---------------------------------------------------------------------------
const MODE_TITLES = {
  checkin: "Check In", checkout: "Check Out",
  inventory: "Sweep & Count", warehouse: "Warehouse", finder: "Find a Tag",
  boldocs: "BOL Documents", requests: "Material Requests",
  eventlog: "Event Log", admin: "Admin",
};
const VIEWS = ["checkin-view", "checkout-view", "inventory-view",
               "warehouse-view", "finder-view", "boldocs-view",
               "requests-view", "eventlog-view", "admin-view"];

// Tag fields an admin may edit (key, label, input type).
const EDIT_FIELDS = [
  { key: "item_type", label: "Type", type: "text" },
  { key: "item_name", label: "Item Name", type: "text" },
  { key: "bol_number", label: "BOL #", type: "text" },
  { key: "po_number", label: "PO #", type: "text" },
  { key: "building", label: "Building #", type: "building" },
  { key: "sector", label: "Sector", type: "text" },
  { key: "vendor", label: "Vendor", type: "vendor" },
  { key: "sku", label: "SKU", type: "text" },
  { key: "mfc_date", label: "Mfc date", type: "date" },
  { key: "quantity", label: "Quantity (box size)", type: "number" },
  { key: "remaining", label: "Units remaining", type: "number" },
  { key: "status", label: "Status", type: "status" },
];

// Finder audio/visual tuning.
const FINDER_TONE_MIN_HZ = 300;    // tone pitch when a signal first appears
const FINDER_TONE_MAX_HZ = 1600;   // tone pitch right on the tag
const FINDER_PROX_ALPHA = 0.5;     // EMA smoothing for proximity (higher = snappier)
const FINDER_BAR_SHOW = 0.45;      // bar appears once smoothed prox passes this
const FINDER_BAR_RED = 0.85;       // bar turns red (and lock fires) at/above this
const FINDER_FOUND_PROX = 0.85;    // enter "found" above this smoothed prox
const FINDER_REARM_PROX = 0.6;     // re-arm (allow another buzz) below this
const FINDER_MIN_SAMPLES = 5;      // readings required before "found" can fire
const FINDER_SIGNAL_STALE_MS = 350; // mute tone if no reads for this long

const state = {
  config: { item_types: [], type_fields: {}, power_min: 10, power_max: 29 },
  mode: null,          // active UI mode
  selectedType: null,
  shipment: null,
  bolDoc: null,        // active truckload's BOL document {id, bol_number, ...}
  bolManual: false,    // no document: operator types the BOL # (legacy flow)
  whGroupBy: "bol",    // warehouse grouping dimension
  whFilters: { bol: "", building: "", received_from: "", received_to: "",
               checked_out_from: "", checked_out_to: "" },
  sweep: null,         // sweep session accumulator (see newSweepSession)
  pendingCheckout: null, // checkout_prompt currently awaiting confirmation
  activeRequest: null, // material request being fulfilled in checkout mode
  stagedDraws: [],     // staged checkout draws for it [{epc, amount, building, ...}]
  eventFilter: "all",  // event-log filter category
  finder: null,        // {epc, rssiMin, rssiMax, proxEma, samples, found}
  admin: { pin: null, editMode: false },
  vendors: [],         // dropdown options, managed in Admin
  sync: null,          // last sync_status message {enabled, online, ...}
  readerConnected: null,          // last known connection state
  readerLastConnectedAt: null,    // Date of most recent connect
  readerLastDisconnectedAt: null, // Date of most recent disconnect
};

let powerSendTimer = null;
let itemSendTimer = null;
let finderAudioCtx = null;
let finderOsc = null;          // persistent oscillator for the sweeping tone
let finderGain = null;         // its gain (0 = silent)
let finderStaleTimer = null;   // mutes the tone when reads stop
let finderLastSignal = 0;      // performance.now() of the last finder event

const $ = (id) => document.getElementById(id);

// -- theme (light / dark) -----------------------------------------------------
// The saved choice is also applied by an inline <head> script before first
// paint; this section keeps the toggle button in sync and handles clicks.
const THEME_KEY = "rfid-theme";

function applyTheme(theme) {
  if (theme === "dark") {
    document.documentElement.dataset.theme = "dark";
  } else {
    delete document.documentElement.dataset.theme;
  }
  const btn = $("theme-toggle");
  const label = theme === "dark"
    ? "\u2600\ufe0e Light"   // sun (text-style): switches back to light
    : "\u263e Dark";         // moon: switches to dark
  btn.textContent = label;
  const tip = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
  btn.setAttribute("aria-label", tip);
  btn.title = tip;
}

function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch (e) { /* private mode */ }
  const theme = saved ||
    (window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark" : "light");
  applyTheme(theme);
  $("theme-toggle").onclick = () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* private mode */ }
    applyTheme(next);
  };
}

initTheme();

// -- boot --------------------------------------------------------------------
async function boot() {
  state.config = await (await fetch("/api/config")).json();
  initPowerBounds();
  await loadVendors();
  await refreshStatus();
  connectWS();
  wireUI();
}

async function loadVendors() {
  try {
    const data = await (await fetch("/api/vendors")).json();
    state.vendors = data.vendors || [];
  } catch (e) { /* keep whatever we have */ }
}

// -- field helpers -----------------------------------------------------------
function fieldsForScope(type, scope) {
  return (state.config.type_fields[type] || [])
    .filter((f) => (f.scope || "shipment") === scope);
}

// -- reader power slider -----------------------------------------------------
function initPowerBounds() {
  const slider = $("power-slider");
  if (state.config.power_min != null) slider.min = state.config.power_min;
  if (state.config.power_max != null) slider.max = state.config.power_max;
}
function setPowerSlider(dbm) {
  $("power-slider").value = dbm;
  $("power-value").textContent = dbm;
}
function onPowerInput() {
  const dbm = parseInt($("power-slider").value, 10);
  $("power-value").textContent = dbm;
  clearTimeout(powerSendTimer);
  powerSendTimer = setTimeout(() => sendPower(dbm), 150);
}
async function sendPower(dbm) {
  try {
    const res = await fetch("/api/power", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dbm }),
    });
    const data = await res.json();
    if (data.ok && data.check_power != null) setPowerSlider(data.check_power);
  } catch (e) { logActivity("Could not set reader power", "err"); }
}

async function refreshStatus() {
  try {
    const s = await (await fetch("/api/status")).json();
    setReaderPill(s.reader_connected);
    setDbPill(s.db_connected, s.db_error);
    if (s.check_power != null) setPowerSlider(s.check_power);
    if (s.sync) setSyncPill(s.sync);
    if (s.requests_pending != null) updateRequestsBadge(s.requests_pending);
  } catch (e) { /* ignore */ }
}

// -- websocket ---------------------------------------------------------------
function connectWS() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = (ev) => handleMessage(JSON.parse(ev.data));
  ws.onclose = () => setTimeout(connectWS, 1500);
  ws.onopen = () => setInterval(() => { try { ws.send("ping"); } catch (e) {} }, 20000);
}

function handleMessage(msg) {
  switch (msg.type) {
    case "reader_status": {
      const now = new Date();
      const changed = state.readerConnected !== msg.connected;
      if (changed) {
        if (msg.connected) state.readerLastConnectedAt = now;
        else state.readerLastDisconnectedAt = now;
      }
      state.readerConnected = msg.connected;
      setReaderPill(msg.connected);
      updateReaderStatusDisplay();
      if (msg.server_greeting) {
        // Confirms the browser-to-server link, not the reader state.
        logActivity(msg.message, "ok");
      } else if (changed && msg.message) {
        logActivity(msg.message, msg.connected ? "ok" : "err");
      }
      break;
    }
    case "live":
      $("live-count").textContent = msg.distinct;
      $("scanner-title").textContent = "Reading\u2026";
      break;
    case "checkin_result": onCheckinResult(msg); break;
    case "checkout_prompt": handleCheckoutScan(msg); break;
    case "checkout_result": onCheckoutResult(msg); break;
    case "inventory_result": onInventoryResult(msg); break;
    case "finder": onFinder(msg); break;
    case "finder_reset": onFinderReset(); break;
    case "sync_status": onSyncStatus(msg); break;
    case "requests_update": onRequestsUpdate(msg); break;
    case "error":
      logActivity(msg.message, "err");
      showResult("err", "Error", `<p>${escapeHtml(msg.message)}</p>`);
      break;
  }
}

// -- status pills ------------------------------------------------------------
function setReaderPill(on) {
  const p = $("reader-pill");
  p.className = "pill " + (on ? "pill-on" : "pill-off");
  p.textContent = on ? "Reader online" : "Reader offline";
}
function setDbPill(on, err) {
  const p = $("db-pill");
  p.className = "pill " + (on ? "pill-on" : "pill-off");
  p.textContent = on ? "Database ready" : "Database offline";
  if (!on && err) p.title = err;
}

// Cloud-sync pill. Offline is normal for this app, so the pill stays calm:
// gray when sync isn't configured, green when the last exchange worked, red
// when the cloud is unreachable (with detail in the tooltip).
function setSyncPill(sync) {
  state.sync = sync;
  const p = $("sync-pill");
  if (!p) return;
  if (!sync || !sync.enabled) {
    p.className = "pill pill-idle";
    p.textContent = "Sync off";
    p.title = "Cloud sync is not configured (set cloud_url in settings.ini). " +
      "The app works fully standalone.";
    return;
  }
  const pending = sync.pending || 0;
  const lastTxt = sync.last_sync
    ? `Last synced ${fmtDateTime(sync.last_sync)}` : "Never synced yet";
  const pendTxt = pending ? ` \u00b7 ${pending} change(s) pending` : "";
  if (sync.online) {
    p.className = "pill pill-on";
    p.textContent = pending ? `Sync (${pending})` : "Sync ok";
    p.title = `${lastTxt}${pendTxt} \u00b7 click to sync now`;
  } else {
    p.className = "pill pill-off";
    p.textContent = pending ? `Sync offline (${pending})` : "Sync offline";
    p.title = `${sync.error || "Cloud unreachable"} \u00b7 ${lastTxt}${pendTxt}` +
      " \u00b7 changes are safe locally and will sync when back online";
  }
  updateSyncDetail();
}

function onSyncStatus(msg) {
  const wasError = state.sync && state.sync.enabled && !state.sync.online;
  setSyncPill(msg);
  // Log transitions (not every 30s heartbeat): going offline / coming back.
  if (msg.enabled && !msg.online && !wasError && msg.error) {
    logActivity(`Cloud sync: ${msg.error}`, "warn");
  } else if (msg.enabled && msg.online && wasError) {
    logActivity("Cloud sync restored \u2014 caught up", "ok");
  }
}

function onRequestsUpdate(msg) {
  if (msg.pending != null) updateRequestsBadge(msg.pending);
  if (msg.added) {
    logActivity(`${msg.added} new material request(s) from the cloud`, "ok");
  }
  if (state.mode === "requests") loadRequests();
}

function updateRequestsBadge(n) {
  const b = $("requests-card-badge");
  if (!b) return;
  b.textContent = n;
  b.classList.toggle("hidden", !n);
}

// -- view helpers ------------------------------------------------------------
function showView(id) { VIEWS.forEach((v) => hide(v)); show(id); }

// -- mode navigation ---------------------------------------------------------
async function openMode(mode, opts = {}) {
  state.mode = mode;
  state.selectedType = null;
  state.pendingCheckout = null;
  hideModal();
  $("mode-picker").classList.add("hidden");
  $("panel").classList.remove("hidden");
  $("panel-title").textContent = MODE_TITLES[mode];
  hide("result"); hide("scanner"); hide("item-form");
  showView(`${mode}-view`);

  // Check-in/check-out run at the reader's minimum power (tag at the reader
  // only); inventory runs at full power. The slider stays hidden everywhere.
  hide("power-control");

  if (mode === "checkin") {
    state.shipment = null;
    await loadVendors();
    renderTypeButtons();
    hide("checkin-form"); hide("arm-btn"); hide("finish-btn");
    hide("item-form"); hide("shipment-notes");
    renderBolStage();
    await setServerMode("idle");
  } else if (mode === "checkout") {
    await setServerMode("checkout");
    renderRequestBanner();
    showScanner(state.activeRequest
      ? "Scan a box to stage it for this request"
      : "Ready \u2014 pull the trigger to deliver to site");
  } else if (mode === "inventory") {
    resetSweepSession();
    await setServerMode("inventory");
    showScanner("Hold the trigger to sweep\u2026");
  } else if (mode === "warehouse") {
    await setServerMode("idle");
    $("wh-edit-banner").classList.toggle("hidden", !isEditing());
    await loadWarehouse();
  } else if (mode === "boldocs") {
    await setServerMode("idle");
    await loadBolDocs();
  } else if (mode === "requests") {
    await setServerMode("idle");
    updateSyncDetail();
    await loadRequests();
  } else if (mode === "eventlog") {
    await setServerMode("idle");
    state.eventFilter = "all";
    $("event-epc").value = opts.epc || "";
    document.querySelectorAll("#event-filter .seg-btn").forEach((b) =>
      b.classList.toggle("active", b.dataset.filter === "all"));
    await loadEvents();
  } else if (mode === "admin") {
    await setServerMode("idle");
    renderAdmin();
  }
}

async function backToModes() {
  await setServerMode("idle");
  stopFinderTone();
  state.mode = null;
  state.finder = null;
  state.sweep = null;
  state.pendingCheckout = null;
  hideModal();
  state.admin.editMode = false;
  $("wh-edit-banner").classList.add("hidden");
  $("panel").classList.add("hidden");
  $("mode-picker").classList.remove("hidden");
  hide("power-control");
}

function isEditing() {
  return Boolean(state.admin.pin && state.admin.editMode);
}

async function setServerMode(mode, extra = {}) {
  try {
    const res = await fetch("/api/mode", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, ...extra }),
    });
    const data = await res.json();
    if (!data.ok) logActivity(data.message || "Mode change failed", "err");
    return data.ok;
  } catch (e) {
    logActivity("Cannot reach server", "err");
    return false;
  }
}

// -- bill of lading (check-in step 1) ------------------------------------------
// A truckload starts by capturing its bill of lading: scan it on the document
// scanner (or upload a PDF), and every box received while it is active is
// filed under that document. Manual BOL # entry remains as a fallback.
function renderBolStage() {
  const active = Boolean(state.bolDoc || state.bolManual);
  $("bol-gate").classList.toggle("hidden", active);
  $("bol-banner").classList.toggle("hidden", !active);
  $("checkin-main").classList.toggle("hidden", !active);
  if (active) renderBolBanner();
  else loadRecentBols();
}

function renderBolBanner() {
  const el = $("bol-banner");
  const d = state.bolDoc;
  if (d) {
    const pages = d.pages === 1 ? "1 page" : `${d.pages} pages`;
    const how = d.source === "upload" ? "Uploaded" : "Scanned";
    // What OCR pulled off the document. Guesses, not gospel: the operator
    // should check them against the paper copy (both prefill the form below
    // and stay editable there).
    const vendorTxt = d.vendor
      ? `<strong>${escapeHtml(d.vendor)}</strong>` : "not detected";
    const poTxt = d.po_number
      ? `<strong>${escapeHtml(d.po_number)}</strong>` : "not detected";
    const ocrLine = `
      <span class="hint bol-ocr-line">Read from document: Vendor ${vendorTxt}
        \u00b7 PO # ${poTxt} \u2014 verify below before arming.</span>`;
    el.innerHTML = `
      <div class="bol-banner-main">
        <span class="bol-banner-label">Truckload BOL</span>
        <strong>${escapeHtml(d.bol_number)}</strong>
        <span class="hint">${how} ${escapeHtml(fmtDateTime(d.created_at))} \u00b7 ${pages}</span>
        ${ocrLine}
      </div>
      <div class="bol-banner-actions">
        <a class="back-btn bol-view-link" href="/api/bol/${d.id}/file" target="_blank">View PDF</a>
        <button id="bol-rename-btn" class="back-btn">Rename</button>
        <button id="bol-addpage-btn" class="back-btn">Add page</button>
        <button id="bol-done-btn" class="back-btn">Done with truckload</button>
      </div>`;
    $("bol-rename-btn").onclick = renderBolRename;
    $("bol-addpage-btn").onclick = addBolPage;
  } else {
    el.innerHTML = `
      <div class="bol-banner-main">
        <span class="bol-banner-label">No BOL document</span>
        <strong>Manual entry</strong>
        <span class="hint">Type the BOL number into the shipment form below.</span>
      </div>
      <div class="bol-banner-actions">
        <button id="bol-done-btn" class="back-btn">Done with truckload</button>
      </div>`;
  }
  $("bol-done-btn").onclick = endTruckload;
}

// Inline rename: swap the banner for an input; saving also updates any boxes
// already checked in under this document (server side).
function renderBolRename() {
  const d = state.bolDoc;
  if (!d) return;
  const el = $("bol-banner");
  el.innerHTML = `
    <div class="bol-banner-main bol-rename-row">
      <span class="bol-banner-label">BOL number (as printed on the document)</span>
      <input id="bol-rename-input" type="text" value="${escapeHtml(d.bol_number)}" />
    </div>
    <div class="bol-banner-actions">
      <button id="bol-rename-save" class="primary-btn bol-rename-save">Save</button>
      <button id="bol-rename-cancel" class="back-btn">Cancel</button>
    </div>`;
  const input = $("bol-rename-input");
  input.focus();
  input.select();
  const save = async () => {
    const name = input.value.trim();
    if (!name || name === d.bol_number) { renderBolBanner(); return; }
    try {
      const res = await fetch("/api/bol/rename", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: d.id, bol_number: name }),
      });
      const data = await res.json();
      if (data.ok) {
        state.bolDoc = data.doc;
        logActivity(data.message +
          (data.tags_updated ? ` ${data.tags_updated} box(es) updated.` : ""), "ok");
        syncBolIntoCheckin();
      } else {
        logActivity(data.message || "Rename failed", "err");
      }
    } catch (e) {
      logActivity("Cannot reach server", "err");
    }
    renderBolBanner();
  };
  $("bol-rename-save").onclick = save;
  $("bol-rename-cancel").onclick = renderBolBanner;
  input.onkeydown = (e) => {
    if (e.key === "Enter") save();
    if (e.key === "Escape") renderBolBanner();
  };
}

// Push the (renamed) BOL number into the shipment form and, if a shipment is
// already armed, re-arm it so the reader files subsequent tags correctly.
async function syncBolIntoCheckin() {
  applyBolToForm();
  if (state.shipment && state.bolDoc) {
    state.shipment.fields.bol_number = state.bolDoc.bol_number;
    state.shipment.fields.bol_doc_id = String(state.bolDoc.id);
    await setServerMode("checkin",
      { item_type: state.shipment.type, fields: state.shipment.fields });
    // Re-arming clears the reader's per-unit fields; restore what's typed in.
    await postItemFields();
  }
}

async function scanBolNew() {
  const btn = $("bol-scan-btn");
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = "Scanning\u2026 feed the document into the scanner";
  logActivity("Scanning bill of lading\u2026", "ok");
  try {
    const res = await fetch("/api/bol/scan", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const data = await res.json();
    if (data.ok) {
      state.bolDoc = data.doc;
      state.bolManual = false;
      hide("result");
      logActivity(`BOL scanned: ${data.doc.bol_number}`, "ok");
      renderBolStage();
    } else {
      logActivity(data.message || "Scan failed", "err");
      await showScanFailure(data.message);
    }
  } catch (e) {
    logActivity("Cannot reach server", "err");
  }
  btn.disabled = false;
  btn.textContent = orig;
}

// Scan failed: show the error plus a scanner health check to point at the fix.
async function showScanFailure(message) {
  let extra = "";
  try {
    const s = await (await fetch("/api/scanner/status")).json();
    if (s && s.message && s.message !== message) {
      extra += `<p class="hint">${escapeHtml(s.message)}</p>`;
    }
    if (s && s.devices && s.devices.length) {
      extra += `<p class="hint">Scanners visible: ${escapeHtml(s.devices.join(", "))}</p>`;
    }
  } catch (e) { /* health check is best effort */ }
  showResult("err", "Could not scan the bill of lading",
    `<p>${escapeHtml(message || "Scan failed.")}</p>${extra}
     <p class="hint">You can also upload the BOL as a PDF, or enter its number manually.</p>`);
}

async function addBolPage() {
  const d = state.bolDoc;
  if (!d) return;
  const btn = $("bol-addpage-btn");
  if (btn) { btn.disabled = true; btn.textContent = "Scanning\u2026"; }
  logActivity("Scanning another BOL page\u2026", "ok");
  try {
    const res = await fetch("/api/bol/scan", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ append_to: d.id }),
    });
    const data = await res.json();
    if (data.ok) {
      state.bolDoc = data.doc;
      logActivity(`Added a page to ${data.doc.bol_number} (now ${data.doc.pages} pages)`, "ok");
      // Re-running OCR over the fuller document may have filled in the BOL
      // number (while still auto-named) or vendor/PO; push that into the form
      // and any armed shipment.
      await syncBolIntoCheckin();
    } else {
      logActivity(data.message || "Scan failed", "err");
      await showScanFailure(data.message);
    }
  } catch (e) {
    logActivity("Cannot reach server", "err");
  }
  renderBolBanner();
}

async function onBolUploadChange() {
  const input = $("bol-upload-input");
  const file = input.files && input.files[0];
  input.value = "";
  if (!file) return;
  const fd = new FormData();
  fd.append("file", file);
  logActivity(`Uploading ${file.name}\u2026`, "ok");
  try {
    const res = await fetch("/api/bol/upload", { method: "POST", body: fd });
    const data = await res.json();
    if (data.ok) {
      state.bolDoc = data.doc;
      state.bolManual = false;
      hide("result");
      logActivity(`BOL uploaded: ${data.doc.bol_number}`, "ok");
      renderBolStage();
    } else {
      logActivity(data.message || "Upload failed", "err");
      showResult("err", "Upload failed", `<p>${escapeHtml(data.message || "")}</p>`);
    }
  } catch (e) {
    logActivity("Cannot reach server", "err");
  }
}

function startManualBol() {
  state.bolDoc = null;
  state.bolManual = true;
  hide("result");
  renderBolStage();
}

// Recent documents shown on the gate, so a truckload survives a page refresh.
async function loadRecentBols() {
  const wrap = $("bol-recent");
  wrap.innerHTML = "";
  let docs = [];
  try {
    docs = (await (await fetch("/api/bol/docs")).json()).docs || [];
  } catch (e) { return; }
  if (!docs.length) return;
  const items = docs.slice(0, 6).map((d) =>
    `<button class="bol-recent-item" data-id="${d.id}">
       <strong>${escapeHtml(d.bol_number)}</strong>
       <span>${escapeHtml(fmtDateTime(d.created_at))} \u00b7 ${d.pages} page(s)
         \u00b7 ${d.boxes} box(es) checked in</span>
     </button>`).join("");
  wrap.innerHTML = `
    <div class="bol-recent-head">Recent truckloads \u2014 tap one to resume</div>
    <div class="bol-recent-list">${items}</div>`;
  const byId = new Map(docs.map((d) => [String(d.id), d]));
  wrap.querySelectorAll(".bol-recent-item").forEach((b) => {
    b.onclick = () => {
      const doc = byId.get(b.dataset.id);
      if (!doc) return;
      state.bolDoc = doc;
      state.bolManual = false;
      renderBolStage();
    };
  });
}

// Finish the whole truckload: disarm, clear the active document, back to gate.
async function endTruckload() {
  await finishCheckin();
  state.bolDoc = null;
  state.bolManual = false;
  state.selectedType = null;
  document.querySelectorAll(".type-btn").forEach((b) => b.classList.remove("active"));
  hide("checkin-form"); hide("arm-btn"); hide("result");
  renderBolStage();
}

// -- BOL documents view ----------------------------------------------------------
// Every scanned/uploaded bill of lading, newest first, with its PDF and the
// number of boxes filed under it. Deleting is PIN-gated: it removes the
// document record and PDF file but leaves the boxes themselves in inventory.
async function loadBolDocs() {
  const wrap = $("bol-docs-list");
  wrap.innerHTML = `<p class="hint">Loading\u2026</p>`;
  let docs = [];
  try {
    docs = (await (await fetch("/api/bol/docs?limit=0")).json()).docs || [];
  } catch (e) {
    wrap.innerHTML = `<p class="hint">Could not load BOL documents.</p>`;
    return;
  }
  renderBolDocs(docs);
}

function renderBolDocs(docs) {
  const wrap = $("bol-docs-list");
  if (!docs.length) {
    wrap.innerHTML = `<p class="hint">No bills of lading yet \u2014 scan or
      upload one from Check In.</p>`;
    return;
  }
  const rows = docs.map((d) => `
    <tr>
      <td><strong>${escapeHtml(d.bol_number)}</strong></td>
      <td>${escapeHtml(d.vendor || "")}</td>
      <td>${escapeHtml(d.po_number || "")}</td>
      <td>${d.source === "upload" ? "Uploaded" : "Scanned"}</td>
      <td class="qty-cell">${d.pages}</td>
      <td class="qty-cell">${d.boxes}</td>
      <td>${escapeHtml(fmtDateTime(d.created_at))}</td>
      <td class="wh-actions bol-docs-actions">
        <a class="bol-pdf-btn bol-view-link" href="/api/bol/${d.id}/file"
          target="_blank">View PDF</a>
        <button class="bol-pdf-btn bol-doc-rename-btn" data-id="${d.id}">Rename</button>
        <button class="danger-btn bol-del-btn" data-id="${d.id}">Delete</button>
      </td>
    </tr>`).join("");
  wrap.innerHTML = `<table class="wh-tag-table bol-docs-table">
      <thead><tr><th>BOL #</th><th>Vendor</th><th>PO #</th><th>Source</th>
        <th>Pages</th><th>Boxes</th><th>Added</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  const byId = new Map(docs.map((d) => [String(d.id), d]));
  wrap.querySelectorAll(".bol-doc-rename-btn").forEach((b) => {
    b.onclick = () => startBolDocRename(b.closest("tr"), byId.get(b.dataset.id));
  });
  wrap.querySelectorAll(".bol-del-btn").forEach((b) => {
    b.onclick = () => confirmDeleteBolDoc(byId.get(b.dataset.id));
  });
}

// Inline rename, mirroring the check-in banner: the BOL # cell becomes an
// input and the row's actions swap to Save/Cancel. Uses the same endpoint as
// the banner, so boxes already filed under the document follow the new
// number server-side. Not PIN-gated (same trust level as the banner rename).
function startBolDocRename(row, doc) {
  if (!row || !doc) return;
  const nameCell = row.cells[0];
  const actionsCell = row.cells[row.cells.length - 1];
  nameCell.innerHTML = `<input class="bol-doc-rename-input" type="text"
    value="${escapeHtml(doc.bol_number)}" maxlength="120"
    title="BOL number as printed on the document" />`;
  actionsCell.innerHTML = `
    <button class="primary-btn bol-doc-rename-save">Save</button>
    <button class="back-btn bol-doc-rename-cancel">Cancel</button>`;
  const input = nameCell.querySelector("input");
  input.focus();
  input.select();
  const save = async () => {
    const name = input.value.trim();
    if (!name || name === doc.bol_number) { await loadBolDocs(); return; }
    try {
      const res = await fetch("/api/bol/rename", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: doc.id, bol_number: name }),
      });
      const data = await res.json();
      if (data.ok) {
        logActivity(data.message +
          (data.tags_updated ? ` ${data.tags_updated} box(es) updated.` : ""), "ok");
        // Keep the active check-in truckload in sync if it's this document.
        if (state.bolDoc && state.bolDoc.id === doc.id) state.bolDoc = data.doc;
      } else {
        logActivity(data.message || "Rename failed", "err");
      }
    } catch (e) {
      logActivity("Cannot reach server", "err");
    }
    await loadBolDocs();
  };
  actionsCell.querySelector(".bol-doc-rename-save").onclick = save;
  actionsCell.querySelector(".bol-doc-rename-cancel").onclick = loadBolDocs;
  input.onkeydown = (e) => {
    if (e.key === "Enter") save();
    if (e.key === "Escape") loadBolDocs();
  };
}

// Deleting needs the admin PIN. If Admin is already unlocked the stored PIN is
// used; otherwise the confirmation modal asks for it inline (no detour).
function confirmDeleteBolDoc(doc) {
  if (!doc) return;
  const boxNote = doc.boxes
    ? `<p><strong>${doc.boxes} box(es)</strong> are filed under this BOL. They
         stay in inventory and keep their BOL number \u2014 only the link to
         the PDF goes away.</p>`
    : `<p>No boxes are filed under this BOL.</p>`;
  const pinField = state.admin.pin ? "" : `
    <label class="edit-field bol-del-pin-row"><span>Admin PIN</span>
      <input id="bol-del-pin" type="password" placeholder="Required to delete" />
    </label>`;
  const how = doc.source === "upload" ? "uploaded" : "scanned";
  showModal(`Delete BOL "${doc.bol_number}"?`,
    `<p>This permanently deletes the document record and its PDF file
        (${doc.pages} page(s), ${how}). This cannot be undone.</p>
     ${boxNote}${pinField}`,
    [
      { label: "Cancel", cls: "back-btn" },
      { label: "Delete", cls: "danger-btn", onClick: () => deleteBolDoc(doc) },
    ]);
  const pinInput = $("bol-del-pin");
  if (pinInput) pinInput.focus();
}

async function deleteBolDoc(doc) {
  // The modal is hidden but still in the DOM, so the PIN typed into it is
  // readable here.
  const pinInput = $("bol-del-pin");
  const pin = state.admin.pin || (pinInput ? pinInput.value.trim() : "");
  if (!pin) {
    logActivity("Admin PIN required to delete a BOL", "err");
    return;
  }
  const data = await adminPost("/api/admin/bol/delete", { pin, id: doc.id });
  if (data && data.ok) {
    logActivity(data.message || `Deleted BOL ${doc.bol_number}`, "warn");
    // If it was the active check-in truckload, drop that reference too.
    if (state.bolDoc && state.bolDoc.id === doc.id) {
      state.bolDoc = null;
      state.bolManual = false;
    }
    await loadBolDocs();
  } else if (data) {
    logActivity(data.message || "Could not delete BOL", "err");
  }
}

// -- check in ----------------------------------------------------------------
function renderTypeButtons() {
  const wrap = $("type-buttons");
  wrap.innerHTML = "";
  state.config.item_types.forEach((t) => {
    const b = document.createElement("button");
    b.className = "type-btn";
    b.textContent = t;
    b.onclick = () => selectType(t, b);
    wrap.appendChild(b);
  });
}

function selectType(type, btn) {
  state.selectedType = type;
  document.querySelectorAll(".type-btn").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  renderShipmentForm(type);
  renderItemForm(type);
  loadItemNameSuggestions(type);
  setShipmentFormDisabled(false);
  show("checkin-form"); show("arm-btn");
  hide("finish-btn"); hide("item-form"); hide("result"); hide("scanner");
}

function setShipmentFormDisabled(disabled) {
  $("checkin-form")
    .querySelectorAll("input, select, .btn-group button, .vendor-add-row button")
    .forEach((i) => { i.disabled = disabled; });
  document.querySelectorAll(".type-btn").forEach((b) => { b.disabled = disabled; });
}

function buildField(f, idPrefix) {
  const field = document.createElement("div");
  field.className = "field";
  const label = document.createElement("label");
  label.textContent = f.label;
  field.appendChild(label);

  if (f.type === "buttons") {
    const group = document.createElement("div");
    group.className = "btn-group";
    group.id = `${idPrefix}${f.key}`;
    group.dataset.value = "";
    (f.options || []).forEach((opt) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "opt-btn";
      b.textContent = opt;
      b.onclick = () => {
        group.dataset.value = group.dataset.value === String(opt) ? "" : String(opt);
        group.querySelectorAll(".opt-btn").forEach((x) => x.classList.remove("active"));
        if (group.dataset.value) b.classList.add("active");
      };
      group.appendChild(b);
    });
    field.appendChild(group);
  } else if (f.type === "select") {
    const select = document.createElement("select");
    select.id = `${idPrefix}${f.key}`;
    if (f.key === "vendor") {
      select.innerHTML = vendorOptionsHtml("");
      field.appendChild(select);
      wireVendorQuickAdd(field, select);
    } else {
      const opts = f.options || [];
      select.innerHTML = `<option value=""></option>` +
        opts.map((o) =>
          `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join("");
      field.appendChild(select);
    }
  } else if (f.type === "number") {
    const input = document.createElement("input");
    input.type = "number";
    input.min = "1";
    input.step = "1";
    input.value = "1";
    input.id = `${idPrefix}${f.key}`;
    field.appendChild(input);
  } else {
    const input = document.createElement("input");
    input.type = f.type === "date" ? "date" : "text";
    input.id = `${idPrefix}${f.key}`;
    if (f.suggest) {
      // Autocomplete from previously used values (e.g. W.I.F. component
      // names); the datalist is filled by loadItemNameSuggestions.
      const listId = `${idPrefix}${f.key}-list`;
      const datalist = document.createElement("datalist");
      datalist.id = listId;
      input.setAttribute("list", listId);
      field.appendChild(datalist);
    }
    field.appendChild(input);
  }
  return field;
}

// Fill the Item Name datalist with names already on file for this type.
async function loadItemNameSuggestions(type) {
  const list = $("it_item_name-list");
  if (!list) return;
  try {
    const res = await fetch(`/api/item_names?item_type=${encodeURIComponent(type)}`);
    const data = await res.json();
    list.innerHTML = (data.names || []).map((n) =>
      `<option value="${escapeHtml(n)}"></option>`).join("");
  } catch (e) { /* suggestions are best effort */ }
}

function getFieldValue(key, prefix) {
  const el = $(`${prefix}${key}`);
  if (!el) return "";
  if (el.classList && el.classList.contains("btn-group")) return el.dataset.value || "";
  return (el.value || "").trim();
}

// -- vendor quick add -----------------------------------------------------------
const ADD_VENDOR_VALUE = "__add_vendor__";

function vendorOptionsHtml(selected) {
  return `<option value=""></option>` +
    (state.vendors || []).map((v) =>
      `<option value="${escapeHtml(v)}"${v === selected ? " selected" : ""}>` +
      `${escapeHtml(v)}</option>`).join("") +
    `<option value="${ADD_VENDOR_VALUE}">+ Add new vendor\u2026</option>`;
}

// Last entry of the vendor dropdown swaps in an inline name row; saving posts
// the vendor (no PIN — same trust level as check-in) and re-selects it.
function wireVendorQuickAdd(field, select) {
  const addRow = document.createElement("div");
  addRow.className = "vendor-add-row hidden";
  addRow.innerHTML = `
    <input type="text" class="vendor-add-name" maxlength="80"
      placeholder="New vendor name" />
    <button type="button" class="primary-btn vendor-add-save">Save</button>
    <button type="button" class="vendor-add-cancel">Cancel</button>`;
  field.appendChild(addRow);

  const nameInput = addRow.querySelector(".vendor-add-name");
  const saveBtn = addRow.querySelector(".vendor-add-save");
  let prev = "";

  const closeRow = () => {
    addRow.classList.add("hidden");
    nameInput.value = "";
  };
  select.onchange = () => {
    if (select.value === ADD_VENDOR_VALUE) {
      // Keep the select's real value clean while the name row is open.
      select.value = prev;
      addRow.classList.remove("hidden");
      nameInput.focus();
    } else {
      prev = select.value;
    }
  };
  addRow.querySelector(".vendor-add-cancel").onclick = closeRow;

  const save = async () => {
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    saveBtn.disabled = true;
    try {
      const res = await fetch("/api/vendors", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (data.ok) {
        state.vendors = data.vendors || state.vendors;
        select.innerHTML = vendorOptionsHtml(name);
        prev = select.value;
        logActivity(data.message || `Vendor '${name}' added`, "ok");
        closeRow();
      } else {
        logActivity(data.message || "Could not add vendor", "err");
      }
    } catch (e) {
      logActivity("Cannot reach server", "err");
    }
    saveBtn.disabled = false;
  };
  saveBtn.onclick = save;
  nameInput.onkeydown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); save(); }
    if (e.key === "Escape") closeRow();
  };
}

function renderShipmentForm(type) {
  const form = $("checkin-form");
  form.innerHTML = "";
  fieldsForScope(type, "shipment").forEach((f) => form.appendChild(buildField(f, "f_")));
  applyBolToForm();
}

// With a scanned BOL active, the form's BOL Number is filled from the document
// and locked (rename it from the banner instead so the doc and tags agree).
// OCR-extracted Vendor / PO # also prefill, but stay editable: they're
// guesses. Prefill only lands in empty inputs and never while a shipment is
// armed, so operator entries are never clobbered.
function applyBolToForm() {
  const input = $("f_bol_number");
  if (!input) return;
  if (state.bolDoc) {
    input.value = state.bolDoc.bol_number;
    input.readOnly = true;
    input.classList.add("locked");
    input.title = "Taken from the scanned BOL document. Use Rename in the banner above to change it.";
    if (!state.shipment) {
      const po = $("f_po_number");
      if (po && !po.value && state.bolDoc.po_number) {
        po.value = state.bolDoc.po_number;
      }
      const vendor = $("f_vendor");
      if (vendor && !vendor.value && state.bolDoc.vendor) {
        const known = Array.from(vendor.options)
          .some((o) => o.value === state.bolDoc.vendor);
        if (known) vendor.value = state.bolDoc.vendor;
      }
    }
  } else {
    input.readOnly = false;
    input.classList.remove("locked");
    input.title = "";
  }
}

function renderItemForm(type) {
  const form = $("item-form");
  const hint = state.config.printer_enabled
    ? "Fill in this unit's details, then pull the trigger to tag it \u2014 or print &amp; encode a fresh label for it."
    : "Fill in this unit's details, then pull the trigger to tag it.";
  form.innerHTML = `<p class="hint">${hint}</p>`;
  fieldsForScope(type, "item").forEach((f) => {
    const field = buildField(f, "it_");
    const inp = field.querySelector("input, select");
    if (inp) inp.oninput = onItemInput;
    form.appendChild(field);
  });
  if (state.config.printer_enabled) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = "print-label-btn";
    btn.className = "primary-btn";
    btn.textContent = "Print & encode label";
    btn.onclick = printAndEncodeLabel;
    form.appendChild(btn);
  }
}

// Check a box in via the label printer: the server mints an EPC, the ZD621R
// prints the 4x6 label and encodes that EPC into its inlay. The result is
// the same shape as a trigger-pull check-in, so it reuses that rendering.
async function printAndEncodeLabel() {
  if (!state.shipment) return;
  const btn = $("print-label-btn");
  btn.disabled = true;
  btn.textContent = "Printing\u2026";
  try {
    const res = await fetch("/api/checkin/print", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        item_type: state.shipment.type,
        fields: state.shipment.fields,
        item_fields: collectItemFields(),
        count: 1,
      }),
    });
    const msg = await res.json();
    if (msg.ok) {
      logActivity(`Printed + encoded label ${msg.epc}`, "ok");
      onCheckinResult(msg);
    } else {
      logActivity(msg.message || "Label print failed", "err");
      showResult("warn", "Label not printed",
        `<p>${escapeHtml(msg.message || "Unknown printer error")}</p>`);
    }
  } catch (e) {
    logActivity("Cannot reach server", "err");
  }
  btn.disabled = false;
  btn.textContent = "Print & encode label";
}

function collectItemFields() {
  const fields = {};
  fieldsForScope(state.selectedType, "item").forEach((f) => {
    fields[f.key] = getFieldValue(f.key, "it_");
  });
  return fields;
}

function onItemInput() {
  clearTimeout(itemSendTimer);
  itemSendTimer = setTimeout(postItemFields, 200);
}

async function postItemFields() {
  try {
    await fetch("/api/checkin_item", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields: collectItemFields() }),
    });
  } catch (e) { /* best effort */ }
}

function clearItemInputs() {
  fieldsForScope(state.selectedType, "item").forEach((f) => {
    const el = $(`it_${f.key}`);
    if (!el) return;
    if (el.classList && el.classList.contains("btn-group")) {
      el.dataset.value = "";
      el.querySelectorAll(".opt-btn").forEach((x) => x.classList.remove("active"));
    } else if (f.type !== "number") {
      // Number fields (quantity) persist across boxes in a shipment since they
      // usually match; they reset to the default only when re-arming a shipment.
      el.value = "";
    }
  });
}

async function armCheckin() {
  if (!state.selectedType) return;
  const fields = {};
  fieldsForScope(state.selectedType, "shipment").forEach((f) => {
    fields[f.key] = getFieldValue(f.key, "f_");
  });
  if (state.bolDoc) {
    // File every tag in this shipment under the scanned BOL document.
    fields.bol_number = state.bolDoc.bol_number;
    fields.bol_doc_id = String(state.bolDoc.id);
  }
  const ok = await setServerMode("checkin", { item_type: state.selectedType, fields });
  if (ok) {
    state.shipment = { type: state.selectedType, fields, qty: 0 };
    hide("result");
    setShipmentFormDisabled(true);
    hide("arm-btn"); show("finish-btn"); show("item-form");
    await postItemFields();
    showScanner(`Receiving ${state.selectedType} \u2014 fill unit details, then pull the trigger`);
    await showShipmentNotes();
  }
}

async function finishCheckin() {
  await setServerMode("idle");
  state.shipment = null;
  setShipmentFormDisabled(false);
  show("arm-btn"); hide("finish-btn"); hide("item-form"); hide("scanner");
  hide("shipment-notes");
}

// -- shipment notes (check-in panel) -------------------------------------------
// Notes attach to the armed shipment's identifying triple. The panel lives
// under the per-unit form and stays up for the whole shipment.
function shipmentNoteTriple() {
  const s = state.shipment;
  return {
    item_type: s.type,
    bol_number: s.fields.bol_number || "",
    building: s.fields.building_number || "",
  };
}

async function fetchNotes(params) {
  const q = new URLSearchParams(params);
  try {
    return (await (await fetch(`/api/notes?${q.toString()}`)).json()).notes || [];
  } catch (e) {
    return [];
  }
}

// One <li> per note; `context` adds the note's own BOL/building (used in the
// warehouse block, where a row can span several shipments).
function noteItemHtml(n, editing, context = false) {
  const del = editing
    ? ` <button class="note-del-btn" data-id="${n.id}" title="Delete this note">&times;</button>`
    : "";
  const where = context
    ? `<span class="note-where">BOL ${escapeHtml(n.bol_number || "n/a")}
         \u00b7 Bldg ${escapeHtml(n.building || "n/a")}</span>`
    : "";
  return `<li class="note-item">
      <span class="note-ts">${escapeHtml(fmtDateTime(n.ts))}</span>${where}
      <span class="note-text">${escapeHtml(n.text)}</span>${del}
    </li>`;
}

async function showShipmentNotes() {
  if (!state.shipment) { hide("shipment-notes"); return; }
  show("shipment-notes");
  $("shipment-notes").innerHTML =
    `<h3>Shipment notes</h3><p class="hint">Loading\u2026</p>`;
  renderShipmentNotesPanel(await fetchNotes(shipmentNoteTriple()));
}

function renderShipmentNotesPanel(notes) {
  const panel = $("shipment-notes");
  if (!state.shipment) return;
  const list = notes.length
    ? `<ul class="note-list">${notes.map((n) => noteItemHtml(n, false)).join("")}</ul>`
    : `<p class="hint">No notes yet for this shipment.</p>`;
  panel.innerHTML = `
    <h3>Shipment notes</h3>
    ${list}
    <div class="note-add">
      <textarea id="shipment-note-text" rows="2"
        placeholder="e.g. 2 boxes arrived damaged \u2014 refused"></textarea>
      <button id="shipment-note-add" class="primary-btn note-add-btn">Add note</button>
    </div>`;
  const ta = $("shipment-note-text");
  const btn = $("shipment-note-add");
  const submit = async () => {
    const text = ta.value.trim();
    if (!text || !state.shipment) return;
    btn.disabled = true;
    try {
      const res = await fetch("/api/notes", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...shipmentNoteTriple(), text }),
      });
      const data = await res.json();
      if (data.ok) {
        logActivity("Note added to shipment", "ok");
        renderShipmentNotesPanel(await fetchNotes(shipmentNoteTriple()));
        return;
      }
      logActivity(data.message || "Could not add note", "err");
    } catch (e) {
      logActivity("Cannot reach server", "err");
    }
    btn.disabled = false;
  };
  btn.onclick = submit;
  ta.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
  };
}

function onCheckinResult(msg) {
  if (!msg.ok) {
    showResult("warn", "Unit not recorded", `<p>${escapeHtml(msg.message)}</p>`);
    logActivity(msg.message, "warn");
    showScanner(`Receiving ${msg.item_type || ""} \u2014 pull the trigger on the next unit`);
    return;
  }
  const boxUnits = msg.quantity != null ? msg.quantity : msg.added_units;
  renderCheckinSummary(msg);
  addItemNameSuggestion(msg.item_name);
  logActivity(`Received a box of ${boxUnits} ${msg.item_type} (BOL ${msg.bol_number || "n/a"}) \u2014 qty now ${msg.qty} units`, "ok");
  // Per-unit fields are unique; clear them for the next unit.
  clearItemInputs();
  postItemFields();
  showScanner(`Receiving ${msg.item_type} \u2014 enter the next unit, then pull the trigger`);
}

// A just-used component name becomes an autocomplete option right away,
// without refetching the whole suggestion list.
function addItemNameSuggestion(name) {
  const list = $("it_item_name-list");
  if (!list || !name) return;
  const exists = Array.from(list.options).some((o) => o.value === name);
  if (!exists) {
    const opt = document.createElement("option");
    opt.value = name;
    list.appendChild(opt);
  }
}

function renderCheckinSummary(msg) {
  const bol = msg.bol_number || "n/a";
  const bldg = msg.building || "n/a";
  const dupNote = msg.duplicates && msg.duplicates.length
    ? `<p class="hint">${msg.duplicates.length} tag(s) were already on file (not re-counted).</p>` : "";
  const itemName = msg.item_name
    ? `<tr><th>Item Name</th><td>${escapeHtml(msg.item_name)}</td></tr>` : "";
  const sku = msg.sku ? `<tr><th>SKU</th><td>${escapeHtml(msg.sku)}</td></tr>` : "";
  const mfc = msg.mfc_date ? `<tr><th>Mfc date</th><td>${escapeHtml(msg.mfc_date)}</td></tr>` : "";
  const boxUnits = msg.quantity != null ? msg.quantity : msg.added_units;
  const epcRow = msg.epc
    ? `<tr><th>EPC</th><td><span class="epc">${escapeHtml(msg.epc)}</span></td></tr>` : "";
  const editBtn = msg.epc
    ? `<button id="checkin-amend-btn" class="edit-btn checkin-amend-btn">Edit this box</button>` : "";
  const po = msg.po_number
    ? `<tr><th>PO Number</th><td>${escapeHtml(msg.po_number)}</td></tr>` : "";
  const sector = msg.sector
    ? `<tr><th>Sector</th><td>${escapeHtml(msg.sector)}</td></tr>` : "";
  showResult("ok", `Shipment: ${escapeHtml(msg.item_type)} \u00b7 Qty ${msg.qty} units`,
    `<table>
       ${epcRow}
       ${itemName}
       <tr><th>BOL Number</th><td>${escapeHtml(bol)}</td></tr>
       ${po}
       <tr><th>Building</th><td>${escapeHtml(bldg)}</td></tr>
       ${sector}
       <tr><th>Vendor</th><td>${escapeHtml(msg.vendor || "")}</td></tr>
       ${sku}${mfc}
       <tr><th>This box</th><td>${boxUnits} unit(s)</td></tr>
       <tr><th>Total in this group</th><td>${msg.qty} unit(s)</td></tr>
     </table>${dupNote}${editBtn}
     <p class="hint">Enter the next box's details and pull the trigger, or "Finish / change shipment".</p>`);
  const btn = $("checkin-amend-btn");
  if (btn) btn.onclick = () => renderCheckinAmend(msg);
}

// Quick fix of the box that was just scanned (typo in qty / SKU / mfc date).
// Scanning stays armed the whole time, so the flow isn't interrupted.
function renderCheckinAmend(msg) {
  const qty = msg.quantity != null ? msg.quantity : 1;
  const named = (state.config.named_item_types || []).includes(msg.item_type);
  const itemNameField = named
    ? `<label class="edit-field"><span>Item Name</span>
         <input id="amend-item-name" type="text" list="it_item_name-list"
                value="${escapeHtml(msg.item_name || "")}" /></label>`
    : "";
  showResult("ok", `Edit box ${msg.epc}`,
    `<div class="checkin-amend-form">
       ${itemNameField}
       <label class="edit-field"><span>SKU</span>
         <input id="amend-sku" type="text" value="${escapeHtml(msg.sku || "")}" /></label>
       <label class="edit-field"><span>Manufactured Date</span>
         <input id="amend-mfc" type="date" value="${escapeHtml(msg.mfc_date || "")}" /></label>
       <label class="edit-field"><span>Quantity (units in this box)</span>
         <input id="amend-qty" type="number" min="1" step="1" value="${escapeHtml(String(qty))}" /></label>
     </div>
     <div class="edit-actions">
       <button id="amend-save" class="primary-btn">Save</button>
       <button id="amend-cancel" class="back-btn">Cancel</button>
     </div>`);
  $("amend-cancel").onclick = () => renderCheckinSummary(msg);
  $("amend-save").onclick = async () => {
    const fields = {
      sku: $("amend-sku").value.trim(),
      mfc_date: $("amend-mfc").value.trim(),
      quantity: $("amend-qty").value.trim(),
    };
    const nameInput = $("amend-item-name");
    if (nameInput) fields.item_name = nameInput.value.trim();
    try {
      const res = await fetch("/api/checkin/amend", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ epc: msg.epc, fields }),
      });
      const data = await res.json();
      if (data.ok) {
        const tag = data.tag || {};
        msg.item_name = tag.item_name;
        msg.sku = tag.sku;
        msg.mfc_date = tag.mfc_date;
        msg.quantity = tag.quantity;
        if (data.qty != null) msg.qty = data.qty;
        logActivity(data.message || `Updated ${msg.epc}`, "ok");
        addItemNameSuggestion(msg.item_name);
        renderCheckinSummary(msg);
      } else {
        logActivity(data.message || "Edit failed", "err");
      }
    } catch (e) {
      logActivity("Cannot reach server", "err");
    }
  };
}

// -- check out ---------------------------------------------------------------
// A trigger pull ONLY looks a box up — scans never commit anything. The
// operator reviews the confirm card and commits with a button press: "Add to
// staging" while fulfilling a request, "Confirm delivery" otherwise. Scanning
// while a card is already showing simply switches the card to the scanned box.
function handleCheckoutScan(msg) {
  // Scan events are broadcast to every open browser tab, but the checkout
  // confirmation state (pending card, active request, staged list) is
  // per-tab. Only the tab the operator is actually looking at may act.
  if (state.mode !== "checkout" || document.visibilityState === "hidden") {
    return;
  }
  hideModal(); // a fresh scan supersedes any dialog still on screen
  onCheckoutPrompt(msg);
}

function onCheckoutPrompt(msg) {
  const req = state.activeRequest;
  if (!msg.ok) {
    state.pendingCheckout = null;
    showResult("warn", "Cannot deliver",
      `<p class="epc">${escapeHtml(msg.epc || "")}</p>
       <p>${escapeHtml(msg.message)}</p>`);
    logActivity(msg.message, "warn");
    showScanner(req ? "Scan a box to stage it for this request"
                    : "Ready \u2014 pull the trigger to deliver to site");
    return;
  }

  if (req) {
    // Already in the staged list: point at the banner instead of re-adding.
    if (state.stagedDraws.some((d) => d.epc === msg.epc)) {
      state.pendingCheckout = null;
      showResult("warn", "Already staged",
        `<p><b>${escapeHtml(msg.item_type || "")}</b> &middot;
           <span class="epc">${escapeHtml(msg.epc)}</span></p>
         <p>This box is already staged for request #${req.id}. Remove it from
           the staged list above if you scanned it by mistake.</p>`);
      showScanner("Scan a box to stage it for this request");
      return;
    }
    // Wrong item type: allow it, but only with an explicit override.
    if (req.item_type && msg.item_type && msg.item_type !== req.item_type) {
      showModal("Different item type",
        `<p>Request #${req.id} asks for <b>${escapeHtml(req.item_type)}</b>,
           but this box is <b>${escapeHtml(msg.item_type)}</b>
           (<span class="epc">${escapeHtml(msg.epc)}</span>).</p>
         <p>Stage it anyway?</p>`,
        [{ label: "Stage anyway", cls: "primary-btn",
           onClick: () => showCheckoutCard(msg) },
         { label: "Skip this box", cls: "back-btn" }]);
      logActivity(`Type mismatch for request #${req.id}: scanned ` +
                  `${msg.item_type}, requested ${req.item_type}`, "warn");
      return;
    }
    // Right type, wrong component (W.I.F. accessory): same override flow.
    if (req.item_name && (msg.item_name || "") !== req.item_name) {
      const boxName = msg.item_name || "(no item name)";
      showModal("Different item name",
        `<p>Request #${req.id} asks for
           <b>${escapeHtml(req.item_type)} | ${escapeHtml(req.item_name)}</b>,
           but this box is
           <b>${escapeHtml(msg.item_type)} | ${escapeHtml(boxName)}</b>
           (<span class="epc">${escapeHtml(msg.epc)}</span>).</p>
         <p>Stage it anyway?</p>`,
        [{ label: "Stage anyway", cls: "primary-btn",
           onClick: () => showCheckoutCard(msg) },
         { label: "Skip this box", cls: "back-btn" }]);
      logActivity(`Item name mismatch for request #${req.id}: scanned ` +
                  `${boxName}, requested ${req.item_name}`, "warn");
      return;
    }
  }
  showCheckoutCard(msg);
}

// The per-box confirm card. Outside a request it commits a checkout draw
// immediately; while fulfilling a request it only adds the draw to the
// staged list (nothing hits the DB until Confirm delivery).
function showCheckoutCard(msg) {
  const req = state.activeRequest;
  state.pendingCheckout = msg;
  const remaining = msg.remaining;
  const quantity = msg.quantity;
  const buildings = state.config.building_options || [];
  const needed = req ? Math.max(0, req.quantity - stagedTotal()) : 0;
  const defaultAmount = req
    ? Math.max(1, Math.min(remaining, needed || 1)) : remaining;
  const defaultBldg = req && req.building
    ? String(req.building) : String(msg.building || "");
  const bldgBtns = buildings.map((b) =>
    `<button type="button" class="opt-btn checkout-bldg-btn${String(b) === defaultBldg ? " active" : ""}"
       data-building="${escapeHtml(b)}">${escapeHtml(b)}</button>`).join("");
  const title = req ? `Add to staging (request #${req.id})`
                    : "How many units leave?";
  const btnLabel = req ? "Add to staging" : "Confirm delivery";
  const hint = req
    ? `Defaults to what the request still needs. Press Add to staging to add
       it to the list — scanning again will not add it.`
    : `Defaults to the whole box. Lower it to deliver part of the box, then
       press Confirm delivery.`;
  const itemNameRow = msg.item_name
    ? `<tr><th>Item Name</th><td>${escapeHtml(msg.item_name)}</td></tr>` : "";
  showResult("ok", title,
    `<p><b>${escapeHtml(msg.item_type || "")}</b> &middot;
       <span class="epc">${escapeHtml(msg.epc)}</span></p>
     <table>
       ${itemNameRow}
       <tr><th>BOL Number</th><td>${escapeHtml(msg.bol_number || "n/a")}</td></tr>
       <tr><th>Building</th><td>${escapeHtml(msg.building || "n/a")}</td></tr>
       <tr><th>SKU</th><td>${escapeHtml(msg.sku || "")}</td></tr>
       <tr><th>Units in this box</th><td>${remaining} of ${quantity}</td></tr>
     </table>
     <div class="checkout-bldg">
       <label>Deliver to building</label>
       <div id="checkout-bldg-group" class="btn-group"
            data-value="${escapeHtml(defaultBldg)}">${bldgBtns}</div>
     </div>
     <div class="checkout-confirm">
       <label for="checkout-amount">Units to ${req ? "stage" : "deliver"}</label>
       <input id="checkout-amount" type="number" min="1" max="${remaining}"
              step="1" value="${defaultAmount}" />
       <button id="checkout-confirm-btn" class="primary-btn">${btnLabel}</button>
     </div>
     <p class="hint">${hint}</p>`);
  showScanner(req ? "Press Add to staging below, or scan a different box"
                  : "Press Confirm delivery below, or scan a different box");
  const group = $("checkout-bldg-group");
  group.querySelectorAll(".checkout-bldg-btn").forEach((b) => {
    b.onclick = () => {
      const val = b.dataset.building;
      group.dataset.value = group.dataset.value === val ? "" : val;
      group.querySelectorAll(".checkout-bldg-btn").forEach((x) =>
        x.classList.toggle("active", x.dataset.building === group.dataset.value));
    };
  });
  const input = $("checkout-amount");
  const commit = () => confirmCheckout(msg.epc, remaining);
  $("checkout-confirm-btn").onclick = commit;
  if (input) {
    input.focus();
    input.select();
    input.onkeydown = (e) => { if (e.key === "Enter") commit(); };
  }
}

async function confirmCheckout(epc, remaining, bldgConfirmed = false) {
  const input = $("checkout-amount");
  // No confirm card on screen means there is nothing the operator has
  // reviewed — never fall back to committing the whole box.
  if (!input || $("result").classList.contains("hidden")) {
    state.pendingCheckout = null;
    return;
  }
  let amount = parseInt(input.value, 10);
  if (!Number.isFinite(amount) || amount < 1) amount = 1;
  if (amount > remaining) amount = remaining;
  const group = $("checkout-bldg-group");
  const building = group ? (group.dataset.value || "") : "";
  if (state.activeRequest) {
    stageDraw({ epc, amount, building });
    return;
  }
  // Destination differs from the building the box is assigned to: get an
  // explicit go-ahead first. (While fulfilling a request the destination is
  // the requester's choice, so this only applies to standalone checkouts;
  // the draw still gets flagged in the DB when it commits.)
  const home = String((state.pendingCheckout || {}).building || "");
  if (!bldgConfirmed && building && home && building !== home) {
    showModal("Different building",
      `<p>This box is assigned to Building <b>${escapeHtml(home)}</b> but is being
         delivered to Building <b>${escapeHtml(building)}</b>.</p>
       <p>Are you sure you want to deliver it there?</p>`,
      [{ label: "Yes, deliver", cls: "primary-btn",
         onClick: () => confirmCheckout(epc, remaining, true) },
       { label: "Cancel", cls: "back-btn" }]);
    return;
  }
  try {
    const res = await fetch("/api/checkout", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ epc, amount, building }),
    });
    onCheckoutResult(await res.json());
  } catch (e) {
    logActivity("Cannot reach server", "err");
  }
}

// -- request staging (checkout mode driven from a material request) -----------
function stagedTotal() {
  return state.stagedDraws.reduce((sum, d) => sum + (d.amount || 0), 0);
}

function stageDraw(draw) {
  const box = state.pendingCheckout || {};
  state.stagedDraws.push({
    epc: draw.epc, amount: draw.amount, building: draw.building,
    item_type: box.item_type || "", item_name: box.item_name || "",
    bol_number: box.bol_number || "",
  });
  state.pendingCheckout = null;
  hide("result");
  renderRequestBanner();
  const req = state.activeRequest;
  logActivity(`Staged ${draw.amount} unit(s) of ${box.item_type || draw.epc} ` +
              `for request #${req.id}`, "ok");
  showScanner("Scan the next box, or press Confirm delivery when done");
}

function renderRequestBanner() {
  const banner = $("request-banner");
  if (!banner) return;
  const req = state.activeRequest;
  if (!req || state.mode !== "checkout") {
    banner.classList.add("hidden");
    return;
  }
  banner.classList.remove("hidden");
  const dest = [req.building && `Bldg ${req.building}`, req.jobsite]
    .filter(Boolean).join(" \u00b7 ");
  $("request-banner-title").textContent =
    `#${req.id} \u2014 ${req.quantity} \u00d7 ${req.item_type}` +
    (req.item_name ? ` | ${req.item_name}` : "") +
    (dest ? ` \u2192 ${dest}` : "");
  const total = stagedTotal();
  const progress = $("request-banner-progress");
  progress.textContent = `${total} of ${req.quantity} unit(s) staged`;
  progress.classList.toggle("request-progress-done", total >= req.quantity);

  const list = $("request-staged-list");
  if (!state.stagedDraws.length) {
    list.innerHTML = `<p class="hint">Nothing staged yet — scan a box to add it.</p>`;
  } else {
    list.innerHTML = state.stagedDraws.map((d, i) => `
      <div class="staged-row">
        <span class="staged-qty">${d.amount}\u00d7</span>
        <span class="staged-desc"><b>${escapeHtml(d.item_type)}</b>
          ${d.item_name ? `\u00b7 ${escapeHtml(d.item_name)}` : ""}
          <span class="epc">${escapeHtml(d.epc)}</span>
          ${d.bol_number ? `\u00b7 BOL ${escapeHtml(d.bol_number)}` : ""}
          ${d.building ? `\u2192 Bldg ${escapeHtml(d.building)}` : ""}</span>
        <button class="staged-remove" data-i="${i}" title="Remove">&times;</button>
      </div>`).join("");
    list.querySelectorAll(".staged-remove").forEach((b) => {
      b.onclick = () => {
        state.stagedDraws.splice(parseInt(b.dataset.i, 10), 1);
        renderRequestBanner();
      };
    });
  }
  $("request-confirm-btn").disabled = !state.stagedDraws.length;
}

function clearRequestContext() {
  state.activeRequest = null;
  state.stagedDraws = [];
  renderRequestBanner();
}

// Fulfill clicked on a pending card (moves it to staging on the cloud too),
// or Resume clicked on a card already staging.
async function startRequestFulfillment(r) {
  if (r.status === "pending") {
    try {
      const res = await fetch("/api/requests/handle", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: r.id, status: "staging", note: "" }),
      });
      const data = await res.json();
      if (!data.ok) {
        logActivity(data.message || "Could not start staging", "err");
        await loadRequests();
        return;
      }
      r = data.request || r;
    } catch (e) {
      logActivity("Cannot reach server", "err");
      return;
    }
  }
  // Keep the cart when resuming the same request; starting a different one
  // (or starting fresh) begins empty.
  if (!state.activeRequest || state.activeRequest.id !== r.id) {
    state.stagedDraws = [];
  }
  state.activeRequest = r;
  await openMode("checkout");
}

function cancelRequestStaging(id) {
  showModal(`Cancel staging for request #${id}?`,
    `<p>Nothing has been checked out yet — the request simply goes back to
        pending.</p>`,
    [{ label: "Cancel staging", cls: "danger-btn",
       onClick: async () => {
         try {
           const res = await fetch("/api/requests/handle", {
             method: "POST", headers: { "Content-Type": "application/json" },
             body: JSON.stringify({ id, status: "pending", note: "" }),
           });
           const data = await res.json();
           logActivity(data.message || `Request #${id} back to pending`,
                       data.ok ? "ok" : "err");
         } catch (e) {
           logActivity("Cannot reach server", "err");
         }
         if (state.activeRequest && state.activeRequest.id === id) {
           clearRequestContext();
         }
         if (state.mode === "checkout") {
           await openMode("requests");
         } else {
           await loadRequests();
         }
       } },
     { label: "Keep staging", cls: "back-btn" }]);
}

// Confirm delivery pressed: summarize, collect the note (required when the
// staged total is short of the request), then commit via /api/requests/fulfill.
function confirmRequestDelivery() {
  const req = state.activeRequest;
  if (!req || !state.stagedDraws.length) return;
  const total = stagedTotal();
  const short = total < req.quantity;
  const shortWarn = short
    ? `<p class="flag-warning"><strong>&#9888; Only ${total} of ${req.quantity}
         unit(s) staged.</strong> A note for the requester is required.</p>`
    : "";
  showModal(`Confirm delivery for request #${req.id}?`,
    `${shortWarn}
     <p>${total} unit(s) of <b>${escapeHtml(req.item_type)}${req.item_name
        ? ` | ${escapeHtml(req.item_name)}` : ""}</b> from
        ${state.stagedDraws.length} box(es) will be checked out, and the
        request marked fulfilled on the cloud site.</p>
     <label class="edit-field"><span>Note for the requester${short ? " (required)" : " (optional)"}</span>
       <input id="request-fulfill-note" type="text" maxlength="200"
         placeholder="${short ? "e.g. Remainder ships next week" : "e.g. On Tuesday's truck"}" />
     </label>`,
    [{ label: "Confirm delivery", cls: "primary-btn",
       onClick: () => submitRequestFulfill() },
     { label: "Back", cls: "back-btn" }]);
  const input = $("request-fulfill-note");
  if (input) input.focus();
}

async function submitRequestFulfill() {
  const req = state.activeRequest;
  const input = $("request-fulfill-note");
  const note = input ? input.value.trim() : "";
  const total = stagedTotal();
  if (total < req.quantity && !note) {
    logActivity("A note is required when fulfilling short", "warn");
    confirmRequestDelivery();
    return;
  }
  let data;
  try {
    const res = await fetch("/api/requests/fulfill", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: req.id,
        draws: state.stagedDraws.map((d) => (
          { epc: d.epc, amount: d.amount, building: d.building })),
        note,
      }),
    });
    data = await res.json();
  } catch (e) {
    logActivity("Cannot reach server", "err");
    return;
  }
  if (!data.ok) {
    logActivity(data.message || "Could not fulfill request", "err");
    if (data.note_required) confirmRequestDelivery();
    return;
  }
  const draws = data.results || [];
  const okDraws = draws.filter((r) => r.ok);
  const failed = draws.filter((r) => !r.ok);
  const rows = okDraws.map((r) => `
    <tr><td>${r.delivered}\u00d7 ${escapeHtml(r.item_type || "")}</td>
        <td><span class="epc">${escapeHtml(r.epc)}</span></td>
        <td>${r.checkout_building ? `Bldg ${escapeHtml(r.checkout_building)}` : ""}</td></tr>`).join("");
  const failHtml = failed.length
    ? `<p class="flag-warning"><strong>&#9888; ${failed.length} box(es) could not
         be delivered:</strong> ${failed.map((r) => escapeHtml(r.message || r.epc)).join("; ")}</p>`
    : "";
  const flags = okDraws.filter((r) => r.flag);
  const flagHtml = flags.length
    ? `<p class="hint">${flags.map((r) => escapeHtml(r.flag)).join("<br>")}</p>` : "";
  logActivity(data.message, data.short || failed.length ? "warn" : "ok");
  clearRequestContext();
  await openMode("requests");
  showResult(data.short || failed.length ? "warn" : "ok",
    `Request #${req.id} fulfilled`,
    `${failHtml}
     <p>${data.delivered} of ${data.requested} requested unit(s) delivered.
        The requester sees the outcome after the next sync.</p>
     ${rows ? `<table>${rows}</table>` : ""}${flagHtml}`);
}

function onCheckoutResult(msg) {
  state.pendingCheckout = null;
  if (msg.ok) {
    const groupLeft = (msg.qty_remaining == null) ? "" :
      `<tr><th>Units left (this group)</th><td>${msg.qty_remaining}</td></tr>`;
    const boxLeft = (msg.box_remaining == null) ? "" :
      `<tr><th>Units left in this box</th><td>${msg.box_remaining}</td></tr>`;
    const delivered = (msg.delivered == null) ? "" :
      `<tr><th>Units delivered</th><td>${msg.delivered}</td></tr>`;
    const checkedOutTo = msg.checkout_building
      ? `<tr><th>Checked out to</th><td>Building ${escapeHtml(msg.checkout_building)}</td></tr>` : "";
    const mismatch = msg.flag
      ? `<div class="flag-warning"><strong>&#9888; ${escapeHtml(msg.flag)}</strong></div>` : "";
    showResult(msg.flag ? "warn" : "ok", "Delivered to site",
      `${mismatch}<p><b>${escapeHtml(msg.item_type || "")}</b> &middot;
         <span class="epc">${escapeHtml(msg.epc)}</span></p>
       <table>
         <tr><th>BOL Number</th><td>${escapeHtml(msg.bol_number || "n/a")}</td></tr>
         <tr><th>Building</th><td>${escapeHtml(msg.building || "n/a")}</td></tr>
         ${checkedOutTo}${delivered}${boxLeft}
         <tr><th>Delivered</th><td>${escapeHtml(msg.delivered_at || "")}</td></tr>
         ${groupLeft}
       </table>`);
    const dest = msg.checkout_building ? ` (Bldg ${msg.checkout_building})` : "";
    logActivity(`Delivered ${msg.delivered != null ? msg.delivered + " unit(s) of " : ""}` +
      `${msg.item_type} (${msg.epc}) to site${dest}`, msg.flag ? "warn" : "ok");
    if (msg.flag) logActivity(msg.flag, "warn");
  } else {
    showResult("warn", "Cannot deliver", `<p class="epc">${escapeHtml(msg.epc || "")}</p>
       <p>${escapeHtml(msg.message)}</p>`);
    logActivity(msg.message, "warn");
  }
  showScanner("Ready \u2014 pull the trigger to deliver to site");
}

// -- inventory sweep ---------------------------------------------------------
// A sweep "session" accumulates every EPC seen across trigger pulls so the
// missing list shrinks as more of the warehouse is covered.
function newSweepSession() {
  return { epcs: new Set(), unknown: new Set(),
           flagged: new Map(), items: new Map() };
}

function resetSweepSession() {
  state.sweep = newSweepSession();
  updateSweepStatus();
  hide("result");
}

function updateSweepStatus() {
  const el = $("sweep-session-status");
  if (!el) return;
  const n = state.sweep ? state.sweep.epcs.size : 0;
  el.textContent = n
    ? `Session: ${n} distinct tag(s) scanned so far.`
    : "No tags scanned yet this session.";
}

async function onInventoryResult(msg) {
  if (!state.sweep) state.sweep = newSweepSession();
  const s = state.sweep;
  (msg.epcs || []).forEach((e) => s.epcs.add(String(e).toUpperCase()));
  (msg.unknown || []).forEach((e) => s.unknown.add(e));
  (msg.flagged || []).forEach((f) => s.flagged.set(f.epc, f));
  (msg.items || []).forEach((t) => s.items.set(t.epc, t));
  updateSweepStatus();

  // Reconcile the whole session against what should be in the warehouse.
  let cmp = null;
  try {
    const res = await fetch("/api/inventory/compare", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ epcs: [...s.epcs] }),
    });
    cmp = await res.json();
  } catch (e) {
    logActivity("Could not compare sweep against inventory", "err");
  }
  renderSweepResult(cmp);
  showScanner("Hold the trigger to sweep again\u2026");
}

function renderSweepResult(cmp) {
  const s = state.sweep || newSweepSession();
  const items = [...s.items.values()];
  const unknown = [...s.unknown];
  const flagged = [...s.flagged.values()];

  // Per-type unit counts across the whole session (in-warehouse tags only).
  const counts = {};
  items.forEach((t) => {
    if (t.remaining > 0) counts[t.item_type] = (counts[t.item_type] || 0) + t.remaining;
  });
  let rows = "";
  Object.keys(counts).sort().forEach((t) => {
    rows += `<tr><td>${escapeHtml(t)}</td><td>${counts[t]}</td></tr>`;
  });
  if (!rows) rows = `<tr><td colspan="2" class="hint">No registered tags found.</td></tr>`;

  // Reconciliation: expected boxes that were NOT detected in this session.
  let missingHtml = "";
  let title, kind;
  if (cmp) {
    title = `Found ${cmp.found_count} of ${cmp.expected} expected box(es)`;
    kind = cmp.missing_count || flagged.length ? "warn" : "ok";
    if (cmp.missing_count) {
      const mrows = cmp.missing.map((t) => {
        const qty = `${t.remaining != null ? t.remaining : ""}` +
          (t.quantity != null ? ` / ${t.quantity}` : "");
        return `<tr>
          <td class="epc epc-link" data-epc="${escapeHtml(t.epc)}"
              title="View this tag's event history">${escapeHtml(t.epc)}</td>
          <td>${escapeHtml(t.item_type || "")}</td>
          <td>${escapeHtml(t.bol_number || "")}</td>
          <td>${escapeHtml(t.building || "")}</td>
          <td>${escapeHtml(t.sku || "")}</td>
          <td class="qty-cell">${escapeHtml(qty)}</td>
          <td><button class="find-btn" data-epc="${escapeHtml(t.epc)}"
            data-label="${escapeHtml((t.item_type || "") + " \u00b7 " + (t.sku || t.epc))}">Find</button></td>
        </tr>`;
      }).join("");
      missingHtml = `<div class="flag-warning sweep-missing">
        <strong>&#9888; ${cmp.missing_count} box(es) expected in the warehouse but NOT detected:</strong>
        <table>
          <thead><tr><th>EPC</th><th>Type</th><th>BOL</th><th>Building</th>
            <th>SKU</th><th>Qty</th><th></th></tr></thead>
          <tbody>${mrows}</tbody>
        </table>
        <p class="hint">Keep sweeping to pick up more tags, or use Find to hunt one down.</p>
      </div>`;
    } else {
      missingHtml = `<p class="sweep-all-found">&#10003; All expected boxes accounted for.</p>`;
    }
  } else {
    // Comparison unavailable (e.g. server hiccup): fall back to plain counts.
    const total = Object.values(counts).reduce((a, b) => a + b, 0)
      + unknown.length + flagged.length;
    title = `Counted ${total} unit(s)`;
    kind = flagged.length ? "warn" : "ok";
  }

  let unknownHtml = "";
  if (unknown.length) {
    unknownHtml = `<p class="hint">${unknown.length} unregistered tag(s):</p>
      <ul class="unknown-list">${unknown.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul>`;
  }
  let flaggedHtml = "";
  if (flagged.length) {
    const fitems = flagged.map((f) =>
      `<li><span class="epc epc-link" data-epc="${escapeHtml(f.epc)}"
        title="View this tag's event history">${escapeHtml(f.epc)}</span> &mdash;
        ${escapeHtml(f.item_type)} (BOL ${escapeHtml(f.bol_number || "n/a")},
        Bldg ${escapeHtml(f.building || "n/a")}), checked out ${escapeHtml(f.delivered_at || "")}</li>`
    ).join("");
    flaggedHtml = `<div class="flag-warning">
      <strong>&#9888; ${flagged.length} checked-out item(s) detected &mdash; should NOT be in the warehouse:</strong>
      <ul>${fitems}</ul></div>`;
  }
  const detailsHtml = sweepDetailsHtml(items);

  showResult(kind, title,
    `${missingHtml}${flaggedHtml}
     <table><tr><th>Type</th><th>Units</th></tr>${rows}</table>
     ${unknownHtml}${detailsHtml}`);
  logActivity(`Sweep: ${title.toLowerCase()}` +
    (cmp && cmp.missing_count ? `, ${cmp.missing_count} missing` : "") +
    (flagged.length ? `, ${flagged.length} flagged` : ""), kind);

  // EPC links jump to that tag's event history; Find buttons open the finder.
  $("result").querySelectorAll(".epc-link").forEach((el) => {
    el.onclick = (ev) => { ev.stopPropagation(); openMode("eventlog", { epc: el.dataset.epc }); };
  });
  $("result").querySelectorAll(".find-btn").forEach((b) => {
    b.onclick = (ev) => { ev.stopPropagation(); openFinder(b.dataset.epc, b.dataset.label); };
  });
}

function sweepDetailsHtml(items) {
  if (!items || !items.length) return "";
  const rows = items.map((t) => {
    const qty = `${t.remaining != null ? t.remaining : ""}` +
      (t.quantity != null ? ` / ${t.quantity}` : "");
    const statusCls = STATUS_BADGE[t.status] || "badge-in";
    const checkedOut = t.delivered_at ? fmtDateTime(t.delivered_at) : "";
    return `<tr>
      <td class="epc epc-link" data-epc="${escapeHtml(t.epc)}"
          title="View this tag's event history">${escapeHtml(t.epc)}</td>
      <td>${escapeHtml(t.item_type || "")}</td>
      <td class="qty-cell">${escapeHtml(qty)}</td>
      <td>${escapeHtml(t.bol_number || "")}</td>
      <td>${escapeHtml(t.po_number || "")}</td>
      <td>${escapeHtml(t.building || "")}</td>
      <td>${escapeHtml(t.vendor || "")}</td>
      <td>${escapeHtml(t.sku || "")}</td>
      <td>${escapeHtml(t.mfc_date || "")}</td>
      <td>${escapeHtml(fmtDateTime(t.received_at))}</td>
      <td>${escapeHtml(checkedOut)}</td>
      <td><span class="badge ${statusCls}">${escapeHtml(t.status || "")}</span></td>
    </tr>`;
  }).join("");
  return `<details class="sweep-details">
      <summary>View detailed scan (${items.length} box${items.length === 1 ? "" : "es"})</summary>
      <table>
        <thead><tr><th>EPC</th><th>Type</th><th>Qty</th><th>BOL</th><th>PO</th><th>Building</th>
          <th>Vendor</th><th>SKU</th><th>Mfc date</th><th>Checked in</th>
          <th>Checked out</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </details>`;
}

// -- warehouse browse / drill-down -------------------------------------------
// Active filter values as URLSearchParams entries (blank values skipped) so the
// tree, drill-down, and exports all narrow to the same set of tags.
function whFilterParams(params) {
  Object.entries(state.whFilters).forEach(([k, v]) => {
    if (v) params.set(k, v);
  });
  return params;
}

async function loadWarehouse() {
  const tree = $("warehouse-tree");
  tree.innerHTML = `<p class="hint">Loading\u2026</p>`;
  const q = whFilterParams(new URLSearchParams({ group_by: state.whGroupBy }));
  try {
    const data = await (await fetch(`/api/inventory?${q.toString()}`)).json();
    renderWarehouse(data);
  } catch (e) {
    tree.innerHTML = `<p class="hint">Could not load inventory.</p>`;
  }
}

function renderWarehouse(data) {
  const tree = $("warehouse-tree");
  tree.innerHTML = "";
  const groupLabel = data.group_by === "building" ? "Building #" : "BOL #";
  const otherLabel = data.group_by === "building" ? "BOL #" : "Building #";
  if (!data.types || !data.types.length) {
    const filtered = Object.values(state.whFilters).some(Boolean);
    tree.innerHTML = filtered
      ? `<p class="hint">Nothing matches these filters.</p>`
      : `<p class="hint">Nothing in the warehouse yet. Check in a shipment to get started.</p>`;
    return;
  }
  data.types.forEach((t) => {
    const typeEl = document.createElement("div");
    typeEl.className = "wh-type";

    const head = document.createElement("button");
    head.className = "wh-type-head";
    head.innerHTML = `<span class="wh-caret">&#9662;</span>
      <span class="wh-type-name">${escapeHtml(t.item_type)}</span>
      <span class="wh-qty">${t.qty} unit(s) in warehouse</span>`;

    const body = document.createElement("div");
    body.className = "wh-type-body";

    // Named types (W.I.F.) group by component name; the BOL/Building toggle
    // value moves to the second column.
    const gLabel = t.named ? "Item Name" : groupLabel;
    const oLabel = t.named ? groupLabel : otherLabel;
    const table = document.createElement("table");
    table.className = "wh-group-table";
    table.innerHTML = `<thead><tr>
        <th>Units</th><th>${escapeHtml(gLabel)}</th>
        <th>${escapeHtml(oLabel)}</th>
        <th>Date Checked In</th><th>Status</th><th></th>
      </tr></thead>`;
    const tbody = document.createElement("tbody");
    t.groups.forEach((g) =>
      addGroupRows(tbody, t.item_type, data.group_by, g, t.named));
    table.appendChild(tbody);
    body.appendChild(table);

    head.onclick = () => {
      body.classList.toggle("hidden");
      head.querySelector(".wh-caret").innerHTML =
        body.classList.contains("hidden") ? "&#9656;" : "&#9662;";
    };

    typeEl.appendChild(head);
    typeEl.appendChild(body);
    tree.appendChild(typeEl);
  });
}

const STATUS_BADGE = {
  "Delivered": "badge-out",
  "In Warehouse": "badge-in",
  "Partial": "badge-partial",
};

// The distinct values of the non-grouped dimension (e.g. the BOLs inside a
// building group). Long lists are truncated; hover shows the full set.
function otherValuesHtml(g) {
  const vals = g.other_values || [];
  if (!vals.length) return "";
  const shown = vals.slice(0, 3).map(escapeHtml).join(", ");
  const extra = vals.length > 3
    ? ` <span class="hint">+${vals.length - 3} more</span>` : "";
  return `<span title="${escapeHtml(vals.join(", "))}">${shown}${extra}</span>`;
}

function addGroupRows(tbody, itemType, groupBy, g, named) {
  const row = document.createElement("tr");
  row.className = "wh-group-row";
  const statusCls = STATUS_BADGE[g.status] || "badge-in";
  const capacity = g.capacity != null ? g.capacity : g.total;
  const statusText = g.status === "Partial"
    ? `Partial (${g.in_wh}/${capacity})`
    : g.status;
  const boxes = g.boxes != null ? g.boxes : g.total;
  const deleteBtn = isEditing()
    ? ` <button class="danger-btn group-delete-btn" title="Delete every box in this group">Delete</button>`
    : "";
  // Component rows (named types) can span several BOLs, so no single PDF.
  const pdfBtn = !named && groupBy === "bol" && g.bol_doc_id
    ? ` <button class="bol-pdf-btn" title="View the scanned bill of lading">BOL PDF</button>`
    : "";
  const noteBadge = g.note_count
    ? ` <span class="note-count" title="${g.note_count} note(s) on this group \u2014 expand to read">
         ${g.note_count} note${g.note_count === 1 ? "" : "s"}</span>`
    : "";
  row.innerHTML = `
    <td>${g.qty}</td>
    <td><span class="wh-caret">&#9656;</span> ${escapeHtml(g.value || "(blank)")}</td>
    <td>${otherValuesHtml(g)}</td>
    <td>${escapeHtml(fmtDateTime(g.received_at) || g.received || "")}</td>
    <td><span class="badge ${statusCls}">${escapeHtml(statusText)}</span></td>
    <td class="wh-count">${boxes} box(es)${noteBadge}${pdfBtn}${deleteBtn}</td>`;
  const pdfLink = row.querySelector(".bol-pdf-btn");
  if (pdfLink) {
    pdfLink.onclick = (ev) => {
      ev.stopPropagation();
      window.open(`/api/bol/${g.bol_doc_id}/file`, "_blank");
    };
  }
  const delBtn = row.querySelector(".group-delete-btn");
  if (delBtn) {
    delBtn.onclick = (ev) => {
      ev.stopPropagation();
      deleteGroup(itemType, groupBy, g, boxes, named);
    };
  }

  const detail = document.createElement("tr");
  detail.className = "wh-detail-row hidden";
  const cell = document.createElement("td");
  cell.colSpan = 6;
  cell.innerHTML = `<p class="hint">Loading units\u2026</p>`;
  detail.appendChild(cell);

  let loaded = false;
  row.onclick = async () => {
    detail.classList.toggle("hidden");
    row.querySelector(".wh-caret").innerHTML =
      detail.classList.contains("hidden") ? "&#9656;" : "&#9662;";
    if (!loaded && !detail.classList.contains("hidden")) {
      loaded = true;
      await loadGroupTags(cell, itemType, groupBy, g.value, g, named);
    }
  };

  tbody.appendChild(row);
  tbody.appendChild(detail);
}

// Admin edit mode: delete every tag in one (item_type, group) cell.
async function deleteGroup(itemType, groupBy, g, boxes, named) {
  const groupLabel = named ? "Item Name"
    : (groupBy === "building" ? "Building" : "BOL");
  const ok = window.confirm(
    `Delete ALL ${itemType} under ${groupLabel} '${g.value || "(blank)"}'? ` +
    `This permanently removes ${boxes} box(es) (${g.qty} unit(s) in warehouse). ` +
    "This cannot be undone.");
  if (!ok) return;
  const data = await adminPost("/api/admin/group/delete",
    { item_type: itemType, group_by: groupBy, value: g.value || "" });
  if (data && data.ok) {
    logActivity(data.message || "Group deleted", "warn");
    await loadWarehouse();
  } else if (data) {
    logActivity(data.message || "Delete failed", "err");
  }
}

async function loadGroupTags(cell, itemType, groupBy, value, groupInfo, named) {
  try {
    const q = whFilterParams(new URLSearchParams(
      { item_type: itemType, group_by: groupBy, value: value || "" }));
    const [data, notes] = await Promise.all([
      fetch(`/api/inventory/group?${q.toString()}`).then((r) => r.json()),
      fetchNotes(groupNoteParams(itemType, groupBy, value, named)),
    ]);
    const editing = isEditing();
    let tableHtml;
    if (!data.tags || !data.tags.length) {
      tableHtml = `<p class="hint">No units.</p>`;
    } else {
      // Component rows (named types) aren't pinned to a BOL or building, so
      // their boxes show both dimensions.
      const dimHeads = named
        ? `<th>BOL #</th><th>Building #</th>`
        : `<th>${escapeHtml(groupBy === "building" ? "BOL #" : "Building #")}</th>`;
      const rows = data.tags.map((tag) =>
        tagRowHtml(tag, itemType, editing, groupBy, named)).join("");
      tableHtml = `<table class="wh-tag-table">
        <thead><tr><th>EPC</th>${dimHeads}<th>PO #</th>
          <th>SKU</th><th>Qty</th><th>Mfc date</th>
          <th>Checked in</th><th>Checked out</th><th>Checked out to</th>
          <th>Status</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table>`;
    }
    cell.innerHTML = `<div class="group-notes"></div>${tableHtml}`;
    renderGroupNotes(cell.querySelector(".group-notes"),
                     itemType, groupBy, value, groupInfo, notes, named);
    cell.querySelectorAll(".find-btn").forEach((b) => {
      b.onclick = (ev) => { ev.stopPropagation(); openFinder(b.dataset.epc, b.dataset.label); };
    });
    cell.querySelectorAll(".checkout-btn").forEach((b) => {
      b.onclick = (ev) => { ev.stopPropagation(); checkoutFromWarehouse(b.dataset.epc); };
    });
    cell.querySelectorAll(".epc-link").forEach((el) => {
      el.onclick = (ev) => { ev.stopPropagation(); openMode("eventlog", { epc: el.dataset.epc }); };
    });
    if (editing) wireTagEditors(cell);
  } catch (e) {
    cell.innerHTML = `<p class="hint">Could not load units.</p>`;
  }
}

// -- warehouse group notes -----------------------------------------------------
// List params: only the row's grouped dimension (a BOL row spans buildings and
// vice versa, and all of its notes should be readable from it). Notes key on
// (item_type, bol, building) -- component rows of named types don't map to
// that triple, so they list every note on the item type.
function groupNoteParams(itemType, groupBy, value, named) {
  const p = { item_type: itemType };
  if (named) return p;
  if (groupBy === "building") p.building = value || "";
  else p.bol_number = value || "";
  return p;
}

// Add body: pin down the other dimension too when the group only spans one
// value of it (the common case), so the note also shows up at check-in.
function groupNoteAddBody(itemType, groupBy, value, groupInfo, named) {
  const others = (groupInfo && groupInfo.other_values) || [];
  const other = others.length === 1 ? String(others[0]) : "";
  if (named) {
    // A component row's other_values hold the toggled dimension; pin it only
    // when the component sits under a single BOL/building.
    return groupBy === "building"
      ? { item_type: itemType, building: other, bol_number: "" }
      : { item_type: itemType, bol_number: other, building: "" };
  }
  return groupBy === "building"
    ? { item_type: itemType, building: value || "", bol_number: other }
    : { item_type: itemType, bol_number: value || "", building: other };
}

function renderGroupNotes(container, itemType, groupBy, value, groupInfo, notes,
                          named) {
  if (!container) return;
  const editing = isEditing();
  const list = notes.length
    ? `<ul class="note-list">${notes.map((n) => noteItemHtml(n, editing, true)).join("")}</ul>`
    : `<p class="hint">No notes for this shipment yet.</p>`;
  container.innerHTML = `
    <div class="group-notes-head">Notes</div>
    ${list}
    <div class="note-add">
      <textarea rows="2" class="group-note-text"
        placeholder="Add a note about this shipment\u2026"></textarea>
      <button class="primary-btn note-add-btn group-note-add">Add note</button>
    </div>`;
  const ta = container.querySelector(".group-note-text");
  const btn = container.querySelector(".group-note-add");
  const reload = async () => {
    renderGroupNotes(container, itemType, groupBy, value, groupInfo,
                     await fetchNotes(groupNoteParams(itemType, groupBy, value,
                                                      named)),
                     named);
  };
  const submit = async () => {
    const text = ta.value.trim();
    if (!text) return;
    btn.disabled = true;
    try {
      const res = await fetch("/api/notes", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          { ...groupNoteAddBody(itemType, groupBy, value, groupInfo, named),
            text }),
      });
      const data = await res.json();
      if (data.ok) {
        logActivity("Note added to shipment", "ok");
        await reload();
        return;
      }
      logActivity(data.message || "Could not add note", "err");
    } catch (e) {
      logActivity("Cannot reach server", "err");
    }
    btn.disabled = false;
  };
  btn.onclick = submit;
  ta.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
  };
  container.querySelectorAll(".note-del-btn").forEach((b) => {
    b.onclick = async (ev) => {
      ev.stopPropagation();
      const data = await adminPost("/api/admin/note/delete",
        { id: parseInt(b.dataset.id, 10) });
      if (data && data.ok) {
        logActivity("Note deleted", "warn");
        await reload();
      } else if (data) {
        logActivity(data.message || "Could not delete note", "err");
      }
    };
  });
}

function tagRowHtml(tag, itemType, editing, groupBy, named) {
  const dimCells = named
    ? `<td>${escapeHtml(tag.bol_number || "")}</td>
       <td>${escapeHtml(tag.building || "")}</td>`
    : `<td>${escapeHtml((groupBy === "building"
        ? tag.bol_number : tag.building) || "")}</td>`;
  const statusCls = STATUS_BADGE[tag.status] || "badge-in";
  const flagBadge = tag.flag
    ? `<span class="badge badge-flag" title="${escapeHtml(tag.flag)}">&#9888; Flagged</span>`
    : "";
  const findBtn = `<button class="find-btn" data-epc="${escapeHtml(tag.epc)}"
    data-label="${escapeHtml(itemType + " \u00b7 " + (tag.sku || tag.epc))}">Find</button>`;
  const checkoutBtn = tag.remaining > 0
    ? ` <button class="checkout-btn" data-epc="${escapeHtml(tag.epc)}"
        title="Check this box out">Check Out</button>` : "";
  const editBtn = editing
    ? ` <button class="edit-btn" data-epc="${escapeHtml(tag.epc)}">Edit</button>` : "";
  let editorRow = "";
  if (editing) {
    editorRow = `<tr class="tag-editor-row hidden" data-editor="${escapeHtml(tag.epc)}">
      <td colspan="${named ? 12 : 11}">${tagEditorHtml(tag)}</td></tr>`;
  }
  const deliveredAt = tag.delivered_at ? fmtDateTime(tag.delivered_at) : "";
  const checkedOutTo = tag.checkout_building ? `Bldg ${tag.checkout_building}` : "";
  const qty = `${tag.remaining != null ? tag.remaining : ""}` +
    (tag.quantity != null ? ` / ${tag.quantity}` : "");
  return `<tr>
      <td class="epc epc-link" data-epc="${escapeHtml(tag.epc)}"
          title="View this tag's event history">${escapeHtml(tag.epc)}</td>
      ${dimCells}
      <td>${escapeHtml(tag.po_number || "")}</td>
      <td>${escapeHtml(tag.sku || "")}</td>
      <td class="qty-cell">${escapeHtml(qty)}</td>
      <td>${escapeHtml(tag.mfc_date || "")}</td>
      <td>${escapeHtml(fmtDateTime(tag.received_at))}</td>
      <td>${escapeHtml(deliveredAt)}</td>
      <td>${escapeHtml(checkedOutTo)}</td>
      <td><span class="badge ${statusCls}">${escapeHtml(tag.status)}</span> ${flagBadge}</td>
      <td class="wh-actions">${findBtn}${checkoutBtn}${editBtn}</td>
    </tr>${editorRow}`;
}

function tagEditorHtml(tag) {
  const fields = EDIT_FIELDS.map((f) => {
    const val = tag[f.key] || "";
    let input;
    if (f.type === "status") {
      const opts = ["In Warehouse", "Partial", "Delivered"].map((s) =>
        `<option value="${s}"${s === tag.status ? " selected" : ""}>${s}</option>`).join("");
      input = `<select data-field="status">${opts}</select>`;
    } else if (f.type === "number") {
      input = `<input type="number" min="0" step="1" data-field="${f.key}"
        value="${escapeHtml(val)}" />`;
    } else if (f.type === "building" || f.type === "vendor") {
      const choices = f.type === "building"
        ? (state.config.building_options || [])
        : state.vendors;
      const opts = [`<option value=""${val ? "" : " selected"}></option>`].concat(
        (choices || []).map((c) =>
          `<option value="${escapeHtml(c)}"${c === val ? " selected" : ""}>${escapeHtml(c)}</option>`));
      // Keep an out-of-list value selectable so existing data isn't lost.
      if (val && !(choices || []).map(String).includes(String(val))) {
        opts.push(`<option value="${escapeHtml(val)}" selected>${escapeHtml(val)}</option>`);
      }
      input = `<select data-field="${f.key}">${opts.join("")}</select>`;
    } else {
      input = `<input type="${f.type === "date" ? "date" : "text"}"
        data-field="${f.key}" value="${escapeHtml(val)}" />`;
    }
    return `<label class="edit-field"><span>${escapeHtml(f.label)}</span>${input}</label>`;
  }).join("");
  const clearFlagBtn = tag.flag
    ? `<button class="warn-btn clear-flag-btn" data-epc="${escapeHtml(tag.epc)}">Clear flag</button>` : "";
  return `<div class="tag-editor" data-epc="${escapeHtml(tag.epc)}">
      <div class="edit-grid">${fields}</div>
      <div class="edit-actions">
        <button class="primary-btn save-tag-btn" data-epc="${escapeHtml(tag.epc)}">Save</button>
        ${clearFlagBtn}
      </div>
    </div>`;
}

function wireTagEditors(cell) {
  cell.querySelectorAll(".edit-btn").forEach((b) => {
    b.onclick = (ev) => {
      ev.stopPropagation();
      const editor = cell.querySelector(`tr[data-editor="${cssEscape(b.dataset.epc)}"]`);
      if (editor) editor.classList.toggle("hidden");
    };
  });
  cell.querySelectorAll(".save-tag-btn").forEach((b) => {
    b.onclick = (ev) => { ev.stopPropagation(); saveTag(b.dataset.epc, b.closest(".tag-editor")); };
  });
  cell.querySelectorAll(".clear-flag-btn").forEach((b) => {
    b.onclick = (ev) => { ev.stopPropagation(); clearTagFlag(b.dataset.epc); };
  });
}

function cssEscape(s) {
  return String(s).replace(/["\\]/g, "\\$&");
}

async function saveTag(epc, editorEl) {
  if (!editorEl) return;
  const fields = {};
  editorEl.querySelectorAll("[data-field]").forEach((el) => {
    fields[el.dataset.field] = el.value;
  });
  const data = await adminPost("/api/admin/tag", { epc, fields });
  if (data && data.ok) {
    logActivity(`Updated ${epc}`, "ok");
    await loadWarehouse();
  } else if (data) {
    logActivity(data.message || "Edit failed", "err");
  }
}

async function clearTagFlag(epc) {
  const data = await adminPost("/api/admin/tag/clear_flag", { epc });
  if (data && data.ok) {
    logActivity(`Cleared flag on ${epc}`, "ok");
    await loadWarehouse();
  } else if (data) {
    logActivity(data.message || "Could not clear flag", "err");
  }
}

// Warehouse "Check Out" button: jump straight to the checkout confirm card for
// a specific box (no trigger pull needed). The reader is still armed for
// checkout, and the building buttons default to the box's check-in building.
async function checkoutFromWarehouse(epc) {
  await openMode("checkout");
  try {
    const res = await fetch(`/api/checkout/lookup?epc=${encodeURIComponent(epc)}`);
    onCheckoutPrompt(await res.json());
  } catch (e) {
    logActivity("Cannot reach server", "err");
  }
}

// -- warehouse export (CSV download / print-to-PDF) ---------------------------
function exportWarehouseCsv() {
  const q = whFilterParams(new URLSearchParams());
  window.location.href = `/api/inventory/export.csv?${q.toString()}`;
}

async function exportWarehousePdf() {
  const q = whFilterParams(new URLSearchParams());
  let data;
  try {
    data = await (await fetch(`/api/inventory/export?${q.toString()}`)).json();
  } catch (e) {
    logActivity("Could not load export data", "err");
    return;
  }
  const rows = data.rows || [];
  if (!rows.length) {
    logActivity("Nothing to export with these filters", "warn");
    return;
  }
  const cols = data.columns || [];
  const keys = data.keys || [];
  const dateKeys = new Set(["received_at", "delivered_at"]);
  const header = cols.map((c) => `<th>${escapeHtml(c)}</th>`).join("");
  const body = rows.map((tag) =>
    `<tr>${keys.map((k) => {
      let v = tag[k];
      if (dateKeys.has(k)) v = v ? fmtDateTime(v) : "";
      return `<td>${escapeHtml(v == null ? "" : v)}</td>`;
    }).join("")}</tr>`).join("");
  const filters = Object.entries(state.whFilters)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`)
    .join(" \u00b7 ");
  $("print-area").innerHTML =
    `<img src="/brand/bg-logo-horizontal-navy.png" alt="Brasfield &amp; Gorrie" class="print-logo" />
     <h1>Warehouse Inventory</h1>
     <p>Exported ${new Date().toLocaleString()}${filters ? ` \u00b7 Filters \u2014 ${escapeHtml(filters)}` : ""}
       \u00b7 ${rows.length} box(es)</p>
     <table>
       <thead><tr>${header}</tr></thead>
       <tbody>${body}</tbody>
     </table>`;
  window.print();
}

// -- material requests ---------------------------------------------------------
// Jobsite users submit requests on the cloud site; the sync worker pulls them
// here. Fulfill/decline updates local state immediately and is pushed back to
// the cloud on the next sync (which /api/requests/handle kicks off).
const REQUEST_BADGE = {
  pending: "badge-partial", staging: "badge-staging",
  fulfilled: "badge-in", declined: "badge-out",
};
const REQUEST_STATUS_LABEL = { staging: "staging for exit" };

// Order key -> user's expand/collapse choice, surviving the re-render after
// every action. Orders without a choice default to expanded while any line
// still needs handling.
const orderExpanded = new Map();

function updateSyncDetail() {
  const el = $("sync-detail");
  if (!el) return;
  const s = state.sync;
  if (!s || !s.enabled) {
    el.textContent = "Cloud sync is off (set cloud_url in settings.ini).";
    return;
  }
  const last = s.last_sync
    ? `Last synced ${fmtDateTime(s.last_sync)}` : "Never synced yet";
  const pending = s.pending ? ` \u00b7 ${s.pending} change(s) pending` : "";
  const err = s.online ? "" : ` \u00b7 offline: ${s.error || "cloud unreachable"}`;
  el.textContent = `${last}${pending}${err}`;
}

async function syncNow() {
  try {
    const data = await (await fetch("/api/sync/now", { method: "POST" })).json();
    logActivity(data.message || (data.ok ? "Sync started" : "Sync failed"),
                data.ok ? "ok" : "warn");
  } catch (e) {
    logActivity("Cannot reach server", "err");
  }
}

async function loadRequests() {
  const wrap = $("requests-list");
  wrap.innerHTML = `<p class="hint">Loading\u2026</p>`;
  let data;
  try {
    data = await (await fetch("/api/requests")).json();
  } catch (e) {
    wrap.innerHTML = `<p class="hint">Could not load requests.</p>`;
    return;
  }
  updateRequestsBadge(data.pending || 0);
  renderRequests(data.requests || []);
}

// One card per ORDER (lines submitted together share an order_ref), with a
// collapsible list of its line items; every line keeps its own
// fulfill/decline/resume/cancel actions and status. Rows arrive from the
// server open-first/newest-first; grouping preserves that order, so an order
// with any staging or pending line surfaces before completed ones.
function groupRequestOrders(rows) {
  const orders = new Map();
  rows.forEach((r) => {
    const key = r.order_ref || `request-${r.id}`;
    let o = orders.get(key);
    if (!o) {
      o = { key, ref: r.order_ref, lines: [] };
      orders.set(key, o);
    }
    o.lines.push(r);
  });
  orders.forEach((o) => o.lines.sort((a, b) => a.id - b.id));
  return [...orders.values()];
}

function renderRequestLine(r) {
  const badgeCls = REQUEST_BADGE[r.status] || "badge-partial";
  const badgeTxt = REQUEST_STATUS_LABEL[r.status] || r.status;
  const handled = (r.status === "fulfilled" || r.status === "declined")
    ? `<div class="request-handled hint">${escapeHtml(r.status)}
         ${r.handled_at ? escapeHtml(fmtDateTime(r.handled_at)) : ""}
         ${r.handler_note ? `\u2014 ${escapeHtml(r.handler_note)}` : ""}</div>`
    : "";
  let actions = "";
  if (r.status === "pending") {
    actions = `<div class="request-actions">
         <button class="primary-btn req-fulfill" data-id="${r.id}">Fulfill</button>
         <button class="danger-btn req-decline" data-id="${r.id}">Decline</button>
       </div>`;
  } else if (r.status === "staging") {
    actions = `<div class="request-actions">
         <button class="primary-btn req-resume" data-id="${r.id}">Resume staging</button>
         <button class="back-btn req-cancel" data-id="${r.id}">Cancel</button>
       </div>`;
  }
  const open = r.status === "pending" || r.status === "staging";
  return `<div class="request-card${open ? " request-pending" : ""}">
    <div class="request-main">
      <div class="request-title">
        <span class="request-qty">${r.quantity}\u00d7</span>
        <strong>${escapeHtml(r.item_type)}${r.item_name
          ? ` | ${escapeHtml(r.item_name)}` : ""}</strong>
        <span class="badge ${badgeCls}">${escapeHtml(badgeTxt)}</span>
      </div>
      <div class="request-meta hint">#${r.id}${r.building
          ? ` \u00b7 Deliver to Bldg ${escapeHtml(r.building)}` : ""}</div>
      ${handled}
    </div>${actions}
  </div>`;
}

function renderRequests(rows) {
  const wrap = $("requests-list");
  if (!rows.length) {
    wrap.innerHTML = `<p class="hint">No material requests yet. They appear
      here when someone submits one on the cloud site.</p>`;
    return;
  }
  const requestsById = {};
  rows.forEach((r) => { requestsById[r.id] = r; });

  const html = groupRequestOrders(rows).map((o) => {
    const first = o.lines[0];
    const openCount = o.lines.filter(
      (r) => r.status === "pending" || r.status === "staging").length;
    const expanded = orderExpanded.has(o.key)
      ? orderExpanded.get(o.key) : openCount > 0;
    // Status roll-up for the collapsed view, e.g. "2 pending · 1 fulfilled".
    const counts = {};
    o.lines.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; });
    const summary = Object.entries(counts).map(([status, n]) =>
      `<span class="badge ${REQUEST_BADGE[status] || "badge-partial"}">
         ${n} ${escapeHtml(status)}</span>`).join(" ");
    const units = o.lines.reduce((sum, r) => sum + (r.quantity || 0), 0);
    const who = [first.requester, first.jobsite && `Jobsite: ${first.jobsite}`,
                 first.contact]
      .filter(Boolean).map(escapeHtml).join(" \u00b7 ");
    // requester/jobsite/contact/note are order-level (identical on every
    // line of a cart); delivery building is per line.
    const note = first.note
      ? `<div class="request-note">\u201C${escapeHtml(first.note)}\u201D</div>`
      : "";
    const title = o.ref ? `Order ${escapeHtml(o.ref)}`
                        : `Request #${first.id}`;
    return `<div class="order-card${openCount ? " request-pending" : ""}"
                 data-key="${escapeHtml(o.key)}">
      <div class="order-head">
        <span class="wh-caret">${expanded ? "&#9662;" : "&#9656;"}</span>
        <div class="request-main">
          <div class="request-title">
            <strong>${title}</strong>
            <span class="order-count hint">${o.lines.length}
              item${o.lines.length === 1 ? "" : "s"} \u00b7 ${units} unit(s)</span>
            ${summary}
          </div>
          <div class="request-meta hint">${escapeHtml(fmtDateTime(first.created_at))}
            ${who ? `\u00b7 ${who}` : ""}</div>
          ${note}
        </div>
      </div>
      <div class="order-lines"${expanded ? "" : " hidden"}>
        ${o.lines.map(renderRequestLine).join("")}
      </div>
    </div>`;
  }).join("");
  wrap.innerHTML = html;

  wrap.querySelectorAll(".order-card .order-head").forEach((head) => {
    head.onclick = () => {
      const card = head.closest(".order-card");
      const lines = card.querySelector(".order-lines");
      lines.hidden = !lines.hidden;
      head.querySelector(".wh-caret").innerHTML =
        lines.hidden ? "&#9656;" : "&#9662;";
      orderExpanded.set(card.dataset.key, !lines.hidden);
    };
  });
  wrap.querySelectorAll(".req-fulfill, .req-resume").forEach((b) => {
    b.onclick = () => startRequestFulfillment(
      requestsById[parseInt(b.dataset.id, 10)]);
  });
  wrap.querySelectorAll(".req-decline").forEach((b) => {
    b.onclick = () => confirmDeclineRequest(parseInt(b.dataset.id, 10));
  });
  wrap.querySelectorAll(".req-cancel").forEach((b) => {
    b.onclick = () => cancelRequestStaging(parseInt(b.dataset.id, 10));
  });
}

function confirmDeclineRequest(id) {
  showModal(`Decline request #${id}?`,
    `<p>The requester sees this status (and your note) on the cloud site
        after the next sync.</p>
     <label class="edit-field"><span>Note (optional)</span>
       <input id="request-handle-note" type="text"
         placeholder="e.g. Out of stock until August" maxlength="200" />
     </label>`,
    [{ label: "Decline", cls: "danger-btn",
       onClick: () => handleRequest(id, "declined") },
     { label: "Cancel", cls: "back-btn" }]);
  const input = $("request-handle-note");
  if (input) input.focus();
}

async function handleRequest(id, status) {
  const input = $("request-handle-note");
  const note = input ? input.value.trim() : "";
  try {
    const res = await fetch("/api/requests/handle", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, status, note }),
    });
    const data = await res.json();
    if (data.ok) {
      logActivity(data.message || `Request #${id} ${status}`, "ok");
    } else {
      logActivity(data.message || "Could not update request", "err");
    }
  } catch (e) {
    logActivity("Cannot reach server", "err");
  }
  await loadRequests();
}

// -- event log ---------------------------------------------------------------
// Raw audit actions -> friendly label + badge class for the log table.
const EVENT_LABELS = {
  IN: { label: "Check-In", cls: "badge-in" },
  OUT: { label: "Check-Out", cls: "badge-out" },
  COUNT: { label: "Scan", cls: "badge-in" },
  FLAG: { label: "Flagged", cls: "badge-flag" },
  UNFLAG: { label: "Flag cleared", cls: "badge-in" },
  EDIT: { label: "Edited", cls: "badge-partial" },
  DELETE: { label: "Group deleted", cls: "badge-out" },
  CLEAR: { label: "DB cleared", cls: "badge-out" },
  VENDOR_ADD: { label: "Vendor added", cls: "badge-in" },
  VENDOR_DEL: { label: "Vendor removed", cls: "badge-out" },
  BOL_SCAN: { label: "BOL scanned", cls: "badge-in" },
  BOL_RENAME: { label: "BOL renamed", cls: "badge-partial" },
  NOTE: { label: "Note added", cls: "badge-in" },
  NOTE_DEL: { label: "Note deleted", cls: "badge-out" },
  REQUEST: { label: "Request received", cls: "badge-partial" },
  REQUEST_STAGING: { label: "Staging for request", cls: "badge-partial" },
  REQUEST_PENDING: { label: "Staging canceled", cls: "badge-partial" },
  REQUEST_FULFILLED: { label: "Request fulfilled", cls: "badge-in" },
  REQUEST_DECLINED: { label: "Request declined", cls: "badge-out" },
};

let eventSearchTimer = null;

async function loadEvents() {
  const list = $("event-log-list");
  list.innerHTML = `<p class="hint">Loading\u2026</p>`;
  const epc = ($("event-epc").value || "").trim();
  const q = new URLSearchParams({ filter: state.eventFilter });
  if (epc) q.set("epc", epc);
  try {
    const data = await (await fetch(`/api/events?${q.toString()}`)).json();
    renderEvents(data.events || []);
  } catch (e) {
    list.innerHTML = `<p class="hint">Could not load events.</p>`;
  }
}

function renderEvents(events) {
  const list = $("event-log-list");
  if (!events.length) {
    list.innerHTML = `<p class="hint">No events match this filter.</p>`;
    return;
  }
  const rows = events.map((e) => {
    const meta = EVENT_LABELS[e.action] || { label: e.action, cls: "badge-in" };
    const epcCell = e.epc
      ? `<span class="epc event-epc-link" data-epc="${escapeHtml(e.epc)}"
           title="Show events for this tag">${escapeHtml(e.epc)}</span>`
      : "";
    return `<tr>
      <td>${escapeHtml(fmtDateTime(e.ts))}</td>
      <td><span class="badge ${meta.cls}">${escapeHtml(meta.label)}</span></td>
      <td>${epcCell}</td>
      <td>${escapeHtml(e.item_type)}</td>
      <td>${escapeHtml(e.bol_number)}</td>
      <td>${escapeHtml(e.building)}</td>
      <td>${escapeHtml(e.detail)}</td>
    </tr>`;
  }).join("");
  list.innerHTML = `<table class="event-table">
    <thead><tr><th>Time</th><th>Action</th><th>EPC</th><th>Type</th>
      <th>BOL</th><th>Building</th><th>Detail</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <p class="hint">${events.length} event(s) shown (most recent first).</p>`;
  list.querySelectorAll(".event-epc-link").forEach((el) => {
    el.onclick = () => {
      $("event-epc").value = el.dataset.epc;
      loadEvents();
    };
  });
}

// -- finder ------------------------------------------------------------------
async function openFinder(epc, label) {
  state.mode = "finder";
  state.finder = { epc, rssiMin: null, rssiMax: null,
                   proxEma: null, samples: 0, found: false };
  $("panel-title").textContent = MODE_TITLES.finder;
  hide("power-control"); hide("scanner"); hide("result");
  showView("finder-view");
  $("finder-target").innerHTML =
    `<div class="finder-label">${escapeHtml(label || epc)}</div>
     <div class="epc">${escapeHtml(epc)}</div>`;
  resetFinderPulse();
  ensureFinderAudio();   // the Find click unlocks the AudioContext
  startFinderTone();
  await setServerMode("finder", { target_epc: epc });
  logActivity(`Finding ${epc}\u2026`, "ok");
}

function resetFinderPulse() {
  const fill = $("finder-bar-fill");
  if (fill) {
    fill.style.setProperty("--fill", 0);
    fill.classList.remove("red");
  }
  $("finder-strength").textContent = "No signal yet";
  $("finder-rssi").textContent = "Hold the trigger and move the reader around.";
  $("finder-view").classList.remove("finder-found");
  muteFinderTone();
  if (state.finder) {
    state.finder.rssiMin = null;
    state.finder.rssiMax = null;
    state.finder.proxEma = null;
    state.finder.samples = 0;
    state.finder.found = false;
  }
}

function onFinder(msg) {
  if (!state.finder || msg.epc !== state.finder.epc) return;
  const f = state.finder;

  // Preferred: the reader's FindTag RP: proximity percentage (already scaled
  // 0-100 across the min/max it has seen), streamed continuously.
  let prox, readout;
  if (msg.percent != null) {
    prox = Math.max(0, Math.min(1, msg.percent / 100));
    // TEMP range-tuning: show raw dBm next to the percent.
    readout = `Signal: ${msg.percent}%` +
      (msg.rssi != null ? ` (${msg.rssi} dBm)` : "");
  } else if (msg.rssi != null) {
    // Fallback: adaptive scale from raw RSSI (we don't assume the units).
    const rssi = msg.rssi;
    if (f.rssiMin == null) { f.rssiMin = rssi - 1; f.rssiMax = rssi + 1; }
    if (rssi < f.rssiMin) f.rssiMin = rssi;
    if (rssi > f.rssiMax) f.rssiMax = rssi;
    const span = f.rssiMax - f.rssiMin;
    prox = span > 0 ? (rssi - f.rssiMin) / span : 0.5;
    readout = `Signal: ${rssi}`;
  } else {
    return;
  }

  // Light smoothing so the bar/tone track quickly but don't jitter.
  f.proxEma = f.proxEma == null
    ? prox
    : FINDER_PROX_ALPHA * prox + (1 - FINDER_PROX_ALPHA) * f.proxEma;
  f.samples += 1;
  const proxEma = f.proxEma;

  // Vertical bar: only appears past the show threshold, red near the top.
  const fill = $("finder-bar-fill");
  if (fill) {
    const pct = proxEma >= FINDER_BAR_SHOW ? Math.round(proxEma * 100) : 0;
    fill.style.setProperty("--fill", pct);
    fill.classList.toggle("red", proxEma >= FINDER_BAR_RED);
  }

  // Tone: only sounds at/above the show threshold (matches the bar), pitch
  // climbing with proximity; silent below so it isn't a constant drone.
  finderLastSignal = performance.now();
  if (proxEma >= FINDER_BAR_SHOW) updateFinderTone(proxEma);
  else muteFinderTone();

  let word = "Far";
  if (proxEma > 0.85) word = "Right here!";
  else if (proxEma > 0.6) word = "Very close";
  else if (proxEma > 0.35) word = "Getting warmer";
  else if (proxEma > 0.15) word = "Cold";
  $("finder-strength").textContent = word;
  $("finder-rssi").textContent = readout;

  // Hybrid confidence gate with hysteresis: fire once on entering "found",
  // re-arm only after backing away below the lower threshold.
  if (!f.found && proxEma >= FINDER_FOUND_PROX && f.samples >= FINDER_MIN_SAMPLES) {
    f.found = true;
    onFinderLock();
  } else if (f.found && proxEma <= FINDER_REARM_PROX) {
    f.found = false;
    $("finder-view").classList.remove("finder-found");
  }
}

function onFinderReset() {
  // Trigger released: forget the adaptive scale so the next aim starts fresh.
  // The beep loop keeps running but goes silent until a new signal arrives.
  if (state.mode !== "finder" || !state.finder) return;
  resetFinderPulse();
}

function onFinderLock() {
  $("finder-view").classList.add("finder-found");
  // Distinct double-chirp so the lock is audible over the cadence beep.
  playTick(1320, 90);
  setTimeout(() => playTick(1320, 90), 130);
  logActivity("Target locked \u2014 vibrating handheld", "ok");
  fetch("/api/alert", { method: "POST" }).catch(() => {});
}

async function stopFinder() {
  stopFinderTone();
  state.finder = null;
  await setServerMode("idle");
  state.mode = "warehouse";
  $("panel-title").textContent = MODE_TITLES.warehouse;
  showView("warehouse-view");
  await loadWarehouse();
}

// -- finder audio ------------------------------------------------------------
function ensureFinderAudio() {
  try {
    if (!finderAudioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      finderAudioCtx = new Ctx();
    }
    if (finderAudioCtx.state === "suspended") finderAudioCtx.resume();
  } catch (e) {
    return null;
  }
  return finderAudioCtx;
}

function playTick(freq = 880, durMs = 40) {
  const ctx = ensureFinderAudio();
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  const now = ctx.currentTime;
  const dur = durMs / 1000;
  // Short envelope to avoid clicks.
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.25, now + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(now);
  osc.stop(now + dur + 0.02);
}

// Continuous "sweeping" tone: one oscillator that glides in pitch with the
// signal strength. It self-mutes when reads stop (trigger released / tag lost).
function startFinderTone() {
  const ctx = ensureFinderAudio();
  if (!ctx) return;
  stopFinderTone();
  finderOsc = ctx.createOscillator();
  finderGain = ctx.createGain();
  finderOsc.type = "sine";
  finderOsc.frequency.value = FINDER_TONE_MIN_HZ;
  finderGain.gain.value = 0.0001;
  finderOsc.connect(finderGain).connect(ctx.destination);
  finderOsc.start();
  finderLastSignal = 0;
  finderStaleTimer = setInterval(() => {
    if (!finderGain) return;
    if (performance.now() - finderLastSignal > FINDER_SIGNAL_STALE_MS) {
      muteFinderTone();
    }
  }, 120);
}

function updateFinderTone(prox) {
  const ctx = finderAudioCtx;
  if (!ctx || !finderOsc || !finderGain) return;
  const p = Math.max(0, Math.min(1, prox));
  const freq = FINDER_TONE_MIN_HZ + p * (FINDER_TONE_MAX_HZ - FINDER_TONE_MIN_HZ);
  const now = ctx.currentTime;
  // Glide pitch (the "sweep") and bring the tone up to an audible level.
  finderOsc.frequency.setTargetAtTime(freq, now, 0.04);
  finderGain.gain.setTargetAtTime(0.18, now, 0.05);
}

function muteFinderTone() {
  if (!finderAudioCtx || !finderGain) return;
  finderGain.gain.setTargetAtTime(0.0001, finderAudioCtx.currentTime, 0.05);
}

function stopFinderTone() {
  if (finderStaleTimer) { clearInterval(finderStaleTimer); finderStaleTimer = null; }
  if (finderOsc) {
    try {
      muteFinderTone();
      finderOsc.stop(finderAudioCtx ? finderAudioCtx.currentTime + 0.1 : 0);
    } catch (e) { /* already stopped */ }
    finderOsc = null;
  }
  finderGain = null;
}

// -- admin -------------------------------------------------------------------
function renderAdmin() {
  const unlocked = Boolean(state.admin.pin);
  $("admin-locked").classList.toggle("hidden", unlocked);
  $("admin-panel").classList.toggle("hidden", !unlocked);
  if (!unlocked) $("admin-pin").value = "";
  else renderAdminVendors();
}

function renderAdminVendors() {
  const list = $("admin-vendor-list");
  if (!list) return;
  if (!state.vendors.length) {
    list.innerHTML = `<p class="hint">No vendors yet. Add one below.</p>`;
    return;
  }
  list.innerHTML = state.vendors.map((v) =>
    `<span class="vendor-chip">${escapeHtml(v)}
       <button class="vendor-del" data-vendor="${escapeHtml(v)}" title="Remove">&times;</button>
     </span>`).join("");
  list.querySelectorAll(".vendor-del").forEach((b) => {
    b.onclick = () => adminRemoveVendor(b.dataset.vendor);
  });
}

async function adminAddVendor() {
  if (!state.admin.pin) return;
  const input = $("admin-vendor-name");
  const name = (input.value || "").trim();
  if (!name) return;
  const data = await adminPost("/api/admin/vendor", { name });
  if (data && data.ok) {
    state.vendors = data.vendors || state.vendors;
    input.value = "";
    renderAdminVendors();
    logActivity(data.message || `Added vendor ${name}`, "ok");
  } else if (data) {
    logActivity(data.message || "Could not add vendor", "err");
  }
}

async function adminRemoveVendor(name) {
  if (!state.admin.pin) return;
  const data = await adminPost("/api/admin/vendor/remove", { name });
  if (data && data.ok) {
    state.vendors = data.vendors || state.vendors;
    renderAdminVendors();
    logActivity(data.message || `Removed vendor ${name}`, "ok");
  } else if (data) {
    logActivity(data.message || "Could not remove vendor", "err");
  }
}

async function adminPost(url, body) {
  try {
    const res = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: state.admin.pin, ...body }),
    });
    if (res.status === 403) {
      // PIN no longer valid (e.g. changed server-side): re-lock.
      state.admin.pin = null;
      state.admin.editMode = false;
      logActivity("Admin session locked (invalid PIN)", "err");
      return { ok: false, message: "Invalid admin PIN" };
    }
    return await res.json();
  } catch (e) {
    logActivity("Cannot reach server", "err");
    return null;
  }
}

async function adminUnlock() {
  const pin = $("admin-pin").value;
  if (!pin) return;
  try {
    const res = await fetch("/api/admin/verify", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin }),
    });
    const data = await res.json();
    if (data.ok) {
      state.admin.pin = pin;
      renderAdmin();
      logActivity("Admin unlocked", "ok");
    } else {
      logActivity("Invalid admin PIN", "err");
    }
  } catch (e) {
    logActivity("Cannot reach server", "err");
  }
}

function adminLock() {
  state.admin.pin = null;
  state.admin.editMode = false;
  renderAdmin();
  logActivity("Admin locked", "ok");
}

async function adminClearDatabase() {
  if (!state.admin.pin) return;
  const ok = window.confirm(
    "Clear the ENTIRE database? This permanently deletes every tag/unit. " +
    "This cannot be undone.");
  if (!ok) return;
  const data = await adminPost("/api/admin/clear", {});
  if (data && data.ok) {
    logActivity(data.message || "Database cleared", "warn");
    showResult("warn", "Database cleared", `<p>${escapeHtml(data.message || "")}</p>`);
  } else if (data) {
    logActivity(data.message || "Clear failed", "err");
  }
}

async function adminEditRecords() {
  state.admin.editMode = true;
  await openMode("warehouse");
}

// -- modal dialog --------------------------------------------------------------
// Small confirmation overlay. `buttons` is a list of {label, cls, onClick};
// every button closes the modal first, then runs its onClick (if any).
function showModal(title, html, buttons) {
  $("modal-title").textContent = title;
  $("modal-body").innerHTML = html;
  const row = $("modal-actions");
  row.innerHTML = "";
  (buttons || []).forEach((b) => {
    const btn = document.createElement("button");
    btn.className = b.cls || "back-btn";
    btn.textContent = b.label;
    btn.onclick = () => { hideModal(); if (b.onClick) b.onClick(); };
    row.appendChild(btn);
  });
  show("modal-overlay");
}

function hideModal() { hide("modal-overlay"); }

// -- ui helpers --------------------------------------------------------------
function showScanner(title) {
  $("scanner-title").textContent = title;
  $("live-count").textContent = "0";
  show("scanner");
}
function showResult(kind, title, html) {
  const r = $("result");
  r.className = `result ${kind}`;
  r.innerHTML = `<h4>${escapeHtml(title)}</h4>${html}`;
  show("result");
}
function updateReaderStatusDisplay() {
  const el = $("reader-status-detail");
  if (!el) return;
  const fmt = (t) => (t ? t.toLocaleString() : "\u2014");
  el.textContent = `Reader last connected: ${fmt(state.readerLastConnectedAt)}`
    + ` \u00b7 last disconnected: ${fmt(state.readerLastDisconnectedAt)}`;
}
function logActivity(text, kind = "") {
  const li = document.createElement("li");
  if (kind) li.className = kind;
  const ts = new Date().toLocaleTimeString();
  li.innerHTML = `<span class="ts">${ts}</span><span>${escapeHtml(text)}</span>`;
  const list = $("activity");
  list.prepend(li);
  while (list.children.length > 30) list.removeChild(list.lastChild);
}
function show(id) { $(id).classList.remove("hidden"); }
function hide(id) { $(id).classList.add("hidden"); }
function fmtDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString([], {
    year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}
function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Filter input id -> state.whFilters key.
const WH_FILTER_INPUTS = {
  "whf-bol": "bol",
  "whf-building": "building",
  "whf-recv-from": "received_from",
  "whf-recv-to": "received_to",
  "whf-out-from": "checked_out_from",
  "whf-out-to": "checked_out_to",
};
let whFilterTimer = null;

function wireWarehouseFilters() {
  const bldgSelect = $("whf-building");
  (state.config.building_options || []).forEach((b) => {
    const opt = document.createElement("option");
    opt.value = b;
    opt.textContent = b;
    bldgSelect.appendChild(opt);
  });
  Object.entries(WH_FILTER_INPUTS).forEach(([id, key]) => {
    const el = $(id);
    const apply = () => {
      state.whFilters[key] = (el.value || "").trim();
      loadWarehouse();
    };
    if (el.tagName === "INPUT" && el.type === "text") {
      // Debounce free-text typing; dates/selects apply immediately.
      el.oninput = () => {
        clearTimeout(whFilterTimer);
        whFilterTimer = setTimeout(apply, 300);
      };
    } else {
      el.onchange = apply;
    }
  });
  $("whf-clear").onclick = () => {
    Object.entries(WH_FILTER_INPUTS).forEach(([id, key]) => {
      $(id).value = "";
      state.whFilters[key] = "";
    });
    loadWarehouse();
  };
}

// -- wiring ------------------------------------------------------------------
function wireUI() {
  document.querySelectorAll(".mode-card").forEach((c) => {
    c.onclick = () => openMode(c.dataset.mode);
  });
  $("back-btn").onclick = backToModes;
  $("arm-btn").onclick = armCheckin;
  $("finish-btn").onclick = finishCheckin;
  $("bol-scan-btn").onclick = scanBolNew;
  $("bol-upload-btn").onclick = () => $("bol-upload-input").click();
  $("bol-upload-input").onchange = onBolUploadChange;
  $("bol-manual-btn").onclick = startManualBol;
  $("power-slider").oninput = onPowerInput;
  $("wh-refresh").onclick = loadWarehouse;
  $("sweep-reset").onclick = () => {
    resetSweepSession();
    logActivity("Sweep session reset", "ok");
    if (state.mode === "inventory") showScanner("Hold the trigger to sweep\u2026");
  };
  $("wh-export-csv").onclick = exportWarehouseCsv;
  $("wh-export-pdf").onclick = exportWarehousePdf;
  wireWarehouseFilters();
  $("finder-stop").onclick = stopFinder;
  $("admin-unlock").onclick = adminUnlock;
  $("admin-pin").onkeydown = (e) => { if (e.key === "Enter") adminUnlock(); };
  $("admin-lock-btn").onclick = adminLock;
  $("admin-clear").onclick = adminClearDatabase;
  $("admin-edit-records").onclick = adminEditRecords;
  $("admin-vendor-add").onclick = adminAddVendor;
  $("admin-vendor-name").onkeydown = (e) => { if (e.key === "Enter") adminAddVendor(); };
  document.querySelectorAll("#warehouse-view .seg-btn").forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll("#warehouse-view .seg-btn")
        .forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      state.whGroupBy = b.dataset.group;
      loadWarehouse();
    };
  });
  document.querySelectorAll("#event-filter .seg-btn").forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll("#event-filter .seg-btn")
        .forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      state.eventFilter = b.dataset.filter;
      loadEvents();
    };
  });
  $("bol-docs-refresh").onclick = loadBolDocs;
  $("requests-refresh").onclick = loadRequests;
  $("request-confirm-btn").onclick = confirmRequestDelivery;
  $("request-cancel-btn").onclick = () => {
    if (state.activeRequest) cancelRequestStaging(state.activeRequest.id);
  };
  $("sync-now-btn").onclick = syncNow;
  $("sync-pill").onclick = () => {
    if (state.sync && state.sync.enabled) syncNow();
  };
  $("event-refresh").onclick = loadEvents;
  $("event-epc").oninput = () => {
    clearTimeout(eventSearchTimer);
    eventSearchTimer = setTimeout(loadEvents, 250);
  };
  $("event-epc").onkeydown = (e) => {
    if (e.key === "Enter") { clearTimeout(eventSearchTimer); loadEvents(); }
  };
  $("event-epc-clear").onclick = () => { $("event-epc").value = ""; loadEvents(); };
  $("sim-btn").onclick = () => {
    const raw = $("sim-epc").value.trim();
    if (!raw) return;
    const epcs = raw.split(",").map((s) => s.trim()).filter(Boolean);
    fetch("/api/simulate_scan", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ epcs }),
    });
  };
}

boot();
