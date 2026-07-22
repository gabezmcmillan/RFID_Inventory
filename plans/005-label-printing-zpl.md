# Plan 005: Label printing — ZPL builder, TCP transport, print-path intake

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 79443fb..HEAD -- apps/warehouse/printer.py apps/warehouse/intake.py packages/domain apps/field`
> If `apps/warehouse/printer.py` or `intake.py` changed since `79443fb`,
> compare the excerpts below against the live code; on a mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (a wrong ZPL string wastes RFID media; mitigated by exact-string tests)
- **Depends on**: plans/004-field-app-foundation-and-checkin.md
- **Category**: migration
- **Planned at**: commit `79443fb`, 2026-07-22

## Why this matters

The second intake path: instead of tagging boxes with factory-encoded labels,
check-in can mint EPCs, print a 4×6 label per box on the Zebra ZD621R, and
burn the EPC into the label's RFID inlay in the same pass. The cardinal rule
(from `apps/warehouse/intake.py:17-22`): **record only what actually
printed — a dead printer never creates phantom inventory.** The phone reaches
the printer over the warehouse LAN (raw ZPL, TCP 9100), which the Python app
already supports; the Windows-spooler USB path is retired with the PC.

## Current state

`apps/warehouse/printer.py` is the spec. Load-bearing facts:

- The full label template is `LABEL_ZPL` (printer.py:50-70). It must be
  reproduced **byte-for-byte** (field positions were iterated against the
  Labelary renderer and verified on the physical printer). The RFID write is
  the `^RFW,H^FD{epc}^FS` line; the QR block `QR_ZPL`
  (printer.py:76: `^FO950,1150^BQN,2,6^FDQA,{url}^FS\n`) is included only
  when a cloud URL exists.
- Description auto-sizing (printer.py:83-114): tiers `(66,2) (50,3) (40,4)`,
  block width 740 dots, average glyph advance `0.55 × font height`; greedy
  word-wrap estimate; if even the smallest tier overflows, trim with a
  trailing `"..."`. Named types print `"TYPE | component name"`
  (intake.py:103-105).
- Field sanitization (printer.py:121-123): strip `^`, `~`, and control chars
  from every field value.
- EPC validation (printer.py:46, 201-203): exactly 24 uppercase hex chars or
  raise.
- Two settings deliberately NOT in the ZPL (printer.py:17-24): no `^LL`
  (media calibration governs length) and no `^RS` (RFID calibration lives in
  the printer). Do not add them.
- Status check (printer.py:286-321): send `~HS`, read until three
  `STX…ETX` strings; s1[1]=media out, s1[2]=paused, s2[1]=printhead open;
  unparseable-but-answering counts as alive.
- Print-path intake (`apps/warehouse/intake.py:87-140`): clamp count to
  `[1, 25]`; mint EPCs via `allocateEpcs`; print sequentially, stop at first
  failure; if nothing printed → error; else record the printed EPCs via the
  normal receive path and append
  `" Printing stopped after N of M labels: <err>"` when partial. Received
  date format `MM/DD/YYYY`, time `H:MM AM/PM` without leading zero
  (intake.py:124-125). QR URL is `{cloud_base}/tag/{epc}` (intake.py:126).

Printer host/port are per-machine settings (`config.py:141-143`; port
effectively always 9100).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck | `pnpm -r typecheck` | exit 0 |
| Domain tests | `pnpm --filter @rfid/domain test` | all pass |
| Bundle check | `pnpm --filter @rfid/field exec expo export --platform ios` | exit 0 |

## Scope

**In scope**:
- `packages/domain/src/label/**` (ZPL builder — pure TS, Node-tested)
- `packages/domain/src/intakeSession.ts` (add the print path)
- `apps/field/src/printer/**` (TCP transport + status)
- Check-in screen: "Print & encode labels" flow; settings screen: printer host
- root `pnpm-lock.yaml`

**Out of scope**:
- The Windows print-queue transport (`printer.py:160-187`) — retired.
- Any change to label geometry or content.
- `apps/warehouse/**` — reference only.

## Git workflow

- Branch: `advisor/005-label-printing`
- Commit per step, short imperative messages (repo style).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: ZPL builder in the domain package

`packages/domain/src/label/zpl.ts`:

- `buildLabelZpl(params): string` — port `print_label` + `LABEL_ZPL` +
  `QR_ZPL` + `_desc_layout` + `_zpl_safe` exactly. Same params:
  `epc, building, sector, description, supplier, sku, quantity, poNumber,
  receivedDate, receivedTime, qrUrl`.
- `EPC_HEX` validation: throw `PrintError` on non-24-hex.
- Export `descLayout(text)` for direct testing.

Vitest suite `zpl.test.ts`:
1. Golden test: build a label with known values and compare the **entire
   output string** to a fixture captured from the Python implementation —
   generate the fixture by running
   `python3 -c "import sys; sys.path.insert(0,'apps/warehouse'); import printer; print(printer.LABEL_ZPL.format(epc='42473031000000000000000A', qr=printer.QR_ZPL.format(url='https://x/tag/42473031000000000000000A'), building='6', sector='B', description='TSC', desc_font=66, desc_lines=2, supplier='ACME', sku='4000-222-01', quantity='10', po_number='PO9', received_date='07/22/2026', received_time='3:05 PM'))"`
   from the repo root and saving stdout to
   `packages/domain/src/label/__fixtures__/label-basic.zpl`.
2. Long W.I.F. description steps the font down (assert `^A0N,50,50` and
   3-line `^FB` appear for a description that wraps to 3 lines at font 50).
3. Hostile input `desc ^XZ ~JA` is sanitized (no `^`/`~` in the field data).
4. Bad EPC (23 chars / non-hex) throws.
5. No `qrUrl` → no `^BQN` in output; no `^LL` and no `^RS` in any output.

**Verify**: `pnpm --filter @rfid/domain test` → all pass.

### Step 2: TCP transport + status in the field app

Add `react-native-tcp-socket`. Create `apps/field/src/printer/printerClient.ts`:

- `sendZpl(host, port, zpl): Promise<void>` — connect (5 s timeout), write,
  close; reject with an operator-safe message
  (`"Printer unreachable at <host>:<port> (<err>)"`, printer.py:154-157).
- `printerStatus(host, port): Promise<{ok, message}>` — port `_status_tcp`
  (printer.py:286-321): send `~HS`, collect until three `\x03`s or timeout,
  parse media-out/paused/printhead-open, unparseable-but-answered → ok.
- Settings screen: `printer_host` text field (empty = printing disabled,
  mirroring `printer.enabled()`, printer.py:117-118), a "Test printer"
  button showing `printerStatus`, and `cloud_base_url` (used for QR URLs;
  empty = no QR — full sync config comes in plan 010).

**Verify**: `pnpm -r typecheck` → exit 0; `expo export` → exit 0.

### Step 3: Print-path intake

Extend `packages/domain/src/intakeSession.ts` with
`checkInPrinted(db, deps, itemType, fields, itemFields, count)` where
`deps = { printLabel(zpl: string): Promise<void>, cloudBaseUrl: string }`
(the field app injects `printLabel = zpl => sendZpl(host, 9100, zpl)`).
Port `intake.py:87-140` exactly:

- count clamped to `[1, 25]` (`MAX_LABELS_PER_PRINT`, intake.py:44);
- description `"TYPE | item_name"` for named types;
- `allocateEpcs(count)` then print sequentially; stop at first rejection;
- record **only** printed EPCs via the same `receiveShipment` call as the
  scan path; return `{ok:false, message:"Label not printed: <err>"}` when
  none printed; append the partial-print suffix when some printed.

Vitest: fake `printLabel` that succeeds twice then throws → exactly 2 tags
recorded, message contains `"Printing stopped after 2 of 3 labels:"`;
all-fail → zero tags and no `IN` events (assert events table).

UI: on the check-in scanning phase add "Print & encode N labels" (count
stepper, hidden when no printer host configured), calling `checkInPrinted`
and appending result cards like scanned check-ins.

**Verify**: `pnpm --filter @rfid/domain test` → all pass;
`pnpm -r typecheck` → exit 0.

## Test plan

- Step 1's five ZPL cases (golden fixture is the critical one) and step 3's
  two phantom-inventory cases. Model structure on plan 002's repo tests.
- Hardware validation (real printer prints + encodes, VOID-retry behavior)
  belongs to plan 010's cutover checklist, not this plan.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm --filter @rfid/domain test` exits 0, incl. golden-fixture ZPL test
- [ ] `pnpm -r typecheck` exits 0
- [ ] `grep -n "\^LL\|\^RS" packages/domain/src/label/zpl.ts` → no matches
- [ ] `grep -rn "win32print\|printer_queue" apps/field packages/domain` → no matches
- [ ] `pnpm --filter @rfid/field exec expo export --platform ios` exits 0
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The Python fixture-generation one-liner fails (no python3, import error) —
  report; do not hand-write the fixture from the excerpt.
- `react-native-tcp-socket` is incompatible with the current Expo SDK/new
  architecture — report the error and the package version.
- Reproducing `_desc_layout`'s wrap estimate diverges from Python's
  `textwrap.wrap` on a test case — report the case; the tier choice must
  match Python, not "close enough".

## Maintenance notes

- Label layout changes must be validated against the Labelary renderer and a
  physical printer before shipping; the golden fixture then gets regenerated
  deliberately — a reviewer should treat any fixture diff as a physical-media
  change, not a refactor.
- If labels start voiding: that's printer-side RFID calibration
  (printer.py:17-24 comment), not app code.
- Deferred: printer discovery (mDNS); the host stays a manually entered IP,
  same as `settings.ini` today.
