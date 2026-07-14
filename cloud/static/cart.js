/* Cart-style requesting on the browse page.
 *
 * The stock table is server-rendered (the page works read-only without JS);
 * this file adds the interactive layer: search/filter/sort, BOL drill-down,
 * quantity steppers capped at availability, a cart persisted in
 * localStorage, and the checkout dialog that submits the whole cart to
 * POST /api/requests/cart and renders its per-line validation errors.
 */
"use strict";

const $ = (id) => document.getElementById(id);
const CART_KEY = "warehouse-cart-v1";

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// -- stock rows (from the server-rendered table) -----------------------------
// key = "itemType|building"; building "" = unassigned stock.
const stock = new Map();
document.querySelectorAll("tbody.stock-group").forEach((tb) => {
  stock.set(tb.dataset.key, {
    key: tb.dataset.key,
    itemType: tb.dataset.itemType,
    building: tb.dataset.building,
    units: parseInt(tb.dataset.units, 10) || 0,
    boxes: parseInt(tb.dataset.boxes, 10) || 0,
    vendors: tb.dataset.vendors || "",
    oldest: tb.dataset.oldest || "",
    el: tb,
  });
});

// -- cart state ---------------------------------------------------------------
// { key: qty } -- item identity lives in the stock map. Restored carts are
// reconciled against current stock: vanished rows drop, quantities clamp.
let cart = {};

function loadCart() {
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem(CART_KEY) || "{}");
  } catch (e) {
    saved = {};
  }
  cart = {};
  for (const [key, qty] of Object.entries(saved)) {
    const row = stock.get(key);
    if (!row || row.units <= 0) continue;
    const n = Math.min(Math.max(parseInt(qty, 10) || 0, 0), row.units);
    if (n > 0) cart[key] = n;
  }
}

function saveCart() {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
  } catch (e) { /* private mode etc. -- cart just won't survive reloads */ }
}

function cartTotals() {
  const keys = Object.keys(cart);
  return {
    items: keys.length,
    units: keys.reduce((sum, k) => sum + cart[k], 0),
  };
}

function setCartLine(key, qty) {
  const row = stock.get(key);
  if (!row) return;
  const n = Math.min(Math.max(qty, 0), row.units);
  if (n > 0) cart[key] = n; else delete cart[key];
  saveCart();
  refreshCartUi();
}

// -- table interactions --------------------------------------------------------
function wireRows() {
  stock.forEach((row) => {
    const tr = row.el.querySelector(".stock-row");
    const detail = row.el.querySelector(".stock-detail");
    const caret = tr.querySelector(".caret");
    tr.addEventListener("click", (ev) => {
      if (ev.target.closest(".qty-add")) return;
      detail.hidden = !detail.hidden;
      caret.classList.toggle("open", !detail.hidden);
    });

    const input = row.el.querySelector(".qty-input");
    const clamp = () => {
      const n = parseInt(input.value, 10);
      input.value = Math.min(Math.max(isNaN(n) ? 1 : n, 1), row.units);
    };
    input.addEventListener("change", clamp);
    input.addEventListener("click", (ev) => ev.stopPropagation());
    row.el.querySelector(".step-down").addEventListener("click", () => {
      input.value = Math.max((parseInt(input.value, 10) || 1) - 1, 1);
    });
    row.el.querySelector(".step-up").addEventListener("click", () => {
      input.value = Math.min((parseInt(input.value, 10) || 1) + 1, row.units);
    });
    row.el.querySelector(".add-btn").addEventListener("click", () => {
      clamp();
      setCartLine(row.key, parseInt(input.value, 10));
    });
  });
}

function refreshRowStates() {
  stock.forEach((row) => {
    const inCart = cart[row.key] > 0;
    row.el.classList.toggle("in-cart", inCart);
    const btn = row.el.querySelector(".add-btn");
    btn.textContent = inCart ? "Update" : "Add";
    if (inCart) row.el.querySelector(".qty-input").value = cart[row.key];
  });
}

// -- search / filter / sort ----------------------------------------------------
function applyFilters() {
  const q = ($("stock-search")?.value || "").trim().toLowerCase();
  const b = $("stock-building-filter")?.value || "";
  let shown = 0;
  stock.forEach((row) => {
    const matchesText = !q
      || row.itemType.toLowerCase().includes(q)
      || row.vendors.toLowerCase().includes(q);
    const matchesBldg = !b || (b === "~" ? row.building === ""
                                         : row.building === b);
    const show = matchesText && matchesBldg;
    row.el.hidden = !show;
    if (show) shown += 1;
  });
  const none = $("stock-no-match");
  if (none) none.hidden = shown > 0;
}

