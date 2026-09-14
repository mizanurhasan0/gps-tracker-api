import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.HISTORY_TEST_DATABASE_URL;
type Row = Record<string, any>;

test('admin guardian provisioning PostgreSQL HTTP integration', { skip: !databaseUrl }, async (t) => {
  const schema = `guardian_enrollment_${randomUUID().replaceAll('-', '')}`;
  const setup = new Pool({ connectionString: databaseUrl });
  await setup.query(`CREATE SCHEMA ${schema}`);
  const isolated = new URL(databaseUrl!);
  isolated.searchParams.set('options', `-c search_path=${schema}`);
  process.env.DATABASE_URL = isolated.toString();
  process.env.ADMIN_PHONE = '01700000001';
  process.env.ADMIN_PASSWORD = 'guardian-enrollment-admin-password';
  const { SecurityModule } = require('../dist/auth/security.module');
  const { TransportModule } = require('../dist/transport/transport.module');
  const { VehiclesModule } = require('../dist/vehicles/vehicles.module');
  const { DatabaseService } = require('../dist/database/database.service');
  class TestApp {}
  Module({ imports: [SecurityModule, TransportModule, VehiclesModule] })(TestApp);
  const app = await NestFactory.create(TestApp, { logger: false });
  t.after(async () => {
    await app.close();
    await setup.query(`DROP SCHEMA ${schema} CASCADE`);
    await setup.end();
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  const origin = await app.getUrl();
  const db = app.get(DatabaseService);
  async function request(path: string, token?: string, body?: unknown, method = 'GET', status = 200): Promise<any> {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const data = response.status === 204 ? undefined : await response.json();
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(data)}`);
    return data;
  }
  const login = (phone: string, password = 'password', status = 200) => request('/auth/login', undefined, { phone, password }, 'POST', status);
  const admin = await login(process.env.ADMIN_PHONE, process.env.ADMIN_PASSWORD);
  const vehicle = await request('/vehicles', admin.token, { name: 'Guardian van', plate: 'GUARDIAN-01', imei: '868720065798376' }, 'POST', 201);
  const route = await request('/admin/routes', admin.token, { name: 'Guardian route', vehicleId: vehicle.id, monthlyAmount: 250000, stops: ['Home', 'School'] }, 'POST', 201);
  const input = (studentName: string, guardianPhone: string, extra: Row = {}) => ({ studentName, guardianPhone, routeId: route.id, stopId: route.stops[0].id, ...extra });
  const enroll = (studentName: string, phone: string, extra: Row = {}, status = 201) => request('/admin/students', admin.token, input(studentName, phone, extra), 'POST', status);
  let first: Row;
  let session: Row;

  await t.test('creates a named guardian who can log in and see only linked students', async () => {
    first = await enroll('First child', ' +8801700000002 ', { guardianName: '  New Guardian  ' });
    assert.equal(first.guardianAccountCreated, true);
    assert.equal(first.guardianPhone, '01700000002');
    assert.equal(first.guardianName, 'New Guardian');
    assert.ok(!('password' in first));
    assert.ok(!('passwordHash' in first));
    const account = await db.get('SELECT * FROM users WHERE id=$1', first.guardianId);
    assert.match(account.passwordHash, /^[a-f0-9]{32}:[a-f0-9]{128}$/);
    assert.equal(account.role, 'GUARDIAN');
    assert.equal(account.verified, 1);
    assert.deepEqual(await db.all('SELECT * FROM sessions WHERE "userId"=$1', first.guardianId), []);
    session = await login('01700000002');
    assert.equal(session.user.id, first.guardianId);
    assert.ok(!('passwordHash' in session.user));
    const overview = await request('/management/overview', session.token);
    assert.deepEqual(overview.students.map((s: Row) => s.id), [first.id]);
    assert.ok(!('guardianAccountCreated' in overview.students[0]));
    assert.equal((await request('/vehicles', session.token)).vehicles[0].id, vehicle.id);
    await request('/admin/students', session.token, input('Unauthorized child', '01700000999'), 'POST', 403);
    assert.equal(await db.get('SELECT id FROM users WHERE phone=$1', '01700000999'), undefined);
  });

  await t.test('reuses normalized numbers and preserves an existing password and name', async () => {
    const before = await db.get('SELECT * FROM users WHERE id=$1', first.guardianId);
    const second = await enroll('Second child', '8801700000002', { guardianName: 'Do not replace name' });
    assert.equal(second.guardianAccountCreated, false);
    assert.equal(second.guardianId, first.guardianId);
    assert.equal(second.guardianName, before.name);
    assert.deepEqual(await db.get('SELECT * FROM users WHERE id=$1', first.guardianId), before);
    assert.equal((await request('/management/overview', session.token)).students.length, 2);
    const registered = await request('/auth/register', undefined, { name: 'Self registered', phone: '01700000003', password: 'original-private-password' }, 'POST', 201);
    const original = await db.get('SELECT "passwordHash" FROM users WHERE id=$1', registered.user.id);
    const linked = await enroll('Registered child', '01700000003', { guardianName: 'Ignored name' });
    assert.equal(linked.guardianAccountCreated, false);
    assert.equal(linked.guardianId, registered.user.id);
    assert.deepEqual(await db.get('SELECT "passwordHash" FROM users WHERE id=$1', linked.guardianId), original);
    await login('01700000003', 'password', 401);
    await login('01700000003', 'original-private-password');
    assert.equal((await request('/management/overview', session.token)).students.length, 2);
  });

  await t.test('supports omitted guardian names, validates supplied names, and refuses admin phones', async () => {
    const fallback = await enroll('Fallback child', '01700000004');
    assert.equal(fallback.guardianAccountCreated, true);
    assert.equal(fallback.guardianName, 'Guardian 01700000004');
    const firstHash = await db.get('SELECT "passwordHash" FROM users WHERE id=$1', first.guardianId);
    const fallbackHash = await db.get('SELECT "passwordHash" FROM users WHERE id=$1', fallback.guardianId);
    assert.notEqual(firstHash.passwordHash, fallbackHash.passwordHash);
    await login('01700000004');
    for (const guardianName of ['', ' ', 'A', 'A'.repeat(81), 123]) {
      await enroll('Invalid name child', '01700000005', { guardianName }, 400);
    }
    assert.equal(await db.get('SELECT id FROM users WHERE phone=$1', '01700000005'), undefined);
    const before = await db.get('SELECT * FROM users WHERE id=$1', admin.user.id);
    await enroll('Admin phone child', '+8801700000001', {}, 409);
    assert.deepEqual(await db.get('SELECT * FROM users WHERE id=$1', admin.user.id), before);
  });

  await t.test('keeps edit ownership locked and does not provision accounts during edits', async () => {
    await request(`/admin/students/${first.id}`, admin.token, { guardianPhone: '01700000006' }, 'PATCH', 400);
    assert.equal(await db.get('SELECT id FROM users WHERE phone=$1', '01700000006'), undefined);
    const edited = await request(`/admin/students/${first.id}`, admin.token, { guardianPhone: '+8801700000002', roll: '10' }, 'PATCH');
    assert.equal(edited.guardianId, first.guardianId);
    assert.equal(edited.roll, '10');
    assert.ok(!('guardianAccountCreated' in edited));
  });

  await t.test('rolls back new accounts and enrollment when downstream audit fails', async () => {
    await db.exec(`CREATE FUNCTION fail_guardian_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END; $$;
      CREATE TRIGGER fail_guardian_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_guardian_audit()`);
    try {
      await enroll('Rollback child', '01700000007', {}, 500);
    } finally {
      await db.exec('DROP TRIGGER fail_guardian_audit ON audit_logs; DROP FUNCTION fail_guardian_audit()');
    }
    assert.equal(await db.get('SELECT id FROM users WHERE phone=$1', '01700000007'), undefined);
    assert.deepEqual(await db.all('SELECT id FROM service_requests WHERE "studentName"=$1', 'Rollback child'), []);
    assert.deepEqual(await db.all('SELECT id FROM subscriptions WHERE "studentName"=$1', 'Rollback child'), []);
    await enroll('Bad route child', '01700000007', { stopId: randomUUID() }, 400);
    assert.equal(await db.get('SELECT id FROM users WHERE phone=$1', '01700000007'), undefined);
  });

  await t.test('simultaneous sibling enrollments create exactly one guardian', async () => {
    const siblings = await Promise.all([
      enroll('Concurrent child A', '01700000008'),
      enroll('Concurrent child B', '+8801700000008'),
    ]);
    assert.equal(siblings[0].guardianId, siblings[1].guardianId);
    assert.equal(siblings.filter(s => s.guardianAccountCreated).length, 1);
    assert.equal((await db.all('SELECT id FROM users WHERE phone=$1', '01700000008')).length, 1);
    const concurrentSession = await login('01700000008');
    const children = (await request('/management/overview', concurrentSession.token)).students;
    assert.deepEqual(children.map((s: Row) => s.id).sort(), siblings.map(s => s.id).sort());
    await enroll('Concurrent child A', '01700000008', {}, 409);
    assert.equal((await request('/management/overview', concurrentSession.token)).students.length, 2);
  });
});
