'use strict';

const assert = require('node:assert/strict');
const { createCipheriv, randomBytes } = require('node:crypto');
const { mkdtemp, readFile, rm, stat, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');
const { decryptBackup, encryptionKey, MAGIC } = require('../scripts/decrypt-backup.cjs');

function archive(plaintext, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  return Buffer.concat([MAGIC, iv, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

test('decrypts an authenticated backup into a private new file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'backup-restore-test-'));
  const input = join(directory, 'backup.enc');
  const output = join(directory, 'backup.dump');
  const key = Buffer.from('42'.repeat(32), 'hex');
  const plaintext = Buffer.from('PostgreSQL custom dump test bytes');
  try {
    await writeFile(input, archive(plaintext, key));
    await decryptBackup(input, output, key);
    assert.deepEqual(await readFile(output), plaintext);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('refuses overwrite and removes partial output after authentication failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'backup-restore-safety-test-'));
  const input = join(directory, 'backup.enc');
  const existing = join(directory, 'existing.dump');
  const failed = join(directory, 'failed.dump');
  const key = Buffer.from('24'.repeat(32), 'hex');
  try {
    const tampered = archive(Buffer.from('sensitive dump'), key);
    tampered[tampered.length - 1] ^= 1;
    await writeFile(input, tampered);
    await writeFile(existing, 'keep-me');
    await assert.rejects(decryptBackup(input, existing, key), /refusing to overwrite/);
    assert.equal(await readFile(existing, 'utf8'), 'keep-me');
    await assert.rejects(decryptBackup(input, failed, key), /authentication failed/);
    await assert.rejects(stat(failed), error => error.code === 'ENOENT');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('validates encryption key before reading a backup', () => {
  assert.throws(() => encryptionKey('not-a-key'), /64 hexadecimal/);
});
