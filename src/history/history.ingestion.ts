import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import { HistoryRepository } from './history.repository';
import { parseGpsTime } from './history.math';
import type { HistoryEvent } from './history.types';
import type { PositionReport } from '../locations/locations.service';

@Injectable()
export class HistoryIngestion implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HistoryIngestion.name);
  private timer?: ReturnType<typeof setInterval>;
  private draining?: Promise<void>;
  private stopped = false;
  private lastWarning = 0;
  private readonly offset: number;

  constructor(
    private readonly db: DatabaseService,
    private readonly repository: HistoryRepository,
  ) {
    this.offset = Number(process.env.GPS_TIMEZONE_OFFSET_MINUTES ?? 0);
    if (!Number.isInteger(this.offset) || Math.abs(this.offset) > 840)
      throw new Error(
        'GPS_TIMEZONE_OFFSET_MINUTES must be an integer between -840 and 840',
      );
    // FULL makes locally acknowledged history durable across OS/power failures.
    this.db.exec(`PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS gps_history_outbox (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, eventKey TEXT NOT NULL UNIQUE,
        imei TEXT NOT NULL, gpsTime TEXT, receivedAt TEXT NOT NULL, payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS gps_outbox_device_time ON gps_history_outbox(imei,gpsTime);
    `);
  }

  onModuleInit(): void {
    this.timer = setInterval(() => void this.flush(), 1000);
    this.timer.unref();
    void this.flush();
  }

  enqueue(report: PositionReport, receivedAt: string): string | null {
    const gpsTime = parseGpsTime(report.gpsTime, this.offset);
    const usableTime =
      gpsTime && Date.parse(gpsTime) <= Date.parse(receivedAt) + 5 * 60_000;
    const quality = !usableTime
      ? 'invalid-time'
      : report.gpsFixed === false
      ? 'invalid-fix'
      : 'valid';
    const vehicle = this.db.get<{ id: string }>(
      'SELECT id FROM vehicles WHERE imei=?',
      report.imei,
    );
    const key = createHash('sha256')
      .update(
        JSON.stringify([
          report.imei,
          report.gpsTime,
          report.latitude,
          report.longitude,
          report.speed,
          report.course,
          report.protocol ?? null,
          report.status ?? null,
        ]),
      )
      .digest('hex');
    const event: HistoryEvent = {
      key,
      imei: report.imei,
      vehicleId: vehicle?.id ?? null,
      latitude: report.latitude,
      longitude: report.longitude,
      speed: report.speed,
      course: report.course,
      gpsTime: gpsTime ?? receivedAt,
      receivedAt,
      protocol: report.protocol ?? null,
      fixStatus: report.status ?? null,
      quality,
      rawGpsTime: report.gpsTime,
    };
    this.db.run(
      'INSERT OR IGNORE INTO gps_history_outbox(eventKey,imei,gpsTime,receivedAt,payload) VALUES(?,?,?,?,?)',
      key,
      report.imei,
      quality === 'valid' ? gpsTime : null,
      receivedAt,
      JSON.stringify(event),
    );
    return quality === 'valid' ? gpsTime : null;
  }

  freshness(imei: string, from: string, to: string) {
    const row = this.db.get<{
      pendingPoints: number;
      oldestPendingAt: string | null;
    }>(
      `SELECT COUNT(*) AS pendingPoints,MIN(receivedAt) AS oldestPendingAt FROM gps_history_outbox WHERE imei=? AND gpsTime >= ? AND gpsTime < ?`,
      imei,
      from,
      to,
    )!;
    return { ...row, complete: row.pendingPoints === 0 };
  }

  flush(): Promise<void> {
    if (this.draining) return this.draining;
    if (this.stopped) return Promise.resolve();
    this.draining = this.drainBatch().finally(() => {
      this.draining = undefined;
    });
    return this.draining;
  }

  private async drainBatch(): Promise<void> {
    try {
      const rows = this.db.all<{ sequence: number; payload: string }>(
        'SELECT sequence,payload FROM gps_history_outbox ORDER BY sequence LIMIT 250',
      );
      if (!rows.length) return;
      await this.repository.insert(
        rows.map(row => JSON.parse(row.payload) as HistoryEvent),
      );
      this.db.transaction(() => {
        for (const row of rows)
          this.db.run(
            'DELETE FROM gps_history_outbox WHERE sequence=?',
            row.sequence,
          );
      });
    } catch {
      if (Date.now() - this.lastWarning > 60_000) {
        this.lastWarning = Date.now();
        this.logger.warn(
          'GPS history delivery delayed; samples remain in durable SQLite outbox',
        );
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.draining;
    // Pending records remain durable for next startup; never block shutdown indefinitely.
  }
}
