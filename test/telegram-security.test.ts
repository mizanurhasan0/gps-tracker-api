import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, test } from 'node:test';
import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthService } from '../src/auth/auth.service';
import { AuthGuard } from '../src/auth/auth.guard';
import { appConfig } from '../src/config/app.config';
import { TelegramController } from '../src/telegram/telegram.controller';
import { TelegramService } from '../src/telegram/telegram.service';

interface MutationResult {
  rowCount: number;
  changes: number;
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
      if (this.processedUpdates.has(updateId)) return { rowCount: 0, changes: 0 };
      this.processedUpdates.add(updateId);
      return { rowCount: 1, changes: 1 };
    }
    if (sql.includes('INSERT INTO telegram_link_tokens')) {
      this.insertedTokens.push(String(params[1]));
      return { rowCount: 1, changes: 1 };
    }
    if (sql.includes('UPDATE telegram_link_tokens')) {
      if (this.tokenUsed) return { rowCount: 0, changes: 0 };
      this.tokenUsed = true;
      return { rowCount: 1, changes: 1 };
    }
    if (sql.includes('INSERT INTO telegram_connections')) {
      if (this.connectionInserted) return { rowCount: 0, changes: 0 };
      this.connectionInserted = true;
      return { rowCount: 1, changes: 1 };
    }
    return { rowCount: 1, changes: 1 };
  }
}

function configureTelegramEnvironment(): Record<string, string | undefined> {
  const keys = [
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_BOT_USERNAME',
    'TELEGRAM_WEBHOOK_SECRET',
    'TELEGRAM_API_BASE_URL',
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.TELEGRAM_BOT_TOKEN = '123456:unit-test-token';
  process.env.TELEGRAM_BOT_USERNAME = 'test_vehicle_bot';
  process.env.TELEGRAM_WEBHOOK_SECRET = 'unit-test-secret';
  process.env.TELEGRAM_API_BASE_URL = 'https://telegram.test';
  Object.assign(appConfig.telegram as unknown as Record<string, unknown>, {
    enabled: true,
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    botUsername: process.env.TELEGRAM_BOT_USERNAME,
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET,
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

test('Telegram webhook secret rejects missing and incorrect secrets', () => {
  const service = new TelegramService(telegramDb() as never);
  assert.throws(() => service.verifyWebhookSecret(undefined), UnauthorizedException);
  assert.throws(() => service.verifyWebhookSecret('wrong-secret'), UnauthorizedException);
  assert.doesNotThrow(() => service.verifyWebhookSecret('unit-test-secret'));
});

test('Telegram webhook processes each update id once', async () => {
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

  const first = await service.handleWebhook(update);
  const duplicate = await service.handleWebhook(update);

  assert.deepEqual(first, { ok: true, handled: true });
  assert.deepEqual(duplicate, { ok: true, handled: false });
  assert.equal(db.calls.filter(({ sql }) => sql.includes('telegram_connections')).length, 1);
  assert.equal(sentMessages, 1);
});

test('Telegram guardian endpoints require the GUARDIAN role and webhook is public', async () => {
  assert.deepEqual(Reflect.getMetadata('roles', TelegramController.prototype.connect), ['GUARDIAN']);
  assert.deepEqual(Reflect.getMetadata('roles', TelegramController.prototype.status), ['GUARDIAN']);
  assert.deepEqual(Reflect.getMetadata('roles', TelegramController.prototype.disconnect), ['GUARDIAN']);
  assert.equal(Reflect.getMetadata('public', TelegramController.prototype.webhook), true);

  const adminAuth = {
    authenticate: async () => ({ id: 'admin', name: 'Admin', phone: '1', role: 'ADMIN', verified: 1, createdAt: '' }),
  } as unknown as AuthService;
  const guardianAuth = {
    authenticate: async () => ({ id: 'guardian', name: 'Guardian', phone: '2', role: 'GUARDIAN', verified: 1, createdAt: '' }),
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
    await guardianGuard.canActivate(context(TelegramController.prototype.connect, 'Bearer guardian-token')),
    true,
  );
});
