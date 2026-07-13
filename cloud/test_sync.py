"""
End-to-end test of the .exe <-> cloud sync loop, all on this machine.

Needs the Docker Postgres from README.md running (localhost:5433). The script
starts its own cloud app on a scratch port, drives a real local SQLite
Database + SyncWorker against it, and checks the full round trip:

  1. check-in on the "exe" side -> appears in the cloud inventory API/pages
  2. no-change cycles skip the snapshot (hash watermark)
  3. request submitted on the site -> lands in the exe as pending
  4. exe fulfills it -> cloud shows fulfilled + the manager's note
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

PG_URL = os.environ.get(
    "DATABASE_URL", "postgresql://postgres:postgres@localhost:5433/warehouse")
TOKEN = "e2e-test-token"
PORT = 8199
BASE = f"http://127.0.0.1:{PORT}"

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
            for t in ("tags", "vendors", "notes", "bol_docs", "events",
                      "requests", "sync_meta"):
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

        # -- 4. fulfillment flows back ----------------------------------------
        db.set_request_status(rid, "fulfilled", "sent on Tuesday truck")
        worker.exchange()
        cloud_reqs = {x["id"]: x for x in
                      http.get(f"{BASE}/api/requests", timeout=5).json()["requests"]}
        check("cloud shows request fulfilled",
              cloud_reqs.get(rid, {}).get("status") == "fulfilled")
        check("manager note visible on cloud",
              cloud_reqs.get(rid, {}).get("handler_note") == "sent on Tuesday truck")
        rpage = http.get(f"{BASE}/requests", timeout=5).text
        check("requests page renders status + form",
              "fulfilled" in rpage and "New request" in rpage)

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
