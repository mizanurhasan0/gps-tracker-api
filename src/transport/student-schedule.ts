import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.service';

export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
export const DEFAULT_SHIFTS = [
  { id: 'MORNING', name: 'Morning', startTime: '07:00', endTime: '11:00' },
  { id: 'DAY', name: 'Day', startTime: '11:00', endTime: '15:00' },
  { id: 'EVENING', name: 'Evening', startTime: '15:00', endTime: '19:00' },
];
export const sharedProfileFields = [
  'studentCode',
  'className',
  'roll',
  'photoUrl',
  'emergencyContact',
] as const;
export type StudentProfile = {
  id: string;
  guardianId: string;
  studentName: string;
  archivedAt: Date | null;
} & Record<
  (typeof sharedProfileFields)[number],
  string
>;
export function validateDays(days: unknown): asserts days is number[] {
  if (
    !Array.isArray(days) ||
    !days.length ||
    days.length > 7 ||
    new Set(days).size !== days.length ||
    days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)
  )
    throw new BadRequestException(
      'Select one or more unique weekdays (0=Sunday through 6=Saturday)',
    );
}
export async function scheduleSettings(db: DatabaseService) {
  const row = await db.get<{ data: Record<string, any> }>(
    'SELECT data FROM business_settings WHERE id=1',
  );
  return { operatingDays: ALL_DAYS, transportShifts: DEFAULT_SHIFTS, ...row?.data };
}
export async function resolveSchedule(
  db: DatabaseService,
  input: { shiftId?: string; operatingDays?: number[] },
  existing?: { shiftId: string; operatingDays: number[] },
) {
  const settings = await scheduleSettings(db);
  const shiftId =
    input.shiftId === undefined
      ? (existing?.shiftId ?? settings.transportShifts[0]?.id)
      : input.shiftId;
  if (!settings.transportShifts.some((shift: { id: string }) => shift.id === shiftId))
    throw new BadRequestException('Select a configured transport shift');
  const operatingDays =
    input.operatingDays === undefined
      ? (existing?.operatingDays ?? settings.operatingDays)
      : input.operatingDays;
  validateDays(operatingDays);
  if (!operatingDays.some((day) => settings.operatingDays.includes(day)))
    throw new BadRequestException('Select at least one day when the institute operates');
  return { shiftId: shiftId as string, operatingDays: [...operatingDays].sort() };
}
export async function resolveStudent(
  db: DatabaseService,
  guardianId: string,
  name: string,
  studentId?: string,
): Promise<StudentProfile> {
  if (studentId) {
    const profile = await db.get<StudentProfile>(
      'SELECT * FROM student_profiles WHERE id=$1 AND "guardianId"=$2',
      studentId,
      guardianId,
    );
    if (!profile) throw new ForbiddenException('This student does not belong to this guardian');
    if (profile.archivedAt)
      throw new ConflictException('This student is archived. Restore the student before enrolling');
    return profile;
  }
  // A name is only a duplicate warning. Reuse an existing student through their explicit ID.
  const match = await db.get<StudentProfile>(
    'SELECT * FROM student_profiles WHERE "guardianId"=$1 AND lower(trim("studentName"))=lower(trim($2))',
    guardianId,
    name,
  );
  if (match) {
    if (match.archivedAt)
      throw new ConflictException('This student is archived. Restore the student before enrolling');
    // Backward-compatible reapplication after all of the student's services ended.
    if (
      await db.get(
        `SELECT 1 FROM subscriptions WHERE "studentId"=$1 AND status='ACTIVE' UNION ALL SELECT 1 FROM service_requests WHERE "studentId"=$1 AND status='PENDING' LIMIT 1`,
        match.id,
      )
    )
      throw new ConflictException(
        'This student already exists. Select the existing student to add a different shift',
      );
    return match;
  }
  const id = randomUUID();
  await db.run(
    'INSERT INTO student_profiles(id,"guardianId","studentName") VALUES($1,$2,$3)',
    id,
    guardianId,
    name,
  );
  return (await db.get<StudentProfile>('SELECT * FROM student_profiles WHERE id=$1', id))!;
}
export async function assertAvailableShift(
  db: DatabaseService,
  studentId: string,
  shiftId: string,
  excludeRequestId?: string,
  excludeSubscriptionId?: string,
) {
  if (
    await db.get(
      `SELECT id FROM subscriptions WHERE "studentId"=$1 AND "shiftId"=$2 AND status='ACTIVE' AND ($3::text IS NULL OR id<>$3)`,
      studentId,
      shiftId,
      excludeSubscriptionId ?? null,
    )
  )
    throw new ConflictException('This student already has an active service in this shift');
  if (
    await db.get(
      `SELECT id FROM service_requests WHERE "studentId"=$1 AND "shiftId"=$2 AND status='PENDING' AND ($3::text IS NULL OR id<>$3)`,
      studentId,
      shiftId,
      excludeRequestId ?? null,
    )
  )
    throw new ConflictException('This student already has a pending request in this shift');
}
export function scheduledOn(operatingDays: number[], instituteDays: number[], date: string) {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  return operatingDays.includes(weekday) && instituteDays.includes(weekday);
}
export async function assertScheduledAttendance(
  db: DatabaseService,
  enrollmentId: string,
  date: string,
) {
  const service = await db.get<{
    operatingDays: number[];
    status: string;
    stoppedOn: string | null;
  }>('SELECT "operatingDays",status,"stoppedOn" FROM subscriptions WHERE id=$1', enrollmentId);
  const settings = await scheduleSettings(db);
  if (
    !service ||
    (service.status !== 'ACTIVE' && (!service.stoppedOn || date > service.stoppedOn)) ||
    !scheduledOn(service.operatingDays, settings.operatingDays, date)
  )
    throw new BadRequestException('This student has no scheduled transport on the selected day');
}
export async function overlapWarnings(
  db: DatabaseService,
  studentId: string,
  shiftId: string,
  days: number[],
  excludedId?: string,
) {
  const settings = await scheduleSettings(db);
  const shift = settings.transportShifts.find((s: { id: string }) => s.id === shiftId);
  if (!shift) return [];
  const services = await db.all<{ id: string; shiftId: string; operatingDays: number[] }>(
    `SELECT id,"shiftId","operatingDays" FROM subscriptions WHERE "studentId"=$1 AND status='ACTIVE' UNION ALL SELECT id,"shiftId","operatingDays" FROM service_requests WHERE "studentId"=$1 AND status='PENDING'`,
    studentId,
  );
  return services
    .filter(
      (service) =>
        service.id !== excludedId &&
        service.shiftId !== shiftId &&
        service.operatingDays.some(
          (day) => days.includes(day) && settings.operatingDays.includes(day),
        ),
    )
    .flatMap((service) => {
      const other = settings.transportShifts.find((s: { id: string }) => s.id === service.shiftId);
      return other && shift.startTime < other.endTime && other.startTime < shift.endTime
        ? [`Transport times overlap with ${other.name}`]
        : [];
    });
}
