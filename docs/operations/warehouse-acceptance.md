# Warehouse Acceptance Checklist

Plan 010, Phase 6. One scheduled warehouse day, one real iPhone, the TSL/Vulcan
Indium sled, the Zebra ZD621R printer, real labels/tags, and a non-sensitive
BOL. A second phone is used for one physical conflict test if available;
otherwise the automated two-replica convergence gate (`scripts/turso/convergence-test.mjs`,
8/8) remains required.

Any **safety, data-loss, or hardware blocker is NO-GO** — stop and report.

## 1. Install / link / revoke

- [ ] Clean TestFlight install (fresh) and upgrade (over a prior build) both succeed.
- [ ] Entra production sign-in works (exact callback `https://<prod>/api/auth/callback/microsoft`).
- [ ] QR link → device registered; replaying the same one-time token is DENIED.
- [ ] Unlink → relink works; lost-device revoke (`scripts/ops/revoke-device.mjs`) → the phone reaches `re-link required` and stops retrying.

## 2. Hardware + workflows

- [ ] Sled connect / reconnect (Bluetooth) stable.
- [ ] Check-in / check-out / sweep / find-a-tag all work end to end.
- [ ] Printer status, print, encode, and read-back all work.
- [ ] BOL scan → on-device OCR → upload (Blob) → web link resolves.

## 3. Offline + sync + convergence

- [ ] Airplane-mode writes succeed locally; banner shows `offline / changes waiting`.
- [ ] Force-close + reopen while offline → local data intact; banner `pending`.
- [ ] Reconnect → automatic sync → banner `synced`; web converges to the phone's writes.
- [ ] Manual `Sync now` triggers an immediate cycle.
- [ ] If two phones: concurrently create DIFFERENT tags → both converge to the union.
- [ ] If two phones: one controlled SAME-record edit → second-pushed value wins (last-push-wins); no silent corruption beyond that.

## 4. Schema / upgrade guard

- [ ] Bump the warehouse schema (add a migration), deploy, and confirm an
      un-upgraded device's banner reaches `update required to sync` and its
      writes are held (not pushed).

## 5. Acceptance

- [ ] This checklist fully PASS.
- [ ] `main` commit == Production deploy SHA.
- [ ] Smoke workflow passes (a few labeled records → sync → web → fulfill → print → BOL).
- [ ] Sentry has no unresolved launch error.
- [ ] One normal warehouse shift completes successfully.

## Post-acceptance (Phase 7)

Only after two business days of clean operation: archive the Python reference
apps per the plan's final step. Do not touch them before this point.
