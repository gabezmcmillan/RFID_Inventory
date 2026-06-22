// ---------------------------------------------------------------------------
// RFID Inventory frontend
// ---------------------------------------------------------------------------
const MODE_TITLES = {
  checkin: "Check In", checkout: "Check Out",
  inventory: "Sweep & Count", warehouse: "Warehouse", finder: "Find a Tag",
};
const VIEWS = ["checkin-view", "checkout-view", "inventory-view",
               "warehouse-view", "finder-view"];

const state = {
  config: { item_types: [], type_fields: {}, power_min: 10, power_max: 29 },
  mode: null,          // active UI mode
  selectedType: null,
  shipment: null,
  whGroupBy: "po",     // warehouse grouping dimension
  finder: null,        // {epc, rssiMin, rssiMax}
};

let powerSendTimer = null;
let itemSendTimer = null;

const $ = (id) => document.getElementById(id);

// -- boot --------------------------------------------------------------------
async function boot() {
  state.config = await (await fetch("/api/config")).json();
  initPowerBounds();
  await refreshStatus();
  connectWS();
  wireUI();
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
    case "reader_status":
      setReaderPill(msg.connected);
      if (msg.message) logActivity(msg.message, msg.connected ? "ok" : "err");
      break;
    case "live":
      $("live-count").textContent = msg.distinct;
      $("scanner-title").textContent = "Reading\u2026";
      break;
    case "checkin_result": onCheckinResult(msg); break;
    case "checkout_result": onCheckoutResult(msg); break;
    case "inventory_result": onInventoryResult(msg); break;
    case "finder": onFinder(msg); break;
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

// -- view helpers ------------------------------------------------------------
function showView(id) { VIEWS.forEach((v) => hide(v)); show(id); }

// -- mode navigation ---------------------------------------------------------
async function openMode(mode) {
  state.mode = mode;
  state.selectedType = null;
  $("mode-picker").classList.add("hidden");
  $("panel").classList.remove("hidden");
  $("panel-title").textContent = MODE_TITLES[mode];
  hide("result"); hide("scanner"); hide("item-form");
  showView(`${mode}-view`);

  // The power slider tunes check-in/check-out range; inventory runs at full power.
  if (mode === "checkin" || mode === "checkout") show("power-control");
  else hide("power-control");

  if (mode === "checkin") {
    state.shipment = null;
    renderTypeButtons();
    hide("checkin-form"); hide("arm-btn"); hide("finish-btn");
    await setServerMode("idle");
  } else if (mode === "checkout") {
    await setServerMode("checkout");
    showScanner("Ready \u2014 pull the trigger to deliver to site");
  } else if (mode === "inventory") {
    await setServerMode("inventory");
    showScanner("Hold the trigger to sweep\u2026");
  } else if (mode === "warehouse") {
    await setServerMode("idle");
    await loadWarehouse();
  }
}

async function backToModes() {
  await setServerMode("idle");
  state.mode = null;
  state.finder = null;
  $("panel").classList.add("hidden");
  $("mode-picker").classList.remove("hidden");
  hide("power-control");
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
  setShipmentFormDisabled(false);
  show("checkin-form"); show("arm-btn");
  hide("finish-btn"); hide("item-form"); hide("result"); hide("scanner");
}

function setShipmentFormDisabled(disabled) {
  $("checkin-form").querySelectorAll("input").forEach((i) => { i.disabled = disabled; });
  document.querySelectorAll(".type-btn").forEach((b) => { b.disabled = disabled; });
}

function buildField(f, idPrefix) {
  const field = document.createElement("div");
  field.className = "field";
  const label = document.createElement("label");
  label.textContent = f.label;
  const input = document.createElement("input");
  input.type = f.type === "date" ? "date" : "text";
  input.id = `${idPrefix}${f.key}`;
  field.appendChild(label);
  field.appendChild(input);
  return field;
}

function renderShipmentForm(type) {
  const form = $("checkin-form");
  form.innerHTML = "";
  fieldsForScope(type, "shipment").forEach((f) => form.appendChild(buildField(f, "f_")));
}

function renderItemForm(type) {
  const form = $("item-form");
  form.innerHTML = '<p class="hint">Fill in this unit\'s details, then pull the trigger to tag it.</p>';
  fieldsForScope(type, "item").forEach((f) => {
    const field = buildField(f, "it_");
    field.querySelector("input").oninput = onItemInput;
    form.appendChild(field);
  });
}

function collectItemFields() {
  const fields = {};
  fieldsForScope(state.selectedType, "item").forEach((f) => {
    const el = $(`it_${f.key}`);
    fields[f.key] = el ? (el.value || "").trim() : "";
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
    if (el) el.value = "";
  });
}

async function armCheckin() {
  if (!state.selectedType) return;
  const fields = {};
  fieldsForScope(state.selectedType, "shipment").forEach((f) => {
    fields[f.key] = ($(`f_${f.key}`).value || "").trim();
  });
  const ok = await setServerMode("checkin", { item_type: state.selectedType, fields });
  if (ok) {
    state.shipment = { type: state.selectedType, fields, qty: 0 };
    hide("result");
    setShipmentFormDisabled(true);
    hide("arm-btn"); show("finish-btn"); show("item-form");
    await postItemFields();
    showScanner(`Receiving ${state.selectedType} \u2014 fill unit details, then pull the trigger`);
  }
}

async function finishCheckin() {
  await setServerMode("idle");
  state.shipment = null;
  setShipmentFormDisabled(false);
  show("arm-btn"); hide("finish-btn"); hide("item-form"); hide("scanner");
}

function onCheckinResult(msg) {
  if (!msg.ok) {
    showResult("warn", "Unit not recorded", `<p>${escapeHtml(msg.message)}</p>`);
    logActivity(msg.message, "warn");
    showScanner(`Receiving ${msg.item_type || ""} \u2014 pull the trigger on the next unit`);
    return;
  }
  const po = msg.po_number || "n/a";
  const bldg = msg.building || "n/a";
  const dupNote = msg.duplicates && msg.duplicates.length
    ? `<p class="hint">${msg.duplicates.length} tag(s) were already on file (not re-counted).</p>` : "";
  const sku = msg.sku ? `<tr><th>SKU</th><td>${escapeHtml(msg.sku)}</td></tr>` : "";
  const mfc = msg.mfc_date ? `<tr><th>Mfc date</th><td>${escapeHtml(msg.mfc_date)}</td></tr>` : "";
  showResult("ok", `Shipment: ${escapeHtml(msg.item_type)} \u00b7 Qty ${msg.qty}`,
    `<table>
       <tr><th>PO Number</th><td>${escapeHtml(po)}</td></tr>
       <tr><th>Building</th><td>${escapeHtml(bldg)}</td></tr>
       <tr><th>Vendor</th><td>${escapeHtml(msg.vendor || "")}</td></tr>
       ${sku}${mfc}
       <tr><th>Just added</th><td>${msg.added}</td></tr>
       <tr><th>Total in this group</th><td>${msg.qty}</td></tr>
     </table>${dupNote}
     <p class="hint">Enter the next unit's details and pull the trigger, or "Finish / change shipment".</p>`);
  logActivity(`Received ${msg.added} ${msg.item_type} (PO ${po}) \u2014 qty now ${msg.qty}`, "ok");
  // Per-unit fields are unique; clear them for the next unit.
  clearItemInputs();
  postItemFields();
  showScanner(`Receiving ${msg.item_type} \u2014 enter the next unit, then pull the trigger`);
}

// -- check out ---------------------------------------------------------------
function onCheckoutResult(msg) {
  if (msg.ok) {
    const remaining = (msg.qty_remaining == null) ? "" :
      `<tr><th>Qty left (this group)</th><td>${msg.qty_remaining}</td></tr>`;
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
  showScanner("Ready \u2014 pull the trigger to deliver to site");
}

// -- inventory sweep ---------------------------------------------------------
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

// -- warehouse browse / drill-down -------------------------------------------
async function loadWarehouse() {
  const tree = $("warehouse-tree");
  tree.innerHTML = `<p class="hint">Loading\u2026</p>`;
  try {
    const data = await (await fetch(`/api/inventory?group_by=${state.whGroupBy}`)).json();
    renderWarehouse(data);
  } catch (e) {
    tree.innerHTML = `<p class="hint">Could not load inventory.</p>`;
  }
}

function renderWarehouse(data) {
  const tree = $("warehouse-tree");
  tree.innerHTML = "";
  const groupLabel = data.group_by === "building" ? "Building #" : "PO #";
  if (!data.types || !data.types.length) {
    tree.innerHTML = `<p class="hint">Nothing in the warehouse yet. Check in a shipment to get started.</p>`;
    return;
  }
  data.types.forEach((t) => {
    const typeEl = document.createElement("div");
    typeEl.className = "wh-type";

    const head = document.createElement("button");
    head.className = "wh-type-head";
    head.innerHTML = `<span class="wh-caret">&#9656;</span>
      <span class="wh-type-name">${escapeHtml(t.item_type)}</span>
      <span class="wh-qty">${t.qty} in warehouse</span>`;

    const body = document.createElement("div");
    body.className = "wh-type-body hidden";

    const table = document.createElement("table");
    table.className = "wh-group-table";
    table.innerHTML = `<thead><tr>
        <th>Qty</th><th>${escapeHtml(groupLabel)}</th>
        <th>Date Checked In</th><th>Status</th><th></th>
      </tr></thead>`;
    const tbody = document.createElement("tbody");
    t.groups.forEach((g) => addGroupRows(tbody, t.item_type, data.group_by, g));
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

function addGroupRows(tbody, itemType, groupBy, g) {
  const row = document.createElement("tr");
  row.className = "wh-group-row";
  const statusCls = g.status === "Delivered" ? "badge-out" : "badge-in";
  row.innerHTML = `
    <td>${g.qty}</td>
    <td><span class="wh-caret">&#9656;</span> ${escapeHtml(g.value || "(blank)")}</td>
    <td>${escapeHtml(g.received || "")}</td>
    <td><span class="badge ${statusCls}">${escapeHtml(g.status)}</span></td>
    <td class="wh-count">${g.total} tag(s)</td>`;

  const detail = document.createElement("tr");
  detail.className = "wh-detail-row hidden";
  const cell = document.createElement("td");
  cell.colSpan = 5;
  cell.innerHTML = `<p class="hint">Loading units\u2026</p>`;
  detail.appendChild(cell);

  let loaded = false;
  row.onclick = async () => {
    detail.classList.toggle("hidden");
    row.querySelector(".wh-caret").innerHTML =
      detail.classList.contains("hidden") ? "&#9656;" : "&#9662;";
    if (!loaded && !detail.classList.contains("hidden")) {
      loaded = true;
      await loadGroupTags(cell, itemType, groupBy, g.value);
    }
  };

  tbody.appendChild(row);
  tbody.appendChild(detail);
}

async function loadGroupTags(cell, itemType, groupBy, value) {
  try {
    const q = new URLSearchParams({ item_type: itemType, group_by: groupBy, value: value || "" });
    const data = await (await fetch(`/api/inventory/group?${q.toString()}`)).json();
    if (!data.tags || !data.tags.length) {
      cell.innerHTML = `<p class="hint">No units.</p>`;
      return;
    }
    const rows = data.tags.map((tag) => {
      const statusCls = tag.status === "Delivered" ? "badge-out" : "badge-in";
      const findBtn = `<button class="find-btn" data-epc="${escapeHtml(tag.epc)}"
        data-label="${escapeHtml(itemType + " \u00b7 " + (tag.sku || tag.epc))}">Find</button>`;
      return `<tr>
        <td class="epc">${escapeHtml(tag.epc)}</td>
        <td>${escapeHtml(tag.sku || "")}</td>
        <td>${escapeHtml(tag.mfc_date || "")}</td>
        <td><span class="badge ${statusCls}">${escapeHtml(tag.status)}</span></td>
        <td>${findBtn}</td>
      </tr>`;
    }).join("");
    cell.innerHTML = `<table class="wh-tag-table">
      <thead><tr><th>EPC</th><th>SKU</th><th>Mfc date</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table>`;
    cell.querySelectorAll(".find-btn").forEach((b) => {
      b.onclick = (ev) => { ev.stopPropagation(); openFinder(b.dataset.epc, b.dataset.label); };
    });
  } catch (e) {
    cell.innerHTML = `<p class="hint">Could not load units.</p>`;
  }
}

// -- finder ------------------------------------------------------------------
async function openFinder(epc, label) {
  state.mode = "finder";
  state.finder = { epc, rssiMin: null, rssiMax: null };
  $("panel-title").textContent = MODE_TITLES.finder;
  hide("power-control"); hide("scanner"); hide("result");
  showView("finder-view");
  $("finder-target").innerHTML =
    `<div class="finder-label">${escapeHtml(label || epc)}</div>
     <div class="epc">${escapeHtml(epc)}</div>`;
  resetFinderPulse();
  await setServerMode("finder", { target_epc: epc });
  logActivity(`Finding ${epc}\u2026`, "ok");
}

function resetFinderPulse() {
  const p = $("finder-pulse");
  p.style.animationDuration = "1.6s";
  p.style.setProperty("--prox", 0);
  $("finder-strength").textContent = "No signal yet";
  $("finder-rssi").textContent = "Hold the trigger and move the reader around.";
}

function onFinder(msg) {
  if (!state.finder || msg.epc !== state.finder.epc) return;
  const f = state.finder;
  const rssi = msg.rssi;
  if (rssi == null) return;
  // Adaptive scale: we don't assume the reader's RSSI units, just track the
  // observed range and map the current reading into it.
  if (f.rssiMin == null) { f.rssiMin = rssi - 1; f.rssiMax = rssi + 1; }
  if (rssi < f.rssiMin) f.rssiMin = rssi;
  if (rssi > f.rssiMax) f.rssiMax = rssi;
  const span = f.rssiMax - f.rssiMin;
  const prox = span > 0 ? (rssi - f.rssiMin) / span : 0.5;

  const p = $("finder-pulse");
  p.style.animationDuration = `${(1.6 - prox * 1.4).toFixed(2)}s`;
  p.style.setProperty("--prox", prox.toFixed(2));

  let word = "Far";
  if (prox > 0.85) word = "Right here!";
  else if (prox > 0.6) word = "Very close";
  else if (prox > 0.35) word = "Getting warmer";
  else if (prox > 0.15) word = "Cold";
  $("finder-strength").textContent = word;
  $("finder-rssi").textContent = `Signal: ${rssi}`;
}

async function stopFinder() {
  state.finder = null;
  await setServerMode("idle");
  state.mode = "warehouse";
  $("panel-title").textContent = MODE_TITLES.warehouse;
  showView("warehouse-view");
  await loadWarehouse();
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
  $("wh-refresh").onclick = loadWarehouse;
  $("finder-stop").onclick = stopFinder;
  document.querySelectorAll(".seg-btn").forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll(".seg-btn").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      state.whGroupBy = b.dataset.group;
      loadWarehouse();
    };
  });
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
