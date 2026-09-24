import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  ServiceUnavailableException,
} from '@nestjs/common';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { BACKUP_CONFIG, BackupConfig } from './backup.config';
import { encryptBackupStream } from './backup.crypto';
import { GoogleDriveBackupClient } from './backup.drive';
import { BackupMail } from './backup.mail';

export interface BackupStatus {
  enabled: boolean;
  scheduleEnabled: boolean;
  running: boolean;
  lastStartedAt?: string;
  lastCompletedAt?: string;
  lastFileName?: string;
  lastSizeBytes?: number;
  lastDriveFileId?: string;
  lastError?: string;
}

@Injectable()
export class BackupService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(BackupService.name);
  private readonly drive: GoogleDriveBackupClient;
  private timer?: NodeJS.Timeout;
  private running?: Promise<BackupStatus>;
  private readonly state: BackupStatus;

  constructor(
    @Inject(BACKUP_CONFIG) private readonly config: BackupConfig,
    private readonly mail: BackupMail,
  ) {
    this.drive = new GoogleDriveBackupClient(config.google);
    this.state = {
      enabled: config.enabled,
      scheduleEnabled: config.scheduleEnabled,
      running: false,
    };
  }

  onApplicationBootstrap(): void {
    if (!this.config.enabled || !this.config.scheduleEnabled) return;
    this.timer = setInterval(() => {
      void this.start('scheduled').catch(error =>
        this.logger.error(`Scheduled backup failed: ${this.safeError(error)}`),
      );
    }, this.config.intervalMs);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  status(): BackupStatus {
    return { ...this.state };
  }

  runManual(): BackupStatus {
    if (!this.config.enabled) throw new ServiceUnavailableException('Backup service is disabled');
    if (this.running) throw new ConflictException('A backup is already running');
    void this.start('manual').catch(error =>
      this.logger.error(`Manual backup failed: ${this.safeError(error)}`),
    );
    return this.status();
  }

  private start(reason: 'manual' | 'scheduled'): Promise<BackupStatus> {
    if (this.running) return this.running;
    this.running = this.execute(reason).finally(() => {
      this.running = undefined;
      this.state.running = false;
    });
    return this.running;
  }

  private async execute(reason: 'manual' | 'scheduled'): Promise<BackupStatus> {
    this.state.running = true;
    this.state.lastStartedAt = new Date().toISOString();
    delete this.state.lastError;
    const workDir = await mkdtemp(join(tmpdir(), 'gps-tracker-backup-'));
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `gps-tracker-${timestamp}.dump.enc`;
    const encryptedPath = join(workDir, fileName);
    try {
      await this.dumpAndEncrypt(encryptedPath);
      const encryptedSize = (await stat(encryptedPath)).size;
      const driveFile = await this.drive.upload(
        encryptedPath,
        fileName,
        Math.min(this.config.timeoutMs, 60 * 60_000),
      );
      let retentionWarning: string | undefined;
      try {
        await this.drive.enforceRetention(this.config.retentionCount);
      } catch (error) {
        retentionWarning = this.safeError(error);
        this.logger.warn(`Backup retention failed: ${retentionWarning}`);
      }
      this.state.lastCompletedAt = new Date().toISOString();
      this.state.lastFileName = fileName;
      this.state.lastSizeBytes = encryptedSize;
      this.state.lastDriveFileId = driveFile.id;
      this.state.lastError = retentionWarning
        ? `Backup uploaded, but retention failed: ${retentionWarning}`
        : undefined;
      try {
        await this.mail.success(fileName, encryptedSize, driveFile.webViewLink);
      } catch (error) {
        this.state.lastError = `Backup uploaded, but notification failed: ${this.safeError(error)}`;
        this.logger.warn(this.state.lastError);
      }
      this.logger.log(`${reason} backup uploaded as ${fileName}`);
      return this.status();
    } catch (error) {
      const message = this.safeError(error);
      this.state.lastError = message;
      try {
        await this.mail.failure(message);
      } catch (mailError) {
        this.logger.warn(`Backup failure notification failed: ${this.safeError(mailError)}`);
      }
      throw error;
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  private async dumpAndEncrypt(destination: string): Promise<void> {
    const database = new URL(this.config.databaseUrl);
    const databaseName = database.pathname.replace(/^\//, '');
    const args = [
      '--format=custom',
      '--compress=6',
      '--no-password',
      '--host',
      database.hostname,
      '--port',
      database.port || '5432',
      '--username',
      decodeURIComponent(database.username),
      '--dbname',
      decodeURIComponent(databaseName),
    ];
    const sslMode = database.searchParams.get('sslmode');
    const child = spawn(this.config.pgDumpPath, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PGPASSWORD: decodeURIComponent(database.password),
        ...(sslMode ? { PGSSLMODE: sslMode } : {}),
      },
    });
    let stderr = '';
    child.stderr.on('data', chunk => {
      if (stderr.length < 16_384) stderr += String(chunk);
    });
    const exit = new Promise<void>((resolve, reject) => {
      child.once('error', error => {
        child.stdout.destroy(error);
        reject(error);
      });
      child.once('close', (code, signal) => {
        if (code === 0) resolve();
        else {
          const error = new Error(
            `pg_dump failed (${code ?? signal}): ${stderr.trim() || 'unknown error'}`,
          );
          child.stdout.destroy(error);
          reject(error);
        }
      });
    });
    const timeout = setTimeout(() => child.kill('SIGKILL'), this.config.timeoutMs);
    timeout.unref();
    try {
      await Promise.all([
        encryptBackupStream(
          child.stdout as Readable,
          destination,
          this.config.encryptionKey,
          this.config.maxBytes,
        ),
        exit,
      ]);
    } catch (error) {
      if (!child.killed) child.kill('SIGKILL');
      child.stdout.destroy();
      await exit.catch(() => undefined);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private safeError(error: unknown): string {
    const message = error instanceof Error ? error.message : 'Unknown backup error';
    return message.replace(/[\r\n]+/g, ' ').slice(0, 500);
  }
}
