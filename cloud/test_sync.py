"""
End-to-end test of the .exe <-> cloud sync loop, all on this machine.

Needs the Docker Postgres from README.md running (localhost:5433). The script
creates and uses a scratch database (warehouse_e2e) so it never touches the
dev "warehouse" DB, starts its own cloud app on a scratch port, drives a real
local SQLite Database + SyncWorker against it, and checks the full round trip:

  1. check-in on the "exe" side -> appears in the cloud inventory API/pages
  2. no-change cycles skip the snapshot (hash watermark)
  3. request submitted on the site -> lands in the exe as pending, and the
     cart endpoint validates availability (zero stock, over-quantity, lines
     jointly exceeding stock) before creating an order of N lines that share
     an order_ref
  4. staging round trip: Fulfill shows "staging for exit" on the site, cancel
     reverts to pending, and fulfill_request commits the checkout draws +
     fulfilled status together (short fulfillment requires a note)
  5. offline: exchanges against a dead port fail cleanly, changes queue up,
     and the next successful exchange catches the cloud up
  6. checkout (edit) and vendor add propagate via the snapshot
  7. a wiped cloud DB rebuilds itself from the exe within two cycles

Run:  python test_sync.py   (from cloud/, any venv with both requirement sets)
"""

import os
import subprocess
import sys
import tempfile
import time

import psycopg
import requests as http

CLOUD_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(CLOUD_DIR)
sys.path.insert(0, ROOT)                      # local app modules (db, sync)

from db import Database                        # noqa: E402 (local SQLite side)
from sync import (                             # noqa: E402
    K_EVENTS_PUSHED, K_SNAPSHOT_HASH, SyncWorker, snapshot_hash)

# The test drops and rebuilds its whole database, so it must never point at
# the "real" dev DB (the one the manually-run cloud app uses). Default to a
# scratch DB inside the same Docker Postgres, created on first run.
PG_URL = os.environ.get("DATABASE_URL", "")
PG_ADMIN_URL = "postgresql://postgres:postgres@localhost:5433/postgres"
PG_TEST_URL = "postgresql://postgres:postgres@localhost:5433/warehouse_e2e"
TOKEN = "e2e-test-token"
PORT = 8199
BASE = f"http://127.0.0.1:{PORT}"


def ensure_test_db():
    global PG_URL
    if PG_URL:
        return                     # explicit override: caller knows best
    with psycopg.connect(PG_ADMIN_URL, autocommit=True) as conn:
        row = conn.execute("SELECT 1 FROM pg_database "
                           "WHERE datname='warehouse_e2e'").fetchone()
        if not row:
            conn.execute("CREATE DATABASE warehouse_e2e")
    PG_URL = PG_TEST_URL

CHECKS = []


def check(name, cond, detail=""):
    CHECKS.append((name, bool(cond)))
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" +
          (f"  ({detail})" if detail and not cond else ""))
    return cond


def wipe_cloud(full=True):
    with psycopg.connect(PG_URL, autocommit=True) as conn:
        if full:
            conn.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
        else:
            for t in ("tags", "vendors", "notes", "bol_docs", "bol_files",
                      "events", "requests", "sync_meta"):
                conn.execute(f"DELETE FROM {t}")


def start_cloud():
    env = dict(os.environ, DATABASE_URL=PG_URL, SYNC_TOKEN=TOKEN)
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app:app", "--port", str(PORT)],
        cwd=CLOUD_DIR, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    for _ in range(50):
        try:
            if http.get(f"{BASE}/healthz", timeout=1).json().get("ok"):
                return proc
        except Exception:  # noqa: BLE001
            pass
        time.sleep(0.2)
    proc.terminate()
    raise SystemExit("cloud app did not come up; is Docker Postgres running? "
                     "(see cloud/README.md)")


