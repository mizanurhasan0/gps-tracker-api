/** A latitude/longitude pair in decimal degrees. */
export interface GeoCoordinate {
  latitude: number;
  longitude: number;
}

/**
 * The coordinate returned by the route-stop lookup.
 *
 * The lookup implementation must verify that stopId belongs to routeId before
 * returning a coordinate. Keeping that concern behind this contract prevents
 * the geofence domain from depending on database tables or ORM models.
 */
export interface RouteStopCoordinate extends GeoCoordinate {
  routeId: string;
  stopId: string;
  /** Persistent pickup-point key used to store this stop's trip state. */
  pickupPointId: string;
  /** Stop-specific hysteresis settings, configured by an administrator. */
  enterRadiusMeters: number;
  exitRadiusMeters: number;
}

export interface RouteStopCoordinateLookup {
  findStopCoordinate(
    routeId: string,
    stopId: string,
  ): Promise<RouteStopCoordinate | null>;
}

export type GeofencePhase = 'outside' | 'inside';

/** State that must be persisted by the caller between GPS updates. */
export interface GeofenceState {
  tripId: string;
  routeId: string;
  stopId: string;
  phase: GeofencePhase;
  /** Remains true after the first enter for this trip and stop. */
  notificationSent: boolean;
}

export interface GeofenceConfig {
  /** Distance at which an outside vehicle enters the geofence. */
  enterRadiusMeters?: number;
  /** Distance at which an inside vehicle exits the geofence. */
  exitRadiusMeters?: number;
}

export interface GeofenceEvaluationInput {
  tripId: string;
  routeId: string;
  stopId: string;
  vehiclePosition: GeoCoordinate;
  previousState?: GeofenceState;
}

export type GeofenceTransition = 'none' | 'enter' | 'exit';
export type GeofenceEvaluationStatus = 'evaluated' | 'stop-unavailable';

export interface GeofenceEvaluationResult {
  status: GeofenceEvaluationStatus;
  transition: GeofenceTransition;
  distanceMeters: number | null;
  shouldNotify: boolean;
  state?: GeofenceState;
}
