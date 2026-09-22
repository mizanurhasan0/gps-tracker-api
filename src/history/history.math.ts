import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import type { HistoryPoint, HistoryRange } from './history.types';

const DAY = 86_400_000;
const DHAKA_OFFSET = 6 * 3_600_000;
const GAP_MS = 10 * 60_000;
const MAX_SPEED_KMH = 200;

/** Existing tracker codec emits a naive time. Explicit offset, never host timezone. */
export function parseGpsTime(value: string, offsetMinutes = 0): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d{3})?(Z)?$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const date = new Date(Date.UTC(+year, +month - 1, +day, +hour, +minute, +second));
  if (
    +year < 2000 ||
    date.getUTCFullYear() !== +year ||
    date.getUTCMonth() !== +month - 1 ||
    date.getUTCDate() !== +day ||
    +hour > 23 ||
    +minute > 59 ||
    +second > 59
  )
    return null;
  return new Date(date.getTime() - (match[7] ? 0 : offsetMinutes * 60_000)).toISOString();
}

export function integerOption(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value))
    throw new BadRequestException(`${name} must be an integer`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max)
    throw new BadRequestException(`${name} must be between ${min} and ${max}`);
  return result;
}

export function validateRange(imei: string, query: Record<string, unknown>): HistoryRange {
  if (!/^\d{10,20}$/.test(imei)) throw new BadRequestException('Invalid device IMEI');
  if (query.timezone !== undefined && query.timezone !== 'Asia/Dhaka')
    throw new BadRequestException('timezone must be Asia/Dhaka');
  const parse = (value: unknown): number => {
    if (
      typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    )
      return NaN;
    if (!parseGpsTime(value.slice(0, 19))) return NaN;
    return Date.parse(value);
  };
  const from = parse(query.from),
    to = parse(query.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 31 * DAY)
    throw new BadRequestException(
      'Provide valid ISO from/to with an explicit offset, from < to, and at most 31 days',
    );
  return {
    imei,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    timezone: 'Asia/Dhaka',
  };
}

export function distanceMeters(a: HistoryPoint, b: HistoryPoint): number {
  const rad = Math.PI / 180;
  const dlat = (b.latitude - a.latitude) * rad,
    dlon = (b.longitude - a.longitude) * rad;
  const h =
    Math.sin(dlat / 2) ** 2 +
    Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dlon / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(Math.min(1, h)), Math.sqrt(Math.max(0, 1 - h)));
}

export function disconnected(
  a: HistoryPoint,
  b: HistoryPoint,
  distance = distanceMeters(a, b),
): boolean {
  const elapsed = Date.parse(b.gpsTime) - Date.parse(a.gpsTime);
  return (
    elapsed > GAP_MS ||
    elapsed < 0 ||
    (elapsed === 0 ? distance > 0 : (distance / elapsed) * 3600 > MAX_SPEED_KMH)
  );
}

export function buildRoute(points: HistoryPoint[], maxPoints: number) {
  const segments: { points: HistoryPoint[] }[] = [];
  let totalDistance = 0,
    gaps = 0;
  for (const point of points) {
    const segment = segments[segments.length - 1];
    const previous = segment?.points[segment.points.length - 1];
    const distance = previous ? distanceMeters(previous, point) : 0;
    if (!previous || disconnected(previous, point, distance)) {
      if (previous) gaps++;
      segments.push({ points: [point] });
    } else {
      totalDistance += distance;
      segment.points.push(point);
    }
  }
  const displayed = sampleSegments(segments, maxPoints);
  const displayedPointCount = displayed.reduce((sum, s) => sum + s.points.length, 0);
  return {
    segments: displayed,
    pointCount: points.length,
    displayedPointCount,
    simplified: displayedPointCount < points.length,
    distanceMeters: Math.round(totalDistance),
    gapCount: gaps,
  };
}

export function sampleSegments(segments: { points: HistoryPoint[] }[], maxPoints: number) {
  const count = segments.reduce((sum, s) => sum + s.points.length, 0);
  const mandatory = segments.reduce((sum, s) => sum + Math.min(2, s.points.length), 0);
  if (mandatory > maxPoints)
    throw new PayloadTooLargeException('Too many disconnected segments; select a shorter period');
  const interior = count - mandatory;
  let budget = Math.max(0, maxPoints - mandatory);
  let remainingInterior = interior;
  return segments.map((segment) => {
    const available = Math.max(0, segment.points.length - 2);
    const take = remainingInterior
      ? Math.min(available, Math.floor((budget * available) / remainingInterior))
      : 0;
    remainingInterior -= available;
    budget -= take;
    if (take === available) return segment;
    const result = [segment.points[0]];
    for (let i = 1; i <= take; i++)
      result.push(segment.points[Math.floor((i * (segment.points.length - 1)) / (take + 1))]);
    if (segment.points.length > 1) result.push(segment.points[segment.points.length - 1]);
    return { points: result };
  });
}

export function summarize(points: HistoryPoint[], from: string, to: string) {
  const groups = new Map<string, HistoryPoint[]>();
  for (
    let time = Math.floor((Date.parse(from) + DHAKA_OFFSET) / DAY) * DAY;
    time < Date.parse(to) + DHAKA_OFFSET;
    time += DAY
  )
    groups.set(new Date(time).toISOString().slice(0, 10), []);
  for (const point of points) {
    const date = new Date(Date.parse(point.gpsTime) + DHAKA_OFFSET).toISOString().slice(0, 10);
    groups.get(date)?.push(point);
  }
  // Distance is within each calendar day. Cross-midnight edges are excluded.
  return [...groups].map(([date, values]) => {
    const route = buildRoute(values, Math.max(2, values.length));
    return {
      date,
      pointCount: values.length,
      distanceMeters: route.distanceMeters,
      firstAt: values[0]?.gpsTime ?? null,
      lastAt: values[values.length - 1]?.gpsTime ?? null,
      gapCount: route.gapCount,
    };
  });
}
