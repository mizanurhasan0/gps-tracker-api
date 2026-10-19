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

test('notification delivery worker drains a backlog at a paced rate', async () => {
  // Twelve jobs exceed one batch of ten; the first two share a chat.
  const jobs = Array.from({ length: 12 }, (_, index) => ({
    id: `delivery-${index}`,
    notificationId: `notification-${index}`,
    guardianId: `guardian-${index}`,
    chatId: String(index === 1 ? 88000 : 88000 + index),
    title: 'Notice',
    body: 'Bus is late',
    attempts: 0,
  }));
  const db = {
    transaction: <T>(work: () => Promise<T>) => work(),
    get: async () => jobs.shift(),
    run: async () => ({ rowCount: 1 }),
  };
  const sends: { chatId: string; at: number }[] = [];
  let drained!: () => void;
  const allSent = new Promise<void>((resolve) => (drained = resolve));
  const telegram: TelegramDeliveryPort = {
    deliver: async ({ chatId }) => {
      sends.push({ chatId, at: Date.now() });
      if (sends.length === 12) drained();
      return { status: 'SENT' };
    },
  };
  const service = new NotificationsService(db as never, telegram);
  void (service as unknown as { processDeliveries: () => Promise<void> }).processDeliveries();

  await allSent;
  await service.onApplicationShutdown();
  assert.equal(sends.length, 12);
  for (let index = 1; index < sends.length; index++)
    assert.ok(sends[index].at - sends[index - 1].at >= 95, `send ${index} was not paced`);
  assert.equal(sends[0].chatId, sends[1].chatId);
  assert.ok(sends[1].at - sends[0].at >= 995, 'a chat received two messages within a second');
});
