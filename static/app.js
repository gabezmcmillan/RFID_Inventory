// ---------------------------------------------------------------------------
// RFID Inventory frontend
// ---------------------------------------------------------------------------
const MODE_TITLES = { checkin: "Check In", checkout: "Check Out", inventory: "Inventory" };

const state = {
  config: { item_types: [], type_fields: {}, power_min: 10, power_max: 29 },
  mode: null,         // active UI mode
  selectedType: null,
};

let powerSendTimer = null;

const $ = (id) => document.getElementById(id);

// -- boot --------------------------------------------------------------------
async function boot() {
  state.config = await (await fetch("/api/config")).json();
  initPowerBounds();
  await refreshStatus();
  connectWS();
  wireUI();
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
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dbm }),
    });
    const data = await res.json();
    if (data.ok && data.check_power != null) setPowerSlider(data.check_power);
  } catch (e) {
    logActivity("Could not set reader power", "err");
  }
}

async function refreshStatus() {
  try {
    const s = await (await fetch("/api/status")).json();
    setReaderPill(s.reader_connected);
    setSheetsPill(s.sheets_connected, s.sheets_error);
    if (s.check_power != null) setPowerSlider(s.check_power);
  } catch (e) { /* ignore */ }
}

// -- websocket ---------------------------------------------------------------
function connectWS() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = (ev) => handleMessage(JSON.parse(ev.data));
  ws.onclose = () => setTimeout(connectWS, 1500);
  // keepalive ping
  ws.onopen = () => setInterval(() => { try { ws.send("ping"); } catch (e) {} }, 20000);
}

