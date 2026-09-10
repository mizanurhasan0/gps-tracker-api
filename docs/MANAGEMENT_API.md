# Noor Transport management API

All routes require a bearer session. `/admin/*` requires the ADMIN role. Unknown
body fields are rejected. Dates use `YYYY-MM-DD`, schedule times use `HH:mm`, and
amounts are integer **poisha**. The matching mobile contracts are in
`android-app-vehicle-tracker/src/api/management.ts`.

| Method | Endpoint | Body / behavior |
|---|---|---|
| GET | `/management/overview` | `{students,drivers,attendance,maintenance,ledger,notices,requests,settings,schedules}` |
| POST | `/admin/students` | `{studentName,guardianPhone,routeId,stopId,...profile}`; guardian account must already exist |
| PATCH | `/admin/students/:id` | Partial student fields, route/stop, monthlyAmount, status ACTIVE/STOPPED |
| POST / PATCH | `/admin/drivers`, `/admin/drivers/:id` | Name, phone, NID, address, joiningDate, monthlySalary, status, optional vehicleId |
| PUT | `/admin/attendance` | `{entries:[{studentId or driverId,date,status,note?}]}`; atomic upsert, max 500 |
| POST / PATCH | `/admin/maintenance`, `/admin/maintenance/:id` | `{vehicleId,title,description?,serviceDate,nextServiceDate?,amount,status?}` |
| POST | `/admin/ledger` | `{type,category,title,amount,date,note?,vehicleId?,driverId?}` |
| POST | `/admin/notices` | `{title,body,category,audience,targetId?}` |
| POST | `/management/requests` | `{studentId?,driverId?,vehicleId?,category,title,description,date?}` |
| PATCH | `/admin/management-requests/:id/decision` | `{decision:"APPROVED" or "REJECTED",note?}`; rejection requires note |
| PATCH | `/admin/settings` | Partial business contact information and SMS text templates |
| PUT | `/admin/routes/:id/schedule` | `{entries:[{label,time,period,position,stopId?,studentId?}]}`; atomic replacement |
| GET | `/admin/reports?month=YYYY-MM` | Monthly billing, cash flow, current counts, attendance counts and ledger rows |

Student profile fields are `studentCode,className,roll,photoUrl,pickupAddress,
dropAddress,emergencyContact`. The existing guardian admission endpoint
`POST /requests/guardian/new` accepts these fields alongside
`studentName,routeId,stopId`. Ownership comes from the session. Fare comes from the
selected route on approval. Profile data survives approval and subsequent edits.
The admin enrollment endpoint accepts a registered guardian's phone (local or
8801/+8801 format), and uses that account's name/phone. It does not create accounts
with shared passwords. Guardian ownership cannot be reassigned on a student edit.
Restarting a stopped service requires a new enrollment. A stopped subscription
cannot be changed back to active, which preserves its closed billing period.

`photoUrl` allows an empty value, HTTPS URI, or JPEG/PNG base64 data URI up to
450,000 characters. The server accepts JSON bodies up to 768 KiB. The mobile app
compresses picked student photos before submitting them. Reverse proxies should
allow at least the same request size.

Vehicle create/update routes also accept `model,purchaseDate,fitnessExpiresAt,
licenseExpiresAt,status`. Each optional vehicle date accepts an empty string to
clear it; nonempty values must be real dates in `YYYY-MM-DD` form.
Vehicle status is RUNNING, MAINTENANCE or INACTIVE. Driver
assignment keeps the existing vehicle driver name/phone fields synchronized; one
driver profile can be assigned to each vehicle. DRIVER is not an authentication
role in this release. Admins can record requests on a driver's behalf.

## Data boundaries and consistency

Guardian overview responses include only their student profiles, attendance,
requests and delivered notices. Driver contact data is limited to active assigned
vehicles, with NID, salary, address and joining date removed. Maintenance and
ledger arrays are empty for guardians. Schedules include only active assigned
routes and the guardian's own students/stops or general route events. Stopped
students retain historical attendance and payments, while tracking and active
schedule/driver access are revoked.

Notice audiences are ALL, ROUTE, VEHICLE or STUDENT. Specific audiences require a
valid target. Recipient accounts are captured when a notice is sent; notices and
in-app notifications are saved in the same transaction. Notices do not perform
external SMS/WhatsApp sends. Business settings store editable message templates
and contact numbers for manual communication.

Attendance statuses are PRESENT, ABSENT and LEAVE. Exactly one student or driver
must be specified per entry. An approved ABSENCE/LEAVE request also records that
person's attendance transactionally. Requests cannot be reviewed twice.

Maintenance statuses are PLANNED, IN_PROGRESS and COMPLETED. An in-progress record
sets the vehicle to MAINTENANCE. Only completed positive costs create an EXPENSE
entry. Editing a maintenance record updates its single linked expense; resetting
it to planned/in progress or zero removes that linked expense. These operations,
vehicle status updates and the audit log commit together. Dates must be real
calendar dates, and next service cannot precede service date.

Ledger types are INCOME, EXPENSE and INVESTMENT. Monthly reports separate
investment from revenue and profit. Expected/paid/due totals follow bill month;
fareReceived follows the actual bill paidAt month in Asia/Dhaka. Net cash income
is received fares plus other income minus expenses. Manual ledger income should
be used for other receipts; recording already-paid student bills again would
double-count them. Existing manual bKash/Rocket bill approval remains the source
of payment truth. Existing bill amounts remain unchanged by later fare edits.
Before changing a fare, all earlier service months must have bills generated;
otherwise the edit returns 409 naming the first missing month. This prevents an
updated fare from changing an older unbilled charge. Stopped service fares are
immutable. New fare values apply to subsequent bill generation only.

## Upgrade and validation

Migration version 2 runs after the unchanged version 1 schema, under the existing
transaction/advisory lock. It backfills student profiles from subscriptions and
driver profiles from vehicles. Student IDs remain the corresponding subscription
IDs, preserving all bill/history relationships. A database trigger creates the
profile from admission fields for every newly inserted subscription.

`test/management.test.ts` boots HTTP against a disposable PostgreSQL schema that
starts with real version 1 data. It tests upgrade/backfill, enrollment/admission,
photo validation, role and ownership enforcement, transactional rollback, notices,
requests, schedule privacy, financial totals and stop revocation.

```sh
TEST_DATABASE_URL=postgresql://... npm test
```

No production database is required for testing. Each integration suite creates
and removes its own uniquely named schema in the explicitly provided test DB.
