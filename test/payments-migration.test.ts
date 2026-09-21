import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { schema as originalSchema } from '../src/database/schema';

const databaseUrl = process.env.TEST_DATABASE_URL;
test('migration preserves legacy payment accounts and supports arbitrary methods after restart', { skip: !databaseUrl }, async (t) => {
  const schema = `payments_migration_${randomUUID().replaceAll('-', '')}`;
  const setup = new Pool({ connectionString: databaseUrl });
  await setup.query(`CREATE SCHEMA "${schema}"`);
  const isolated = new URL(databaseUrl!);
  isolated.searchParams.set('options', `-c search_path=${schema}`);
  const legacy = new Pool({ connectionString: isolated.toString() });
  await legacy.query(originalSchema);
  await legacy.query("INSERT INTO payment_accounts VALUES ('BKASH','01700000001','Send Money'),('ROCKET','017000000022','Payment')");
  await legacy.query('CREATE TABLE app_migrations(version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  await legacy.query('INSERT INTO app_migrations(version) VALUES (1)');
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = isolated.toString();
  const { DatabaseService } = require('../dist/database/database.service');
  let db = new DatabaseService();
  t.after(async () => {
    await db.onApplicationShutdown();
    await legacy.end();
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
    await setup.query(`DROP SCHEMA "${schema}" CASCADE`);
    await setup.end();
  });
  await db.onModuleInit();
  assert.deepEqual(await db.all('SELECT method,name,number,"imageUrl" FROM payment_accounts ORDER BY method'), [
    { method: 'BKASH', name: 'bKash', number: '01700000001', imageUrl: '' },
    { method: 'ROCKET', name: 'Rocket', number: '017000000022', imageUrl: '' },
  ]);
  await db.run(`INSERT INTO payment_accounts(method,name,number,instructions) VALUES('BANK','School Bank','AC-123','')`);
  await db.onApplicationShutdown();
  db = new DatabaseService();
  await db.onModuleInit();
  assert.equal((await db.all('SELECT * FROM payment_accounts')).length, 3);
  assert.deepEqual(await db.all('SELECT version FROM app_migrations WHERE version=9'), [{ version: 9 }]);
});
