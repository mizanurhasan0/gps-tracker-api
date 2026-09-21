import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { appConfig } from '../src/config/app.config';
import { TelegramPollingService } from '../src/telegram/telegram-polling.service';
import { TelegramUpdateDto } from '../src/telegram/telegram.dto';

const previousTelegramConfig = { ...appConfig.telegram };
after(() => {
  Object.assign(appConfig.telegram as unknown as Record<string, unknown>, previousTelegramConfig);
});

test('long polling removes an old webhook and advances its update offset', async () => {
  Object.assign(appConfig.telegram as unknown as Record<string, unknown>, {
    enabled: true,
    pollingTimeoutSeconds: 1,
  });

  const handled: number[] = [];
  let resolveSecondPoll!: (offset: number | undefined) => void;
  const secondPollStarted = new Promise<number | undefined>((resolve) => {
    resolveSecondPoll = resolve;
  });
  const telegram = {
    deleteWebhook: async (_signal: AbortSignal) => undefined,
    getUpdates: async (
      offset: number | undefined,
      _timeoutSeconds: number,
      signal: AbortSignal,
    ): Promise<TelegramUpdateDto[]> => {
      if (offset === undefined) return [{ update_id: 41 }, { update_id: 42 }];
      resolveSecondPoll(offset);
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      });
    },
    getUpdateId: (update: TelegramUpdateDto) =>
      typeof update.update_id === 'number' ? update.update_id : undefined,
    handleUpdate: async (update: TelegramUpdateDto) => {
      handled.push(update.update_id as number);
      return { handled: true };
    },
  };

  const polling = new TelegramPollingService(telegram as never);
  polling.onApplicationBootstrap();

  assert.equal(await secondPollStarted, 43);
  await polling.onApplicationShutdown();
  assert.deepEqual(handled, [41, 42]);
});
