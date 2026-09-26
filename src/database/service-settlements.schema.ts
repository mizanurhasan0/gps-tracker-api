/** Version 12 records non-destructive transport-service stops and their billing settlement. */
export const serviceSettlementsSchema = `
ALTER TABLE subscriptions ADD COLUMN "stoppedOn" TEXT;
ALTER TABLE subscriptions ADD COLUMN "stopReason" TEXT NOT NULL DEFAULT '';
ALTER TABLE subscriptions ADD COLUMN "finalMonthlyFee" INTEGER;
ALTER TABLE subscriptions ADD CHECK("finalMonthlyFee" IS NULL OR "finalMonthlyFee" >= 0);
ALTER TABLE bills DROP CONSTRAINT bills_amount_check;
ALTER TABLE bills ADD CHECK(amount >= 0);
ALTER TABLE bills DROP CONSTRAINT bills_status_check;
ALTER TABLE bills ADD CHECK(status IN ('UNPAID','PAID','WAIVED'));
CREATE TABLE service_settlements (
 id TEXT PRIMARY KEY, "subscriptionId" TEXT NOT NULL UNIQUE REFERENCES subscriptions(id),
 "billId" TEXT REFERENCES bills(id), "stopDate" TEXT NOT NULL,
 "finalMonthlyFee" INTEGER NOT NULL CHECK("finalMonthlyFee" >= 0),
 reason TEXT NOT NULL DEFAULT '', "previousBillAmount" INTEGER,
 "billAction" TEXT NOT NULL CHECK("billAction" IN ('NO_BILL','CREATED','ADJUSTED','UNCHANGED')),
 "createdBy" TEXT NOT NULL REFERENCES users(id), "createdAt" TEXT NOT NULL
);
CREATE INDEX service_settlements_stop_date ON service_settlements("stopDate");
`;
