import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import type { HistoryEvent, HistoryPoint, HistoryRange } from './history.types';

const COLUMNS = `id::text, imei, vehicle_id AS "vehicleId", latitude, longitude, speed, course,
 to_char(gps_time AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "gpsTime",
 to_char(received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "receivedAt"`;

@Injectable()
export class HistoryRepository {
  constructor(private readonly db: DatabaseService) {}

  async ensureReady(): Promise<void> {
    await this.db.ensureReady();
  }

  async insert(events: HistoryEvent[]): Promise<void> {
    await this.db.transaction(async () => {
      // Allocate IDs in commit order so paginated high-water snapshots stay stable.
      await this.db.run('SELECT pg_advisory_xact_lock(74523002)');
      for (const event of events) {
        await this.db.run(
          `INSERT INTO gps_history(event_key,imei,vehicle_id,gps_time,received_at,latitude,longitude,speed,course,protocol,fix_status,quality,raw_gps_time)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(event_key) DO NOTHING`,
          event.key,
          event.imei,
          event.vehicleId,
          event.quality === 'invalid-time' ? null : event.gpsTime,
          event.receivedAt,
          event.latitude,
          event.longitude,
          event.speed,
          event.course,
          event.protocol,
          event.fixStatus,
          event.quality,
          event.rawGpsTime
        );
      }
    });
  }

  async snapshot(): Promise<string> {
    return (await this.db.get<{ id: string }>(
      'SELECT COALESCE(MAX(id),0)::text AS id FROM gps_history'
    ))!.id;
  }

  async points(
    range: HistoryRange,
    snapshot: string,
    limit: number,
    after?: { time: string; id: string }
  ): Promise<HistoryPoint[]> {
    const params: unknown[] = [
      range.imei,
      range.from,
      range.to,
      snapshot,
      limit,
    ];
    let cursor = '';
    if (after) {
      params.push(after.time, after.id);
      cursor = 'AND (gps_time,id) > ($6::timestamptz,$7::bigint)';
    }
    return this.db.all<HistoryPoint>(
      `SELECT ${COLUMNS} FROM gps_history WHERE imei=$1 AND gps_time >= $2 AND gps_time < $3 AND id <= $4 AND quality='valid' ${cursor} ORDER BY gps_time,id LIMIT $5`,
      ...params
    );
  }

  async count(range: HistoryRange, snapshot: string): Promise<number> {
    const row = await this.db.get<{ count: string }>(
      `SELECT count(*)::text AS count FROM gps_history WHERE imei=$1 AND gps_time >= $2 AND gps_time < $3 AND id <= $4 AND quality='valid'`,
      range.imei,
      range.from,
      range.to,
      snapshot
    );
    return Number(row!.count);
  }
}
