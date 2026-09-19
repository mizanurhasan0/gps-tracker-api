export { GeofenceService, DEFAULT_GEOFENCE_CONFIG } from './geofence.service';
export {
  EARTH_RADIUS_METERS,
  haversineDistanceMeters,
  isValidGeoCoordinate,
} from './geofence.math';
export type {
  GeoCoordinate,
  GeofenceConfig,
  GeofenceEvaluationInput,
  GeofenceEvaluationResult,
  GeofenceEvaluationStatus,
  GeofencePhase,
  GeofenceState,
  GeofenceTransition,
  RouteStopCoordinate,
  RouteStopCoordinateLookup,
} from './geofence.types';

