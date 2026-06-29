"""
Serial worker for the TSL ASCII 2.0 reader (Vulcan RFID Indium / TSL 1128).

The reader's physical trigger drives every scan. By default a single trigger
press runs `.iv`, so while the trigger is held the reader streams `EP:` lines
on its own; we never issue `.iv` ourselves. We also enable asynchronous switch
notifications (`.sa -aon`) so the reader reports trigger state changes.

A scan "burst" is finalized once no EP:/OK: lines have arrived for
QUIET_GAP_SECONDS (the trigger has been released):
  - check in / check out : ONE tag per trigger pull -- take the EPC with the
                           strongest peak RSSI (the closest tag); if no RSSI was
                           captured, fall back to the most-frequently-read EPC.
  - inventory            : take every distinct EPC seen across the whole hold.
  - finder               : constrains the trigger `.iv` to a single tag using a
                           Gen2 Select mask for the target EPC (-ql sl -io off),
                           so RI: lines for just that tag stream rapidly while
                           the trigger is held. Releasing the trigger (`SW: off`)
                           emits a finder_reset so the UI resets for the next aim.

RSSI (`RI:`) output is enabled for check-in/check-out (to pick the closest tag)
and the finder (live proximity); it is left off for inventory.

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

        # Read-success beep toggle (off in finder so it doesn't compete with the
        # browser proximity beep; on elsewhere); applied like power.
        self._pending_beep = None
        self._applied_beep = None

        # One-shot handheld alert (buzz/vibrate) request; flushed by the worker.
        self._pending_alert = False

        # Finder mode: TSL FindTag (`.ft`) streams a continuous RP: proximity
        # percentage for one target tag. We arm it on entering finder and disarm
        # it on leaving; _applied_finder tracks what is currently armed.
        self._finder_target = None
        self._pending_finder = False
        self._applied_finder = None
        self._last_epc = None

        # Accumulator for the current burst.
        self._counts = Counter()
        self._distinct = set()
        # Peak RSSI per EPC in the burst (check-in/check-out tag selection).
        self._rssi_peak = {}
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

    def alert(self):
        """Request a one-shot handheld alert (buzz/vibrate). Thread-safe; the
        worker thread flushes it to the serial port on its next loop."""
        with self._lock:
            self._pending_alert = True

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
            self._rssi_peak.clear()
            power = _power_for_mode(mode, self._check_power)
            if power is not None:
                self._pending_power = power
            # RSSI (`.iv -r`) is streamed for check-in/check-out (closest tag)
            # and the finder (live proximity); off elsewhere.
            self._pending_rssi = mode in (CHECKIN, CHECKOUT, FINDER)
            # Mute the reader's read-success beep in finder mode so it doesn't
            # compete with the browser's proximity beep; on in every other mode.
            self._pending_beep = (mode != FINDER)
            # Reconcile the finder select-mask (single-tag .iv) for the new mode.
            self._pending_finder = True

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
                # Reader resets parameters on power-up, so re-apply power, RSSI,
                # the beep toggle, and the FindTag state for the current mode.
                self._applied_power = None
                self._applied_rssi = None
                self._applied_beep = None
                self._applied_finder = None
                with self._lock:
                    power = _power_for_mode(self._mode, self._check_power)
                    if power is not None:
                        self._pending_power = power
                    self._pending_rssi = self._mode in (CHECKIN, CHECKOUT, FINDER)
                    self._pending_beep = (self._mode != FINDER)
                    self._pending_finder = True
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
            self._apply_pending_beep()
            self._apply_pending_finder()
            self._apply_pending_alert()
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

    def _apply_pending_beep(self):
        """Toggle the reader's read-success beep (`.iv -al`) on the port.

        Muted in finder mode so it doesn't compete with the browser proximity
        beep; on otherwise so check-in/out/inventory still beep on each read.
        """
        with self._lock:
            want = self._pending_beep
            self._pending_beep = None
        if want is None or want == self._applied_beep:
            return
        try:
            flag = "on" if want else "off"
            self._ser.write(f".iv -al {flag} -n\r\n".encode())
            self._applied_beep = want
        except Exception:
            with self._lock:
                if self._pending_beep is None:
                    self._pending_beep = want

    def _apply_pending_finder(self):
        """Constrain the trigger `.iv` to a single target tag for finder mode.

        This reader's firmware does not support the FindTag (`.ft`) command, so
        instead we set a Gen2 Select mask on the inventory: matching only the
        target EPC asserts its SL flag, and `-ql sl` then inventories only
        SL-asserted tags. `-io off` is required so the reader actually performs
        the select before each round. The result is a fast, frequent RI: stream
        for just the target (instead of it appearing once per all-tag round).
        Leaving finder restores the normal all-tag inventory.
        """
        with self._lock:
            pending = self._pending_finder
            self._pending_finder = False
            want = self._finder_target if self._mode == FINDER else None
        if not pending or want == self._applied_finder:
            return
        try:
            if want:
                # EPC memory bank: bits 0x00-0x1F are CRC+PC, so the EPC select
                # mask starts at bit offset 0x20. Length is the EPC's bit count.
                # Session 0 (-qs s0) re-reads the tag on nearly every round (its
                # inventoried flag reverts immediately) and a fixed Q of 0
                # (-qa fix -qv 0) keeps each single-tag round minimal, so RI:
                # streams continuously instead of one-read-then-silent.
                bits = len(want) * 4
                cmd = (f".iv -io off -ql sl -sa 0 -st sl -sb epc "
                       f"-so 0020 -sd {want} -sl {bits:02X} -ie on "
                       f"-qs s0 -qa fix -qv 0 -n\r\n")
            else:
                # Restore default all-tag inventory (no select, dynamic Q, S1).
                cmd = (".iv -io on -ql all -st s1 -sl 00 -so 0000 "
                       "-qs s1 -qa dyn -qv 4 -n\r\n")
            self._ser.write(cmd.encode())
            self._applied_finder = want
        except Exception:
            with self._lock:
                self._pending_finder = True

    def _apply_pending_alert(self):
        """Fire a one-shot handheld alert, then restore the default alert params
        so the read-success beep used by other modes is left intact."""
        with self._lock:
            want = self._pending_alert
            self._pending_alert = False
        if not want:
            return
        try:
            self._ser.write((config.ALERT_VIBRATE_CMD + "\r\n").encode())
            self._ser.write((config.ALERT_RESTORE_CMD + "\r\n").encode())
        except Exception:
            # Couldn't write; leave it pending for the next loop / reconnect.
            with self._lock:
                self._pending_alert = True

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
            if mode in (CHECKIN, CHECKOUT) and self._last_epc:
                prev = self._rssi_peak.get(self._last_epc)
                if prev is None or rssi > prev:
                    self._rssi_peak[self._last_epc] = rssi
            elif mode == FINDER and self._last_epc and self._last_epc == target:
                # Select-masked inventory returns only the target, so RI: lines
                # arrive frequently. Map the raw dBm to an absolute 0-100%
                # signal strength on a fixed scale (stable, unlike adaptive).
                lo, hi = config.FINDER_RSSI_MIN_DBM, config.FINDER_RSSI_MAX_DBM
                percent = round((rssi - lo) / (hi - lo) * 100)
                percent = max(0, min(100, percent))
                self._emit({"event": "finder", "epc": self._last_epc,
                            "rssi": rssi, "percent": percent})
        elif line.startswith("SW:"):
            # Asynchronous switch (trigger) state from `.sa -aon`: single/off.
            state = line[3:].strip().lower()
            if state == "off":
                self._last_epc = None
                with self._lock:
                    mode = self._mode
                # Releasing the trigger ends a finder pass; tell the UI to drop
                # its adaptive scale so the next aim starts from scratch.
                if mode == FINDER:
                    self._emit({"event": "finder_reset"})
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
            rssi_peak = dict(self._rssi_peak)
            self._counts.clear()
            self._distinct.clear()
            self._rssi_peak.clear()
        self._finalize(mode, payload, counts, distinct, rssi_peak)

    @staticmethod
    def _pick_epc(counts, rssi_peak):
        """Choose one EPC from a burst: strongest peak RSSI wins (read count
        breaks ties); fall back to the most-read EPC when no RSSI was captured."""
        if rssi_peak:
            return max(rssi_peak,
                       key=lambda e: (rssi_peak[e], counts.get(e, 0)))
        return counts.most_common(1)[0][0]

    def _finalize(self, mode, payload, counts, distinct, rssi_peak=None):
        if mode == IDLE or not distinct:
            return
        rssi_peak = rssi_peak or {}
        if mode == CHECKOUT:
            epc = self._pick_epc(counts, rssi_peak)
            self._emit({"event": "scan", "mode": CHECKOUT, "epc": epc,
                        "reads": counts[epc], "candidates": len(distinct),
                        "rssi": rssi_peak.get(epc)})
        elif mode == CHECKIN:
            # One tag per trigger pull: use the closest (strongest-RSSI) EPC.
            epc = self._pick_epc(counts, rssi_peak)
            with self._lock:
                item_fields = dict(self._checkin_item)
            event = {"event": "checkin_batch", "epcs": [epc], "distinct": 1,
                     "candidates": len(distinct), "item_fields": item_fields,
                     "rssi": rssi_peak.get(epc)}
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
