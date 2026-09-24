import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ValidationPipe } from '@nestjs/common';
import { readRecoveryConfig } from '../src/auth/recovery/recovery.config';
import { RecoveryCrypto } from '../src/auth/recovery/recovery.crypto';
import { RecoveryService } from '../src/auth/recovery/recovery.service';
const { RecoveryRequestDto, RecoveryConfirmDto } = require('../dist/auth/recovery/recovery.dto');

const settings = {
  ADMIN_RECOVERY_ENABLED: 'true',
  ADMIN_RECOVERY_SECRET: 'ab'.repeat(32),
  RECOVERY_SMTP_USER: 'eng.mizanur.hasan@gmail.com',
  RECOVERY_SMTP_PASSWORD: 'test-only-password',
};

test('recovery configuration is disabled by default and fails closed when enabled without secrets', () => {
  assert.equal(readRecoveryConfig({}).enabled, false);
  for (const override of [
    { ADMIN_RECOVERY_SECRET: '' },
    { RECOVERY_SMTP_PASSWORD: '' },
    { RECOVERY_SMTP_PORT: '25' },
    { ADMIN_RECOVERY_EMAIL: 'invalid' },
    { ADMIN_RECOVERY_ENABLED: 'yes' },
    { RECOVERY_SMTP_FROM: 'invalid' },
  ])
    assert.throws(() => readRecoveryConfig({ ...settings, ...override }));
  const config = readRecoveryConfig(settings);
  assert.equal(config.email, 'eng.mizanur.hasan@gmail.com');
  assert.equal(config.smtp.host, 'smtp.gmail.com');
  assert.equal(config.smtp.port, 465);
});

test('OTP digests bind the code to its challenge and email; encrypted mail rejects tampering', () => {
  const crypto = new RecoveryCrypto(settings.ADMIN_RECOVERY_SECRET);
  const otp = crypto.otp();
  assert.match(otp, /^\d{8}$/);
  const digest = crypto.digest('otp', 'request-1', 'owner@example.com', otp);
  assert.equal(
    crypto.matches(digest, crypto.digest('otp', 'request-1', 'owner@example.com', otp)),
    true,
  );
  assert.equal(
    crypto.matches(digest, crypto.digest('otp', 'request-2', 'owner@example.com', otp)),
    false,
  );
  assert.equal(
    crypto.matches(digest, crypto.digest('otp', 'request-1', 'attacker@example.com', otp)),
    false,
  );
  const encrypted = crypto.encrypt(otp, 'message-1');
  assert.equal(crypto.decrypt(encrypted, 'message-1'), otp);
  assert.throws(() => crypto.decrypt(encrypted, 'message-2'));
  const tampered = Buffer.from(encrypted, 'base64');
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => crypto.decrypt(tampered.toString('base64'), 'message-1'));
});

test('recovery DTOs reject account selection, role injection, malformed codes and weak passwords', async () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
  const validate = (body: unknown, metatype = RecoveryConfirmDto) =>
    pipe.transform(body, { type: 'body', metatype });
  const input = {
    email: 'eng.mizanur.hasan@gmail.com',
    requestId: randomUUID(),
    otp: '01234567',
    newPassword: 'strong-new-password',
    confirmPassword: 'strong-new-password',
  };
  assert.equal(
    (await validate({ email: ' ENG.MIZANUR.HASAN@GMAIL.COM ' }, RecoveryRequestDto)).email,
    input.email,
  );
  for (const override of [
    { role: 'ADMIN' },
    { userId: randomUUID() },
    { phone: '01700000001' },
    { otp: '123456' },
    { otp: 12345678 },
    { requestId: 'invalid' },
    { newPassword: 'short' },
    { newPassword: 'x'.repeat(129) },
  ])
    await assert.rejects(() => validate({ ...input, ...override }));
});

test('disabled recovery never reads or modifies the database', async () => {
  const service = new RecoveryService({} as never, readRecoveryConfig({}));
  await service.onApplicationBootstrap();
  await assert.rejects(service.request('eng.mizanur.hasan@gmail.com', '127.0.0.1'), {
    status: 404,
  });
});
