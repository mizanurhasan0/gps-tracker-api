import {
  BadRequestException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseService } from '../../database/database.service';
import { hashPassword } from '../password';
import {
  RECOVERY_CONFIG,
  RECOVERY_MAX_ATTEMPTS,
  RECOVERY_TTL_MS,
  RecoveryConfig,
} from './recovery.config';
import { RecoveryCrypto } from './recovery.crypto';
import { RecoveryConfirmDto } from './recovery.dto';

interface Owner {
  userId: string;
  email: string;
  role: string;
}
interface Challenge extends Owner {
  codeHash: string;
  attempts: number;
  valid: boolean;
}

@Injectable()
export class RecoveryService implements OnApplicationBootstrap {
  private readonly crypto: RecoveryCrypto;

  constructor(
    private readonly db: DatabaseService,
    @Inject(RECOVERY_CONFIG) private readonly config: RecoveryConfig,
  ) {
    this.crypto = new RecoveryCrypto(config.secret);
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.enabled) return;
    await this.db.transaction(async () => {
      await this.db.run('SELECT pg_advisory_xact_lock(74523003)');
      const existing = await this.db.get<Owner>(
        'SELECT "userId",email FROM admin_recovery_owner WHERE id=1',
      );
      if (existing) {
        if (existing.email !== this.config.email)
          throw new Error(
            'Recovery email differs from its permanent binding; review the documented owner-change procedure',
          );
        return;
      }
      const admins = await this.db.all<{ id: string }>(
        "SELECT id FROM users WHERE role='ADMIN' LIMIT 2",
      );
      if (admins.length !== 1)
        throw new Error(
          'Admin recovery requires exactly one existing admin for its initial binding',
        );
      await this.db.run(
        'INSERT INTO admin_recovery_owner(id,"userId",email) VALUES(1,$1,$2)',
        admins[0].id,
        this.config.email,
      );
      await this.audit(admins[0].id, 'ADMIN_RECOVERY_BOUND');
    });
  }

  async request(email: string, ip: string): Promise<{ message: string; requestId: string }> {
    const started = Date.now();
    try {
      return await this.createRequest(email, ip);
    } finally {
      // Normalize ordinary eligible/ineligible response timing without waiting on SMTP.
      await delay(Math.max(0, 250 - (Date.now() - started)));
    }
  }

  private async createRequest(
    email: string,
    ip: string,
  ): Promise<{ message: string; requestId: string }> {
    this.assertEnabled();
    await this.limit('request', ip, 10);
    const requestId = randomUUID();
    // Wrong emails, cooldowns and unavailable accounts all return the same shape.
    // SMTP is handled by the outbox worker, never on this public request path.
    await this.db.transaction(async () => {
      const owner = await this.owner();
      if (!owner || owner.role !== 'ADMIN' || !this.emailMatches(email, owner.email)) return;
      const frequency = await this.db.get<{ hourly: number; recent: number }>(
        `SELECT count(*)::int hourly,
          count(*) FILTER(WHERE "createdAt">now()-interval '60 seconds')::int recent
         FROM admin_recovery_challenges WHERE "ownerId"=1 AND "createdAt">now()-interval '1 hour'`,
      );
      if (frequency!.recent || frequency!.hourly >= 5) return;
      const otp = this.crypto.otp();
      const expiresAt = new Date(Date.now() + RECOVERY_TTL_MS).toISOString();
      await this.db.run(
        'UPDATE admin_recovery_challenges SET "usedAt"=now() WHERE "ownerId"=1 AND "usedAt" IS NULL',
      );
      await this.db.run(
        "UPDATE admin_recovery_mail SET payload=NULL WHERE kind='OTP' AND payload IS NOT NULL",
      );
      await this.db.run(
        `INSERT INTO admin_recovery_challenges(id,"ownerId","codeHash","expiresAt") VALUES($1,1,$2,$3)`,
        requestId,
        this.crypto.digest('otp', requestId, owner.email, otp),
        expiresAt,
      );
      await this.queueMail('OTP', requestId, expiresAt, {
        subject: 'Admin recovery verification code',
        text: `Your admin recovery code is: ${otp}\n\nIt expires in 5 minutes and can be used once. Request ID: ${requestId}\nIf you did not request this, ignore this message. Never share this code.`,
      });
      await this.audit(owner.userId, 'ADMIN_RECOVERY_REQUESTED');
    });
    return {
      message:
        'If this email is eligible, recovery instructions will be sent. Please check your inbox.',
      requestId,
    };
  }

  async confirm(input: RecoveryConfirmDto, ip: string): Promise<{ message: string }> {
    this.assertEnabled();
    await this.limit('confirm', ip, 20);
    if (input.newPassword !== input.confirmPassword)
      throw new BadRequestException('Passwords do not match');
    const digest = this.crypto.digest('otp', input.requestId, input.email, input.otp);
    const recovered = await this.db.transaction(async () => {
      const row = await this.db.get<Challenge>(
        `SELECT c."codeHash",c.attempts,o."userId",o.email,u.role,
          (c."usedAt" IS NULL AND c."expiresAt">clock_timestamp()) AS valid
         FROM admin_recovery_challenges c
         JOIN admin_recovery_owner o ON o.id=c."ownerId"
         JOIN users u ON u.id=o."userId" WHERE c.id=$1 FOR UPDATE OF c,u`,
        input.requestId,
      );
      const codeMatches = this.crypto.matches(row?.codeHash ?? '0'.repeat(64), digest);
      if (!row || !row.valid || row.attempts >= RECOVERY_MAX_ATTEMPTS || row.role !== 'ADMIN')
        return false;
      if (!codeMatches || !this.emailMatches(input.email, row.email)) {
        await this.db.run(
          `UPDATE admin_recovery_challenges SET attempts=attempts+1,
           "usedAt"=CASE WHEN attempts+1 >= $2 THEN now() ELSE NULL END WHERE id=$1`,
          input.requestId,
          RECOVERY_MAX_ATTEMPTS,
        );
        if (row.attempts + 1 >= RECOVERY_MAX_ATTEMPTS) {
          await this.clearCode(input.requestId);
          await this.audit(row.userId, 'ADMIN_RECOVERY_ATTEMPTS_EXHAUSTED');
        }
        // Returning instead of throwing ensures failed attempts commit.
        return false;
      }
      const passwordHash = await hashPassword(input.newPassword);
      const consumed = await this.db.run(
        'UPDATE admin_recovery_challenges SET "usedAt"=now() WHERE id=$1 AND "usedAt" IS NULL AND "expiresAt">clock_timestamp()',
        input.requestId,
      );
      if (!consumed.rowCount) return false;
      await this.db.run(
        'UPDATE users SET "passwordHash"=$1 WHERE id=$2 AND role=\'ADMIN\'',
        passwordHash,
        row.userId,
      );
      await this.db.run('DELETE FROM sessions WHERE "userId"=$1', row.userId);
      await this.clearCode(input.requestId);
      await this.audit(row.userId, 'ADMIN_PASSWORD_RECOVERED');
      await this.queueMail('NOTICE', null, new Date(Date.now() + 24 * 3_600_000).toISOString(), {
        subject: 'Your admin password was reset',
        text: 'Your admin password was reset using email recovery. All previous sessions for this account have been signed out. Sign in normally with your new password. If this was not you, secure your email and contact your server operator immediately.',
      });
      return true;
    });
    if (!recovered)
      throw new BadRequestException('Invalid or expired recovery code. Request a new code.');
    return { message: 'Admin password reset. Sign in with your new password.' };
  }

  private owner(): Promise<Owner | undefined> {
    return this.db.get<Owner>(
      'SELECT o."userId",o.email,u.role FROM admin_recovery_owner o JOIN users u ON u.id=o."userId" WHERE o.id=1 FOR UPDATE OF o',
    );
  }

  private emailMatches(email: string, expected: string): boolean {
    return (
      this.crypto.matches(
        this.crypto.digest('email', email),
        this.crypto.digest('email', expected),
      ) && expected === this.config.email
    );
  }

  private async limit(action: string, ip: string, maximum: number): Promise<void> {
    const duration = 15 * 60_000;
    const windowStart = Math.floor(Date.now() / duration) * duration;
    const result = await this.db.get<{ attempts: number }>(
      `INSERT INTO admin_recovery_limits(key,"windowStart",attempts,"expiresAt") VALUES($1,$2,1,$3)
       ON CONFLICT(key,"windowStart") DO UPDATE SET attempts=admin_recovery_limits.attempts+1
       RETURNING attempts`,
      this.crypto.digest('rate-limit', action, ip),
      windowStart,
      new Date(windowStart + duration).toISOString(),
    );
    if (result!.attempts > maximum)
      throw new HttpException('Too many recovery attempts. Try again later.', 429);
  }

  private async clearCode(requestId: string): Promise<void> {
    await this.db.run(
      'UPDATE admin_recovery_mail SET payload=NULL WHERE "challengeId"=$1',
      requestId,
    );
  }

  private async queueMail(
    kind: 'OTP' | 'NOTICE',
    challengeId: string | null,
    expiresAt: string,
    message: { subject: string; text: string },
  ): Promise<void> {
    const id = randomUUID();
    await this.db.run(
      `INSERT INTO admin_recovery_mail(id,"challengeId","ownerId",kind,payload,"expiresAt") VALUES($1,$2,1,$3,$4,$5)`,
      id,
      challengeId,
      kind,
      this.crypto.encrypt(JSON.stringify(message), id),
      expiresAt,
    );
  }

  private async audit(userId: string, action: string): Promise<void> {
    await this.db.run(
      'INSERT INTO audit_logs(id,"actorId",action,"entityId",note,"createdAt") VALUES($1,$2,$3,$2,$4,$5)',
      randomUUID(),
      userId,
      action,
      'Owner-bound email recovery',
      new Date().toISOString(),
    );
  }

  private assertEnabled(): void {
    if (!this.config.enabled) throw new NotFoundException('Not found');
  }
}