function handleMessage(msg) {
  switch (msg.type) {
    case "reader_status":
      setReaderPill(msg.connected);
      if (msg.message) logActivity(msg.message, msg.connected ? "ok" : "err");
      break;
    case "live":
      $("live-count").textContent = msg.distinct;
      $("scanner-title").textContent = "Reading\u2026";
      break;
    case "checkin_result":
      onCheckinResult(msg);
      break;
    case "checkout_result":
      onCheckoutResult(msg);
      break;
    case "inventory_result":
      onInventoryResult(msg);
      break;
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
function setSheetsPill(on, err) {
  const p = $("sheets-pill");
  p.className = "pill " + (on ? "pill-on" : "pill-off");
  p.textContent = on ? "Sheets connected" : "Sheets offline";
  if (!on && err) p.title = err;
}

// -- mode navigation ---------------------------------------------------------
async function openMode(mode) {
  state.mode = mode;
  state.selectedType = null;
  $("mode-picker").classList.add("hidden");
  $("panel").classList.remove("hidden");
  $("panel-title").textContent = MODE_TITLES[mode];
  hide("result"); hide("scanner");

  ["checkin-view", "checkout-view", "inventory-view"].forEach((v) => hide(v));
  show(`${mode}-view`);

  // The power slider tunes check-in/check-out range; inventory runs at full power.
  if (mode === "checkin" || mode === "checkout") show("power-control");
  else hide("power-control");

  if (mode === "checkin") {
    state.shipment = null;
    renderTypeButtons();
    hide("checkin-form"); hide("arm-btn"); hide("finish-btn");
    // worker stays idle until the user arms a shipment
    await setServerMode("idle");
  } else if (mode === "checkout") {
    await setServerMode("checkout");
    showScanner("Ready \u2014 pull the trigger to deliver to site");
  } else if (mode === "inventory") {
    await setServerMode("inventory");
    showScanner("Hold the trigger to sweep\u2026");
  }
}

async function backToModes() {
  await setServerMode("idle");
  state.mode = null;
  $("panel").classList.add("hidden");
  $("mode-picker").classList.remove("hidden");
  hide("power-control");
}

async function setServerMode(mode, extra = {}) {
  try {
    const res = await fetch("/api/mode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
  renderCheckinForm(type);
  setFormDisabled(false);
  show("checkin-form"); show("arm-btn");
  hide("finish-btn"); hide("result"); hide("scanner");
}

function setFormDisabled(disabled) {
  $("checkin-form").querySelectorAll("input").forEach((i) => { i.disabled = disabled; });
  document.querySelectorAll(".type-btn").forEach((b) => { b.disabled = disabled; });
}

function renderCheckinForm(type) {
  const form = $("checkin-form");
  form.innerHTML = "";
  (state.config.type_fields[type] || []).forEach((f) => {
    const field = document.createElement("div");
    field.className = "field";
    const label = document.createElement("label");
    label.textContent = f.label;
    const input = document.createElement("input");
    input.type = f.type === "date" ? "date" : "text";
    input.id = `f_${f.key}`;
    field.appendChild(label);
    field.appendChild(input);
    form.appendChild(field);
  });
}

async function armCheckin() {
  if (!state.selectedType) return;
  const fields = {};
  (state.config.type_fields[state.selectedType] || []).forEach((f) => {
    fields[f.key] = ($(`f_${f.key}`).value || "").trim();
  });
  const ok = await setServerMode("checkin", { item_type: state.selectedType, fields });
  if (ok) {
    state.shipment = { type: state.selectedType, fields, qty: 0 };
    hide("result");
    setFormDisabled(true);
    hide("arm-btn"); show("finish-btn");
    showScanner(`Receiving ${state.selectedType} \u2014 pull the trigger on each tagged unit`);
  }
}

async function finishCheckin() {
  await setServerMode("idle");
  state.shipment = null;
  setFormDisabled(false);
  show("arm-btn"); hide("finish-btn"); hide("scanner");
}

function onCheckinResult(msg) {
  if (!msg.ok) {
    showResult("warn", "Shipment not recorded", `<p>${escapeHtml(msg.message)}</p>`);
    logActivity(msg.message, "warn");
    showScanner(`Receiving ${msg.item_type || ""} \u2014 pull the trigger on each tagged unit`);
    return;
  }
  const po = msg.po_number || "n/a";
  const bldg = msg.building || "n/a";
  const dupNote = msg.duplicates && msg.duplicates.length
    ? `<p class="hint">${msg.duplicates.length} tag(s) were already on file (not re-counted).</p>` : "";
  showResult("ok", `Shipment: ${escapeHtml(msg.item_type)} \u00b7 Qty ${msg.qty}`,
    `<table>
       <tr><th>PO Number</th><td>${escapeHtml(po)}</td></tr>
       <tr><th>Building</th><td>${escapeHtml(bldg)}</td></tr>
       <tr><th>Vendor</th><td>${escapeHtml(msg.vendor || "")}</td></tr>
       <tr><th>Just added</th><td>${msg.added}</td></tr>
       <tr><th>Total received (this PO)</th><td>${msg.qty}</td></tr>
     </table>${dupNote}
     <p class="hint">Tag the next unit and pull the trigger, or "Finish / change shipment".</p>`);
  logActivity(`Received ${msg.added} ${msg.item_type} (PO ${po}) \u2014 qty now ${msg.qty}`, "ok");
  showScanner(`Receiving ${msg.item_type} \u2014 pull the trigger on the next unit`);
}

// -- check out ---------------------------------------------------------------
function onCheckoutResult(msg) {
  if (msg.ok) {
    const remaining = (msg.qty_remaining == null) ? "" :
      `<tr><th>Qty left (this PO)</th><td>${msg.qty_remaining}</td></tr>`;
    showResult("ok", "Delivered to site",
      `<p><b>${escapeHtml(msg.item_type || "")}</b> &middot;
         <span class="epc">${escapeHtml(msg.epc)}</span></p>
       <table>
         <tr><th>PO Number</th><td>${escapeHtml(msg.po_number || "n/a")}</td></tr>
         <tr><th>Building</th><td>${escapeHtml(msg.building || "n/a")}</td></tr>
         <tr><th>Delivered</th><td>${escapeHtml(msg.delivered_at || "")}</td></tr>
         ${remaining}
       </table>`);
    logActivity(`Delivered ${msg.item_type} (${msg.epc}) to site`, "ok");
  } else {
    showResult("warn", "Cannot deliver", `<p class="epc">${escapeHtml(msg.epc || "")}</p>
       <p>${escapeHtml(msg.message)}</p>`);
    logActivity(msg.message, "warn");
  }
  // stay armed for the next delivery
  showScanner("Ready \u2014 pull the trigger to deliver to site");
}

// -- inventory ---------------------------------------------------------------
function onInventoryResult(msg) {
  const counts = msg.counts || {};
  let rows = "";
  Object.keys(counts).sort().forEach((t) => {
    rows += `<tr><td>${escapeHtml(t)}</td><td>${counts[t]}</td></tr>`;
  });
  if (!rows) rows = `<tr><td colspan="2" class="hint">No registered tags found.</td></tr>`;
  let unknownHtml = "";
  if (msg.unknown && msg.unknown.length) {
    unknownHtml = `<p class="hint">${msg.unknown.length} unregistered tag(s):</p>
      <ul class="unknown-list">${msg.unknown.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul>`;
  }
  showResult("ok", `Counted ${msg.total} tag(s)`,
    `<table><tr><th>Type</th><th>Qty</th></tr>${rows}</table>${unknownHtml}`);
  logActivity(`Inventory sweep: ${msg.total} tag(s)`, "ok");
  showScanner("Hold the trigger to sweep again\u2026");
}

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
function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// -- wiring ------------------------------------------------------------------
function wireUI() {
  document.querySelectorAll(".mode-card").forEach((c) => {
    c.onclick = () => openMode(c.dataset.mode);
  });
  $("back-btn").onclick = backToModes;
  $("arm-btn").onclick = armCheckin;
  $("finish-btn").onclick = finishCheckin;
  $("power-slider").oninput = onPowerInput;
  $("sim-btn").onclick = () => {
    const raw = $("sim-epc").value.trim();
    if (!raw) return;
    const epcs = raw.split(",").map((s) => s.trim()).filter(Boolean);
    fetch("/api/simulate_scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ epcs }),
    });
  };
}

boot();
