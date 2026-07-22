"""
Cloud sync worker: pushes this machine's inventory to the cloud app and pulls
material requests back, over a single authenticated endpoint.

Modeled on ReaderWorker (reader.py): a daemon thread with a stop event that
reports through the same on_event queue. Offline is the normal case -- the
warehouse wifi is spotty -- so every failure just backs off and retries; the
local app never blocks on the cloud.

One exchange (POST {cloud_url}/sync/exchange, bearer token) per cycle:
  push  - full snapshot of tags/vendors/notes/bol_docs, but only when its
          content hash differs from what the cloud last acked (the tables are
          small at warehouse scale, and a snapshot naturally carries edits and
          deletes),
        - events above the last-acked id (append-only, watermark-based),
        - status updates for requests the manager handled (status_dirty rows).
  pull  - material-request rows above the last-pulled id.

BOL PDFs (the files, not the rows) ride separately: the ack lists the
bol_docs ids whose PDF the cloud is missing (bol_files_wanted), and this
worker follows up with POST /sync/bol_files carrying those files base64-
encoded. The cloud asks again every cycle until it has them, so a failed
upload self-heals; ids whose file is gone from scans/ are simply skipped
(the cloud will keep listing them, which is harmless and bounded).

The response acks advance watermarks stored in the sync_state table. Retries
are safe: snapshot upserts are idempotent, events are keyed by id, request
upserts are insert-or-ignore, and watermarks are row ids (never wall clocks).
"""

import base64
import hashlib
import json
import os
import threading
import time
from datetime import datetime

import requests

import config
from contract import sync_contract

PROTOCOL = 1
EVENTS_BATCH = 1000          # max events pushed per exchange
CONNECT_TIMEOUT = 5          # seconds to establish the HTTPS connection
READ_TIMEOUT = 60            # seconds for the server to answer (big snapshots)
BACKOFF_MAX = 300            # cap between retries after repeated failures
BOL_FILE_MAX_BYTES = 20 * 1024 * 1024   # skip absurdly large PDFs

# sync_state keys
K_EVENTS_PUSHED = "events_pushed_id"      # last event id the cloud acked
K_REQUESTS_PULLED = "requests_pulled_id"  # last request id pulled from cloud
K_SNAPSHOT_HASH = "cloud_snapshot_hash"   # snapshot hash the cloud last acked
K_LAST_SYNC = "last_sync_at"              # ISO timestamp of last success


def _now():
    return datetime.now().isoformat(timespec="seconds")


