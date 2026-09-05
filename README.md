# GPS Tracker API

NestJS server for GT06 protocol GPS trackers (CY03A, Concox and clones). It accepts
raw TCP connections from devices, keeps each device's latest position, exposes a
REST API, and pushes live updates over Socket.IO.

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

Socket.IO on `SOCKET_PORT` emits `location:update` with the same
`DeviceLocation` payload each time a device reports a valid fix.

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
npm test              # protocol + coordinate unit tests
npm run typecheck
```

## Storage

State lives in `DATA_DIR` as `devices.json` and `vehicles.json`. This is enough
for a handful of trackers; move to a database when the device count grows.
