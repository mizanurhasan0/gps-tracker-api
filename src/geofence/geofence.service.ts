import { haversineDistanceMeters, isValidGeoCoordinate } from './geofence.math';
import type {
  GeofenceConfig,
  GeofenceEvaluationInput,
  GeofenceEvaluationResult,
  GeofenceState,
  RouteStopCoordinate,
  RouteStopCoordinateLookup,
} from './geofence.types';

export const DEFAULT_GEOFENCE_CONFIG: Required<GeofenceConfig> = {
  enterRadiusMeters: 100,
  exitRadiusMeters: 150,
};

/**
 * Evaluates one vehicle position against one route stop.
 *
 * This service deliberately does not read GPS data or persist state. The
 * caller owns those concerns and must persist the returned state atomically
 * with its event/notification decision.
 */
export class GeofenceService {
  private readonly config: Required<GeofenceConfig>;

  constructor(
    private readonly stopLookup: RouteStopCoordinateLookup,
    config: GeofenceConfig = DEFAULT_GEOFENCE_CONFIG,
  ) {
    this.config = normalizeConfig(config);
  }

  async evaluate(input: GeofenceEvaluationInput): Promise<GeofenceEvaluationResult> {
    validateInput(input);

    const stop = await this.stopLookup.findStopCoordinate(input.routeId, input.stopId);
    return this.evaluateAtStop(input, stop);
  }

  /** Evaluate an already loaded stop without a second database lookup. */
  evaluateAtStop(
    input: GeofenceEvaluationInput,
    stop: RouteStopCoordinate | null,
  ): GeofenceEvaluationResult {
    validateInput(input);

    // Missing coordinates must not create an exit or notification. Keeping the
    // previous state lets a temporary route-data issue recover safely.
    if (!stop) {
      return {
        status: 'stop-unavailable',
        transition: 'none',
        distanceMeters: null,
        shouldNotify: false,
        state: input.previousState,
      };
    }

    if (
      stop.routeId !== input.routeId ||
      stop.stopId !== input.stopId ||
      !stop.pickupPointId ||
      !isValidGeoCoordinate(stop)
    ) {
      throw new RangeError('Route-stop lookup returned an invalid coordinate');
    }

    const config = normalizeConfig({
      enterRadiusMeters: stop.enterRadiusMeters ?? this.config.enterRadiusMeters,
      exitRadiusMeters: stop.exitRadiusMeters ?? this.config.exitRadiusMeters,
    });

    const distanceMeters = haversineDistanceMeters(input.vehiclePosition, stop);
    const state = stateForInput(input);
    const transition = transitionForDistance(state.phase, distanceMeters, config);

    if (transition === 'enter') {
      const shouldNotify = !state.notificationSent;
      return {
        status: 'evaluated',
        transition,
        distanceMeters,
        shouldNotify,
        state: {
          ...state,
          phase: 'inside',
          notificationSent: true,
        },
      };
    }

    return {
      status: 'evaluated',
      transition,
      distanceMeters,
      shouldNotify: false,
      state: {
        ...state,
        phase: transition === 'exit' ? 'outside' : state.phase,
      },
    };
  }
}

function normalizeConfig(config: GeofenceConfig): Required<GeofenceConfig> {
  const enterRadiusMeters = config.enterRadiusMeters ?? DEFAULT_GEOFENCE_CONFIG.enterRadiusMeters;
  const exitRadiusMeters = config.exitRadiusMeters ?? DEFAULT_GEOFENCE_CONFIG.exitRadiusMeters;

  if (
    !Number.isFinite(enterRadiusMeters) ||
    !Number.isFinite(exitRadiusMeters) ||
    enterRadiusMeters <= 0 ||
    exitRadiusMeters < enterRadiusMeters
  ) {
    throw new RangeError(
      'exitRadiusMeters must be at least enterRadiusMeters, and both must be positive',
    );
  }

  return { enterRadiusMeters, exitRadiusMeters };
}

function validateInput(input: GeofenceEvaluationInput): void {
  if (!input.tripId || !input.routeId || !input.stopId) {
    throw new TypeError('tripId, routeId and stopId are required');
  }
  if (!isValidGeoCoordinate(input.vehiclePosition)) {
    throw new RangeError('Vehicle position must contain valid latitude and longitude');
  }
}

function stateForInput(input: GeofenceEvaluationInput): GeofenceState {
  const previous = input.previousState;
  if (
    previous &&
    previous.tripId === input.tripId &&
    previous.routeId === input.routeId &&
    previous.stopId === input.stopId
  ) {
    return previous;
  }

  return {
    tripId: input.tripId,
    routeId: input.routeId,
    stopId: input.stopId,
    phase: 'outside',
    notificationSent: false,
  };
}

function transitionForDistance(
  phase: GeofenceState['phase'],
  distanceMeters: number,
  config: Required<GeofenceConfig>,
): 'none' | 'enter' | 'exit' {
  if (phase === 'outside' && distanceMeters <= config.enterRadiusMeters) {
    return 'enter';
  }
  if (phase === 'inside' && distanceMeters >= config.exitRadiusMeters) {
    return 'exit';
  }
  return 'none';
}
