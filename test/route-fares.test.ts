import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.HISTORY_TEST_DATABASE_URL;
type Row = Record<string, any>;

test('route journey fares PostgreSQL HTTP integration', { skip: !databaseUrl }, async (t) => {
  const schema = `route_fares_${randomUUID().replaceAll('-', '')}`;
  const setup = new Pool({ connectionString: databaseUrl });
  await setup.query(`CREATE SCHEMA ${schema}`);
  t.after(async () => {
    await setup.query(`DROP SCHEMA ${schema} CASCADE`);
    await setup.end();
  });
  const isolated = new URL(databaseUrl!);
  isolated.searchParams.set('options', `-c search_path=${schema}`);
  process.env.DATABASE_URL = isolated.toString();
  process.env.ADMIN_PHONE = '01700000001';
  process.env.ADMIN_PASSWORD = 'route-fares-admin-password';
  const { SecurityModule } = require('../dist/auth/security.module');
  const { TransportModule } = require('../dist/transport/transport.module');
  const { VehiclesModule } = require('../dist/vehicles/vehicles.module');
  const { DatabaseService } = require('../dist/database/database.service');
  class TestApp {}
  Module({ imports: [SecurityModule, TransportModule, VehiclesModule] })(TestApp);
  const app = await NestFactory.create(TestApp, { logger: false });
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
  try {
    const admin = await request('/auth/login', undefined, { phone: process.env.ADMIN_PHONE, password: process.env.ADMIN_PASSWORD }, 'POST');
    const guardian = await request('/auth/register', undefined, { name: 'Fare guardian', phone: '01700000002', password: 'guardian-password' }, 'POST', 201);
    const vehicle = await request('/vehicles', admin.token, { name: 'Fare van', plate: 'FARE-01', imei: '868720065798375' }, 'POST', 201);
    const route = await request('/admin/routes', admin.token, { name: 'Uttara to Mirpur', vehicleId: vehicle.id, monthlyAmount: 250000, stops: ['Uttara', 'Khilkhet', 'Mirpur'] }, 'POST', 201);
    const otherRoute = await request('/admin/routes', admin.token, { name: 'Other route', vehicleId: vehicle.id, monthlyAmount: 300000, stops: ['Other origin', 'Other destination'] }, 'POST', 201);
    const [uttara, khilkhet, mirpur] = route.stops;
    const fares = [
      { boardingStopId: uttara.id, dropoffStopId: khilkhet.id, monthlyAmount: 100000 },
      { boardingStopId: uttara.id, dropoffStopId: mirpur.id, monthlyAmount: 180000 },
    ];
    const farePath = `/admin/routes/${route.id}/fares`;
    const currentFares = async () => (await request('/routes', guardian.token)).find((item: Row) => item.id === route.id).fares;
    const sorted = (items: Row[]) => items.map(({ boardingStopId, dropoffStopId, monthlyAmount }) => ({ boardingStopId, dropoffStopId, monthlyAmount })).sort((a, b) => a.dropoffStopId.localeCompare(b.dropoffStopId));
    const enroll = (studentName: string, dropoffStopId?: string, extra: Row = {}) => request('/admin/students', admin.token, { studentName, guardianPhone: guardian.user.phone, routeId: route.id, stopId: uttara.id, ...(dropoffStopId ? { dropoffStopId } : {}), ...extra }, 'POST', 201);
    let shortJourney: Row;
    let longJourney: Row;
    let legacy: Row;
    let paidBill: Row;
    let payment: Row;

    await t.test('admin configures directional fares; invalid replacements retain the whole fare table', async () => {
      await request(farePath, undefined, { fares }, 'PUT', 401);
      await request(farePath, guardian.token, { fares }, 'PUT', 403);
      await request(farePath, admin.token, { fares }, 'PUT');
      assert.deepEqual(sorted(await currentFares()), sorted(fares));
      const invalid = [
        [fares[0], fares[0]],
        [{ ...fares[0], dropoffStopId: uttara.id }],
        [{ ...fares[0], dropoffStopId: otherRoute.stops[0].id }],
        [{ ...fares[0], boardingStopId: otherRoute.stops[0].id }],
        [{ ...fares[0], monthlyAmount: -1 }],
        [{ ...fares[0], monthlyAmount: 1.5 }],
        [{ ...fares[0], monthlyAmount: null }],
      ];
      for (const invalidFares of invalid) {
        await request(farePath, admin.token, { fares: invalidFares }, 'PUT', 400);
        assert.deepEqual(sorted(await currentFares()), sorted(fares));
      }
    });

    await t.test('guardian cannot inject prices or enroll uncovered, same-stop or cross-route journeys', async () => {
      const input = { studentName: 'Invalid fare child', routeId: route.id, stopId: uttara.id, dropoffStopId: khilkhet.id };
      await request('/requests/guardian/new', guardian.token, { ...input, monthlyAmount: 1 }, 'POST', 400);
      await request('/requests/guardian/new', guardian.token, { studentName: input.studentName, routeId: route.id, stopId: uttara.id }, 'POST', 400);
      await request('/requests/guardian/new', guardian.token, { ...input, dropoffStopId: null }, 'POST', 400);
      await request('/admin/students', admin.token, { ...input, guardianPhone: guardian.user.phone, monthlyAmount: 1 }, 'POST', 400);
      for (const override of [
        { dropoffStopId: uttara.id },
        { dropoffStopId: otherRoute.stops[0].id },
        { stopId: otherRoute.stops[0].id },
        { stopId: khilkhet.id, dropoffStopId: mirpur.id },
        { stopId: khilkhet.id, dropoffStopId: uttara.id },
      ]) {
        await request('/requests/guardian/new', guardian.token, { ...input, ...override }, 'POST', 400);
        await request('/admin/students', admin.token, { ...input, guardianPhone: guardian.user.phone, ...override }, 'POST', 400);
      }
      assert.deepEqual(await request('/requests/mine', guardian.token), []);
    });

    await t.test('students on the same route receive their destination fare and legacy enrollment retains its default', async () => {
      const admission = await request('/requests/guardian/new', guardian.token, { studentName: 'Short journey child', routeId: route.id, stopId: uttara.id, dropoffStopId: khilkhet.id }, 'POST', 201);
      const quote = (await request('/requests/mine', guardian.token))[0];
      assert.equal(quote.monthlyAmount, 100000);
      assert.equal(quote.dropoffStopId, khilkhet.id);
      assert.equal(quote.dropoffStopName, 'Khilkhet');
      await request(`/admin/requests/${admission.id}/decision`, admin.token, { decision: 'APPROVED' }, 'PATCH');
      shortJourney = (await request('/management/overview', guardian.token)).students[0];
      assert.equal(shortJourney.monthlyAmount, 100000);
      assert.equal(shortJourney.dropoffStopId, khilkhet.id);
      assert.equal(shortJourney.dropoffStopName, 'Khilkhet');
      longJourney = await enroll('Long journey child', mirpur.id);
      legacy = await enroll('Legacy default child');
      assert.equal(longJourney.monthlyAmount, 180000);
      assert.equal(legacy.monthlyAmount, 250000);
      assert.equal(legacy.dropoffStopId, null);
      const subscriptions = await request('/subscriptions', guardian.token);
      assert.equal(subscriptions.find((item: Row) => item.id === longJourney.id).dropoffStopName, 'Mirpur');
    });

    const month = new Date(Date.now() + 6 * 60 * 60_000).toISOString().slice(0, 7);
    await t.test('monthly bills and payment collection use each enrolled fare', async () => {
      await request('/admin/bills/generate', admin.token, { month }, 'POST', 201);
      const bills = await request(`/payments/monthly?month=${month}`, guardian.token);
      paidBill = bills.find((item: Row) => item.subscriptionId === shortJourney.id);
      assert.equal(paidBill.amount, 100000);
      assert.equal(bills.find((item: Row) => item.subscriptionId === longJourney.id).amount, 180000);
      assert.equal(bills.find((item: Row) => item.subscriptionId === legacy.id).amount, 250000);
      await request('/admin/payment-accounts/BKASH', admin.token, { number: '01700000001', instructions: 'Test payment account' }, 'PUT', 204);
      payment = await request('/payments/submissions', guardian.token, { billId: paidBill.id, method: 'BKASH', recipientNumber: '01700000001', senderNumber: guardian.user.phone, transactionId: 'FAREPAYMENT123', amount: paidBill.amount }, 'POST', 201);
      await request(`/admin/payments/${payment.id}/decision`, admin.token, { decision: 'APPROVED' }, 'PATCH');
    });

    await t.test('fare table edits and profile-only edits preserve subscriptions; journey edits derive their configured fare', async () => {
      await request(farePath, admin.token, { fares: fares.map((fare) => ({ ...fare, monthlyAmount: fare.monthlyAmount + 20000 })) }, 'PUT');
      const existing = (await request('/management/overview', guardian.token)).students;
      assert.equal(existing.find((item: Row) => item.id === shortJourney.id).monthlyAmount, 100000);
      assert.equal(existing.find((item: Row) => item.id === longJourney.id).monthlyAmount, 180000);
      const profile = await request(`/admin/students/${shortJourney.id}`, admin.token, { roll: '42' }, 'PATCH');
      assert.equal(profile.monthlyAmount, 100000);
      assert.equal(profile.dropoffStopId, khilkhet.id);
      const changed = await request(`/admin/students/${shortJourney.id}`, admin.token, { dropoffStopId: mirpur.id }, 'PATCH');
      assert.equal(changed.monthlyAmount, 200000);
      assert.equal(changed.dropoffStopName, 'Mirpur');
      const cleared = await request(`/admin/students/${shortJourney.id}`, admin.token, { dropoffStopId: null }, 'PATCH');
      assert.equal(cleared.monthlyAmount, 250000);
      assert.equal(cleared.dropoffStopId, null);
      await request(`/admin/students/${shortJourney.id}`, admin.token, { dropoffStopId: mirpur.id }, 'PATCH');
      const custom = await request(`/admin/students/${shortJourney.id}`, admin.token, { dropoffStopId: null, monthlyAmount: 220000 }, 'PATCH');
      assert.equal(custom.monthlyAmount, 220000);
      assert.equal(custom.dropoffStopId, null);
      const fresh = await enroll('New short journey child', khilkhet.id);
      assert.equal(fresh.monthlyAmount, 120000);
      const historical = (await request(`/payments/monthly?month=${month}`, guardian.token)).find((item: Row) => item.id === paidBill.id);
      assert.equal(historical.amount, 100000);
      assert.equal(historical.status, 'PAID');
      const history = (await request('/payments/submissions', guardian.token)).find((item: Row) => item.id === payment.id);
      assert.equal(history.amount, 100000);
      assert.equal(history.status, 'APPROVED');
    });

    await t.test('removing configured fares preserves old enrollment snapshots but rejects new uncovered journeys', async () => {
      await request(farePath, admin.token, { fares: [] }, 'PUT');
      assert.deepEqual(await currentFares(), []);
      const updated = await request(`/admin/students/${longJourney.id}`, admin.token, { className: 'Class 8' }, 'PATCH');
      assert.equal(updated.monthlyAmount, 180000);
      assert.equal(updated.dropoffStopId, mirpur.id);
      await request('/requests/guardian/new', guardian.token, { studentName: 'Uncovered child', routeId: route.id, stopId: uttara.id, dropoffStopId: mirpur.id }, 'POST', 400);
      assert.equal(Number((await db.get('SELECT count(*) AS total FROM subscriptions')).total), 4);
    });
  } finally {
    await app.close();
  }
});
