export const schema = `
CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL UNIQUE,
 passwordHash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('ADMIN','GUARDIAN')),
 verified INTEGER NOT NULL DEFAULT 0, createdAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
 tokenHash TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id), expiresAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(userId);
CREATE TABLE IF NOT EXISTS vehicles (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, plate TEXT NOT NULL, imei TEXT NOT NULL UNIQUE,
 driverName TEXT, driverPhone TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS routes (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, vehicleId TEXT NOT NULL REFERENCES vehicles(id),
 monthlyAmount INTEGER NOT NULL CHECK(monthlyAmount > 0), active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS stops (
 id TEXT PRIMARY KEY, routeId TEXT NOT NULL REFERENCES routes(id), name TEXT NOT NULL,
 UNIQUE(routeId, name)
);
CREATE TABLE IF NOT EXISTS service_requests (
 id TEXT PRIMARY KEY, guardianId TEXT NOT NULL REFERENCES users(id), studentName TEXT NOT NULL,
 routeId TEXT NOT NULL REFERENCES routes(id), stopId TEXT NOT NULL REFERENCES stops(id),
 status TEXT NOT NULL CHECK(status IN ('PENDING','APPROVED','REJECTED')),
 note TEXT NOT NULL DEFAULT '', reviewedBy TEXT REFERENCES users(id), createdAt TEXT NOT NULL, reviewedAt TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS pending_service ON service_requests(guardianId, studentName) WHERE status = 'PENDING';
CREATE TABLE IF NOT EXISTS subscriptions (
 id TEXT PRIMARY KEY, guardianId TEXT NOT NULL REFERENCES users(id), requestId TEXT NOT NULL UNIQUE REFERENCES service_requests(id),
 studentName TEXT NOT NULL, routeId TEXT NOT NULL REFERENCES routes(id), stopId TEXT NOT NULL REFERENCES stops(id),
 monthlyAmount INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('ACTIVE','STOPPED')), startedAt TEXT NOT NULL, stoppedAt TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS active_student ON subscriptions(guardianId, studentName) WHERE status = 'ACTIVE';
CREATE TABLE IF NOT EXISTS bills (
 id TEXT PRIMARY KEY, guardianId TEXT NOT NULL REFERENCES users(id), subscriptionId TEXT NOT NULL REFERENCES subscriptions(id),
 month TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount > 0),
 status TEXT NOT NULL CHECK(status IN ('UNPAID','PAID')), createdAt TEXT NOT NULL, paidAt TEXT,
 UNIQUE(subscriptionId, month)
);
CREATE TABLE IF NOT EXISTS payment_accounts (
 method TEXT PRIMARY KEY CHECK(method IN ('BKASH','ROCKET')), number TEXT NOT NULL, instructions TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS payment_account_history (
 method TEXT NOT NULL, number TEXT NOT NULL, PRIMARY KEY(method,number)
);
INSERT OR IGNORE INTO payment_account_history SELECT method, number FROM payment_accounts;
CREATE TABLE IF NOT EXISTS payment_submissions (
 id TEXT PRIMARY KEY, billId TEXT NOT NULL REFERENCES bills(id), guardianId TEXT NOT NULL REFERENCES users(id),
 method TEXT NOT NULL CHECK(method IN ('BKASH','ROCKET')), recipientNumber TEXT NOT NULL, senderNumber TEXT NOT NULL,
 transactionId TEXT NOT NULL COLLATE NOCASE, amount INTEGER NOT NULL CHECK(amount > 0),
 status TEXT NOT NULL CHECK(status IN ('PENDING','APPROVED','REJECTED')),
 note TEXT NOT NULL DEFAULT '', reviewedBy TEXT REFERENCES users(id), createdAt TEXT NOT NULL, reviewedAt TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS reserved_transaction ON payment_submissions(method, transactionId) WHERE status != 'REJECTED';
CREATE UNIQUE INDEX IF NOT EXISTS pending_payment ON payment_submissions(billId) WHERE status = 'PENDING';
CREATE TABLE IF NOT EXISTS complaints (
 id TEXT PRIMARY KEY, guardianId TEXT NOT NULL REFERENCES users(id), subscriptionId TEXT NOT NULL REFERENCES subscriptions(id),
 category TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'OPEN',
 note TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL, reviewedAt TEXT
);
CREATE TABLE IF NOT EXISTS stop_requests (
 id TEXT PRIMARY KEY, guardianId TEXT NOT NULL REFERENCES users(id), subscriptionId TEXT NOT NULL REFERENCES subscriptions(id),
 reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING', note TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL, reviewedAt TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS pending_stop ON stop_requests(subscriptionId) WHERE status = 'PENDING';
CREATE TABLE IF NOT EXISTS notifications (
 id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, body TEXT NOT NULL,
 entityId TEXT NOT NULL, createdAt TEXT NOT NULL, readAt TEXT
);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications(userId, createdAt);
CREATE TABLE IF NOT EXISTS audit_logs (
 id TEXT PRIMARY KEY, actorId TEXT NOT NULL REFERENCES users(id), action TEXT NOT NULL,
 entityId TEXT NOT NULL, note TEXT NOT NULL, createdAt TEXT NOT NULL
);
INSERT OR IGNORE INTO migrations(version) VALUES (1);
`;
