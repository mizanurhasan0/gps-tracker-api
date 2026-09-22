import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.HISTORY_TEST_DATABASE_URL;

test(
  'database migration 8 creates Telegram tables and enforces delivery idempotency',
  { skip: !databaseUrl },
  async (t) => {
    const schema = `telegram_migration_${randomUUID().replaceAll('-', '')}`;
    const setup = new Pool({ connectionString: databaseUrl });
    await setup.query(`CREATE SCHEMA "${schema}"`);
    const isolated = new URL(databaseUrl!);
    isolated.searchParams.set('options', `-c search_path=${schema}`);
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = isolated.toString();
    const { DatabaseService } = require('../dist/database/database.service') as {
      DatabaseService: new () => {
        onModuleInit(): Promise<void>;
        onApplicationShutdown(): Promise<void>;
        all<T>(sql: string, ...params: unknown[]): Promise<T[]>;
        run(sql: string, ...params: unknown[]): Promise<{ rowCount: number }>;
      };
    };
    const db = new DatabaseService();
    t.after(async () => {
      await db.onApplicationShutdown();
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
      await setup.query(`DROP SCHEMA "${schema}" CASCADE`);
      await setup.end();
    });

    await db.onModuleInit();
    assert.deepEqual(
      await db.all<{ version: number }>('SELECT version FROM app_migrations WHERE version = 8'),
      [{ version: 8 }],
    );
    const tables = await db.all<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
     WHERE table_schema = current_schema()
       AND table_name = ANY($1::text[])
     ORDER BY table_name`,
      [
        'telegram_connections',
        'telegram_link_tokens',
        'telegram_webhook_updates',
        'telegram_deliveries',
        'pickup_points',
        'geofence_trips',
        'geofence_trip_states',
      ],
    );
    assert.deepEqual(
      tables.map(({ table_name }) => table_name),
      [
        'geofence_trip_states',
        'geofence_trips',
        'pickup_points',
        'telegram_connections',
        'telegram_deliveries',
        'telegram_link_tokens',
        'telegram_webhook_updates',
      ],
    );

    const guardianOne = randomUUID();
    const guardianTwo = randomUUID();
    const notification = randomUUID();
    const timestamp = '2026-09-19T00:00:00.000Z';
    await db.run(
      `INSERT INTO users(id,name,phone,"passwordHash",role,"createdAt")
     VALUES ($1,'Guardian One',$2,'hash','GUARDIAN',$3),
            ($4,'Guardian Two',$5,'hash','GUARDIAN',$3)`,
      guardianOne,
      `017${guardianOne.slice(0, 8)}`,
      timestamp,
      guardianTwo,
      `018${guardianTwo.slice(0, 8)}`,
    );
    await db.run(
      `INSERT INTO notifications(id,"userId",title,body,"entityId","createdAt")
     VALUES ($1,$2,'Bus alert','Near pickup point',$3,$4)`,
      notification,
      guardianOne,
      randomUUID(),
      timestamp,
    );
    await db.run(
      `INSERT INTO telegram_deliveries
      (id,"eventKey","notificationId","guardianId","chatId",title,body)
     VALUES ($1,'pickup:trip-1:stop-1',$2,$3,88001,'Bus alert','Near pickup point')`,
      randomUUID(),
      notification,
      guardianOne,
    );
    await assert.rejects(
      db.run(
        `INSERT INTO telegram_deliveries
        (id,"eventKey","guardianId","chatId",title,body)
       VALUES ($1,'pickup:trip-1:stop-1',$2,88001,'Duplicate','Duplicate')`,
        randomUUID(),
        guardianOne,
      ),
      (error: unknown) => (error as { code?: string }).code === '23505',
    );
    await assert.rejects(
      db.run(
        `INSERT INTO telegram_deliveries
        (id,"eventKey","notificationId","guardianId","chatId",title,body)
       VALUES ($1,'pickup:trip-1:stop-2',$2,$3,88001,'Duplicate notification','Duplicate')`,
        randomUUID(),
        notification,
        guardianOne,
      ),
      (error: unknown) => (error as { code?: string }).code === '23505',
    );
    await db.run(
      `INSERT INTO telegram_webhook_updates("updateId",payload)
     VALUES (99001,'{"message": {"text": "/start"}}')`,
    );
    await assert.rejects(
      db.run(
        `INSERT INTO telegram_webhook_updates("updateId",payload)
       VALUES (99001,'{"message": {"text": "/start"}}')`,
      ),
      (error: unknown) => (error as { code?: string }).code === '23505',
    );
    await db.run(
      `INSERT INTO telegram_connections
      ("guardianId","chatId",username,status,"connectedAt")
     VALUES ($1,88001,'one','CONNECTED',$2)`,
      guardianOne,
      timestamp,
    );
    await assert.rejects(
      db.run(
        `INSERT INTO telegram_connections
        ("guardianId","chatId",username,status,"connectedAt")
       VALUES ($1,88001,'one','CONNECTED',$2)`,
        guardianTwo,
        timestamp,
      ),
      (error: unknown) => (error as { code?: string }).code === '23505',
    );

    await db.onModuleInit();
    assert.equal(
      Number(
        (
          await db.all<{ count: string }>(
            'SELECT count(*)::text AS count FROM app_migrations WHERE version = 8',
          )
        )[0].count,
      ),
      1,
    );
  },
);
