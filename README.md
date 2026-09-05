# GPS Tracker API + PathSathi Transport

Admin-only GPS route history now uses PostgreSQL, with a durable SQLite outbox
for database outages. See [history API](docs/HISTORY_API.md) for configuration,
daily/weekly/monthly queries, route limits and integration tests. Existing
transport and payment data remains in SQLite.

NestJS server for GT06 protocol GPS trackers (CY03A, Concox and clones). It accepts
raw TCP connections from devices, keeps each device's latest position, exposes an
authenticated REST API, and pushes authorized live updates over Socket.IO.

The transport modules add guardian/admin accounts, routes/stops, approval-based
service subscriptions, manual bKash/Rocket payments, complaints, stop requests,
persistent in-app notifications and audit history. No payment gateway is used.

## Start the transport service

Requires **Node 24 or newer** (uses `node:sqlite`).

```sh
npm ci
cp .env.example .env
# Edit .env: set ADMIN_PHONE and a unique ADMIN_PASSWORD (12+ characters).
npm run start:dev
```

`.env` is loaded automatically; already-exported environment variables take
precedence. The admin is bootstrapped only when no admin exists. Guardians can
self-register using a Bangladesh phone number and a password (8–128 characters).
Changing ADMIN_PASSWORD later does not reset an existing account's password.
No default admin credentials are shipped. Password reset/OTP is not implemented.

The mobile app's admin **Setup** screen configures receiving wallet numbers,
vehicles and routes. Admin **Bills** generates the chosen month's bills. A
subsequent guardian submission is **PENDING**; the bill stays **UNPAID** until
an admin verifies the external transfer and approves it.

**Breaking access change:** `/vehicles` and `/locations` now require a bearer
session. Vehicle mutations and setup/review endpoints require ADMIN. Existing
other clients (including any web tracker) must be adapted to sign in and pass a
bearer token, including `auth.token` for Socket.IO. Those projects were outside
this change's requested two-directory scope.

## Transport API

All endpoints below except registration/login require
`Authorization: Bearer <token>`. Unknown body fields are rejected.

| Method | Path | Access / purpose |
|---|---|---|
| POST | `/auth/register` | Public: `{name,phone,password}`; creates GUARDIAN only |
| POST | `/auth/login` | Public: `{phone,password}`; returns `{token,expiresAt,user}` |
| GET / POST | `/auth/me` / `/auth/logout` | Inspect / revoke current session |
| GET | `/routes` | Routes with stops and monthlyAmount |
| POST | `/admin/routes` | Admin: `{name,vehicleId,monthlyAmount,stops:string[]}` |
| POST | `/requests/guardian/new` | Guardian: `{studentName,routeId,stopId}` |
| GET | `/requests/mine`, `/admin/requests` | Own applications / admin queue |
| PATCH | `/admin/requests/:id/decision` | `{decision:"APPROVED"|"REJECTED",note?}` |
| POST | `/admin/requests/:id/call-notes` | `{note}`; records a manual call note |
| GET | `/subscriptions` | Own subscriptions, or all for admin |
| GET | `/payments/accounts` | Configured admin wallet numbers |
| PUT | `/admin/payment-accounts/:method` | BKASH/ROCKET: `{number,instructions}` |
| POST | `/admin/bills/generate` | `{month:"YYYY-MM"}`; idempotent; no future month |
| GET | `/payments/monthly?month=YYYY-MM` | Own bills, or all for admin; optional month |
| POST | `/payments/submissions` | Guardian proof details; example below |
| GET | `/payments/submissions` | Own history / admin payment review queue |
| PATCH | `/admin/payments/:id/decision` | Admin approve/reject; rejection needs note |
| GET / POST | `/complaints` | Own history / new `{subscriptionId,category,description}` |
| GET | `/complaint-categories` | Supported dropdown values |
| PATCH | `/admin/complaints/:id` | `{status:"OPEN"|"RESOLVED",note?}`; resolution needs note |
| GET / POST | `/stop-requests` | Own history / new `{subscriptionId,reason}` |
| PATCH | `/admin/stop-requests/:id/decision` | Admin approve/reject |
| GET | `/notifications` | Own newest 100 notifications |
| PATCH | `/notifications/:id/read` | Mark own notification read |

