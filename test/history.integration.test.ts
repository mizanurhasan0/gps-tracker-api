import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

const url = process.env.HISTORY_TEST_DATABASE_URL;

test(
  'PostgreSQL history, durable outbox, HTTP access and snapshot integration',
  { skip: !url },
  async t => {
    const directory = mkdtempSync(join(tmpdir(), 'gps-history-'));
    const schema = `history_test_${randomUUID().replace(/-/g, '')}`;
    const setup = new Pool({ connectionString: url });
    await setup.query(`CREATE SCHEMA ${schema}`);
    const isolated = new URL(url!);
    isolated.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = isolated.toString();
    process.env.DATA_DIR = directory;
    process.env.ADMIN_PHONE = '01700000999';
    process.env.ADMIN_PASSWORD = 'history-test-password-123';
    const { SecurityModule } = require('../dist/auth/security.module');
    const { LocationsModule } = require('../dist/locations/locations.module');
    const { LocationsService } = require('../dist/locations/locations.service');
    const { HistoryRepository } = require('../dist/history/history.repository');
    const { HistoryIngestion } = require('../dist/history/history.ingestion');
    const { HistoryService } = require('../dist/history/history.service');
    const { DatabaseService } = require('../dist/database/database.service');
    class TestApp {}
    Module({ imports: [SecurityModule, LocationsModule] })(TestApp);
    let app = await NestFactory.create(TestApp, { logger: false });
    await app.listen(0, '127.0.0.1');
    const pg = new Pool({ connectionString: isolated.toString() });
    const imei = '868720065798377';
    const from = '2024-09-01T18:00:00.000Z',
      to = '2024-09-02T18:00:00.000Z';
    const query = { from, to };
    const report = (gpsTime: string, latitude = 23.81) => ({
      imei,
      latitude,
      longitude: 90.41,
      speed: 10,
      course: 90,
      gpsTime,
      protocol: 0x12,
      status: 0x1400,
      gpsFixed: true,
    });
    try {
      let ingestion = app.get(HistoryIngestion);
      let locations = app.get(LocationsService);
      let repository = app.get(HistoryRepository);
      await repository.ensureReady();
      const origin = await app.getUrl();
      const request = async (path: string, token?: string, body?: unknown) =>
        fetch(origin + path, {
          method: body ? 'POST' : 'GET',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      const adminResponse = await request('/auth/login', undefined, {
        phone: process.env.ADMIN_PHONE,
        password: process.env.ADMIN_PASSWORD,
      });
      const admin = (await adminResponse.json()) as { token: string };
      const guardianResponse = await request('/auth/register', undefined, {
        name: 'History guardian',
        phone: '01700000888',
        password: 'guardian-password-123',
      });
      const guardian = (await guardianResponse.json()) as { token: string };
      const path = `/locations/${imei}/history/summary?from=${from}&to=${to}`;
      await t.test('requires an admin on all history routes', async () => {
        for (const suffix of ['', '/summary', '/route']) {
          const endpoint = `/locations/${imei}/history${suffix}?from=${from}&to=${to}`;
          assert.equal((await request(endpoint)).status, 401);
          assert.equal((await request(endpoint, guardian.token)).status, 403);
          assert.equal((await request(endpoint, admin.token)).status, 200);
        }
        assert.equal(
          (
            await request(
              `/locations/${imei}/history?from=bad&to=${to}`,
              admin.token,
            )
          ).status,
          400,
        );
      });
      await t.test(
        'persists before returning; late points do not replace latest; invalid times and fixes excluded',
        async () => {
          locations.savePosition(report('2024-09-02 00:00:00'));
          locations.savePosition(report('2024-09-02 00:01:00', 23.8101));
          locations.savePosition(report('2024-09-01 23:59:00', 23.8099));
          locations.savePosition({
            ...report('2024-09-02 00:02:00'),
            gpsFixed: false,
          });
          locations.savePosition(report('2024-02-30 12:00:00'));
          assert.equal(
            locations.findByImei(imei).gpsTime,
            '2024-09-02T00:01:00.000Z',
          );
          assert.equal(
            app
              .get(DatabaseService)
              .get('SELECT COUNT(*) AS count FROM gps_history_outbox').count,
            5,
          );
          assert.equal(ingestion.freshness(imei, from, to).pendingPoints, 3);
          await ingestion.flush();
          const result = await app.get(HistoryService).history(imei, query);
          assert.equal(result.points.length, 3);
          assert.equal(result.points[0].gpsTime, '2024-09-01T23:59:00.000Z');
          assert.equal(result.freshness.complete, true);
          assert.equal(
            (await pg.query('SELECT count(*)::int AS count FROM gps_history'))
              .rows[0].count,
            5,
          );
          assert.equal((await request(path, admin.token)).status, 200);
        },
      );
      await t.test(
        'retransmissions deduplicate after outbox deletion',
        async () => {
          locations.savePosition(report('2024-09-02 00:00:00'));
          await ingestion.flush();
          assert.equal(
            (await pg.query('SELECT count(*)::int AS count FROM gps_history'))
              .rows[0].count,
            5,
          );
        },
      );
      await t.test(
        'pagination snapshots exclude late inserts and reject cross-range cursors',
        async () => {
          const service = app.get(HistoryService);
          const first = await service.history(imei, { ...query, limit: '1' });
          locations.savePosition(report('2024-09-02 00:00:30', 23.81005));
          await ingestion.flush();
          const second = await service.history(imei, {
            ...query,
            limit: '10',
            cursor: first.nextCursor,
          });
          assert.equal(second.points.length, 2);
          assert.ok(
            second.points.every(
              (p: { gpsTime: string }) =>
                p.gpsTime !== '2024-09-02T00:00:30.000Z',
            ),
          );
          await assert.rejects(
            service.history('868720065798378', {
              ...query,
              cursor: first.nextCursor,
            }),
            /Invalid cursor/,
          );
        },
      );
      await t.test(
        'outbox survives unavailable PostgreSQL and application restart',
        async () => {
          const original = repository.insert.bind(repository);
          repository.insert = async () => {
            throw new Error('simulated database outage');
          };
          locations.savePosition(report('2024-09-02 00:03:00', 23.8103));
          await ingestion.flush();
          assert.equal(ingestion.freshness(imei, from, to).pendingPoints, 1);
          await app.close();
          repository.insert = original;
          app = await NestFactory.create(TestApp, { logger: false });
          // Nest init may immediately drain: both outcomes prove the queued event survives.
          await app.init();
          ingestion = app.get(HistoryIngestion);
          repository = app.get(HistoryRepository);
          locations = app.get(LocationsService);
          await ingestion.flush();
          const result = await app.get(HistoryService).history(imei, query);
          assert.ok(
            result.points.some(
              (p: { gpsTime: string }) =>
                p.gpsTime === '2024-09-02T00:03:00.000Z',
            ),
          );
          assert.equal(result.freshness.complete, true);
          assert.equal(
            locations.findByImei(imei).gpsTime,
            '2024-09-02T00:03:00.000Z',
          );
        },
      );
      await t.test(
        'does not acknowledge a report when durable enqueue fails',
        async () => {
          const { Gt06Connection } = require('../dist/gt06/gt06.connection');
          const { crc16X25 } = require('../dist/gt06/gt06.crc');
          const body = Buffer.from(
            '120B081D112E10CC027AC7EB0C46584900148F',
            'hex',
          );
          const checksummed = Buffer.concat([
            Buffer.from([body.length + 4]),
            body,
            Buffer.from([0, 3]),
          ]);
          const crc = Buffer.alloc(2);
          crc.writeUInt16BE(crc16X25(checksummed));
          const frame = Buffer.concat([
            Buffer.from([0x78, 0x78]),
            checksummed,
            crc,
            Buffer.from([0x0d, 0x0a]),
          ]);
          const writes: Buffer[] = [];
          const socket = {
            remoteAddress: '127.0.0.1',
            remotePort: 1234,
            destroyed: false,
            write: (buffer: Buffer) => writes.push(buffer),
            destroy: () => undefined,
          };
          const connection = new Gt06Connection(socket, locations, {
            publishLocation: () => undefined,
          });
          connection.handleData(
            Buffer.from('78780D0108687200657983770001F9790D0A', 'hex'),
          );
          assert.equal(writes.length, 1);
          const db = app.get(DatabaseService);
          db.exec(
            "CREATE TRIGGER reject_history BEFORE INSERT ON gps_history_outbox BEGIN SELECT RAISE(FAIL,'simulated full disk'); END;",
          );
          try {
            assert.throws(
              () => connection.handleData(frame),
              /simulated full disk/,
            );
            assert.equal(
              writes.length,
              1,
              'failed position did not receive an ACK',
            );
          } finally {
            db.exec('DROP TRIGGER reject_history');
          }
        },
      );
      await t.test(
        'unavailable history is explicit rather than an empty successful result',
        async () => {
          const original = repository.snapshot.bind(repository);
          repository.snapshot = async () => {
            throw new Error('connection unavailable');
          };
          try {
            await assert.rejects(
              app.get(HistoryService).summary(imei, query),
              (error: unknown) =>
                Boolean(
                  error &&
                    typeof error === 'object' &&
                    'getStatus' in error &&
                    (error as { getStatus: () => number }).getStatus() === 503,
                ),
            );
          } finally {
            repository.snapshot = original;
          }
        },
      );
      await t.test(
        'vehicle identity remains a historical snapshot after reassignment',
        async () => {
          const db = app.get(DatabaseService);
          db.run(
            'INSERT INTO vehicles(id,name,plate,imei,createdAt,updatedAt) VALUES(?,?,?,?,?,?)',
            'old-vehicle',
            'Old',
            'OLD',
            imei,
            from,
            from,
          );
          locations.savePosition(report('2024-09-02 00:04:00', 23.8104));
          await ingestion.flush();
          db.run(
            'UPDATE vehicles SET imei=? WHERE id=?',
            '868720065798379',
            'old-vehicle',
          );
          const result = await app.get(HistoryService).history(imei, query);
          assert.equal(
            result.points.find(
              (p: { gpsTime: string }) =>
                p.gpsTime === '2024-09-02T00:04:00.000Z',
            ).vehicleId,
            'old-vehicle',
          );
        },
      );
      await t.test(
        'dense 31-day summary and route remain bounded without truncating raw counts',
        async () => {
          const denseImei = '868720065798380';
          await pg.query(
            `INSERT INTO gps_history(event_key,imei,gps_time,received_at,latitude,longitude,speed,course,quality,raw_gps_time)
        SELECT 'dense-'||i,$1,'2024-08-31T18:00:00Z'::timestamptz+i*interval '10 seconds','2024-08-31T18:00:00Z'::timestamptz+i*interval '10 seconds',23.81,90.41,0,0,'valid','fixture'
        FROM generate_series(0,267839) i`,
            [denseImei],
          );
          const service = app.get(HistoryService);
          const range = {
            from: '2024-08-31T18:00:00Z',
            to: '2024-10-01T18:00:00Z',
          };
          const summary = await service.summary(denseImei, range);
          assert.equal(summary.days.length, 31);
          assert.equal(
            summary.days.reduce(
              (sum: number, day: { pointCount: number }) =>
                sum + day.pointCount,
              0,
            ),
            267840,
          );
          const route = await service.route(denseImei, {
            ...range,
            maxPoints: '100',
          });
          assert.equal(route.pointCount, 267840);
          assert.ok(route.displayedPointCount <= 100);
          assert.equal(route.simplified, true);
          assert.equal(route.gapCount, 0);
          assert.equal(route.distanceMeters, 0);
          for (const [start, end] of [
            ['2024-09-01', '2024-09-08'],
            ['2024-09-12', '2024-09-19'],
            ['2024-09-24', '2024-10-01'],
          ]) {
            assert.ok(
              route.segments[0].points.filter(
                (p: { gpsTime: string }) =>
                  p.gpsTime >= start && p.gpsTime < end,
              ).length >= 15,
              'route retains balanced early, middle and late samples',
            );
          }
          assert.equal(
            route.segments[0].points[0].gpsTime,
            '2024-08-31T18:00:00.000Z',
          );
          assert.equal(
            route.segments[0].points.at(-1).gpsTime,
            '2024-10-01T17:59:50.000Z',
          );
        },
      );
    } finally {
      await app.close();
      await pg.end();
      await setup.query(`DROP SCHEMA ${schema} CASCADE`);
      await setup.end();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