const sortState = { by: null, dir: 1 };

function sortRows(by) {
  const table = $("stock-table");
  if (!table) return;
  sortState.dir = sortState.by === by ? -sortState.dir : 1;
  sortState.by = by;
  const val = (row) => ({
    item_type: row.itemType.toLowerCase(),
    building: row.building,
    units: row.units,
    boxes: row.boxes,
    vendors: row.vendors.toLowerCase(),
    oldest_received: row.oldest,
  }[by]);
  const groups = [...stock.values()].sort((a, b) => {
    const x = val(a), y = val(b);
    return (x < y ? -1 : x > y ? 1 : 0) * sortState.dir;
  });
  groups.forEach((g) => table.appendChild(g.el));
  table.querySelectorAll("th.sortable").forEach((th) => {
    th.classList.toggle("sorted-asc",
                        th.dataset.sort === by && sortState.dir === 1);
    th.classList.toggle("sorted-desc",
                        th.dataset.sort === by && sortState.dir === -1);
  });
}

// -- cart bar -------------------------------------------------------------------
function refreshCartUi() {
  refreshRowStates();
  const bar = $("cart-bar");
  if (!bar) return;
  const { items, units } = cartTotals();
  bar.hidden = items === 0;
  if (items > 0) {
    $("cart-summary").textContent =
      `${items} item${items === 1 ? "" : "s"} \u00b7 ` +
      `${units} unit${units === 1 ? "" : "s"} in your cart`;
  }
  const modal = $("checkout-modal");
  if (modal && !modal.hidden) {
    if (items === 0) closeCheckout(); else renderCartLines();
  }
}

// -- checkout dialog -------------------------------------------------------------
// lineKeys[i] is the stock key of lines[i] in the submitted payload, so the
// server's per-line errors ({line: i}) map back to rendered rows.
let lineKeys = [];

function defaultDeliveryBuilding() {
  const counts = {};
  Object.keys(cart).forEach((key) => {
    const b = stock.get(key)?.building;
    if (b) counts[b] = (counts[b] || 0) + 1;
  });
  return Object.keys(counts)
    .sort((a, b) => counts[b] - counts[a])[0] || "";
}

function renderCartLines() {
  const wrap = $("cart-lines");
  lineKeys = Object.keys(cart);
  wrap.innerHTML = lineKeys.map((key, i) => {
    const row = stock.get(key);
    const bldg = row.building
      ? `<span class="bldg-badge">Bldg ${escapeHtml(row.building)}</span>`
      : `<span class="bldg-badge bldg-none">Unassigned</span>`;
    return `<div class="cart-line" data-key="${escapeHtml(key)}" data-line="${i}">
      <div class="cart-line-main">
        <div class="cart-line-title">
          <strong>${escapeHtml(row.itemType)}</strong> ${bldg}
          <span class="hint">${row.units} available</span>
        </div>
        <div class="cart-line-issue" hidden></div>
      </div>
      <div class="stepper">
        <button type="button" class="step-btn line-down" aria-label="Less">&minus;</button>
        <input type="number" class="qty-input line-qty" value="${cart[key]}"
               min="1" max="${row.units}" inputmode="numeric" />
        <button type="button" class="step-btn line-up" aria-label="More">+</button>
      </div>
      <button type="button" class="line-remove" aria-label="Remove">&times;</button>
    </div>`;
  }).join("");

  wrap.querySelectorAll(".cart-line").forEach((el) => {
    const key = el.dataset.key;
    const row = stock.get(key);
    const input = el.querySelector(".line-qty");
    input.addEventListener("change", () => {
      const n = parseInt(input.value, 10);
      setCartLine(key, isNaN(n) ? 1 : n);
    });
    el.querySelector(".line-down").addEventListener("click",
      () => setCartLine(key, cart[key] - 1));
    el.querySelector(".line-up").addEventListener("click",
      () => setCartLine(key, Math.min(cart[key] + 1, row.units)));
    el.querySelector(".line-remove").addEventListener("click",
      () => setCartLine(key, 0));
  });
  refreshWarnings();
}

function refreshWarnings() {
  const delivery =
    ($("checkout-form").elements.delivery_building.value || "").trim();
  document.querySelectorAll("#cart-lines .cart-line").forEach((el) => {
    const row = stock.get(el.dataset.key);
    const issue = el.querySelector(".cart-line-issue");
    if (issue.dataset.error) return;   // server errors outrank warnings
    if (row.building && delivery && delivery !== row.building) {
      issue.hidden = false;
      issue.className = "cart-line-issue warn";
      issue.textContent = `This stock is assigned to Building ${row.building}; `
        + `you're asking for delivery to Building ${delivery}. The warehouse `
        + `manager will review.`;
    } else {
      issue.hidden = true;
      issue.textContent = "";
    }
  });
}

