import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, test } from 'node:test';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthService } from '../src/auth/auth.service';
import { AuthGuard } from '../src/auth/auth.guard';
import { appConfig } from '../src/config/app.config';
import { TelegramController } from '../src/telegram/telegram.controller';
import { TelegramService } from '../src/telegram/telegram.service';

interface MutationResult {
  rowCount: number;
}

class TelegramDatabaseStub {
  readonly calls: { sql: string; params: unknown[] }[] = [];
  readonly insertedTokens: string[] = [];
  private readonly processedUpdates = new Set<number>();
  private token?: { guardianId: string; expiresAt: string };
  private tokenUsed = false;
  private connectionInserted = false;

  setLinkToken(guardianId: string): void {
    this.token = {
      guardianId,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
  }

  async exec(_sql: string): Promise<void> {}

  async transaction<T>(work: () => Promise<T>): Promise<T> {
    return work();
  }

  async get<T = Record<string, unknown>>(
    sql: string,
    ...params: unknown[]
  ): Promise<T | undefined> {
    this.calls.push({ sql, params });
    if (sql.includes('FROM telegram_link_tokens')) {
      return (this.token && !this.tokenUsed ? this.token : undefined) as T | undefined;
    }
    return undefined;
  }

  async run(sql: string, ...params: unknown[]): Promise<MutationResult> {
    this.calls.push({ sql, params });
    if (sql.includes('INSERT INTO telegram_webhook_updates')) {
      const updateId = Number(params[0]);
      if (this.processedUpdates.has(updateId)) return { rowCount: 0 };
      this.processedUpdates.add(updateId);
      return { rowCount: 1 };
    }
    if (sql.includes('INSERT INTO telegram_link_tokens')) {
      this.insertedTokens.push(String(params[1]));
      return { rowCount: 1 };
    }
    if (sql.includes('UPDATE telegram_link_tokens')) {
      if (this.tokenUsed) return { rowCount: 0 };
      this.tokenUsed = true;
      return { rowCount: 1 };
    }
    if (sql.includes('INSERT INTO telegram_connections')) {
      if (this.connectionInserted) return { rowCount: 0 };
      this.connectionInserted = true;
      return { rowCount: 1 };
    }
    return { rowCount: 1 };
  }
}

function configureTelegramEnvironment(): Record<string, string | undefined> {
  const keys = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_USERNAME', 'TELEGRAM_API_BASE_URL'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.TELEGRAM_BOT_TOKEN = '123456:unit-test-token';
  process.env.TELEGRAM_BOT_USERNAME = 'test_vehicle_bot';
  process.env.TELEGRAM_API_BASE_URL = 'https://telegram.test';
  Object.assign(appConfig.telegram as unknown as Record<string, unknown>, {
    enabled: true,
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    botUsername: process.env.TELEGRAM_BOT_USERNAME,
    pollingTimeoutSeconds: 1,
  });
  return previous;
}

function restoreEnvironment(previous: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function telegramDb(): TelegramDatabaseStub {
  return new TelegramDatabaseStub();
}

const previousTelegramConfig = { ...appConfig.telegram };
const previousTelegramEnvironment = configureTelegramEnvironment();
const previousFetch = globalThis.fetch;
after(() => {
  restoreEnvironment(previousTelegramEnvironment);
  Object.assign(appConfig.telegram as unknown as Record<string, unknown>, previousTelegramConfig);
  globalThis.fetch = previousFetch;
});

test('Telegram connect links store only a digest of the one-time token', async () => {
  const db = telegramDb();
  const service = new TelegramService(db as never);

  const result = await service.issueConnectLink('guardian-1');
  const rawToken = decodeURIComponent(result.url.split('?start=')[1]).replace(/^connect_/, '');

  assert.match(result.url, /^https:\/\/t\.me\/test_vehicle_bot\?start=connect_/);
  assert.equal(db.insertedTokens.length, 1);
  assert.equal(db.insertedTokens[0], createHash('sha256').update(rawToken).digest('hex'));
  assert.notEqual(db.insertedTokens[0], rawToken);
  assert.ok(Date.parse(result.expiresAt) > Date.now());
});

test('Telegram polling processes each update id once', async () => {
  let sentMessages = 0;
  globalThis.fetch = async () => {
    sentMessages += 1;
    return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const db = telegramDb();
  db.setLinkToken('guardian-1');
  const service = new TelegramService(db as never);
  const update = {
    update_id: 9001,
    message: {
      chat: { id: 88001, type: 'private', username: 'guardian', first_name: 'Guardian' },
      text: '/start connect_valid-token',
    },
  };

  const first = await service.handleUpdate(update);
  const duplicate = await service.handleUpdate(update);

  assert.deepEqual(first, { handled: true });
  assert.deepEqual(duplicate, { handled: false });
  assert.equal(db.calls.filter(({ sql }) => sql.includes('telegram_connections')).length, 1);
  assert.equal(sentMessages, 1);
});

test('Telegram long polling removes webhooks and requests message updates', async () => {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = async (input, init) => {
    const method = String(input).split('/').at(-1)!;
    calls.push({
      method,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return new Response(JSON.stringify({ ok: true, result: method === 'getUpdates' ? [] : true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const service = new TelegramService(telegramDb() as never);
  const controller = new AbortController();
  await service.deleteWebhook(controller.signal);
  assert.deepEqual(await service.getUpdates(9002, 1, controller.signal), []);

  assert.deepEqual(calls, [
    { method: 'deleteWebhook', body: { drop_pending_updates: false } },
    {
      method: 'getUpdates',
      body: { offset: 9002, timeout: 1, allowed_updates: ['message'] },
    },
  ]);
});

test('Telegram guardian endpoints require the GUARDIAN role', async () => {
  assert.deepEqual(Reflect.getMetadata('roles', TelegramController.prototype.connect), [
    'GUARDIAN',
  ]);
  assert.deepEqual(Reflect.getMetadata('roles', TelegramController.prototype.status), ['GUARDIAN']);
  assert.deepEqual(Reflect.getMetadata('roles', TelegramController.prototype.disconnect), [
    'GUARDIAN',
  ]);

  const adminAuth = {
    authenticate: async () => ({
      id: 'admin',
      name: 'Admin',
      phone: '1',
      role: 'ADMIN',
      verified: 1,
      createdAt: '',
    }),
  } as unknown as AuthService;
  const guardianAuth = {
    authenticate: async () => ({
      id: 'guardian',
      name: 'Guardian',
      phone: '2',
      role: 'GUARDIAN',
      verified: 1,
      createdAt: '',
    }),
  } as unknown as AuthService;
  const reflector = new Reflector();
  const context = (handler: (...args: never[]) => unknown, authHeader: string): ExecutionContext =>
    ({
      getType: () => 'http',
      getHandler: () => handler,
      getClass: () => TelegramController,
      switchToHttp: () => ({ getRequest: () => ({ headers: { authorization: authHeader } }) }),
    }) as unknown as ExecutionContext;

  const adminGuard = new AuthGuard(adminAuth, reflector);
  await assert.rejects(
    adminGuard.canActivate(context(TelegramController.prototype.connect, 'Bearer admin-token')),
    ForbiddenException,
  );
  const guardianGuard = new AuthGuard(guardianAuth, reflector);
  assert.equal(
    await guardianGuard.canActivate(
      context(TelegramController.prototype.connect, 'Bearer guardian-token'),
    ),
    true,
  );
});

test('queued Telegram delivery rechecks the connected chat before sending', async () => {
  let connected = false;
  let sends = 0;
  const message = {
    notificationId: 'notification-1',
    userId: 'guardian-1',
    chatId: '88001',
    title: 'Pickup alert',
    body: 'The bus is nearby.',
  };
  const service = new TelegramService({
    get: async (_sql: string, ...params: unknown[]) => {
      assert.deepEqual(params, [message.userId, message.chatId]);
      return connected ? { chatId: message.chatId } : undefined;
    },
  } as never);
  globalThis.fetch = async (_url, options) => {
    sends++;
    assert.deepEqual(JSON.parse(String(options?.body)), {
      chat_id: message.chatId,
      text: `${message.title}\n\n${message.body}`,
    });
    return Response.json({ ok: true, result: { message_id: 7 } });
  };
  assert.equal((await service.deliver(message)).status, 'SKIPPED');
  assert.equal(sends, 0);
  connected = true;
  assert.deepEqual(await service.deliver(message), { status: 'SENT', providerMessageId: '7' });
  assert.equal(sends, 1);
  connected = false;
  assert.equal((await service.deliver(message)).status, 'SKIPPED');
  assert.equal(sends, 1);
});

test('Telegram delivery skips permanent recipient failures and retries provider outages', async () => {
  const service = new TelegramService({ get: async () => ({ chatId: '88001' }) } as never);
  const message = {
    notificationId: 'notification-1',
    userId: 'guardian-1',
    chatId: '88001',
    title: 'Alert',
    body: 'Nearby',
  };
  globalThis.fetch = async () =>
    Response.json({ ok: false, description: 'Bot blocked' }, { status: 403 });
  assert.equal((await service.deliver(message)).status, 'SKIPPED');
  globalThis.fetch = async () =>
    Response.json({ ok: false, description: 'Unavailable' }, { status: 503 });
  assert.equal((await service.deliver(message)).status, 'RETRY');
});
