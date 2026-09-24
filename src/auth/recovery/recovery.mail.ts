import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import nodemailer, { Transporter } from 'nodemailer';
import { RECOVERY_CONFIG, RecoveryConfig } from './recovery.config';

export const RECOVERY_MAIL = Symbol('RECOVERY_MAIL');
export interface RecoveryMail {
  send(to: string, subject: string, text: string, id: string): Promise<void>;
}

@Injectable()
export class SmtpRecoveryMail implements RecoveryMail, OnApplicationShutdown {
  private readonly transport?: Transporter;

  constructor(@Inject(RECOVERY_CONFIG) private readonly config: RecoveryConfig) {
    if (!config.enabled) return;
    this.transport = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      requireTLS: config.smtp.port === 587,
      auth: { user: config.smtp.user, pass: config.smtp.password },
      tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
      connectionTimeout: 5_000,
      greetingTimeout: 10_000,
      socketTimeout: 10_000,
      disableFileAccess: true,
      disableUrlAccess: true,
      logger: false,
      debug: false,
    });
  }

  async send(to: string, subject: string, text: string, id: string): Promise<void> {
    if (!this.transport || to !== this.config.email)
      throw new Error('Recovery delivery is unavailable');
    const result = await this.transport.sendMail({
      from: this.config.smtp.from,
      to,
      subject,
      text,
      messageId: `<admin-recovery-${id}@${this.config.smtp.from.split('@')[1]}>`,
    });
    if (!result.accepted?.length) throw new Error('Recovery email was not accepted');
  }

  onApplicationShutdown(): void {
    this.transport?.close();
  }
}
