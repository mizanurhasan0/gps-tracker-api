import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { buildRoute, distanceMeters, integerOption, parseGpsTime, summarize, validateRange } from '../src/history/history.math';
import type { HistoryPoint } from '../src/history/history.types';

const IMEI = '868720065798377';
const START = Date.parse('2026-09-04T18:00:00.000Z');
function point(index: number, latitude = 23.8, longitude = 90.4, seconds = index * 60): HistoryPoint {
  const gpsTime = new Date(START + seconds * 1000).toISOString();
  return { id: String(index), imei: IMEI, vehicleId: 'vehicle-1', latitude, longitude, speed: 0, course: 0, gpsTime, receivedAt: gpsTime };
}

describe('history date validation', () => {
  it('uses explicit device offset while preserving UTC timestamps', () => {
    assert.equal(parseGpsTime('2026-09-05 00:00:00', 360), '2026-09-04T18:00:00.000Z');
    assert.equal(parseGpsTime('2026-09-05 00:00:00'), '2026-09-05T00:00:00.000Z');
    assert.equal(parseGpsTime('2026-09-05T00:00:00Z', 360), '2026-09-05T00:00:00.000Z');
    assert.equal(parseGpsTime('2024-02-29 23:59:59'), '2024-02-29T23:59:59.000Z');
  });

  it('rejects invalid calendar fields rather than normalizing into a different day', () => {
    for (const value of ['', '2026-02-29 10:00:00', '2026-04-31 10:00:00', '2026-09-00 10:00:00', '2026-13-05 10:00:00', '2026-09-05 24:00:00', '2026-09-05 10:60:00', '2026-09-05 10:00:60']) {
      assert.equal(parseGpsTime(value), null, value);
    }
  });

  it('normalizes an explicitly zoned calendar month to an exclusive UTC range', () => {
    assert.deepEqual(validateRange(IMEI, { from: '2026-08-01T00:00:00+06:00', to: '2026-09-01T00:00:00+06:00' }), {
      imei: IMEI, from: '2026-07-31T18:00:00.000Z', to: '2026-08-31T18:00:00.000Z', timezone: 'Asia/Dhaka',
    });
  });

  it('rejects timezone-less, reversed, oversized and impossible ranges', () => {
    const valid = { from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' };
    for (const query of [
      { ...valid, from: '2026-09-01T00:00:00' },
      { ...valid, from: valid.to },
      { ...valid, from: '2026-09-03T00:00:00Z' },
      { ...valid, to: '2026-10-03T00:00:00Z' },
      { ...valid, from: '2026-02-30T00:00:00Z' },
      { ...valid, from: '2026-09-01T24:00:00Z', to: '2026-09-03T00:00:00Z' },
      { ...valid, timezone: 'UTC' },
    ]) assert.throws(() => validateRange(IMEI, query), BadRequestException, JSON.stringify(query));
    assert.throws(() => validateRange('../devices', valid), BadRequestException);
  });

  it('bounds integer options and rejects arrays and fractional values', () => {
    assert.equal(integerOption(undefined, 2000, 2, 5000, 'maxPoints'), 2000);
    assert.equal(integerOption('2', 2000, 2, 5000, 'maxPoints'), 2);
    for (const value of ['0', '5001', '2.1', ['2'], 'Infinity'])
      assert.throws(() => integerOption(value, 2000, 2, 5000, 'maxPoints'), BadRequestException);
  });
});

describe('history route integrity', () => {
  it('keeps stationary samples without inventing distance or gaps', () => {
    const points = [point(0), point(1), point(2)];
    const route = buildRoute(points, 10);
    assert.equal(route.distanceMeters, 0);
    assert.equal(route.gapCount, 0);
    assert.equal(route.pointCount, 3);
    assert.equal(route.simplified, false);
    assert.deepEqual(route.segments[0].points, points);
  });

  it('disconnects reporting gaps, impossible jumps and simultaneous different fixes', () => {
    for (const second of [point(1, 23.8, 90.4, 601), point(1, 24.8, 90.4, 60), point(1, 23.801, 90.4, 0)]) {
      const route = buildRoute([point(0), second], 10);
      assert.equal(route.gapCount, 1);
      assert.equal(route.segments.length, 2);
      assert.equal(route.distanceMeters, 0);
    }
    assert.equal(buildRoute([point(0), point(1, 23.8, 90.4, 600)], 10).gapCount, 0);
  });

  it('calculates distance from all samples before reducing route display points', () => {
    const points = Array.from({ length: 20 }, (_, i) => point(i, 23.8 + i * 0.0001, 90.4 + (i % 2) * 0.0001));
    const detailed = buildRoute(points, 20);
    const reduced = buildRoute(points, 5);
    assert.equal(reduced.distanceMeters, detailed.distanceMeters);
    assert.ok(reduced.distanceMeters > Math.round(distanceMeters(points[0], points.at(-1)!)));
    assert.equal(reduced.displayedPointCount, 5);
    assert.equal(reduced.pointCount, 20);
    assert.equal(reduced.simplified, true);
    assert.equal(reduced.segments[0].points[0], points[0]);
    assert.equal(reduced.segments[0].points.at(-1), points.at(-1));
    for (const p of reduced.segments[0].points) assert.ok(points.includes(p));
  });

  it('retains every segment endpoint and never crosses the point budget', () => {
    const first = Array.from({ length: 5 }, (_, i) => point(i, 23.8 + i * 0.0001));
    const second = Array.from({ length: 5 }, (_, i) => point(i + 5, 23.9 + i * 0.0001, 90.4, 3600 + i * 60));
    const route = buildRoute([...first, ...second], 6);
    assert.equal(route.segments.length, 2);
    assert.equal(route.displayedPointCount, 6);
    for (const [index, original] of [first, second].entries()) {
      assert.equal(route.segments[index].points[0], original[0]);
      assert.equal(route.segments[index].points.at(-1), original.at(-1));
    }
    assert.throws(() => buildRoute([...first, ...second], 3), PayloadTooLargeException);
  });

  it('returns a coherent empty route', () => {
    assert.deepEqual(buildRoute([], 2000), { segments: [], pointCount: 0, displayedPointCount: 0, simplified: false, distanceMeters: 0, gapCount: 0 });
  });
});

describe('Dhaka daily summary', () => {
  it('places midnight samples in the new day and zero-fills missing days', () => {
    const before = point(0, 23.8, 90.4, -1);
    const after = point(1, 23.8001, 90.4, 0);
    const days = summarize([before, after], '2026-09-03T18:00:00.000Z', '2026-09-06T18:00:00.000Z');
    assert.deepEqual(days.map(d => [d.date, d.pointCount]), [['2026-09-04', 1], ['2026-09-05', 1], ['2026-09-06', 0]]);
    assert.equal(days[0].firstAt, before.gpsTime);
    assert.equal(days[1].firstAt, after.gpsTime);
    assert.equal(days[2].firstAt, null);
    assert.equal(days[2].lastAt, null);
    assert.equal(days[2].distanceMeters, 0);
    // Cross-midnight travel is deliberately excluded from within-day totals.
    assert.equal(days[0].distanceMeters + days[1].distanceMeters, 0);
  });
});
