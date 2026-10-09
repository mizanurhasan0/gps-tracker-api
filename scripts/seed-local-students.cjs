#!/usr/bin/env node
'use strict';

const { randomBytes, scrypt: scryptCallback } = require('node:crypto');
const { lstatSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { promisify } = require('node:util');
const { Client } = require('pg');

const root = resolve(__dirname, '..');
const localEnv = join(root, '.env.local');
const password = 'pass';
const scrypt = promisify(scryptCallback);
const students = Array.from({ length: 100 }, (_, index) => {
  const number = String(index + 1).padStart(3, '0');
  return {
    studentName: `Local Student ${number}`,
    studentCode: `LOCAL-SEED-${number}`,
    guardianName: `Local Guardian ${number}`,
    guardianPhone: `0195${String(index + 1).padStart(7, '0')}`,
    className: `Class ${1 + (index % 10)}`,
    roll: String(index + 1),
  };
});

async function main() {
  const envFile = lstatSync(localEnv);
  if (!envFile.isFile() || (envFile.mode & 0o077) !== 0) {
    throw new Error('.env.local must be a private regular file (chmod 600)');
  }
  process.loadEnvFile(localEnv);
  if (process.env.LOCAL_ALLOW_SHORT_PASSWORDS !== 'true') {
    throw new Error('Enable LOCAL_ALLOW_SHORT_PASSWORDS=true in .env.local first');
  }
  if (!process.env.APP_DB_PASSWORD || !process.env.ADMIN_PHONE || !process.env.ADMIN_PASSWORD) {
    throw new Error('Local database and admin credentials are missing from .env.local');
  }

  const apiPort = Number(process.env.REST_PORT ?? process.env.LOCAL_REST_PORT ?? 3000);
  const dbPort = Number(process.env.LOCAL_POSTGRES_PORT ?? 55432);
  if (![apiPort, dbPort].every(port => Number.isInteger(port) && port > 0 && port <= 65535)) {
    throw new Error('Local API or PostgreSQL port is invalid');
  }
  const apiBase = `http://127.0.0.1:${apiPort}`;
  const db = new Client({
    host: '127.0.0.1',
    port: dbPort,
    user: 'gps_tracker',
    password: process.env.APP_DB_PASSWORD,
    database: 'gps_tracker',
  });

  async function api(path, token, method = 'GET', body) {
    const response = await fetch(`${apiBase}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(`${method} ${path} failed (${response.status}): ${JSON.stringify(result)}`);
    }
    return result;
  }

  await db.connect();
  try {
    const existing = await db.query(
      `SELECT p."studentCode",p."studentName",u.phone
       FROM student_profiles p JOIN users u ON u.id=p."guardianId"
       WHERE p."studentCode"=ANY($1::text[])`,
      [students.map(student => student.studentCode)],
    );
    const byCode = new Map(existing.rows.map(row => [row.studentCode, row]));
    const guardianRows = await db.query(
      'SELECT name,phone,role FROM users WHERE phone=ANY($1::text[])',
      [students.map(student => student.guardianPhone)],
    );
    const byPhone = new Map(guardianRows.rows.map(row => [row.phone, row]));
    for (const student of students) {
      const profile = byCode.get(student.studentCode);
      if (profile &&
        (profile.studentName !== student.studentName || profile.phone !== student.guardianPhone)) {
        throw new Error(`Seed student code ${student.studentCode} belongs to another account`);
      }
      const guardian = byPhone.get(student.guardianPhone);
      if (guardian &&
        (guardian.role !== 'GUARDIAN' ||
          (!profile && guardian.name !== student.guardianName))) {
        throw new Error(`Seed guardian phone ${student.guardianPhone} is already in use`);
      }
    }

    const login = await api('/auth/login', null, 'POST', {
      phone: process.env.ADMIN_PHONE,
      password: process.env.ADMIN_PASSWORD,
    });
    if (login.user?.role !== 'ADMIN' || !login.token) {
      throw new Error('Local admin login failed');
    }
    const token = login.token;
    const routes = await api('/routes', token);
    let route = routes.find(item => item.name === 'Local Demo Route') ?? routes[0];
    if (!route) {
      const vehicleResult = await api('/vehicles', token);
      const vehicles = Array.isArray(vehicleResult) ? vehicleResult : vehicleResult.vehicles;
      let vehicle = vehicles.find(item => item.name === 'Local Demo Bus');
      if (!vehicle) {
        vehicle = await api('/vehicles', token, 'POST', {
          name: 'Local Demo Bus', plate: 'LOCAL-001', imei: '867400000000001',
        });
      }
      route = await api('/admin/routes', token, 'POST', {
        name: 'Local Demo Route', vehicleId: vehicle.id, monthlyAmount: 5000,
        stops: ['Demo Pickup', 'Demo School'],
      });
    }
    const stop = route.stops?.find(item => item.name === 'Demo Pickup') ?? route.stops?.[0];
    if (!stop?.id) throw new Error('The selected local route has no stop');

    const missing = students.filter(student => !byCode.has(student.studentCode));
    for (let index = 0; index < missing.length; index += 4) {
      await Promise.all(missing.slice(index, index + 4).map(student =>
        api('/admin/students', token, 'POST', {
          ...student,
          routeId: route.id,
          stopId: stop.id,
        }),
      ));
      if ((index + 4) % 20 === 0 || index + 4 >= missing.length) {
        console.log(`Created ${Math.min(index + 4, missing.length)}/${missing.length} missing students`);
      }
    }

    const phones = students.map(student => student.guardianPhone);
    const users = await db.query(
      `SELECT id,phone,role FROM users WHERE phone=ANY($1::text[])
       OR (phone=$2 AND role='GUARDIAN')`,
      [phones, '01900000001'],
    );
    const createdPhones = new Set(users.rows.map(row => row.phone));
    if (phones.some(phone => !createdPhones.has(phone)) ||
      users.rows.some(row => row.role !== 'GUARDIAN')) {
      throw new Error('A seeded guardian account is missing or has the wrong role');
    }
    const passwordUpdates = [];
    for (const user of users.rows) {
      const salt = randomBytes(16).toString('hex');
      const derived = await scrypt(password, salt, 64);
      passwordUpdates.push({ id: user.id, hash: `${salt}:${derived.toString('hex')}` });
    }
    await db.query('BEGIN');
    try {
      for (const update of passwordUpdates) {
        await db.query('UPDATE users SET "passwordHash"=$1 WHERE id=$2', [update.hash, update.id]);
        await db.query('DELETE FROM sessions WHERE "userId"=$1', [update.id]);
      }
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    }

    const profileCount = await db.query(
      `SELECT COUNT(DISTINCT p.id)::int profiles,COUNT(DISTINCT s.id)::int enrollments
       FROM student_profiles p LEFT JOIN subscriptions s ON s."studentId"=p.id
       WHERE p."studentCode"=ANY($1::text[])`,
      [students.map(student => student.studentCode)],
    );
    if (profileCount.rows[0].profiles !== 100 || profileCount.rows[0].enrollments < 100) {
      throw new Error('The seed did not create all 100 student enrollments');
    }
    const guardianLogin = await api('/auth/login', null, 'POST', {
      phone: students[0].guardianPhone,
      password,
    });
    if (guardianLogin.user?.role !== 'GUARDIAN') {
      throw new Error('Seed guardian login verification failed');
    }
    const studentPage = await api('/admin/students?page=1&pageSize=10&status=ALL', token);
    console.log(JSON.stringify({
      createdNow: missing.length,
      seedStudents: profileCount.rows[0].profiles,
      guardiansWithPasswordPass: users.rowCount,
      activeStudentListTotal: studentPage.total,
      totalPages: studentPage.totalPages,
    }));
  } finally {
    await db.end();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
