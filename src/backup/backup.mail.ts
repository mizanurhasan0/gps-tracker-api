import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import nodemailer, { Transporter } from 'nodemailer';
import { BACKUP_CONFIG, BackupConfig } from './backup.config';

@Injectable()
export class BackupMail implements OnApplicationShutdown {
  private readonly transport?: Transporter;

  constructor(@Inject(BACKUP_CONFIG) private readonly config: BackupConfig) {
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
      socketTimeout: 15_000,
      disableFileAccess: true,
      disableUrlAccess: true,
      logger: false,
      debug: false,
    });
  }

  async success(name: string, bytes: number, link?: string): Promise<void> {
    await this.send(
      'GPS Tracker backup completed',
      [
        'The encrypted database backup completed successfully.',
        `File: ${name}`,
        `Encrypted size: ${bytes} bytes`,
        link ? `Google Drive: ${link}` : undefined,
        '',
        'Keep BACKUP_ENCRYPTION_KEY safe; this backup cannot be restored without it.',
      ]
        .filter(value => value !== undefined)
        .join('\n'),
    );
  }

  async failure(message: string): Promise<void> {
    await this.send(
      'GPS Tracker backup failed',
      `The database backup failed at ${new Date().toISOString()}.\nReason: ${message}`,
    );
  }

  private async send(subject: string, text: string): Promise<void> {
    if (!this.transport) throw new Error('Backup email is unavailable');
    const result = await this.transport.sendMail({
      from: this.config.smtp.from,
      to: this.config.recipient,
      subject,
      text,
    });
    if (!result.accepted?.length) throw new Error('Backup notification email was not accepted');
  }

  onApplicationShutdown(): void {
    this.transport?.close();
  }
}
