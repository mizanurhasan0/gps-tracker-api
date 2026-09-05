export enum Gt06Protocol {
  LOGIN = 0x01,
  GPS = 0x12,
  HEARTBEAT = 0x13,
  STRING_INFO = 0x15,
  ALARM = 0x16,
  LBS = 0x1a,
}

export interface Gt06Frame {
  protocol: number;
  serial: number;
  /** Payload starting at the protocol byte, excluding serial and CRC */
  body: Buffer;
  extended: boolean;
}

export interface Gt06Login {
  imei: string;
}

export interface Gt06Status {
  terminalInfo: number;
  voltageLevel: number;
  gsmSignal: number;
}

export interface Gt06Position {
  latitude: number;
  longitude: number;
  speed: number;
  course: number;
  status: number;
  /** Device clock, formatted `YYYY-MM-DD HH:mm:ss` */
  gpsTime: string;
}
