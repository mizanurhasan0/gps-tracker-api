# Boarding and destination fares

Each route keeps its ordered stops and its legacy flat `monthlyAmount`. An admin
can now set different monthly fares for particular boarding/destination pairs.
All API amounts are integer **poisha**: Tk 1,000 is `100000`, and Tk 1,500 is
`150000`. The mobile app accepts and displays taka.

For example, create the route **Uttara → Mirpur** with stops **Uttara**, **Khilkhet**,
**Mirpur**, then configure Uttara → Khilkhet for Tk 1,000 and Uttara → Mirpur for
Tk 1,500. Each student's selected journey determines their monthly subscription
fee, which bill generation uses independently for that student.

## Route fare configuration

`GET /routes` returns existing route fields plus `fares`:

```json
{
  "id": "<route UUID>",
  "name": "Uttara → Mirpur",
  "vehicleId": "<vehicle UUID>",
  "monthlyAmount": 150000,
  "stops": [
    { "id": "<uttara UUID>", "name": "Uttara" },
    { "id": "<khilkhet UUID>", "name": "Khilkhet" },
    { "id": "<mirpur UUID>", "name": "Mirpur" }
  ],
  "fares": [
    { "boardingStopId": "<uttara UUID>", "dropoffStopId": "<khilkhet UUID>", "monthlyAmount": 100000 },
    { "boardingStopId": "<uttara UUID>", "dropoffStopId": "<mirpur UUID>", "monthlyAmount": 150000 }
  ]
}
```

`PUT /admin/routes/:id/fares` accepts `{ "fares": [...] }` using the same fare
objects and returns the updated route. ADMIN authorization is required. This is
an atomic replacement of that route's fare table; an empty array clears it.
Invalid entries leave the entire previous configuration unchanged. Both stops
must belong to the route and must be different. Duplicate pairs are rejected.
Amounts must be integers from 1 through 100000000 poisha. At most 2450 entries
are accepted (all distinct directional pairs across the existing 50-stop limit).

Pairs are directional: a fare for Uttara → Mirpur does not automatically create
Mirpur → Uttara. Either direction may be configured, regardless of stop order.
No distance calculation, summing of intermediate fares, or fallback to the flat
fee is applied when a destination is supplied.

## Student journey assignment

`POST /requests/guardian/new`, `POST /admin/students`, and
`PATCH /admin/students/:id` accept `dropoffStopId`. The existing `stopId` remains
the boarding stop. For example:

```json
{
  "studentName": "Ayesha",
  "routeId": "<route UUID>",
  "stopId": "<uttara UUID>",
  "dropoffStopId": "<khilkhet UUID>"
}
```

Guardian requests require a destination whenever the route has configured fares.
A guardian cannot omit the destination to obtain the legacy flat fee. Requests
return a `monthlyAmount` quote calculated by the server. Approval rechecks route
coverage and uses the current configured fare; the request's `monthlyAmount` is
updated to the approved amount. If the pair has been removed, approval fails
until an admin restores a fare. Routes without fares continue accepting the
existing boarding-only request flow. Old pending boarding-only requests remain
approvable at the flat route fee.

Admin enrollment uses the same server pricing when a destination is selected.
Omit `monthlyAmount` for a journey; a supplied mismatching amount is rejected.
An admin may deliberately retain the legacy boarding-only/custom-amount workflow
by omitting a destination. On an existing student, omitted `dropoffStopId` means
keep the current destination, while explicit `"dropoffStopId": null` clears the
journey and uses an explicitly supplied `monthlyAmount`, or the route's default
flat fee when no amount is supplied.

Requests, subscriptions, and management student responses include nullable
`dropoffStopId` and `dropoffStopName`. Requests also include their `monthlyAmount`
quote/approved amount; pre-upgrade requests can have a null quote.

## Billing and existing records

An assigned subscription keeps its amount when the fare table is edited or
cleared. Profile-only edits and saving the same journey keep that assigned
amount. Changing the route, boarding stop, or destination selects the then-current
configured fare. To migrate a legacy student, edit the student and choose both
stops; automatic bulk repricing is intentionally not performed.

Bill generation reads the subscription's assigned `monthlyAmount`. Issued bills,
including pending and paid bills, are never rewritten by a fare or journey edit.
The existing historical-charge safeguard remains in force: before changing an
assigned amount, all earlier service months must already have generated bills;
otherwise the API returns HTTP 409 identifying the first missing month. Stopped
subscription amounts cannot be changed. A new amount applies to bills generated
after the change, including the current month if its bill has not been generated.

Migration 3 runs automatically at API startup after migrations 1 and 2 in the
existing advisory-locked transaction. It creates `route_fares`, adds optional
destination references, and enforces same-route/different-stop fare integrity.
It does not backfill destinations or change existing subscription/bill amounts.
