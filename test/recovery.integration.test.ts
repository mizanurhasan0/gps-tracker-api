import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Pool } from 'pg';
import type { DatabaseService as Database } from '../src/database/database.service';
import type { RecoveryConfig } from '../src/auth/recovery/recovery.config';

const url = process.env.TEST_DATABASE_URL ?? process.env.HISTORY_TEST_DATABASE_URL;

test(
  'owner-bound email recovery, durable limits, atomic reset and SMTP outbox',
  { skip: !url },
  async (t) => {
    const schema = `recovery_${randomUUID().replaceAll('-', '')}`;
    const setup = new Pool({ connectionString: url });
    await setup.query(`CREATE SCHEMA ${schema}`);
    const isolated = new URL(url!);
    isolated.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = isolated.toString();
    const { DatabaseService } = require('../dist/database/database.service');
    const { RecoveryService } = require('../dist/auth/recovery/recovery.service');
    const { RecoveryController } = require('../dist/auth/recovery/recovery.controller');
    const { RecoveryMailWorker } = require('../dist/auth/recovery/recovery-mail.worker');
    const { AuthService } = require('../dist/auth/auth.service');
    const { hashPassword } = require('../dist/auth/password');
    const db: Database = new DatabaseService();
    await db.ensureReady();
    t.after(async () => {
      await db.onApplicationShutdown();
      await setup.query(`DROP SCHEMA ${schema} CASCADE`);
      await setup.end();
    });
    const ownerId = randomUUID();
    const guardianId = randomUUID();
    const originalPassword = 'original-admin-password';
    const originalHash = await hashPassword(originalPassword);
    await db.run(
      `INSERT INTO users(id,name,phone,"passwordHash",role,"createdAt") VALUES
    ($1,'Owner','01700000001',$3,'ADMIN',$4),($2,'Guardian','01700000002',$3,'GUARDIAN',$4)`,
      ownerId,
      guardianId,
      originalHash,
      new Date().toISOString(),
    );
    const config: RecoveryConfig = {
      enabled: true,
      email: 'eng.mizanur.hasan@gmail.com',
      secret: 'ab'.repeat(32),
      smtp: {
        host: 'smtp.gmail.com',
        port: 465,
        user: 'test@example.com',
        password: 'test-only',
        from: 'test@example.com',
      },
    };
    const service = new RecoveryService(db, config);
    const messages: Array<{ to: string; subject: string; text: string }> = [];
    let rejectMail = false;
    const mail = {
      send: async (to: string, subject: string, text: string) => {
        if (rejectMail) throw new Error('test SMTP unavailable');
        messages.push({ to, subject, text });
      },
    };
    let worker = new RecoveryMailWorker(db, config, mail);
    class TestApp {}
    Module({
      controllers: [RecoveryController],
      providers: [{ provide: RecoveryService, useValue: service }],
    })(TestApp);
    const app = await NestFactory.create(TestApp, { logger: false });
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
    );
    await app.listen(0, '127.0.0.1');
    t.after(async () => {
      await worker.onApplicationShutdown();
      await app.close();
    });
    const origin = await app.getUrl();
    const auth = new AuthService(db);
    const post = async (path: string, body: unknown) => {
      const response = await fetch(`${origin}/auth/recovery/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as Record<string, any> };
    };
    const fresh = async () => {
      await db.run('DELETE FROM admin_recovery_mail');
      await db.run('DELETE FROM admin_recovery_challenges');
      await db.run('DELETE FROM admin_recovery_limits');
      messages.length = 0;
      rejectMail = false;
    };
    const issue = async () => {
      const result = await post('request', { email: config.email });
      assert.equal(result.status, 202);
      await worker.processOnce();
      const otp = messages.at(-1)?.text.match(/code is: (\d{8})/)?.[1];
      assert.ok(otp, 'OTP must be delivered through mail, never the API');
      return { requestId: result.body.requestId as string, otp };
    };
    const confirmation = (challenge: { requestId: string; otp: string }) => ({
      ...challenge,
      email: config.email,
      newPassword: 'replacement-admin-password',
      confirmPassword: 'replacement-admin-password',
    });

    await t.test(
      'initial binding is permanent and ambiguous or missing admins fail closed',
      async () => {
        assert.deepEqual(await db.get('SELECT "userId",email FROM admin_recovery_owner'), {
          userId: ownerId,
          email: config.email,
        });
        await assert.rejects(
          new RecoveryService(db, {
            ...config,
            email: 'other@example.com',
          }).onApplicationBootstrap(),
          /differs/,
        );
        await db.run('DELETE FROM admin_recovery_owner');
        await db.run("UPDATE users SET role='GUARDIAN' WHERE id=$1", ownerId);
        await assert.rejects(service.onApplicationBootstrap(), /exactly one/);
        await db.run("UPDATE users SET role='ADMIN'");
        await assert.rejects(service.onApplicationBootstrap(), /exactly one/);
        await db.run("UPDATE users SET role='GUARDIAN' WHERE id=$1", guardianId);
        await service.onApplicationBootstrap();
        await db.run("UPDATE users SET role='ADMIN' WHERE id=$1", guardianId);
        await new RecoveryService(db, config).onApplicationBootstrap();
        assert.equal(
          (await db.get<{ userId: string }>('SELECT "userId" FROM admin_recovery_owner'))!.userId,
          ownerId,
        );
        await db.run("UPDATE users SET role='GUARDIAN' WHERE id=$1", guardianId);
      },
    );

    await t.test(
      'unknown emails get the same public response, with no challenge or mail',
      async () => {
        await fresh();
        const unknown = await post('request', { email: 'attacker@example.com' });
        const eligible = await post('request', { email: config.email });
        assert.equal(unknown.status, 202);
        assert.equal(unknown.body.message, eligible.body.message);
        assert.equal(
          await db.get(
            'SELECT id FROM admin_recovery_challenges WHERE id=$1',
            unknown.body.requestId,
          ),
          undefined,
        );
        assert.equal((await db.all('SELECT id FROM admin_recovery_mail')).length, 1);
        assert.equal(messages.length, 0, 'request must not send mail synchronously');
        worker = new RecoveryMailWorker(db, config, mail);
        await worker.processOnce();
        assert.equal(messages[0].to, config.email);
        const code = messages[0].text.match(/code is: (\d{8})/)![1];
        assert.ok(!JSON.stringify(eligible.body).includes(code));
        assert.equal(
          (await db.get<{ payload: string | null }>('SELECT payload FROM admin_recovery_mail'))!
            .payload,
          null,
        );
        assert.notEqual(
          (await db.get<{ codeHash: string }>('SELECT "codeHash" FROM admin_recovery_challenges'))!
            .codeHash,
          code,
        );
      },
    );

    await t.test(
      'successful reset revokes only owner sessions, audits, queues notice, and cannot replay',
      async () => {
        await fresh();
        const ownerSession = await auth.login({ phone: '01700000001', password: originalPassword });
        const guardianSession = await auth.login({
          phone: '01700000002',
          password: originalPassword,
        });
        const challenge = await issue();
        assert.equal(
          (await post('confirm', { ...confirmation(challenge), role: 'ADMIN' })).status,
          400,
        );
        assert.equal(
          (await post('confirm', { ...confirmation(challenge), userId: guardianId })).status,
          400,
        );
        const success = await post('confirm', confirmation(challenge));
        assert.equal(success.status, 200);
        assert.equal(success.body.token, undefined);
        await assert.rejects(auth.authenticate(ownerSession.token), { status: 401 });
        assert.equal((await auth.authenticate(guardianSession.token)).id, guardianId);
        await assert.rejects(auth.login({ phone: '01700000001', password: originalPassword }), {
          status: 401,
        });
        assert.equal(
          (await auth.login({ phone: '01700000001', password: 'replacement-admin-password' })).user
            .id,
          ownerId,
        );
        assert.ok(
          await db.get(
            'SELECT id FROM audit_logs WHERE action=\'ADMIN_PASSWORD_RECOVERED\' AND "actorId"=$1',
            ownerId,
          ),
        );
        await worker.processOnce();
        assert.match(messages.at(-1)!.subject, /password was reset/);
        assert.ok(!messages.at(-1)!.text.includes('replacement-admin-password'));
        assert.equal((await post('confirm', confirmation(challenge))).status, 400);
      },
    );

    await t.test(
      'incorrect attempts persist across restarts and exhaust the code after five tries',
      async () => {
        await fresh();
        const challenge = await issue();
        const wrong = challenge.otp === '00000000' ? '11111111' : '00000000';
        for (let i = 0; i < 5; i++) {
          const restarted = new RecoveryService(db, config);
          await assert.rejects(
            restarted.confirm(confirmation({ ...challenge, otp: wrong }), `attempt-${i}`),
            { status: 400 },
          );
        }
        assert.equal(
          (await db.get<{ attempts: number }>(
            'SELECT attempts FROM admin_recovery_challenges WHERE id=$1',
            challenge.requestId,
          ))!.attempts,
          5,
        );
        assert.equal((await post('confirm', confirmation(challenge))).status, 400);
      },
    );

    await t.test(
      'expired codes and non-admin owners cannot reset passwords or gain roles',
      async () => {
        await fresh();
        const challenge = await issue();
        await db.run(
          'UPDATE admin_recovery_challenges SET "expiresAt"=now()-interval \'1 second\'',
        );
        assert.equal((await post('confirm', confirmation(challenge))).status, 400);
        await fresh();
        const active = await issue();
        await db.run("UPDATE users SET role='GUARDIAN' WHERE id=$1", ownerId);
        assert.equal((await post('confirm', confirmation(active))).status, 400);
        assert.equal(
          (await db.get<{ role: string }>('SELECT role FROM users WHERE id=$1', ownerId))!.role,
          'GUARDIAN',
        );
        await db.run("UPDATE users SET role='ADMIN' WHERE id=$1", ownerId);
      },
    );

    await t.test('concurrent confirmations consume the code exactly once', async () => {
      await fresh();
      const challenge = await issue();
      const results = await Promise.all([
        post('confirm', confirmation(challenge)),
        post('confirm', confirmation(challenge)),
      ]);
      assert.deepEqual(results.map((result) => result.status).sort(), [200, 400]);
    });

    await t.test(
      'owner phone changes do not redirect recovery and another email cannot use the code',
      async () => {
        await fresh();
        await db.run('UPDATE users SET phone=$1 WHERE id=$2', '01700000003', ownerId);
        try {
          const challenge = await issue();
          assert.equal(
            (await post('confirm', { ...confirmation(challenge), email: 'attacker@example.com' }))
              .status,
            400,
          );
          assert.equal((await post('confirm', confirmation(challenge))).status, 200);
          assert.equal(
            (await auth.login({ phone: '01700000003', password: 'replacement-admin-password' }))
              .user.id,
            ownerId,
          );
        } finally {
          await db.run('UPDATE users SET phone=$1 WHERE id=$2', '01700000001', ownerId);
        }
      },
    );

    await t.test(
      'a login using a password read before a reset cannot issue a session afterward',
      async () => {
        const previous = (await db.get<{ passwordHash: string }>(
          'SELECT "passwordHash" FROM users WHERE id=$1',
          ownerId,
        ))!;
        const changedHash = await hashPassword('changed-while-login-was-hashing');
        const sessionsBefore = await db.all(
          'SELECT "tokenHash" FROM sessions WHERE "userId"=$1 ORDER BY "tokenHash"',
          ownerId,
        );
        const racingAuth = new AuthService({
          get: async (sql: string, ...params: unknown[]) => {
            const row = await db.get(sql, ...params);
            if (sql === 'SELECT * FROM users WHERE phone = $1')
              await db.run('UPDATE users SET "passwordHash"=$1 WHERE id=$2', changedHash, ownerId);
            return row;
          },
          run: db.run.bind(db),
          transaction: db.transaction.bind(db),
        });
        try {
          await assert.rejects(
            racingAuth.login({ phone: '01700000001', password: 'replacement-admin-password' }),
            { status: 401 },
          );
          assert.deepEqual(
            await db.all(
              'SELECT "tokenHash" FROM sessions WHERE "userId"=$1 ORDER BY "tokenHash"',
              ownerId,
            ),
            sessionsBefore,
          );
        } finally {
          await db.run(
            'UPDATE users SET "passwordHash"=$1 WHERE id=$2',
            previous.passwordHash,
            ownerId,
          );
        }
      },
    );

    await t.test(
      'cooldown preserves the active code, resending replaces it, and hourly quota persists',
      async () => {
        await fresh();
        const initial = await issue();
        const cooldown = await post('request', { email: config.email });
        assert.equal(cooldown.status, 202);
        assert.equal((await db.all('SELECT id FROM admin_recovery_challenges')).length, 1);
        for (let i = 0; i < 4; i++) {
          await db.run(
            'UPDATE admin_recovery_challenges SET "createdAt"=now()-interval \'61 seconds\'',
          );
          await new RecoveryService(db, config).request(config.email, `resend-${i}`);
        }
        assert.equal((await post('confirm', confirmation(initial))).status, 400);
        await db.run(
          'UPDATE admin_recovery_challenges SET "createdAt"=now()-interval \'61 seconds\'',
        );
        await service.request(config.email, 'hourly-limit');
        assert.equal((await db.all('SELECT id FROM admin_recovery_challenges')).length, 5);
      },
    );

    await t.test('request and verification IP limits survive service recreation', async () => {
      await fresh();
      for (let i = 0; i < 10; i++) await service.request('wrong@example.com', 'limited-ip');
      await assert.rejects(
        new RecoveryService(db, config).request('wrong@example.com', 'limited-ip'),
        { status: 429 },
      );
      for (let i = 0; i < 20; i++)
        await assert.rejects(
          service.confirm(confirmation({ requestId: randomUUID(), otp: '00000000' }), 'verify-ip'),
          { status: 400 },
        );
      await assert.rejects(
        new RecoveryService(db, config).confirm(
          confirmation({ requestId: randomUUID(), otp: '00000000' }),
          'verify-ip',
        ),
        { status: 429 },
      );
    });

    await t.test('mail failures retry durably and expired mail never sends', async () => {
      await fresh();
      await post('request', { email: config.email });
      rejectMail = true;
      await worker.processOnce();
      assert.equal(messages.length, 0);
      assert.equal(
        (await db.get<{ attempts: number }>('SELECT attempts FROM admin_recovery_mail'))!.attempts,
        1,
      );
      rejectMail = false;
      await db.run('UPDATE admin_recovery_mail SET "nextAttemptAt"=now()');
      worker = new RecoveryMailWorker(db, config, mail);
      await Promise.all([worker.processOnce(), worker.processOnce()]);
      assert.equal(messages.length, 1);
      await fresh();
      await post('request', { email: config.email });
      await db.run('UPDATE admin_recovery_challenges SET "expiresAt"=now()-interval \'1 second\'');
      await worker.processOnce();
      assert.equal(messages.length, 0);
    });

    await t.test(
      'audit failure rolls back password, OTP consumption and session deletion together',
      async () => {
        await fresh();
        const challenge = await issue();
        const before = await db.get('SELECT "passwordHash" FROM users WHERE id=$1', ownerId);
        const session = await auth.login({
          phone: '01700000001',
          password: 'replacement-admin-password',
        });
        await db.exec(`CREATE FUNCTION fail_recovery_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action='ADMIN_PASSWORD_RECOVERED' THEN RAISE EXCEPTION 'test failure'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER fail_recovery_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_recovery_audit()`);
        try {
          assert.equal(
            (
              await post('confirm', {
                ...confirmation(challenge),
                newPassword: 'another-new-password',
                confirmPassword: 'another-new-password',
              })
            ).status,
            500,
          );
        } finally {
          await db.exec(
            'DROP TRIGGER fail_recovery_audit ON audit_logs; DROP FUNCTION fail_recovery_audit()',
          );
        }
        assert.deepEqual(
          await db.get('SELECT "passwordHash" FROM users WHERE id=$1', ownerId),
          before,
        );
        assert.equal((await auth.authenticate(session.token)).id, ownerId);
        assert.equal(
          (await db.get<{ usedAt: Date | null }>(
            'SELECT "usedAt" FROM admin_recovery_challenges WHERE id=$1',
            challenge.requestId,
          ))!.usedAt,
          null,
        );
        assert.equal((await post('confirm', confirmation(challenge))).status, 200);
      },
    );
  },
);
