/** Version 8 adds Telegram delivery state and pickup geofence persistence. */
export const telegramSchema = `
CREATE TABLE telegram_connections (
 "guardianId" TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 "chatId" BIGINT NOT NULL,
 username TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'CONNECTED' CHECK(status IN ('CONNECTED','DISCONNECTED')),
 "connectedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
 "disconnectedAt" TIMESTAMPTZ,
 "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK ((status = 'CONNECTED' AND "disconnectedAt" IS NULL)
     OR (status = 'DISCONNECTED' AND "disconnectedAt" IS NOT NULL))
);
CREATE UNIQUE INDEX telegram_connections_active_chat
 ON telegram_connections("chatId") WHERE status='CONNECTED';

CREATE TABLE telegram_link_tokens (
 id TEXT PRIMARY KEY,
 "guardianId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 "tokenHash" TEXT NOT NULL UNIQUE,
 "expiresAt" TIMESTAMPTZ NOT NULL,
 "usedAt" TIMESTAMPTZ,
 "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK ("expiresAt" > "createdAt"),
 CHECK ("usedAt" IS NULL OR "usedAt" >= "createdAt")
);
CREATE INDEX telegram_link_tokens_guardian
 ON telegram_link_tokens("guardianId","createdAt" DESC);
CREATE INDEX telegram_link_tokens_pending_expiry
 ON telegram_link_tokens("expiresAt") WHERE "usedAt" IS NULL;

CREATE TABLE telegram_webhook_updates (
 "updateId" BIGINT PRIMARY KEY,
 payload JSONB NOT NULL,
 status TEXT NOT NULL DEFAULT 'RECEIVED' CHECK(status IN ('RECEIVED','PROCESSED','FAILED')),
 "receivedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
 "processedAt" TIMESTAMPTZ,
 "errorMessage" TEXT,
 CHECK (status = 'RECEIVED' OR "processedAt" IS NOT NULL)
);
CREATE INDEX telegram_webhook_updates_status
 ON telegram_webhook_updates(status,"receivedAt");

CREATE TABLE telegram_deliveries (
 id TEXT PRIMARY KEY,
 "eventKey" TEXT NOT NULL UNIQUE,
 "notificationId" TEXT REFERENCES notifications(id) ON DELETE SET NULL,
 "guardianId" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 "chatId" BIGINT NOT NULL,
 title TEXT NOT NULL,
 body TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','SENDING','SENT','FAILED','CANCELLED')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
 "nextAttemptAt" TIMESTAMPTZ,
 "telegramMessageId" INTEGER,
 "lastError" TEXT,
 "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
 "sentAt" TIMESTAMPTZ,
 "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX telegram_deliveries_notification
 ON telegram_deliveries("notificationId") WHERE "notificationId" IS NOT NULL;
CREATE INDEX telegram_deliveries_guardian
 ON telegram_deliveries("guardianId","createdAt" DESC);
CREATE INDEX telegram_deliveries_queue
 ON telegram_deliveries(status,"nextAttemptAt","createdAt")
 WHERE status IN ('PENDING','FAILED');

CREATE TABLE pickup_points (
 id TEXT PRIMARY KEY,
 "stopId" TEXT NOT NULL UNIQUE REFERENCES stops(id) ON DELETE CASCADE,
 latitude DOUBLE PRECISION NOT NULL CHECK(latitude BETWEEN -90 AND 90),
 longitude DOUBLE PRECISION NOT NULL CHECK(longitude BETWEEN -180 AND 180),
 "enterRadiusMeters" INTEGER NOT NULL DEFAULT 100 CHECK("enterRadiusMeters" BETWEEN 10 AND 10000),
 "exitRadiusMeters" INTEGER NOT NULL DEFAULT 150 CHECK("exitRadiusMeters" > "enterRadiusMeters" AND "exitRadiusMeters" <= 20000),
 active BOOLEAN NOT NULL DEFAULT TRUE,
 "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
 "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX pickup_points_active ON pickup_points("stopId") WHERE active=TRUE;

CREATE TABLE geofence_trips (
 id TEXT PRIMARY KEY,
 "routeId" TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
 "vehicleId" TEXT NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
 "shiftId" TEXT NOT NULL,
 "serviceDate" DATE NOT NULL,
 status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','COMPLETED','CANCELLED')),
 "startedAt" TIMESTAMPTZ,
 "endedAt" TIMESTAMPTZ,
 "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE("routeId","vehicleId","shiftId","serviceDate"),
 CHECK ("endedAt" IS NULL OR "startedAt" IS NULL OR "endedAt" >= "startedAt")
);
CREATE INDEX geofence_trips_active_route
 ON geofence_trips("routeId","serviceDate") WHERE status='ACTIVE';
CREATE INDEX geofence_trips_active_vehicle
 ON geofence_trips("vehicleId","serviceDate") WHERE status='ACTIVE';

CREATE TABLE geofence_trip_states (
 "tripId" TEXT NOT NULL REFERENCES geofence_trips(id) ON DELETE CASCADE,
 "pickupPointId" TEXT NOT NULL REFERENCES pickup_points(id) ON DELETE CASCADE,
 state TEXT NOT NULL DEFAULT 'OUTSIDE' CHECK(state IN ('OUTSIDE','INSIDE')),
 "entryCount" INTEGER NOT NULL DEFAULT 0 CHECK("entryCount" >= 0),
 "lastLatitude" DOUBLE PRECISION CHECK("lastLatitude" BETWEEN -90 AND 90),
 "lastLongitude" DOUBLE PRECISION CHECK("lastLongitude" BETWEEN -180 AND 180),
 "lastDistanceMeters" DOUBLE PRECISION CHECK("lastDistanceMeters" >= 0),
 "lastTransitionAt" TIMESTAMPTZ,
 "lastEnteredAt" TIMESTAMPTZ,
 "lastExitedAt" TIMESTAMPTZ,
 "lastEventKey" TEXT,
 "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY("tripId","pickupPointId")
);
CREATE INDEX geofence_trip_states_point_state
 ON geofence_trip_states("pickupPointId",state,"updatedAt");
`;
