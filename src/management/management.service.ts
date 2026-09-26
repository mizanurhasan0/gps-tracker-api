import { dhakaDate, dhakaMonth } from '../common/dhaka-time';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { User } from '../auth/auth.types';
import { hashPassword } from '../auth/password';
import { DatabaseService } from '../database/database.service';
import { NotificationsService } from '../notifications/notifications.service';
import { DecisionDto } from '../payments/payments.dto';
import { journeyFare } from '../transport/journey-fare';
import {
  assertAvailableShift,
  assertScheduledAttendance,
  overlapWarnings,
  resolveSchedule,
  resolveStudent,
  scheduleSettings,
  scheduledOn,
  sharedProfileFields,
  validateDays,
} from '../transport/student-schedule';
import {
  AttendanceBatchDto,
  CreateBannerDto,
  CreateDriverDto,
  CreateLedgerDto,
  CreateMaintenanceDto,
  CreateManagementRequestDto,
  CreateNoticeDto,
  CreateStudentDto,
  ScheduleDto,
  SettingsDto,
  StopStudentServiceDto,
  UpdateBannerDto,
  UpdateDriverDto,
  UpdateMaintenanceDto,
  UpdateStudentDto,
} from './management.dto';

const profileFields = [
  'studentCode',
  'className',
  'roll',
  'photoUrl',
  'pickupAddress',
  'dropAddress',
  'emergencyContact',
] as const;
type Row = Record<string, any>;
const now = () => new Date().toISOString();

@Injectable()
export class ManagementService {
  constructor(
    private readonly db: DatabaseService,
    private readonly notifications: NotificationsService,
  ) {}

  async overview(user: User) {
    const isAdmin = user.role === 'ADMIN';
    const [
      students,
      drivers,
      attendance,
      maintenance,
      ledger,
      notices,
      banners,
      requests,
      settings,
      schedules,
    ] = await Promise.all([
      this.students(user),
      isAdmin
        ? this.drivers()
        : this.db.all(
            `SELECT d.id,d.name,d.phone,d.status,d."vehicleId",v.name "vehicleName",
        ''::text nid,''::text address,''::text "joiningDate",0 "monthlySalary",d."createdAt",NULL::text "routeName"
        FROM drivers d JOIN vehicles v ON v.id=d."vehicleId" WHERE EXISTS (SELECT 1 FROM subscriptions s
        JOIN routes r ON r.id=s."routeId" WHERE r."vehicleId"=d."vehicleId" AND s."guardianId"=$1 AND s.status='ACTIVE' AND r.active=1)`,
            user.id,
          ),
      this.db.all(
        `SELECT a.* FROM attendance a WHERE $1::boolean OR EXISTS (SELECT 1 FROM subscriptions s WHERE s.id=a."studentId" AND s."guardianId"=$2) ORDER BY a.date DESC,a.id`,
        isAdmin,
        user.id,
      ),
      isAdmin ? this.maintenance() : Promise.resolve([]),
      isAdmin
        ? this.db.all('SELECT * FROM ledger ORDER BY date DESC,"createdAt" DESC')
        : Promise.resolve([]),
      this.db.all(
        `SELECT n.* FROM notices n WHERE $1::boolean OR EXISTS (SELECT 1 FROM notice_recipients x WHERE x."noticeId"=n.id AND x."userId"=$2) ORDER BY n."createdAt" DESC`,
        isAdmin,
        user.id,
      ),
      this.banners(user),
      this.db.all(
        `SELECT q.*,u.name "userName",s."studentName" FROM management_requests q JOIN users u ON u.id=q."userId"
        LEFT JOIN subscriptions s ON s.id=q."studentId" WHERE $1::boolean OR q."userId"=$2 ORDER BY q."createdAt" DESC`,
        isAdmin,
        user.id,
      ),
      this.settings(),
      this.db.all(
        `SELECT q.* FROM route_schedules q WHERE $1::boolean OR EXISTS (SELECT 1 FROM subscriptions s JOIN routes r ON r.id=s."routeId"
        WHERE s."routeId"=q."routeId" AND s."guardianId"=$2 AND s.status='ACTIVE' AND r.active=1
        AND (q."studentId" IS NULL OR q."studentId"=s.id) AND (q."stopId" IS NULL OR q."stopId"=s."stopId")) ORDER BY q.period,q.position,q.id`,
        isAdmin,
        user.id,
      ),
    ]);
    const today = dhakaDate();
    const scheduledStudents = students.map((student) => ({
      ...student,
      scheduledToday:
        student.status === 'ACTIVE' &&
        scheduledOn(student.operatingDays, settings.operatingDays, today),
    }));
    return {
      students: scheduledStudents,
      today,
      todayStudents: scheduledStudents.filter((student) => student.scheduledToday),
      drivers,
      attendance,
      maintenance,
      ledger,
      notices,
      banners,
      requests,
      settings,
      schedules,
    };
  }

  students(user: User, id?: string, archived = false) {
    return this.db.all<Row>(
      `SELECT p.*,c."studentCode",c."className",c.roll,c."photoUrl",c."emergencyContact",c."archivedAt",c."archivedBy",s."studentId",s."shiftId",s."operatingDays",s.id "subscriptionId",s."guardianId",s."studentName",s."routeId",s."stopId",s."dropoffStopId",s."monthlyAmount",s.status,s."startedAt",s."stoppedAt",s."stoppedOn",s."stopReason",s."finalMonthlyFee",
      u.name "guardianName",u.phone "guardianPhone",r.name "routeName",t.name "stopName",d.name "dropoffStopName",v.id "vehicleId",v.name "vehicleName",
      CASE WHEN $1::text='ADMIN' OR (s.status='ACTIVE' AND r.active=1) THEN v."driverName" ELSE NULL END "driverName",
      CASE WHEN $1::text='ADMIN' OR (s.status='ACTIVE' AND r.active=1) THEN v."driverPhone" ELSE NULL END "driverPhone"
      FROM students p JOIN subscriptions s ON s.id=p.id JOIN student_profiles c ON c.id=s."studentId" JOIN users u ON u.id=s."guardianId" JOIN routes r ON r.id=s."routeId"
      JOIN stops t ON t.id=s."stopId" LEFT JOIN stops d ON d.id=s."dropoffStopId" JOIN vehicles v ON v.id=r."vehicleId" WHERE ($1::text='ADMIN' OR s."guardianId"=$2) AND ($3::text IS NULL OR s.id=$3) AND (($4::boolean AND c."archivedAt" IS NOT NULL) OR (NOT $4::boolean AND c."archivedAt" IS NULL)) ORDER BY s."studentName",s.id`,
      user.role,
      user.id,
      id ?? null,
      archived,
    );
  }

