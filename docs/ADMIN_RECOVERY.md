# Admin email recovery

Recovery is restricted to `eng.mizanur.hasan@gmail.com` and one existing admin.
The first enabled startup binds the sole `ADMIN` account's immutable database ID.
Later phone changes or additional admins do not change that binding. The bound
account must still have the `ADMIN` role when recovery completes. These endpoints
cannot create accounts, select a different user, or grant roles.

## Enable Gmail delivery

The feature is disabled by default. In the VPS's private `.env`, configure:

```dotenv
ADMIN_RECOVERY_ENABLED=true
ADMIN_RECOVERY_EMAIL=eng.mizanur.hasan@gmail.com
ADMIN_RECOVERY_SECRET=REPLACE_WITH_64_RANDOM_HEX_CHARACTERS
RECOVERY_SMTP_HOST=smtp.gmail.com
RECOVERY_SMTP_PORT=465
RECOVERY_SMTP_USER=eng.mizanur.hasan@gmail.com
RECOVERY_SMTP_PASSWORD=REPLACE_WITH_GMAIL_APP_PASSWORD
RECOVERY_SMTP_FROM=eng.mizanur.hasan@gmail.com
```

Generate the recovery secret with `openssl rand -hex 32`. Keep it stable across
restarts, out of Git, and in a password manager separate from database backups.
Create a Gmail App Password after enabling Google 2-Step Verification; enter
the App Password without the display spaces. Do not use your normal Google
password. App Password availability depends on the account's security settings:
[Google's instructions](https://support.google.com/accounts/answer/185833).

Deploy through the normal project workflow. Migration 10 creates the recovery
tables. Enabling without valid secrets, or with zero/multiple admins on the first
binding, fails startup rather than guessing an owner. Once bound, the API refuses
startup if the configured recovery email differs from the stored binding.

Port 465 uses implicit TLS; port 587 requires STARTTLS. Certificate verification
is enabled. The SMTP user/from can be a different authorized sender; the recipient
is always the configured and bound recovery email. Allow outbound SMTP through
the VPS firewall/provider. Serve both endpoints over HTTPS.

## Request a code

`POST /auth/recovery/request` — public; returns HTTP 202.

```json
{ "email": "eng.mizanur.hasan@gmail.com" }
```

```json
{
  "message": "If this email is eligible, recovery instructions will be sent. Please check your inbox.",
  "requestId": "f7af85c3-a773-4779-9e60-736862216c26"
}
```

Save `requestId` on the recovery screen. Email contains the eight-digit OTP and
its matching request ID. Unknown emails, cooldowns, quotas and ineligible owners
receive the same response shape with a random ID. A 202 response does not promise
that an email was sent. Ordinary response timing is padded to at least 250 ms;
delivery occurs independently, avoiding SMTP-dependent timing differences.

Wait at least 60 seconds before resending. A permitted resend invalidates the
previous code; a request blocked by cooldown/quota leaves the current code valid.
The UI should disable resend during cooldown and retain the corresponding request
ID. If several emails arrive, use the newest request and code together.

## Reset the password

`POST /auth/recovery/confirm` — public; returns HTTP 200 on success.

```json
{
  "email": "eng.mizanur.hasan@gmail.com",
  "requestId": "f7af85c3-a773-4779-9e60-736862216c26",
  "otp": "01234567",
  "newPassword": "REPLACE_WITH_A_UNIQUE_STRONG_PASSWORD",
  "confirmPassword": "REPLACE_WITH_A_UNIQUE_STRONG_PASSWORD"
}
```

Password length is 12–128 characters. Unknown fields, including `role`, `userId`
and `phone`, are rejected by the existing global validation pipe. Successful
recovery returns a message, not an authentication token. Sign in normally.

The password update, OTP consumption, deletion of that admin's sessions, audit
record and confirmation-email enqueue all commit in one transaction. Concurrent
confirmations succeed once. Login rechecks the password hash under a database
lock before issuing a session, so an in-flight old-password login cannot bypass
the reset. Other users' sessions remain valid. Existing live sockets recheck
session validity on the next location broadcast.

Responses: 400 for invalid/expired/exhausted codes or invalid input; 429 for IP
limits; 404 when recovery is disabled. Database failures do not accept a reset.

## Limits and delivery

- OTP lifetime: five minutes from creation; one use; five incorrect attempts.
- Owner delivery quota: one request per 60 seconds, maximum five per rolling hour.
- Request IP quota: ten requests per fixed 15-minute window.
- Confirmation IP quota: twenty attempts per fixed 15-minute window.
- Limits and failed-code attempts persist in PostgreSQL across API restarts.
- OTPs are generated with cryptographic randomness. Verification uses an HMAC
  bound to the request ID and email; mail payloads use authenticated AES-256-GCM
  encryption with a separate derived key. SMTP logs never include raw errors,
  passwords, OTPs or message bodies.
- The database outbox worker polls every second, retries failed delivery up to
  five attempts with backoff, and uses a two-minute claim lease. OTP mail stops
  when the code expires or is consumed; reset notices expire after 24 hours.
- Payloads are erased after successful delivery, invalidation, expiry or retry
  exhaustion. Expired challenges are removed after a day, expired rate buckets
  are removed, and terminal mail metadata is retained up to seven days. Audit
  records use the existing application retention policy.

SMTP delivery is at least once: a crash after provider acceptance but before the
database update can produce a duplicate email. It does not make the OTP reusable.
Monitor pending/exhausted `admin_recovery_mail` jobs and worker warnings. A Gmail
acceptance response cannot guarantee inbox delivery; check spam and sender setup.

IP limits use `req.ip`, not an untrusted `X-Forwarded-For` header. The current app
does not trust proxies, so requests behind Nginx may share its IP quota. If changing
this, trust only your known proxy network and prevent direct public API access.

## Owner maintenance and recovery limits

Changing the recovery email or owner requires an explicit server/database
maintenance operation; no HTTP endpoint can do it. Stop the API, invalidate all
outstanding challenges and mail, independently verify the intended owner, update
the binding and matching configuration together, and record the maintenance.
Do not delete/recreate the binding merely to work around a startup failure.

Secret rotation invalidates outstanding OTP digests and encrypted mail; invalidate
pending recovery records during a controlled rotation. Keep infrastructure access
and an off-server database backup available. Protect the Gmail account with MFA.
Email recovery cannot protect against an attacker with full VPS/database control
or restore a deleted account.

The token, enumeration and session handling follows the
[OWASP password-recovery guidance](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html).
