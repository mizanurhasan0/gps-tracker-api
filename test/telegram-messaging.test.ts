import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.HISTORY_TEST_DATABASE_URL;
type Row = Record<string, any>;

test('admin Telegram messaging HTTP integration', { skip: !databaseUrl }, async (t) => {
  const schema = `telegram_messaging_${randomUUID().replaceAll('-', '')}`;
  const setup = new Pool({ connectionString: databaseUrl });
  await setup.query(`CREATE SCHEMA ${schema}`);
  const isolated = new URL(databaseUrl!);
  isolated.searchParams.set('options', `-c search_path=${schema}`);
  process.env.DATABASE_URL = isolated.toString();
  process.env.ADMIN_PHONE = '01700000101';
  process.env.ADMIN_PASSWORD = 'messaging-admin-pass';
  const { appConfig } = require('../dist/config/app.config');
  // Connect links must fail closed here instead of reaching a bot from a local env file.
  Object.assign(appConfig.telegram, { enabled: false, botToken: undefined });
  const { SecurityModule } = require('../dist/auth/security.module');
  const { TransportModule } = require('../dist/transport/transport.module');
  const { VehiclesModule } = require('../dist/vehicles/vehicles.module');
  const { DatabaseService } = require('../dist/database/database.service');
  const {
    NotificationsService,
    DELIVERY_MAX_ATTEMPTS,
  } = require('../dist/notifications/notifications.service');
  const { dhakaDate } = require('../dist/common/dhaka-time');
  class TestApp {}
  Module({ imports: [SecurityModule, TransportModule, VehiclesModule] })(TestApp);
  const app = await NestFactory.create<NestExpressApplication>(TestApp, { logger: false });
  app.useBodyParser('json', { limit: '768kb' });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  await app.listen(0, '127.0.0.1');
  // Delivery states are set by hand below; the outbox worker must not race them.
  await app.get(NotificationsService).onApplicationShutdown();
  const origin = await app.getUrl();
  const db = app.get(DatabaseService);
  t.after(async () => {
    await app.close();
    await setup.query(`DROP SCHEMA ${schema} CASCADE`);
    await setup.end();
  });
  async function request(
    path: string,
    token?: string,
    body?: unknown,
    method = 'GET',
    status = 200,
  ): Promise<any> {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const data = response.status === 204 ? undefined : await response.json();
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(data)}`);
    return data;
  }

  const admin = await request(
    '/auth/login',
    undefined,
    { phone: process.env.ADMIN_PHONE, password: process.env.ADMIN_PASSWORD },
    'POST',
  );
  const adminUser = await db.get('SELECT id,name FROM users WHERE role=$1', 'ADMIN');
  const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf'] as const;
  const guardians: Record<(typeof names)[number], Row> = {} as never;
  for (const [index, name] of names.entries())
    guardians[name] = await request(
      '/auth/register',
      undefined,
      { name, phone: `0171000000${index}`, password: 'guardian-password' },
      'POST',
      201,
    );
  const { Alpha, Bravo, Charlie, Delta, Echo, Foxtrot, Golf } = guardians;
  const vehicle = (index: number) =>
    request(
      '/vehicles',
      admin.token,
      { name: `Van ${index}`, plate: `DHK-${index}`, imei: `86872006579000${index}` },
      'POST',
      201,
    );
  const route = (name: string, vehicleId: string) =>
    request(
      '/admin/routes',
      admin.token,
      { name, vehicleId, monthlyAmount: 250000, stops: ['Stop A', 'Stop B'] },
      'POST',
      201,
    );
  const enroll = (studentName: string, guardian: Row, enrolledRoute: Row) =>
    request(
      '/admin/students',
      admin.token,
      {
        studentName,
        guardianPhone: guardian.user.phone,
        routeId: enrolledRoute.id,
        stopId: enrolledRoute.stops[0].id,
      },
      'POST',
      201,
    );
  const [v1, v2, v3] = [await vehicle(1), await vehicle(2), await vehicle(3)];
  const r1 = await route('Route One', v1.id);
  const r2 = await route('Route Two', v2.id);
  const retired = await route('Retired route', v1.id);
  await enroll('Zara', Alpha, r1);
  await enroll('Amin', Alpha, r1);
  await enroll('Kabir', Alpha, r2);
  await enroll('Bilal', Bravo, r1);
  const stopped = await enroll('Chand', Charlie, r1);
  await request(
    `/admin/students/${stopped.id}/stop`,
    admin.token,
    { stopDate: dhakaDate(), finalMonthlyFee: 0 },
    'PATCH',
  );
  await enroll('Dina', Delta, retired);
  await db.run('UPDATE routes SET active=0 WHERE id=$1', retired.id);
  const archived = await enroll('Ema', Echo, r1);
  // Archiving through the API also stops the service; keep it ACTIVE to isolate the archive filter.
  await db.run(
    'UPDATE student_profiles SET "archivedAt"=now() WHERE id=(SELECT "studentId" FROM subscriptions WHERE id=$1)',
    archived.id,
  );
  await enroll('Faria', Foxtrot, r2);
  await enroll('Gias', Golf, r2);
  for (const [index, guardian] of [Alpha, Bravo, Charlie, Delta, Echo, Foxtrot].entries())
    await db.run(
      `INSERT INTO telegram_connections("guardianId","chatId",username) VALUES($1,$2,'')`,
      guardian.user.id,
      90001 + index,
    );
  const messageCount = async () =>
    Number((await db.get('SELECT count(*)::int count FROM telegram_messages')).count);
  const sendMessage = (body: Row, token = admin.token, status = 201) =>
    request('/admin/telegram-messages', token, { requestId: randomUUID(), ...body }, 'POST', status);

  await t.test('migration 15 seeds the legacy SMS templates as saved messages', async () => {
    assert.deepEqual(
      (await db.all('SELECT version FROM app_migrations WHERE version=15')).length,
      1,
    );
    const seeded = await request('/admin/message-templates', admin.token);
    const settings = (await db.get('SELECT data FROM business_settings WHERE id=1')).data;
    assert.deepEqual(
      seeded.map((template: Row) => [template.title, template.body]),
      [
        ['পেমেন্ট রিমাইন্ডার', settings.paymentReminder],
        ['অনুপস্থিতি', settings.absenceMessage],
        ['গাড়ি দেরি', settings.delayMessage],
        ['ছুটির বার্তা', settings.holidayMessage],
        ['জরুরি বার্তা', settings.emergencyMessage],
      ],
    );
    assert.ok(seeded.every((template: Row) => template.body.length > 0));
    for (const template of seeded) {
      assert.match(template.id, /^[0-9a-f-]{36}$/);
      assert.equal(new Date(template.createdAt).toISOString(), template.createdAt);
    }
    // The legacy keys stay for older app builds.
    for (const key of ['paymentReminder', 'absenceMessage', 'delayMessage', 'holidayMessage', 'emergencyMessage'])
      assert.equal(typeof settings[key], 'string');
  });

  await t.test('saved messages support trimmed, validated CRUD for admins only', async () => {
    await request('/admin/message-templates', Alpha.token, undefined, 'GET', 403);
    await request('/admin/message-templates', Alpha.token, { title: 'x', body: 'y' }, 'POST', 403);
    const created = await request(
      '/admin/message-templates',
      admin.token,
      { title: '  Exam day  ', body: '  No service tomorrow  ' },
      'POST',
      201,
    );
    assert.equal(created.title, 'Exam day');
    assert.equal(created.body, 'No service tomorrow');
    assert.equal(created.createdAt, created.updatedAt);
    assert.equal((await request('/admin/message-templates', admin.token))[0].id, created.id);
    for (const invalid of [
      { title: '', body: 'x' },
      { title: '   ', body: 'x' },
      { title: 'a'.repeat(81), body: 'x' },
      { title: 'x', body: '  ' },
      { title: 'x', body: 'a'.repeat(2001) },
      { title: 'x' },
      { title: 5, body: 'x' },
      { title: 'x', body: 'y', category: 'OTHER' },
    ])
      await request('/admin/message-templates', admin.token, invalid, 'POST', 400);
    const longest = await request(
      '/admin/message-templates',
      admin.token,
      { title: 'a'.repeat(80), body: 'b'.repeat(2000) },
      'POST',
      201,
    );
    assert.equal(longest.body.length, 2000);

    const updated = await request(
      `/admin/message-templates/${created.id}`,
      admin.token,
      { body: '  Updated body  ' },
      'PATCH',
    );
    assert.equal(updated.title, 'Exam day');
    assert.equal(updated.body, 'Updated body');
    assert.ok(Date.parse(updated.updatedAt) >= Date.parse(created.updatedAt));
    const renamed = await request(
      `/admin/message-templates/${created.id}`,
      admin.token,
      { title: 'Exam week' },
      'PATCH',
    );
    assert.deepEqual([renamed.title, renamed.body], ['Exam week', 'Updated body']);
    for (const invalid of [{ title: null }, { body: null }, { title: '  ' }, { body: 'a'.repeat(2001) }])
      await request(`/admin/message-templates/${created.id}`, admin.token, invalid, 'PATCH', 400);
    await request(`/admin/message-templates/${randomUUID()}`, admin.token, { title: 'x' }, 'PATCH', 404);
    await request('/admin/message-templates/not-a-uuid', admin.token, { title: 'x' }, 'PATCH', 400);

    await request(`/admin/message-templates/${longest.id}`, admin.token, undefined, 'DELETE', 204);
    await request(`/admin/message-templates/${longest.id}`, admin.token, undefined, 'DELETE', 404);
    await request(`/admin/message-templates/${randomUUID()}`, Alpha.token, undefined, 'DELETE', 403);
    const remaining = await request('/admin/message-templates', admin.token);
    assert.ok(!remaining.some((template: Row) => template.id === longest.id));
    assert.equal(remaining.length, 6);
    assert.deepEqual(
      (
        await db.all(
          `SELECT action FROM audit_logs WHERE "entityId"=ANY($1::text[]) ORDER BY "createdAt",action`,
          [created.id, longest.id],
        )
      ).map((row: Row) => row.action),
      [
        'MESSAGE_TEMPLATE_CREATED',
        'MESSAGE_TEMPLATE_CREATED',
        'MESSAGE_TEMPLATE_UPDATED',
        'MESSAGE_TEMPLATE_UPDATED',
        'MESSAGE_TEMPLATE_DELETED',
      ],
    );
  });

  await t.test('recipients include only eligible guardians, grouped per requested vehicle', async () => {
    const recipients = await request(
      `/admin/telegram-messages/recipients?vehicleIds=${v1.id},${v2.id},${v3.id}`,
      admin.token,
    );
    assert.deepEqual(
      recipients.vehicles.map((item: Row) => [
        item.vehicleId,
        item.name,
        item.plate,
        item.guardians.map((guardian: Row) => guardian.name),
      ]),
      [
        [v1.id, 'Van 1', 'DHK-1', ['Alpha', 'Bravo']],
        [v2.id, 'Van 2', 'DHK-2', ['Alpha', 'Foxtrot', 'Golf']],
        [v3.id, 'Van 3', 'DHK-3', []],
      ],
    );
    assert.deepEqual(recipients.vehicles[0].guardians[0], {
      guardianId: Alpha.user.id,
      name: 'Alpha',
      phone: Alpha.user.phone,
      studentNames: ['Amin', 'Zara'],
      telegramConnected: true,
    });
    assert.deepEqual(recipients.vehicles[1].guardians[0].studentNames, ['Kabir']);
    assert.equal(recipients.vehicles[1].guardians[2].telegramConnected, false);
    assert.deepEqual(recipients.totals, { guardians: 4, telegramConnected: 3 });

    const reordered = await request(
      `/admin/telegram-messages/recipients?vehicleIds=${v3.id},${v1.id}`,
      admin.token,
    );
    assert.deepEqual(
      reordered.vehicles.map((item: Row) => item.vehicleId),
      [v3.id, v1.id],
    );
    assert.deepEqual(reordered.totals, { guardians: 2, telegramConnected: 2 });

    // A disconnected link no longer counts as connected.
    await db.run(
      `UPDATE telegram_connections SET status='DISCONNECTED',"disconnectedAt"=now() WHERE "guardianId"=$1`,
      Bravo.user.id,
    );
    const disconnected = await request(
      `/admin/telegram-messages/recipients?vehicleIds=${v1.id}`,
      admin.token,
    );
    assert.equal(disconnected.vehicles[0].guardians[1].telegramConnected, false);
    await db.run(
      `UPDATE telegram_connections SET status='CONNECTED',"disconnectedAt"=NULL WHERE "guardianId"=$1`,
      Bravo.user.id,
    );

    const unknown = await request(
      `/admin/telegram-messages/recipients?vehicleIds=${v1.id},${randomUUID()}`,
      admin.token,
      undefined,
      'GET',
      400,
    );
    assert.equal(unknown.message, 'One or more selected vehicles were not found');
    for (const query of ['', '?vehicleIds=', '?vehicleIds=nope', `?vehicleIds=${v1.id},${v1.id}`])
      await request(`/admin/telegram-messages/recipients${query}`, admin.token, undefined, 'GET', 400);
    await request(
      `/admin/telegram-messages/recipients?vehicleIds=${v1.id}`,
      Alpha.token,
      undefined,
      'GET',
      403,
    );
  });

  let all: Row;
  let selected: Row;
  let untemplated: Row;
  await t.test('sending to ALL reaches each eligible guardian once', async () => {
    all = await sendMessage({ vehicleIds: [v1.id, v2.id], body: '  Bus is late today  ' });
    assert.match(all.id, /^[0-9a-f-]{36}$/);
    assert.equal(all.title, 'NOOR TRANSPORT');
    assert.equal(all.body, 'Bus is late today');
    assert.equal(all.audience, 'ALL');
    assert.deepEqual(all.vehicles, [
      { id: v1.id, name: 'Van 1' },
      { id: v2.id, name: 'Van 2' },
    ]);
    assert.equal(all.templateId, null);
    assert.deepEqual(all.createdBy, { id: adminUser.id, name: adminUser.name });
    assert.equal(new Date(all.createdAt).toISOString(), all.createdAt);
    assert.deepEqual(all.stats, { recipients: 4, sent: 0, pending: 3, failed: 0, appOnly: 1 });
    assert.deepEqual(
      all.recipients.map((recipient: Row) => [recipient.name, recipient.status]),
      [
        ['Alpha', 'PENDING'],
        ['Bravo', 'PENDING'],
        ['Foxtrot', 'PENDING'],
        ['Golf', 'APP_ONLY'],
      ],
    );
    assert.deepEqual(all.recipients[0], {
      guardianId: Alpha.user.id,
      name: 'Alpha',
      phone: Alpha.user.phone,
      status: 'PENDING',
      sentAt: null,
      error: null,
    });

    const notifications = await db.all(
      'SELECT "userId",title,body FROM notifications WHERE "entityId"=$1 ORDER BY "userId"',
      all.id,
    );
    assert.deepEqual(
      notifications.map((row: Row) => row.userId),
      [Alpha, Bravo, Foxtrot, Golf].map((guardian) => guardian.user.id).sort(),
    );
    assert.ok(notifications.every((row: Row) => row.title === 'NOOR TRANSPORT'));
    const queued = await db.all(
      `SELECT d."guardianId",d.title,d.body,d.status FROM telegram_deliveries d
       JOIN notifications n ON n.id=d."notificationId" WHERE n."entityId"=$1`,
      all.id,
    );
    assert.equal(queued.length, 3);
    assert.ok(queued.every((row: Row) => row.body === 'Bus is late today' && row.status === 'PENDING'));
    assert.ok(!queued.some((row: Row) => row.guardianId === Golf.user.id));
    assert.ok(
      (await request('/notifications', Golf.token)).some((row: Row) => row.entityId === all.id),
    );
    assert.equal(
      (await db.get('SELECT note FROM audit_logs WHERE action=$1 AND "entityId"=$2', 'TELEGRAM_MESSAGE_SENT', all.id))
        .note,
      '4 recipients, 3 queued for Telegram',
    );
  });

  await t.test('sending to SELECTED guardians keeps the template link', async () => {
    const templates = await request('/admin/message-templates', admin.token);
    selected = await sendMessage({
        vehicleIds: [v1.id, v2.id],
        guardianIds: [Golf.user.id, Foxtrot.user.id],
        body: templates[0].body,
        templateId: templates[0].id,
      });
    assert.equal(selected.audience, 'SELECTED');
    assert.equal(selected.templateId, templates[0].id);
    assert.deepEqual(
      selected.recipients.map((recipient: Row) => [recipient.name, recipient.status]),
      [
        ['Foxtrot', 'PENDING'],
        ['Golf', 'APP_ONLY'],
      ],
    );
    assert.deepEqual(selected.stats, { recipients: 2, sent: 0, pending: 1, failed: 0, appOnly: 1 });

    untemplated = await sendMessage({ vehicleIds: [v1.id], guardianIds: [Bravo.user.id], body: 'Hello', templateId: randomUUID() });
    assert.equal(untemplated.templateId, null);
    assert.deepEqual(untemplated.recipients.map((recipient: Row) => recipient.name), ['Bravo']);
  });

  await t.test('the notification title follows the business name', async () => {
    await request('/admin/settings', admin.token, { businessName: 'Noor School Van' }, 'PATCH');
    const named = await sendMessage({ vehicleIds: [v1.id], guardianIds: [Alpha.user.id], body: 'Named' });
    assert.equal(named.title, 'Noor School Van');
    await db.run(`UPDATE business_settings SET data=jsonb_set(data,'{businessName}','"   "') WHERE id=1`);
    const fallback = await sendMessage({ vehicleIds: [v1.id], guardianIds: [Alpha.user.id], body: 'Fallback' });
    assert.equal(fallback.title, 'বার্তা');
    assert.equal(
      (await db.get('SELECT title FROM notifications WHERE "entityId"=$1', fallback.id)).title,
      'বার্তা',
    );
  });

  await t.test('sending rejects ineligible, unknown and empty recipient sets', async () => {
    const before = await messageCount();
    const notificationsBefore = Number(
      (await db.get('SELECT count(*)::int count FROM notifications')).count,
    );
    const send = (body: Row, status = 400) => sendMessage(body, admin.token, status);
    for (const guardian of [Bravo, Charlie, Delta, Echo])
      assert.equal(
        (await send({ vehicleIds: [v2.id], guardianIds: [Golf.user.id, guardian.user.id], body: 'x' }))
          .message,
        'Some selected guardians are not on the selected vehicles',
      );
    for (const guardian of [Charlie, Delta, Echo])
      await send({ vehicleIds: [v1.id], guardianIds: [guardian.user.id], body: 'x' });
    assert.equal(
      (await send({ vehicleIds: [v3.id], body: 'x' })).message,
      'No guardians found for the selected vehicles',
    );
    assert.equal(
      (await send({ vehicleIds: [v1.id, randomUUID()], body: 'x' })).message,
      'One or more selected vehicles were not found',
    );
    for (const invalid of [
      { vehicleIds: [], body: 'x' },
      { vehicleIds: [v1.id, v1.id], body: 'x' },
      { vehicleIds: ['nope'], body: 'x' },
      { vehicleIds: v1.id, body: 'x' },
      { vehicleIds: [v1.id], body: '   ' },
      { vehicleIds: [v1.id], body: 'a'.repeat(2001) },
      { vehicleIds: [v1.id] },
      { vehicleIds: [v1.id], guardianIds: [], body: 'x' },
      { vehicleIds: [v1.id], guardianIds: null, body: 'x' },
      { vehicleIds: [v1.id], guardianIds: [Alpha.user.id, Alpha.user.id], body: 'x' },
      { vehicleIds: [v1.id], body: 'x', templateId: 'nope' },
      { vehicleIds: [v1.id], body: 'x', title: 'Custom' },
      { vehicleIds: [v1.id], body: 'x', requestId: undefined },
      { vehicleIds: [v1.id], body: 'x', requestId: null },
      { vehicleIds: [v1.id], body: 'x', requestId: '' },
      { vehicleIds: [v1.id], body: 'x', requestId: 'not-a-uuid' },
      { vehicleIds: [v1.id], body: 'x', requestId: 42 },
    ])
      await send(invalid);
    await sendMessage({ vehicleIds: [v1.id], body: 'x' }, Alpha.token, 403);
    assert.equal(await messageCount(), before);
    assert.equal(
      Number((await db.get('SELECT count(*)::int count FROM notifications')).count),
      notificationsBefore,
    );
  });

  await t.test('history stats and recipient status follow the Telegram outbox', async () => {
    const deliveryFor = async (messageId: string, guardian: Row) =>
      (
        await db.get(
          `SELECT d.id FROM telegram_message_recipients r
           JOIN telegram_deliveries d ON d."notificationId"=r."notificationId"
           WHERE r."messageId"=$1 AND r."guardianId"=$2`,
          messageId,
          guardian.user.id,
        )
      ).id;
    await db.run(
      `UPDATE telegram_deliveries SET status='SENT',attempts=1,"sentAt"='2026-10-19T04:00:00Z' WHERE id=$1`,
      await deliveryFor(all.id, Alpha),
    );
    await db.run(
      `UPDATE telegram_deliveries SET status='FAILED',attempts=3,"nextAttemptAt"=now()+interval '1 hour',
         "lastError"='Telegram timeout' WHERE id=$1`,
      await deliveryFor(all.id, Bravo),
    );
    await db.run(
      `UPDATE telegram_deliveries SET status='FAILED',attempts=$2,"lastError"='Telegram API error: Bad Gateway'
       WHERE id=$1`,
      await deliveryFor(all.id, Foxtrot),
      DELIVERY_MAX_ATTEMPTS,
    );
    await db.run(
      `UPDATE telegram_deliveries SET status='CANCELLED',attempts=1,"lastError"='Bot blocked' WHERE id=$1`,
      await deliveryFor(selected.id, Foxtrot),
    );
    await db.run(
      `UPDATE telegram_deliveries SET status='SENDING',attempts=1 WHERE id=$1`,
      await deliveryFor(untemplated.id, Bravo),
    );

    const detail = await request(`/admin/telegram-messages/${all.id}`, admin.token);
    assert.deepEqual(detail.stats, { recipients: 4, sent: 1, pending: 1, failed: 1, appOnly: 1 });
    assert.deepEqual(
      detail.recipients.map((recipient: Row) => [
        recipient.name,
        recipient.status,
        recipient.sentAt,
        recipient.error,
      ]),
      [
        ['Foxtrot', 'FAILED', null, 'Telegram API error: Bad Gateway'],
        ['Bravo', 'PENDING', null, null],
        ['Golf', 'APP_ONLY', null, null],
        ['Alpha', 'SENT', '2026-10-19T04:00:00.000Z', null],
      ],
    );
    const selectedDetail = await request(`/admin/telegram-messages/${selected.id}`, admin.token);
    assert.deepEqual(
      selectedDetail.recipients.map((recipient: Row) => [recipient.name, recipient.status, recipient.error]),
      [
        ['Foxtrot', 'FAILED', 'Bot blocked'],
        ['Golf', 'APP_ONLY', null],
      ],
    );

    const history = await request('/admin/telegram-messages', admin.token);
    assert.deepEqual(
      [history.page, history.pageSize, history.total, history.totalPages],
      [1, 20, 5, 1],
    );
    assert.equal(history.items.length, 5);
    assert.deepEqual(history.items.slice(2).map((item: Row) => item.id), [untemplated.id, selected.id, all.id]);
    assert.ok(!('recipients' in history.items[0]));
    const byId = new Map<string, Row>(history.items.map((item: Row) => [item.id, item]));
    assert.deepEqual(byId.get(all.id)!.stats, detail.stats);
    assert.deepEqual(byId.get(selected.id)!.stats, { recipients: 2, sent: 0, pending: 0, failed: 1, appOnly: 1 });
    assert.deepEqual(byId.get(untemplated.id)!.stats, { recipients: 1, sent: 0, pending: 1, failed: 0, appOnly: 0 });
    const { recipients: _recipients, ...summary } = detail;
    assert.deepEqual(byId.get(all.id), summary);

    const second = await request('/admin/telegram-messages?page=2&pageSize=2', admin.token);
    assert.deepEqual([second.page, second.pageSize, second.total, second.totalPages], [2, 2, 5, 3]);
    assert.deepEqual(second.items.map((item: Row) => item.id), [untemplated.id, selected.id]);
    assert.deepEqual((await request('/admin/telegram-messages?page=9', admin.token)).items, []);
    for (const query of ['?page=0', '?pageSize=0', '?pageSize=51', '?page=x'])
      await request(`/admin/telegram-messages${query}`, admin.token, undefined, 'GET', 400);
    await request(`/admin/telegram-messages/${randomUUID()}`, admin.token, undefined, 'GET', 404);
    await request('/admin/telegram-messages/not-a-uuid', admin.token, undefined, 'GET', 400);
    await request('/admin/telegram-messages', Alpha.token, undefined, 'GET', 403);
    await request(`/admin/telegram-messages/${all.id}`, Alpha.token, undefined, 'GET', 403);

    // History keeps the vehicle snapshot and drops a deleted template link.
    await db.run('UPDATE vehicles SET name=$2 WHERE id=$1', v1.id, 'Renamed van');
    await request(`/admin/message-templates/${selected.templateId}`, admin.token, undefined, 'DELETE', 204);
    const kept = await request(`/admin/telegram-messages/${selected.id}`, admin.token);
    assert.equal(kept.templateId, null);
    assert.deepEqual(kept.vehicles, [
      { id: v1.id, name: 'Van 1' },
      { id: v2.id, name: 'Van 2' },
    ]);
  });

  const sendCounts = () =>
    db.get(`SELECT (SELECT count(*)::int FROM telegram_messages) messages,
      (SELECT count(*)::int FROM telegram_message_recipients) recipients,
      (SELECT count(*)::int FROM notifications) notifications,
      (SELECT count(*)::int FROM telegram_deliveries) deliveries,
      (SELECT count(*)::int FROM audit_logs WHERE action='TELEGRAM_MESSAGE_SENT') audits`);
  // Sending to V1 and V2 reaches Alpha, Bravo, Foxtrot and Golf; Golf has no Telegram link.
  const oneSend = (before: Row) => ({
    messages: before.messages + 1,
    recipients: before.recipients + 4,
    notifications: before.notifications + 4,
    deliveries: before.deliveries + 3,
    audits: before.audits + 1,
  });
  let replayedRequestId: string;
  await t.test('a repeated requestId returns the first send without sending again', async () => {
    replayedRequestId = randomUUID();
    const draft = { vehicleIds: [v1.id, v2.id], body: 'Idempotent notice', requestId: replayedRequestId };
    const before = await sendCounts();
    const first = await sendMessage(draft);
    const afterFirst = await sendCounts();
    assert.deepEqual(afterFirst, oneSend(before));
    const retry = await sendMessage(draft, admin.token, 200);
    assert.deepEqual(retry, first);
    // The stored message wins even if the retried draft changed meanwhile.
    const edited = await sendMessage(
      { ...draft, vehicleIds: [v3.id], body: 'Edited text' },
      admin.token,
      200,
    );
    assert.equal(edited.id, first.id);
    assert.equal(edited.body, 'Idempotent notice');
    assert.deepEqual(await sendCounts(), afterFirst);
  });

  await t.test('concurrent sends with one requestId create exactly one message', async () => {
    const requestId = randomUUID();
    const before = await sendCounts();
    const post = () =>
      fetch(`${origin}/admin/telegram-messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ vehicleIds: [v1.id, v2.id], body: 'Concurrent notice', requestId }),
      });
    const responses = await Promise.all([post(), post(), post()]);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    assert.deepEqual(
      responses.map((response) => response.status).sort(),
      [200, 200, 201],
      JSON.stringify(bodies),
    );
    assert.equal(new Set(bodies.map((body: Row) => body.id)).size, 1);
    assert.deepEqual(await sendCounts(), oneSend(before));
  });

  await t.test('another admin cannot reuse a requestId', async () => {
    const { hashPassword } = require('../dist/auth/password');
    await db.run(
      `INSERT INTO users(id,name,phone,"passwordHash",role,verified,"createdAt")
       VALUES($1,'Second admin','01700000102',$2,'ADMIN',1,$3)`,
      randomUUID(),
      await hashPassword('second-admin-pass'),
      new Date().toISOString(),
    );
    const secondAdmin = await request(
      '/auth/login',
      undefined,
      { phone: '01700000102', password: 'second-admin-pass' },
      'POST',
    );
    const before = await sendCounts();
    const conflict = await sendMessage(
      { vehicleIds: [v1.id], body: 'Reused key', requestId: replayedRequestId },
      secondAdmin.token,
      409,
    );
    assert.equal(conflict.message, 'This message request was already used');
    assert.deepEqual(await sendCounts(), before);
  });

  await t.test('released app builds can request a Telegram link with GET', async () => {
    // Telegram is disabled in this environment, so reaching the handler yields 503 rather than 404.
    await request('/telegram/connect', Alpha.token, undefined, 'GET', 503);
    await request('/telegram/connect', Alpha.token, undefined, 'POST', 503);
    await request('/telegram/connect', admin.token, undefined, 'GET', 403);
    await request('/telegram/connect', undefined, undefined, 'GET', 401);
  });
});