  archivedStudents(actor: User) {
    return this.students(actor, undefined, true);
  }

  async archiveStudent(actor: User, enrollmentId: string) {
    return this.write(async () => {
      const enrollment = await this.require('subscriptions', enrollmentId);
      const profile = await this.db.get<Row>(
        'SELECT * FROM student_profiles WHERE id=$1 FOR UPDATE',
        enrollment.studentId,
      );
      if (!profile) throw new NotFoundException('student profiles record not found');
      if (profile.archivedAt)
        return { studentId: profile.id, archivedAt: profile.archivedAt, affectedSubscriptions: 0 };
      if (
        await this.db.get(
          `SELECT id FROM service_requests WHERE "studentId"=$1 AND status='PENDING' LIMIT 1`,
          profile.id,
        )
      )
        throw new ConflictException('Review pending service requests before archiving this student');
      const timestamp = now();
      await this.db.run(
        'UPDATE student_profiles SET "archivedAt"=$1,"archivedBy"=$2 WHERE id=$3',
        timestamp,
        actor.id,
        profile.id,
      );
      const activeServices = await this.db.all<Row>(
        `SELECT * FROM subscriptions WHERE "studentId"=$1 AND status='ACTIVE' FOR UPDATE`,
        profile.id,
      );
      for (const service of activeServices) {
        const month = dhakaMonth();
        let bill = await this.db.get<Row>(
          'SELECT * FROM bills WHERE "subscriptionId"=$1 AND month=$2 FOR UPDATE',
          service.id,
          month,
        );
        const previousBillAmount = bill?.amount ?? null;
        let billAction = 'UNCHANGED';
        if (!bill) {
          const billId = randomUUID();
          await this.db.run(
            `INSERT INTO bills(id,"guardianId","subscriptionId",month,amount,status,"createdAt")
             VALUES($1,$2,$3,$4,$5,'UNPAID',$6)`,
            billId,
            service.guardianId,
            service.id,
            month,
            service.monthlyAmount,
            timestamp,
          );
          bill = { id: billId, amount: service.monthlyAmount };
          billAction = 'CREATED';
        }
        await this.db.run(
          `UPDATE subscriptions SET status='STOPPED',"stoppedAt"=$1,"stoppedOn"=$2,
           "stopReason"='Student archived',"finalMonthlyFee"=$3 WHERE id=$4`,
          timestamp,
          dhakaDate(),
          bill.amount,
          service.id,
        );
        await this.db.run('DELETE FROM route_schedules WHERE "studentId"=$1', service.id);
        await this.db.run(
          `INSERT INTO service_settlements(id,"subscriptionId","billId","stopDate","finalMonthlyFee",
           reason,"previousBillAmount","billAction","createdBy","createdAt")
           VALUES($1,$2,$3,$4,$5,'Student archived',$6,$7,$8,$9)`,
          randomUUID(),
          service.id,
          bill.id,
          dhakaDate(),
          bill.amount,
          previousBillAmount,
          billAction,
          actor.id,
          timestamp,
        );
      }
      await this.db.run(
        `UPDATE stop_requests q SET status='APPROVED',note='Resolved by admin while archiving the student',"reviewedAt"=$1
         WHERE q.status='PENDING' AND EXISTS(
           SELECT 1 FROM subscriptions s WHERE s.id=q."subscriptionId" AND s."studentId"=$2
         )`,
        timestamp,
        profile.id,
      );
      await this.notifications.audit(
        actor.id,
        'STUDENT_ARCHIVED',
        profile.id,
        `${activeServices.length} active subscription(s) stopped`,
      );
      return {
        studentId: profile.id,
        archivedAt: timestamp,
        affectedSubscriptions: activeServices.length,
      };
    });
  }

  async restoreStudent(actor: User, enrollmentId: string) {
    return this.write(async () => {
      const enrollment = await this.require('subscriptions', enrollmentId);
      const profile = await this.db.get<Row>(
        'SELECT * FROM student_profiles WHERE id=$1 FOR UPDATE',
        enrollment.studentId,
      );
      if (!profile) throw new NotFoundException('student profiles record not found');
      if (!profile.archivedAt)
        return { studentId: profile.id, archivedAt: null, affectedSubscriptions: 0 };
      await this.db.run(
        'UPDATE student_profiles SET "archivedAt"=NULL,"archivedBy"=NULL WHERE id=$1',
        profile.id,
      );
      await this.notifications.audit(actor.id, 'STUDENT_RESTORED', profile.id);
      return { studentId: profile.id, archivedAt: null, affectedSubscriptions: 0 };
    });
  }

