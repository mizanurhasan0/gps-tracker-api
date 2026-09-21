import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { appConfig } from '../config/app.config';
import { TelegramService } from './telegram.service';

const INITIAL_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;

/**
 * Owns the bot's single long-polling session. Telegram permits only one
 * getUpdates consumer for a bot, so run one API replica when polling is enabled.
 */
@Injectable()
export class TelegramPollingService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(TelegramPollingService.name);
  private controller?: AbortController;
  private pollingTask?: Promise<void>;

  constructor(private readonly telegram: TelegramService) {}

  onApplicationBootstrap(): void {
    if (!appConfig.telegram.enabled) return;

    this.controller = new AbortController();
    this.pollingTask = this.poll(this.controller.signal);
  }

  async onApplicationShutdown(): Promise<void> {
    this.controller?.abort();
    if (this.pollingTask) await this.pollingTask;
    this.controller = undefined;
    this.pollingTask = undefined;
  }

  private async poll(signal: AbortSignal): Promise<void> {
    let offset: number | undefined;
    let retryDelayMs = INITIAL_RETRY_DELAY_MS;
    let webhookDeleted = false;

    while (!signal.aborted) {
      try {
        if (!webhookDeleted) {
          await this.telegram.deleteWebhook(signal);
          webhookDeleted = true;
          this.logger.log('Telegram long polling started');
        }

        const updates = await this.telegram.getUpdates(
          offset,
          appConfig.telegram.pollingTimeoutSeconds,
          signal,
        );
        retryDelayMs = INITIAL_RETRY_DELAY_MS;

        for (const update of updates) {
          const updateId = this.telegram.getUpdateId(update);
          if (updateId === undefined) continue;
          await this.telegram.handleUpdate(update);
          offset = updateId + 1;
        }
      } catch (error) {
        if (signal.aborted) return;
        this.logger.warn(
          `Telegram polling failed; retrying in ${retryDelayMs}ms: ${this.errorMessage(error)}`,
        );
        await this.wait(retryDelayMs, signal);
        retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_DELAY_MS);
      }
    }
  }

  private wait(milliseconds: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const timeout = setTimeout(done, milliseconds);
      const onAbort = () => done();
      function done(): void {
        clearTimeout(timeout);
        signal.removeEventListener('abort', onAbort);
        resolve();
      }
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
