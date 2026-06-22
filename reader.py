"""
Serial worker for the TSL ASCII 2.0 reader (Vulcan RFID Indium / TSL 1128).

The reader's physical trigger drives every scan. By default a single trigger
press runs `.iv`, so while the trigger is held the reader streams `EP:` lines
on its own; we never issue `.iv` ourselves. We also enable asynchronous switch
notifications (`.sa -aon`) so the reader reports trigger state changes.

A scan "burst" is finalized once no EP:/OK: lines have arrived for
QUIET_GAP_SECONDS (the trigger has been released):
  - check in / check out : ONE tag per trigger pull -- take the most-frequently
                           -read EPC (the strongest / closest tag) of the burst.
  - inventory            : take every distinct EPC seen across the whole hold.
  - finder               : no burst; while the trigger is held, RSSI (`RI:`) for
                           one target EPC is streamed live to gauge proximity.

Output power is set per mode with `.iv -o<nn> -n` (set parameter, take no
action), which persists for subsequent trigger-initiated inventories:
  - check in / check out : low power (config.CHECK_POWER_DBM) so only the tag
                           held at the reader is read (avoids stray EPCs).
  - inventory            : full power (config.INVENTORY_POWER_DBM).

Events are delivered through the on_event callback (called from the worker
thread, so keep it fast -- it should just enqueue).
"""

import time
import threading
from collections import Counter

import serial

import config

# Modes
IDLE = "idle"
CHECKIN = "checkin"
CHECKOUT = "checkout"
INVENTORY = "inventory"
FINDER = "finder"
# Check-in and check-out take one tag per trigger pull (a tag is applied to each
# unit individually). Inventory sweeps every distinct tag while the trigger is held.
SINGLE_MODES = (CHECKIN, CHECKOUT)
SWEEP_MODES = (INVENTORY,)


def _power_for_mode(mode, check_power):
    """Output power (dBm) for a mode, or None to leave the reader unchanged."""
    if mode in (CHECKIN, CHECKOUT):
        return check_power
    if mode in (INVENTORY, FINDER):
        return config.INVENTORY_POWER_DBM
    return None


