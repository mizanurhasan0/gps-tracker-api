import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import type { HistoryEvent, HistoryPoint, HistoryRange } from './history.types';

const MIGRATION = `
CREATE TABLE IF NOT EXISTS gps_history_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS gps_history (
 id bigserial PRIMARY KEY, event_key text NOT NULL UNIQUE, imei text NOT NULL,
 vehicle_id text, gps_time timestamptz, received_at timestamptz NOT NULL,
 latitude double precision NOT NULL CHECK(latitude BETWEEN -90 AND 90),
 longitude double precision NOT NULL CHECK(longitude BETWEEN -180 AND 180),
 speed double precision NOT NULL, course double precision NOT NULL,
 protocol integer, fix_status integer, quality text NOT NULL,
 raw_gps_time text NOT NULL
);
CREATE INDEX IF NOT EXISTS gps_history_device_time ON gps_history(imei,gps_time,id) WHERE quality='valid';
INSERT INTO gps_history_migrations(version) VALUES(1) ON CONFLICT DO NOTHING;
`;
const COLUMNS = `id::text, imei, vehicle_id AS "vehicleId", latitude, longitude, speed, course,
 to_char(gps_time AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "gpsTime",
 to_char(received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "receivedAt"`;

@Injectable()
export class HistoryRepository implements OnModuleDestroy {
  private readonly logger = new Logger(HistoryRepository.name);
  private readonly pool: Pool | null;
  private ready?: Promise<void>;

  constructor() {
    const url = process.env.DATABASE_URL?.trim();
    if (url && !/^postgres(?:ql)?:\/\//.test(url))
      throw new Error('DATABASE_URL must be a PostgreSQL connection URL');
    this.pool = url
      ? new Pool({
          connectionString: url,
          max: 4,
          connectionTimeoutMillis: 3000,
          idleTimeoutMillis: 10000,
          statement_timeout: 10000,
          query_timeout: 12000,
        })
      : null;
    this.pool?.on('error', () =>
      this.logger.error(
        'PostgreSQL history connection failed; durable outbox retained',
      ),
    );
  }

  async ensureReady(): Promise<void> {
    if (!this.pool) throw new Error('PostgreSQL history is not configured');
    if (!this.ready)
      this.ready = this.migrate().catch(error => {
        this.ready = undefined;
        throw error;
      });
    return this.ready;
  }

  private async migrate(): Promise<void> {
    const client = await this.pool!.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(74523001)');
      await client.query(MIGRATION);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async insert(events: HistoryEvent[]): Promise<void> {
    await this.ensureReady();
    const client = await this.pool!.connect();
    try {
      await client.query('BEGIN');
      // All writers use this lock before allocating IDs: committed high-water IDs
      // are safe pagination snapshots, including across multiple API processes.
      await client.query('SELECT pg_advisory_xact_lock(74523002)');
      for (const event of events)
        await client.query(
          `INSERT INTO gps_history(event_key,imei,vehicle_id,gps_time,received_at,latitude,longitude,speed,course,protocol,fix_status,quality,raw_gps_time)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(event_key) DO NOTHING`,
          [
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
            event.rawGpsTime,
          ],
        );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async snapshot(): Promise<string> {
    await this.ensureReady();
    const result = await this.pool!.query<{ id: string }>(
      'SELECT COALESCE(MAX(id),0)::text AS id FROM gps_history',
    );
    return result.rows[0].id;
  }

  async points(
    range: HistoryRange,
    snapshot: string,
    limit: number,
    after?: { time: string; id: string },
  ): Promise<HistoryPoint[]> {
    await this.ensureReady();
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
    const result = await this.pool!.query<HistoryPoint>(
      `SELECT ${COLUMNS} FROM gps_history WHERE imei=$1 AND gps_time >= $2 AND gps_time < $3 AND id <= $4 AND quality='valid' ${cursor} ORDER BY gps_time,id LIMIT $5`,
      params,
    );
    return result.rows;
  }

  async count(range: HistoryRange, snapshot: string): Promise<number> {
    await this.ensureReady();
    const result = await this.pool!.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM gps_history WHERE imei=$1 AND gps_time >= $2 AND gps_time < $3 AND id <= $4 AND quality='valid'`,
      [range.imei, range.from, range.to, snapshot],
    );
    return Number(result.rows[0].count);
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }
}
