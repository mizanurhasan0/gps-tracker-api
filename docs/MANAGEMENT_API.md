# Noor Transport management API

All routes require a bearer session. `/admin/*` requires the ADMIN role. Unknown
body fields are rejected. Dates use `YYYY-MM-DD`, schedule times use `HH:mm`, and
amounts are integer **poisha**. The matching mobile contracts are in
`android-app-vehicle-tracker/src/api/management.ts`.

| Method | Endpoint | Body / behavior |
|---|---|---|
| GET | `/management/overview` | `{students,today,todayStudents,drivers,attendance,maintenance,ledger,notices,banners,requests,settings,schedules}`; guardians receive published image banners, while admins also receive hidden banners for management |
| POST | `/admin/students` | `{studentName,guardianPhone,guardianName?,routeId,stopId,...profile}`; reuses or creates a guardian account; returns student fields plus `guardianAccountCreated` |
| PATCH | `/admin/students/:id` | Partial student fields, route/stop/dropoffStopId, legacy monthlyAmount, status ACTIVE/STOPPED |
| PATCH | `/admin/students/:id/archive` | Archives the canonical student resolved from an enrollment ID and stops all active shifts; returns `{studentId,archivedAt,affectedSubscriptions}` |
| PATCH | `/admin/students/:id/restore` | Restores the canonical profile without reactivating stopped shifts; returns `{studentId,archivedAt:null,affectedSubscriptions:0}` |
| GET | `/admin/students/archived` | Archived students as the existing enrollment-shaped student rows, including `archivedAt` and `archivedBy` |
| PUT | `/admin/routes/:id/fares` | Atomic replacement `{fares:[{boardingStopId,dropoffStopId,monthlyAmount}]}` |
| POST / PATCH | `/admin/drivers`, `/admin/drivers/:id` | Name, phone, NID, address, joiningDate, monthlySalary, status, optional vehicleId |
| PUT | `/admin/attendance` | `{entries:[{studentId or driverId,date,status,note?}]}`; atomic upsert, max 500 |
| POST / PATCH | `/admin/maintenance`, `/admin/maintenance/:id` | `{vehicleId,title,description?,serviceDate,nextServiceDate?,amount,status?}` |
| POST | `/admin/ledger` | `{type,category,title,amount,date,note?,vehicleId?,driverId?}` |
| POST | `/admin/notices` | `{title,body,category,audience,targetId?}` |
| POST / PATCH / DELETE | `/admin/banners`, `/admin/banners/:id` | Admin-managed image cards; `{imageUrl,redirectRoute,sortOrder?,sliderDuration?,active?}`. `redirectRoute` is an allowed in-app route; `sliderDuration` is optional seconds (1-60, default 5). |
| POST | `/management/requests` | `{studentId?,driverId?,vehicleId?,category,title,description,date?}` |
| PATCH | `/admin/management-requests/:id/decision` | `{decision:"APPROVED" or "REJECTED",note?}`; rejection requires note |
| PATCH | `/admin/settings` | Partial business contact information, message templates, operatingDays and transportShifts |
| PUT | `/admin/routes/:id/schedule` | `{entries:[{label,time,period,position,stopId?,studentId?}]}`; atomic replacement |
| GET | `/admin/reports?month=YYYY-MM` | Monthly billing, cash flow, current counts, attendance counts and ledger rows |

Student profile fields are `studentCode,className,roll,photoUrl,pickupAddress,
dropAddress,emergencyContact`. The existing guardian admission endpoint
`POST /requests/guardian/new` accepts these fields alongside
`studentName,routeId,stopId,dropoffStopId?`. Ownership comes from the session.
A selected destination uses the configured boarding/destination fare on approval.
See [route fare contracts and billing rules](ROUTE_FARES.md). Profile data survives approval and subsequent edits.
The admin enrollment endpoint accepts a guardian's phone (local or 8801/+8801
format), normalized to the local 11-digit number. An existing guardian is reused
without changing their name or password. A number belonging to an ADMIN returns
409. If the number is new, an account is created with the optional `guardianName`
(trimmed, 2–80 characters), or `Guardian <local phone>` when omitted. Its initial
password is `password`, stored with the same salted scrypt hash as registration.
The guardian signs in with the local phone number and this password; this initial
release has no OTP or mandatory password change. No guardian session is issued
during enrollment. New account creation, enrollment, profile and audit changes
commit together or roll back together; concurrent enrollments reuse one account.

