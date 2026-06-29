// ---------------------------------------------------------------------------
// RFID Inventory frontend
// ---------------------------------------------------------------------------
const MODE_TITLES = {
  checkin: "Check In", checkout: "Check Out",
  inventory: "Sweep & Count", warehouse: "Warehouse", finder: "Find a Tag",
  eventlog: "Event Log", admin: "Admin",
};
const VIEWS = ["checkin-view", "checkout-view", "inventory-view",
               "warehouse-view", "finder-view", "eventlog-view", "admin-view"];

// Tag fields an admin may edit (key, label, input type).
const EDIT_FIELDS = [
  { key: "item_type", label: "Type", type: "text" },
  { key: "po_number", label: "PO #", type: "text" },
  { key: "building", label: "Building #", type: "building" },
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
  whGroupBy: "po",     // warehouse grouping dimension
  eventFilter: "all",  // event-log filter category
  finder: null,        // {epc, rssiMin, rssiMax, proxEma, samples, found}
  admin: { pin: null, editMode: false },
  vendors: [],         // dropdown options, managed in Admin
};

let powerSendTimer = null;
let itemSendTimer = null;
let finderAudioCtx = null;
let finderOsc = null;          // persistent oscillator for the sweeping tone
let finderGain = null;         // its gain (0 = silent)
let finderStaleTimer = null;   // mutes the tone when reads stop
let finderLastSignal = 0;      // performance.now() of the last finder event

const $ = (id) => document.getElementById(id);

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
    case "checkout_prompt": onCheckoutPrompt(msg); break;
    case "checkout_result": onCheckoutResult(msg); break;
    case "inventory_result": onInventoryResult(msg); break;
    case "finder": onFinder(msg); break;
    case "finder_reset": onFinderReset(); break;
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
async function openMode(mode, opts = {}) {
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
    await loadVendors();
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
    $("wh-edit-banner").classList.toggle("hidden", !isEditing());
    await loadWarehouse();
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
  $("checkin-form").querySelectorAll("input, select, .btn-group button")
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
    const opts = f.key === "vendor" ? state.vendors : (f.options || []);
    select.innerHTML = `<option value=""></option>` +
      (opts || []).map((o) =>
        `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join("");
    field.appendChild(select);
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
    field.appendChild(input);
  }
  return field;
}

function getFieldValue(key, prefix) {
  const el = $(`${prefix}${key}`);
  if (!el) return "";
  if (el.classList && el.classList.contains("btn-group")) return el.dataset.value || "";
  return (el.value || "").trim();
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
    const inp = field.querySelector("input, select");
    if (inp) inp.oninput = onItemInput;
    form.appendChild(field);
  });
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
  const boxUnits = msg.quantity != null ? msg.quantity : msg.added_units;
  showResult("ok", `Shipment: ${escapeHtml(msg.item_type)} \u00b7 Qty ${msg.qty} units`,
    `<table>
       <tr><th>PO Number</th><td>${escapeHtml(po)}</td></tr>
       <tr><th>Building</th><td>${escapeHtml(bldg)}</td></tr>
       <tr><th>Vendor</th><td>${escapeHtml(msg.vendor || "")}</td></tr>
       ${sku}${mfc}
       <tr><th>This box</th><td>${boxUnits} unit(s)</td></tr>
       <tr><th>Total in this group</th><td>${msg.qty} unit(s)</td></tr>
     </table>${dupNote}
     <p class="hint">Enter the next box's details and pull the trigger, or "Finish / change shipment".</p>`);
  logActivity(`Received a box of ${boxUnits} ${msg.item_type} (PO ${po}) \u2014 qty now ${msg.qty} units`, "ok");
  // Per-unit fields are unique; clear them for the next unit.
  clearItemInputs();
  postItemFields();
  showScanner(`Receiving ${msg.item_type} \u2014 enter the next unit, then pull the trigger`);
}

// -- check out ---------------------------------------------------------------
// A trigger pull only looks the box up; the operator confirms how many units to
// draw down here (full box by default), then we commit via POST /api/checkout.
function onCheckoutPrompt(msg) {
  if (!msg.ok) {
    showResult("warn", "Cannot deliver",
      `<p class="epc">${escapeHtml(msg.epc || "")}</p>
       <p>${escapeHtml(msg.message)}</p>`);
    logActivity(msg.message, "warn");
    showScanner("Ready \u2014 pull the trigger to deliver to site");
    return;
  }
  const remaining = msg.remaining;
  const quantity = msg.quantity;
  showResult("ok", "How many units leave?",
    `<p><b>${escapeHtml(msg.item_type || "")}</b> &middot;
       <span class="epc">${escapeHtml(msg.epc)}</span></p>
     <table>
       <tr><th>PO Number</th><td>${escapeHtml(msg.po_number || "n/a")}</td></tr>
       <tr><th>Building</th><td>${escapeHtml(msg.building || "n/a")}</td></tr>
       <tr><th>SKU</th><td>${escapeHtml(msg.sku || "")}</td></tr>
       <tr><th>Units in this box</th><td>${remaining} of ${quantity}</td></tr>
     </table>
     <div class="checkout-confirm">
       <label for="checkout-amount">Units to deliver</label>
       <input id="checkout-amount" type="number" min="1" max="${remaining}"
              step="1" value="${remaining}" />
       <button id="checkout-confirm-btn" class="primary-btn">Confirm delivery</button>
     </div>
     <p class="hint">Defaults to the whole box. Lower it to deliver part of the box.</p>`);
  const input = $("checkout-amount");
  const commit = () => confirmCheckout(msg.epc, remaining);
  $("checkout-confirm-btn").onclick = commit;
  if (input) {
    input.focus();
    input.select();
    input.onkeydown = (e) => { if (e.key === "Enter") commit(); };
  }
}

async function confirmCheckout(epc, remaining) {
  const input = $("checkout-amount");
  let amount = input ? parseInt(input.value, 10) : remaining;
  if (!Number.isFinite(amount) || amount < 1) amount = 1;
  if (amount > remaining) amount = remaining;
  try {
    const res = await fetch("/api/checkout", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ epc, amount }),
    });
    onCheckoutResult(await res.json());
  } catch (e) {
    logActivity("Cannot reach server", "err");
  }
}

