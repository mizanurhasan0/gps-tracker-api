export const START_BYTES = Buffer.from([0x78, 0x78]);
export const EXTENDED_START_BYTES = Buffer.from([0x79, 0x79]);
export const STOP_BYTES = Buffer.from([0x0d, 0x0a]);

/** Standard frame: start(2) + length(1) + payload + crc(2) + stop(2) */
export const STANDARD_HEADER_SIZE = 5;
/** Extended frame: start(2) + length(2) + payload + crc(2) + stop(2) */
export const EXTENDED_HEADER_SIZE = 6;

/** CRC-16/X-25, reversed polynomial */
export const CRC16_X25_POLYNOMIAL = 0x8408;
export const CRC16_INITIAL = 0xffff;

/**
 * Smallest body that holds a complete position report. The course/status word
 * sits at offset 17..18, so 19 bytes must be readable.
 */
export const MIN_POSITION_BODY_SIZE = 19;

/** Body must hold the protocol byte plus 8 BCD IMEI bytes */
export const MIN_LOGIN_BODY_SIZE = 9;

/**
 * CY03A and similar Concox clones invert the east/west flag: bit 10 set means
 * East, whereas the published GT06 spec uses bit 10 set for West.
 */
export const COURSE_STATUS_EAST_BIT = 0x0400;
export const COURSE_STATUS_SOUTH_BIT = 0x0800;
export const COURSE_MASK = 0x03ff;

/** Raw coordinates arrive as minutes scaled by 30000 */
export const COORDINATE_SCALE = 30000 * 60;
