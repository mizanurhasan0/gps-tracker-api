# Data transfer and Google Drive backup

These features are available only to authenticated `ADMIN` accounts. The mobile
app exposes them under **More → Data and backup**.

## CSV and Excel transfer

The transfer API supports `vehicles`, `routes`, `stops`, and `drivers`. Export a
dataset first and use that file as the import template. CSV and XLSX headers must
match exactly. Import files are limited to 512 KiB and 2,000 data rows.
Each export is capped at 20,000 rows to keep API and mobile memory bounded.

Import runs in two steps. Preview validates every row and returns a one-time token
bound to the administrator for ten minutes. Confirm consumes that token and
upserts every row in one database transaction. A failed row rolls back the whole
import. Formulas are rejected, CSV formula markers are blocked, and exports
neutralize spreadsheet formula injection.

For related records, import in this order:

1. `vehicles`
2. `routes`
3. `stops`
4. `drivers`

Passwords, sessions, recovery records, notification delivery state, and GPS
history are not included in spreadsheet transfer. Use the encrypted PostgreSQL
backup for full disaster recovery.

## Backup configuration

Never commit real values. Configure these only in the private deployment `.env`:

```env
BACKUP_ENABLED=true
BACKUP_SCHEDULE_ENABLED=true
BACKUP_INTERVAL_HOURS=24
BACKUP_RETENTION_COUNT=30
BACKUP_MAX_MIB=512
BACKUP_TIMEOUT_MINUTES=20
BACKUP_PG_DUMP_PATH=pg_dump
BACKUP_ENCRYPTION_KEY=

BACKUP_SMTP_HOST=smtp.gmail.com
BACKUP_SMTP_PORT=465
BACKUP_SMTP_USER=
BACKUP_SMTP_PASSWORD=
BACKUP_SMTP_FROM=
BACKUP_EMAIL=

GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REFRESH_TOKEN=
GOOGLE_DRIVE_FOLDER_ID=
```

`BACKUP_ENCRYPTION_KEY` must be 32 random bytes encoded as 64 hexadecimal
characters. Generate it with `openssl rand -hex 32` and keep an offline copy
separate from Drive. Losing it makes every encrypted backup unrecoverable.

Use OAuth offline access for the Drive account and the narrow
`https://www.googleapis.com/auth/drive.file` scope. The refresh token must belong
to the account that owns or can write to `GOOGLE_DRIVE_FOLDER_ID`. Gmail SMTP uses
an App Password from `BACKUP_SMTP_USER`; remove spaces when copying it into `.env`.

Create a Google OAuth **Desktop app** client, then generate the missing refresh
token locally in a private terminal. The command prints a Google authorization URL
and briefly listens only on `127.0.0.1` for the callback:

Put the new client ID and secret in the private `.env`, leave backups disabled,
then run `npm run backup:authorize-drive`.

Authorize the intended Drive account, copy the resulting refresh token directly
to the server `.env`. Do not copy it into source files, chat, or deployment logs.

Leave `BACKUP_ENABLED=false` until every required value is present. When enabled,
invalid or missing settings intentionally stop API startup instead of silently
running without backups.

The runtime creates a PostgreSQL custom-format dump, encrypts it with AES-256-GCM,
uploads only the encrypted file, removes its private temporary directory, applies
count-based retention to files tagged by this application, and emails success or
failure. The mobile app never receives OAuth, SMTP, database, or encryption
credentials.

## Restore rehearsal

Download an encrypted `.dump.enc` file into a private machine, provide the same
encryption key, and decrypt into a new file:

```sh
npm run backup:decrypt -- backup.dump.enc restored.dump
pg_restore --list restored.dump
```

The decrypt helper reads `BACKUP_ENCRYPTION_KEY` from the private `.env` or the
process environment.

The helper refuses to overwrite a file and never runs `pg_restore`. Rehearse the
actual restore only into an isolated PostgreSQL database. Do not overwrite the
production database while the application is accepting writes.
