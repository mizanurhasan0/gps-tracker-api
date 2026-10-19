/** Version 15 adds admin Telegram messaging: saved messages and sent-message history. */
export const messagingSchema = `
CREATE TABLE message_templates (
 id TEXT PRIMARY KEY,
 title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 80),
 body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 2000),
 "createdBy" TEXT REFERENCES users(id) ON DELETE SET NULL,
 "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
 "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX message_templates_updated ON message_templates("updatedAt" DESC,"createdAt" DESC);

-- Legacy SMS templates stay in business_settings for older app builds.
-- Earlier legacy keys get a slightly newer timestamp so the list keeps their order.
INSERT INTO message_templates(id,title,body,"createdAt","updatedAt")
SELECT gen_random_uuid()::text, legacy.title, left(btrim(s.data->>legacy.key),2000),
  now() - legacy.position * interval '1 millisecond', now() - legacy.position * interval '1 millisecond'
FROM business_settings s
CROSS JOIN (VALUES
  (1,'paymentReminder','পেমেন্ট রিমাইন্ডার'),
  (2,'absenceMessage','অনুপস্থিতি'),
  (3,'delayMessage','গাড়ি দেরি'),
  (4,'holidayMessage','ছুটির বার্তা'),
  (5,'emergencyMessage','জরুরি বার্তা')
) AS legacy(position,key,title)
WHERE s.id=1 AND jsonb_typeof(s.data->legacy.key)='string' AND btrim(s.data->>legacy.key)<>''
ORDER BY legacy.position;

CREATE TABLE telegram_messages (
 id TEXT PRIMARY KEY,
 title TEXT NOT NULL,
 body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 2000),
 audience TEXT NOT NULL CHECK(audience IN ('ALL','SELECTED')),
 vehicles JSONB NOT NULL CHECK(jsonb_typeof(vehicles)='array'),
 "templateId" TEXT REFERENCES message_templates(id) ON DELETE SET NULL,
 "createdBy" TEXT REFERENCES users(id) ON DELETE SET NULL,
 "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX telegram_messages_created ON telegram_messages("createdAt" DESC,id DESC);

CREATE TABLE telegram_message_recipients (
 "messageId" TEXT NOT NULL REFERENCES telegram_messages(id) ON DELETE CASCADE,
 "guardianId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 "notificationId" TEXT REFERENCES notifications(id) ON DELETE SET NULL,
 "telegramQueued" BOOLEAN NOT NULL DEFAULT FALSE,
 PRIMARY KEY("messageId","guardianId")
);
CREATE INDEX telegram_message_recipients_guardian ON telegram_message_recipients("guardianId");
`;
