import {
  ConflictException,
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appConfig } from '../config/app.config';
import { DatabaseService } from '../database/database.service';
import {
  TelegramDeliveryMessage,
  TelegramDeliveryPort,
  TelegramDeliveryResult,
} from '../notifications/telegram-delivery.port';
import {
  TelegramApiEnvelope,
  TelegramConnectResponse,
  TelegramStatusResponse,
  TelegramUpdateDto,
  TelegramUpdateResult,
} from './telegram.dto';

interface TelegramSentMessage {
  message_id?: unknown;
}

interface TelegramBotInfo {
  username?: unknown;
}

interface TelegramConnectionRow {
  connectedAt: string;
  username: string | null;
  chatId: string;
}

interface TelegramLinkTokenRow {
  guardianId: string;
  expiresAt: string;
}

const DEFAULT_LINK_TTL_SECONDS = 10 * 60;
const MAX_TELEGRAM_ATTEMPTS = 3;
const MAX_RETRY_AFTER_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

interface TelegramRequestOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  signal?: AbortSignal;
}

class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

@Injectable()
export class TelegramService implements OnModuleInit, TelegramDeliveryPort {
  private readonly logger = new Logger(TelegramService.name);
  private readonly botToken = appConfig.telegram.botToken ?? '';
  private readonly configuredBotUsername = appConfig.telegram.botUsername ?? '';
  private readonly telegramEnabled = appConfig.telegram.enabled;
  private readonly apiBaseUrl =
    process.env.TELEGRAM_API_BASE_URL?.trim() || 'https://api.telegram.org';
  private readonly linkTtlSeconds = this.readPositiveInteger(
    process.env.TELEGRAM_LINK_TOKEN_TTL_SECONDS,
    DEFAULT_LINK_TTL_SECONDS,
  );
  private botUsernamePromise?: Promise<string>;

  constructor(private readonly db: DatabaseService) {}

  async onModuleInit(): Promise<void> {
    await this.db.ensureReady();
  }

  async issueConnectLink(guardianId: string): Promise<TelegramConnectResponse> {
    this.requireConfigured();
    const botUsername = await this.getBotUsername();
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(
      Date.now() + this.linkTtlSeconds * 1000,
    ).toISOString();

    await this.db.transaction(async () => {
      await this.db.run(
        'DELETE FROM telegram_link_tokens WHERE "guardianId" = $1 OR "expiresAt" <= $2',
        guardianId,
        new Date().toISOString(),
      );
      await this.db.run(
        'INSERT INTO telegram_link_tokens (id,"tokenHash","guardianId","expiresAt") VALUES ($1,$2,$3,$4)',
        randomUUID(),
        this.digest(token),
        guardianId,
        expiresAt,
      );
    });

    return {
      enabled: true,
      url: `https://t.me/${botUsername}?start=${encodeURIComponent(`connect_${token}`)}`,
      expiresAt,
    };
  }

  async status(guardianId: string): Promise<TelegramStatusResponse> {
    const connection = await this.db.get<TelegramConnectionRow>(
      `SELECT "connectedAt",username,"chatId"
       FROM telegram_connections
       WHERE "guardianId" = $1 AND status = 'CONNECTED'`,
      guardianId,
    );

    return {
      enabled: this.isConfigured(),
      connected: Boolean(connection),
      connectedAt: connection?.connectedAt ?? null,
      username: connection?.username ?? null,
      chatIdLast4: connection ? connection.chatId.slice(-4) : null,
    };
  }

  async disconnect(guardianId: string): Promise<void> {
    await this.db.run(
      `UPDATE telegram_connections
       SET status = 'DISCONNECTED', "disconnectedAt" = COALESCE("disconnectedAt", $1), "updatedAt" = now()
       WHERE "guardianId" = $2`,
      new Date().toISOString(),
      guardianId,
    );
    await this.db.run(
      'DELETE FROM telegram_link_tokens WHERE "guardianId" = $1',
      guardianId,
    );
  }