def snapshot_hash(snapshot):
    """Stable content hash of a snapshot dict (drives 'anything changed?')."""
    blob = json.dumps(snapshot, sort_keys=True, separators=(",", ":"),
                      default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


class SyncWorker:
    def __init__(self, db, on_event, url=None, token=None, interval=None,
                 enabled=None):
        self.db = db
        self.on_event = on_event
        self.url = (url if url is not None else config.CLOUD_URL).rstrip("/")
        self.token = token if token is not None else config.SYNC_TOKEN
        self.interval = interval or config.SYNC_INTERVAL_SECONDS
        self.enabled = (enabled if enabled is not None
                        else config.SYNC_ENABLED) and bool(self.url)

        self._thread = None
        self._stop = threading.Event()
        self._wake = threading.Event()   # set by sync_now() / stop()
        self._backoff = 0                # 0 = healthy; else current retry delay

        # Last-known status, mirrored into /api/status and the UI pill.
        self.online = False              # last exchange succeeded
        self.last_sync = self.db.sync_get(K_LAST_SYNC, "") if db else ""
        self.last_error = ""
        self.warning = ""                # non-fatal, e.g. contract skew
        self.pending = 0                 # local changes not yet on the cloud

    # -- lifecycle -------------------------------------------------------------
    def start(self):
        self._thread = threading.Thread(target=self._run, daemon=True,
                                        name="sync-worker")
        self._thread.start()

    def stop(self):
        self._stop.set()
        self._wake.set()
        if self._thread:
            self._thread.join(timeout=5)

    def sync_now(self):
        """Manual 'Sync now': skip the current wait and retry immediately."""
        self._backoff = 0
        self._wake.set()

    # -- worker loop -----------------------------------------------------------
    def _run(self):
        if not self.enabled:
            self._emit_status(message="Sync is off (no cloud_url configured)")
            return
        # First exchange shortly after startup (give the app a beat to settle).
        self._wait(2)
        while not self._stop.is_set():
            try:
                self.exchange()
            except Exception as exc:  # noqa: BLE001 -- offline is routine
                self.online = False
                self.last_error = self._friendly_error(exc)
                self._backoff = min(max(self.interval, self._backoff * 2),
                                    BACKOFF_MAX)
                self._emit_status()
            self._wait(self._backoff or self.interval)

    def _wait(self, seconds):
        self._wake.wait(timeout=seconds)
        self._wake.clear()

    @staticmethod
    def _friendly_error(exc):
        if isinstance(exc, requests.exceptions.ConnectionError):
            return "Cloud unreachable (offline?)"
        if isinstance(exc, requests.exceptions.Timeout):
            return "Cloud request timed out"
        return str(exc) or exc.__class__.__name__

    # -- one round trip ----------------------------------------------------------
    def exchange(self):
        """Build the payload, POST it, apply the acks. Raises on any failure."""
        db = self.db

        snapshot = db.export_snapshot()
        snap_hash = snapshot_hash(snapshot)
        cloud_hash = db.sync_get(K_SNAPSHOT_HASH, "")
        events_after = int(db.sync_get(K_EVENTS_PUSHED, "0"))
        requests_after = int(db.sync_get(K_REQUESTS_PULLED, "0"))
        events = db.events_since(events_after, EVENTS_BATCH)
        request_updates = db.dirty_request_statuses()

        payload = {
            "protocol": PROTOCOL,
            "contract_hash": sync_contract.contract_hash(),
            "snapshot_hash": snap_hash,
            # Only ship the (comparatively) heavy snapshot when its content
            # differs from what the cloud last acked.
            "snapshot": snapshot if snap_hash != cloud_hash else None,
            "events_after": events_after,
            "events": events,
            "request_updates": request_updates,
            "requests_after": requests_after,
        }

        resp = requests.post(
            f"{self.url}/sync/exchange", json=payload,
            headers={"Authorization": f"Bearer {self.token}"},
            timeout=(CONNECT_TIMEOUT, READ_TIMEOUT))
        if resp.status_code == 401 or resp.status_code == 403:
            raise RuntimeError("Cloud rejected the sync token (check "
                               "sync_token in settings.ini)")
        resp.raise_for_status()
        ack = resp.json()
        if not ack.get("ok"):
            raise RuntimeError(ack.get("message") or "Cloud sync failed")

        # Contract skew is expected (exe and cloud deploy independently) and
        # deliberately non-fatal: the cloud stores unknown columns as TEXT so
        # nothing is dropped. Warn so someone updates the lagging side.
        cloud_contract = ack.get("contract_hash") or ""
        if cloud_contract != sync_contract.contract_hash():
            self.warning = ("Cloud is on a different sync contract version "
                            "(syncing still works; update the exe or the "
                            "cloud app)")
        else:
            self.warning = ""

        # Apply acks / pulls. Each step is idempotent, so a crash between any
        # two of them just repeats work on the next cycle.
        db.sync_set(K_SNAPSHOT_HASH, ack.get("snapshot_hash") or "")
        acked_to = ack.get("events_acked_to")
        # A cloud that lost data (fresh DB) acks lower than our watermark
        # (possibly 0); rewinding re-pushes the missing tail next cycles.
        db.sync_set(K_EVENTS_PUSHED,
                    events_after if acked_to is None else int(acked_to))
        db.clear_request_dirty(ack.get("request_updates_acked") or [])

        pulled = ack.get("requests") or []
        added = db.upsert_pulled_requests(pulled)
        if pulled:
            max_pulled = max(int(r["id"]) for r in pulled)
            if max_pulled > requests_after:
                db.sync_set(K_REQUESTS_PULLED, max_pulled)

        # BOL PDFs the cloud is missing (for the tag pages' "View bill of
        # lading" link). Pushed after the acks: a failed upload leaves the
        # watermarks correct and the cloud just asks again next cycle.
        wanted = ack.get("bol_files_wanted") or []
        if wanted:
            files = self._collect_bol_files(wanted)
            if files:
                up = requests.post(
                    f"{self.url}/sync/bol_files", json={"files": files},
                    headers={"Authorization": f"Bearer {self.token}"},
                    timeout=(CONNECT_TIMEOUT, READ_TIMEOUT))
                up.raise_for_status()

        self.online = True
        self.last_error = ""
        self.last_sync = _now()
        self._backoff = 0
        db.sync_set(K_LAST_SYNC, self.last_sync)
        if added:
            self.on_event({"event": "sync_requests", "added": len(added),
                           "pending": db.count_pending_requests()})
        self._emit_status()

    def _collect_bol_files(self, doc_ids):
        """Read the requested BOL PDFs from scans/ as upload-ready dicts.

        Ids without a doc row or file on disk are skipped (deleted PDFs, or
        another machine did the scanning); the cloud keeps listing them,
        which is harmless.
        """
        files = []
        for doc_id in doc_ids:
            doc = self.db.get_bol_doc(doc_id)
            if doc is None:
                continue
            path = os.path.join(config.SCANS_DIR, doc["filename"])
            try:
                if os.path.getsize(path) > BOL_FILE_MAX_BYTES:
                    continue
                with open(path, "rb") as f:
                    data = f.read()
            except OSError:
                continue
            files.append({"id": doc["id"], "filename": doc["filename"],
                          "data": base64.b64encode(data).decode("ascii")})
        return files

    # -- status ------------------------------------------------------------------
    def _count_pending(self):
        """Local changes the cloud doesn't have yet (for 'N changes pending')."""
        try:
            db = self.db
            pending = db.last_event_id() - int(db.sync_get(K_EVENTS_PUSHED, "0"))
            pending += len(db.dirty_request_statuses())
            # +1 "change" when the snapshot itself is out of date on the cloud.
            if snapshot_hash(db.export_snapshot()) != db.sync_get(K_SNAPSHOT_HASH, ""):
                pending += 1
            return max(0, pending)
        except Exception:  # noqa: BLE001 -- status must never take the app down
            return 0

    def status(self):
        # Recompute pending on every read: between (backed-off) retries the
        # cached value goes stale while the operator keeps checking things in.
        self.pending = self._count_pending() if self.enabled else 0
        return {
            "enabled": self.enabled,
            "online": self.online,
            "last_sync": self.last_sync,
            "error": self.last_error,
            "warning": self.warning,
            "pending": self.pending,
        }

    def _emit_status(self, message=None):
        event = {"event": "sync_status", **self.status()}
        if message:
            event["message"] = message
        self.on_event(event)
