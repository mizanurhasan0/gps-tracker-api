export type DeviceStatus = 'live' | 'lastKnown' | 'waiting' | 'offline';

export interface DevicePosition {
  latitude: number;
  longitude: number;
  speed: number;
  course: number;
  /** Device clock at the time of the fix */
  gpsTime: string;
  /** Server clock when the fix was received */
  receivedAt: string;
}

/**
 * Immutable input for post-commit consumers such as geofence evaluation.
 * This deliberately contains only a valid, newest device fix.
 */
export interface SavedPosition {
  imei: string;
  latitude: number;
  longitude: number;
  speed: number;
  course: number;
  gpsTime: string;
  receivedAt: string;
}

export type PositionEvaluationHook = (
  position: SavedPosition,
) => void | Promise<void>;

/** Persisted shape: device status plus its most recent valid fix */
export interface DeviceRecord {
  imei: string;
  lastSeen: string;
  gsmSignal?: number;
  voltageLevel?: number;
  position?: DevicePosition;
}

export interface DeviceLocation {
  imei: string;
  status: DeviceStatus;
  online: boolean;
  lastSeen: string;
  gsmSignal?: number;
  voltageLevel?: number;
  hasFix: boolean;
  latitude?: number;
  longitude?: number;
  speed?: number;
  course?: number;
  gpsTime?: string;
  positionAt?: string;
}
