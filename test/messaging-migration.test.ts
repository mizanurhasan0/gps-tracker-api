import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.HISTORY_TEST_DATABASE_URL;

test(
  'database migrations 15 and 16 seed saved messages and backfill message request IDs',
  { skip: !databaseUrl },
  async (t) => {
    const schema = `messaging_migration_${randomUUID().replaceAll('-', '')}`;
    const setup = new Pool({ connectionString: databaseUrl });
    await setup.query(`CREATE SCHEMA "${schema}"`);
    const isolated = new URL(databaseUrl!);
    isolated.searchParams.set('options', `-c search_path=${schema}`);
    const legacy = new Pool({ connectionString: isolated.toString() });
    const { migrations } = require('../dist/database/migrations') as {
      migrations: readonly (readonly [number, string])[];
    };
    await legacy.query(
      'CREATE TABLE app_migrations(version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())',
    );
    const apply = async (version: number) => {
      await legacy.query(migrations.find(([candidate]) => candidate === version)![1]);
      await legacy.query('INSERT INTO app_migrations(version) VALUES($1)', [version]);
    };
    for (const [version] of migrations.filter(([version]) => version < 15)) await apply(version);
    // Admins edited some templates, cleared others, and one key never existed.
    await legacy.query(
      `UPDATE business_settings SET data=(data || $1::jsonb) - 'delayMessage' WHERE id=1`,
      [
        JSON.stringify({
          paymentReminder: '  এই মাসের ভাড়া দিন  ',
          absenceMessage: '',
          holidayMessage: '   ',
          emergencyMessage: 'জরুরি: অফিসে ফোন করুন',
        }),
      ],
    );
    await apply(15);
    // A database that ran version 15 before requestId existed already has sends.
    const earlierSend = randomUUID();
    await legacy.query(
      `INSERT INTO telegram_messages(id,title,body,audience,vehicles)
       VALUES($1,'NOOR TRANSPORT','Earlier send','ALL','[]')`,
      [earlierSend],
    );
    await legacy.end();

    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = isolated.toString();
    const { DatabaseService } = require('../dist/database/database.service') as {
      DatabaseService: new () => {
        onModuleInit(): Promise<void>;
        onApplicationShutdown(): Promise<void>;
        all<T>(sql: string, ...params: unknown[]): Promise<T[]>;
        get<T>(sql: string, ...params: unknown[]): Promise<T | undefined>;
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
      await db.all('SELECT version FROM app_migrations WHERE version>=15 ORDER BY version'),
      [{ version: 15 }, { version: 16 }],
    );
    const templates = await db.all<{ id: string; title: string; body: string; createdBy: string | null }>(
      `SELECT id,title,body,"createdBy" FROM message_templates ORDER BY "updatedAt" DESC,"createdAt" DESC`,
    );
    assert.deepEqual(
      templates.map(({ title, body, createdBy }) => ({ title, body, createdBy })),
      [
        { title: 'পেমেন্ট রিমাইন্ডার', body: 'এই মাসের ভাড়া দিন', createdBy: null },
        { title: 'জরুরি বার্তা', body: 'জরুরি: অফিসে ফোন করুন', createdBy: null },
      ],
    );
    for (const { id } of templates)
      assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    // Older app builds still read the legacy keys.
    const settings = await db.get<{ data: Record<string, unknown> }>(
      'SELECT data FROM business_settings WHERE id=1',
    );
    assert.equal(settings!.data.paymentReminder, '  এই মাসের ভাড়া দিন  ');
    assert.equal(settings!.data.absenceMessage, '');
    assert.equal(settings!.data.emergencyMessage, 'জরুরি: অফিসে ফোন করুন');

    assert.deepEqual(await db.all('SELECT id,"requestId" FROM telegram_messages'), [
      { id: earlierSend, requestId: earlierSend },
    ]);
    assert.deepEqual(
      await db.all(
        `SELECT is_nullable FROM information_schema.columns
         WHERE table_schema=current_schema() AND table_name='telegram_messages' AND column_name='requestId'`,
      ),
      [{ is_nullable: 'NO' }],
    );
    await assert.rejects(
      db.all(
        `INSERT INTO telegram_messages(id,title,body,audience,vehicles,"requestId")
         VALUES($1,'NOOR TRANSPORT','Duplicate','ALL','[]',$2)`,
        randomUUID(),
        earlierSend,
      ),
      (error: unknown) => (error as { code?: string }).code === '23505',
    );
    await assert.rejects(
      db.all(
        `INSERT INTO telegram_messages(id,title,body,audience,vehicles)
         VALUES($1,'NOOR TRANSPORT','Missing key','ALL','[]')`,
        randomUUID(),
      ),
      (error: unknown) => (error as { code?: string }).code === '23502',
    );

    // Restarting does not seed twice.
    await db.onModuleInit();
    assert.equal((await db.all('SELECT id FROM message_templates')).length, 2);
  },
);
