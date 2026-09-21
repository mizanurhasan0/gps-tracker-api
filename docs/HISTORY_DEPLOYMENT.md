# Unified PostgreSQL setup and rollout

All runtime data uses one PostgreSQL database. Docker can run both backend and
PostgreSQL, so the VPS needs neither a new Node installation nor PM2 for this API.
Alternatively, run the backend on Node >=22.22.0 with Docker PostgreSQL only.
This is a runbook, not evidence of a VPS inspection or deployment.

## Check before installing anything

Run these read-only checks on the target host:

```sh
docker --version
docker compose version
docker ps -a
docker volume ls
ss -ltn
node --version
pm2 list
```

Only install missing tools for the chosen deployment mode. Inspect existing
containers, volumes and ports before provisioning. Do not delete an existing
PostgreSQL volume or stop another application's database. Full-stack Docker
needs Docker with Compose; host-run API additionally needs compatible Node/npm.
Node 24 is not required. Git is needed if downloading the release using Git.

## Prepare configuration

In a separate checkout of the candidate backend:

```sh
cp .env.example .env
chmod 600 .env
openssl rand -hex 32
openssl rand -hex 32
nano .env
```

Put the two different generated values into `POSTGRES_PASSWORD` (administrator)
and `APP_DB_PASSWORD` (application role). Hex passwords need no URL encoding.
Set `ADMIN_PHONE`, a unique `ADMIN_PASSWORD` of at least 12 characters,
`PUBLIC_HOST` and appropriate `CORS_ORIGIN`. Preserve tracker settings from the
old release. Do not commit this file or print resolved Compose configuration with
real credentials. Admin bootstrap runs only if there is no existing admin.

### Configure Telegram notifications

Telegram is optional and remains disabled with the example defaults. To enable it
on a production deployment, create a bot with BotFather and put the following in
the private VPS `.env`:

```dotenv
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=REPLACE_WITH_BOTFATHER_TOKEN
TELEGRAM_BOT_USERNAME=your_bot_username
TELEGRAM_POLL_TIMEOUT_SECONDS=50
TELEGRAM_GEOFENCE_RADIUS_METERS=100
TELEGRAM_GEOFENCE_TIME_WINDOW_MINUTES=15
```

The API uses long polling, so no public domain, HTTPS certificate, webhook URL or
webhook secret is needed. `TELEGRAM_BOT_USERNAME` is optional: when it is empty,
the API reads the bot username from Telegram when it creates a guardian connect
link. The API validates that the required bot token is set during startup. The geofence radius
is limited to 10–1000 metres and the time window to 1–1440 minutes.

After editing the private `.env`, deploy the API normally. Never include the bot
token or resolved Compose output in a commit or support log. At startup, the API
automatically removes a previous webhook for this bot before beginning to poll.
Telegram permits only one active `getUpdates` consumer per bot, so run one API
replica while this integration is enabled.

`compose.yml` constructs the API connection URL using `postgres` as its database
hostname. The `.env` `DATABASE_URL` is used only for host-run tools/API, where the
host is `127.0.0.1` and the password must match `APP_DB_PASSWORD`:

```dotenv
DATABASE_URL=postgresql://gps_tracker:YOUR_APP_PASSWORD@127.0.0.1:5432/gps_tracker
```

If `POSTGRES_PORT` changes, update the host URL too. The database port binds only
to localhost; do not publish port 5432 to the Internet.

## Full backend + PostgreSQL Docker setup

Build the candidate and start only its database first:

```sh
docker compose build api
docker compose up -d --wait postgres
docker compose ps
```

The backend image uses Node 22 and runs as the unprivileged `node` user.
PostgreSQL 16 uses a new project-scoped `postgres-data` volume. The initialization
script creates `gps_tracker` as a non-superuser and owner of only the application
database; the API does not use PostgreSQL administrator credentials. Initialization
scripts run only for an empty volume. Changing environment passwords later does
not rotate passwords in an existing database.

If migrating existing data, complete the next section before starting the API.
For a fresh installation, start it directly:

```sh
docker compose up -d --wait api
docker compose logs --tail=50 api
curl --fail http://127.0.0.1:3000/health
```

