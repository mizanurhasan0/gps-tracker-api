#!/usr/bin/env node
'use strict';

const { randomUUID } = require('node:crypto');
const { lstatSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { Client } = require('pg');

const root = resolve(__dirname, '..');
const localEnv = join(root, '.env.local');
const vehicleCount = 30;

async function main() {
  const envFile = lstatSync(localEnv);
  if (!envFile.isFile() || (envFile.mode & 0o077) !== 0) {
    throw new Error('.env.local must be a private regular file (chmod 600)');
  }
  process.loadEnvFile(localEnv);
  if (process.env.LOCAL_ALLOW_SHORT_PASSWORDS !== 'true' ||
      !process.env.APP_DB_PASSWORD || !process.env.ADMIN_PHONE) {
    throw new Error('Local database settings are missing from .env.local');
  }
  const port = Number(process.env.LOCAL_POSTGRES_PORT ?? 55432);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('LOCAL_POSTGRES_PORT is invalid');
  }
  const db = new Client({
    host: '127.0.0.1',
    port,
    user: 'gps_tracker',
    password: process.env.APP_DB_PASSWORD,
    database: 'gps_tracker',
  });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(74523002)');
    const admin = await db.query(
      "SELECT id FROM users WHERE phone=$1 AND role='ADMIN'",
      [process.env.ADMIN_PHONE],
    );
    if (!admin.rowCount) throw new Error('The local admin account was not found');

    const seeded = await db.query(
      `SELECT s.id "subscriptionId",s."guardianId",s."monthlyAmount",
              p."studentCode",u.phone "guardianPhone"
       FROM subscriptions s
       JOIN student_profiles p ON p.id=s."studentId"
       JOIN users u ON u.id=s."guardianId"
       WHERE p."studentCode" LIKE 'LOCAL-SEED-%' AND s.status='ACTIVE'
       ORDER BY p."studentCode",s.id`,
    );
    if (seeded.rowCount < 100) {
      throw new Error('Run npm run seed:local:students before seeding the dashboard');
    }

    const now = new Date().toISOString();
    const current = await db.query(
      "SELECT to_char(now() AT TIME ZONE 'Asia/Dhaka','YYYY-MM') AS \"month\", " +
      "to_char(now() AT TIME ZONE 'Asia/Dhaka','YYYY-MM-DD') AS \"today\"",
    );
    const { month, today } = current.rows[0];
    let newVehicles = 0;
    let newRoutes = 0;
    let newBills = 0;
    let newPayments = 0;

    for (let index = 1; index <= vehicleCount; index++) {
      const serial = String(index).padStart(3, '0');
      const name = `Local Seed Bus ${serial}`;
      const plate = `LOCAL-BUS-${serial}`;
      const imei = `867400001${String(index).padStart(6, '0')}`;
      const driverName = `Local Driver ${serial}`;
      const driverPhone = `0196${String(index).padStart(7, '0')}`;
      const status = index % 10 === 0 ? 'MAINTENANCE' : index % 10 === 9 ? 'INACTIVE' : 'RUNNING';
      const existing = await db.query(
        'SELECT id,name,plate,imei FROM vehicles WHERE imei=$1 OR name=$2 OR plate=$3',
        [imei, name, plate],
      );
      let vehicleId;
      if (existing.rowCount) {
        const vehicle = existing.rows[0];
        if (existing.rowCount !== 1 || vehicle.name !== name ||
            vehicle.plate !== plate || vehicle.imei !== imei) {
          throw new Error(`Local seed vehicle ${serial} conflicts with an existing vehicle`);
        }
        vehicleId = vehicle.id;
      } else {
        vehicleId = randomUUID();
        await db.query(
          `INSERT INTO vehicles
           (id,name,plate,imei,"driverName","driverPhone","createdAt","updatedAt",model,status)
           VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8,$9)`,
          [vehicleId, name, plate, imei, driverName, driverPhone, now,
            index % 2 ? 'Toyota Hiace' : 'Tata Starbus', status],
        );
        newVehicles++;
      }
      const driver = await db.query('SELECT id FROM drivers WHERE "vehicleId"=$1', [vehicleId]);
      if (!driver.rowCount) {
        await db.query(
          'INSERT INTO drivers(id,name,phone,"vehicleId","createdAt") VALUES($1,$2,$3,$4,$5)',
          [randomUUID(), driverName, driverPhone, vehicleId, now],
        );
      }

      const routeName = `Local Seed Route ${serial}`;
      const existingRoute = await db.query(
        'SELECT id,"vehicleId" FROM routes WHERE name=$1', [routeName],
      );
      let routeId;
      if (existingRoute.rowCount) {
        if (existingRoute.rowCount !== 1 || existingRoute.rows[0].vehicleId !== vehicleId) {
          throw new Error(`Local seed route ${serial} conflicts with an existing route`);
        }
        routeId = existingRoute.rows[0].id;
      } else {
        routeId = randomUUID();
        await db.query(
          'INSERT INTO routes(id,name,"vehicleId","monthlyAmount",active) VALUES($1,$2,$3,$4,1)',
          [routeId, routeName, vehicleId, 90000 + (index % 5) * 10000],
        );
        newRoutes++;
      }
      for (const [position, stopName] of [`Local Pickup ${serial}`, `Local School ${serial}`].entries()) {
        await db.query(
          'INSERT INTO stops(id,"routeId",name,position) VALUES($1,$2,$3,$4) ON CONFLICT("routeId",name) DO NOTHING',
          [randomUUID(), routeId, stopName, position],
        );
      }
      if (status === 'MAINTENANCE') {
        const title = `Local demo inspection ${serial}`;
        const previous = await db.query(
          'SELECT id FROM maintenance WHERE "vehicleId"=$1 AND title=$2',
          [vehicleId, title],
        );
        if (!previous.rowCount) {
          await db.query(
            `INSERT INTO maintenance(id,"vehicleId",title,description,"serviceDate",amount,status,"createdAt")
             VALUES($1,$2,$3,$4,$5,$6,'IN_PROGRESS',$7)`,
            [randomUUID(), vehicleId, title, 'Local demonstration maintenance', today, 25000, now],
          );
        }
      }
    }

    for (const student of seeded.rows) {
      const billId = randomUUID();
      const bill = await db.query(
        `INSERT INTO bills(id,"guardianId","subscriptionId",month,amount,status,"createdAt")
         VALUES($1,$2,$3,$4,$5,'UNPAID',$6)
         ON CONFLICT("subscriptionId",month) DO NOTHING RETURNING id`,
        [billId, student.guardianId, student.subscriptionId, month,
          student.monthlyAmount, now],
      );
      if (!bill.rowCount) continue;
      newBills++;
      const serial = Number(student.studentCode.slice(-3));
      if (serial % 3 !== 0) continue;
      const paymentId = randomUUID();
      await db.query(
        `INSERT INTO payment_submissions
         (id,"billId","guardianId",method,"recipientNumber","senderNumber",
          "transactionId",amount,status,"reviewedBy","createdAt","reviewedAt","methodName")
         VALUES($1,$2,$3,'LOCAL_DEMO','',$4,$5,$6,'APPROVED',$7,$8,$8,'Demo cash')`,
        [paymentId, billId, student.guardianId, student.guardianPhone,
          `LOCAL-${month.replace('-', '')}-${student.studentCode}`,
          student.monthlyAmount, admin.rows[0].id, now],
      );
      await db.query('UPDATE bills SET status=\'PAID\',"paidAt"=$1 WHERE id=$2', [now, billId]);
      newPayments++;
    }

    const summary = await db.query(
      `SELECT
        (SELECT count(*)::int FROM vehicles) vehicles,
        (SELECT count(*)::int FROM routes) routes,
        (SELECT count(*)::int FROM bills WHERE month=$1) "monthBills",
        (SELECT coalesce(sum(amount),0)::bigint FROM bills WHERE month=$1) billed,
        (SELECT coalesce(sum(amount),0)::bigint FROM bills WHERE month=$1 AND status='PAID') paid,
        (SELECT coalesce(sum(amount),0)::bigint FROM bills WHERE status='UNPAID') outstanding,
        (SELECT count(DISTINCT "guardianId")::int FROM bills WHERE status='UNPAID') "dueGuardians"`,
      [month],
    );
    await db.query('COMMIT');
    console.log(JSON.stringify({
      month,
      createdNow: { vehicles: newVehicles, routes: newRoutes, bills: newBills, payments: newPayments },
      totals: summary.rows[0],
    }));
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await db.end();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
