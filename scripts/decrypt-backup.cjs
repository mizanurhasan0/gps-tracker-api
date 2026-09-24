#!/usr/bin/env node
'use strict';

const { createDecipheriv } = require('node:crypto');
const { createReadStream, createWriteStream, existsSync } = require('node:fs');
const { open, stat, unlink } = require('node:fs/promises');
const { resolve } = require('node:path');
const { pipeline } = require('node:stream/promises');

const MAGIC = Buffer.from('GPSBACKUP1', 'ascii');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + IV_BYTES;

if (existsSync('.env')) process.loadEnvFile('.env');

function encryptionKey(value = process.env.BACKUP_ENCRYPTION_KEY) {
  const hex = value?.trim() || '';
  if (!/^[a-f\d]{64}$/i.test(hex))
    throw new Error('BACKUP_ENCRYPTION_KEY must contain exactly 64 hexadecimal characters');
  return Buffer.from(hex, 'hex');
}

async function decryptBackup(inputPath, outputPath, key = encryptionKey()) {
  const input = resolve(inputPath);
  const output = resolve(outputPath);
  if (input === output) throw new Error('Input and output paths must be different');
  const details = await stat(input);
  if (!details.isFile() || details.size < HEADER_BYTES + TAG_BYTES)
    throw new Error('Backup archive is too short or is not a regular file');

  const handle = await open(input, 'r');
  const header = Buffer.alloc(HEADER_BYTES);
  const tag = Buffer.alloc(TAG_BYTES);
  try {
    const headerRead = await handle.read(header, 0, HEADER_BYTES, 0);
    const tagRead = await handle.read(tag, 0, TAG_BYTES, details.size - TAG_BYTES);
    if (headerRead.bytesRead !== HEADER_BYTES || tagRead.bytesRead !== TAG_BYTES)
      throw new Error('Backup archive is truncated');
  } finally {
    await handle.close();
  }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC))
    throw new Error('Backup archive has an unsupported or invalid header');

  const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(MAGIC.length));
  decipher.setAuthTag(tag);
  const source = createReadStream(input, {
    start: HEADER_BYTES,
    end: details.size - TAG_BYTES - 1,
  });
  let outputCreated = false;
  try {
    const destination = createWriteStream(output, { flags: 'wx', mode: 0o600 });
    destination.once('open', () => {
      outputCreated = true;
    });
    await pipeline(source, decipher, destination);
  } catch (error) {
    if (outputCreated) await unlink(output).catch(() => undefined);
    if (error && (error.code === 'EEXIST' || /authenticate data/.test(error.message || '')))
      throw new Error(
        error.code === 'EEXIST'
          ? 'Output file already exists; refusing to overwrite it'
          : 'Backup authentication failed; the key is wrong or the archive was modified',
      );
    throw error;
  }
}

async function main() {
  const [, , inputPath, outputPath] = process.argv;
  if (!inputPath || !outputPath)
    throw new Error('Usage: node scripts/decrypt-backup.cjs <backup.dump.enc> <output.dump>');
  await decryptBackup(inputPath, outputPath);
  process.stdout.write(`Decrypted backup written to ${resolve(outputPath)}\n`);
  process.stdout.write('No restore command was run. Inspect the dump before using pg_restore.\n');
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`Decrypt failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { decryptBackup, encryptionKey, MAGIC };
