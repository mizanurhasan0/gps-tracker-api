/** Version 2 upgrades existing installations without rewriting migration 1. */
export const managementSchema = `
ALTER TABLE service_requests ADD COLUMN "className" TEXT NOT NULL DEFAULT '';
ALTER TABLE service_requests ADD COLUMN roll TEXT NOT NULL DEFAULT '';
ALTER TABLE service_requests ADD COLUMN "studentCode" TEXT NOT NULL DEFAULT '';
ALTER TABLE service_requests ADD COLUMN "photoUrl" TEXT NOT NULL DEFAULT '';
ALTER TABLE service_requests ADD COLUMN "pickupAddress" TEXT NOT NULL DEFAULT '';
ALTER TABLE service_requests ADD COLUMN "dropAddress" TEXT NOT NULL DEFAULT '';
ALTER TABLE service_requests ADD COLUMN "emergencyContact" TEXT NOT NULL DEFAULT '';
CREATE TABLE students (
 id TEXT PRIMARY KEY REFERENCES subscriptions(id), "studentCode" TEXT NOT NULL DEFAULT '',
 "className" TEXT NOT NULL DEFAULT '', roll TEXT NOT NULL DEFAULT '', "photoUrl" TEXT NOT NULL DEFAULT '',
 "pickupAddress" TEXT NOT NULL DEFAULT '', "dropAddress" TEXT NOT NULL DEFAULT '',
 "emergencyContact" TEXT NOT NULL DEFAULT ''
);
INSERT INTO students(id) SELECT id FROM subscriptions;
CREATE FUNCTION create_student_profile() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN INSERT INTO students(id,"studentCode","className",roll,"photoUrl","pickupAddress","dropAddress","emergencyContact")
 SELECT NEW.id,"studentCode","className",roll,"photoUrl","pickupAddress","dropAddress","emergencyContact"
 FROM service_requests WHERE id=NEW."requestId"; RETURN NEW; END; $$;
CREATE TRIGGER subscription_student_profile AFTER INSERT ON subscriptions FOR EACH ROW EXECUTE FUNCTION create_student_profile();
CREATE TABLE drivers (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL, nid TEXT NOT NULL DEFAULT '',
 address TEXT NOT NULL DEFAULT '', "joiningDate" TEXT NOT NULL DEFAULT '',
 "monthlySalary" INTEGER NOT NULL DEFAULT 0 CHECK("monthlySalary" >= 0),
 status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','LEAVE','INACTIVE')),
 "vehicleId" TEXT UNIQUE REFERENCES vehicles(id) ON DELETE SET NULL, "createdAt" TEXT NOT NULL
);
INSERT INTO drivers(id,name,phone,"vehicleId","createdAt")
 SELECT id, "driverName", COALESCE("driverPhone",''),id,"createdAt" FROM vehicles WHERE COALESCE("driverName",'') != '';
ALTER TABLE vehicles ADD COLUMN model TEXT NOT NULL DEFAULT '';
ALTER TABLE vehicles ADD COLUMN "purchaseDate" TEXT NOT NULL DEFAULT '';
ALTER TABLE vehicles ADD COLUMN "fitnessExpiresAt" TEXT NOT NULL DEFAULT '';
ALTER TABLE vehicles ADD COLUMN "licenseExpiresAt" TEXT NOT NULL DEFAULT '';
ALTER TABLE vehicles ADD COLUMN status TEXT NOT NULL DEFAULT 'RUNNING' CHECK(status IN ('RUNNING','MAINTENANCE','INACTIVE'));
CREATE TABLE attendance (
 id TEXT PRIMARY KEY, "studentId" TEXT REFERENCES students(id), "driverId" TEXT REFERENCES drivers(id),
 date TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('PRESENT','ABSENT','LEAVE')),
 note TEXT NOT NULL DEFAULT '', "updatedAt" TEXT NOT NULL, "recordedBy" TEXT NOT NULL REFERENCES users(id),
 CHECK (("studentId" IS NULL) != ("driverId" IS NULL))
);
CREATE UNIQUE INDEX attendance_student_day ON attendance("studentId",date) WHERE "studentId" IS NOT NULL;
CREATE UNIQUE INDEX attendance_driver_day ON attendance("driverId",date) WHERE "driverId" IS NOT NULL;
CREATE TABLE maintenance (
 id TEXT PRIMARY KEY, "vehicleId" TEXT NOT NULL REFERENCES vehicles(id), title TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '', "serviceDate" TEXT NOT NULL, "nextServiceDate" TEXT,
 amount INTEGER NOT NULL CHECK(amount >= 0), status TEXT NOT NULL CHECK(status IN ('PLANNED','IN_PROGRESS','COMPLETED')),
 "createdAt" TEXT NOT NULL
);
CREATE TABLE ledger (
 id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('INCOME','EXPENSE','INVESTMENT')),
 category TEXT NOT NULL, title TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount > 0), date TEXT NOT NULL,
 note TEXT NOT NULL DEFAULT '', "vehicleId" TEXT REFERENCES vehicles(id), "driverId" TEXT REFERENCES drivers(id),
 "maintenanceId" TEXT UNIQUE REFERENCES maintenance(id), "createdBy" TEXT NOT NULL REFERENCES users(id), "createdAt" TEXT NOT NULL
);
CREATE INDEX ledger_date ON ledger(date);
CREATE TABLE notices (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, category TEXT NOT NULL,
 audience TEXT NOT NULL CHECK(audience IN ('ALL','ROUTE','VEHICLE','STUDENT')), "targetId" TEXT,
 "createdBy" TEXT NOT NULL REFERENCES users(id), "createdAt" TEXT NOT NULL
);
CREATE TABLE notice_recipients (
 "noticeId" TEXT NOT NULL REFERENCES notices(id), "userId" TEXT NOT NULL REFERENCES users(id),
 PRIMARY KEY("noticeId","userId")
);
CREATE TABLE management_requests (
 id TEXT PRIMARY KEY, "userId" TEXT NOT NULL REFERENCES users(id), "studentId" TEXT REFERENCES students(id),
 "driverId" TEXT REFERENCES drivers(id), "vehicleId" TEXT REFERENCES vehicles(id),
 category TEXT NOT NULL CHECK(category IN ('ABSENCE','LEAVE','MAINTENANCE','OTHER')),
 title TEXT NOT NULL, description TEXT NOT NULL, date TEXT,
 status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPROVED','REJECTED')),
 note TEXT NOT NULL DEFAULT '', "createdAt" TEXT NOT NULL, "reviewedAt" TEXT, "reviewedBy" TEXT REFERENCES users(id)
);
CREATE UNIQUE INDEX management_pending_student_date ON management_requests("studentId",category,date)
 WHERE "studentId" IS NOT NULL AND date IS NOT NULL AND status='PENDING';
CREATE UNIQUE INDEX management_pending_driver_date ON management_requests("driverId",category,date)
 WHERE "driverId" IS NOT NULL AND date IS NOT NULL AND status='PENDING';
CREATE TABLE business_settings (id INTEGER PRIMARY KEY CHECK(id = 1), data JSONB NOT NULL);
INSERT INTO business_settings VALUES(1,'{"businessName":"NOOR TRANSPORT","phone":"","address":"","emergencyPhone":"","whatsappNumber":"","paymentReminder":"মাসিক ভাড়া পরিশোধ করুন।","absenceMessage":"আজ শিক্ষার্থী অনুপস্থিত।","delayMessage":"গাড়ি আসতে দেরি হবে।","holidayMessage":"পরিবহন সেবা বন্ধ থাকবে।","emergencyMessage":"জরুরি প্রয়োজনে অফিসে যোগাযোগ করুন।"}');
CREATE TABLE route_schedules (
 id TEXT PRIMARY KEY, "routeId" TEXT NOT NULL REFERENCES routes(id), "stopId" TEXT REFERENCES stops(id),
 "studentId" TEXT REFERENCES students(id), label TEXT NOT NULL, time TEXT NOT NULL,
 period TEXT NOT NULL CHECK(period IN ('MORNING','AFTERNOON')), position INTEGER NOT NULL CHECK(position >= 0)
);
CREATE INDEX route_schedules_route ON route_schedules("routeId",period,position);
`;
