# Switch Warehouse — cloud app

The lightweight, employee-facing half of the RFID inventory system
(`switch-warehouse.brasfieldgorrie.com`):

- **Read-only inventory view** mirrored from the warehouse manager's
  `RFIDInventory.exe` (the .exe stays the source of truth).
- **Material request form** — requests queue in Postgres and flow down to the
  .exe on its next sync.
- **`POST /sync/exchange`** — the private, token-authenticated endpoint the
  .exe calls. The cloud never calls into the warehouse PC.

Stack: FastAPI + Jinja2 on Azure App Service (Linux/Python), with Azure
Database for PostgreSQL Flexible Server.

## Run locally (no Azure needed)

```bash
# 1. Postgres in Docker
docker run -d --name warehouse-pg -p 5433:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=warehouse postgres:16

# 2. Cloud app (from this cloud/ directory)
pip install -r requirements.txt
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/warehouse \
SYNC_TOKEN=dev-token \
python -m uvicorn app:app --port 8100
```

Then point the .exe at it — in `settings.ini` next to the exe (or the repo
when running from source):

```ini
cloud_url = http://127.0.0.1:8100
sync_token = dev-token
```

Open http://127.0.0.1:8100 — inventory appears after the .exe's first sync
(within ~30 s of it starting). Submit a request on the site and watch it show
up in the .exe's Requests panel on the next sync.

An automated end-to-end check of the whole loop lives at `test_sync.py`:

```bash
python test_sync.py     # needs the Docker Postgres above; starts its own app
```

## Deploy to Azure

One-time provisioning (adjust names/region/subscription to fit; smallest
tiers are plenty for this workload):

```bash
RG=rg-switch-warehouse
LOC=eastus2
PG=switch-warehouse-pg
APP=switch-warehouse
PLAN=switch-warehouse-plan
PGPASS='<generate a strong password>'
TOKEN=$(openssl rand -hex 32)          # the sync token; also goes in settings.ini

az group create -n $RG -l $LOC

# Postgres Flexible Server (smallest burstable tier)
az postgres flexible-server create -g $RG -n $PG -l $LOC \
  --tier Burstable --sku-name Standard_B1ms --storage-size 32 \
  --version 16 --admin-user warehouse --admin-password "$PGPASS" \
  --database-name warehouse --public-access 0.0.0.0
# --public-access 0.0.0.0 allows Azure services (the App Service) through the
# firewall while blocking the public internet.

# App Service (Linux, Python)
az appservice plan create -g $RG -n $PLAN --is-linux --sku B1
az webapp create -g $RG -n $APP --plan $PLAN --runtime "PYTHON:3.12"

az webapp config appsettings set -g $RG -n $APP --settings \
  DATABASE_URL="postgresql://warehouse:$PGPASS@$PG.postgres.database.azure.com:5432/warehouse?sslmode=require" \
  SYNC_TOKEN="$TOKEN" \
  SCM_DO_BUILD_DURING_DEPLOYMENT=true

az webapp config set -g $RG -n $APP \
  --startup-file "python -m uvicorn app:app --host 0.0.0.0 --port 8000"
```

Deploy the code (from this `cloud/` directory — the zip must contain
`app.py` at its root):

```bash
zip -r deploy.zip app.py db.py requirements.txt templates static
az webapp deploy -g $RG -n $APP --src-path deploy.zip --type zip
```

Check `https://<app>.azurewebsites.net/healthz` → `{"ok": true, "db": "up"}`.
The site is fully functional on the default `azurewebsites.net` URL; the
custom domain and SSO below can land later.

### Custom domain + TLS

Ask IT for a DNS CNAME `switch-warehouse.brasfieldgorrie.com` → 
`<app>.azurewebsites.net`, then:

```bash
az webapp config hostname add -g $RG --webapp-name $APP \
  --hostname switch-warehouse.brasfieldgorrie.com
az webapp config ssl create -g $RG -n $APP \
  --hostname switch-warehouse.brasfieldgorrie.com   # free managed cert
```

### Employee sign-in (Easy Auth / Entra ID) — with /sync excluded

Enable App Service Authentication with Microsoft Entra ID — easiest from the
portal: the app → Authentication → Add identity provider → Microsoft →
"Require authentication" for unauthenticated requests. (The portal creates
the app registration and secret settings for you.)

The .exe authenticates with the bearer token, not SSO, so `/sync/exchange`
(and `/healthz`) must bypass Easy Auth. Easy Auth v2 supports excluded paths
(needs the `authV2` CLI extension; pass each path as its own argument —
older extension versions mangle the single-string form):

```bash
az extension add --name authV2
az webapp auth update -g $RG -n $APP \
  --excluded-paths "/sync/exchange" "/healthz"
```

Verify afterwards: an unauthenticated `curl https://<host>/healthz` must
return JSON (not a login redirect), and the site root must redirect to the
Microsoft sign-in page.

Finally, confirm outbound HTTPS from the warehouse PC to the domain (the only
network path the system needs), and set the production values in the exe's
`settings.ini`:

```ini
cloud_url = https://switch-warehouse.brasfieldgorrie.com
sync_token = <the $TOKEN generated above>
```

## How the sync stays consistent

- The .exe pushes a **full snapshot** of `tags` / `vendors` / `notes` /
  `bol_docs` whenever their content hash changes (small tables; snapshot
  replace carries edits and deletes), and **events** incrementally above an
  id watermark. BOL PDF files stay local in v1 (metadata only).
- The cloud owns **requests**; the .exe pulls new rows above its own
  watermark and pushes back fulfilled/declined statuses (with a note).
- Every exchange step is idempotent, and all watermarks are row ids — a
  dropped response or retried call can duplicate work but never data. If this
  database is ever wiped, the ack tells the .exe to rewind and re-push
  everything on its own.