  /** Processes one inbound update from the long-polling worker exactly once. */
  async handleUpdate(update: TelegramUpdateDto): Promise<TelegramUpdateResult> {
    const updateId = this.asInteger(update.update_id);
    if (updateId === undefined) return { handled: false };

    const inserted = await this.db.run(
      `INSERT INTO telegram_webhook_updates ("updateId",payload,status,"receivedAt")
       VALUES ($1,$2::jsonb,'RECEIVED',now()) ON CONFLICT ("updateId") DO NOTHING`,
      updateId,
      JSON.stringify(update),
    );
    if (!inserted.changes) return { handled: false };

    const message = update.message;
    const chatId = this.asChatId(message?.chat?.id);
    const text = this.asString(message?.text);
    if (!chatId || message?.chat?.type !== 'private' || !text) {
      await this.markUpdate(updateId);
      return { handled: false };
    }

    const startPayload = this.extractStartPayload(text);
    if (!startPayload) {
      await this.trySendMessage(chatId, 'সংযোগ করতে Connect Telegram লিংক থেকে Telegram Bot-এ Start চাপুন।');
      await this.markUpdate(updateId);
      return { handled: true };
    }

    const tokenHash = this.digest(startPayload);
    const token = await this.db.get<TelegramLinkTokenRow>(
      `SELECT "guardianId","expiresAt"
       FROM telegram_link_tokens
       WHERE "tokenHash" = $1 AND "usedAt" IS NULL AND "expiresAt" > $2`,
      tokenHash,
      new Date().toISOString(),
    );
    if (!token) {
      await this.trySendMessage(
        chatId,
        'এই Telegram connection link-এর মেয়াদ শেষ হয়েছে। App থেকে নতুন link তৈরি করুন।',
      );
      await this.markUpdate(updateId);
      return { handled: true };
    }

    try {
      await this.db.transaction(async () => {
        const consumed = await this.db.run(
          `UPDATE telegram_link_tokens SET "usedAt" = $1
           WHERE "tokenHash" = $2 AND "usedAt" IS NULL AND "expiresAt" > $3`,
          new Date().toISOString(),
          tokenHash,
          new Date().toISOString(),
        );
        if (!consumed.changes) throw new ConflictException('Link already used');
        await this.db.run(
          `INSERT INTO telegram_connections
             ("guardianId","chatId",username,status,"connectedAt","disconnectedAt","updatedAt")
           VALUES ($1,$2,$3,'CONNECTED',now(),NULL,now())
           ON CONFLICT ("guardianId") DO UPDATE SET
             "chatId" = EXCLUDED."chatId",
             username = EXCLUDED.username,
             status = 'CONNECTED',
             "connectedAt" = EXCLUDED."connectedAt",
             "disconnectedAt" = NULL,
             "updatedAt" = now()`,
          token.guardianId,
          chatId,
          this.asString(message.chat?.username) ?? '',
        );
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        await this.trySendMessage(
          chatId,
          'এই Telegram account অন্য একটি guardian account-এর সঙ্গে যুক্ত আছে।',
        );
        await this.markUpdate(updateId);
        return { handled: true };
      }
      if (error instanceof ConflictException) {
        await this.markUpdate(updateId, 'FAILED', error.message);
        return { handled: false };
      }
      await this.markUpdate(updateId, 'FAILED', this.errorMessage(error));
      throw error;
    }

    await this.trySendMessage(
      chatId,
      'Telegram সফলভাবে সংযুক্ত হয়েছে। এখন থেকে এই account-এ notification পাঠানো যাবে।',
    );
    await this.markUpdate(updateId);
    return { handled: true };
  }

  async deleteWebhook(signal: AbortSignal): Promise<void> {
    await this.requestTelegram<boolean>('deleteWebhook', {
      drop_pending_updates: false,
    }, { signal });
  }

  async getUpdates(
    offset: number | undefined,
    timeoutSeconds: number,
    signal: AbortSignal,
  ): Promise<TelegramUpdateDto[]> {
    return this.requestTelegram<TelegramUpdateDto[]>(
      'getUpdates',
      {
        ...(offset === undefined ? {} : { offset }),
        timeout: timeoutSeconds,
        allowed_updates: ['message'],
      },
      {
        timeoutMs: (timeoutSeconds + 10) * 1_000,
        maxAttempts: 1,
        signal,
      },
    );
  }

  getUpdateId(update: TelegramUpdateDto): number | undefined {
    return this.asInteger(update.update_id);
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    this.requireConfigured();
    await this.requestTelegram<TelegramSentMessage>('sendMessage', {
      chat_id: chatId,
      text,
    });
  }

  async deliver(
    message: TelegramDeliveryMessage,
  ): Promise<TelegramDeliveryResult> {
    if (!this.isConfigured())
      return { status: 'SKIPPED', reason: 'Telegram integration is disabled' };

    try {
      const sent = await this.requestTelegram<TelegramSentMessage>('sendMessage', {
        chat_id: message.chatId,
        text: `${message.title}\n\n${message.body}`,
      });
      const providerMessageId = this.asStringOrNumber(sent.message_id);
      return providerMessageId
        ? { status: 'SENT', providerMessageId }
        : { status: 'SENT' };
    } catch (error) {
      if (error instanceof TelegramApiError && [400, 403].includes(error.statusCode))
        return { status: 'SKIPPED', reason: error.message };
      return { status: 'RETRY', reason: this.errorMessage(error) };
    }
  }

  private async trySendMessage(chatId: string, text: string): Promise<void> {
    try {
      await this.sendMessage(chatId, text);
    } catch (error) {
      this.logger.warn(
        `Telegram acknowledgement failed: ${this.errorMessage(error)}`,
      );
    }
  }

  private async getBotUsername(): Promise<string> {
    if (this.configuredBotUsername) return this.configuredBotUsername;
    if (!this.botUsernamePromise) {
      this.botUsernamePromise = this.requestTelegram<TelegramBotInfo>('getMe', {})
        .then((bot) => {
          const username = this.asString(bot.username);
          if (!username) throw new ServiceUnavailableException('Telegram bot username is unavailable');
          return username;
        })
        .catch((error) => {
          this.botUsernamePromise = undefined;
          throw error;
        });
    }
    return this.botUsernamePromise;
  }

  private async requestTelegram<T>(
    method: string,
    body: Record<string, unknown>,
    options: TelegramRequestOptions = {},
  ): Promise<T> {
    this.requireConfigured();
    const maxAttempts = options.maxAttempts ?? MAX_TELEGRAM_ATTEMPTS;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      let response: Response;
      let payload: TelegramApiEnvelope<T>;
      try {
        const requestController = new AbortController();
        const timeout = setTimeout(
          () => requestController.abort(),
          options.timeoutMs ?? REQUEST_TIMEOUT_MS,
        );
        const abortRequest = () => requestController.abort();
        options.signal?.addEventListener('abort', abortRequest, { once: true });
        if (options.signal?.aborted) requestController.abort();
        try {
          response = await fetch(
            `${this.apiBaseUrl}/bot${this.botToken}/${method}`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
              signal: requestController.signal,
            },
          );
          payload = (await response.json()) as TelegramApiEnvelope<T>;
        } finally {
          clearTimeout(timeout);
          options.signal?.removeEventListener('abort', abortRequest);
        }
      } catch (error) {
        if (options.signal?.aborted || attempt + 1 >= maxAttempts) throw error;
        await this.delay(2 ** attempt * 500);
        continue;
      }

      if (payload.ok === true && payload.result !== undefined) return payload.result;

      const retryAfter = this.asInteger(payload.parameters?.retry_after);
      if (retryAfter !== undefined && attempt + 1 < maxAttempts) {
        await this.delay(Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS));
        continue;
      }

