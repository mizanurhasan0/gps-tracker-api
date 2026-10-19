import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationShutdown,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import {
  TELEGRAM_DELIVERY,
  TelegramDeliveryPort,
  TelegramDeliveryResult,
} from './telegram-delivery.port';

const DELIVERY_POLL_MS = 5_000;
const DELIVERY_BATCH_SIZE = 10;
/** Paces one worker to at most 10 messages/s, well under Telegram's ~30/s bot limit. */
const DELIVERY_MIN_INTERVAL_MS = 100;
/** Telegram allows about one message per second to the same chat. */
const DELIVERY_CHAT_INTERVAL_MS = 1_000;
const DELIVERY_LEASE_MS = 30_000;
/** A FAILED delivery is retried until it has used this many attempts. */
export const DELIVERY_MAX_ATTEMPTS = 8;

interface TelegramDeliveryJob {
  id: string;
  notificationId: string;
  guardianId: string;
  chatId: string;
  title: string;
  body: string;
  attempts: number;
}

export interface Notification {
  id: string;
  userId: string;
  title: string;
  body: string;
  entityId: string;
  createdAt: string;
  readAt: string | null;
  telegramStatus?: string;
}

export interface CreatedNotification {
  notificationId: string;
  /** Whether a Telegram outbox row was queued in the same transaction. */
  telegramQueued: boolean;
}
@Injectable()
export class NotificationsService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(NotificationsService.name);
  private deliveryTimer?: NodeJS.Timeout;
  private deliveryPass?: Promise<void>;
  private stopping = false;
  private lastSentAt = 0;
  private readonly chatSentAt = new Map<string, number>();

  constructor(
    private readonly db: DatabaseService,
    @Optional()
    @Inject(TELEGRAM_DELIVERY)
    private readonly telegram?: TelegramDeliveryPort,
  ) {}

  async onModuleInit(): Promise<void> {
    this.deliveryTimer = setInterval(() => {
      void this.processDeliveries();
    }, DELIVERY_POLL_MS);
    this.deliveryTimer.unref?.();
    void this.processDeliveries();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.deliveryTimer) clearInterval(this.deliveryTimer);
    this.deliveryTimer = undefined;
    if (this.deliveryPass) await this.deliveryPass;
  }

  /** Callers may ignore the result; bulk senders keep it to report delivery state. */
  async create(
    userId: string,
    title: string,
    body: string,
    entityId: string,
  ): Promise<CreatedNotification> {
    return this.db.transaction(async () => {
      const notificationId = randomUUID();
      const createdAt = new Date().toISOString();
      await this.db.run(
        'INSERT INTO notifications (id,"userId",title,body,"entityId","createdAt") VALUES ($1,$2,$3,$4,$5,$6)',
        notificationId,
        userId,
        title,
        body,
        entityId,
        createdAt,
      );
      const connection = await this.db.get<{ chatId: string }>(
        `SELECT "chatId" FROM telegram_connections
         WHERE "guardianId" = $1 AND status = 'CONNECTED'`,
        userId,
      );
      let telegramQueued = false;
      if (connection) {
        const queued = await this.db.run(
          `INSERT INTO telegram_deliveries
            (id,"eventKey","notificationId","guardianId","chatId",title,body,status,attempts,"nextAttemptAt","createdAt","updatedAt")
           VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING',0,$8,$8,$8)
           ON CONFLICT ("eventKey") DO NOTHING`,
          randomUUID(),
          `notification:${notificationId}`,
          notificationId,
          userId,
          connection.chatId,
          title,
          body,
          createdAt,
        );
        telegramQueued = queued.rowCount > 0;
      }
      return { notificationId, telegramQueued };
    });
  }
  async admins(title: string, body: string, entityId: string): Promise<void> {
    for (const admin of await this.db.all<{ id: string }>(
      "SELECT id FROM users WHERE role = 'ADMIN'",
    ))
      await this.create(admin.id, title, body, entityId);
  }
  list(userId: string): Promise<Notification[]> {
    return this.db.all<Notification>(
      `SELECT n.*, d.status AS "telegramStatus"
       FROM notifications n
       LEFT JOIN telegram_deliveries d ON d."notificationId" = n.id
       WHERE n."userId" = $1
       ORDER BY n."createdAt" DESC LIMIT 100`,
      userId,
    );
  }
  async read(userId: string, id: string): Promise<void> {
    if (
      !(
        await this.db.run(
          'UPDATE notifications SET "readAt" = COALESCE("readAt", $1) WHERE id = $2 AND "userId" = $3',
          new Date().toISOString(),
          id,
          userId,
        )
      ).rowCount
    ) {
      throw new NotFoundException('Notification not found');
    }
  }
  async audit(actorId: string, action: string, entityId: string, note = ''): Promise<void> {
    await this.db.run(
      'INSERT INTO audit_logs (id,"actorId",action,"entityId",note,"createdAt") VALUES ($1,$2,$3,$4,$5,$6)',
      randomUUID(),
      actorId,
      action,
      entityId,
      note,
      new Date().toISOString(),
    );
  }

  /**
   * Returns delivery records for the admin notification view. The existing
   * /notifications response remains unchanged for app clients.
   */
  listTelegramDeliveries(limit = 100): Promise<unknown[]> {
    return this.db.all(
      `SELECT d.id, d."notificationId", d."guardianId" AS "userId",
          u.name AS "userName", right(d."chatId"::text, 4) AS "chatIdLast4",
          d.title, d.body, d.status,
          d.attempts, d."lastError", d."telegramMessageId",
          d."createdAt", d."updatedAt", d."sentAt"
       FROM telegram_deliveries d
       JOIN users u ON u.id = d."guardianId"
       ORDER BY d."createdAt" DESC
       LIMIT $1`,
      Math.min(Math.max(limit, 1), 500),
    );
  }

  private processDeliveries(): Promise<void> {
    if (!this.telegram) return Promise.resolve();
    if (!this.deliveryPass) {
      let backlog = false;
      this.deliveryPass = this.deliverPending()
        .then((more) => {
          backlog = more;
        })
        .catch((error: unknown) => {
          this.logger.error(
            `Telegram delivery worker failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        })
        .finally(() => {
          this.deliveryPass = undefined;
          // A full batch means a backlog (for example a bulk message): continue
          // at the paced rate instead of idling until the next poll.
          if (backlog && !this.stopping) setImmediate(() => void this.processDeliveries());
        });
    }
    return this.deliveryPass;
  }

  /** Returns true when the batch was full and more jobs may be waiting. */
  private async deliverPending(): Promise<boolean> {
    for (let index = 0; index < DELIVERY_BATCH_SIZE; index++) {
      if (this.stopping) return false;
      const job = await this.claimDelivery();
      if (!job) return false;

      await this.paceDelivery(String(job.chatId));

      let result: TelegramDeliveryResult;
      try {
        result = await this.telegram!.deliver({
          notificationId: job.notificationId,
          userId: job.guardianId,
          chatId: job.chatId,
          title: job.title,
          body: job.body,
        });
      } catch (error: unknown) {
        await this.retryDelivery(job, error instanceof Error ? error.message : String(error), true);
        continue;
      }

      if (result.status === 'SENT') {
        await this.markSent(job.id, result.providerMessageId);
      } else if (result.status === 'SKIPPED') {
        await this.markSkipped(job.id, result.reason);
      } else {
        await this.retryDelivery(job, result.reason, true);
      }
    }
    return true;
  }

  private async paceDelivery(chatId: string): Promise<void> {
    const wait =
      Math.max(
        this.lastSentAt + DELIVERY_MIN_INTERVAL_MS,
        (this.chatSentAt.get(chatId) ?? 0) + DELIVERY_CHAT_INTERVAL_MS,
      ) - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastSentAt = Date.now();
    for (const [chat, sentAt] of this.chatSentAt)
      if (sentAt + DELIVERY_CHAT_INTERVAL_MS <= this.lastSentAt) this.chatSentAt.delete(chat);
    this.chatSentAt.set(chatId, this.lastSentAt);
  }

  private claimDelivery(): Promise<TelegramDeliveryJob | undefined> {
    return this.db.transaction(async () => {
      const row = await this.db.get<TelegramDeliveryJob>(
        `SELECT id, "notificationId", "guardianId", "chatId", title, body, attempts
         FROM telegram_deliveries
         WHERE ((status IN ('PENDING','FAILED') AND
                 COALESCE("nextAttemptAt", now()) <= now() AND attempts < $1)
            OR (status = 'SENDING' AND "updatedAt" <= now() - ($2 * interval '1 millisecond')))
         ORDER BY COALESCE("nextAttemptAt", "createdAt"), "createdAt"
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
        DELIVERY_MAX_ATTEMPTS,
        DELIVERY_LEASE_MS,
      );
      if (!row) return undefined;

      const nextAttempts = row.attempts + 1;
      await this.db.run(
        `UPDATE telegram_deliveries
         SET status = 'SENDING', attempts = $2,
             "nextAttemptAt" = NULL, "updatedAt" = now(), "lastError" = NULL
         WHERE id = $1`,
        row.id,
        nextAttempts,
        DELIVERY_LEASE_MS,
      );
      return {
        id: row.id,
        notificationId: row.notificationId,
        guardianId: row.guardianId,
        chatId: row.chatId,
        title: row.title,
        body: row.body,
        attempts: nextAttempts,
      };
    });
  }

  private async markSent(id: string, providerMessageId?: string): Promise<void> {
    await this.db.run(
      `UPDATE telegram_deliveries
       SET status = 'SENT', "telegramMessageId" = $2, "sentAt" = now(),
           "updatedAt" = now(), "lastError" = NULL
       WHERE id = $1 AND status = 'SENDING'`,
      id,
      providerMessageId && /^\d+$/.test(providerMessageId) ? Number(providerMessageId) : null,
    );
  }

  private async markSkipped(id: string, reason: string): Promise<void> {
    await this.db.run(
      `UPDATE telegram_deliveries
       SET status = 'CANCELLED', "lastError" = $2,
           "updatedAt" = now()
       WHERE id = $1 AND status = 'SENDING'`,
      id,
      reason.slice(0, 1000),
    );
  }

  private async retryDelivery(
    job: TelegramDeliveryJob,
    reason: string,
    retryable: boolean,
  ): Promise<void> {
    const terminalFailure = !retryable || job.attempts >= DELIVERY_MAX_ATTEMPTS;
    const delayMs = Math.min(60 * 60 * 1000, 5_000 * 2 ** (job.attempts - 1));
    await this.db.run(
      `UPDATE telegram_deliveries
       SET status = $2,
           "nextAttemptAt" = CASE WHEN $2 = 'FAILED' AND NOT $5
             THEN now() + ($3 * interval '1 millisecond') ELSE NULL END,
           "lastError" = $4, "updatedAt" = now()
       WHERE id = $1 AND status = 'SENDING'`,
      job.id,
      'FAILED',
      delayMs,
      reason.slice(0, 1000),
      terminalFailure,
    );
  }
}
