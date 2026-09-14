# GPS Tracker API + Noor Transport

All persistent application data uses one PostgreSQL database: accounts, sessions,
vehicles, transport, payments, latest GPS positions and admin-only route history.
See [history API](docs/HISTORY_API.md) and [Docker setup and migration](docs/HISTORY_DEPLOYMENT.md).
There is no runtime SQLite, JSON file store or local history queue.

NestJS server for GT06 protocol GPS trackers (CY03A, Concox and clones). It accepts
raw TCP connections from devices, keeps each device's latest position, exposes an
authenticated REST API, and pushes authorized live updates over Socket.IO.

The transport modules add guardian/admin accounts, routes/stops, approval-based
service subscriptions, manual bKash/Rocket payments, complaints, stop requests,
persistent in-app notifications and audit history. No payment gateway is used.
The Noor management module adds connected student/driver profiles, attendance,
maintenance, an income/expense/investment ledger, targeted notices, requests,
business settings, route schedules and monthly financial summaries. See
[management API](docs/MANAGEMENT_API.md) for contracts and migration details.
[Boarding and destination fares](docs/ROUTE_FARES.md) configure different monthly
charges for each student journey on the same route.

## Start the transport service

Requires **Node >=22.22.0** and PostgreSQL. Docker can run both services without
installing Node or PM2 on the host; see the deployment guide.

```sh
npm ci
cp .env.example .env
# Edit .env: set DATABASE_URL, ADMIN_PHONE and a unique ADMIN_PASSWORD (12+ characters).
# Start PostgreSQL first; DATABASE_URL is required.
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
| GET | `/routes` | Routes with ordered stops, flat monthlyAmount, and pair-specific fares |
| POST | `/admin/routes` | Admin: `{name,vehicleId,monthlyAmount,stops:string[]}` |
| PUT | `/admin/routes/:id/fares` | Admin: `{fares:[{boardingStopId,dropoffStopId,monthlyAmount}]}` |
| POST | `/requests/guardian/new` | Guardian: `{studentName,routeId,stopId,dropoffStopId?}`; destination required on routes with fares |
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
  retain duplicate-name protection within a guardian account. Student profile IDs
  are stable subscription IDs; admin profile editing supports route/stop changes.
- Each route has one assigned vehicle and ordered stops. One vehicle can serve
  multiple routes. Approval rechecks route/stop coverage and vehicle existence.
  Route pickup/drop schedules are editable; vehicle capacity is not modeled.
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
├── database/                PostgreSQL pool, schema migrations and transactions
├── gt06/                    Device protocol
│   ├── gt06.constants.ts    Framing bytes, CRC polynomial, bit masks
│   ├── gt06.crc.ts          CRC-16/X-25
│   ├── gt06.codec.ts        Pure framing + parsing functions
│   ├── gt06.connection.ts   Per-socket conversation (login, heartbeat, position)
│   └── gt06.server.ts       TCP listener
├── locations/               Device positions
│   ├── coordinates.ts       Validation and hemisphere normalization
│   ├── locations.service.ts PostgreSQL latest positions and history ingestion
│   └── locations.controller.ts
├── vehicles/                Vehicle registry (CRUD, validated)
├── realtime/                Socket.IO gateway
└── health/                  Liveness endpoint
```

The protocol layer is made of pure functions, so it is unit tested without
sockets or a Nest container.

## Configuration

Copy `.env.example` to `.env`. `DATABASE_URL` is mandatory: startup fails if it is
missing or PostgreSQL is unavailable. Schema migrations run automatically. Existing
SQLite/JSON files are never imported automatically.

| Variable | Default | Purpose |
|---|---|---|
| `REST_PORT` | `3000` | REST API port |
| `SOCKET_PORT` | `3001` | Socket.IO port |
| `TCP_HOST` / `TCP_PORT` | `0.0.0.0` / `5023` | GT06 device listener |
| `PUBLIC_HOST` | `127.0.0.1` | Address shown in logs and setup hints |
| `ALLOWED_IMEIS` | empty | Comma separated allowlist; empty accepts any device |
| `ONLINE_THRESHOLD_MS` | `180000` | Window for treating a device as online |
| `CORS_ORIGIN` | `*` | Allowed origin for REST and Socket.IO |
| `DATABASE_URL` | required | PostgreSQL connection URL for all persistent data |
| `GPS_TIMEZONE_OFFSET_MINUTES` | `0` | Tracker clock offset; independent of display timezone |

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
  -H 'Authorization: Bearer YOUR_ADMIN_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"name":"Van 01","plate":"DHK-METRO-11-1234","imei":"868720065798377"}'
```

### Health

`GET /health` → `{ status, database: "postgresql", uptimeSeconds, device: { host, port } }`.
Returns HTTP 503 if PostgreSQL cannot be queried.

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

For subsequent releases to the existing VPS, commit your changes and run
`npm run deploy`. This validates, pushes the commit, backs up the database and
deploys that exact API revision over SSH. See [push and VPS deployment](docs/DEPLOYMENT.md)
for connection settings, prerequisites and recovery.

```bash
npm ci
npm run start:dev     # watch mode
npm run build         # -> dist/main.js
npm run start:prod    # node dist/main
npm run test:unit     # build + database-independent tests
# Full suite requires a dedicated disposable TEST_DATABASE_URL:
TEST_DATABASE_URL=postgresql://test_user:password@localhost:5432/test_db npm test
npm run typecheck
```

## Storage and migration

One PostgreSQL database stores business data, latest positions and route history.
Foreign keys, unique constraints and transactions protect related changes. GPS
reports are persisted before acknowledgements are sent. An unavailable database
prevents acceptance of new reports; connection closure permits device retries,
whose actual behavior depends on tracker firmware. There is no local disk queue.
A single application instance is recommended because rate limiting and realtime
subscriptions are process-local.

Legacy SQLite and JSON migration is an explicit operator action using
`scripts/import-legacy.cjs`, not application startup. Stop the old writer and back
up its entire data directory, then follow the dry-run/apply instructions in the
[deployment guide](docs/HISTORY_DEPLOYMENT.md). Never manufacture historical
journeys from a latest-position snapshot.

Back up PostgreSQL using `pg_dump` and rehearse restoration. Keep original legacy
backups until migration is verified. No automatic history retention is enabled.

## Verification

`npm run test:unit` runs database-independent tests. `npm test` requires
`TEST_DATABASE_URL` pointing to a disposable PostgreSQL test database. Tests create
isolated schemas and exercise HTTP ownership/roles, payments and transaction
rollback, GPS persistence, history and protocol behavior. Never use production
credentials for tests. Tests also need permission to bind a localhost HTTP port.
