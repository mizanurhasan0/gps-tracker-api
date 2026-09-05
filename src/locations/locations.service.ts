import { Injectable } from '@nestjs/common';
import { appConfig } from '../config/app.config';
import { DatabaseService } from '../database/database.service';
import { HistoryIngestion } from '../history/history.ingestion';
import { parseGpsTime } from '../history/history.math';
import { isValidCoordinates, normalizeCoordinates } from './coordinates';
import type {
  DeviceLocation,
  DeviceRecord,
  DeviceStatus,
} from './location.types';

export interface PositionReport {
  imei: string;
  latitude: number;
  longitude: number;
  speed: number;
  course: number;
  gpsTime: string;
  protocol?: number;
  status?: number;
  gpsFixed?: boolean;
}

export interface StatusReport {
  gsmSignal?: number;
  voltageLevel?: number;
}

@Injectable()
export class LocationsService {
  constructor(
    private readonly history: HistoryIngestion,
    private readonly db: DatabaseService
  ) {}

  /** Persist modem contact using the same database as business data and history. */
  async touch(imei: string, status: StatusReport = {}): Promise<DeviceRecord> {
    return this.db.transaction(async () => {
      const existing = await this.lockRecord(imei);
      const record: DeviceRecord = {
        ...existing,
        imei,
        lastSeen: new Date().toISOString(),
        gsmSignal: status.gsmSignal ?? existing?.gsmSignal,
        voltageLevel: status.voltageLevel ?? existing?.voltageLevel,
      };
      await this.persist(record);
      return record;
    });
  }

  /** History and latest fix commit atomically before the tracker receives its ACK. */
  async savePosition(report: PositionReport): Promise<DeviceLocation> {
    if (!isValidCoordinates(report.latitude, report.longitude))
      return this.toLocation(await this.touch(report.imei));
    const { latitude, longitude } =
      report.protocol !== undefined
        ? report
        : normalizeCoordinates(report.latitude, report.longitude);
    const receivedAt = new Date().toISOString();
    return this.db.transaction(async () => {
      const existing = await this.lockRecord(report.imei);
      const gpsTime = await this.history.record(
        { ...report, latitude, longitude },
        receivedAt
      );
      const previous = existing?.position;
      const previousTime = previous
        ? parseGpsTime(
            previous.gpsTime,
            Number(process.env.GPS_TIMEZONE_OFFSET_MINUTES ?? 0)
          )
        : null;
      const record: DeviceRecord = {
        ...existing,
        imei: report.imei,
        lastSeen: receivedAt,
      };
      // Invalid, delayed and retransmitted fixes must not refresh or regress the latest position.
      if (gpsTime && (!previousTime || gpsTime > previousTime)) {
        record.position = {
          latitude,
          longitude,
          speed: report.speed,
          course: report.course,
          gpsTime,
          receivedAt,
        };
      }
      await this.persist(record);
      return this.toLocation(record);
    });
  }

  async findAll(): Promise<DeviceLocation[]> {
    const rows = await this.db.all<{ record: DeviceRecord }>(
      'SELECT record FROM devices ORDER BY imei'
    );
    return rows.map((row) => this.toLocation(row.record));
  }

  async findByImei(imei: string): Promise<DeviceLocation | null> {
    const row = await this.db.get<{ record: DeviceRecord }>(
      'SELECT record FROM devices WHERE imei=$1',
      imei
    );
    return row ? this.toLocation(row.record) : null;
  }

  private async lockRecord(imei: string): Promise<DeviceRecord | undefined> {
    // Also serializes first contact where no row exists yet, across API processes.
    await this.db.run(
      'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      imei
    );
    return (
      await this.db.get<{ record: DeviceRecord }>(
        'SELECT record FROM devices WHERE imei=$1 FOR UPDATE',
        imei
      )
    )?.record;
  }

  private async persist(record: DeviceRecord): Promise<void> {
    await this.db.run(
      `INSERT INTO devices(imei,record) VALUES($1,$2::jsonb)
      ON CONFLICT(imei) DO UPDATE SET record=EXCLUDED.record`,
      record.imei,
      JSON.stringify(record)
    );
  }

  private toLocation(record: DeviceRecord): DeviceLocation {
    const { onlineThresholdMs } = appConfig.devices;
    const now = Date.now();

    const online = now - Date.parse(record.lastSeen) < onlineThresholdMs;
    const position = record.position;
    const fixIsRecent = position
      ? now - Date.parse(position.receivedAt) < onlineThresholdMs
      : false;

    const status: DeviceStatus = !online
      ? 'offline'
      : !position
      ? 'waiting'
      : fixIsRecent
      ? 'live'
      : 'lastKnown';

    return {
      imei: record.imei,
      status,
      online,
      lastSeen: record.lastSeen,
      gsmSignal: record.gsmSignal,
      voltageLevel: record.voltageLevel,
      hasFix: Boolean(position),
      latitude: position?.latitude,
      longitude: position?.longitude,
      speed: position?.speed,
      course: position?.course,
      gpsTime: position?.gpsTime,
      positionAt: position?.receivedAt,
    };
  }
}
