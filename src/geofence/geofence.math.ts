import type { GeoCoordinate } from './geofence.types';

/** Mean earth radius in metres. */
export const EARTH_RADIUS_METERS = 6_371_008.8;

export function isValidGeoCoordinate(coordinate: GeoCoordinate): boolean {
  return (
    Number.isFinite(coordinate.latitude) &&
    Number.isFinite(coordinate.longitude) &&
    coordinate.latitude >= -90 &&
    coordinate.latitude <= 90 &&
    coordinate.longitude >= -180 &&
    coordinate.longitude <= 180
  );
}

/**
 * Returns the great-circle distance between two coordinates in metres.
 * Haversine is stable for short distances and handles longitude wraparound.
 */
export function haversineDistanceMeters(
  from: GeoCoordinate,
  to: GeoCoordinate,
): number {
  if (!isValidGeoCoordinate(from) || !isValidGeoCoordinate(to)) {
    throw new RangeError('Both coordinates must contain valid latitude and longitude');
  }

  const latitudeDelta = toRadians(to.latitude - from.latitude);
  const longitudeDelta = toRadians(to.longitude - from.longitude);
  const fromLatitude = toRadians(from.latitude);
  const toLatitude = toRadians(to.latitude);

  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(fromLatitude) *
      Math.cos(toLatitude) *
      Math.sin(longitudeDelta / 2) ** 2;

  // Floating-point rounding can move the value a few ulps outside [0, 1].
  const clampedHaversine = Math.min(1, haversine);
  const centralAngle = 2 * Math.atan2(
    Math.sqrt(clampedHaversine),
    Math.sqrt(1 - clampedHaversine),
  );
  return EARTH_RADIUS_METERS * centralAngle;
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}