Example manual payment body (**amounts are integer poisha**, not taka):

```json
{
  "billId": "<bill UUID>",
  "method": "BKASH",
  "senderNumber": "01700000002",
  "recipientNumber": "01700000001",
  "transactionId": "ABC1234567",
  "amount": 150000
}
```

The receiving number must be a current or previously configured admin account.
This preserves the actual destination if settings change after a guardian sends
money. The exact bill amount is required. Transaction IDs are normalized and
unique within each payment method across pending/approved submissions. Rejected
proof stays in history and may be corrected and resubmitted. Only one pending
submission is allowed per bill. A paid bill cannot be paid again through this API.

Approval updates the submission, bill, audit record and guardian notification in
one database transaction. Competing decisions receive HTTP 409; failure to persist
any part rolls back the whole decision. No external SMS, calls or money transfers
are performed by the server.

## Service rules in this initial version

- One guardian may request multiple students. Each student name may have one
  pending application and one active service for that guardian. Student names
  identify services within a guardian account in this MVP; persistent student
  IDs and route-change workflows can be added when needed.
- Each route has one assigned vehicle and ordered stops. One vehicle can serve
  multiple routes. Approval rechecks route/stop coverage and vehicle existence.
  Vehicle capacity/time schedules are not modeled.
- Account approval is distinct from active subscription access. Only active
  assignments can view vehicle/location data. Complaints and stop submissions
  need an active approved service.
- Stop approval takes effect immediately. Existing bills/receipts remain visible.
- Bill generation is an explicit admin action. Fees are captured on subscription
  approval. A subscription is billed its full fee for months intersecting its
  active dates (Asia/Dhaka). No proration, refund or partial payment logic.
- Notifications are stored transactionally and fetched by the app every 20 seconds
  while foregrounded, on resume and pull-to-refresh. FCM background push is not
  configured.
- Sessions last seven days and are revocable. Passwords use salted scrypt;
  session tokens are random and stored hashed. Login/registration are rate-limited
  in memory. Deploy one application instance for this initial configuration.
- Run behind HTTPS and configure `CORS_ORIGIN` for browser clients. Production
  mobile origins proxy `/socket.io/` to port 3001 with WebSocket upgrade support;
  REST requests go to port 3000. Keep the raw tracker TCP port separate.


## Architecture

```
src/
├── config/app.config.ts     Typed, env-driven configuration
├── common/json-store.ts     Reusable JSON file persistence
├── gt06/                    Device protocol
│   ├── gt06.constants.ts    Framing bytes, CRC polynomial, bit masks
│   ├── gt06.crc.ts          CRC-16/X-25
│   ├── gt06.codec.ts        Pure framing + parsing functions
│   ├── gt06.connection.ts   Per-socket conversation (login, heartbeat, position)
│   └── gt06.server.ts       TCP listener
├── locations/               Device positions
│   ├── coordinates.ts       Validation and hemisphere normalization
│   ├── locations.service.ts In-memory store + JSON persistence
│   └── locations.controller.ts
├── vehicles/                Vehicle registry (CRUD, validated)
├── realtime/                Socket.IO gateway
└── health/                  Liveness endpoint
```

The protocol layer is made of pure functions, so it is unit tested without
sockets or a Nest container.

## Configuration

Copy `.env.example` to `.env`. Every value has a safe default, so the server also
runs with no `.env` at all.

| Variable | Default | Purpose |
|---|---|---|
| `REST_PORT` | `3000` | REST API port |
| `SOCKET_PORT` | `3001` | Socket.IO port |
| `TCP_HOST` / `TCP_PORT` | `0.0.0.0` / `5023` | GT06 device listener |
| `PUBLIC_HOST` | `127.0.0.1` | Address shown in logs and setup hints |
| `ALLOWED_IMEIS` | empty | Comma separated allowlist; empty accepts any device |
| `ONLINE_THRESHOLD_MS` | `180000` | Window for treating a device as online |
| `CORS_ORIGIN` | `*` | Allowed origin for REST and Socket.IO |
| `DATA_DIR` | `./data` | Where `devices.json` and `vehicles.json` are written |

