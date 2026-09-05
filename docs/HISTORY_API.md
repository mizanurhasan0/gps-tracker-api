# GPS history API

GPS history is restricted to authenticated `ADMIN` sessions. Guardian sessions
receive 403 on all three endpoints, including for their assigned live vehicles.
Existing live-location, vehicle and transport endpoints remain available.

## Storage and ingestion

`DATABASE_URL` configures a pooled PostgreSQL history database. Versioned schema
creation runs automatically under a PostgreSQL advisory lock. Business data
(users, sessions, vehicles, payments and transport) stays in SQLite.

Every usable coordinate report is synchronously committed to a SQLite outbox
with `synchronous=FULL` before the TCP handler sends its ACK. Batches retry every
second and insert into PostgreSQL idempotently. No fire-and-forget database
writes run in the TCP handler. If local persistence fails, the connection closes
without acknowledging the failed report, allowing device retry. Retry behavior
still depends on the physical device. Never delete `transport.sqlite` during an
upgrade: it contains accepted history that may not yet have reached PostgreSQL.

PostgreSQL failure preserves live tracking and the durable queue. History queries
return 503 when PostgreSQL cannot be read. Successful queries expose pending
history through `freshness`. Shutdown waits for the active batch; remaining
queued records survive restart. No automatic history deletion is configured.
Monitor queue depth and disk space, especially during a prolonged database outage.

History uses binary GT06 date bytes, the GPS-fix flag, and correct hemisphere
bits. `GPS_TIMEZONE_OFFSET_MINUTES=0` assumes device UTC; verify it against a real
fix before production cutover. This setting does not affect the `Asia/Dhaka`
calendar used by the admin UI. Invalid device dates, future dates beyond five
minutes and explicit invalid fixes are preserved as diagnostics but excluded
from route queries. Out-of-range coordinates and `(0,0)` are discarded. A late
valid fix is stored without replacing a newer live position. Vehicle identity
is captured at ingestion; vehicle reassignment does not relabel historical rows.
Existing latest-position JSON is not imported as invented historical travel.

## Common request and response

All endpoints accept a numeric IMEI (10–20 digits), `from` and `to` as ISO
timestamps with explicit offsets, and optional `timezone=Asia/Dhaka`.
Ranges are half-open `[from,to)` and at most 31 days. A Bangladesh calendar day
starts at 18:00 UTC on the preceding date. Weeks start Monday in the client.

Each response includes:

```json
{
  "imei": "868720065798377",
  "from": "2026-09-04T18:00:00.000Z",
  "to": "2026-09-05T18:00:00.000Z",
  "timezone": "Asia/Dhaka",
  "snapshot": "12345",
  "freshness": {
    "pendingPoints": 0,
    "oldestPendingAt": null,
    "complete": true
  }
}
```

Freshness is captured conservatively before the PostgreSQL snapshot. `complete`
means no known valid queued points in this range at that check; it does not claim
the device reported continuously or that no later/offline uploads will arrive.
Snapshot IDs exclude later commits from a response. History is append-only and
all application writers serialize ID allocation/commit with an advisory lock.

Point shape:

```json
{
  "id": "12345",
  "imei": "868720065798377",
  "vehicleId": "vehicle-uuid-or-null",
  "latitude": 23.8103,
  "longitude": 90.4125,
  "speed": 12,
  "course": 90,
  "gpsTime": "2026-09-05T06:00:00.000Z",
  "receivedAt": "2026-09-05T06:00:01.000Z"
}
```

`vehicleId` is JSON null when no vehicle was assigned. Speed is km/h; course is
degrees. IDs are strings, including PostgreSQL bigint IDs.

## Raw points

`GET /locations/:imei/history?from=...&to=...&limit=1000&cursor=...`

Adds `points: HistoryPoint[]` and `nextCursor: string | null`. Limit is 1–2000
(default 1000). Points sort by `(gpsTime,id)`. Continue with the opaque cursor and
the same IMEI/range to retain the original snapshot. Start again without a cursor
to see later arrivals. Invalid or cross-device/range cursors return 400.

## Daily summary

`GET /locations/:imei/history/summary?from=...&to=...`

Adds `days: [{date,pointCount,distanceMeters,firstAt,lastAt,gapCount}]`. Dates are
`YYYY-MM-DD` in Dhaka and empty days are included with zero counts/distance and
null first/last times. Full-resolution points are processed in bounded pages;
a dense month is not truncated. Cross-midnight edges are excluded from daily
distance rather than assigned to either day.

## Segmented route

`GET /locations/:imei/history/route?from=...&to=...&maxPoints=2000`

Adds `segments: [{points: HistoryPoint[]}]`, `pointCount`, `displayedPointCount`,
`simplified`, `distanceMeters` and `gapCount`. `maxPoints` is 2–2000.
Reporting intervals over ten minutes, impossible jumps above 200 km/h, and
different coordinates at identical timestamps start new segments. Never draw a
line between separate segments. Stationary reports remain valid points.

Geometry samples the entire snapshot with a stable uniform interval and retains
every segment endpoint; it is reduced once to the requested display budget.
Distance is calculated from all accepted full-resolution segment edges, not
from display geometry. It is an estimate, without road snapping. Route distance
may differ from summed daily distance because the route can include valid
cross-midnight edges. If disconnected segment endpoints exceed the requested
budget, return 413 with a shorter-range instruction instead of silently dropping
segments. Daily summaries remain available for selecting a smaller interval.

## Verification

```sh
npm run typecheck
npm test
HISTORY_TEST_DATABASE_URL=postgresql://test_user:test_password@127.0.0.1:55432/test_db npm test
```

The PostgreSQL test creates and drops its own random schema, so use a dedicated
test database/user with schema permissions. Without the test URL, that integration
suite is explicitly skipped; codec, history math and existing HTTP tests still run.
Coverage includes real PostgreSQL storage, admin/guardian access, retransmission
deduplication, late points, cursor snapshots, outage queue/restart recovery,
vehicle reassignment, and a 267,840-point calendar month.