def main():
    print("== E2E sync test ==")
    ensure_test_db()
    wipe_cloud(full=True)
    cloud = start_cloud()
    events = []
    try:
        dbfile = os.path.join(tempfile.mkdtemp(), "exe.db")
        db = Database(dbfile)
        worker = SyncWorker(db, on_event=events.append, url=BASE, token=TOKEN,
                            enabled=True)

        # -- 0. sync auth ------------------------------------------------------
        bad = http.post(f"{BASE}/sync/exchange", json={"protocol": 1},
                        headers={"Authorization": "Bearer wrong-token"},
                        timeout=5)
        check("wrong sync token is rejected (401)", bad.status_code == 401)
        check("no token is rejected",
              http.post(f"{BASE}/sync/exchange", json={}, timeout=5)
              .status_code == 401)

        # -- 1. check-in propagates ------------------------------------------
        db.receive_shipment(["E2E00001", "E2E00002"], "TSC", "7", "BOL-77",
                            "Acme Corp", {"quantity": 5, "sku": "TSC-5"})
        db.receive_shipment(["E2E00003"], "CDU", "8", "BOL-78", "Beta LLC",
                            {"quantity": 2})
        worker.exchange()
        inv = http.get(f"{BASE}/api/inventory", timeout=5).json()
        by_type = {t["item_type"]: t for t in inv["types"]}
        check("cloud shows 10 TSC units after check-in",
              by_type.get("TSC", {}).get("units") == 10, str(inv))
        check("cloud shows 2 CDU units", by_type.get("CDU", {}).get("units") == 2)
        page = http.get(BASE, timeout=5).text
        check("inventory page renders the item type",
              "TSC" in page and "BOL-77" in page)

        # -- 2. unchanged snapshot is skipped --------------------------------
        check("snapshot hash acked == local content hash",
              db.sync_get(K_SNAPSHOT_HASH) == snapshot_hash(db.export_snapshot()))
        worker.exchange()
        check("second exchange still ok (no-change cycle)", worker.online)

        # -- 3. site request reaches the exe ---------------------------------
        r = http.post(f"{BASE}/api/requests", json={
            "item_type": "TSC", "quantity": 3, "jobsite": "Switch 4",
            "requester": "E2E Bot", "note": "need by friday"}, timeout=5).json()
        check("request created on cloud", r.get("ok"), str(r))
        rid = r["request"]["id"]
        worker.exchange()
        local = {x["id"]: x for x in db.list_requests()}
        check("request pulled into exe as pending",
              local.get(rid, {}).get("status") == "pending", str(local))
        check("sync_requests event fired for the UI",
              any(e.get("event") == "sync_requests" for e in events))

        # -- 3b. cart orders validate against mirrored stock -------------------
        bad = http.post(f"{BASE}/api/requests", json={
            "item_type": "TSC", "quantity": 999, "requester": "E2E Bot"},
            timeout=5).json()
        check("legacy API rejects over-quantity", not bad.get("ok"), str(bad))
        bad = http.post(f"{BASE}/api/requests", json={
            "item_type": "Ghost Item", "quantity": 1, "requester": "E2E Bot"},
            timeout=5).json()
        check("legacy API rejects zero-stock item", not bad.get("ok"), str(bad))

        bad = http.post(f"{BASE}/api/requests/cart", json={
            "requester": "E2E Bot", "delivery_building": "7",
            "lines": [{"item_type": "TSC", "building": "7", "quantity": 999}]},
            timeout=5)
        check("cart over-quantity line rejected (400)", bad.status_code == 400,
              bad.text)
        body = bad.json()
        check("cart error names the offending line",
              (body.get("errors") or [{}])[0].get("line") == 0
              and "Only 10" in body["errors"][0]["message"], str(body))
        bad = http.post(f"{BASE}/api/requests/cart", json={
            "requester": "E2E Bot", "delivery_building": "7",
            "lines": [{"item_type": "Ghost Item", "building": "7",
                       "quantity": 1}]}, timeout=5)
        check("cart zero-stock line rejected", bad.status_code == 400, bad.text)
        bad = http.post(f"{BASE}/api/requests/cart", json={
            "requester": "E2E Bot", "delivery_building": "7",
            "lines": [{"item_type": "TSC", "building": "7", "quantity": 6},
                      {"item_type": "TSC", "building": "7", "quantity": 6}]},
            timeout=5)
        check("cart lines jointly exceeding stock rejected",
              bad.status_code == 400
              and len(bad.json().get("errors") or []) == 2, bad.text)
        bad = http.post(f"{BASE}/api/requests/cart", json={
            "requester": "E2E Bot", "delivery_building": "",
            "lines": [{"item_type": "TSC", "building": "7", "quantity": 1}]},
            timeout=5)
        check("cart without a delivery building rejected",
              bad.status_code == 400, bad.text)

        cart = http.post(f"{BASE}/api/requests/cart", json={
            "requester": "E2E Bot", "contact": "e2e@example.com",
            "jobsite": "Switch 4", "note": "cart e2e",
            "lines": [{"item_type": "TSC", "building": "7", "quantity": 2,
                       "delivery_building": "7"},
                      {"item_type": "CDU", "building": "8", "quantity": 1,
                       "delivery_building": "8"}]},
            timeout=5).json()
        check("valid cart accepted", cart.get("ok"), str(cart))
        check("cart returns an order_ref and one id per line",
              bool(cart.get("order_ref")) and len(cart.get("ids") or []) == 2,
              str(cart))
        worker.exchange()
        local = {x["id"]: x for x in db.list_requests()}
        refs = {local[i]["order_ref"] for i in cart["ids"] if i in local}
        check("cart lines pulled into exe sharing the order_ref",
              refs == {cart["order_ref"]}, str(refs))
        bldgs = {local[i]["item_type"]: local[i]["building"]
                 for i in cart["ids"] if i in local}
        check("per-line delivery buildings pulled into exe",
              bldgs == {"TSC": "7", "CDU": "8"}, str(bldgs))

        # -- 4. staging + checkout-driven fulfillment --------------------------
        def cloud_request():
            rows = http.get(f"{BASE}/api/requests", timeout=5).json()["requests"]
            return {x["id"]: x for x in rows}.get(rid, {})

        # One-click fulfilled is gone: only pending<->staging/declined here.
        res = db.set_request_status(rid, "fulfilled", "nope")
        check("direct fulfilled transition is rejected", not res["ok"], str(res))

        res = db.set_request_status(rid, "staging")
        check("pending -> staging accepted", res["ok"], str(res))
        worker.exchange()
        check("cloud shows request staging",
              cloud_request().get("status") == "staging", str(cloud_request()))
        rpage = http.get(f"{BASE}/requests", timeout=5).text
        check("site renders 'staging for exit' badge", "staging for exit" in rpage)

        # Cancel: back to pending on both sides, nothing committed.
        res = db.set_request_status(rid, "pending")
        check("staging -> pending (cancel) accepted", res["ok"], str(res))
        worker.exchange()
        check("cloud back to pending after cancel",
              cloud_request().get("status") == "pending")

        # Fulfill for real: re-stage, then commit draws. The request asks for
        # 3 TSC but only 2 get staged -> short, so a note is required and the
        # handler note gets the "2 of 3 supplied" prefix.
        db.set_request_status(rid, "staging")
        short = db.fulfill_request(
            rid, [{"epc": "E2E00001", "amount": 2, "building": "7"}], note="")
        check("short fulfillment without a note is rejected",
              not short["ok"] and short.get("note_required"), str(short))
        tag = {t["epc"]: t for t in db.export_snapshot()["tags"]}["E2E00001"]
        check("rejected fulfillment left the box untouched",
              tag["remaining"] == 5, str(tag))

        done = db.fulfill_request(
            rid, [{"epc": "E2E00001", "amount": 2, "building": "7"}],
            note="third unit ships next week")
        check("fulfill_request commits the draws", done["ok"], str(done))
        check("fulfill_request reports 2 of 3 delivered",
              done.get("delivered") == 2 and done.get("short"), str(done))
        tag = {t["epc"]: t for t in db.export_snapshot()["tags"]}["E2E00001"]
        check("draw decremented the box (5 -> 3)",
              tag["remaining"] == 3, str(tag))
        check("request fulfilled locally",
              {x["id"]: x for x in db.list_requests()}[rid]["status"] == "fulfilled")

        worker.exchange()
        check("cloud shows request fulfilled",
              cloud_request().get("status") == "fulfilled")
        check("shortfall note (with prefix) visible on cloud",
              cloud_request().get("handler_note")
              == "2 of 3 supplied -- third unit ships next week",
              str(cloud_request()))
        inv = http.get(f"{BASE}/api/inventory", timeout=5).json()
        by_type = {t["item_type"]: t for t in inv["types"]}
        check("cloud inventory reflects the fulfillment draw (8 TSC left)",
              by_type.get("TSC", {}).get("units") == 8, str(by_type.get("TSC")))
        rpage = http.get(f"{BASE}/requests", timeout=5).text
        check("orders page renders line status + order ref",
              "fulfilled" in rpage and cart["order_ref"] in rpage)
        check("already-fulfilled request cannot be re-fulfilled",
              not db.fulfill_request(rid, [{"epc": "E2E00003"}], "x")["ok"])

        # -- 5. offline behavior ----------------------------------------------
        dead = SyncWorker(db, on_event=events.append,
                          url="http://127.0.0.1:9", token=TOKEN, enabled=True)
        offline_failed = False
        try:
            dead.exchange()
        except Exception:  # noqa: BLE001
            offline_failed = True
        check("exchange against dead endpoint raises (worker would back off)",
              offline_failed)
        db.receive_shipment(["E2E00004"], "W.I.F.", "6", "BOL-79", "Acme Corp",
                            {"quantity": 1})
        dead._emit_status()
        check("pending counter sees queued offline changes",
              events[-1]["pending"] > 0, str(events[-1]))
        worker.exchange()   # back online: catch up
        inv = http.get(f"{BASE}/api/inventory", timeout=5).json()
        check("offline check-in arrives after reconnect",
              any(t["item_type"] == "W.I.F." for t in inv["types"]))

        # -- 5b. named types (W.I.F.) roll up into one stock row ---------------
        # Components carry per-box item_names; the browse page shows ONE
        # W.I.F. row whose drill-down lists each component, and requests are
        # per component. E2E00004 above was a W.I.F. box with NO name, so the
        # mixed case (named + unnamed boxes of one type) is covered too.
        db.receive_shipment(["E2E00006"], "W.I.F.", "6", "BOL-80", "Acme Corp",
                            {"quantity": 724,
                             "item_name": "DOOR PANEL ASM_RIGHT"})
        db.receive_shipment(["E2E00007"], "W.I.F.", "6", "BOL-80", "Acme Corp",
                            {"quantity": 2268,
                             "item_name": "Valve Support Lower"})
        worker.exchange()
        stock_rows = http.get(f"{BASE}/api/stock", timeout=5).json()["stock"]
        wif = [r for r in stock_rows if r["item_type"] == "W.I.F."]
        check("W.I.F. appears as exactly one stock row",
              len(wif) == 1 and wif[0].get("named"), str(wif))
        comps = {c["item_name"]: c for c in wif[0].get("components") or []}
        check("W.I.F. row totals its components",
              wif[0]["units"] == 724 + 2268 + 1, str(wif))
        check("components carry name/units/BOL/status",
              comps.get("DOOR PANEL ASM_RIGHT", {}).get("units") == 724
              and comps.get("Valve Support Lower", {}).get("units") == 2268
              and "BOL-80" in comps.get("Valve Support Lower",
                                        {}).get("bol_numbers", [])
              and comps.get("Valve Support Lower",
                            {}).get("status") == "In Warehouse", str(comps))
        check("unnamed W.I.F. box shows as its own component",
              comps.get("", {}).get("units") == 1, str(comps))
        page = http.get(BASE, timeout=5).text
        check("browse page renders the component drill-down",
              "DOOR PANEL ASM_RIGHT" in page and "component-row" in page)
        bad = http.post(f"{BASE}/api/requests/cart", json={
            "requester": "E2E Bot",
            "lines": [{"item_type": "W.I.F.",
                       "item_name": "DOOR PANEL ASM_RIGHT", "building": "6",
                       "quantity": 725, "delivery_building": "6"}]},
            timeout=5)
        check("component over-quantity rejected against its own stock",
              bad.status_code == 400 and "Only 724" in bad.text, bad.text)
        wif_cart = http.post(f"{BASE}/api/requests/cart", json={
            "requester": "E2E Bot",
            "lines": [{"item_type": "W.I.F.",
                       "item_name": "DOOR PANEL ASM_RIGHT", "building": "6",
                       "quantity": 10, "delivery_building": "6"}]},
            timeout=5).json()
        check("component request accepted", wif_cart.get("ok"), str(wif_cart))
        worker.exchange()
        local = {x["id"]: x for x in db.list_requests()}
        wif_line = local.get((wif_cart.get("ids") or [0])[0], {})
        check("component name travels to the exe with the request",
              wif_line.get("item_name") == "DOOR PANEL ASM_RIGHT",
              str(wif_line))

        # -- 6. edits propagate (checkout + vendor) ---------------------------
        db.deliver_units("E2E00001", 5, "7")     # empty one box
        db.add_vendor("Gamma Inc")
        worker.exchange()
        inv = http.get(f"{BASE}/api/inventory", timeout=5).json()
        by_type = {t["item_type"]: t for t in inv["types"]}
        check("checkout draws cloud count down to 5 TSC",
              by_type.get("TSC", {}).get("units") == 5, str(by_type.get("TSC")))

        # -- 7. wiped cloud self-heals ----------------------------------------
        wipe_cloud(full=False)
        worker.exchange()   # learns the cloud is empty (hash/events rewind)
        worker.exchange()   # re-pushes snapshot + event backlog
        inv = http.get(f"{BASE}/api/inventory", timeout=5).json()
        by_type = {t["item_type"]: t for t in inv["types"]}
        check("cloud rebuilt from exe after wipe (TSC back to 5)",
              by_type.get("TSC", {}).get("units") == 5, str(inv))
        check("events re-pushed after wipe",
              int(db.sync_get(K_EVENTS_PUSHED)) == db.last_event_id())

        # -- 8. BOL PDF sync + tag page (label QR target) ----------------------
        import config as exe_config              # noqa: E402
        exe_config.SCANS_DIR = tempfile.mkdtemp()
        with open(os.path.join(exe_config.SCANS_DIR, "bol_e2e.pdf"), "wb") as f:
            f.write(b"%PDF-1.4\n% e2e test document\n%%EOF\n")
        doc = db.create_bol_doc("BOL-99", "bol_e2e.pdf", "scan", 1)
        db.receive_shipment(["E2E00005"], "TSC", "8", "BOL-99", "Acme Corp",
                            {"quantity": 4}, bol_doc_id=doc["id"],
                            po_number="PO-9", sector="8.1")
        worker.exchange()   # snapshot + ack wants the file + follow-up upload
        page = http.get(f"{BASE}/tag/e2e00005", timeout=5)  # case-insensitive
        check("tag page renders box details",
              page.status_code == 200 and "BOL-99" in page.text
              and "8.1" in page.text, f"status {page.status_code}")
        check("tag page links the BOL PDF", f'/bol/{doc["id"]}' in page.text)
        pdf = http.get(f"{BASE}/bol/{doc['id']}", timeout=5)
        check("BOL PDF served inline",
              pdf.status_code == 200 and pdf.content.startswith(b"%PDF-")
              and "application/pdf" in pdf.headers.get("content-type", ""))
        check("unknown tag page 404s",
              http.get(f"{BASE}/tag/DEADBEEFDEADBEEFDEADBEEF",
                       timeout=5).status_code == 404)
        check("missing BOL file 404s",
              http.get(f"{BASE}/bol/999999", timeout=5).status_code == 404)

        db.close()
    finally:
        cloud.terminate()

    failed = [n for n, ok in CHECKS if not ok]
    print(f"\n{len(CHECKS) - len(failed)}/{len(CHECKS)} checks passed")
    if failed:
        print("FAILED:", ", ".join(failed))
        sys.exit(1)
    print("E2E OK")


if __name__ == "__main__":
    main()
