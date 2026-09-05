export interface HistoryPoint {
  id: string;
  imei: string;
  vehicleId: string | null;
  latitude: number;
  longitude: number;
  speed: number;
  course: number;
  gpsTime: string;
  receivedAt: string;
}

export interface HistoryEvent extends Omit<HistoryPoint, 'id'> {
  key: string;
  protocol: number | null;
  fixStatus: number | null;
  quality: 'valid' | 'invalid-time' | 'invalid-fix';
  rawGpsTime: string;
}

export interface HistoryRange {
  imei: string;
  from: string;
  to: string;
  timezone: 'Asia/Dhaka';
}
