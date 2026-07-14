# RFID Inventory — Cloud Sync API

Offline-first sync target for the RFID Inventory desktop app. Each device keeps a
local SQLite database and periodically **pushes** queued changes here and **pulls**
back anything newer. This cloud service is the source of truth.

- **Runtime:** FastAPI on Vercel Python Functions (serverless)
- **Database:** Postgres (Neon, via the Vercel Marketplace integration)
- **Entry point:** `api/index.py` (all routes rewritten to it via `vercel.json`)

## Data model

Two synced tables mirror the desktop app's local schema (`../db.py`):

- **`tags`** — canonical inventory, keyed by the globally-unique **EPC**. Conflict
  resolution is **last-write-wins** on `updated_at` (ISO-8601 strings sort correctly).
- **`events`** — append-only audit log, keyed by a client-generated **`event_uid`**
  so re-sending after a dropped connection is idempotent.

Plus a `devices` table that records each device's last sync.

## Authentication

Every request sends an `X-API-Key` header.

- Device endpoints validate the key against `SYNC_API_KEYS` (comma-separated list).
- The admin endpoint validates against `ADMIN_API_KEY`.

## Endpoints

| Method | Path                 | Auth   | Purpose                                   |
| ------ | -------------------- | ------ | ----------------------------------------- |
| GET    | `/`                  | none   | Liveness                                  |
| GET    | `/api/health`        | none   | Liveness + DB connectivity                |
| POST   | `/api/sync/push`     | device | Batch upsert `tags` + `events`            |
| GET    | `/api/sync/pull`     | device | Tags changed since a cursor               |
| GET    | `/api/tags`          | device | List tags (dashboard/debug)               |
| GET    | `/api/inventory`     | device | Aggregated counts by item_type + status   |
| POST   | `/api/admin/init-db` | admin  | Create/verify schema (run once after deploy) |

### `POST /api/sync/push`

```jsonc
{
  "device_id": "warehouse-laptop-01",
  "tags": [
    {
      "epc": "330DE29525C0210005F5F8F2",
      "item_type": "Pipe",
      "bol_number": "BOL-1234",
      "vendor": "Acme",
      "quantity": 1,
      "remaining": 1,
      "status": "In Warehouse",
      "received_at": "2026-07-14T10:00:00",
      "updated_at": "2026-07-14T10:05:00"   // drives last-write-wins
    }
  ],
  "events": [
    {
      "event_uid": "warehouse-laptop-01:8842",  // stable & unique per event
      "ts": "2026-07-14T10:05:00",
      "action": "receive",
      "epc": "330DE29525C0210005F5F8F2",
      "detail": "Scanned on dock"
    }
  ]
}
```

Response reports how many rows were actually written (a tag whose `updated_at` is
older than the stored row is intentionally skipped):

```json
{ "ok": true, "server_time": "...", "tags_received": 1, "tags_written": 1,
  "events_received": 1, "events_written": 1 }
```

### `GET /api/sync/pull?since=<iso>&limit=1000`

Returns tags with `updated_at > since`, oldest first, plus a `next_cursor` to pass
as `since` on the following pull.

## Client sync loop (for the desktop team)

1. Keep a local **outbox**: rows changed since the last successful push.
2. When online, `POST /api/sync/push` with those rows. On success, mark them synced.
   Retries are safe — tags upsert by EPC, events dedupe by `event_uid`.
3. `GET /api/sync/pull?since=<last_cursor>`; merge returned tags locally (server
   wins by `updated_at`). Persist the new `next_cursor`.

> **Note:** local `events` use an autoincrement rowid, which is *not* globally
> unique. When syncing, send `event_uid = "<device_id>:<rowid>"` (or a UUID).

## Local development

```bash
cd cloud
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
vercel env pull .env.local          # get POSTGRES_URL + keys from the linked project
export $(grep -v '^#' .env.local | xargs)
uvicorn api.index:app --reload
```

## Deploy & initialize

```bash
cd cloud
vercel link                         # link this dir to its own Vercel project
vercel integration add neon         # provision Postgres (auto-sets POSTGRES_URL)
vercel env add SYNC_API_KEYS        # comma-separated device keys
vercel env add ADMIN_API_KEY        # admin key for init-db
vercel --prod                       # deploy

# one-time schema creation
curl -X POST https://<deployment>/api/admin/init-db -H "X-API-Key: <admin key>"
```
