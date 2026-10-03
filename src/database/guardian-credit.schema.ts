/** Guardian advance payments are stored as integer poisha with an auditable journal. */
export const guardianCreditSchema = `
CREATE TABLE guardian_credit_accounts (
  "guardianId" TEXT PRIMARY KEY REFERENCES users(id),
  balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0)
);
CREATE TABLE guardian_credit_entries (
  id TEXT PRIMARY KEY,
  "guardianId" TEXT NOT NULL REFERENCES users(id),
  "billId" TEXT NOT NULL REFERENCES bills(id),
  "submissionId" TEXT NOT NULL REFERENCES payment_submissions(id),
  kind TEXT NOT NULL CHECK (kind IN ('RESERVED','RETURNED','OVERPAYMENT','CREDIT_PAYMENT')),
  amount INTEGER NOT NULL CHECK (amount <> 0),
  "createdAt" TEXT NOT NULL,
  UNIQUE ("submissionId", kind)
);
CREATE INDEX guardian_credit_entries_guardian ON guardian_credit_entries("guardianId", "createdAt");
ALTER TABLE payment_submissions ADD COLUMN "creditApplied" INTEGER NOT NULL DEFAULT 0 CHECK ("creditApplied" >= 0);
ALTER TABLE payment_submissions DROP CONSTRAINT payment_submissions_amount_check;
ALTER TABLE payment_submissions ADD CONSTRAINT payment_submissions_amount_check CHECK (amount >= 0);
ALTER TABLE bills ADD COLUMN "creditApplied" INTEGER NOT NULL DEFAULT 0 CHECK ("creditApplied" >= 0);
`;
