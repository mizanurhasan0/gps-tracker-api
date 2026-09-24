import { isEmail } from 'class-validator';

export interface BackupConfig {
  enabled: boolean;
  scheduleEnabled: boolean;
  intervalMs: number;
  databaseUrl: string;
  pgDumpPath: string;
  encryptionKey: Buffer;
  maxBytes: number;
  timeoutMs: number;
  retentionCount: number;
  recipient: string;
  smtp: {
    host: string;
    port: number;
    user: string;
    password: string;
    from: string;
  };
  google: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    folderId: string;
  };
}

function booleanValue(value: string | undefined, fallback: boolean, name: string): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return fallback;
  if (!['true', 'false'].includes(normalized)) throw new Error(`${name} must be true or false`);
  return normalized === 'true';
}

function integerValue(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  return parsed;
}

export function readBackupConfig(env: NodeJS.ProcessEnv = process.env): BackupConfig {
  const enabled = booleanValue(env.BACKUP_ENABLED, false, 'BACKUP_ENABLED');
  const scheduleEnabled = booleanValue(
    env.BACKUP_SCHEDULE_ENABLED,
    false,
    'BACKUP_SCHEDULE_ENABLED',
  );
  const encryptionHex = env.BACKUP_ENCRYPTION_KEY?.trim() || '';
  const smtpUser = env.BACKUP_SMTP_USER?.trim() || '';
  const config: BackupConfig = {
    enabled,
    scheduleEnabled,
    intervalMs:
      integerValue(env.BACKUP_INTERVAL_HOURS, 24, 1, 24 * 30, 'BACKUP_INTERVAL_HOURS') *
      60 *
      60_000,
    databaseUrl: env.DATABASE_URL?.trim() || '',
    pgDumpPath: env.BACKUP_PG_DUMP_PATH?.trim() || 'pg_dump',
    encryptionKey: /^[a-f\d]{64}$/i.test(encryptionHex)
      ? Buffer.from(encryptionHex, 'hex')
      : Buffer.alloc(0),
    maxBytes:
      integerValue(env.BACKUP_MAX_MIB, 512, 1, 10_240, 'BACKUP_MAX_MIB') * 1024 * 1024,
    timeoutMs:
      integerValue(env.BACKUP_TIMEOUT_MINUTES, 20, 1, 180, 'BACKUP_TIMEOUT_MINUTES') * 60_000,
    retentionCount: integerValue(env.BACKUP_RETENTION_COUNT, 30, 1, 365, 'BACKUP_RETENTION_COUNT'),
    recipient: env.BACKUP_EMAIL?.trim().toLowerCase() || '',
    smtp: {
      host: env.BACKUP_SMTP_HOST?.trim() || 'smtp.gmail.com',
      port: integerValue(env.BACKUP_SMTP_PORT, 465, 1, 65_535, 'BACKUP_SMTP_PORT'),
      user: smtpUser,
      password: env.BACKUP_SMTP_PASSWORD || '',
      from: env.BACKUP_SMTP_FROM?.trim() || smtpUser,
    },
    google: {
      clientId: env.GOOGLE_CLIENT_ID?.trim() || '',
      clientSecret: env.GOOGLE_CLIENT_SECRET?.trim() || '',
      refreshToken: env.GOOGLE_REFRESH_TOKEN?.trim() || '',
      folderId: env.GOOGLE_DRIVE_FOLDER_ID?.trim() || '',
    },
  };
  if (!enabled && !scheduleEnabled) return config;
  if (!enabled) throw new Error('BACKUP_ENABLED must be true when scheduling is enabled');
  if (!config.databaseUrl) throw new Error('DATABASE_URL is required for backups');
  try {
    const database = new URL(config.databaseUrl);
    if (!['postgres:', 'postgresql:'].includes(database.protocol) || !database.hostname)
      throw new Error();
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL');
  }
  if (config.encryptionKey.length !== 32)
    throw new Error('BACKUP_ENCRYPTION_KEY must contain 64 random hexadecimal characters');
  if (!config.pgDumpPath || /[\r\n\0]/.test(config.pgDumpPath))
    throw new Error('BACKUP_PG_DUMP_PATH is invalid');
  if (!isEmail(config.recipient)) throw new Error('BACKUP_EMAIL must be a valid email');
  if (
    !config.smtp.host ||
    /[\s/]/.test(config.smtp.host) ||
    ![465, 587].includes(config.smtp.port) ||
    !config.smtp.user ||
    !config.smtp.password ||
    !isEmail(config.smtp.from)
  )
    throw new Error(
      'Backup SMTP requires BACKUP_SMTP_USER, BACKUP_SMTP_PASSWORD, a valid sender, and TLS port 465 or 587',
    );
  if (
    !config.google.clientId ||
    !config.google.clientSecret ||
    !config.google.refreshToken ||
    !/^[A-Za-z0-9_-]{10,}$/.test(config.google.folderId)
  )
    throw new Error('Google Drive OAuth credentials and a valid folder ID are required');
  return config;
}

export const BACKUP_CONFIG = Symbol('BACKUP_CONFIG');
