/** Version 16 adds the client idempotency key for Telegram message sends. */
export const messagingRequestIdSchema = `
ALTER TABLE telegram_messages ADD COLUMN "requestId" TEXT;
UPDATE telegram_messages SET "requestId"=id WHERE "requestId" IS NULL;
ALTER TABLE telegram_messages ALTER COLUMN "requestId" SET NOT NULL;
CREATE UNIQUE INDEX telegram_messages_request_id ON telegram_messages("requestId");
`;
