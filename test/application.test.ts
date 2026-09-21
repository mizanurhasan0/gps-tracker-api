import 'reflect-metadata';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
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

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? process.env.HISTORY_TEST_DATABASE_URL;

test(
  'transport and manual payment PostgreSQL HTTP integration',
  { skip: !databaseUrl },
  async (t) => {
    const schema = `application_test_${randomUUID().replace(/-/g, '')}`;
    const setup = new Pool({ connectionString: databaseUrl });
    await setup.query(`CREATE SCHEMA ${schema}`);
    t.after(async () => {
      await setup.query(`DROP SCHEMA ${schema} CASCADE`);
      await setup.end();
    });
    const isolated = new URL(databaseUrl!);
    isolated.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = isolated.toString();
    const directory = mkdtempSync(join(tmpdir(), 'transport-test-'));
    process.env.DATA_DIR = directory;
    process.env.ADMIN_PHONE = '01700000001';
    process.env.ADMIN_PASSWORD = 'admin-test-password-123';
    const legacyVehicleId = randomUUID();
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
      imports: [
        SecurityModule,
        TransportModule,
        VehiclesModule,
        LocationsModule,
      ],
    })(TestApp);
    const app = await NestFactory.create(TestApp, { logger: false });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      })
    );
    await app.listen(0, '127.0.0.1');
    const origin = await app.getUrl();
    const db = app.get(DatabaseService);
    const seededAt = new Date().toISOString();
    await db.run(
      'INSERT INTO vehicles(id,name,plate,imei,"createdAt","updatedAt") VALUES($1,$2,$3,$4,$5,$6)',
      legacyVehicleId,
      'Legacy van',
      'DHAKA-01',
      '868720065798377',
      seededAt,
      seededAt
    );
    async function request<T = Record<string, unknown>>(
      path: string,
      token?: string,
      body?: unknown,
      method = 'GET',
      status = 200
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
        `${method} ${path}: ${JSON.stringify(data)}`
      );
      return data as T;
    }
    try {
      const admin = await request<Session>(
        '/auth/login',
        undefined,
        {
          phone: process.env.ADMIN_PHONE,
          password: process.env.ADMIN_PASSWORD,
        },
        'POST'
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
        201
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
        201
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
            400
          );
          await request(
            '/admin/requests',
            guardian.token,
            undefined,
            'GET',
            403
          );
          await request(
            '/auth/login',
            undefined,
            { phone: '01700000002', password: 'incorrect-password' },
            'POST',
            401
          );
          const vehicles = await request<{ vehicles: { id: string }[] }>(
            '/vehicles',
            admin.token
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
            400
          );
        }
      );
      await t.test(
        'concurrent registration cannot duplicate a phone and expired sessions are rejected',
        async () => {
          const input = {
            name: 'Concurrent guardian',
            phone: '01700000005',
            password: 'guardian-pass-123',
          };
          const responses = await Promise.all(
            Array.from({ length: 2 }, () =>
              fetch(`${origin}/auth/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(input),
              })
            )
          );
          assert.deepEqual(
            responses.map((response) => response.status).sort(),
            [201, 409]
          );
          const created = (await responses
            .find((response) => response.status === 201)!
            .json()) as Session;
          assert.equal(created.user.role, 'GUARDIAN');
          assert.equal(
            Number(
              (
                await db.get(
                  'SELECT count(*) AS total FROM users WHERE phone = $1',
                  input.phone
                )
              ).total
            ),
            1
          );
          await db.run(
            'UPDATE sessions SET "expiresAt" = $1 WHERE "userId" = $2',
            '2000-01-01T00:00:00.000Z',
            created.user.id
          );
          await request('/auth/me', created.token, undefined, 'GET', 401);
          const renewed = await request<Session>(
            '/auth/login',
            undefined,
            {
              phone: input.phone,
              password: input.password,
            },
            'POST'
          );
          await request('/auth/me', renewed.token);
          await request(
            '/admin/requests',
            renewed.token,
            undefined,
            'GET',
            403
          );
        }
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
        201
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
        201
      );
      let service: Identified;
      await t.test(
        'validates route coverage and pending requests',
        async () => {
          await request(
            '/requests/guardian/new',
            guardian.token,
            {
              studentName: 'Student One',
              routeId: route.id,
              stopId: route2.stops[0].id,
            },
            'POST',
            400
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
            201
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
            409
          );
          await request(
            '/locations/868720065798377',
            guardian.token,
            undefined,
            'GET',
            403
          );
        }
      );
      await request(
        `/admin/requests/${service!.id}/decision`,
        admin.token,
        { decision: 'APPROVED' },
        'PATCH'
      );
      await request(
        `/admin/requests/${service!.id}/decision`,
        admin.token,
        { decision: 'APPROVED' },
        'PATCH',
        409
      );
      const subscriptions = await request<Identified[]>(
        '/subscriptions',
        guardian.token
      );
      const subscription = subscriptions[0];
      await t.test('restricts tracking by approved assignment', async () => {
        await app.get(LocationsService).savePosition({
          imei: '868720065798377',
          latitude: 23.82,
          longitude: 90.36,
          speed: 12,
          course: 0,
          gpsTime: '2026-09-05 12:00:00',
        });
        const vehicles = await request<{ vehicles: { id: string }[] }>(
          '/vehicles',
          guardian.token
        );
        assert.equal(vehicles.vehicles.length, 1);
        await request('/locations/868720065798377', guardian.token);
        await request(
          '/locations/868720065798377',
          other.token,
          undefined,
          'GET',
          403
        );
        await request(
          `/vehicles/${legacyVehicleId}`,
          other.token,
          undefined,
          'GET',
          403
        );
        await request(
          `/vehicles/${legacyVehicleId}`,
          admin.token,
          undefined,
          'DELETE',
          409
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
          403
        );
      });
      const month = new Date(Date.now() + 6 * 60 * 60_000)
        .toISOString()
        .slice(0, 7);
      await t.test(
        'generates monthly bills idempotently and scopes ownership',
        async () => {
          const generated = await Promise.all(
            Array.from({ length: 4 }, () =>
              request<{ created: number }>(
                '/admin/bills/generate',
                admin.token,
                { month },
                'POST',
                201
              )
            )
          );
          assert.equal(
            generated.reduce((sum, result) => sum + result.created, 0),
            1
          );
          assert.equal(
            (
              await request<{ created: number }>(
                '/admin/bills/generate',
                admin.token,
                { month },
                'POST',
                201
              )
            ).created,
            0
          );
          assert.deepEqual(await request('/payments/monthly', other.token), []);
          await request(
            '/payments/monthly?month=2026-99',
            guardian.token,
            undefined,
            'GET',
            400
          );
          await request(
            '/admin/bills/generate',
            admin.token,
            { month: '2099-01' },
            'POST',
            400
          );
        }
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
      await t.test('supports custom QR accounts and private editable evidence', async () => {
        const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT1sAAAAASUVORK5CYII=';
        const account = { name: 'School Bank', number: 'AC-1234567890123456', instructions: '', imageUrl: image };
        await request('/admin/payment-accounts/BANK', guardian.token, account, 'PUT', 403);
        await request('/admin/payment-accounts/BANK', admin.token, { ...account, imageUrl: 'data:image/svg+xml;base64,AAAA' }, 'PUT', 400);
        await request('/admin/payment-accounts/BANK', admin.token, account, 'PUT', 204);
        const accounts = await request<any[]>('/payments/accounts', guardian.token);
        assert.deepEqual(accounts.find(item => item.method === 'BANK'), { method: 'BANK', ...account });
        const input = { ...paymentInput, method: 'BANK', recipientNumber: account.number, senderNumber: 'AC-SENDER', transactionId: '' };
        await request('/payments/submissions', guardian.token, input, 'POST', 400);
        await request('/payments/submissions', guardian.token, { ...input, evidenceImageUrl: 'invalid' }, 'POST', 400);
        const submission = await request<any>('/payments/submissions', guardian.token,
          { ...input, evidenceImageUrl: image, transactionInfo: 'Paid at school branch' }, 'POST', 201);
        assert.equal(submission.methodName, 'School Bank');
        assert.equal(submission.evidenceImageUrl, image);
        assert.equal(submission.status, 'PENDING');
        const endpoint = `/payments/submissions/${submission.id}/evidence`;
        await request(endpoint, other.token, { transactionInfo: 'Not mine' }, 'PATCH', 404);
        await request(endpoint, admin.token, { transactionInfo: 'No guardian permission' }, 'PATCH', 403);
        assert.deepEqual(await request('/payments/submissions', other.token), []);
        await request(endpoint, guardian.token, { evidenceImageUrl: '' }, 'PATCH', 400);
        const updated = await request<any>(endpoint, guardian.token,
          { transactionId: 'BANK/2026-09.123', transactionInfo: 'Branch reference added' }, 'PATCH');
        assert.equal(updated.evidenceImageUrl, image);
        assert.equal(updated.transactionInfo, 'Branch reference added');
        const adminHistory = await request<any[]>('/payments/submissions', admin.token);
        assert.equal(adminHistory.find(item => item.id === submission.id).evidenceImageUrl, image);
        await request('/admin/payment-accounts/BANK', admin.token, { ...account, name: 'Renamed Bank' }, 'PUT', 204);
        assert.equal((await request<any[]>('/payments/submissions', guardian.token))[0].methodName, 'School Bank');
        await request(`/admin/payments/${submission.id}/decision`, admin.token,
          { decision: 'REJECTED', note: 'Please correct the transfer' }, 'PATCH');
        await request(endpoint, guardian.token, { transactionInfo: 'Too late' }, 'PATCH', 409);
      });
      let payment: PaymentSubmission;
      await t.test(
        'validates manual submission and snapshots the receiver',
        async () => {
          await request(
            '/payments/submissions',
            guardian.token,
            paymentInput,
            'POST',
            400
          );
          await request(
            '/admin/payment-accounts/BKASH',
            admin.token,
            {
              number: '01700000001',
              instructions: 'Send Money to the admin personal account',
            },
            'PUT',
            204
          );
          await request(
            '/payments/submissions',
            other.token,
            paymentInput,
            'POST',
            404
          );
          await request(
            '/payments/submissions',
            guardian.token,
            { ...paymentInput, amount: bill.amount - 1 },
            'POST',
            400
          );
          await request(
            '/payments/submissions',
            guardian.token,
            { ...paymentInput, transactionId: '<script>' },
            'POST',
            400
          );
          payment = await request<PaymentSubmission>(
            '/payments/submissions',
            guardian.token,
            paymentInput,
            'POST',
            201
          );
          assert.equal(payment.status, 'PENDING');
          assert.equal(payment.recipientNumber, '01700000001');
          assert.equal(
            (await request<Bill[]>('/payments/monthly', guardian.token))[0]
              .status,
            'UNPAID'
          );
          await request(
            '/payments/submissions',
            guardian.token,
            paymentInput,
            'POST',
            409
          );
          await request(
            `/admin/payments/${payment.id}/decision`,
            guardian.token,
            { decision: 'APPROVED' },
            'PATCH',
            403
          );
          await request(
            '/admin/payment-accounts/BKASH',
            admin.token,
            {
              number: '01700000009',
              instructions: 'Updated receiving account',
            },
            'PUT',
            204
          );
          assert.equal(
            (
              await request<PaymentSubmission[]>(
                '/payments/submissions',
                guardian.token
              )
            )[0].recipientNumber,
            '01700000001'
          );
        }
      );
      await t.test(
        'rejects with a reason and allows corrected resubmission',
        async () => {
          await request(
            `/admin/payments/${payment!.id}/decision`,
            admin.token,
            { decision: 'REJECTED' },
            'PATCH',
            400
          );
          await request(
            `/admin/payments/${payment!.id}/decision`,
            admin.token,
            {
              decision: 'REJECTED',
              note: 'Transaction was entered incorrectly',
            },
            'PATCH'
          );
          const corrected = await request<PaymentSubmission>(
            '/payments/submissions',
            guardian.token,
            { ...paymentInput, transactionId: 'CORRECT123' },
            'POST',
            201
          );
          payment = corrected;
          assert.equal(
            (await request<Bill[]>('/payments/monthly', guardian.token))[0]
              .status,
            'UNPAID'
          );
        }
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
              })
            )
          );
          assert.deepEqual(
            responses.map((response) => response.status).sort(),
            [200, 409]
          );
          assert.equal(
            (await request<Bill[]>('/payments/monthly', guardian.token))[0]
              .status,
            'PAID'
          );
          await request(
            '/payments/submissions',
            guardian.token,
            { ...paymentInput, transactionId: 'DIFFERENT123' },
            'POST',
            409
          );
          const notifications = await request<{ id: string; title: string }[]>(
            '/notifications',
            guardian.token
          );
          const confirmations = notifications.filter(
            (notification) => notification.title === 'Payment completed'
          );
          assert.equal(confirmations.length, 1);
          await request(
            `/notifications/${confirmations[0].id}/read`,
            other.token,
            undefined,
            'PATCH',
            404
          );
          await request(
            `/notifications/${confirmations[0].id}/read`,
            guardian.token,
            undefined,
            'PATCH',
            204
          );
        }
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
            201
          );
          await request(
            `/admin/requests/${secondRequest.id}/decision`,
            admin.token,
            { decision: 'APPROVED' },
            'PATCH'
          );
          await request(
            '/admin/bills/generate',
            admin.token,
            { month },
            'POST',
            201
          );
          const unpaid = (
            await request<Bill[]>('/payments/monthly', guardian.token)
          ).find((item) => item.status === 'UNPAID')!;
          await request(
            '/payments/submissions',
            guardian.token,
            { ...paymentInput, billId: unpaid.id, transactionId: 'correct123' },
            'POST',
            409
          );
        }
      );
      await t.test(
        'rolls back all payment writes if notification persistence fails',
        async () => {
          const db = app.get(DatabaseService);
          const unpaid = (
            await request<Bill[]>('/payments/monthly', guardian.token)
          ).find((item) => item.status === 'UNPAID')!;
          await db.exec(`CREATE FUNCTION fail_notification() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'test failure'; END; $$;
          CREATE TRIGGER fail_notification BEFORE INSERT ON notifications
          FOR EACH ROW EXECUTE FUNCTION fail_notification()`);
          await request(
            '/payments/submissions',
            guardian.token,
            {
              ...paymentInput,
              billId: unpaid.id,
              transactionId: 'ROLLBACK123',
            },
            'POST',
            500
          );
          await db.exec(
            'DROP TRIGGER fail_notification ON notifications; DROP FUNCTION fail_notification()'
          );
          assert.equal(
            Number(
              (
                await db.get(
                  `SELECT count(*) total FROM payment_submissions WHERE "transactionId" = 'ROLLBACK123'`
                )
              ).total
            ),
            0
          );
        }
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
            201
          );
          await request(
            `/admin/complaints/${complaint.id}`,
            admin.token,
            {
              status: 'RESOLVED',
              note: 'Pickup timing corrected with the driver',
            },
            'PATCH'
          );
          const gateway = new RealtimeGateway(
            app.get(AuthService),
            app.get(AccessService)
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
          await gateway.publishLocation({ imei: '868720065798377' });
          assert.equal(deliveries, 1);
          for (const active of await request<Identified[]>(
            '/subscriptions',
            guardian.token
          )) {
            const stop = await request<Identified>(
              '/stop-requests',
              guardian.token,
              { subscriptionId: active.id, reason: 'No longer need transport' },
              'POST',
              201
            );
            await request(
              '/stop-requests',
              guardian.token,
              { subscriptionId: active.id, reason: 'Duplicate stop request' },
              'POST',
              409
            );
            await request(
              `/admin/stop-requests/${stop.id}/decision`,
              admin.token,
              { decision: 'APPROVED' },
              'PATCH'
            );
          }
          await gateway.publishLocation({ imei: '868720065798377' });
          assert.equal(
            deliveries,
            1,
            'already connected sockets must lose tracking access'
          );
          await request(
            '/locations/868720065798377',
            guardian.token,
            undefined,
            'GET',
            403
          );
          assert.deepEqual(await request('/vehicles', guardian.token), {
            vehicles: [],
          });
          assert.equal(
            (await request<Bill[]>('/payments/monthly', guardian.token)).length,
            2,
            'billing history survives a stop'
          );
          await request('/auth/logout', guardian.token, undefined, 'POST', 204);
          await gateway.publishLocation({ imei: '868720065798377' });
          assert.equal(disconnected, true);
          await request('/auth/me', guardian.token, undefined, 'GET', 401);
        }
      );
      await t.test(
        'does not persist raw session tokens or passwords',
        async () => {
          const db = app.get(DatabaseService);
          assert.equal(
            await db.get(
              'SELECT "tokenHash" FROM sessions WHERE "tokenHash" = $1',
              admin.token
            ),
            undefined
          );
          assert.notEqual(
            (
              await db.get(
                'SELECT "passwordHash" FROM users WHERE id = $1',
                admin.user.id
              )
            ).passwordHash,
            process.env.ADMIN_PASSWORD
          );
          assert.equal(
            Number(
              (
                await db.get(
                  "SELECT count(*) total FROM audit_logs WHERE action = 'PAYMENT_APPROVED'"
                )
              ).total
            ),
            1
          );
        }
      );
    } finally {
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
);
