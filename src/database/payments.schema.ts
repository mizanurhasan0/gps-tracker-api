/** Version 9 preserves existing accounts and receipts while allowing any provider. */
export const paymentsSchema = `
ALTER TABLE payment_accounts DROP CONSTRAINT payment_accounts_method_check;
ALTER TABLE payment_submissions DROP CONSTRAINT payment_submissions_method_check;
ALTER TABLE payment_accounts ADD COLUMN name TEXT NOT NULL DEFAULT '';
ALTER TABLE payment_accounts ADD COLUMN "imageUrl" TEXT NOT NULL DEFAULT '';
UPDATE payment_accounts SET name = CASE method WHEN 'BKASH' THEN 'bKash' WHEN 'ROCKET' THEN 'Rocket' ELSE method END;
ALTER TABLE payment_submissions ADD COLUMN "methodName" TEXT NOT NULL DEFAULT '';
UPDATE payment_submissions SET "methodName" = CASE method WHEN 'BKASH' THEN 'bKash' WHEN 'ROCKET' THEN 'Rocket' ELSE method END;
ALTER TABLE payment_submissions ADD COLUMN "evidenceImageUrl" TEXT NOT NULL DEFAULT '';
ALTER TABLE payment_submissions ADD COLUMN "transactionInfo" TEXT NOT NULL DEFAULT '';
DROP INDEX reserved_transaction;
CREATE UNIQUE INDEX reserved_transaction ON payment_submissions(method, lower("transactionId"))
 WHERE status != 'REJECTED' AND "transactionId" <> '';
`;
