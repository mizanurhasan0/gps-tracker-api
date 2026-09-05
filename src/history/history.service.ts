import {
  BadRequestException,
  Injectable,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { HistoryRepository } from './history.repository';
import { HistoryIngestion } from './history.ingestion';
import {
  disconnected,
  distanceMeters,
  integerOption,
  sampleSegments,
  summarize,
  validateRange,
} from './history.math';
import type { HistoryPoint, HistoryRange } from './history.types';

interface Cursor {
  imei: string;
  from: string;
  to: string;
  snapshot: string;
  time: string;
  id: string;
}

@Injectable()
export class HistoryService {
  constructor(
    private readonly repository: HistoryRepository,
    private readonly ingestion: HistoryIngestion
  ) {}

  private metadata(range: HistoryRange) {
    return {
      ...range,
      freshness: this.ingestion.freshness(range.imei, range.from, range.to),
    };
  }

  private async available<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof PayloadTooLargeException
      )
        throw error;
      throw new ServiceUnavailableException(
        'GPS history is temporarily unavailable'
      );
    }
  }

  async history(imei: string, query: Record<string, unknown>) {
    const range = validateRange(imei, query);
    const limit = integerOption(query.limit, 1000, 1, 2000, 'limit');
    let cursor: Cursor | undefined;
    if (query.cursor !== undefined) {
      try {
        if (
          typeof query.cursor !== 'string' ||
          query.cursor.length > 1500 ||
          !/^[A-Za-z0-9_-]+$/.test(query.cursor)
        )
          throw new Error();
        cursor = JSON.parse(
          Buffer.from(query.cursor, 'base64url').toString('utf8')
        ) as Cursor;
        if (
          !cursor ||
          cursor.imei !== imei ||
          cursor.from !== range.from ||
          cursor.to !== range.to ||
          !/^\d{1,18}$/.test(cursor.snapshot) ||
          !/^\d{1,18}$/.test(cursor.id) ||
          !Number.isFinite(Date.parse(cursor.time)) ||
          Date.parse(cursor.time) < Date.parse(range.from) ||
          Date.parse(cursor.time) >= Date.parse(range.to) ||
          BigInt(cursor.id) > BigInt(cursor.snapshot)
        )
          throw new Error();
      } catch {
        throw new BadRequestException(
          'Invalid cursor or cursor does not match this device/range'
        );
      }
    }
    return this.available(async () => {
      const metadata = this.metadata(range);
      const snapshot = cursor?.snapshot ?? (await this.repository.snapshot());
      const values = await this.repository.points(
        range,
        snapshot,
        limit + 1,
        cursor
      );
      const points = values.slice(0, limit);
      const last = points[points.length - 1];
      const nextCursor =
        values.length > limit
          ? Buffer.from(
              JSON.stringify({
                imei,
                from: range.from,
                to: range.to,
                snapshot,
                time: last.gpsTime,
                id: last.id,
              })
            ).toString('base64url')
          : null;
      return { ...metadata, points, nextCursor, snapshot };
    });
  }

  async summary(imei: string, query: Record<string, unknown>) {
    const range = validateRange(imei, query);
    return this.available(async () => {
      const metadata = this.metadata(range);
      const snapshot = await this.repository.snapshot();
      const days = summarize([], range.from, range.to);
      const groups = new Map(days.map((day) => [day.date, day]));
      let previous: HistoryPoint | undefined;
      for await (const points of this.batches(range, snapshot))
        for (const point of points) {
          const date = new Date(Date.parse(point.gpsTime) + 6 * 3600000)
            .toISOString()
            .slice(0, 10);
          const day = groups.get(date)!;
          day.pointCount++;
          day.firstAt ??= point.gpsTime;
          day.lastAt = point.gpsTime;
          if (
            previous &&
            new Date(Date.parse(previous.gpsTime) + 6 * 3600000)
              .toISOString()
              .slice(0, 10) === date
          ) {
            if (disconnected(previous, point)) day.gapCount++;
            else day.distanceMeters += distanceMeters(previous, point);
          }
          previous = point;
        }
      for (const day of days)
        day.distanceMeters = Math.round(day.distanceMeters);
      return { ...metadata, days, snapshot };
    });
  }

  async route(imei: string, query: Record<string, unknown>) {
    const range = validateRange(imei, query);
    const maxPoints = integerOption(
      query.maxPoints,
      2000,
      2,
      2000,
      'maxPoints'
    );
    return this.available(async () => {
      const metadata = this.metadata(range);
      const snapshot = await this.repository.snapshot();
      const count = await this.repository.count(range, snapshot);
      const stride = Math.max(1, Math.ceil(count / maxPoints));
      let segments: { points: HistoryPoint[] }[] = [];
      let previous: HistoryPoint | undefined;
      let pointCount = 0,
        totalDistance = 0,
        gapCount = 0;
      const keepPrevious = () => {
        const points = segments[segments.length - 1]?.points;
        if (previous && points && points[points.length - 1].id !== previous.id)
          points.push(previous);
      };
      for await (const points of this.batches(range, snapshot))
        for (const point of points) {
          pointCount++;
          if (!previous || disconnected(previous, point)) {
            if (previous) {
              gapCount++;
              keepPrevious();
            }
            segments.push({ points: [point] });
            if (segments.length > maxPoints)
              throw new PayloadTooLargeException(
                'Too many disconnected segments; select a shorter period'
              );
          } else {
            totalDistance += distanceMeters(previous, point);
            if ((pointCount - 1) % stride === 0)
              segments[segments.length - 1].points.push(point);
          }
          previous = point;
        }
      keepPrevious();
      segments = sampleSegments(segments, maxPoints);
      const displayedPointCount = segments.reduce(
        (sum, s) => sum + s.points.length,
        0
      );
      return {
        ...metadata,
        segments,
        pointCount,
        displayedPointCount,
        simplified: displayedPointCount < pointCount,
        distanceMeters: Math.round(totalDistance),
        gapCount,
        snapshot,
      };
    });
  }

  private async *batches(range: HistoryRange, snapshot: string) {
    let after: { time: string; id: string } | undefined;
    while (true) {
      const points = await this.repository.points(range, snapshot, 5000, after);
      if (!points.length) return;
      yield points;
      const last = points[points.length - 1];
      after = { time: last.gpsTime, id: last.id };
      if (points.length < 5000) return;
    }
  }
}