Only the POST response includes `guardianAccountCreated: true` for a new account
or `false` for an existing account. Passwords and hashes are never returned.
`guardianName` is creation-only and does not rename existing accounts. PATCH
cannot create a guardian, accepts no `guardianName`, and cannot reassign guardian
ownership. Multiple students can belong to the same guardian, whose dashboard
continues to show only their own linked students.
Restarting a stopped service requires a new enrollment. A stopped subscription
cannot be changed back to active, which preserves its closed billing period.
Archiving applies to the canonical student across every shift. It is refused while
the student has a pending service request, stops every active subscription, hides
the profile from normal admin and guardian overviews, and preserves attendance,
bills, payments, requests and audit history. Restore makes the profile available
again but deliberately leaves its former subscriptions stopped. Archived profiles
cannot be edited, reused by ID, or silently reused by name until restored.

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
profile from admission fields for every newly inserted subscription. Migration 3
adds optional destination references and route fare tables without repricing
existing subscriptions or bills; see [route fares](ROUTE_FARES.md).

`test/management.test.ts` boots HTTP against a disposable PostgreSQL schema that
starts with real version 1 data. It tests upgrade/backfill, enrollment/admission,
photo validation, role and ownership enforcement, transactional rollback, notices,
requests, schedule privacy, financial totals and stop revocation.

```sh
TEST_DATABASE_URL=postgresql://... npm test
```

No production database is required for testing. Each integration suite creates
and removes its own uniquely named schema in the explicitly provided test DB.

## Shifts and weekly travel

Migration 4 adds a canonical `student_profiles` record while retaining existing
`students.id`/`subscriptionId` enrollment IDs. Existing bills, stops, vehicle access,
route schedule targets, management request `studentId` and attendance `studentId`
continue to reference **enrollment IDs**. The `studentId` returned on transport
requests, subscriptions and management students is the **canonical profile ID**.
Bills and payment submissions expose that canonical `studentId` plus `shiftId`.
Reports count distinct canonical students, while charges remain per enrollment.

Both enrollment POST endpoints accept optional `studentId`, `shiftId` and
`operatingDays`. Pass `studentId` to add a shift to an existing student; the API
checks guardian ownership. An omitted ID matching an existing student with a
pending/active service returns 409, asking the caller to select that profile.
Requests (including rejected/pending requests) expose the canonical ID so clients
can reuse students who do not yet have an approved enrollment. Shared name,
class, roll, student code, photo and emergency contact belong to the profile;
pickup/drop addresses, route, fare and calendar belong to the enrollment.

A student may have one pending request **or** active enrollment in each shift,
regardless of route or selected weekdays. The database serializes claims across
both tables, including competing guardian requests and admin enrollments. Another
shift is allowed. Stopping one enrollment leaves the student's other shifts active.
Shift changes on billed/stopped enrollments return 409; stop and create a new
enrollment to preserve historical billing labels. Overlapping configured shift
times on a common operating day return a `warnings` array when enrolling/updating.

`operatingDays` is a nonempty array of unique integers: 0 Sunday through 6 Saturday.
Omitted days on new services use institution settings; updates retain the current
calendar when omitted. A selection must overlap at least one institution operating
day. Effective travel days are the intersection of both calendars. Today's
`scheduledToday` and `todayStudents` use the Asia/Dhaka date (`today`). Attendance
and absence/leave requests are rejected on unscheduled days; existing historical
attendance remains intact when calendars change. Driver attendance is independent.

`PATCH /admin/settings` accepts `operatingDays` and `transportShifts`, an array of
1–20 `{id,name,startTime,endTime}` entries. IDs are unique stable strings matching
`[A-Za-z0-9_-]{1,40}`; times are `HH:mm` within the same day, with end after start.
A referenced shift cannot be removed. Defaults are MORNING 07:00–11:00, DAY
11:00–15:00 and EVENING 15:00–19:00. Brand-new installations exclude Friday by
default. Upgrades preserve all seven days for existing settings and enrollments;
an admin can explicitly set institute off days after upgrading. Migration also
preserves previously renamed/edited student profiles and enrollment references.

`test/student-shifts.test.ts` checks ownership, canonical profile reuse, duplicate
and concurrent claims, calendar validation, attendance, overlap warnings, stopped
service replacement and shift billing. `test/student-shifts-migration.test.ts`
checks preservation of real version 3 profile edits, bills and attendance.
