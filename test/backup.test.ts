import assert from 'node:assert/strict';
import { createDecipheriv } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { readBackupConfig } from '../src/backup/backup.config';
import { BACKUP_MAGIC, encryptBackupStream } from '../src/backup/backup.crypto';

test('disabled backup accepts no secrets and scheduling defaults off', () => {
  const config = readBackupConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.scheduleEnabled, false);
  assert.equal(config.encryptionKey.length, 0);
});

test('enabled backup requires a Google refresh token', () => {
  assert.throws(
    () =>
      readBackupConfig({
        BACKUP_ENABLED: 'true',
        DATABASE_URL: 'postgresql://user:password@database:5432/tracker',
        BACKUP_ENCRYPTION_KEY: '12'.repeat(32),
        BACKUP_EMAIL: 'backup@example.com',
        BACKUP_SMTP_USER: 'sender@example.com',
        BACKUP_SMTP_PASSWORD: 'app-password',
        BACKUP_SMTP_FROM: 'sender@example.com',
        GOOGLE_CLIENT_ID: 'client-id',
        GOOGLE_CLIENT_SECRET: 'client-secret',
        GOOGLE_DRIVE_FOLDER_ID: '1dASr9Tb5TgyemjuZZD7lRTJ5N_w6aFxq',
      }),
    /OAuth credentials/,
  );
});

test('AES-256-GCM stream has a versioned header and authenticates plaintext', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'backup-test-'));
  const path = join(directory, 'backup.enc');
  const key = Buffer.from('ab'.repeat(32), 'hex');
  const plaintext = Buffer.from('sample PostgreSQL custom dump bytes');
  try {
    const byteCount = await encryptBackupStream(Readable.from(plaintext), path, key, 1024);
    assert.equal(byteCount, plaintext.length);
    const encrypted = await readFile(path);
    assert.deepEqual(encrypted.subarray(0, BACKUP_MAGIC.length), BACKUP_MAGIC);
    const ivStart = BACKUP_MAGIC.length;
    const ciphertextStart = ivStart + 12;
    const authTagStart = encrypted.length - 16;
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      encrypted.subarray(ivStart, ciphertextStart),
    );
    decipher.setAuthTag(encrypted.subarray(authTagStart));
    const restored = Buffer.concat([
      decipher.update(encrypted.subarray(ciphertextStart, authTagStart)),
      decipher.final(),
    ]);
    assert.deepEqual(restored, plaintext);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('encryption rejects a stream that exceeds the configured limit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'backup-limit-test-'));
  const path = join(directory, 'backup.enc');
  try {
    await assert.rejects(
      encryptBackupStream(Readable.from(Buffer.alloc(17)), path, Buffer.alloc(32), 16),
      /size limit/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
