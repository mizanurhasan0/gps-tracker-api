/** Version 13 adds optional student identity details to every profile projection. */
export const studentProfileDetailsSchema = `
ALTER TABLE student_profiles ADD COLUMN "dateOfBirth" TEXT NOT NULL DEFAULT '';
ALTER TABLE student_profiles ADD COLUMN "bloodGroup" TEXT NOT NULL DEFAULT '';
ALTER TABLE service_requests ADD COLUMN "dateOfBirth" TEXT NOT NULL DEFAULT '';
ALTER TABLE service_requests ADD COLUMN "bloodGroup" TEXT NOT NULL DEFAULT '';
ALTER TABLE students ADD COLUMN "dateOfBirth" TEXT NOT NULL DEFAULT '';
ALTER TABLE students ADD COLUMN "bloodGroup" TEXT NOT NULL DEFAULT '';
`;