      const description = this.asString(payload.description) ?? `HTTP ${response.status}`;
      throw new TelegramApiError(
        `Telegram API error: ${description}`,
        response.status,
      );
    }
    throw new ServiceUnavailableException('Telegram API request failed');
  }

  private requireConfigured(): void {
    if (!this.isConfigured())
      throw new ServiceUnavailableException(
        'Telegram integration is not configured. Set TELEGRAM_BOT_TOKEN.',
      );
  }

  private isConfigured(): boolean {
    return Boolean(this.telegramEnabled && this.botToken);
  }

  private extractStartPayload(text: string): string | undefined {
    const match = text.trim().match(/^\/start(?:@[A-Za-z0-9_]+)?(?:\s+([^\s]+))?$/);
    const payload = match?.[1];
    return payload?.startsWith('connect_') ? payload.slice('connect_'.length) : undefined;
  }

  private digest(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private markUpdate(
    updateId: number,
    status: 'PROCESSED' | 'FAILED' = 'PROCESSED',
    errorMessage: string | null = null,
  ): Promise<void> {
    return this.db
      .run(
        `UPDATE telegram_webhook_updates
         SET status = $2, "processedAt" = now(), "errorMessage" = $3
         WHERE "updateId" = $1`,
        updateId,
        status,
        errorMessage?.slice(0, 1000) ?? null,
      )
      .then(() => undefined);
  }

  private asString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  private asChatId(value: unknown): string | undefined {
    if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
    if (typeof value === 'string' && /^-?\d+$/.test(value)) return value;
    return undefined;
  }

  private asStringOrNumber(value: unknown): string | undefined {
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
    return undefined;
  }

  private asInteger(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) {
      const parsed = Number(value);
      return Number.isSafeInteger(parsed) ? parsed : undefined;
    }
    return undefined;
  }

  private readPositiveInteger(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  }

  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
