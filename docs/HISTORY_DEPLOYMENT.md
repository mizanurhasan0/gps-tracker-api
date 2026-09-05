# GPS history setup and VPS rollout

The backend keeps accounts, vehicles and billing in SQLite. GPS history is
delivered to PostgreSQL through a durable SQLite outbox. Back up both stores.
This document is a runbook, not evidence that a deployment has been performed.

## Local database

Use Node 24 or newer. From the backend directory, set a local database password
without writing it into shell history:

```sh
read -rs POSTGRES_PASSWORD
export POSTGRES_PASSWORD
docker compose -f compose.history.yml up -d --wait
```

Put `DATABASE_URL=postgresql://gps_history:<URL-encoded-password>@127.0.0.1:5432/gps_history`
in the ignored application `.env`. Use `HISTORY_DB_PORT` to select a different
local port, and use that port in the URL. Do not print the resolved Compose
configuration with real credentials. Install dependencies with `npm ci`, then
run `npm run typecheck`, `npm test`, and `npm run start:prod`.

The Compose volume survives ordinary `docker compose down`. Do not use `down -v`
unless intentionally deleting this development database. Changing the password
environment variable does not change the password in an existing database.

The example image initializes a superuser for development. Production should
have a dedicated non-superuser application role with ownership of only its
history database/schema and migration objects. Keep the database bound to
localhost/private networking; use verified TLS for a remote database connection.

## Existing VPS prerequisites

Read-only checks on 2026-09-05 found:

- Deployed app: `/home/hasan/test-gps-tracker`, PM2 name `gps-tracker`.
- Node 22.22.3 is currently used by that PM2 process. The new backend needs Node 24.
- REST 3000, Socket.IO 3001, tracker TCP 5023.
- Legacy `devices.json` and `vehicles.json` data; no historical position archive.
- No `psql` command or port 5432 listener was observed. Recheck PostgreSQL and
  Docker containers before provisioning to avoid conflicting with another app.

Install Node 24 in an app-specific path and explicitly set this app's PM2
interpreter. Do not change the system Node binary used by other hosted apps.
Configure `DATABASE_URL`, preserve existing tracker settings, and provide an
initial admin bootstrap only if the new SQLite database has no admin.
The Android release client requires HTTPS: configure a valid domain/certificate
and reverse proxy for REST and Socket.IO before distributing a release build.
GPS devices continue to use the existing raw TCP port.

## Candidate release and cutover

1. Record PM2's script, interpreter, working directory and restart configuration.
   Preserve code, configuration and data in a timestamped protected backup. Do
   not copy a live SQLite main file alone; use SQLite online backup or stop
   writes and copy its complete state. Protect backups as application data.
2. Build a candidate release in a separate directory. Use copied/isolated data
   and alternate ports for validation. Check legacy vehicle import, admin login,
   existing application flows, migrations and PostgreSQL connectivity.
3. Run the full backend suite with a disposable PostgreSQL database. Integration
   tests must never point at the production database. Verify multiple fixes,
   query permissions, restart persistence, queue recovery and calendar boundaries.
4. Stop the old process briefly, take the final consistent local data backup,
   switch to the candidate using the preserved production data directory, and
   start PM2 with the explicit Node 24 interpreter. Keep the existing public
   tracker address and ports. Recheck device reconnection after cutover.
5. Check `/health`, admin authentication, all three history endpoints and live
   Socket.IO updates. Observe real tracker samples and confirm they survive a
   restart. Verify the Android admin map and a guardian's denied history request.
6. Save the verified PM2 configuration for reboot recovery. Record the history
   collection start time and application/database versions in the release record.

## Backups, monitoring and rollback

Use scheduled PostgreSQL logical backups (for example `pg_dump -Fc`) plus
consistent SQLite/outbox backups, and perform a restore rehearsal into an
isolated database. Store credentials via protected configuration or a password
file, not command-line arguments. Keep backups off the VPS as well as local.

Monitor outbox backlog and oldest pending sample, database connectivity, disk
space, insert/query latency and tracker connections. A delayed outbox means the
history view is incomplete even when the live tracker still works. No history
retention deletion is enabled by default; size a retention/archive policy from
observed device count and reporting interval.

Rollback switches code and PM2 settings back to the preserved release. Keep the
new PostgreSQL history and SQLite outbox intact; do not restore an old database
over newly accepted samples. An old release does not collect new history, so
document that interruption and reconcile pending samples on forward recovery.
If business data has changed after cutover, reconcile it before restoring an
older SQLite snapshot. Never fabricate pre-installation journeys from the
latest-position JSON.

## References

- [Official PostgreSQL Docker image](https://hub.docker.com/_/postgres)
- [Compose environment interpolation](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/)
