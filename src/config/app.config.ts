import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');

function readNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readBoundedNumber(
  value: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value.trim() === '') return fallback;

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be a number between ${minimum} and ${maximum}`);
  }

  return parsed;
}

function readBoolean(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined || value.trim() === '') return fallback;

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(`${name} must be either true or false`);
}

function readString(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

function readList(value: string | undefined): string[] {
  return readString(value, '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function readOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function readTelegramConfig() {
  const enabled = readBoolean(process.env.TELEGRAM_ENABLED, false, 'TELEGRAM_ENABLED');
  const botToken = readOptionalString(process.env.TELEGRAM_BOT_TOKEN);
  const botUsername = readOptionalString(process.env.TELEGRAM_BOT_USERNAME)?.replace(/^@/, '');
  const webhookSecret = readOptionalString(process.env.TELEGRAM_WEBHOOK_SECRET);
  const webhookUrl = readOptionalString(process.env.TELEGRAM_WEBHOOK_URL);

  if (botUsername && !/^[A-Za-z0-9_]{5,32}$/.test(botUsername)) {
    throw new Error('TELEGRAM_BOT_USERNAME must be a valid Telegram bot username');
  }

  if (webhookSecret && !/^[A-Za-z0-9_-]{1,256}$/.test(webhookSecret)) {
    throw new Error('TELEGRAM_WEBHOOK_SECRET contains unsupported characters');
  }

  if (webhookUrl) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(webhookUrl);
    } catch {
      throw new Error('TELEGRAM_WEBHOOK_URL must be a valid URL');
    }
    if (parsedUrl.protocol !== 'https:') {
      throw new Error('TELEGRAM_WEBHOOK_URL must use HTTPS');
    }
  }

  if (enabled) {
    const missing = [
      ['TELEGRAM_BOT_TOKEN', botToken],
      ['TELEGRAM_BOT_USERNAME', botUsername],
      ['TELEGRAM_WEBHOOK_SECRET', webhookSecret],
      ['TELEGRAM_WEBHOOK_URL', webhookUrl],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name);

    if (missing.length > 0) {
      throw new Error(`Telegram is enabled but missing: ${missing.join(', ')}`);
    }
  }

  return {
    enabled,
    botToken,
    botUsername,
    webhookSecret,
    webhookUrl,
    geofenceRadiusMeters: readBoundedNumber(
      process.env.TELEGRAM_GEOFENCE_RADIUS_METERS,
      100,
      'TELEGRAM_GEOFENCE_RADIUS_METERS',
      10,
      1_000,
    ),
    geofenceTimeWindowMinutes: readBoundedNumber(
      process.env.TELEGRAM_GEOFENCE_TIME_WINDOW_MINUTES,
      15,
      'TELEGRAM_GEOFENCE_TIME_WINDOW_MINUTES',
      1,
      1_440,
    ),
  } as const;
}

export const appConfig = {
  rest: {
    port: readNumber(process.env.REST_PORT, 3000),
  },
  socket: {
    port: readNumber(process.env.SOCKET_PORT, 3001),
  },
  tcp: {
    host: readString(process.env.TCP_HOST, '0.0.0.0'),
    port: readNumber(process.env.TCP_PORT, 5023),
    publicHost: readString(process.env.PUBLIC_HOST, '127.0.0.1'),
  },
  cors: {
    origin: readString(process.env.CORS_ORIGIN, '*'),
  },
  devices: {
    /** A device is considered online if seen within this window */
    onlineThresholdMs: readNumber(process.env.ONLINE_THRESHOLD_MS, 180_000),
    /** Empty list accepts any IMEI */
    allowedImeis: readList(process.env.ALLOWED_IMEIS),
  },
  database: {
    url: readString(process.env.DATABASE_URL, ''),
  },
  telegram: readTelegramConfig(),
} as const;

export type AppConfig = typeof appConfig;
