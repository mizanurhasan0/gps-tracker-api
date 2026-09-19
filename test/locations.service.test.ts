import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LocationsService } from '../src/locations/locations.service';
import type { DeviceRecord, SavedPosition } from '../src/locations/location.types';

function fixture(
  initial?: DeviceRecord,
  gpsTime = '2026-09-19T05:00:00.000Z',
) {
  let record = initial;
  let committed = false;
  const db = {
    transaction: async <T>(work: () => Promise<T>): Promise<T> => {
      const result = await work();
      committed = true;
      return result;
    },
    run: async (sql: string, ...params: unknown[]) => {
      const json = params.at(-1);
      if (sql.includes('INSERT INTO devices') && typeof json === 'string') {
        record = JSON.parse(json) as DeviceRecord;
      }
      return { rowCount: 1, changes: 1 };
    },
    get: async <T>(_sql: string): Promise<T | undefined> =>
      record ? ({ record } as T) : undefined,
  };
  const history = {
    record: async () => gpsTime,
  };
  return {
    locations: new LocationsService(history as never, db as never),
    get committed() {
      return committed;
    },
  };
}

test('emits a newest valid fix after the database transaction commits', async () => {
  const f = fixture();
  const received: SavedPosition[] = [];
  let committedWhenCalled = false;
  f.locations.registerPositionEvaluationHook((position) => {
    committedWhenCalled = f.committed;
    received.push(position);
  });

  const location = await f.locations.savePosition({
    imei: '868720065798377',
    latitude: 23.8103,
    longitude: 90.4125,
    speed: 12,
    course: 90,
    gpsTime: '2026-09-19 11:00:00',
  });
  await Promise.resolve();

  assert.equal(location.hasFix, true);
  assert.equal(received.length, 1);
  assert.equal(committedWhenCalled, true);
  assert.deepEqual(received[0], {
    imei: '868720065798377',
    latitude: 23.8103,
    longitude: 90.4125,
    speed: 12,
    course: 90,
    gpsTime: '2026-09-19T05:00:00.000Z',
    receivedAt: received[0].receivedAt,
  });
});

test('does not evaluate a delayed fix that did not become the latest position', async () => {
  const f = fixture(
    {
      imei: '868720065798377',
      lastSeen: '2026-09-19T05:01:00.000Z',
      position: {
        latitude: 23.81,
        longitude: 90.41,
        speed: 10,
        course: 80,
        gpsTime: '2026-09-19T05:01:00.000Z',
        receivedAt: '2026-09-19T05:01:00.000Z',
      },
    },
    '2026-09-19T04:59:00.000Z',
  );
  let calls = 0;
  f.locations.registerPositionEvaluationHook(() => {
    calls++;
  });

  await f.locations.savePosition({
    imei: '868720065798377',
    latitude: 23.8103,
    longitude: 90.4125,
    speed: 12,
    course: 90,
    gpsTime: '2026-09-19 10:59:00',
  });
  await Promise.resolve();

  assert.equal(calls, 0);
});

test('hook failures do not reject a committed position save', async () => {
  const f = fixture();
  f.locations.registerPositionEvaluationHook(async () => {
    throw new Error('geofence unavailable');
  });

  await assert.doesNotReject(
    f.locations.savePosition({
      imei: '868720065798377',
      latitude: 23.8103,
      longitude: 90.4125,
      speed: 12,
      course: 90,
      gpsTime: '2026-09-19 11:00:00',
    }),
  );
  await Promise.resolve();
});
