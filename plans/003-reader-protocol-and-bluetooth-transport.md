# Plan 003: Reader module — TSL ASCII 2.0 protocol engine + Bluetooth transport + simulator

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 79443fb..HEAD -- packages/reader-protocol apps/field apps/warehouse/reader.py apps/warehouse/config.py`
> If `apps/warehouse/reader.py` changed since this plan was written, compare
> the excerpts below against the live code; on a mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED (native Bluetooth code; but all logic is testable without it)
- **Depends on**: plans/001-scaffold-typescript-monorepo.md
- **Category**: migration
- **Planned at**: commit `79443fb`, 2026-07-22

## Why this matters

The Vulcan RFID Indium handheld (a rebadged TSL 1128) drives every scan in
the system with its physical trigger. Today it talks TSL ASCII 2.0 over USB
serial to `apps/warehouse/reader.py`. The Expo app needs the same behavior
over Bluetooth. The design splits it so hardware is never a development
blocker: **all protocol logic is pure TypeScript** in
`packages/reader-protocol` (line parsing, burst finalization, mode commands),
fully unit-tested; the field app adds a thin byte-stream transport — one
native iOS External Accessory module for the real sled, one simulated
transport for development and tests.

## Current state

`apps/warehouse/reader.py` is the complete, battle-tested protocol spec.
Facts to port exactly:

**Setup & event stream** (reader.py:1-32): the trigger runs `.iv` on the
reader itself — the app never issues `.iv` to start a scan. On connect, the
app sends `.sa -aon\r\n` (async switch notifications). The reader streams
lines: `EP:<epc>` (tag read), `RI:<rssi>` (signed dBm for the preceding EP),
`SW:single` / `SW:off` (trigger state), `OK:`/`ER:` (end of one `.iv` cycle).

**Burst model** (reader.py:9-14, 470-508): reads accumulate until no
EP:/OK: activity for `QUIET_GAP_SECONDS = 0.6` (config.py:41), then finalize:

- check-in/check-out (single modes): pick ONE EPC — strongest peak RSSI,
  read-count tiebreak; fall back to most-read when no RSSI (reader.py:485-492).
  Emit `{event:"scan", mode, epc, reads, candidates, rssi}`.
- inventory (sweep mode): every distinct EPC →
  `{event:"inventory", epcs: sorted, distinct}`.
- Also emit `{event:"live", mode, epc, distinct}` the first time each EPC
  appears in a burst (reader.py:415-420).

**Mode side-effects** (reader.py:190-216), applied via "set parameter, take
no action" commands (`-n` suffix), re-applied after every reconnect because
the reader resets on power-up (reader.py:241-253):

- Power: `.iv -o<nn> -n` — check-in/check-out use low power
  (`CHECK_POWER_DBM = 10`, adjustable 10–29), inventory/finder full power
  (29). (config.py:47-59, reader.py:288-304)
- RSSI on for checkin/checkout/finder, off otherwise: `.iv -r on|off -n`.
- Read-beep muted only in finder: `.iv -al on|off -n`.
- Alert (finder lock): fire `.al -boff -von -dlon`, then restore
  `.al -bon -dsho -von -n` (config.py:66-67).

**Finder** (reader.py:346-383): this firmware lacks `.ft`, so the finder
constrains the trigger `.iv` to one tag with a Gen2 Select mask:

```363:378:apps/warehouse/reader.py
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
```

Finder RI: lines for the target map to a fixed 0–100% scale:
`FINDER_RSSI_MIN_DBM = -80` → 0%, `FINDER_RSSI_MAX_DBM = -40` → 100%
(config.py:73-74, reader.py:432-440), emitting
`{event:"finder", epc, rssi, percent}`; `SW:off` in finder emits
`{event:"finder_reset"}` (reader.py:441-451).

RSSI parsing (reader.py:458-468): first token, try decimal then hex, else
ignore.

`inject_scan(epcs)` (reader.py:218-225): test hook that finalizes a synthetic
burst — this is what the "test without hardware" UI uses; keep an equivalent.

**Bluetooth**: the Indium pairs over Bluetooth in SPP mode (its default) and
appears to iOS apps through the External Accessory framework (it is MFi;
TSL's own apps connect this way). The EA protocol string is expected to be
`com.uk.tsl.rfid` — **verify at runtime** against
`EAAccessory.protocolStrings` and treat a mismatch as a STOP condition (log
the actual strings; they are the fix).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck | `pnpm --filter @rfid/reader-protocol typecheck && pnpm --filter @rfid/field typecheck` | exit 0 |
| Protocol tests | `pnpm --filter @rfid/reader-protocol test` | all pass |
| JS bundle check | `pnpm --filter @rfid/field exec expo export --platform ios` | exit 0 |

## Scope

**In scope**:
- `packages/reader-protocol/**` (replace plan-001 stub)
- `apps/field/modules/tsl-transport/**` (new Expo native module)
- `apps/field/src/reader/**` (transport interface, simulated transport, reader service)
- `apps/field/app.json` (EA protocol string + Bluetooth usage description)
- root `pnpm-lock.yaml`

**Out of scope**:
- `apps/warehouse/**` (reference only), `packages/domain/**`, `apps/web/**`
- No UI screens (plan 004+). No App Store/PPID work (plan 010 notes it).

## Git workflow

- Branch: `advisor/003-reader-module`
- Commit per step, short imperative messages (repo style).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Protocol engine (`packages/reader-protocol`)

Pure TS, no React Native imports. Files:

- `src/lines.ts` — split an incoming byte/string stream into `\r\n` lines
  (handle partial chunks); classify into
  `{kind:"ep",epc} | {kind:"ri",rssi} | {kind:"sw",state} | {kind:"ok"} | {kind:"er"} | {kind:"other",raw}`.
  Port RSSI parsing (decimal then hex) from reader.py:458-468. EPCs uppercase.
- `src/commands.ts` — builders returning exact command strings incl. `\r\n`:
  `switchNotifications()` → `.sa -aon\r\n`; `setPower(dbm)`;
  `setRssiOutput(on)`; `setBeep(on)`; `alertFire()` / `alertRestore()`;
  `finderMask(epc)` / `finderRestore()` (exact strings from the excerpt
  above); plus `POWER_MIN=10`, `POWER_MAX=29`, `CHECK_POWER_DEFAULT=10`,
  `INVENTORY_POWER=29`.
- `src/session.ts` — `ReaderSession`: the port of `ReaderWorker`'s state
  machine minus threads/serial. Constructor takes
  `{ send(cmd: string): void, emit(event: ReaderEvent): void, now?: () => number }`.
  API: `setMode(mode, {targetEpc?})`, `setCheckPower(dbm)`, `alert()`,
  `onConnected()` (re-apply all pending state + `.sa -aon`),
  `feed(chunk: string)` (line-split + handle), `tick()` (quiet-gap check;
  callers invoke it on an interval or after each feed), `injectScan(epcs)`.
  Modes: `idle|checkin|checkout|inventory|finder`. Reproduce: burst
  accumulation (counts, distinct, per-EPC peak RSSI), 0.6 s quiet gap,
  single-mode EPC pick, live events, finder percent mapping and reset,
  mode-change side-effect commands, dropping partial accumulation on mode
  change (reader.py:202-205).
- `src/events.ts` — the `ReaderEvent` union matching the Python events:
  `scan | inventory | live | finder | finder_reset | status`.

Export from `src/index.ts`.

**Verify**: `pnpm --filter @rfid/reader-protocol typecheck` → exit 0.

### Step 2: Protocol tests

Vitest suites driving `ReaderSession` with a fake `send` recorder, a captured
`emit` array, and a controllable `now`:

1. Feeding `EP:AAAA...\r\nRI:-52\r\nEP:BBBB...\r\nRI:-70\r\n` in checkin
   mode, then advancing time past 0.6 s and calling `tick()` → one `scan`
   event with the stronger-RSSI EPC, `candidates: 2`.
2. No RSSI captured → most-read EPC wins.
3. Inventory mode, duplicate EP lines → `inventory` event with sorted
   distinct EPCs; `live` emitted once per new EPC.
4. `setMode("finder", {targetEpc})` → `send` received the exact select-mask
   command string (byte-for-byte vs the excerpt, with the EPC's bit length in
   uppercase hex); leaving finder sends the exact restore string.
5. Finder RI mapping: −80 → 0, −40 → 100, −60 → 50; `SW:off` → `finder_reset`.
6. `onConnected()` after `setMode("checkout")` replays `.sa -aon`, power,
   RSSI-on, beep-on commands.
7. Partial line chunks across `feed()` calls parse correctly.
8. Mode change mid-burst discards accumulation (no stray finalize).

**Verify**: `pnpm --filter @rfid/reader-protocol test` → all pass.

### Step 3: Transport interface + simulated transport (field app)

`apps/field/src/reader/transport.ts`:

```ts
export interface ReaderTransport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(data: string): void;
  onData(cb: (chunk: string) => void): () => void;
  onConnectionChange(cb: (connected: boolean) => void): () => void;
}
```

`apps/field/src/reader/simulatedTransport.ts`: implements the interface in
pure TS; exposes `simulateTriggerPull(epcs: string[], rssi?: Record<string, number>)`
which emits realistic `EP:`/`RI:`/`OK:` line sequences through `onData`, and
`simulateTriggerRelease()` emitting `SW:off`. This is the dev/test rig every
later plan's "simulate scan" button uses.

`apps/field/src/reader/readerService.ts`: singleton wiring a chosen transport
to a `ReaderSession`; exposes `setMode`, `setCheckPower`, `alert`,
`injectScan`, a `subscribe(cb)` event bus, and `connected` state. Runs
`tick()` on a 150 ms interval while a mode is active. Transport selection:
simulated by default in dev, native when available (a settings toggle,
persisted with `AsyncStorage`, may wait for plan 004's settings screen — a
constant is fine here).

**Verify**: `pnpm --filter @rfid/field typecheck` → exit 0.

### Step 4: Native External Accessory module

Create a local Expo module: `npx create-expo-module@latest --local
tsl-transport` inside `apps/field` (generates `modules/tsl-transport/`).
Swift implementation (`TslTransportModule.swift`):

- Functions: `listAccessories(): [{name, protocolStrings}]`,
  `connect(protocolString: string)`, `disconnect()`, `send(data: string)`.
- Events to JS: `onData` (UTF-8 chunk), `onConnectionChange` (bool).
- Implementation: `EAAccessoryManager.shared().connectedAccessories`; open an
  `EASession` for the protocol string; read the `inputStream` on a stream
  delegate, forwarding bytes as they arrive; write `send` data to the
  `outputStream` (buffer if space unavailable). Re-emit
  `EAAccessoryDidConnect/Disconnect` notifications as `onConnectionChange`.
- JS wrapper `modules/tsl-transport/index.ts` adapts it to `ReaderTransport`
  with `DEFAULT_PROTOCOL = "com.uk.tsl.rfid"` (overridable), falling back to
  the first protocol string the accessory advertises, logging what it found.

In `apps/field/app.json` add:

```json
"ios": {
  "infoPlist": {
    "UISupportedExternalAccessoryProtocols": ["com.uk.tsl.rfid"]
  }
}
```

**Verify**: `pnpm --filter @rfid/field typecheck` → exit 0;
`pnpm --filter @rfid/field exec expo export --platform ios` → bundles clean
(native compilation is exercised later via `expo prebuild`/EAS in plan 010 —
do not attempt an Xcode build here unless the environment has Xcode, in which
case `npx expo prebuild -p ios && xcodebuild -workspace ... build` is a bonus
check, not a gate).

## Test plan

- Step 2's eight protocol suites are the substance; model structure on
  `packages/domain`'s tests (plan 002).
- The native module is deliberately too thin to unit test; its correctness is
  verified on hardware during plan 010's cutover checklist (pair sled →
  `listAccessories` shows it → trigger pull produces a `scan` event).
- Verification: `pnpm --filter @rfid/reader-protocol test` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm --filter @rfid/reader-protocol test` exits 0, including the exact
      finder-mask command-string assertion
- [ ] `pnpm -r typecheck` exits 0
- [ ] `grep -rn "react-native" packages/reader-protocol/src` → no matches
- [ ] `apps/field/modules/tsl-transport/` exists with Swift module + JS wrapper
- [ ] `grep -n "UISupportedExternalAccessoryProtocols" apps/field/app.json` → 1 match
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `create-expo-module --local` scaffolding fails or produces a structure the
  current Expo SDK doesn't autolink — report the SDK version and error.
- You find evidence the EA protocol string differs from `com.uk.tsl.rfid`
  (e.g. in TSL docs fetched during work) — record it; do not guess a third
  value.
- Reproducing the finder command string requires deviating from the excerpt
  (e.g. different flag order). The Python string is ground truth.
- The quiet-gap/burst semantics can't be reproduced with the `tick()` design —
  report rather than redesigning the event model.

## Maintenance notes

- `ReaderSession` is a line-for-line behavioral port of
  `apps/warehouse/reader.py`; when tuning (power, quiet gap, finder scale),
  change `packages/reader-protocol/src/commands.ts` constants — mirroring
  `config.py` — not call sites.
- The reviewer should diff every command string against `reader.py` — a one
  character difference silently degrades scanning.
- Deferred: barcode scanning via the sled's 2D imager (the Indium supports
  it; nothing in the current system uses it), and Android support in the
  native module.
