/** Version 11 archives the canonical student identity without deleting history. */
export const studentArchiveSchema = `
ALTER TABLE student_profiles ADD COLUMN "archivedAt" TIMESTAMPTZ;
ALTER TABLE student_profiles ADD COLUMN "archivedBy" TEXT REFERENCES users(id);
CREATE INDEX student_profiles_archived ON student_profiles("archivedAt") WHERE "archivedAt" IS NOT NULL;
`;
