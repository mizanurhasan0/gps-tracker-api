import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';

/** Domain-separated keys prevent an OTP/database leak from enabling offline guessing. */
export class RecoveryCrypto {
  constructor(private readonly secret: string) {}

  otp(): string {
    return randomInt(0, 100_000_000).toString().padStart(8, '0');
  }

  digest(purpose: string, ...values: string[]): string {
    return createHmac('sha256', Buffer.from(this.secret, 'hex'))
      .update(JSON.stringify([purpose, ...values]))
      .digest('hex');
  }

  matches(expected: string, actual: string): boolean {
    const left = Buffer.from(expected, 'hex');
    const right = Buffer.from(actual, 'hex');
    return left.length === right.length && timingSafeEqual(left, right);
  }

  encrypt(text: string, messageId: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey(), iv);
    cipher.setAAD(Buffer.from(messageId));
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  }

  decrypt(value: string, messageId: string): string {
    const bytes = Buffer.from(value, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey(), bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(messageId));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
  }

  private encryptionKey(): Buffer {
    return Buffer.from(this.digest('recovery-mail-encryption-v1'), 'hex');
  }
}
