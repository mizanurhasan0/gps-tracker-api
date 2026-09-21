import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  GeofenceService,
  haversineDistanceMeters,
  type GeofenceState,
  type RouteStopCoordinate,
  type RouteStopCoordinateLookup,
} from '../src/geofence';

const ROUTE_ID = 'route-1';
const STOP_ID = 'stop-1';
const TRIP_ID = 'trip-1';
const STOP: RouteStopCoordinate = {
  routeId: ROUTE_ID,
  stopId: STOP_ID,
  pickupPointId: 'pickup-point-1',
  latitude: 23.8103,
  longitude: 90.4125,
  enterRadiusMeters: 100,
  exitRadiusMeters: 150,
};

class FakeStopLookup implements RouteStopCoordinateLookup {
  constructor(private readonly coordinate: RouteStopCoordinate | null = STOP) {}

  calls: Array<[string, string]> = [];

  async findStopCoordinate(routeId: string, stopId: string): Promise<RouteStopCoordinate | null> {
    this.calls.push([routeId, stopId]);
    return this.coordinate;
  }
}

function positionMetersFromStop(meters: number): { latitude: number; longitude: number } {
  return {
    latitude: STOP.latitude,
    longitude: STOP.longitude + meters / (111_320 * Math.cos((STOP.latitude * Math.PI) / 180)),
  };
}

function input(
  vehiclePosition: { latitude: number; longitude: number },
  previousState?: GeofenceState,
) {
  return {
    tripId: TRIP_ID,
    routeId: ROUTE_ID,
    stopId: STOP_ID,
    vehiclePosition,
    previousState,
  };
}

describe('haversineDistanceMeters', () => {
  it('calculates the known distance between two coordinates', () => {
    const distance = haversineDistanceMeters(
      { latitude: 23.8103, longitude: 90.4125 },
      { latitude: 23.8203, longitude: 90.4125 },
    );
    assert.ok(distance > 1_100 && distance < 1_130, `${distance}m`);
  });

  it('rejects invalid coordinates', () => {
    assert.throws(() =>
      haversineDistanceMeters(
        { latitude: 91, longitude: 90 },
        { latitude: 23, longitude: 90 },
      ),
    RangeError);
  });
});


describe('GeofenceService', () => {
  it('looks up a route stop and enters at the configurable enter radius', async () => {
    const lookup = new FakeStopLookup();
    const service = new GeofenceService(lookup, {
      enterRadiusMeters: 100,
      exitRadiusMeters: 150,
    });

    const result = await service.evaluate(input(positionMetersFromStop(90)));

    assert.equal(result.status, 'evaluated');
    assert.equal(result.transition, 'enter');
    assert.equal(result.shouldNotify, true);
    assert.equal(result.state?.phase, 'inside');
    assert.equal(result.state?.notificationSent, true);
    assert.deepEqual(lookup.calls, [[ROUTE_ID, STOP_ID]]);
  });

  it('keeps the vehicle inside between enter and exit radii', async () => {
    const service = new GeofenceService(new FakeStopLookup(), {
      enterRadiusMeters: 100,
      exitRadiusMeters: 150,
    });
    const inside: GeofenceState = {
      tripId: TRIP_ID,
      routeId: ROUTE_ID,
      stopId: STOP_ID,
      phase: 'inside',
      notificationSent: true,
    };

    const result = await service.evaluate(input(positionMetersFromStop(120), inside));

    assert.equal(result.transition, 'none');
    assert.equal(result.shouldNotify, false);
    assert.equal(result.state?.phase, 'inside');
  });

  it('uses the pickup point radius instead of the application default', async () => {
    const lookup = new FakeStopLookup({
      ...STOP,
      enterRadiusMeters: 50,
      exitRadiusMeters: 75,
    });
    const service = new GeofenceService(lookup, {
      enterRadiusMeters: 100,
      exitRadiusMeters: 150,
    });

    const outside = await service.evaluate(input(positionMetersFromStop(60)));
    const inside = await service.evaluate(input(positionMetersFromStop(45)));
    const exited = await service.evaluate(
      input(positionMetersFromStop(80), inside.state),
    );

    assert.equal(outside.transition, 'none');
    assert.equal(inside.transition, 'enter');
    assert.equal(exited.transition, 'exit');
  });

  it('exits only at the exit radius and can re-enter without a second notification', async () => {
    const service = new GeofenceService(new FakeStopLookup(), {
      enterRadiusMeters: 100,
      exitRadiusMeters: 150,
    });
    const entered = await service.evaluate(input(positionMetersFromStop(90)));
    const exited = await service.evaluate(input(positionMetersFromStop(160), entered.state));
    const reentered = await service.evaluate(input(positionMetersFromStop(80), exited.state));

    assert.equal(entered.shouldNotify, true);
    assert.equal(exited.transition, 'exit');
    assert.equal(exited.shouldNotify, false);
    assert.equal(reentered.transition, 'enter');
    assert.equal(reentered.shouldNotify, false);
    assert.equal(reentered.state?.notificationSent, true);
  });

  it('allows one notification per trip and resets for a new trip', async () => {
    const service = new GeofenceService(new FakeStopLookup());
    const entered = await service.evaluate(input(positionMetersFromStop(50)));
    const newTrip = await service.evaluate({
      ...input(positionMetersFromStop(50)),
      tripId: 'trip-2',
      previousState: entered.state,
    });

    assert.equal(entered.shouldNotify, true);
    assert.equal(newTrip.transition, 'enter');
    assert.equal(newTrip.shouldNotify, true);
    assert.equal(newTrip.state?.tripId, 'trip-2');
  });

  it('does not emit a false exit when route stop coordinates are unavailable', async () => {
    const state: GeofenceState = {
      tripId: TRIP_ID,
      routeId: ROUTE_ID,
      stopId: STOP_ID,
      phase: 'inside',
      notificationSent: true,
    };
    const service = new GeofenceService(new FakeStopLookup(null));

    const result = await service.evaluate(input(positionMetersFromStop(500), state));

    assert.equal(result.status, 'stop-unavailable');
    assert.equal(result.transition, 'none');
    assert.equal(result.shouldNotify, false);
    assert.equal(result.state, state);
  });

  it('rejects an invalid hysteresis configuration', () => {
    assert.throws(
      () => new GeofenceService(new FakeStopLookup(), { enterRadiusMeters: 200, exitRadiusMeters: 100 }),
      RangeError,
    );
  });
});
