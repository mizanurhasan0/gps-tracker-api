/** Version 10: owner-bound admin recovery, durable limits and encrypted mail outbox. */
export const adminRecoverySchema = `
CREATE TABLE admin_recovery_owner (
 id SMALLINT PRIMARY KEY CHECK(id=1),
 "userId" TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
 email TEXT NOT NULL,
 "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE admin_recovery_challenges (
 id UUID PRIMARY KEY,
 "ownerId" SMALLINT NOT NULL REFERENCES admin_recovery_owner(id),
 "codeHash" TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
 "expiresAt" TIMESTAMPTZ NOT NULL,
 "usedAt" TIMESTAMPTZ
);
CREATE UNIQUE INDEX admin_recovery_one_pending ON admin_recovery_challenges("ownerId") WHERE "usedAt" IS NULL;
CREATE TABLE admin_recovery_limits (
 key TEXT NOT NULL,
 "windowStart" BIGINT NOT NULL,
 attempts INTEGER NOT NULL CHECK(attempts > 0),
 "expiresAt" TIMESTAMPTZ NOT NULL,
 PRIMARY KEY(key,"windowStart")
);
CREATE TABLE admin_recovery_mail (
 id UUID PRIMARY KEY,
 "challengeId" UUID REFERENCES admin_recovery_challenges(id) ON DELETE CASCADE,
 "ownerId" SMALLINT NOT NULL REFERENCES admin_recovery_owner(id),
 kind TEXT NOT NULL CHECK(kind IN ('OTP','NOTICE')),
 payload TEXT,
 attempts INTEGER NOT NULL DEFAULT 0,
 "nextAttemptAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
 "leaseUntil" TIMESTAMPTZ,
 "sentAt" TIMESTAMPTZ,
 "expiresAt" TIMESTAMPTZ NOT NULL,
 "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK((kind='OTP' AND "challengeId" IS NOT NULL) OR (kind='NOTICE' AND "challengeId" IS NULL))
);
CREATE INDEX admin_recovery_mail_pending ON admin_recovery_mail("nextAttemptAt") WHERE payload IS NOT NULL;
`;