## API

### Locations

`GET /locations` → `{ "devices": [DeviceLocation] }`
`GET /locations/:imei` → `DeviceLocation`, or `404` if the device never reported

```json
{
  "imei": "868720065798377",
  "status": "live",
  "online": true,
  "lastSeen": "2026-08-30T17:36:24.900Z",
  "gsmSignal": 3,
  "voltageLevel": 6,
  "hasFix": true,
  "latitude": 23.824333,
  "longitude": 90.36912,
  "speed": 0,
  "course": 0,
  "gpsTime": "2026-08-30 23:12:24",
  "positionAt": "2026-08-30T17:35:00.000Z"
}
```

`status` is computed by the server so clients do not have to derive it:

| Status | Meaning |
|---|---|
| `live` | Device online and reported a fix recently |
| `lastKnown` | Device online, but the stored fix is older than the threshold |
| `waiting` | Device online and has never reported a fix |
| `offline` | Nothing received within the threshold |

A report with invalid coordinates (including `0,0`) never overwrites a good fix;
it only refreshes `lastSeen`, so the last known position survives.

### Vehicles

| Method | Path | Body |
|---|---|---|
| `GET` | `/vehicles` | — |
| `GET` | `/vehicles/:id` | — |
| `POST` | `/vehicles` | `{ name, plate, imei, driverName?, driverPhone? }` |
| `PATCH` | `/vehicles/:id` | any subset of the above |
| `DELETE` | `/vehicles/:id` | — |

Bodies are validated; unknown fields are rejected and IMEIs must be unique.

```bash
curl -X POST http://localhost:3000/vehicles \
  -H 'Content-Type: application/json' \
  -d '{"name":"Van 01","plate":"DHK-METRO-11-1234","imei":"868720065798377"}'
```

### Health

`GET /health` → `{ status, uptimeSeconds, device: { host, port } }`

## Realtime

Socket.IO on `SOCKET_PORT` authenticates `auth: { token }` during the handshake.
It emits `location:update` with the same `DeviceLocation` payload only to authorized
clients. Session validity and active vehicle assignment are checked before every
delivery, so logout, expiration and stop approval also affect existing sockets.

## Device setup

Point the tracker at this server by SMS:

```
SERVER,0,<PUBLIC_HOST>,<TCP_PORT>,0#
```

The exact string is printed in the logs at startup.

## Commands

```bash
npm install
npm run start:dev     # watch mode
npm run build         # -> dist/main.js
npm run start:prod    # node dist/main
npm test              # build + HTTP payment/access integration + GPS unit tests
npm run typecheck
```

## Storage

Transport state and vehicles live in `DATA_DIR/transport.sqlite` using foreign
keys, unique indexes and explicit transactions (WAL mode). On first startup,
legacy `vehicles.json` is imported once, preserving IDs/IMEIs. Invalid legacy data
fails migration instead of silently discarding it. The source JSON is left intact.
GPS latest-position persistence remains in `devices.json`; the protocol behavior
is unchanged. High-frequency location history is not part of this MVP.

Before upgrading, stop the old process and back up DATA_DIR. For later backups,
stop the service and copy the full directory, including SQLite WAL/SHM files if
present, or use SQLite's online backup facility. Do not copy a live SQLite main
file alone. Test restoration before relying on a backup. Schema creation and the
legacy import are versioned in the `migrations` table. Use one server process;
a PostgreSQL migration and distributed rate limiting would be needed before
horizontal scaling.

## Verification

`npm test` builds production classes and exercises the real Nest HTTP controllers
against an isolated temporary SQLite database. Coverage includes guardian
ownership, role escalation prevention, route coverage, duplicate/concurrent
payments, rejected resubmission, notification failure rollback, stop revocation,
logout, and the existing GT06 parsing/coordinate regression suite. Tests require
permission to bind a temporary localhost HTTP port. No production data is used.