class ReaderWorker:
    def __init__(self, on_event, port=None, baud=None, timeout=None):
        self.on_event = on_event
        self.port = port or config.SERIAL_PORT
        self.baud = baud or config.BAUD_RATE
        self.timeout = timeout or config.SERIAL_TIMEOUT

        self._ser = None
        self._thread = None
        self._stop = threading.Event()
        self._lock = threading.Lock()

        self._mode = IDLE
        self._checkin_payload = None  # {"item_type":..., "fields":{...}}
        # Per-unit fields (SKU, mfc date) for the NEXT tag in check-in; the UI
        # updates these before each trigger pull since they differ per unit.
        self._checkin_item = {}
        self._connected = False

        # Output power (dBm) to apply on the reader; set when the mode changes
        # and flushed to the serial port by the worker thread.
        self._pending_power = None
        self._applied_power = None
        # Adjustable check-in/check-out power (inventory always runs at full power).
        self._check_power = config.CHECK_POWER_DBM

        # RSSI output toggle (on only in finder mode); applied like power.
        self._pending_rssi = None
        self._applied_rssi = None

        # Finder mode: stream RSSI for one specific tag.
        self._finder_target = None
        self._last_epc = None

        # Accumulator for the current burst.
        self._counts = Counter()
        self._distinct = set()
        self._last_read = 0.0

    # -- public API ----------------------------------------------------------
    def start(self):
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="reader", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2.0)
        if self._ser and self._ser.is_open:
            try:
                self._ser.close()
            except Exception:
                pass

    @property
    def connected(self):
        return self._connected

    @property
    def mode(self):
        with self._lock:
            return self._mode

    @property
    def check_power(self):
        return self._check_power

    def set_check_power(self, dbm):
        """Set the check-in/check-out output power (dBm); applies live if active."""
        dbm = max(config.READER_POWER_MIN_DBM,
                  min(config.READER_POWER_MAX_DBM, int(dbm)))
        with self._lock:
            self._check_power = dbm
            if self._mode in (CHECKIN, CHECKOUT):
                self._pending_power = dbm
        return dbm

    def set_mode(self, mode, payload=None):
        with self._lock:
            self._mode = mode
            self._checkin_payload = payload if mode == CHECKIN else None
            self._checkin_item = {}
            self._finder_target = (
                (payload or {}).get("target_epc") if mode == FINDER else None)
            self._last_epc = None
            # Drop anything partially accumulated when the mode changes.
            self._counts.clear()
            self._distinct.clear()
            power = _power_for_mode(mode, self._check_power)
            if power is not None:
                self._pending_power = power
            # RSSI output is only needed (and wanted) for the finder.
            self._pending_rssi = (mode == FINDER)

    def set_checkin_item_fields(self, fields):
        """Set the per-unit fields (SKU, mfc date) attached to the next tag."""
        with self._lock:
            self._checkin_item = dict(fields or {})

    def inject_scan(self, epcs):
        """Test hook: feed EPCs as if they came from the reader (no hardware)."""
        with self._lock:
            mode = self._mode
            payload = self._checkin_payload
        if mode == IDLE:
            return
        self._finalize(mode, payload, Counter(e.upper() for e in epcs),
                       set(e.upper() for e in epcs))

    # -- worker loop ---------------------------------------------------------
    def _run(self):
        while not self._stop.is_set():
            try:
                self._ser = serial.Serial(self.port, self.baud, timeout=self.timeout)
                time.sleep(0.2)
                self._ser.reset_input_buffer()
                self._ser.write(b".sa -aon\r\n")  # async switch-state notifications
                time.sleep(0.1)
                self._ser.reset_input_buffer()
                self._connected = True
                # Reader resets parameters on power-up, so re-apply power and RSSI
                # for whatever mode we're currently in.
                self._applied_power = None
                self._applied_rssi = None
                with self._lock:
                    power = _power_for_mode(self._mode, self._check_power)
                    if power is not None:
                        self._pending_power = power
                    self._pending_rssi = (self._mode == FINDER)
                self._emit({"event": "status", "connected": True,
                            "message": f"Reader connected on {self.port}"})
                self._read_loop()
            except serial.SerialException as exc:
                self._connected = False
                self._emit({"event": "status", "connected": False,
                            "message": f"Reader not connected: {exc}"})
            except Exception as exc:  # noqa: BLE001 - keep the worker alive
                self._connected = False
                self._emit({"event": "status", "connected": False,
                            "message": f"Reader error: {exc}"})
            finally:
                if self._ser and self._ser.is_open:
                    try:
                        self._ser.close()
                    except Exception:
                        pass
            if not self._stop.is_set():
                time.sleep(2.0)  # wait before trying to reconnect

    def _read_loop(self):
        while not self._stop.is_set():
            self._apply_pending_power()
            self._apply_pending_rssi()
            raw = self._ser.readline()
            if raw:
                line = raw.decode(errors="ignore").strip()
                if line:
                    self._handle_line(line)
            self._maybe_finalize()

    def _apply_pending_power(self):
        """Push a pending output-power change to the reader (worker thread only)."""
        with self._lock:
            power = self._pending_power
            self._pending_power = None
        if power is None or power == self._applied_power:
            return
        try:
            # Set the inventory output power without performing an inventory; the
            # trigger's `.iv` then uses this power until it's changed again.
            self._ser.write(f".iv -o{power} -n\r\n".encode())
            self._applied_power = power
        except Exception:
            # Couldn't write; leave it pending for the next loop / reconnect.
            with self._lock:
                if self._pending_power is None:
                    self._pending_power = power

    def _apply_pending_rssi(self):
        """Toggle RSSI (`RI:`) output on the reader (worker thread only).

        Enabled only for the finder so we can gauge proximity to one tag; off
        otherwise to keep inventory output clean.
        """
        with self._lock:
            want = self._pending_rssi
            self._pending_rssi = None
        if want is None or want == self._applied_rssi:
            return
        try:
            flag = "on" if want else "off"
            self._ser.write(f".iv -r {flag} -n\r\n".encode())
            self._applied_rssi = want
        except Exception:
            with self._lock:
                if self._pending_rssi is None:
                    self._pending_rssi = want

    def _handle_line(self, line):
        if line.startswith("EP:"):
            epc = line[3:].strip().upper()
            if not epc:
                return
            self._last_epc = epc
            with self._lock:
                mode = self._mode
            if mode == IDLE:
                return
            if mode == FINDER:
                # Finder doesn't accumulate; it streams RSSI (see RI: below).
                return
            self._last_read = time.time()
            is_new = epc not in self._distinct
            self._counts[epc] += 1
            self._distinct.add(epc)
            if is_new:
                self._emit({"event": "live", "mode": mode, "epc": epc,
                            "distinct": len(self._distinct)})
        elif line.startswith("RI:"):
            rssi = self._parse_rssi(line[3:])
            if rssi is None:
                return
            with self._lock:
                mode = self._mode
                target = self._finder_target
            if mode == FINDER and self._last_epc and self._last_epc == target:
                self._emit({"event": "finder", "epc": self._last_epc, "rssi": rssi})
        elif line.startswith(("OK:", "ER:")):
            # End of one .iv cycle; the quiet-gap check finalizes the burst.
            self._last_epc = None
            if self._distinct:
                self._last_read = time.time()

    @staticmethod
    def _parse_rssi(text):
        """Parse an RSSI value from an `RI:` payload; return int or None."""
        token = text.strip().split()[0] if text.strip() else ""
        try:
            return int(token)
        except ValueError:
            try:
                return int(token, 16)
            except ValueError:
                return None

    def _maybe_finalize(self):
        if not self._distinct:
            return
        if time.time() - self._last_read < config.QUIET_GAP_SECONDS:
            return
        with self._lock:
            mode = self._mode
            payload = self._checkin_payload
            counts = self._counts.copy()
            distinct = set(self._distinct)
            self._counts.clear()
            self._distinct.clear()
        self._finalize(mode, payload, counts, distinct)

    def _finalize(self, mode, payload, counts, distinct):
        if mode == IDLE or not distinct:
            return
        if mode == CHECKOUT:
            epc = counts.most_common(1)[0][0]
            self._emit({"event": "scan", "mode": CHECKOUT, "epc": epc,
                        "reads": counts[epc], "candidates": len(distinct)})
        elif mode == CHECKIN:
            # One tag per trigger pull: use the strongest (most-read) EPC.
            epc = counts.most_common(1)[0][0]
            with self._lock:
                item_fields = dict(self._checkin_item)
            event = {"event": "checkin_batch", "epcs": [epc], "distinct": 1,
                     "candidates": len(distinct), "item_fields": item_fields}
            if payload:
                event["item_type"] = payload.get("item_type")
                event["fields"] = payload.get("fields", {})
            self._emit(event)
        elif mode == INVENTORY:
            self._emit({"event": "inventory", "epcs": sorted(distinct),
                        "distinct": len(distinct)})

    def _emit(self, event):
        try:
            self.on_event(event)
        except Exception:
            pass
