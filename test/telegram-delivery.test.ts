import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TelegramDeliveryPort } from '../src/notifications/telegram-delivery.port';
import { NotificationsService } from '../src/notifications/notifications.service';

interface MutationResult {
  rowCount: number;
}

class DeliveryDatabaseStub {
  private claimed = false;
  readonly updates: string[] = [];

  async exec(_sql: string): Promise<void> {}

  async transaction<T>(work: () => Promise<T>): Promise<T> {
    return work();
  }

  async get<T = Record<string, unknown>>(_sql: string): Promise<T | undefined> {
    if (this.claimed) return undefined;
    this.claimed = true;
    return {
      id: 'delivery-1',
      notificationId: 'notification-1',
      userId: 'guardian-1',
      title: 'Bus alert',
      body: 'The bus is near the pickup point.',
      status: 'PENDING',
      attempts: 0,
    } as T;
  }

  async run(sql: string, ..._params: unknown[]): Promise<MutationResult> {
    this.updates.push(sql);
    return { rowCount: 1 };
  }
}

test('notification delivery worker does not deliver the same claimed job twice', async () => {
  const db = new DeliveryDatabaseStub();
  const delivered: string[] = [];
  const telegram: TelegramDeliveryPort = {
    deliver: async ({ notificationId }) => {
      delivered.push(notificationId);
      return { status: 'SENT', providerMessageId: 'telegram-message-1' };
    },
  };
  const service = new NotificationsService(db as never, telegram);
  const process = (
    service as unknown as { processDeliveries: () => Promise<void> }
  ).processDeliveries.bind(service);

  await Promise.all([process(), process()]);

  assert.deepEqual(delivered, ['notification-1']);
  assert.equal(db.updates.filter((sql) => sql.includes("status = 'SENT'")).length, 1);
  service.onApplicationShutdown();
});
