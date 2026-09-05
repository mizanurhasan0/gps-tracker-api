#!/usr/bin/env node
'use strict';
// Explicit offline migration only. The application does not read SQLite or JSON.
const { readFileSync, existsSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { Pool } = require('pg');
const TABLES = [
  'users',
  'sessions',
  'vehicles',
  'routes',
  'stops',
  'service_requests',
  'subscriptions',
  'bills',
  'payment_accounts',
  'payment_account_history',
  'payment_submissions',
  'complaints',
  'stop_requests',
  'notifications',
  'audit_logs',
];
const quote = (value) => '"' + value.replaceAll('"', '""') + '"';
function check(ok, message) {
  if (!ok) throw new Error(message);
}
function readArray(directory, name) {
  const file = join(directory, name);
  if (!existsSync(file)) return [];
  const rows = JSON.parse(readFileSync(file, 'utf8'));
  check(Array.isArray(rows), `${name} must contain an array`);
  return rows;
}
function deviceRecord(row) {
  check(
    row && typeof row.imei === 'string' && row.imei.length > 0,
    'Invalid device IMEI'
  );
  check(
    typeof row.lastSeen === 'string' &&
      Number.isFinite(Date.parse(row.lastSeen)),
    'Invalid device lastSeen'
  );
  const allowed = [
    'imei',
    'lastSeen',
    'gsmSignal',
    'voltageLevel',
    'position',
    'latitude',
    'longitude',
    'speed',
    'course',
    'gpsTime',
    'timestamp',
    'lastValidLatitude',
    'lastValidLongitude',
    'lastValidGpsTime',
    'lastValidTimestamp',
  ];
  check(
    Object.keys(row).every((key) => allowed.includes(key)),
    'Unknown device field'
  );
  const record = { imei: row.imei, lastSeen: row.lastSeen };
  for (const key of ['gsmSignal', 'voltageLevel'])
    if (row[key] !== undefined) {
      check(
        typeof row[key] === 'number' && Number.isFinite(row[key]),
        `Invalid device ${key}`
      );
      record[key] = row[key];
    }
  let position = row.position;
  if (!position && (row.lastValidLatitude ?? row.latitude) !== undefined) {
    position = {
      latitude: row.lastValidLatitude ?? row.latitude,
      longitude: row.lastValidLongitude ?? row.longitude,
      speed: row.speed ?? 0,
      course: row.course ?? 0,
      gpsTime: row.lastValidGpsTime ?? row.gpsTime,
      receivedAt: row.lastValidTimestamp ?? row.timestamp ?? row.lastSeen,
    };
  }
  if (position !== undefined) {
    check(
      position &&
        Object.keys(position).every((key) =>
          [
            'latitude',
            'longitude',
            'speed',
            'course',
            'gpsTime',
            'receivedAt',
          ].includes(key)
        ),
      'Unknown device position field'
    );
    for (const key of ['latitude', 'longitude', 'speed', 'course'])
      check(
        typeof position[key] === 'number' && Number.isFinite(position[key]),
        `Invalid position ${key}`
      );
    check(
      Math.abs(position.latitude) <= 90 && Math.abs(position.longitude) <= 180,
      'Invalid position coordinates'
    );
    check(
      typeof position.gpsTime === 'string' &&
        typeof position.receivedAt === 'string' &&
        Number.isFinite(Date.parse(position.receivedAt)),
      'Invalid position time'
    );
    record.position = position;
  }
  return record;
}
async function migrate({ directory, url, apply = false }) {
  check(directory && url, 'Set LEGACY_DATA_DIR and DATABASE_URL');
  directory = resolve(directory);
  check(
    ['transport.sqlite', 'vehicles.json', 'devices.json'].some((name) =>
      existsSync(join(directory, name))
    ),
    'No legacy files found'
  );
  const data = JSON.parse(
    execFileSync(
      'python3',
      [
        join(__dirname, 'export-legacy.py'),
        join(directory, 'transport.sqlite'),
      ],
      { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 }
    )
  );
  for (const name of Object.keys(data))
    check(
      [...TABLES, 'migrations', 'gps_history_outbox'].includes(name),
      `Unknown legacy table: ${name}`
    );
  for (const row of data.migrations ?? [])
    check(
      Object.keys(row).length === 1 && [1, 2].includes(row.version),
      'Unsupported legacy migration version'
    );
  const vehicles = readArray(directory, 'vehicles.json');
  const devices = readArray(directory, 'devices.json').map(deviceRecord);
  // Migration 2 means SQLite already incorporated vehicles.json; that file is stale.
  if (!(data.migrations ?? []).some((row) => row.version === 2)) {
    data.vehicles ??= [];
    for (const row of vehicles) {
      check(
        row && typeof row === 'object' && !Array.isArray(row),
        'Invalid legacy vehicle'
      );
      const existing = data.vehicles.find((item) => item.id === row.id);
      if (existing)
        check(
          Object.entries(row).every(([key, value]) => existing[key] === value),
          'Conflicting legacy vehicle sources'
        );
      else data.vehicles.push(row);
    }
  }
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ data, devices }))
    .digest('hex');
  const pool = new Pool({
    connectionString: url,
    connectionTimeoutMillis: 5000,
  });
  let client;
  try {
    client = await pool.connect();
  } catch (error) {
    await pool.end();
    throw error;
  }
  const counts = {};
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(74523001)');
    await client.query(require('../dist/database/schema').schema);
    await client.query(
      'CREATE TABLE IF NOT EXISTS legacy_imports (fingerprint TEXT PRIMARY KEY, imported_at TIMESTAMPTZ NOT NULL DEFAULT now())'
    );
    if (
      (
        await client.query(
          'SELECT 1 FROM legacy_imports WHERE fingerprint=$1',
          [fingerprint]
        )
      ).rowCount
    ) {
      await client.query('ROLLBACK');
      return { alreadyImported: true, fingerprint };
    }
    const insertExact = async (table, row) => {
      check(
        row &&
          typeof row === 'object' &&
          !Array.isArray(row) &&
          Object.keys(row).length,
        `Invalid row in ${table}`
      );
      const columns = Object.keys(row);
      const result = await client.query(
        `INSERT INTO ${quote(table)} (${columns
          .map(quote)
          .join(',')}) VALUES (${columns
          .map((_, i) => '$' + (i + 1))
          .join(',')}) ON CONFLICT DO NOTHING RETURNING *`,
        Object.values(row)
      );
      if (!result.rowCount) {
        const matched = await client.query(
          `SELECT 1 FROM ${quote(table)} WHERE ${columns
            .map((key, i) => `${quote(key)} IS NOT DISTINCT FROM $${i + 1}`)
            .join(' AND ')}`,
          Object.values(row)
        );
        check(
          matched.rowCount === 1,
          `Destination conflict in ${table}; no data was overwritten`
        );
      }
      counts[table] = (counts[table] ?? 0) + result.rowCount;
    };
    for (const table of TABLES) {
      const positions = new Map();
      for (const source of data[table] ?? []) {
        const row = { ...source };
        if (table === 'stops') {
          row.position = positions.get(row.routeId) ?? 0;
          positions.set(row.routeId, row.position + 1);
        }
        await insertExact(table, row);
      }
    }
    for (const row of data.payment_accounts ?? [])
      await insertExact('payment_account_history', {
        method: row.method,
        number: row.number,
      });
    for (const record of devices)
      await insertExact('devices', {
        imei: record.imei,
        record: JSON.stringify(record),
      });
    await client.query('SELECT pg_advisory_xact_lock(74523002)');
    for (const row of data.gps_history_outbox ?? []) {
      check(
        Object.keys(row).every((key) =>
          [
            'sequence',
            'eventKey',
            'imei',
            'gpsTime',
            'receivedAt',
            'payload',
          ].includes(key)
        ),
        'Unknown outbox field'
      );
      const event = JSON.parse(row.payload);
      const fields = [
        'key',
        'imei',
        'vehicleId',
        'gpsTime',
        'receivedAt',
        'latitude',
        'longitude',
        'speed',
        'course',
        'protocol',
        'fixStatus',
        'quality',
        'rawGpsTime',
      ];
      check(
        isDeepStrictEqual(Object.keys(event).sort(), fields.sort()),
        'Unknown or missing GPS event field'
      );
      check(
        event.key === row.eventKey &&
          event.imei === row.imei &&
          event.receivedAt === row.receivedAt,
        'Outbox metadata mismatch'
      );
      check(
        ['valid', 'invalid-time', 'invalid-fix'].includes(event.quality),
        'Invalid GPS quality'
      );
      check(
        typeof event.key === 'string' &&
          event.key.length > 0 &&
          typeof event.imei === 'string' &&
          event.imei.length > 0,
        'Invalid GPS identity'
      );
      for (const key of ['latitude', 'longitude', 'speed', 'course'])
        check(
          typeof event[key] === 'number' && Number.isFinite(event[key]),
          `Invalid GPS ${key}`
        );
      const historyRow = {
        event_key: event.key,
        imei: event.imei,
        vehicle_id: event.vehicleId,
        gps_time: event.quality === 'invalid-time' ? null : event.gpsTime,
        received_at: event.receivedAt,
        latitude: event.latitude,
        longitude: event.longitude,
        speed: event.speed,
        course: event.course,
        protocol: event.protocol,
        fix_status: event.fixStatus,
        quality: event.quality,
        raw_gps_time: event.rawGpsTime,
      };
      // A retransmission can have the same event key with a later receipt time or
      // a reassigned vehicle. Keep the first committed identity and timestamp.
      const existing = await client.query(
        'SELECT 1 FROM gps_history WHERE event_key=$1',
        [event.key]
      );
      if (existing.rowCount) {
        const intrinsic = Object.entries(historyRow).filter(
          ([key]) => !['received_at', 'vehicle_id'].includes(key)
        );
        const match = await client.query(
          `SELECT 1 FROM gps_history WHERE ${intrinsic
            .map(([key], i) => `${quote(key)} IS NOT DISTINCT FROM $${i + 1}`)
            .join(' AND ')}`,
          intrinsic.map(([, value]) => value)
        );
        check(
          match.rowCount === 1,
          'Conflicting GPS event key; existing history preserved'
        );
      } else await insertExact('gps_history', historyRow);
    }
    await client.query('INSERT INTO legacy_imports(fingerprint) VALUES($1)', [
      fingerprint,
    ]);
    await client.query(apply ? 'COMMIT' : 'ROLLBACK');
    return { dryRun: !apply, fingerprint, inserted: counts };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
module.exports = { migrate, deviceRecord };
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['--dry-run', '--apply'].includes(args[0])) {
    console.error(
      'Usage: LEGACY_DATA_DIR=/backup/data DATABASE_URL=... node scripts/import-legacy.cjs --dry-run|--apply'
    );
    process.exitCode = 1;
  } else
    migrate({
      directory: process.env.LEGACY_DATA_DIR,
      url: process.env.DATABASE_URL,
      apply: args[0] === '--apply',
    })
      .then((result) => console.log(JSON.stringify(result, null, 2)))
      .catch((error) => {
        console.error('Import failed:', error.message);
        process.exitCode = 1;
      });
}
