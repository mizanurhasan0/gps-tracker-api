import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
const { migrate, deviceRecord } = require('../scripts/import-legacy.cjs');

test('legacy device validation refuses malformed records instead of discarding data', () => {
  assert.throws(() => deviceRecord({ imei: '1', lastSeen: 'bad' }), /lastSeen/);
  assert.throws(
    () =>
      deviceRecord({
        imei: '1',
        lastSeen: '2026-01-01T00:00:00Z',
        position: {
          latitude: 91,
          longitude: 0,
          speed: 0,
          course: 0,
          gpsTime: 'x',
          receivedAt: '2026-01-01T00:00:00Z',
        },
      }),
    /coordinates/
  );
});

test(
  'legacy import is atomic, dry-run safe, preserves stop ordering and is repeatable',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const root = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const schema = 'migration_' + randomUUID().replaceAll('-', '');
    await root.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    const pool = new Pool({ connectionString: url.toString() });
    const directory = mkdtempSync(join(tmpdir(), 'legacy-import-'));
    try {
      execFileSync('python3', [
        '-c',
        `
import sqlite3,sys,json
c=sqlite3.connect(sys.argv[1])
c.executescript('''
CREATE TABLE migrations(version INTEGER); INSERT INTO migrations VALUES(2);
CREATE TABLE users(id TEXT,name TEXT,phone TEXT,passwordHash TEXT,role TEXT,verified INTEGER,createdAt TEXT);
INSERT INTO users VALUES('u','Admin','01700000000','hash','ADMIN',1,'2026-01-01');
CREATE TABLE vehicles(id TEXT,name TEXT,plate TEXT,imei TEXT,createdAt TEXT,updatedAt TEXT);
INSERT INTO vehicles VALUES('v','Van','ABC','123','2026-01-01','2026-01-01');
CREATE TABLE routes(id TEXT,name TEXT,vehicleId TEXT,monthlyAmount INTEGER,active INTEGER);
INSERT INTO routes VALUES('r','Route','v',100,1);
CREATE TABLE stops(id TEXT,routeId TEXT,name TEXT);
INSERT INTO stops VALUES('z','r','First'); INSERT INTO stops VALUES('a','r','Second');
CREATE TABLE gps_history_outbox(sequence INTEGER,eventKey TEXT,imei TEXT,gpsTime TEXT,receivedAt TEXT,payload TEXT);
''')
e={'key':'event1','imei':'123','vehicleId':'original-vehicle','gpsTime':'2026-01-01T00:00:00Z','receivedAt':'2026-01-01T00:00:01Z','latitude':23.5,'longitude':90.5,'speed':10,'course':90,'protocol':18,'fixStatus':0,'quality':'valid','rawGpsTime':'2026-01-01 00:00:00'}
c.execute('INSERT INTO gps_history_outbox VALUES(?,?,?,?,?,?)',(1,e['key'],e['imei'],e['gpsTime'],e['receivedAt'],json.dumps(e)))
c.commit()
`,
        join(directory, 'transport.sqlite'),
      ]);
      writeFileSync(
        join(directory, 'devices.json'),
        JSON.stringify([{ imei: '123', lastSeen: '2026-01-01T00:00:00Z' }])
      );
      const dry = await migrate({ directory, url: url.toString() });
      assert.equal(dry.dryRun, true);
      assert.equal(
        (await pool.query("SELECT to_regclass('users') AS name")).rows[0].name,
        null
      );
      await migrate({ directory, url: url.toString(), apply: true });
      assert.deepEqual(
        (await pool.query('SELECT id,position FROM stops ORDER BY position'))
          .rows,
        [
          { id: 'z', position: 0 },
          { id: 'a', position: 1 },
        ]
      );
      assert.equal(
        (await pool.query('SELECT vehicle_id FROM gps_history')).rows[0]
          .vehicle_id,
        'original-vehicle'
      );
      assert.equal(
        (await migrate({ directory, url: url.toString(), apply: true }))
          .alreadyImported,
        true
      );
      assert.equal(
        (await pool.query('SELECT COUNT(*) FROM gps_history')).rows[0].count,
        '1'
      );
      // Replayed device transmissions keep the first committed vehicle and receipt.
      execFileSync('python3', [
        '-c',
        `
import sqlite3,sys,json
c=sqlite3.connect(sys.argv[1]); e=json.loads(c.execute('SELECT payload FROM gps_history_outbox').fetchone()[0])
e['receivedAt']='2026-01-01T00:00:02Z'; e['vehicleId']='reassigned-vehicle'
c.execute('UPDATE gps_history_outbox SET receivedAt=?,payload=?',(e['receivedAt'],json.dumps(e))); c.commit()
`,
        join(directory, 'transport.sqlite'),
      ]);
      await migrate({ directory, url: url.toString(), apply: true });
      assert.equal(
        (await pool.query('SELECT vehicle_id FROM gps_history')).rows[0]
          .vehicle_id,
        'original-vehicle'
      );
      assert.equal(
        (await pool.query('SELECT COUNT(*) FROM gps_history')).rows[0].count,
        '1'
      );
      // A changed source with a conflicting business row must roll back everything.
      execFileSync('python3', [
        '-c',
        'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("UPDATE users SET name=\'Changed\'"); c.commit()',
        join(directory, 'transport.sqlite'),
      ]);
      await assert.rejects(
        migrate({ directory, url: url.toString(), apply: true }),
        /Destination conflict/
      );
      assert.equal(
        (await pool.query('SELECT name FROM users')).rows[0].name,
        'Admin'
      );
      assert.equal(
        (await pool.query('SELECT COUNT(*) FROM legacy_imports')).rows[0].count,
        '2'
      );
      execFileSync('python3', [
        '-c',
        "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('CREATE TABLE unknown_table(x TEXT)'); c.commit()",
        join(directory, 'transport.sqlite'),
      ]);
      await assert.rejects(
        migrate({ directory, url: url.toString(), apply: true }),
        /Unknown legacy table/
      );
    } finally {
      await pool.end();
      await root.query(`DROP SCHEMA "${schema}" CASCADE`);
      await root.end();
      rmSync(directory, { recursive: true, force: true });
    }
  }
);