Stop the old API before binding its production ports. For a pre-cutover smoke
test, set alternate host `REST_PORT`, `SOCKET_PORT`, `TCP_PORT` values in `.env`.
Use the same Compose project directory for subsequent commands. Missing or
unreachable `DATABASE_URL` prevents startup; health checks also verify database
connectivity. Restart policies start the containers after a Docker/host restart.
Configure HTTPS for REST and Socket.IO before distributing the Android release.
Tracker TCP remains a separate port.

## Explicit legacy migration

The application does not read `DATA_DIR` or automatically import SQLite/JSON.
The one-time host-run importer requires Node >=22.22.0, `npm ci`, Python 3 with
its standard SQLite module, and access to the target PostgreSQL database.
Python opens the source SQLite database read-only. Keep this tooling outside the
minimal production API image.

1. Stop the old API so its data cannot change during the final migration.
2. Back up the entire legacy data directory, including any SQLite WAL/SHM files.
   Do not copy a live SQLite main file alone. Preserve code and old PM2 settings.
3. Set the ignored `.env` `DATABASE_URL` to the new database using localhost,
   and `LEGACY_DATA_DIR` to the absolute path of the stopped legacy backup.
4. Validate and apply explicitly:

```sh
npm ci
npm run build
node --env-file=.env scripts/import-legacy.cjs --dry-run
node --env-file=.env scripts/import-legacy.cjs --apply
```

Dry-run validates without writing source data. Inspect its report before applying.
The importer preserves legacy identifiers and imports supported business records,
latest positions and pending/history data under its validation rules. It must
not invent journeys from a single latest position. Keep any old PostgreSQL history
database available until its historical rows have been reconciled: the SQLite/JSON
importer is not a backup/restore tool for a separate old PostgreSQL database.

Start the new API only after migration verification. Check admin/guardian login,
vehicle assignments, bill/payment counts and history. Rehearse on a disposable
copy first. If data has changed in PostgreSQL after cutover, rolling back code to
SQLite requires reconciliation; simply restoring the old SQLite snapshot would
lose new business changes.

## Host-run API with Docker PostgreSQL only

Use `compose.history.yml` instead of the full-stack compose file:

```sh
docker compose -f compose.history.yml up -d --wait
npm ci
npm run typecheck
npm run test:unit
npm run build
npm run start:prod
```

Despite its historical filename, this database stores all application data.
It has a separate `gps-tracker-local` project/volume. Do not launch both compose
files on the same host port. Provide the mandatory localhost `DATABASE_URL` in
`.env`. For a VPS managed by PM2, run the built entrypoint with the existing
compatible Node interpreter and save/startup configuration after verification.

## Verification and ongoing updates

Database-independent tests:

```sh
npm run typecheck
npm run test:unit
```

Full suite (dedicated disposable PostgreSQL database with schema permissions):

```sh
TEST_DATABASE_URL=postgresql://test_user:password@127.0.0.1:55432/test_db npm test
```

Never point tests at production. Verify real tracker login, fixes, live Socket.IO,
admin daily/weekly/monthly queries and denied guardian history access. Restart
and confirm persisted state remains. Database failure means new reports cannot
be accepted; ACK follows successful persistence. Recovery of missing reports
depends on tracker firmware buffering/retry. There is no durable local queue.

For subsequent Docker releases, back up PostgreSQL, update the checkout, run
verification, then rebuild/start:

```sh
docker compose build api
docker compose up -d --wait api
curl --fail http://127.0.0.1:3000/health
```

## Backup and monitoring

```sh
mkdir -p backups
chmod 700 backups
umask 077
docker compose exec -T postgres pg_dump -U postgres -d gps_tracker -Fc > "backups/gps-tracker-$(date +%Y%m%d-%H%M%S).dump"
```

Keep backups off the VPS and rehearse restoration into an isolated database.
Monitor database capacity, health, failed ingestion, tracker connections and
query latency. No automatic history deletion is configured. Ordinary Compose
shutdown preserves the volume; `docker compose down -v` deletes it. Preserve all
old SQLite/JSON and PostgreSQL backups until migration and rollback are verified.
