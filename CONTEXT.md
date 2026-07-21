# Domain glossary

Terms with a specific meaning in this codebase. Keep entries short; add terms
lazily, when a design conversation actually sharpens one.

## Intake

- **Shipment intake** — the one module (`intake.py`) where a box becomes
  inventory. Two paths, one recording rule: the handheld path (trigger pull
  picks an EPC) and the print path (mint EPCs, print/encode labels, record
  only what actually printed — a dead printer never creates phantom
  inventory). HTTP handlers and the reader event pump are thin adapters.
- **Armed shipment** — the item type + shipment-scope fields that scanned
  tags file under, set when the operator opens check-in (`intake.arm`).
  Lives in intake, not on the reader: the reader only reports which EPC it
  saw. Per-unit fields (SKU, mfc date) ride alongside and reset on re-arm.

## Sync

- **Exchange** — one `POST /sync/exchange` round trip: the exe pushes its
  snapshot/events/request-statuses, the cloud answers with an ack that
  advances watermarks and lists what it still wants (`sync.py`,
  `cloud/db.py apply_exchange`).
- **Snapshot** — full dump of the mirrored tables (tags, vendors, notes,
  bol_docs), sent only when its content hash differs from what the cloud
  last acked. Wholesale replace on the cloud; carries edits and deletes.
- **Events** — append-only audit rows, pushed incrementally above a
  watermark (row id, never wall clock). Unlike the snapshot, a dropped
  event column is lost permanently once acked.
- **Mirror** — the cloud's read-only copy of the exe's tables. The exe is
  the source of truth; nothing on the cloud edits mirror rows. Types are
  deliberately permissive (TEXT/INTEGER).
- **Sync contract** — the single definition of which tables and columns
  cross the exe→cloud seam (lives in `cloud/`, imported by both sides).
  Replaces the four hand-kept column lists (local schema, `SELECT *`
  export, `MIRROR_COLUMNS`, cloud schema patches). Skew between exe and
  cloud versions is handled leniently: the exchange never fails over a
  column mismatch, it warns.
- **Watermark** — last-acked row id stored in `sync_state` (exe) /
  `sync_meta` (cloud). Rewinding a watermark re-pushes the missing tail;
  retries are always safe because every apply step is idempotent.
