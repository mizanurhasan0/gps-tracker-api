import { isEmail } from 'class-validator';

export interface RecoveryConfig {
  enabled: boolean;
  email: string;
  secret: string;
  smtp: { host: string; port: number; user: string; password: string; from: string };
}

export function readRecoveryConfig(env: NodeJS.ProcessEnv = process.env): RecoveryConfig {
  const flag = env.ADMIN_RECOVERY_ENABLED?.trim().toLowerCase() || 'false';
  if (!['true', 'false'].includes(flag))
    throw new Error('ADMIN_RECOVERY_ENABLED must be true or false');
  const config: RecoveryConfig = {
    enabled: flag === 'true',
    email: (env.ADMIN_RECOVERY_EMAIL || 'eng.mizanur.hasan@gmail.com').trim().toLowerCase(),
    secret: env.ADMIN_RECOVERY_SECRET?.trim() || '',
    smtp: {
      host: env.RECOVERY_SMTP_HOST?.trim() || 'smtp.gmail.com',
      port: Number(env.RECOVERY_SMTP_PORT || 465),
      user: env.RECOVERY_SMTP_USER?.trim() || '',
      password: env.RECOVERY_SMTP_PASSWORD || '',
      from: env.RECOVERY_SMTP_FROM?.trim() || env.RECOVERY_SMTP_USER?.trim() || '',
    },
  };
  if (!config.enabled) return config;
  if (!isEmail(config.email)) throw new Error('ADMIN_RECOVERY_EMAIL must be a valid email');
  if (!/^[a-f\d]{64}$/i.test(config.secret))
    throw new Error('ADMIN_RECOVERY_SECRET must contain 64 random hexadecimal characters');
  if (!config.smtp.host || /[\s/]/.test(config.smtp.host) || ![465, 587].includes(config.smtp.port))
    throw new Error('Recovery SMTP requires a hostname and TLS port 465 or STARTTLS port 587');
  if (!config.smtp.user || !config.smtp.password || !isEmail(config.smtp.from))
    throw new Error(
      'Recovery SMTP requires RECOVERY_SMTP_USER, RECOVERY_SMTP_PASSWORD and a valid sender',
    );
  return config;
}

export const RECOVERY_CONFIG = Symbol('RECOVERY_CONFIG');
export const RECOVERY_TTL_MS = 5 * 60_000;
export const RECOVERY_MAX_ATTEMPTS = 5;
