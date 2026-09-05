import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');

function readNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
} as const;

export type AppConfig = typeof appConfig;
