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
// v2: keys became "itemType|itemName|building" when W.I.F. components got
// their own stock rows (old carts don't translate; they just start empty).
const CART_KEY = "warehouse-cart-v2";

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// -- stock rows (from the server-rendered table) -----------------------------
// Two collections:
//   topRows -- one entry per <tbody> (plain types AND the single roll-up row
//     a named type like W.I.F. gets); drives search/filter/sort and the
//     expand/collapse.
//   stock -- the requestable lines, keyed "itemType|itemName|building". For
//     plain types that's the tbody itself; for named types it's each
//     .component-row inside the drill-down. building "" = unassigned stock.
const stock = new Map();
const topRows = [];
document.querySelectorAll("tbody.stock-group").forEach((tb) => {
  const top = {
    el: tb,
    named: tb.classList.contains("stock-group-named"),
    itemType: tb.dataset.itemType,
    itemNames: tb.dataset.itemNames || tb.dataset.itemName || "",
    buildings: (tb.dataset.buildings || "").split("|"),
    units: parseInt(tb.dataset.units, 10) || 0,
    boxes: parseInt(tb.dataset.boxes, 10) || 0,
    vendors: tb.dataset.vendors || "",
    oldest: tb.dataset.oldest || "",
  };
  topRows.push(top);
  if (tb.dataset.key) {
    stock.set(tb.dataset.key, {
      key: tb.dataset.key,
      itemType: tb.dataset.itemType,
      itemName: tb.dataset.itemName || "",
      building: tb.dataset.building || "",
      units: top.units,
      el: tb,
      top,
    });
  }
  tb.querySelectorAll("tr.component-row").forEach((tr) => {
    stock.set(tr.dataset.key, {
      key: tr.dataset.key,
      itemType: tr.dataset.itemType,
      itemName: tr.dataset.itemName || "",
      building: tr.dataset.building || "",
      units: parseInt(tr.dataset.units, 10) || 0,
      el: tr,
      top,
    });
  });
});

// -- cart state ---------------------------------------------------------------
// { key: {qty, deliverTo} } -- item identity lives in the stock map. Restored
// carts are reconciled against current stock: vanished rows drop, quantities
// clamp. Older saved carts stored a bare qty; those get a default deliverTo.
let cart = {};

function loadCart() {
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem(CART_KEY) || "{}");
  } catch (e) {
    saved = {};
  }
  cart = {};
  for (const [key, val] of Object.entries(saved)) {
    const row = stock.get(key);
    if (!row || row.units <= 0) continue;
    const isObj = val && typeof val === "object";
    const n = Math.min(
      Math.max(parseInt(isObj ? val.qty : val, 10) || 0, 0), row.units);
    if (n > 0) {
      cart[key] = { qty: n,
                    deliverTo: (isObj && val.deliverTo) || row.building };
    }
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
    units: keys.reduce((sum, k) => sum + cart[k].qty, 0),
  };
}

function cartQty(key) {
  return cart[key] ? cart[key].qty : 0;
}

function setCartLine(key, qty) {
  const row = stock.get(key);
  if (!row) return;
  const n = Math.min(Math.max(qty, 0), row.units);
  if (n > 0) {
    cart[key] = { qty: n,
                  deliverTo: cart[key] ? cart[key].deliverTo : row.building };
  } else {
    delete cart[key];
  }
  saveCart();
  refreshCartUi();
}

function setCartDelivery(key, building) {
  if (!cart[key]) return;
  cart[key].deliverTo = (building || "").trim();
  saveCart();
  refreshWarnings();   // no re-render: the operator may still be typing
}

// -- table interactions --------------------------------------------------------
function wireRows() {
  topRows.forEach((top) => {
    const tr = top.el.querySelector(".stock-row");
    const detail = top.el.querySelector(".stock-detail");
    const caret = tr.querySelector(".caret");
    tr.addEventListener("click", (ev) => {
      if (ev.target.closest(".qty-add")) return;
      detail.hidden = !detail.hidden;
      caret.classList.toggle("open", !detail.hidden);
    });
  });

  // Steppers + Add live on the requestable line (the plain tbody's stock-row
  // or a named type's component-row); each el contains exactly one set.
  stock.forEach((row) => {
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
    const inCart = cartQty(row.key) > 0;
    row.el.classList.toggle("in-cart", inCart);
    const btn = row.el.querySelector(".add-btn");
    btn.textContent = inCart ? "Update" : "Add";
    if (inCart) row.el.querySelector(".qty-input").value = cart[row.key].qty;
  });
  // A named type's roll-up row highlights when any of its components are in
  // the cart, so the state shows even while the drill-down is collapsed.
  topRows.filter((t) => t.named).forEach((top) => {
    const any = [...stock.values()].some(
      (row) => row.top === top && cartQty(row.key) > 0);
    top.el.classList.toggle("in-cart", any);
  });
}

