import {
  CRC16_INITIAL,
  CRC16_X25_POLYNOMIAL,
  STANDARD_HEADER_SIZE,
} from './gt06.constants';

export function crc16X25(data: Buffer): number {
  let crc = CRC16_INITIAL;

  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >> 1) ^ CRC16_X25_POLYNOMIAL : crc >> 1;
    }
  }

  return (~crc & 0xffff) >>> 0;
}

/**
 * Verifies the CRC of a standard frame. `length` is the declared length byte;
 * the checksum covers that byte plus the payload.
 */
export function verifyFrameCrc(frame: Buffer, length: number): boolean {
  const crcOffset = STANDARD_HEADER_SIZE + length - 4;
  if (crcOffset < 0 || crcOffset + 2 > frame.length) {
    return false;
  }

  const expected = frame.readUInt16BE(crcOffset);
  const actual = crc16X25(frame.subarray(2, crcOffset));

  return expected === actual;
}
