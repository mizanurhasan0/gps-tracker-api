export function isValidCoordinates(latitude: number, longitude: number): boolean {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180 &&
    !(latitude === 0 && longitude === 0)
  );
}

/**
 * Safety net for trackers that still report a western hemisphere longitude
 * while physically in Bangladesh. Only flips the sign when the latitude is
 * inside Bangladesh and the mirrored longitude would land in the country.
 */
export function normalizeCoordinates(
  latitude: number,
  longitude: number,
): { latitude: number; longitude: number } {
  const insideBangladeshLatitude = latitude >= 20 && latitude <= 27;
  const mirroredLongitude = Math.abs(longitude);
  const mirrorsIntoBangladesh =
    longitude < 0 && mirroredLongitude >= 80 && mirroredLongitude <= 95;

  if (insideBangladeshLatitude && mirrorsIntoBangladesh) {
    return { latitude, longitude: mirroredLongitude };
  }

  return { latitude, longitude };
}
