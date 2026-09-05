import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';

const url =
  process.env.TEST_DATABASE_URL ?? process.env.HISTORY_TEST_DATABASE_URL;

test(
  'PostgreSQL transaction boundaries and concurrent writes',
  { skip: !url },
  async (t) => {
    const schema = `database_test_${randomUUID().replace(/-/g, '')}`;
    const setup = new Pool({ connectionString: url });
    await setup.query(`CREATE SCHEMA ${schema}`);
    const isolated = new URL(url!);
    isolated.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = isolated.toString();
    const { DatabaseService } = require('../dist/database/database.service');
    const db = new DatabaseService();
    t.after(async () => {
      await db.onApplicationShutdown();
      await setup.query(`DROP SCHEMA ${schema} CASCADE`);
      await setup.end();
    });
    await db.onModuleInit();
    await db.exec(
      'CREATE TABLE transaction_probe(id integer PRIMARY KEY, value integer NOT NULL)'
    );
    await db.run('INSERT INTO transaction_probe VALUES($1,$2)', 1, 0);

    await t.test(
      'nested work rolls back with its outer transaction',
      async () => {
        await assert.rejects(
          db.transaction(async () => {
            await db.run('UPDATE transaction_probe SET value = 1 WHERE id = 1');
            await db.transaction(async () => {
              await db.run('INSERT INTO transaction_probe VALUES($1,$2)', 2, 2);
            });
            throw new Error('abort outer transaction');
          }),
          /abort outer transaction/
        );
        assert.deepEqual(
          await db.all('SELECT * FROM transaction_probe ORDER BY id'),
          [{ id: 1, value: 0 }]
        );
      }
    );

    await t.test(
      'unrelated async request cannot observe or join an uncommitted transaction',
      async () => {
        let release!: () => void;
        let signal!: () => void;
        const ready = new Promise<void>((resolve) => {
          signal = resolve;
        });
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const transaction = db.transaction(async () => {
          await db.run('UPDATE transaction_probe SET value = 7 WHERE id = 1');
          signal();
          await gate;
        });
        try {
          await ready;
          assert.equal(
            (await db.get('SELECT value FROM transaction_probe WHERE id = 1'))
              .value,
            0
          );
          await db.run('INSERT INTO transaction_probe VALUES($1,$2)', 3, 3);
        } finally {
          release();
          await transaction;
        }
        assert.equal(
          (await db.get('SELECT value FROM transaction_probe WHERE id = 1'))
            .value,
          7
        );
        assert.equal(
          (await db.get('SELECT value FROM transaction_probe WHERE id = 3'))
            .value,
          3
        );
      }
    );

    await t.test(
      'serializable retry prevents lost updates across concurrent read-modify-write transactions',
      async () => {
        await db.run('UPDATE transaction_probe SET value = 0 WHERE id = 1');
        await Promise.all(
          Array.from({ length: 4 }, () =>
            db.transaction(async () => {
              const row = await db.get(
                'SELECT value FROM transaction_probe WHERE id = 1'
              );
              // Force overlapping snapshots to exercise serialization retry, not only sequential updates.
              await new Promise((resolve) => setTimeout(resolve, 15));
              await db.run(
                'UPDATE transaction_probe SET value = $1 WHERE id = 1',
                row.value + 1
              );
            })
          )
        );
        assert.equal(
          (await db.get('SELECT value FROM transaction_probe WHERE id = 1'))
            .value,
          4
        );
      }
    );

    await t.test(
      'a database failure rolls back and releases the connection for subsequent work',
      async () => {
        await assert.rejects(
          db.transaction(async () => {
            await db.run(
              'UPDATE transaction_probe SET value = 999 WHERE id = 1'
            );
            await db.run('INSERT INTO transaction_probe VALUES($1,$2)', 1, 123);
          }),
          (error: unknown) => (error as { code: string }).code === '23505'
        );
        assert.equal(
          (await db.get('SELECT value FROM transaction_probe WHERE id = 1'))
            .value,
          4
        );
        await db.transaction(async () => {
          await db.run('UPDATE transaction_probe SET value = 5 WHERE id = 1');
        });
        assert.equal(
          (await db.get('SELECT value FROM transaction_probe WHERE id = 1'))
            .value,
          5
        );
      }
    );
  }
);
