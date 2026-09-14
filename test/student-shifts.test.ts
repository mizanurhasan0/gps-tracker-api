import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.HISTORY_TEST_DATABASE_URL;
type Row = Record<string, any>;
test('student shifts, weekly travel and cross-table concurrency HTTP integration', { skip: !databaseUrl }, async t => {
  const schema = `student_shifts_${randomUUID().replaceAll('-', '')}`;
  const setup = new Pool({ connectionString: databaseUrl });
  await setup.query(`CREATE SCHEMA ${schema}`);
  const isolated = new URL(databaseUrl!);
  isolated.searchParams.set('options', `-c search_path=${schema}`);
  process.env.DATABASE_URL = isolated.toString();
  process.env.ADMIN_PHONE = '01700000001';
  process.env.ADMIN_PASSWORD = 'student-shifts-admin-password';
  const { SecurityModule } = require('../dist/auth/security.module');
  const { TransportModule } = require('../dist/transport/transport.module');
  const { VehiclesModule } = require('../dist/vehicles/vehicles.module');
  const { DatabaseService } = require('../dist/database/database.service');
  class TestApp {}
  Module({ imports: [SecurityModule, TransportModule, VehiclesModule] })(TestApp);
  const app = await NestFactory.create(TestApp, { logger: false });
  t.after(async () => { await app.close(); await setup.query(`DROP SCHEMA ${schema} CASCADE`); await setup.end(); });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  const origin = await app.getUrl();
  const db = app.get(DatabaseService);
  async function raw(path: string, token?: string, body?: unknown, method = 'GET') {
    const response = await fetch(`${origin}${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  }
  async function request(path: string, token?: string, body?: unknown, method = 'GET', status = 200): Promise<any> {
    const result = await raw(path, token, body, method);
    assert.equal(result.status, status, `${method} ${path}: ${JSON.stringify(result.data)}`);
    return result.data;
  }
  const admin = await request('/auth/login', undefined, { phone: process.env.ADMIN_PHONE, password: process.env.ADMIN_PASSWORD }, 'POST');
  const guardian = await request('/auth/register', undefined, { name: 'Shift Guardian', phone: '01700000002', password: 'guardian-password' }, 'POST', 201);
  const other = await request('/auth/register', undefined, { name: 'Other Guardian', phone: '01700000003', password: 'guardian-password' }, 'POST', 201);
  const vehicle = await request('/vehicles', admin.token, { name: 'Shift van', plate: 'SHIFT-01', imei: '868720065798376' }, 'POST', 201);
  const route = await request('/admin/routes', admin.token, { name: 'Shift route', vehicleId: vehicle.id, monthlyAmount: 200000, stops: ['Home', 'School'] }, 'POST', 201);
  const route2 = await request('/admin/routes', admin.token, { name: 'Second route', vehicleId: vehicle.id, monthlyAmount: 250000, stops: ['Home', 'Institute'] }, 'POST', 201);
  const form = (extra: Row = {}) => ({ studentName: 'Shift Child', routeId: route.id, stopId: route.stops[0].id, ...extra });
  const enroll = (extra: Row, status = 201) => request('/admin/students', admin.token, form({ guardianPhone: guardian.user.phone, ...extra }), 'POST', status);
  const apply = (extra: Row, status = 201, token = guardian.token) => request('/requests/guardian/new', token, form(extra), 'POST', status);
  let morning: Row;
  let day: Row;
  let settings: Row;
  await t.test('fresh defaults exclude Friday and selected student profile is shared across shifts', async () => {
    settings = (await request('/management/overview', guardian.token)).settings;
    assert.deepEqual(settings.operatingDays, [0, 1, 2, 3, 4, 6]);
    morning = await enroll({ className: 'Class 4', roll: '12', pickupAddress: 'Home', operatingDays: [0, 1, 3] });
    assert.ok(morning.studentId);
    assert.notEqual(morning.id, morning.studentId);
    assert.equal(morning.shiftId, 'MORNING');
    const pending = await apply({ studentId: morning.studentId, shiftId: 'DAY', operatingDays: [1, 2, 4], pickupAddress: 'Other pickup', className: 'Cannot override shared profile' });
    await request(`/admin/requests/${pending.id}/decision`, admin.token, { decision: 'APPROVED' }, 'PATCH');
    const overview = await request('/management/overview', guardian.token);
    day = overview.students.find((student: Row) => student.shiftId === 'DAY');
    assert.equal(day.studentId, morning.studentId);
    assert.equal(day.className, 'Class 4');
    assert.equal(day.pickupAddress, 'Other pickup');
    await request(`/admin/students/${day.id}`, admin.token, { roll: '13' }, 'PATCH');
    assert.ok((await request('/management/overview', guardian.token)).students.every((student: Row) => student.roll === '13'));
    assert.equal((await request('/management/overview', guardian.token)).students.find((student: Row) => student.id === morning.id).pickupAddress, 'Home');
    assert.equal((await db.get('SELECT count(*)::int count FROM student_profiles WHERE "guardianId"=$1', guardian.user.id)).count, 1);
  });
  await t.test('same-shift duplicates fail regardless of route while foreign identities stay private', async () => {
    await apply({ studentId: morning.studentId, shiftId: 'MORNING', routeId: route2.id, stopId: route2.stops[0].id }, 409);
    await enroll({ studentId: morning.studentId, shiftId: 'DAY' }, 409);
    await apply({ shiftId: 'EVENING' }, 409);
    await apply({ studentName: '  shift child  ', shiftId: 'EVENING' }, 409);
    await apply({ studentId: morning.studentId, shiftId: 'EVENING' }, 403, other.token);
    await request('/admin/students', admin.token, form({ studentId: morning.studentId, guardianPhone: other.user.phone, shiftId: 'EVENING' }), 'POST', 403);
    await request(`/admin/students/${day.id}`, admin.token, { shiftId: 'MORNING' }, 'PATCH', 409);
  });
  await t.test('invalid weekdays, empty calendars and unknown shifts reject without creating profiles', async () => {
    for (const operatingDays of [[], [1, 1], [-1], [7], [1.5], ['1'], null, [5]])
      await apply({ studentName: 'Invalid Student', shiftId: 'EVENING', operatingDays }, 400);
    await apply({ studentName: 'Invalid Student', shiftId: 'UNKNOWN' }, 400);
    assert.equal(await db.get('SELECT id FROM student_profiles WHERE "studentName"=$1', 'Invalid Student'), undefined);
    for (const operatingDays of [[], [1, 1], [7], null]) await request('/admin/settings', admin.token, { operatingDays }, 'PATCH', 400);
    await request('/admin/settings', admin.token, { transportShifts: [] }, 'PATCH', 400);
    await request('/admin/settings', admin.token, { transportShifts: [settings.transportShifts[0], settings.transportShifts[0]] }, 'PATCH', 400);
    await request('/admin/settings', admin.token, { transportShifts: [{ ...settings.transportShifts[0], endTime: '01:00' }] }, 'PATCH', 400);
    await request('/admin/settings', admin.token, { transportShifts: [settings.transportShifts[0]] }, 'PATCH', 409);
  });
  await t.test('concurrent pending claims allow only one and block an admin active enrollment', async () => {
    const input = form({ studentId: morning.studentId, shiftId: 'EVENING' });
    const results = await Promise.all([raw('/requests/guardian/new', guardian.token, input, 'POST'), raw('/requests/guardian/new', guardian.token, input, 'POST')]);
    assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
    const pending = results.find(result => result.status === 201)!.data;
    await enroll({ studentId: morning.studentId, shiftId: 'EVENING' }, 409);
    await request(`/admin/requests/${pending.id}/decision`, admin.token, { decision: 'REJECTED', note: 'Testing shift release' }, 'PATCH');
    const race = await Promise.all([
      raw('/requests/guardian/new', guardian.token, input, 'POST'),
      raw('/admin/students', admin.token, { ...input, guardianPhone: guardian.user.phone }, 'POST'),
    ]);
    assert.deepEqual(race.map(result => result.status).sort(), [201, 409]);
    const active = await db.all(`SELECT id FROM subscriptions WHERE "studentId"=$1 AND "shiftId"='EVENING' AND status='ACTIVE'`, morning.studentId);
    const requests = await db.all(`SELECT id FROM service_requests WHERE "studentId"=$1 AND "shiftId"='EVENING' AND status='PENDING'`, morning.studentId);
    assert.equal(active.length + requests.length, 1);
  });
  await t.test('concurrent creation of the same new student returns a duplicate conflict instead of a server error', async () => {
    const input = form({ studentName: 'Concurrent Child' });
    const results = await Promise.all([raw('/requests/guardian/new', other.token, input, 'POST'), raw('/requests/guardian/new', other.token, input, 'POST')]);
    assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
    assert.equal((await db.get('SELECT count(*)::int count FROM student_profiles WHERE "guardianId"=$1', other.user.id)).count, 1);
  });
  await t.test('attendance is independent for each enrollment and refuses institute/student off days atomically', async () => {
    const record = (studentId: string, date: string) => ({ studentId, date, status: 'PRESENT' });
    await request('/admin/attendance', admin.token, { entries: [record(morning.id, '2026-09-14'), record(day.id, '2026-09-14')] }, 'PUT');
    let overview = await request('/management/overview', guardian.token);
    assert.equal(overview.attendance.filter((entry: Row) => entry.date === '2026-09-14').length, 2);
    await request('/admin/attendance', admin.token, { entries: [record(morning.id, '2026-09-15')] }, 'PUT', 400);
    await request('/admin/attendance', admin.token, { entries: [record(day.id, '2026-09-15'), record(morning.id, '2026-09-15')] }, 'PUT', 400);
    assert.equal((await db.all('SELECT id FROM attendance WHERE date=$1', '2026-09-15')).length, 0);
    await request('/management/requests', guardian.token, { studentId: morning.id, category: 'ABSENCE', title: 'Off day', description: 'Should not count as absent', date: '2026-09-15' }, 'POST', 400);
    await request('/admin/settings', admin.token, { operatingDays: [0, 2, 3, 4, 6] }, 'PATCH');
    await request('/admin/attendance', admin.token, { entries: [record(morning.id, '2026-09-21')] }, 'PUT', 400);
    overview = await request('/management/overview', guardian.token);
    const weekday = new Date(`${overview.today}T12:00:00Z`).getUTCDay();
    for (const student of overview.students) assert.equal(student.scheduledToday, student.status === 'ACTIVE' && student.operatingDays.includes(weekday) && overview.settings.operatingDays.includes(weekday));
    assert.deepEqual(overview.todayStudents.map((s: Row) => s.id), overview.students.filter((s: Row) => s.scheduledToday).map((s: Row) => s.id));
    assert.equal(overview.attendance.length, 2, 'calendar changes retain historical attendance');
    await request('/admin/settings', admin.token, { operatingDays: settings.operatingDays }, 'PATCH');
  });
  await t.test('overlaps warn, profile identities survive stopping, and bills distinguish each shift', async () => {
    await request('/admin/settings', admin.token, { transportShifts: settings.transportShifts.map((shift: Row) => shift.id === 'DAY' ? { ...shift, startTime: '10:00' } : shift) }, 'PATCH');
    const updated = await request(`/admin/students/${day.id}`, admin.token, { operatingDays: [1] }, 'PATCH');
    assert.ok(updated.warnings.some((warning: string) => warning.includes('Morning')));
    await request('/admin/bills/generate', admin.token, { month: new Date().toISOString().slice(0, 7) }, 'POST', 201);
    const bills = await request('/payments/monthly', guardian.token);
    const own = bills.filter((bill: Row) => [morning.id, day.id].includes(bill.subscriptionId));
    assert.equal(own.length, 2);
    assert.deepEqual(own.map((bill: Row) => bill.shiftId).sort(), ['DAY', 'MORNING']);
    assert.ok(own.every((bill: Row) => bill.studentId === morning.studentId));
    const report = await request(`/admin/reports?month=${new Date().toISOString().slice(0, 7)}`, admin.token);
    assert.equal(report.students.total, 1);
    assert.equal(report.students.active, 1);
    await request(`/admin/students/${day.id}`, admin.token, { shiftId: 'EVENING' }, 'PATCH', 409);
    await request(`/admin/students/${day.id}`, admin.token, { status: 'STOPPED' }, 'PATCH');
    const replacement = await apply({ studentId: morning.studentId, shiftId: 'DAY' });
    assert.equal(replacement.studentId, morning.studentId);
    assert.equal((await db.get('SELECT status FROM subscriptions WHERE id=$1', morning.id)).status, 'ACTIVE');
    await request(`/admin/requests/${replacement.id}/decision`, admin.token, { decision: 'APPROVED' }, 'PATCH');
    assert.equal((await db.get('SELECT count(*)::int count FROM bills WHERE "subscriptionId"=$1', day.id)).count, 1);
  });
});
