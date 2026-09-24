import { createCipheriv, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';

export const BACKUP_MAGIC = Buffer.from('GPSBACKUP1', 'ascii');

export async function encryptBackupStream(
  input: Readable,
  destination: string,
  key: Buffer,
  maxPlaintextBytes: number,
): Promise<number> {
  if (key.length !== 32) throw new Error('Backup encryption key must be 32 bytes');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback(
        bytes > maxPlaintextBytes ? new Error('Backup exceeded configured size limit') : null,
        chunk,
      );
    },
  });
  const output = createWriteStream(destination, { flags: 'wx', mode: 0o600 });
  output.write(Buffer.concat([BACKUP_MAGIC, iv]));
  await pipeline(input, limiter, cipher, output, { end: false });
  await new Promise<void>((resolve, reject) => {
    output.once('error', reject);
    output.end(cipher.getAuthTag(), resolve);
  });
  return bytes;
}