function onCheckoutResult(msg) {
  if (msg.ok) {
    const groupLeft = (msg.qty_remaining == null) ? "" :
      `<tr><th>Units left (this group)</th><td>${msg.qty_remaining}</td></tr>`;
    const boxLeft = (msg.box_remaining == null) ? "" :
      `<tr><th>Units left in this box</th><td>${msg.box_remaining}</td></tr>`;
    const delivered = (msg.delivered == null) ? "" :
      `<tr><th>Units delivered</th><td>${msg.delivered}</td></tr>`;
    showResult("ok", "Delivered to site",
      `<p><b>${escapeHtml(msg.item_type || "")}</b> &middot;
         <span class="epc">${escapeHtml(msg.epc)}</span></p>
       <table>
         <tr><th>PO Number</th><td>${escapeHtml(msg.po_number || "n/a")}</td></tr>
         <tr><th>Building</th><td>${escapeHtml(msg.building || "n/a")}</td></tr>
         ${delivered}${boxLeft}
         <tr><th>Delivered</th><td>${escapeHtml(msg.delivered_at || "")}</td></tr>
         ${groupLeft}
       </table>`);
    logActivity(`Delivered ${msg.delivered != null ? msg.delivered + " unit(s) of " : ""}` +
      `${msg.item_type} (${msg.epc}) to site`, "ok");
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
  const flagged = msg.flagged || [];
  let flaggedHtml = "";
  if (flagged.length) {
    const items = flagged.map((f) =>
      `<li><span class="epc epc-link" data-epc="${escapeHtml(f.epc)}"
        title="View this tag's event history">${escapeHtml(f.epc)}</span> &mdash;
        ${escapeHtml(f.item_type)} (PO ${escapeHtml(f.po_number || "n/a")},
        Bldg ${escapeHtml(f.building || "n/a")}), checked out ${escapeHtml(f.delivered_at || "")}</li>`
    ).join("");
    flaggedHtml = `<div class="flag-warning">
      <strong>&#9888; ${flagged.length} checked-out item(s) detected &mdash; should NOT be in the warehouse:</strong>
      <ul>${items}</ul></div>`;
  }
  const detailsHtml = sweepDetailsHtml(msg.items || []);
  showResult(flagged.length ? "warn" : "ok", `Counted ${msg.total} unit(s)`,
    `${flaggedHtml}<table><tr><th>Type</th><th>Units</th></tr>${rows}</table>` +
    `${unknownHtml}${detailsHtml}`);
  logActivity(`Inventory sweep: ${msg.total} unit(s)` +
    (flagged.length ? `, ${flagged.length} flagged` : ""),
    flagged.length ? "warn" : "ok");
  // EPCs in the flagged list and detailed scan jump to that tag's event history.
  $("result").querySelectorAll(".epc-link").forEach((el) => {
    el.onclick = (ev) => { ev.stopPropagation(); openMode("eventlog", { epc: el.dataset.epc }); };
  });
  showScanner("Hold the trigger to sweep again\u2026");
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
        <thead><tr><th>EPC</th><th>Type</th><th>Qty</th><th>PO</th><th>Building</th>
          <th>Vendor</th><th>SKU</th><th>Mfc date</th><th>Checked in</th>
          <th>Checked out</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </details>`;
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
      <span class="wh-qty">${t.qty} unit(s) in warehouse</span>`;

    const body = document.createElement("div");
    body.className = "wh-type-body hidden";

    const table = document.createElement("table");
    table.className = "wh-group-table";
    table.innerHTML = `<thead><tr>
        <th>Units</th><th>${escapeHtml(groupLabel)}</th>
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

const STATUS_BADGE = {
  "Delivered": "badge-out",
  "In Warehouse": "badge-in",
  "Partial": "badge-partial",
};

function addGroupRows(tbody, itemType, groupBy, g) {
  const row = document.createElement("tr");
  row.className = "wh-group-row";
  const statusCls = STATUS_BADGE[g.status] || "badge-in";
  const capacity = g.capacity != null ? g.capacity : g.total;
  const statusText = g.status === "Partial"
    ? `Partial (${g.in_wh}/${capacity})`
    : g.status;
  const boxes = g.boxes != null ? g.boxes : g.total;
  row.innerHTML = `
    <td>${g.qty}</td>
    <td><span class="wh-caret">&#9656;</span> ${escapeHtml(g.value || "(blank)")}</td>
    <td>${escapeHtml(fmtDateTime(g.received_at) || g.received || "")}</td>
    <td><span class="badge ${statusCls}">${escapeHtml(statusText)}</span></td>
    <td class="wh-count">${boxes} box(es)</td>`;

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
    const editing = isEditing();
    const rows = data.tags.map((tag) => tagRowHtml(tag, itemType, editing)).join("");
    cell.innerHTML = `<table class="wh-tag-table">
      <thead><tr><th>EPC</th><th>SKU</th><th>Qty</th><th>Mfc date</th>
        <th>Checked in</th><th>Checked out</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table>`;
    cell.querySelectorAll(".find-btn").forEach((b) => {
      b.onclick = (ev) => { ev.stopPropagation(); openFinder(b.dataset.epc, b.dataset.label); };
    });
    cell.querySelectorAll(".epc-link").forEach((el) => {
      el.onclick = (ev) => { ev.stopPropagation(); openMode("eventlog", { epc: el.dataset.epc }); };
    });
    if (editing) wireTagEditors(cell);
  } catch (e) {
    cell.innerHTML = `<p class="hint">Could not load units.</p>`;
  }
}

function tagRowHtml(tag, itemType, editing) {
  const statusCls = STATUS_BADGE[tag.status] || "badge-in";
  const flagBadge = tag.flag
    ? `<span class="badge badge-flag" title="${escapeHtml(tag.flag)}">&#9888; Flagged</span>`
    : "";
  const findBtn = `<button class="find-btn" data-epc="${escapeHtml(tag.epc)}"
    data-label="${escapeHtml(itemType + " \u00b7 " + (tag.sku || tag.epc))}">Find</button>`;
  const editBtn = editing
    ? ` <button class="edit-btn" data-epc="${escapeHtml(tag.epc)}">Edit</button>` : "";
  let editorRow = "";
  if (editing) {
    editorRow = `<tr class="tag-editor-row hidden" data-editor="${escapeHtml(tag.epc)}">
      <td colspan="8">${tagEditorHtml(tag)}</td></tr>`;
  }
  const deliveredAt = tag.delivered_at ? fmtDateTime(tag.delivered_at) : "";
  const qty = `${tag.remaining != null ? tag.remaining : ""}` +
    (tag.quantity != null ? ` / ${tag.quantity}` : "");
  return `<tr>
      <td class="epc epc-link" data-epc="${escapeHtml(tag.epc)}"
          title="View this tag's event history">${escapeHtml(tag.epc)}</td>
      <td>${escapeHtml(tag.sku || "")}</td>
      <td class="qty-cell">${escapeHtml(qty)}</td>
      <td>${escapeHtml(tag.mfc_date || "")}</td>
      <td>${escapeHtml(fmtDateTime(tag.received_at))}</td>
      <td>${escapeHtml(deliveredAt)}</td>
      <td><span class="badge ${statusCls}">${escapeHtml(tag.status)}</span> ${flagBadge}</td>
      <td>${findBtn}${editBtn}</td>
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

// -- event log ---------------------------------------------------------------
// Raw audit actions -> friendly label + badge class for the log table.
const EVENT_LABELS = {
  IN: { label: "Check-In", cls: "badge-in" },
  OUT: { label: "Check-Out", cls: "badge-out" },
  COUNT: { label: "Scan", cls: "badge-in" },
  FLAG: { label: "Flagged", cls: "badge-flag" },
  UNFLAG: { label: "Flag cleared", cls: "badge-in" },
  EDIT: { label: "Edited", cls: "badge-partial" },
  CLEAR: { label: "DB cleared", cls: "badge-out" },
  VENDOR_ADD: { label: "Vendor added", cls: "badge-in" },
  VENDOR_DEL: { label: "Vendor removed", cls: "badge-out" },
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
      <td>${escapeHtml(e.po_number)}</td>
      <td>${escapeHtml(e.building)}</td>
      <td>${escapeHtml(e.detail)}</td>
    </tr>`;
  }).join("");
  list.innerHTML = `<table class="event-table">
    <thead><tr><th>Time</th><th>Action</th><th>EPC</th><th>Type</th>
      <th>PO</th><th>Building</th><th>Detail</th></tr></thead>
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
