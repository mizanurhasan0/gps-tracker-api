import {
  COORDINATE_SCALE,
  COURSE_MASK,
  COURSE_STATUS_NORTH_BIT,
  COURSE_STATUS_WEST_BIT,
  COURSE_STATUS_FIX_BIT,
  EXTENDED_HEADER_SIZE,
  EXTENDED_START_BYTES,
  MIN_LOGIN_BODY_SIZE,
  MIN_POSITION_BODY_SIZE,
  STANDARD_HEADER_SIZE,
  START_BYTES,
  STOP_BYTES,
} from './gt06.constants';
import { crc16X25, verifyFrameCrc } from './gt06.crc';
import type {
  Gt06Frame,
  Gt06Login,
  Gt06Position,
  Gt06Status,
} from './gt06.types';

export interface FrameSearchResult {
  frame: Buffer | null;
  /** Bytes left to process, including any partial frame */
  remaining: Buffer;
}

export function toHex(buffer: Buffer): string {
  return buffer.toString('hex').toUpperCase();
}

export function bcdToNumber(value: number): number {
  return ((value >> 4) & 0x0f) * 10 + (value & 0x0f);
}

/** Decodes 8 BCD bytes into an IMEI, dropping the leading pad digit */
export function decodeImei(bytes: Buffer): string {
  let imei = '';

  bytes.forEach((byte, index) => {
    const high = (byte >> 4) & 0x0f;
    const low = byte & 0x0f;
    const isLastNibblePadding = index === bytes.length - 1 && low === 0x0f;

    imei += isLastNibblePadding ? `${high}` : `${high}${low}`;
  });

  return imei.replace(/^0+/, '') || imei;
}

/** Builds the ACK a device expects: 78 78 05 [protocol] [serial] [crc] 0D 0A */
export function buildAck(protocol: number, serial: number): Buffer {
  const lengthByte = 0x05;
  const serialBytes = Buffer.alloc(2);
  serialBytes.writeUInt16BE(serial, 0);

  const checksummed = Buffer.concat([
    Buffer.from([lengthByte, protocol]),
    serialBytes,
  ]);
  const crcBytes = Buffer.alloc(2);
  crcBytes.writeUInt16BE(crc16X25(checksummed), 0);

  return Buffer.concat([
    START_BYTES,
    Buffer.from([lengthByte, protocol]),
    serialBytes,
    crcBytes,
    STOP_BYTES,
  ]);
}

/**
 * Extracts the first complete frame from a stream buffer. Leading garbage is
 * skipped; a frame that fails CRC is dropped so the stream can resynchronise.
 */
export function findFrame(buffer: Buffer): FrameSearchResult {
  const standardIndex = buffer.indexOf(START_BYTES);
  const extendedIndex = buffer.indexOf(EXTENDED_START_BYTES);

  if (standardIndex === -1 && extendedIndex === -1) {
    return { frame: null, remaining: Buffer.alloc(0) };
  }

  const startIndex =
    standardIndex === -1
      ? extendedIndex
      : extendedIndex === -1
        ? standardIndex
        : Math.min(standardIndex, extendedIndex);

  const aligned = startIndex > 0 ? buffer.subarray(startIndex) : buffer;
  const isExtended = aligned.subarray(0, 2).equals(EXTENDED_START_BYTES);

  return isExtended ? findExtendedFrame(aligned) : findStandardFrame(aligned);
}

function findStandardFrame(buffer: Buffer): FrameSearchResult {
  if (buffer.length < STANDARD_HEADER_SIZE) {
    return { frame: null, remaining: buffer };
  }

  const declaredLength = buffer[2];
  const frameLength = STANDARD_HEADER_SIZE + declaredLength;

  if (buffer.length < frameLength) {
    return { frame: null, remaining: buffer };
  }

  const frame = buffer.subarray(0, frameLength);

  if (!verifyFrameCrc(frame, declaredLength)) {
    // Skip the start bytes so the next scan can find a later frame
    return { frame: null, remaining: buffer.subarray(2) };
  }

  return { frame, remaining: buffer.subarray(frameLength) };
}

function findExtendedFrame(buffer: Buffer): FrameSearchResult {
  if (buffer.length < EXTENDED_HEADER_SIZE) {
    return { frame: null, remaining: buffer };
  }

  const declaredLength = buffer.readUInt16BE(2);
  const frameLength = EXTENDED_HEADER_SIZE + declaredLength;

  if (buffer.length < frameLength) {
    return { frame: null, remaining: buffer };
  }

  return {
    frame: buffer.subarray(0, frameLength),
    remaining: buffer.subarray(frameLength),
  };
}

export function parseFrame(frame: Buffer): Gt06Frame {
  const extended = frame.subarray(0, 2).equals(EXTENDED_START_BYTES);

  if (extended) {
    const declaredLength = frame.readUInt16BE(2);
    const bodyEnd = 4 + declaredLength - 4;

    return {
      protocol: frame[4],
      serial: frame.readUInt16BE(bodyEnd),
      body: frame.subarray(4, bodyEnd),
      extended: true,
    };
  }

  const declaredLength = frame[2];
  const bodyEnd = 3 + declaredLength - 4;

  return {
    protocol: frame[3],
    serial: frame.readUInt16BE(bodyEnd),
    body: frame.subarray(3, bodyEnd),
    extended: false,
  };
}

export function hasLogin(body: Buffer): boolean {
  return body.length >= MIN_LOGIN_BODY_SIZE;
}

export function parseLogin(body: Buffer): Gt06Login {
  return { imei: decodeImei(body.subarray(1, MIN_LOGIN_BODY_SIZE)) };
}

export function parseStatus(body: Buffer): Gt06Status {
  return {
    terminalInfo: body.length > 1 ? body[1] : 0,
    voltageLevel: body.length > 2 ? body[2] : 0,
    gsmSignal: body.length > 3 ? body[3] : 0,
  };
}

export function hasPosition(body: Buffer): boolean {
  return body.length >= MIN_POSITION_BODY_SIZE;
}

export function parsePosition(body: Buffer): Gt06Position {
  // Unlike the IMEI, GT06 GPS date components are unsigned binary bytes.
  const year = body[1] + 2000;
  const month = body[2];
  const day = body[3];
  const hour = body[4];
  const minute = body[5];
  const second = body[6];

  const courseStatus = body.readUInt16BE(17);

  let latitude = body.readUInt32BE(8) / COORDINATE_SCALE;
  let longitude = body.readUInt32BE(12) / COORDINATE_SCALE;

  if (courseStatus & COURSE_STATUS_WEST_BIT) {
    longitude = -longitude;
  }
  if (!(courseStatus & COURSE_STATUS_NORTH_BIT)) {
    latitude = -latitude;
  }

  return {
    latitude,
    longitude,
    speed: body[16],
    course: courseStatus & COURSE_MASK,
    status: courseStatus,
    gpsFixed: Boolean(courseStatus & COURSE_STATUS_FIX_BIT),
    satellites: body[7] & 0x0f,
    gpsTime: formatGpsTime(year, month, day, hour, minute, second),
  };
}

function formatGpsTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): string {
  // Date.UTC normalizes impossible dates. Reject those rather than silently
  // moving a report into another day's history. Keep invalid packets safe to
  // parse; ingestion treats an empty device timestamp as unusable.
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    year > 2099 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    return '';
  }
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)}`;
}
