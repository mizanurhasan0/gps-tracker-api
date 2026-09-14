/** Version 4 keeps enrollment IDs (and their bills/attendance) intact. */
export const shiftsSchema = `
CREATE TABLE student_profiles (
 id TEXT PRIMARY KEY, "guardianId" TEXT NOT NULL REFERENCES users(id), "studentName" TEXT NOT NULL,
 "studentCode" TEXT NOT NULL DEFAULT '', "className" TEXT NOT NULL DEFAULT '', roll TEXT NOT NULL DEFAULT '',
 "photoUrl" TEXT NOT NULL DEFAULT '', "emergencyContact" TEXT NOT NULL DEFAULT '',
 UNIQUE("guardianId","studentName"), UNIQUE(id,"guardianId")
);
INSERT INTO student_profiles(id,"guardianId","studentName","studentCode","className",roll,"photoUrl","emergencyContact")
 SELECT DISTINCT ON (q."guardianId",COALESCE(s."studentName",q."studentName")) q.id,q."guardianId",COALESCE(s."studentName",q."studentName"),
 COALESCE(p."studentCode",q."studentCode"),COALESCE(p."className",q."className"),COALESCE(p.roll,q.roll),COALESCE(p."photoUrl",q."photoUrl"),COALESCE(p."emergencyContact",q."emergencyContact")
 FROM service_requests q LEFT JOIN subscriptions s ON s."requestId"=q.id LEFT JOIN students p ON p.id=s.id
 ORDER BY q."guardianId",COALESCE(s."studentName",q."studentName"),(s.status='ACTIVE') DESC NULLS LAST,COALESCE(s."startedAt",q."createdAt") DESC,q.id;
ALTER TABLE service_requests ADD COLUMN "studentId" TEXT;
ALTER TABLE subscriptions ADD COLUMN "studentId" TEXT;
UPDATE service_requests q SET "studentId"=p.id FROM student_profiles p WHERE p."guardianId"=q."guardianId" AND p."studentName"=COALESCE((SELECT s."studentName" FROM subscriptions s WHERE s."requestId"=q.id),q."studentName");
UPDATE subscriptions s SET "studentId"=q."studentId" FROM service_requests q WHERE q.id=s."requestId";
ALTER TABLE service_requests ALTER COLUMN "studentId" SET NOT NULL;
ALTER TABLE subscriptions ALTER COLUMN "studentId" SET NOT NULL;
ALTER TABLE service_requests ADD FOREIGN KEY("studentId","guardianId") REFERENCES student_profiles(id,"guardianId");
ALTER TABLE subscriptions ADD FOREIGN KEY("studentId","guardianId") REFERENCES student_profiles(id,"guardianId");
ALTER TABLE service_requests ADD COLUMN "shiftId" TEXT NOT NULL DEFAULT 'MORNING';
ALTER TABLE subscriptions ADD COLUMN "shiftId" TEXT NOT NULL DEFAULT 'MORNING';
ALTER TABLE service_requests ADD COLUMN "operatingDays" INTEGER[] NOT NULL DEFAULT ARRAY[0,1,2,3,4,5,6];
ALTER TABLE subscriptions ADD COLUMN "operatingDays" INTEGER[] NOT NULL DEFAULT ARRAY[0,1,2,3,4,5,6];
CREATE FUNCTION valid_operating_days(days INTEGER[]) RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE AS $$
 SELECT cardinality(days) BETWEEN 1 AND 7 AND days <@ ARRAY[0,1,2,3,4,5,6] AND array_position(days,NULL) IS NULL
 AND cardinality(days)=(SELECT count(DISTINCT d) FROM unnest(days) d); $$;
ALTER TABLE service_requests ADD CHECK(valid_operating_days("operatingDays"));
ALTER TABLE subscriptions ADD CHECK(valid_operating_days("operatingDays"));
DROP INDEX pending_service;
DROP INDEX active_student;
CREATE UNIQUE INDEX pending_service ON service_requests("studentId","shiftId") WHERE status='PENDING';
CREATE UNIQUE INDEX active_student ON subscriptions("studentId","shiftId") WHERE status='ACTIVE';
-- Serializes claims across BOTH tables, including admin enrollment vs guardian request.
CREATE FUNCTION guard_student_shift() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."studentId" IS NULL THEN
   IF TG_TABLE_NAME='subscriptions' THEN
     SELECT "studentId","shiftId","operatingDays" INTO NEW."studentId",NEW."shiftId",NEW."operatingDays" FROM service_requests WHERE id=NEW."requestId";
   ELSE
     INSERT INTO student_profiles(id,"guardianId","studentName") VALUES(NEW.id,NEW."guardianId",NEW."studentName") ON CONFLICT("guardianId","studentName") DO NOTHING;
     SELECT id INTO NEW."studentId" FROM student_profiles WHERE "guardianId"=NEW."guardianId" AND "studentName"=NEW."studentName";
   END IF;
 END IF;
 UPDATE student_profiles SET "studentName"="studentName" WHERE id=NEW."studentId";
 IF TG_TABLE_NAME='service_requests' AND NEW.status='PENDING' THEN
   IF EXISTS(SELECT 1 FROM subscriptions WHERE "studentId"=NEW."studentId" AND "shiftId"=NEW."shiftId" AND status='ACTIVE') THEN
     RAISE EXCEPTION 'Student already has an active service in this shift' USING ERRCODE='23505',CONSTRAINT='active_student';
   END IF;
 ELSIF TG_TABLE_NAME='subscriptions' AND NEW.status='ACTIVE' THEN
   IF EXISTS(SELECT 1 FROM service_requests WHERE "studentId"=NEW."studentId" AND "shiftId"=NEW."shiftId" AND status='PENDING' AND id<>NEW."requestId") THEN
     RAISE EXCEPTION 'Student already has a pending request in this shift' USING ERRCODE='23505',CONSTRAINT='pending_service';
   END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER request_shift_guard BEFORE INSERT OR UPDATE ON service_requests FOR EACH ROW EXECUTE FUNCTION guard_student_shift();
CREATE TRIGGER subscription_shift_guard BEFORE INSERT OR UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION guard_student_shift();
UPDATE business_settings SET data=data || '{"operatingDays":[0,1,2,3,4,5,6],"transportShifts":[{"id":"MORNING","name":"Morning","startTime":"07:00","endTime":"11:00"},{"id":"DAY","name":"Day","startTime":"11:00","endTime":"15:00"},{"id":"EVENING","name":"Evening","startTime":"15:00","endTime":"19:00"}]}'::jsonb WHERE id=1;
`;