function showLineErrors(errors) {
  document.querySelectorAll("#cart-lines .cart-line").forEach((el) => {
    const issue = el.querySelector(".cart-line-issue");
    delete issue.dataset.error;
    issue.hidden = true;
    issue.textContent = "";
  });
  (errors || []).forEach((err) => {
    const el = document.querySelector(
      `#cart-lines .cart-line[data-line="${err.line}"]`);
    if (!el) return;
    const issue = el.querySelector(".cart-line-issue");
    issue.dataset.error = "1";
    issue.className = "cart-line-issue err";
    issue.hidden = false;
    issue.textContent = err.message;
  });
  refreshWarnings();
}

async function refreshAvailability() {
  // The tab may have sat open for hours; re-check caps before checkout.
  let data;
  try {
    data = await (await fetch("/api/stock")).json();
  } catch (e) {
    return;   // offline/stale is fine -- the server re-validates on submit
  }
  const fresh = new Map(
    (data.stock || []).map((r) => [`${r.item_type}|${r.building}`, r]));
  stock.forEach((row, key) => {
    const now = fresh.get(key);
    row.units = now ? (now.units || 0) : 0;
    const cell = row.el.querySelector(".stock-row td.num");
    if (cell) cell.textContent = row.units;
    row.el.querySelector(".qty-input").max = Math.max(row.units, 1);
    if (cart[key] > row.units) setCartLine(key, row.units);
  });
}

async function openCheckout() {
  await refreshAvailability();
  if (!Object.keys(cart).length) return;
  const modal = $("checkout-modal");
  const form = $("checkout-form");
  if (!form.elements.delivery_building.value) {
    form.elements.delivery_building.value = defaultDeliveryBuilding();
  }
  $("checkout-error").hidden = true;
  modal.hidden = false;
  renderCartLines();
  form.elements.requester.focus();
}

function closeCheckout() {
  $("checkout-modal").hidden = true;
}

async function submitCart(ev) {
  ev.preventDefault();
  const form = $("checkout-form");
  const errBanner = $("checkout-error");
  const btn = $("checkout-submit");
  lineKeys = Object.keys(cart);
  const payload = {
    requester: form.elements.requester.value.trim(),
    contact: form.elements.contact.value.trim(),
    jobsite: form.elements.jobsite.value.trim(),
    note: form.elements.note.value.trim(),
    delivery_building: form.elements.delivery_building.value.trim(),
    lines: lineKeys.map((key) => ({
      item_type: stock.get(key).itemType,
      building: stock.get(key).building,
      quantity: cart[key],
    })),
  };
  btn.disabled = true;
  btn.textContent = "Submitting\u2026";
  let data;
  try {
    const res = await fetch("/api/requests/cart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    data = await res.json();
  } catch (e) {
    data = { ok: false, message: "Could not reach the site. Check your "
                                 + "connection and try again." };
  }
  btn.disabled = false;
  btn.textContent = "Submit request";
  if (data.ok) {
    cart = {};
    saveCart();
    window.location.href =
      `/requests?ok=${encodeURIComponent(data.order_ref || "")}`;
    return;
  }
  errBanner.textContent = data.message || "The request could not be submitted.";
  errBanner.hidden = false;
  showLineErrors(data.errors);
}

// -- wiring -----------------------------------------------------------------------
function init() {
  if (!stock.size) return;
  loadCart();
  wireRows();
  refreshCartUi();

  $("stock-search")?.addEventListener("input", applyFilters);
  $("stock-building-filter")?.addEventListener("change", applyFilters);
  document.querySelectorAll("#stock-table th.sortable").forEach((th) => {
    th.addEventListener("click", () => sortRows(th.dataset.sort));
  });

  $("cart-review").addEventListener("click", openCheckout);
  $("cart-clear").addEventListener("click", () => {
    cart = {};
    saveCart();
    refreshCartUi();
  });
  $("checkout-close").addEventListener("click", closeCheckout);
  $("checkout-modal").addEventListener("click", (ev) => {
    if (ev.target === $("checkout-modal")) closeCheckout();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !$("checkout-modal").hidden) closeCheckout();
  });
  $("checkout-form").addEventListener("submit", submitCart);
  $("checkout-form").elements.delivery_building
    .addEventListener("input", refreshWarnings);
}

init();