// -- search / filter / sort ----------------------------------------------------
function applyFilters() {
  const q = ($("stock-search")?.value || "").trim().toLowerCase();
  const b = $("stock-building-filter")?.value || "";
  let shown = 0;
  topRows.forEach((top) => {
    const matchesText = !q
      || top.itemType.toLowerCase().includes(q)
      || top.itemNames.toLowerCase().includes(q)
      || top.vendors.toLowerCase().includes(q);
    // A named roll-up matches a building filter when ANY of its components
    // sit in that building ("~" = unassigned).
    const matchesBldg = !b || top.buildings.includes(b === "~" ? "" : b);
    const show = matchesText && matchesBldg;
    top.el.hidden = !show;
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
  const val = (top) => ({
    item_type: `${top.itemType} ${top.itemNames}`.toLowerCase(),
    building: top.buildings.join(","),
    units: top.units,
    boxes: top.boxes,
    vendors: top.vendors.toLowerCase(),
    oldest_received: top.oldest,
  }[by]);
  const groups = [...topRows].sort((a, b) => {
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

function renderCartLines() {
  const wrap = $("cart-lines");
  lineKeys = Object.keys(cart);
  wrap.innerHTML = lineKeys.map((key, i) => {
    const row = stock.get(key);
    const bldg = row.building
      ? `<span class="bldg-badge">Bldg ${escapeHtml(row.building)}</span>`
      : `<span class="bldg-badge bldg-none">Unassigned</span>`;
    const name = row.itemName
      ? ` <span class="item-name">| ${escapeHtml(row.itemName)}</span>` : "";
    return `<div class="cart-line" data-key="${escapeHtml(key)}" data-line="${i}">
      <div class="cart-line-main">
        <div class="cart-line-title">
          <strong>${escapeHtml(row.itemType)}</strong>${name} ${bldg}
          <span class="hint">${row.units} available</span>
        </div>
        <label class="cart-line-deliver">Deliver to building
          <input type="text" class="line-deliver" maxlength="40"
                 list="building-list" placeholder="e.g. 7"
                 value="${escapeHtml(cart[key].deliverTo)}" />
        </label>
        <div class="cart-line-issue" hidden></div>
      </div>
      <div class="stepper">
        <button type="button" class="step-btn line-down" aria-label="Less">&minus;</button>
        <input type="number" class="qty-input line-qty" value="${cart[key].qty}"
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
      () => setCartLine(key, cart[key].qty - 1));
    el.querySelector(".line-up").addEventListener("click",
      () => setCartLine(key, Math.min(cart[key].qty + 1, row.units)));
    el.querySelector(".line-remove").addEventListener("click",
      () => setCartLine(key, 0));
    el.querySelector(".line-deliver").addEventListener("input",
      (ev) => setCartDelivery(key, ev.target.value));
  });
  refreshWarnings();
}

function refreshWarnings() {
  document.querySelectorAll("#cart-lines .cart-line").forEach((el) => {
    const row = stock.get(el.dataset.key);
    const line = cart[el.dataset.key];
    const issue = el.querySelector(".cart-line-issue");
    if (issue.dataset.error) return;   // server errors outrank warnings
    const deliverTo = line ? line.deliverTo : "";
    if (row.building && deliverTo && deliverTo !== row.building) {
      issue.hidden = false;
      issue.className = "cart-line-issue warn";
      issue.textContent = `This stock is assigned to Building ${row.building}; `
        + `you're asking for delivery to Building ${deliverTo}. The warehouse `
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
  // Flatten to requestable lines: named types (W.I.F.) carry their
  // requestable stock in `components`, plain types are the row itself.
  const fresh = new Map();
  (data.stock || []).forEach((r) => {
    if (r.named) {
      (r.components || []).forEach((c) => fresh.set(
        `${r.item_type}|${c.item_name || ""}|${c.building || ""}`, c));
    } else {
      fresh.set(`${r.item_type}|${r.item_name || ""}|${r.building || ""}`, r);
    }
  });
  stock.forEach((row, key) => {
    const now = fresh.get(key);
    row.units = now ? (now.units || 0) : 0;
    // First numeric cell of the line is its Units/Available column, whether
    // the line is a plain tbody's stock-row or a component-row.
    const cell = row.el.querySelector(".stock-row td.num")
      || row.el.querySelector("td.num");
    if (cell) cell.textContent = row.units;
    row.el.querySelector(".qty-input").max = Math.max(row.units, 1);
    if (cartQty(key) > row.units) setCartLine(key, row.units);
  });
  // Roll the fresh component units back up into each named type's header.
  topRows.filter((t) => t.named).forEach((top) => {
    top.units = [...stock.values()]
      .filter((row) => row.top === top)
      .reduce((sum, row) => sum + row.units, 0);
    const cell = top.el.querySelector(".stock-row td.num");
    if (cell) cell.textContent = top.units;
  });
}

async function openCheckout() {
  await refreshAvailability();
  if (!Object.keys(cart).length) return;
  const modal = $("checkout-modal");
  const form = $("checkout-form");
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
    lines: lineKeys.map((key) => ({
      item_type: stock.get(key).itemType,
      item_name: stock.get(key).itemName,
      building: stock.get(key).building,
      quantity: cart[key].qty,
      delivery_building: cart[key].deliverTo,
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
}

init();
