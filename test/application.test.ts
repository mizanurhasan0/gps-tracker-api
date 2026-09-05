import 'reflect-metadata';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { User } from '../src/auth/auth.types';
import type { Bill, PaymentSubmission } from '../src/payments/payments.service';

interface Session {
  token: string;
  user: User;
}
interface Route {
  id: string;
  stops: { id: string }[];
}
interface Identified {
  id: string;
  status: string;
}

test('transport and manual payment HTTP integration', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'transport-test-'));
  process.env.DATA_DIR = directory;
  process.env.ADMIN_PHONE = '01700000001';
  process.env.ADMIN_PASSWORD = 'admin-test-password-123';
  const legacyVehicleId = randomUUID();
  writeFileSync(
    join(directory, 'vehicles.json'),
    JSON.stringify([
      {
        id: legacyVehicleId,
        name: 'Legacy van',
        plate: 'DHAKA-01',
        imei: '868720065798377',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]),
  );
  // Import compiled production classes so Nest's decorator metadata is preserved.
  const { SecurityModule } = require('../dist/auth/security.module');
  const { TransportModule } = require('../dist/transport/transport.module');
  const { VehiclesModule } = require('../dist/vehicles/vehicles.module');
  const { LocationsModule } = require('../dist/locations/locations.module');
  const { DatabaseService } = require('../dist/database/database.service');
  const { AuthService } = require('../dist/auth/auth.service');
  const { AccessService } = require('../dist/auth/access.service');
  const { RealtimeGateway } = require('../dist/realtime/realtime.gateway');
  const { LocationsService } = require('../dist/locations/locations.service');
  class TestApp {}
  Module({
    imports: [SecurityModule, TransportModule, VehiclesModule, LocationsModule],
  })(TestApp);
  const app = await NestFactory.create(TestApp, { logger: false });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await app.listen(0, '127.0.0.1');
  const origin = await app.getUrl();
  async function request<T = Record<string, unknown>>(
    path: string,
    token?: string,
    body?: unknown,
    method = 'GET',
    status = 200,
  ): Promise<T> {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = response.status === 204 ? undefined : await response.json();
    assert.equal(
      response.status,
      status,
      `${method} ${path}: ${JSON.stringify(data)}`,
    );
    return data as T;
  }
  try {
    const admin = await request<Session>(
      '/auth/login',
      undefined,
      { phone: process.env.ADMIN_PHONE, password: process.env.ADMIN_PASSWORD },
      'POST',
    );
    const guardian = await request<Session>(
      '/auth/register',
      undefined,
      {
        name: 'Guardian One',
        phone: '01700000002',
        password: 'guardian-pass-123',
      },
      'POST',
      201,
    );
    const other = await request<Session>(
      '/auth/register',
      undefined,
      {
        name: 'Guardian Two',
        phone: '01700000003',
        password: 'guardian-pass-123',
      },
      'POST',
      201,
    );
    await t.test(
      'protects endpoints and rejects role injection and invalid login',
      async () => {
        await request('/vehicles', undefined, undefined, 'GET', 401);
        await request(
          '/auth/register',
          undefined,
          {
            name: 'Fake Admin',
            phone: '01700000004',
            password: 'guardian-pass-123',
            role: 'ADMIN',
          },
          'POST',
          400,
        );
        await request('/admin/requests', guardian.token, undefined, 'GET', 403);
        await request(
          '/auth/login',
          undefined,
          { phone: '01700000002', password: 'incorrect-password' },
          'POST',
          401,
        );
        const vehicles = await request<{ vehicles: { id: string }[] }>(
          '/vehicles',
          admin.token,
        );
        assert.equal(vehicles.vehicles[0].id, legacyVehicleId);
        assert.deepEqual(await request('/vehicles', guardian.token), {
          vehicles: [],
        });
        await request(
          '/vehicles',
          admin.token,
          { name: ' ', plate: 'DHK', imei: '868720065798378' },
          'POST',
          400,
        );
      },
    );
    const route = await request<Route>(
      '/admin/routes',
      admin.token,
      {
        name: 'School road',
        vehicleId: legacyVehicleId,
        monthlyAmount: 150000,
        stops: ['Main gate', 'School'],
      },
      'POST',
      201,
    );
    const route2 = await request<Route>(
      '/admin/routes',
      admin.token,
      {
        name: 'Other road',
        vehicleId: legacyVehicleId,
        monthlyAmount: 160000,
        stops: ['Other gate'],
      },
      'POST',
      201,
    );
    let service: Identified;
    await t.test('validates route coverage and pending requests', async () => {
      await request(
        '/requests/guardian/new',
        guardian.token,
        {
          studentName: 'Student One',
          routeId: route.id,
          stopId: route2.stops[0].id,
        },
        'POST',
        400,
      );
      service = await request<Identified>(
        '/requests/guardian/new',
        guardian.token,
        {
          studentName: 'Student One',
          routeId: route.id,
          stopId: route.stops[0].id,
        },
        'POST',
        201,
      );
      await request(
        '/requests/guardian/new',
        guardian.token,
        {
          studentName: 'Student One',
          routeId: route.id,
          stopId: route.stops[0].id,
        },
        'POST',
        409,
      );
      await request(
        '/locations/868720065798377',
        guardian.token,
        undefined,
        'GET',
        403,
      );
    });
    await request(
      `/admin/requests/${service!.id}/decision`,
      admin.token,
      { decision: 'APPROVED' },
      'PATCH',
    );
    await request(
      `/admin/requests/${service!.id}/decision`,
      admin.token,
      { decision: 'APPROVED' },
      'PATCH',
      409,
    );
    const subscriptions = await request<Identified[]>(
      '/subscriptions',
      guardian.token,
    );
    const subscription = subscriptions[0];
    await t.test('restricts tracking by approved assignment', async () => {
      app.get(LocationsService).savePosition({
        imei: '868720065798377',
        latitude: 23.82,
        longitude: 90.36,
        speed: 12,
        course: 0,
        gpsTime: '2026-09-05 12:00:00',
      });
      const vehicles = await request<{ vehicles: { id: string }[] }>(
        '/vehicles',
        guardian.token,
      );
      assert.equal(vehicles.vehicles.length, 1);
      await request('/locations/868720065798377', guardian.token);
      await request(
        '/locations/868720065798377',
        other.token,
        undefined,
        'GET',
        403,
      );
      await request(
        `/vehicles/${legacyVehicleId}`,
        other.token,
        undefined,
        'GET',
        403,
      );
      await request(
        `/vehicles/${legacyVehicleId}`,
        admin.token,
        undefined,
        'DELETE',
        409,
      );
      const user = await request<User>('/auth/me', guardian.token);
      assert.equal(user.verified, 1);
      await request(
        '/complaints',
        other.token,
        {
          subscriptionId: subscription.id,
          category: 'OTHER',
          description: 'A complaint by a stranger',
        },
        'POST',
        403,
      );
    });
    const month = new Date(Date.now() + 6 * 60 * 60_000)
      .toISOString()
      .slice(0, 7);
    await t.test(
      'generates monthly bills idempotently and scopes ownership',
      async () => {
        assert.equal(
          (
            await request<{ created: number }>(
              '/admin/bills/generate',
              admin.token,
              { month },
              'POST',
              201,
            )
          ).created,
          1,
        );
        assert.equal(
          (
            await request<{ created: number }>(
              '/admin/bills/generate',
              admin.token,
              { month },
              'POST',
              201,
            )
          ).created,
          0,
        );
        assert.deepEqual(await request('/payments/monthly', other.token), []);
        await request(
          '/payments/monthly?month=2026-99',
          guardian.token,
          undefined,
          'GET',
          400,
        );
        await request(
          '/admin/bills/generate',
          admin.token,
          { month: '2099-01' },
          'POST',
          400,
        );
      },
    );
    const bill = (
      await request<Bill[]>('/payments/monthly', guardian.token)
    )[0];
    const paymentInput = {
      billId: bill.id,
      method: 'BKASH',
      recipientNumber: '01700000001',
      senderNumber: '01700000002',
      transactionId: 'ABC1234567',
      amount: bill.amount,
    };
    let payment: PaymentSubmission;
    await t.test(
      'validates manual submission and snapshots the receiver',
      async () => {
        await request(
          '/payments/submissions',
          guardian.token,
          paymentInput,
          'POST',
          400,
        );
        await request(
          '/admin/payment-accounts/BKASH',
          admin.token,
          {
            number: '01700000001',
            instructions: 'Send Money to the admin personal account',
          },
          'PUT',
          204,
        );
        await request(
          '/payments/submissions',
          other.token,
          paymentInput,
          'POST',
          404,
        );
        await request(
          '/payments/submissions',
          guardian.token,
          { ...paymentInput, amount: bill.amount - 1 },
          'POST',
          400,
        );
        await request(
          '/payments/submissions',
          guardian.token,
          { ...paymentInput, transactionId: '<script>' },
          'POST',
          400,
        );
        payment = await request<PaymentSubmission>(
          '/payments/submissions',
          guardian.token,
          paymentInput,
          'POST',
          201,
        );
        assert.equal(payment.status, 'PENDING');
        assert.equal(payment.recipientNumber, '01700000001');
        assert.equal(
          (await request<Bill[]>('/payments/monthly', guardian.token))[0]
            .status,
          'UNPAID',
        );
        await request(
          '/payments/submissions',
          guardian.token,
          paymentInput,
          'POST',
          409,
        );
        await request(
          `/admin/payments/${payment.id}/decision`,
          guardian.token,
          { decision: 'APPROVED' },
          'PATCH',
          403,
        );
        await request(
          '/admin/payment-accounts/BKASH',
          admin.token,
          { number: '01700000009', instructions: 'Updated receiving account' },
          'PUT',
          204,
        );
        assert.equal(
          (
            await request<PaymentSubmission[]>(
              '/payments/submissions',
              guardian.token,
            )
          )[0].recipientNumber,
          '01700000001',
        );
      },
    );
    await t.test(
      'rejects with a reason and allows corrected resubmission',
      async () => {
        await request(
          `/admin/payments/${payment!.id}/decision`,
          admin.token,
          { decision: 'REJECTED' },
          'PATCH',
          400,
        );
        await request(
          `/admin/payments/${payment!.id}/decision`,
          admin.token,
          { decision: 'REJECTED', note: 'Transaction was entered incorrectly' },
          'PATCH',
        );
        const corrected = await request<PaymentSubmission>(
          '/payments/submissions',
          guardian.token,
          { ...paymentInput, transactionId: 'CORRECT123' },
          'POST',
          201,
        );
        payment = corrected;
        assert.equal(
          (await request<Bill[]>('/payments/monthly', guardian.token))[0]
            .status,
          'UNPAID',
        );
      },
    );
    await t.test(
      'concurrent reviews pay a bill exactly once and persist notification',
      async () => {
        const responses = await Promise.all(
          [1, 2].map(() =>
            fetch(`${origin}/admin/payments/${payment!.id}/decision`, {
              method: 'PATCH',
              headers: {
                Authorization: `Bearer ${admin.token}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ decision: 'APPROVED' }),
            }),
          ),
        );
        assert.deepEqual(
          responses.map(response => response.status).sort(),
          [200, 409],
        );
        assert.equal(
          (await request<Bill[]>('/payments/monthly', guardian.token))[0]
            .status,
          'PAID',
        );
        await request(
          '/payments/submissions',
          guardian.token,
          { ...paymentInput, transactionId: 'DIFFERENT123' },
          'POST',
          409,
        );
        const notifications = await request<{ id: string; title: string }[]>(
          '/notifications',
          guardian.token,
        );
        const confirmations = notifications.filter(
          notification => notification.title === 'Payment completed',
        );
        assert.equal(confirmations.length, 1);
        await request(
          `/notifications/${confirmations[0].id}/read`,
          other.token,
          undefined,
          'PATCH',
          404,
        );
        await request(
          `/notifications/${confirmations[0].id}/read`,
          guardian.token,
          undefined,
          'PATCH',
          204,
        );
      },
    );
    await t.test(
      'blocks a reused transaction ID on a different bill',
      async () => {
        const secondRequest = await request<Identified>(
          '/requests/guardian/new',
          guardian.token,
          {
            studentName: 'Student Two',
            routeId: route.id,
            stopId: route.stops[0].id,
          },
          'POST',
          201,
        );
        await request(
          `/admin/requests/${secondRequest.id}/decision`,
          admin.token,
          { decision: 'APPROVED' },
          'PATCH',
        );
        await request(
          '/admin/bills/generate',
          admin.token,
          { month },
          'POST',
          201,
        );
        const unpaid = (
          await request<Bill[]>('/payments/monthly', guardian.token)
        ).find(item => item.status === 'UNPAID')!;
        await request(
          '/payments/submissions',
          guardian.token,
          { ...paymentInput, billId: unpaid.id, transactionId: 'correct123' },
          'POST',
          409,
        );
      },
    );
    await t.test(
      'rolls back all payment writes if notification persistence fails',
      async () => {
        const db = app.get(DatabaseService);
        const unpaid = (
          await request<Bill[]>('/payments/monthly', guardian.token)
        ).find(item => item.status === 'UNPAID')!;
        db.run(
          "CREATE TRIGGER fail_notification BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT, 'test failure'); END",
        );
        await request(
          '/payments/submissions',
          guardian.token,
          { ...paymentInput, billId: unpaid.id, transactionId: 'ROLLBACK123' },
          'POST',
          500,
        );
        db.run('DROP TRIGGER fail_notification');
        assert.equal(
          db.get(
            "SELECT count(*) total FROM payment_submissions WHERE transactionId = 'ROLLBACK123'",
          ).total,
          0,
        );
      },
    );
    await t.test(
      'complaints resolve and stop approvals revoke live socket access',
      async () => {
        const complaint = await request<Identified>(
          '/complaints',
          guardian.token,
          {
            subscriptionId: subscription.id,
            category: 'LATE_PICKUP',
            description: 'The pickup was thirty minutes late.',
          },
          'POST',
          201,
        );
        await request(
          `/admin/complaints/${complaint.id}`,
          admin.token,
          {
            status: 'RESOLVED',
            note: 'Pickup timing corrected with the driver',
          },
          'PATCH',
        );
        const gateway = new RealtimeGateway(
          app.get(AuthService),
          app.get(AccessService),
        );
        let deliveries = 0;
        let disconnected = false;
        const client = {
          handshake: { auth: { token: guardian.token } },
          emit: () => {
            deliveries++;
          },
          disconnect: () => {
            disconnected = true;
          },
        };
        Object.assign(gateway, {
          server: { sockets: { sockets: new Map([['guardian', client]]) } },
        });
        gateway.publishLocation({ imei: '868720065798377' });
        assert.equal(deliveries, 1);
        for (const active of await request<Identified[]>(
          '/subscriptions',
          guardian.token,
        )) {
          const stop = await request<Identified>(
            '/stop-requests',
            guardian.token,
            { subscriptionId: active.id, reason: 'No longer need transport' },
            'POST',
            201,
          );
          await request(
            '/stop-requests',
            guardian.token,
            { subscriptionId: active.id, reason: 'Duplicate stop request' },
            'POST',
            409,
          );
          await request(
            `/admin/stop-requests/${stop.id}/decision`,
            admin.token,
            { decision: 'APPROVED' },
            'PATCH',
          );
        }
        gateway.publishLocation({ imei: '868720065798377' });
        assert.equal(
          deliveries,
          1,
          'already connected sockets must lose tracking access',
        );
        await request(
          '/locations/868720065798377',
          guardian.token,
          undefined,
          'GET',
          403,
        );
        assert.deepEqual(await request('/vehicles', guardian.token), {
          vehicles: [],
        });
        assert.equal(
          (await request<Bill[]>('/payments/monthly', guardian.token)).length,
          2,
          'billing history survives a stop',
        );
        await request('/auth/logout', guardian.token, undefined, 'POST', 204);
        gateway.publishLocation({ imei: '868720065798377' });
        assert.equal(disconnected, true);
        await request('/auth/me', guardian.token, undefined, 'GET', 401);
      },
    );
    await t.test('does not persist raw session tokens or passwords', () => {
      const db = app.get(DatabaseService);
      assert.equal(
        db.get(
          'SELECT tokenHash FROM sessions WHERE tokenHash = ?',
          admin.token,
        ),
        undefined,
      );
      assert.notEqual(
        db.get('SELECT passwordHash FROM users WHERE id = ?', admin.user.id)
          .passwordHash,
        process.env.ADMIN_PASSWORD,
      );
      assert.equal(
        db.get(
          "SELECT count(*) total FROM audit_logs WHERE action = 'PAYMENT_APPROVED'",
        ).total,
        1,
      );
    });
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
