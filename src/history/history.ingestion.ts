import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import { HistoryRepository } from './history.repository';
import { parseGpsTime } from './history.math';
import type { HistoryEvent } from './history.types';
import type { PositionReport } from '../locations/locations.service';

@Injectable()
export class HistoryIngestion {
  private readonly offset: number;

  constructor(
    private readonly db: DatabaseService,
    private readonly repository: HistoryRepository,
  ) {
    this.offset = Number(process.env.GPS_TIMEZONE_OFFSET_MINUTES ?? 0);
    if (!Number.isInteger(this.offset) || Math.abs(this.offset) > 840)
      throw new Error('GPS_TIMEZONE_OFFSET_MINUTES must be an integer between -840 and 840');
  }

  /** Writes on the caller's shared PostgreSQL transaction; never acknowledges an in-memory queue. */
  async record(report: PositionReport, receivedAt: string): Promise<string | null> {
    const gpsTime = parseGpsTime(report.gpsTime, this.offset);
    const usableTime = gpsTime && Date.parse(gpsTime) <= Date.parse(receivedAt) + 5 * 60_000;
    const quality = !usableTime
      ? 'invalid-time'
      : report.gpsFixed === false
        ? 'invalid-fix'
        : 'valid';
    const vehicle = await this.db.get<{ id: string }>(
      'SELECT id FROM vehicles WHERE imei=$1',
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
    await this.repository.insert([event]);
    return quality === 'valid' ? gpsTime : null;
  }
}
