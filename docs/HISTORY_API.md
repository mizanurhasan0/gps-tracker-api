# GPS history API

GPS history is restricted to authenticated `ADMIN` sessions. Guardian sessions
receive 403 on all three endpoints, including for their assigned live vehicles.
Existing live-location, vehicle and transport endpoints remain available.

## Storage and ingestion

`DATABASE_URL` configures the shared PostgreSQL database used by every module.
Schema creation is versioned. Missing configuration or unavailable PostgreSQL
fails application startup; there is no SQLite/JSON fallback or local outbox.

Usable GPS reports and latest device state are committed to PostgreSQL before
TCP acknowledgements are sent. Failed persistence closes the connection without
acknowledging the failed report. Tracker firmware determines whether and when it
retries; server-side buffering cannot guarantee recovery during an outage.
History requests return 503 when PostgreSQL is unavailable. No automatic history
deletion is configured. Monitor PostgreSQL capacity and ingestion errors.

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

`freshness` retains the existing client response shape. With direct PostgreSQL
writes, `pendingPoints` is zero, `oldestPendingAt` is null and `complete` is true.
This describes committed server data, not uninterrupted tracker coverage or the
absence of later offline uploads. Snapshot IDs exclude later commits from a
response; history remains append-only.

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
npm run test:unit
TEST_DATABASE_URL=postgresql://test_user:test_password@127.0.0.1:55432/test_db npm test
```

Full tests require a disposable PostgreSQL database/user with schema permissions.
They create isolated schemas. Never point tests at the production database.
Database-free tests cover protocol parsing and history math; integration tests
exercise database persistence, role checks, route queries and transactions.
