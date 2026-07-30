export interface ParsedPacket {
  protocolNumber: number;
  serialNumber: number;
  body: Buffer;
  raw: Buffer;
}

export interface LoginPacket {
  imei: string;
  serialNumber: number;
}

export interface GpsPacket {
  imei: string;
  latitude: number;
  longitude: number;
  speed: number;
  course: number;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  gpsTime: string;
  status: number;
  serialNumber: number;
}
