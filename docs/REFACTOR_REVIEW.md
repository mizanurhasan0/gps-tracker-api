# Backend cleanup and performance review

The refactor preserves public endpoint paths and response shapes, GPS persistence
before acknowledgement, serializable transactions, and historical migration SQL.
No runtime dependency or database migration was added.

## Changes

| Area | Change |
| --- | --- |
| Live tracking | Authenticate sessions and check assignments in batches of 250. At most two queries per batch replace up to two queries per viewer. |
| Vehicle/location lists | One shared permission lookup replaces one permission query per record. Input order and admin access are preserved. |
| Vehicle writes | Combine up to five detail updates into one parameterized update. Reuse transaction/error handling across create, update and delete. |
| Management saves | Retrieve the saved student, driver or maintenance record by ID instead of loading and filtering the entire list. |
| Overview | Schedule the independent student query alongside the other overview reads. |
| Routes | Group fares once instead of scanning all fares for every route. |
| Geofencing | Reuse the loaded pickup point, calculate the current shift time once per position, and skip settings queries when no assignment exists. |
| History calculations | Calculate each adjacent-point distance once and reuse the previous calendar date. Streaming and pagination remain intact. |
| Migrations | Use an ordered registry and a single applied-version lookup; preserve fresh-install versus legacy schedule defaults. |
| Shared logic | Add `common/collections.ts` and `common/dhaka-time.ts`; reuse date formatters instead of constructing them for each evaluation. |

## Removed duplication

- Remove `notifications/telegram-delivery.adapter.ts` and its competing provider
  registration. `TelegramService` implements the existing delivery port and now
  owns the current guardian/chat check as well as sending and error classification.
- Consolidate the identical Telegram job/row interfaces.
- Replace the obsolete SQLite-style `changes` result alias with PostgreSQL
  `rowCount` throughout the backend and test stubs.
- Remove the constant-returning history ingestion `freshness` method and the
  resulting query-service dependency on ingestion. Preserve the response metadata.
- Consolidate business date/month formatting and repeated vehicle write handlers.

Telegram delivery now uses the existing provider result classification: disabled
integration, disconnected recipients and permanent recipient failures are skipped;
temporary provider failures remain retryable. Live database failures suppress
updates while allowing a subsequent broadcast to retry authorization. Neither
path uses a persistent authorization cache.

## Validation

- TypeScript type checking and production build pass.
- Expanded database-free suite: 77 tests pass.
- Full suite on an isolated temporary PostgreSQL 16 database: 157 tests pass,
  with no skipped tests. This includes deployment scripts, legacy upgrades,
  transaction rollback/concurrency, payment ownership and realtime revocation.
- The 501-viewer regression case uses three authorization batches, demonstrating
  six authorization calls instead of up to 1,002 per-viewer calls.
- Correct the existing Telegram unique-chat test fixture to insert the original
  connection before expecting a duplicate connection to fail.

These are functional and query-count checks, not a production throughput benchmark.

## Retained components and scaling boundaries

Historical schema files, legacy import/export scripts, deployment scripts and both
Compose configurations have active callers or documented operational uses. Keep
them available for upgrades, recovery and local development.

The shared history write lock protects pagination snapshot ordering. Changing it
requires a replacement consistency design. The application still runs as one
replica because realtime subscriptions, rate limits and Telegram polling have
process-local behavior. History retention, private image object storage and
pagination for large management responses remain separate scaling decisions that
require retention requirements or client contract changes.