  async stopStudentService(actor: User, enrollmentId: string, input: StopStudentServiceDto) {
    return this.write(async () => {
      const service = await this.db.get<Row>(
        'SELECT * FROM subscriptions WHERE id=$1 FOR UPDATE',
        enrollmentId,
      );
      if (!service) throw new NotFoundException('subscriptions record not found');
      if (service.status !== 'ACTIVE')
        throw new ConflictException('This transport service is already stopped');
      const today = dhakaDate();
      if (input.stopDate > today)
        throw new BadRequestException('Stop date cannot be in the future');
      if (input.stopDate.slice(0, 7) !== today.slice(0, 7))
        throw new BadRequestException('Stop date must be in the current billing month');
      if (input.stopDate < dhakaDate(service.startedAt))
        throw new BadRequestException('Stop date cannot be before the service start date');

      const month = input.stopDate.slice(0, 7);
      let bill = await this.db.get<Row>(
        'SELECT * FROM bills WHERE "subscriptionId"=$1 AND month=$2 FOR UPDATE',
        enrollmentId,
        month,
      );
      const previousBillAmount = bill?.amount ?? null;
      let billAction: 'NO_BILL' | 'CREATED' | 'ADJUSTED' | 'UNCHANGED';
      if (
        bill &&
        (await this.db.get(
          `SELECT id FROM payment_submissions WHERE "billId"=$1 AND status='PENDING'`,
          bill.id,
        ))
      )
        throw new ConflictException('Review the pending payment before stopping this service');
      if (!bill && input.finalMonthlyFee === 0) {
        billAction = 'NO_BILL';
      } else if (!bill) {
        const billId = randomUUID();
        await this.db.run(
          `INSERT INTO bills(id,"guardianId","subscriptionId",month,amount,status,"createdAt")
           VALUES($1,$2,$3,$4,$5,'UNPAID',$6)`,
          billId,
          service.guardianId,
          enrollmentId,
          month,
          input.finalMonthlyFee,
          now(),
        );
        bill = await this.db.get<Row>('SELECT * FROM bills WHERE id=$1', billId);
        billAction = 'CREATED';
      } else if (bill.amount === input.finalMonthlyFee) {
        billAction = 'UNCHANGED';
      } else if (bill.status === 'PAID') {
        throw new ConflictException(
          'A paid bill cannot be changed; use its paid amount as the final monthly fee',
        );
      } else {
        await this.db.run(
          `UPDATE bills SET amount=$1,status=$2 WHERE id=$3`,
          input.finalMonthlyFee,
          input.finalMonthlyFee === 0 ? 'WAIVED' : 'UNPAID',
          bill.id,
        );
        bill = {
          ...bill,
          amount: input.finalMonthlyFee,
          status: input.finalMonthlyFee === 0 ? 'WAIVED' : 'UNPAID',
        };
        billAction = 'ADJUSTED';
      }

      const timestamp = now();
      const stoppedAt = `${input.stopDate}T00:00:00+06:00`;
      await this.db.run(
        `UPDATE subscriptions SET status='STOPPED',"stoppedAt"=$1,"stoppedOn"=$2,
         "stopReason"=$3,"finalMonthlyFee"=$4 WHERE id=$5`,
        stoppedAt,
        input.stopDate,
        input.reason ?? '',
        input.finalMonthlyFee,
        enrollmentId,
      );
      await this.db.run('DELETE FROM route_schedules WHERE "studentId"=$1', enrollmentId);
      await this.db.run(
        `UPDATE stop_requests SET status='APPROVED',note='Resolved by direct admin service stop',"reviewedAt"=$1
         WHERE "subscriptionId"=$2 AND status='PENDING'`,
        timestamp,
        enrollmentId,
      );
      const settlementId = randomUUID();
      await this.db.run(
        `INSERT INTO service_settlements(id,"subscriptionId","billId","stopDate","finalMonthlyFee",
         reason,"previousBillAmount","billAction","createdBy","createdAt")
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        settlementId,
        enrollmentId,
        bill?.id ?? null,
        input.stopDate,
        input.finalMonthlyFee,
        input.reason ?? '',
        previousBillAmount,
        billAction,
        actor.id,
        timestamp,
      );
      await this.notifications.create(
        service.guardianId,
        'Transport service stopped',
        `Service stopped on ${input.stopDate}. Final monthly fee: ${this.formatTaka(input.finalMonthlyFee)}.`,
        enrollmentId,
      );
      await this.notifications.audit(
        actor.id,
        'STUDENT_SERVICE_STOPPED',
        enrollmentId,
        `${input.stopDate}; final fee ${input.finalMonthlyFee}; ${billAction}; ${input.reason ?? ''}`,
      );
      const student = (await this.students(actor, enrollmentId))[0];
      return {
        ...student,
        settlement: {
          id: settlementId,
          billId: bill?.id ?? null,
          stopDate: input.stopDate,
          finalMonthlyFee: input.finalMonthlyFee,
          reason: input.reason ?? '',
          previousBillAmount,
          billAction,
        },
        finalBill: bill ?? null,
      };
    });
  }

  async saveStudent(actor: User, input: CreateStudentDto | UpdateStudentDto, id?: string) {
    const existingId = id;
    id ??= randomUUID();
    return this.write(async () => {
      const existing = existingId ? await this.require('subscriptions', existingId) : undefined;
      if (existing) {
        const profile = await this.db.get<{ archivedAt: Date | null }>(
          'SELECT "archivedAt" FROM student_profiles WHERE id=$1',
          existing.studentId,
        );
        if (profile?.archivedAt)
          throw new ConflictException('Restore this student before updating the enrollment');
      }
      const guardianPhone = input.guardianPhone?.replace(/^(?:\+?88)/, '');
      let guardian = guardianPhone
        ? await this.db.get<{ id: string; role: string }>(
            'SELECT id,role FROM users WHERE phone=$1',
            guardianPhone,
          )
        : existing
          ? { id: existing.guardianId, role: 'GUARDIAN' }
          : undefined;
      if (guardian && guardian.role !== 'GUARDIAN')
        throw new ConflictException('This phone number belongs to a non-guardian account');
      if (existing && !guardian)
        throw new BadRequestException(
          'Guardian ownership cannot be changed; submit a new enrollment',
        );
      if (!existing && !guardianPhone) throw new BadRequestException('Guardian phone is required');
      let guardianAccountCreated = false;
      if (!guardian) {
        const passwordHash = await hashPassword('password');
        // The unique phone constraint and serializable transaction retry prevent
        // concurrent enrollments from creating or overwriting duplicate accounts.
        guardian = await this.db.get<{ id: string; role: string }>(
          `INSERT INTO users(id,name,phone,"passwordHash",role,"createdAt")
           VALUES($1,$2,$3,$4,'GUARDIAN',$5) ON CONFLICT(phone) DO NOTHING RETURNING id,role`,
          randomUUID(),
          (input as CreateStudentDto).guardianName ?? `Guardian ${guardianPhone}`,
          guardianPhone,
          passwordHash,
          now(),
        );
        guardianAccountCreated = Boolean(guardian);
        guardian ??= await this.db.get<{ id: string; role: string }>(
          'SELECT id,role FROM users WHERE phone=$1',
          guardianPhone,
        );
        if (!guardian || guardian.role !== 'GUARDIAN')
          throw new ConflictException('This phone number belongs to a non-guardian account');
      }
      if (existing && guardian.id !== existing.guardianId)
        throw new BadRequestException(
          'Guardian ownership cannot be changed; submit a new enrollment',
        );
      const routeId = input.routeId ?? existing?.routeId;
      const stopId = input.stopId ?? existing?.stopId;
      await this.coverage(routeId, stopId);
      const dropoffStopId =
        input.dropoffStopId !== undefined ? input.dropoffStopId : (existing?.dropoffStopId ?? null);
      const journeyChanged =
        !existing ||
        routeId !== existing.routeId ||
        stopId !== existing.stopId ||
        dropoffStopId !== existing.dropoffStopId;
      if (
        dropoffStopId &&
        (dropoffStopId === stopId ||
          !(await this.db.get(
            'SELECT id FROM stops WHERE id=$1 AND "routeId"=$2',
            dropoffStopId,
            routeId,
          )))
      )
        throw new BadRequestException('Select a different destination on the same route');
      const profile = await resolveStudent(
        this.db,
        guardian.id,
        input.studentName ?? existing?.studentName,
        existing?.studentId ?? (input as CreateStudentDto).studentId,
      );
      const studentName = existing
        ? (input.studentName ?? profile.studentName)
        : profile.studentName;
      const { shiftId, operatingDays } = await resolveSchedule(
        this.db,
        input,
        existing as { shiftId: string; operatingDays: number[] } | undefined,
      );
      const status = input.status ?? existing?.status ?? 'ACTIVE';
      if (existing && input.status === 'STOPPED' && existing.status === 'ACTIVE')
        throw new BadRequestException(
          'Use the stop-service action to set the stop date and final monthly fee',
        );
      if (
        existing &&
        shiftId !== existing.shiftId &&
        (existing.status === 'STOPPED' ||
          (await this.db.get('SELECT id FROM bills WHERE "subscriptionId"=$1 LIMIT 1', existingId)))
      )
        throw new ConflictException(
          'This service has billing history. Stop it and add a new enrollment to change shifts',
        );
      if (existing?.status === 'STOPPED' && status === 'ACTIVE')
        throw new BadRequestException(
          'Create a new enrollment to restart service; the stopped billing period must remain intact',
        );
      const assignedAmount = journeyChanged
        ? await journeyFare(this.db, routeId, stopId, dropoffStopId)
        : existing!.monthlyAmount;
      if (dropoffStopId && input.monthlyAmount != null && input.monthlyAmount !== assignedAmount)
        throw new BadRequestException('The monthly amount must match the assigned journey fare');
      const amount = dropoffStopId ? assignedAmount : (input.monthlyAmount ?? assignedAmount);
      if (existing && amount !== existing.monthlyAmount) {
        if (existing.status === 'STOPPED')
          throw new BadRequestException('The fare for a stopped billing period cannot be changed');
        const unbilled = await this.db.get<{ month: string }>(
          `SELECT to_char(m,'YYYY-MM') AS "month" FROM generate_series(
          date_trunc('month',$1::timestamptz AT TIME ZONE 'Asia/Dhaka'),
          date_trunc('month',now() AT TIME ZONE 'Asia/Dhaka') - interval '1 month',interval '1 month') m
          WHERE NOT EXISTS(SELECT 1 FROM bills b WHERE b."subscriptionId"=$2 AND b.month=to_char(m,'YYYY-MM')) ORDER BY m LIMIT 1`,
          existing.startedAt,
          id,
        );
        if (unbilled)
          throw new ConflictException(
            `Generate ${unbilled.month} bills before changing this fare so historical charges retain their original amount`,
          );
      }
      if (status === 'ACTIVE')
        await assertAvailableShift(this.db, profile.id, shiftId, existing?.requestId, existingId);
      const warnings = await overlapWarnings(
        this.db,
        profile.id,
        shiftId,
        operatingDays,
        existingId,
      );
      const timestamp = now();
      if (!existingId) {
        const requestId = randomUUID();
        await this.db.run(
          `INSERT INTO service_requests(id,"guardianId","studentName","routeId","stopId",status,"createdAt","reviewedAt","reviewedBy","dropoffStopId","monthlyAmount","studentId","shiftId","operatingDays")
          VALUES($1,$2,$3,$4,$5,'APPROVED',$6,$6,$7,$8,$9,$10,$11,$12)`,
          requestId,
          guardian.id,
          studentName,
          routeId,
          stopId,
          timestamp,
          actor.id,
          dropoffStopId,
          amount,
          profile.id,
          shiftId,
          operatingDays,
        );
        await this.db.run(
          `INSERT INTO subscriptions(id,"guardianId","requestId","studentName","routeId","stopId","monthlyAmount",status,"startedAt","stoppedAt","dropoffStopId","studentId","shiftId","operatingDays")
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          id,
          guardian.id,
          requestId,
          studentName,
          routeId,
          stopId,
          amount,
          status,
          timestamp,
          status === 'STOPPED' ? timestamp : null,
          dropoffStopId,
          profile.id,
          shiftId,
          operatingDays,
        );
        await this.db.run('UPDATE users SET verified=1 WHERE id=$1', guardian.id);
      } else {
        await this.db.run(
          `UPDATE subscriptions SET "studentName"=$1,"routeId"=$2,"stopId"=$3,"monthlyAmount"=$4,status=$5,"stoppedAt"=$6,"dropoffStopId"=$8,"shiftId"=$9,"operatingDays"=$10 WHERE id=$7`,
          studentName,
          routeId,
          stopId,
          amount,
          status,
          status === 'STOPPED' ? (existing?.stoppedAt ?? timestamp) : null,
          id,
          dropoffStopId,
          shiftId,
          operatingDays,
        );
      }
      await this.db.run(
        `UPDATE student_profiles SET "studentName"=$1,${sharedProfileFields.map((field, i) => `"${field}"=$${i + 2}`).join(',')} WHERE id=$7`,
        studentName,
        ...sharedProfileFields.map((field) => input[field] ?? profile[field]),
        profile.id,
      );
      await this.db.run(
        'UPDATE subscriptions SET "studentName"=$1 WHERE "studentId"=$2',
        studentName,
        profile.id,
      );
      await this.db.run(
        `UPDATE service_requests SET "studentName"=$1,${sharedProfileFields.map((field, i) => `"${field}"=$${i + 2}`).join(',')} WHERE "studentId"=$7`,
        studentName,
        ...sharedProfileFields.map((field) => input[field] ?? profile[field]),
        profile.id,
      );
      const old = await this.require('students', id);
      await this.db.run(
        `UPDATE students SET ${profileFields.map((f, i) => `"${f}"=$${i + 1}`).join(',')} WHERE id=$8`,
        ...profileFields.map(
          (f) =>
            input[f] ??
            (sharedProfileFields.includes(f as any)
              ? profile[f as (typeof sharedProfileFields)[number]]
              : old[f]) ??
            '',
        ),
        id,
      );
      if (!existingId)
        await this.db.run(
          `UPDATE service_requests SET ${profileFields.map((f, i) => `"${f}"=$${i + 1}`).join(',')} WHERE id=(SELECT "requestId" FROM subscriptions WHERE id=$8)`,
          ...profileFields.map((f) => input[f] ?? ''),
          id,
        );
      await this.notifications.audit(
        actor.id,
        existing ? 'STUDENT_UPDATED' : 'STUDENT_CREATED',
        id,
      );
      const student = (await this.students(actor, id))[0];
      return existingId
        ? { ...student, warnings }
        : { ...student, guardianAccountCreated, warnings };
    });
  }

  drivers(id?: string) {
    return this.db.all<Row>(
      `SELECT d.*,v.name "vehicleName",(SELECT string_agg(r.name,', ' ORDER BY r.name) FROM routes r WHERE r."vehicleId"=d."vehicleId" AND r.active=1) "routeName"
      FROM drivers d LEFT JOIN vehicles v ON v.id=d."vehicleId" WHERE ($1::text IS NULL OR d.id=$1) ORDER BY d.name,d.id`,
      id ?? null,
    );
  }
  async saveDriver(actor: User, input: CreateDriverDto | UpdateDriverDto, id?: string) {
    const existingId = id;
    id ??= randomUUID();
    return this.write(async () => {
      const existing = existingId ? await this.require('drivers', existingId) : undefined;
      const value = {
        ...{
          nid: '',
          address: '',
          joiningDate: '',
          monthlySalary: 0,
          status: 'ACTIVE',
          vehicleId: null,
        },
        ...existing,
        ...input,
      };
      if (value.vehicleId) await this.require('vehicles', value.vehicleId);
      if (existing?.vehicleId && existing.vehicleId !== value.vehicleId)
        await this.db.run(
          'UPDATE vehicles SET "driverName"=NULL,"driverPhone"=NULL,"updatedAt"=$1 WHERE id=$2',
          now(),
          existing.vehicleId,
        );
      await this.db.run(
        `INSERT INTO drivers(id,name,phone,nid,address,"joiningDate","monthlySalary",status,"vehicleId","createdAt")
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,phone=EXCLUDED.phone,nid=EXCLUDED.nid,address=EXCLUDED.address,
        "joiningDate"=EXCLUDED."joiningDate","monthlySalary"=EXCLUDED."monthlySalary",status=EXCLUDED.status,"vehicleId"=EXCLUDED."vehicleId"`,
        id,
        value.name,
        value.phone,
        value.nid,
        value.address,
        value.joiningDate,
        value.monthlySalary,
        value.status,
        value.vehicleId,
        existing?.createdAt ?? now(),
      );
      if (value.vehicleId)
        await this.db.run(
          'UPDATE vehicles SET "driverName"=$1,"driverPhone"=$2,"updatedAt"=$3 WHERE id=$4',
          value.name,
          value.phone,
          now(),
          value.vehicleId,
        );
      await this.notifications.audit(actor.id, existing ? 'DRIVER_UPDATED' : 'DRIVER_CREATED', id);
      return (await this.drivers(id))[0];
    });
  }

  async attendance(actor: User, input: AttendanceBatchDto) {
    return this.write(async () => {
      const seen = new Set<string>();
      for (const entry of input.entries) {
        if (Boolean(entry.studentId) === Boolean(entry.driverId))
          throw new BadRequestException('Provide exactly one studentId or driverId');
        const key = `${entry.studentId ?? entry.driverId}:${entry.date}`;
        if (seen.has(key)) throw new BadRequestException('Duplicate attendance entry');
        seen.add(key);
        const field = entry.studentId ? 'studentId' : 'driverId';
        const personId = entry.studentId ?? entry.driverId!;
        await this.require(entry.studentId ? 'students' : 'drivers', personId);
        if (entry.studentId) await assertScheduledAttendance(this.db, personId, entry.date);
        await this.db.run(
          `INSERT INTO attendance(id,"${field}",date,status,note,"updatedAt","recordedBy") VALUES($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT("${field}",date) WHERE "${field}" IS NOT NULL DO UPDATE SET status=EXCLUDED.status,note=EXCLUDED.note,"updatedAt"=EXCLUDED."updatedAt","recordedBy"=EXCLUDED."recordedBy"`,
          randomUUID(),
          personId,
          entry.date,
          entry.status,
          entry.note ?? '',
          now(),
          actor.id,
        );
      }
      await this.notifications.audit(
        actor.id,
        'ATTENDANCE_SAVED',
        actor.id,
        `${input.entries.length} records`,
      );
      return { saved: input.entries.length };
    });
  }

  maintenance(id?: string) {
    return this.db.all<Row>(
      `SELECT m.*,v.name "vehicleName" FROM maintenance m JOIN vehicles v ON v.id=m."vehicleId" WHERE ($1::text IS NULL OR m.id=$1) ORDER BY m."serviceDate" DESC,m.id`,
      id ?? null,
    );
  }
  async saveMaintenance(
    actor: User,
    input: CreateMaintenanceDto | UpdateMaintenanceDto,
    id?: string,
  ) {
    const existingId = id;
    id ??= randomUUID();
    return this.write(async () => {
      const existing = existingId ? await this.require('maintenance', existingId) : undefined;
      const value: Row = {
        description: '',
        nextServiceDate: null,
        status: 'PLANNED',
        ...existing,
        ...input,
      };
      if (value.nextServiceDate && value.nextServiceDate < value.serviceDate)
        throw new BadRequestException('Next service must not precede service date');
      await this.require('vehicles', value.vehicleId);
      await this.db.run(
        `INSERT INTO maintenance(id,"vehicleId",title,description,"serviceDate","nextServiceDate",amount,status,"createdAt")
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO UPDATE SET "vehicleId"=EXCLUDED."vehicleId",title=EXCLUDED.title,description=EXCLUDED.description,
        "serviceDate"=EXCLUDED."serviceDate","nextServiceDate"=EXCLUDED."nextServiceDate",amount=EXCLUDED.amount,status=EXCLUDED.status`,
        id,
        value.vehicleId,
        value.title,
        value.description,
        value.serviceDate,
        value.nextServiceDate,
        value.amount,
        value.status,
        existing?.createdAt ?? now(),
      );
      // Only completed service costs are actual expenses. Updating keeps one linked entry.
      if (value.status === 'COMPLETED' && value.amount > 0) {
        await this.db.run(
          `INSERT INTO ledger(id,type,category,title,amount,date,note,"vehicleId","maintenanceId","createdBy","createdAt")
          VALUES($1,'EXPENSE','MAINTENANCE',$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT("maintenanceId") DO UPDATE SET title=EXCLUDED.title,amount=EXCLUDED.amount,date=EXCLUDED.date,note=EXCLUDED.note,"vehicleId"=EXCLUDED."vehicleId"`,
          randomUUID(),
          value.title,
          value.amount,
          value.serviceDate,
          value.description,
          value.vehicleId,
          id,
          actor.id,
          now(),
        );
      } else await this.db.run('DELETE FROM ledger WHERE "maintenanceId"=$1', id);
      const vehicleIds = new Set<string>([
        value.vehicleId,
        ...(existing ? [existing.vehicleId] : []),
      ]);
      for (const vehicleId of vehicleIds)
        await this.db.run(
          `UPDATE vehicles SET status=CASE WHEN EXISTS(SELECT 1 FROM maintenance WHERE "vehicleId"=$1 AND status='IN_PROGRESS') THEN 'MAINTENANCE'
        WHEN status='MAINTENANCE' THEN 'RUNNING' ELSE status END,"updatedAt"=$2 WHERE id=$1`,
          vehicleId,
          now(),
        );
      await this.notifications.audit(
        actor.id,
        existing ? 'MAINTENANCE_UPDATED' : 'MAINTENANCE_CREATED',
        id,
      );
      return (await this.maintenance(id))[0];
    });
  }

  async ledger(actor: User, input: CreateLedgerDto) {
    return this.write(async () => {
      if (input.category === 'SALARY' && (input.type !== 'EXPENSE' || !input.driverId))
        throw new BadRequestException('Salary expenses require a driver');
      if (input.vehicleId) await this.require('vehicles', input.vehicleId);
      if (input.driverId) await this.require('drivers', input.driverId);
      const id = randomUUID();
      await this.db.run(
        `INSERT INTO ledger(id,type,category,title,amount,date,note,"vehicleId","driverId","createdBy","createdAt") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        id,
        input.type,
        input.category,
        input.title,
        input.amount,
        input.date,
        input.note ?? '',
        input.vehicleId ?? null,
        input.driverId ?? null,
        actor.id,
        now(),
      );
      await this.notifications.audit(actor.id, 'LEDGER_CREATED', id);
      return this.require('ledger', id);
    });
  }

  async notice(actor: User, input: CreateNoticeDto) {
    return this.write(async () => {
      if (input.audience !== 'ALL' && !input.targetId)
        throw new BadRequestException('A target is required for this notice');
      if (input.audience === 'ALL' && input.targetId)
        throw new BadRequestException('An all-guardian notice must not have a target');
      if (input.audience !== 'ALL')
        await this.require(
          ({ ROUTE: 'routes', VEHICLE: 'vehicles', STUDENT: 'students' } as const)[input.audience],
          input.targetId!,
        );
      const recipients = await this.db.all<{ id: string }>(
        `SELECT DISTINCT u.id FROM users u WHERE u.role='GUARDIAN' AND ($1::text='ALL' OR EXISTS(
        SELECT 1 FROM subscriptions s JOIN routes r ON r.id=s."routeId" WHERE s."guardianId"=u.id AND s.status='ACTIVE' AND
        (($1='STUDENT' AND s.id=$2) OR ($1='ROUTE' AND s."routeId"=$2) OR ($1='VEHICLE' AND r."vehicleId"=$2))))`,
        input.audience,
        input.targetId ?? null,
      );
      const id = randomUUID();
      await this.db.run(
        'INSERT INTO notices(id,title,body,category,audience,"targetId","createdBy","createdAt") VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        id,
        input.title,
        input.body,
        input.category,
        input.audience,
        input.targetId ?? null,
        actor.id,
        now(),
      );
      for (const recipient of recipients) {
        await this.db.run(
          'INSERT INTO notice_recipients("noticeId","userId") VALUES($1,$2)',
          id,
          recipient.id,
        );
        await this.notifications.create(recipient.id, input.title, input.body, id);
      }
      await this.notifications.audit(
        actor.id,
        'NOTICE_SENT',
        id,
        `${recipients.length} in-app recipients`,
      );
      return { ...(await this.require('notices', id)), recipientCount: recipients.length };
    });
  }

  async banners(user: User) {
    const isAdmin = user.role === 'ADMIN';
    return this.db.all<Row>(
      `SELECT id,"imageUrl","redirectRoute","sortOrder","sliderDuration",active,"createdAt","updatedAt"
       FROM banners
       WHERE ($1::boolean OR (active=1 AND "imageUrl" <> '' AND "redirectRoute" <> ''))
       ORDER BY "sortOrder" ASC,"createdAt" DESC`,
      isAdmin,
    );
  }

  private async bannerView(id: string) {
    const banner = await this.db.get<Row>(
      `SELECT id,"imageUrl","redirectRoute","sortOrder","sliderDuration",active,"createdAt","updatedAt"
       FROM banners WHERE id=$1`,
      id,
    );
    if (!banner) throw new NotFoundException('Banner not found');
    return banner;
  }

  async saveBanner(actor: User, input: CreateBannerDto | UpdateBannerDto, existingId?: string) {
    return this.write(async () => {
      const existing = existingId ? await this.require('banners', existingId) : undefined;
      const id = existingId ?? randomUUID();
      const timestamp = now();
      const values = {
        imageUrl: input.imageUrl ?? existing?.imageUrl ?? '',
        redirectRoute: input.redirectRoute ?? existing?.redirectRoute ?? '',
        sortOrder: input.sortOrder ?? existing?.sortOrder ?? 0,
        sliderDuration:
          input.sliderDuration === undefined
            ? (existing?.sliderDuration ?? null)
            : input.sliderDuration,
        active: input.active === undefined ? (existing?.active ?? 1) : input.active ? 1 : 0,
      };
      if (existing) {
        await this.db.run(
          `UPDATE banners SET "imageUrl"=$1,"redirectRoute"=$2,"sortOrder"=$3,"sliderDuration"=$4,active=$5,"updatedAt"=$6
           WHERE id=$7`,
          values.imageUrl,
          values.redirectRoute,
          values.sortOrder,
          values.sliderDuration,
          values.active,
          timestamp,
          id,
        );
      } else {
        await this.db.run(
          `INSERT INTO banners(id,"imageUrl","redirectRoute","sortOrder","sliderDuration",active,"createdBy","createdAt","updatedAt")
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
          id,
          values.imageUrl,
          values.redirectRoute,
          values.sortOrder,
          values.sliderDuration,
          values.active,
          actor.id,
          timestamp,
        );
      }
      await this.notifications.audit(actor.id, existing ? 'BANNER_UPDATED' : 'BANNER_CREATED', id);
      return this.bannerView(id);
    });
  }

  async deleteBanner(actor: User, id: string) {
    return this.write(async () => {
      await this.require('banners', id);
      await this.db.run('DELETE FROM banners WHERE id=$1', id);
      await this.notifications.audit(actor.id, 'BANNER_DELETED', id);
      return { id };
    });
  }

  async request(user: User, input: CreateManagementRequestDto) {
    return this.write(async () => {
      if (input.studentId) {
        const student = await this.require('subscriptions', input.studentId);
        if (
          user.role !== 'ADMIN' &&
          (student.guardianId !== user.id || student.status !== 'ACTIVE')
        )
          throw new ForbiddenException('This student is not assigned to you');
      }
      if (user.role !== 'ADMIN' && (input.driverId || input.vehicleId))
        throw new ForbiddenException('Guardians submit requests for their own students');
      if (user.role !== 'ADMIN' && !input.studentId)
        throw new BadRequestException('Select your student');
      if (input.driverId) await this.require('drivers', input.driverId);
      if (input.vehicleId) await this.require('vehicles', input.vehicleId);
      if (['ABSENCE', 'LEAVE'].includes(input.category) && !input.date)
        throw new BadRequestException('A date is required for absence or leave');
      if (input.category === 'ABSENCE' && !input.studentId)
        throw new BadRequestException('Absence requires a student');
      if (input.category === 'LEAVE' && !input.studentId && !input.driverId)
        throw new BadRequestException('Leave requires a student or driver');
      if (['ABSENCE', 'LEAVE'].includes(input.category) && input.studentId && input.driverId)
        throw new BadRequestException('Select one person for absence or leave');
      if (input.studentId && input.date && ['ABSENCE', 'LEAVE'].includes(input.category))
        await assertScheduledAttendance(this.db, input.studentId, input.date);
      const id = randomUUID();
      await this.db.run(
        `INSERT INTO management_requests(id,"userId","studentId","driverId","vehicleId",category,title,description,date,"createdAt") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        id,
        user.id,
        input.studentId ?? null,
        input.driverId ?? null,
        input.vehicleId ?? null,
        input.category,
        input.title,
        input.description,
        input.date ?? null,
        now(),
      );
      await this.notifications.admins('নতুন রিকোয়েস্ট', input.title, id);
      await this.notifications.audit(user.id, 'MANAGEMENT_REQUEST_CREATED', id);
      return this.require('management_requests', id);
    });
  }
  async decision(actor: User, id: string, input: DecisionDto) {
    return this.write(async () => {
      if (input.decision === 'REJECTED' && !input.note?.trim())
        throw new BadRequestException('Please explain the rejection');
      const request = await this.require('management_requests', id);
      if (request.status !== 'PENDING')
        throw new ConflictException('This request has already been reviewed');
      await this.db.run(
        'UPDATE management_requests SET status=$1,note=$2,"reviewedAt"=$3,"reviewedBy"=$4 WHERE id=$5',
        input.decision,
        input.note ?? '',
        now(),
        actor.id,
        id,
      );
      if (
        input.decision === 'APPROVED' &&
        ['ABSENCE', 'LEAVE'].includes(request.category) &&
        request.date
      ) {
        await this.attendance(actor, {
          entries: [
            {
              studentId: request.studentId ?? undefined,
              driverId: request.driverId ?? undefined,
              date: request.date,
              status: request.category === 'ABSENCE' ? 'ABSENT' : 'LEAVE',
              note: request.description,
            },
          ],
        });
      }
      await this.notifications.create(
        request.userId,
        input.decision === 'APPROVED' ? 'রিকোয়েস্ট অনুমোদিত' : 'রিকোয়েস্ট প্রত্যাখ্যাত',
        input.note || request.title,
        id,
      );
      await this.notifications.audit(
        actor.id,
        `MANAGEMENT_REQUEST_${input.decision}`,
        id,
        input.note,
      );
      return this.require('management_requests', id);
    });
  }

  async settings() {
    return scheduleSettings(this.db);
  }
  async updateSettings(actor: User, input: SettingsDto) {
    return this.write(async () => {
      if (Object.values(input).some((value) => value === null))
        throw new BadRequestException('Settings values cannot be null');
      if (input.operatingDays !== undefined) validateDays(input.operatingDays);
      if (input.transportShifts !== undefined) {
        if (
          !Array.isArray(input.transportShifts) ||
          !input.transportShifts.length ||
          new Set(input.transportShifts.map((shift) => shift.id)).size !==
            input.transportShifts.length
        )
          throw new BadRequestException('Configure at least one shift with unique IDs');
        for (const shift of input.transportShifts)
          if (shift.startTime >= shift.endTime)
            throw new BadRequestException('A shift must finish after it starts on the same day');
        const used = await this.db.all<{ shiftId: string }>(
          `SELECT "shiftId" FROM subscriptions UNION SELECT "shiftId" FROM service_requests`,
        );
        if (used.some((row) => !input.transportShifts!.some((shift) => shift.id === row.shiftId)))
          throw new ConflictException(
            'A shift referenced by a student or request cannot be removed',
          );
      }
      await this.db.run(
        'UPDATE business_settings SET data=data || $1::jsonb WHERE id=1',
        JSON.stringify(input),
      );
      await this.notifications.audit(actor.id, 'SETTINGS_UPDATED', actor.id);
      return this.settings();
    });
  }
  async schedule(actor: User, routeId: string, input: ScheduleDto) {
    return this.write(async () => {
      await this.require('routes', routeId);
      const positions = new Set<string>();
      for (const entry of input.entries) {
        if (positions.has(`${entry.period}:${entry.position}`))
          throw new BadRequestException('Schedule positions must be unique within each period');
        positions.add(`${entry.period}:${entry.position}`);
        if (entry.stopId && (await this.require('stops', entry.stopId)).routeId !== routeId)
          throw new BadRequestException('Stop belongs to another route');
        if (entry.studentId) {
          const student = await this.require('subscriptions', entry.studentId);
          if (
            student.routeId !== routeId ||
            student.status !== 'ACTIVE' ||
            (entry.stopId && student.stopId !== entry.stopId)
          )
            throw new BadRequestException('Student is not assigned to this route and stop');
        }
      }
      await this.db.run('DELETE FROM route_schedules WHERE "routeId"=$1', routeId);
      for (const entry of input.entries)
        await this.db.run(
          'INSERT INTO route_schedules(id,"routeId","stopId","studentId",label,time,period,position) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          randomUUID(),
          routeId,
          entry.stopId ?? null,
          entry.studentId ?? null,
          entry.label,
          entry.time,
          entry.period,
          entry.position,
        );
      await this.notifications.audit(actor.id, 'ROUTE_SCHEDULE_UPDATED', routeId);
      return this.db.all(
        'SELECT * FROM route_schedules WHERE "routeId"=$1 ORDER BY period,position',
        routeId,
      );
    });
  }

  async report(month: string) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
      throw new BadRequestException('Month must be YYYY-MM');
    return this.db.transaction(async () => {
      const billing = await this.db.get<Row>(
        `SELECT COALESCE(sum(amount) FILTER(WHERE month=$1),0)::float8 expected,
        COALESCE(sum(amount) FILTER(WHERE month=$1 AND status='PAID'),0)::float8 paid,
        COALESCE(sum(amount) FILTER(WHERE month=$1 AND status='UNPAID'),0)::float8 due,
        COALESCE(sum(amount) FILTER(WHERE month<$1 AND status='UNPAID'),0)::float8 "previousDue" FROM bills`,
        month,
      );
      const ledger = await this.db.all<Row>(
        'SELECT * FROM ledger WHERE left(date,7)=$1 ORDER BY date DESC,"createdAt" DESC',
        month,
      );
      const students = await this.db.get<Row>(
        `SELECT count(DISTINCT s."studentId")::int total,count(DISTINCT s."studentId") FILTER(WHERE s.status='ACTIVE')::int active
         FROM subscriptions s JOIN student_profiles p ON p.id=s."studentId" WHERE p."archivedAt" IS NULL`,
      );
      const drivers = await this.db.get<{ count: number }>(
        'SELECT count(*)::int count FROM drivers',
      );
      const vehicles = await this.db.get<{ count: number }>(
        'SELECT count(*)::int count FROM vehicles',
      );
      const attendance = await this.db.get<Row>(
        `SELECT count(*) FILTER(WHERE status='PRESENT')::int present,count(*) FILTER(WHERE status='ABSENT')::int absent,count(*) FILTER(WHERE status='LEAVE')::int leave FROM attendance WHERE left(date,7)=$1`,
        month,
      );
      const fare = await this.db.get<{ amount: number }>(
        `SELECT COALESCE(sum(amount),0)::float8 amount FROM bills WHERE status='PAID' AND to_char("paidAt"::timestamptz AT TIME ZONE 'Asia/Dhaka','YYYY-MM')=$1`,
        month,
      );
      const sum = (type: string) =>
        ledger.filter((x) => x.type === type).reduce((a, b) => a + b.amount, 0);
      const cashflow = {
        fareReceived: fare!.amount,
        otherIncome: sum('INCOME'),
        expenses: sum('EXPENSE'),
        investment: sum('INVESTMENT'),
        net: fare!.amount + sum('INCOME') - sum('EXPENSE'),
      };
      return {
        month,
        billing,
        cashflow,
        students,
        drivers: drivers!.count,
        vehicles: vehicles!.count,
        attendance,
        ledger,
      };
    });
  }

  private async coverage(routeId: string, stopId: string) {
    const route = await this.db.get<Row>(
      'SELECT r.* FROM routes r JOIN stops s ON s."routeId"=r.id WHERE r.id=$1 AND s.id=$2 AND r.active=1',
      routeId,
      stopId,
    );
    if (!route) throw new BadRequestException('Select a stop on an active route');
    return route;
  }
  private formatTaka(poisha: number) {
    return `৳${(poisha / 100).toLocaleString('en-BD', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }
  private async require(table: string, id: string): Promise<Row> {
    // Table identifiers only come from hard-coded service calls; values remain parameterized.
    const row = await this.db.get<Row>(`SELECT * FROM ${table} WHERE id=$1`, id);
    if (!row) throw new NotFoundException(`${table.replace(/_/g, ' ')} record not found`);
    return row;
  }
  private async write<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await this.db.transaction(work);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === '23505') throw new ConflictException('This record or assignment already exists');
      if (code === '23503') throw new BadRequestException('A referenced record does not exist');
      if (code === '23514' || code === '23502')
        throw new BadRequestException('Invalid record values');
      throw error;
    }
  }
}
