import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { RECOVERY_CONFIG, RecoveryConfig } from './recovery.config';
import { RecoveryCrypto } from './recovery.crypto';
import { RECOVERY_MAIL, RecoveryMail } from './recovery.mail';

interface MailJob {
  id: string;
  email: string;
  payload: string;
  attempts: number;
}

@Injectable()
export class RecoveryMailWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(RecoveryMailWorker.name);
  private readonly crypto: RecoveryCrypto;
  private timer?: NodeJS.Timeout;
  private pass?: Promise<void>;
  private nextCleanup = 0;

  constructor(
    private readonly db: DatabaseService,
    @Inject(RECOVERY_CONFIG) private readonly config: RecoveryConfig,
    @Inject(RECOVERY_MAIL) private readonly mail: RecoveryMail,
  ) {
    this.crypto = new RecoveryCrypto(config.secret);
  }

  onApplicationBootstrap(): void {
    if (!this.config.enabled) return;
    this.timer = setInterval(() => {
      void this.processOnce();
    }, 1_000);
    this.timer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.pass;
  }

  processOnce(): Promise<void> {
    if (!this.config.enabled) return Promise.resolve();
    if (!this.pass) {
      this.pass = this.deliverNext()
        .catch(() => {
          this.logger.warn('Recovery email worker unavailable; it will retry');
        })
        .finally(() => {
          this.pass = undefined;
        });
    }
    return this.pass;
  }

  private async deliverNext(): Promise<void> {
    if (Date.now() >= this.nextCleanup) {
      await this.cleanup();
      this.nextCleanup = Date.now() + 60_000;
    }
    const job = await this.db.transaction(async () => {
      const row = await this.db.get<MailJob>(
        `SELECT m.id,m.payload,m.attempts,o.email FROM admin_recovery_mail m
         JOIN admin_recovery_owner o ON o.id=m."ownerId"
         WHERE m.payload IS NOT NULL AND m.attempts<5 AND m."expiresAt">now()
           AND m."nextAttemptAt"<=now() AND (m."leaseUntil" IS NULL OR m."leaseUntil"<=now())
           AND o.email=$1 AND (m.kind='NOTICE' OR EXISTS(
             SELECT 1 FROM admin_recovery_challenges c JOIN users u ON u.id=o."userId"
             WHERE c.id=m."challengeId" AND c."usedAt" IS NULL AND c."expiresAt">now() AND u.role='ADMIN'))
         ORDER BY m."createdAt" LIMIT 1 FOR UPDATE OF m SKIP LOCKED`,
        this.config.email,
      );
      if (!row) return undefined;
      await this.db.run(
        'UPDATE admin_recovery_mail SET attempts=attempts+1,"leaseUntil"=now()+interval \'2 minutes\' WHERE id=$1',
        row.id,
      );
      return { ...row, attempts: row.attempts + 1 };
    });
    if (!job) return;
    try {
      const message = JSON.parse(this.crypto.decrypt(job.payload, job.id)) as {
        subject: string;
        text: string;
      };
      await this.mail.send(job.email, message.subject, message.text, job.id);
      await this.db.run(
        'UPDATE admin_recovery_mail SET "sentAt"=now(),payload=NULL,"leaseUntil"=NULL WHERE id=$1',
        job.id,
      );
    } catch {
      // Never log SMTP errors: they can contain credentials, message bodies or recipients.
      this.logger.warn('Recovery email delivery failed; delivery status recorded');
      await this.db.run(
        `UPDATE admin_recovery_mail SET "leaseUntil"=NULL,"nextAttemptAt"=$2,
         payload=CASE WHEN attempts>=5 THEN NULL ELSE payload END WHERE id=$1`,
        job.id,
        new Date(Date.now() + Math.min(60_000, 5_000 * 2 ** (job.attempts - 1))).toISOString(),
      );
    }
  }

  private async cleanup(): Promise<void> {
    await this.db.run('DELETE FROM admin_recovery_limits WHERE "expiresAt"<now()');
    await this.db.run(
      'UPDATE admin_recovery_mail SET payload=NULL WHERE payload IS NOT NULL AND ("expiresAt"<=now() OR attempts>=5)',
    );
    await this.db.run(
      'DELETE FROM admin_recovery_mail WHERE "createdAt"<now()-interval \'7 days\' AND payload IS NULL',
    );
    await this.db.run(
      'DELETE FROM admin_recovery_challenges WHERE "expiresAt"<now()-interval \'1 day\'',
    );
  }
}
