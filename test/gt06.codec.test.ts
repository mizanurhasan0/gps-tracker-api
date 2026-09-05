import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { crc16X25, verifyFrameCrc } from '../src/gt06/gt06.crc';
import {
  buildAck,
  decodeImei,
  findFrame,
  hasLogin,
  hasPosition,
  parseFrame,
  parseLogin,
  parsePosition,
  parseStatus,
  toHex,
} from '../src/gt06/gt06.codec';
import { Gt06Protocol } from '../src/gt06/gt06.types';
import { COORDINATE_SCALE } from '../src/gt06/gt06.constants';

const DEVICE_IMEI = '868720065798377';

function buildStandardFrame(payload: Buffer): Buffer {
  const lengthByte = payload.length + 2;
  const checksummed = Buffer.concat([Buffer.from([lengthByte]), payload]);
  const crc = Buffer.alloc(2);
  crc.writeUInt16BE(crc16X25(checksummed), 0);

  return Buffer.concat([
    Buffer.from([0x78, 0x78]),
    checksummed,
    crc,
    Buffer.from([0x0d, 0x0a]),
  ]);
}

function toRawCoordinate(decimal: number): number {
  return Math.round(decimal * COORDINATE_SCALE);
}

function buildPositionPayload(
  latitude: number,
  longitude: number,
  courseStatus = 0x0400,
  speed = 0,
): Buffer {
  const latBytes = Buffer.alloc(4);
  const lonBytes = Buffer.alloc(4);
  latBytes.writeUInt32BE(toRawCoordinate(latitude), 0);
  lonBytes.writeUInt32BE(toRawCoordinate(longitude), 0);

  const courseBytes = Buffer.alloc(2);
  courseBytes.writeUInt16BE(courseStatus, 0);

  return Buffer.concat([
    Buffer.from([Gt06Protocol.GPS]),
    // BCD timestamp: 2024-08-30 10:00:00
    Buffer.from([0x24, 0x08, 0x30, 0x10, 0x00, 0x00]),
    Buffer.from([0xcf]),
    latBytes,
    lonBytes,
    Buffer.from([speed]),
    courseBytes,
    Buffer.from([0x00, 0x02]),
  ]);
}

const LOGIN_PAYLOAD = Buffer.from([
  Gt06Protocol.LOGIN, 0x08, 0x68, 0x72, 0x00, 0x65, 0x79, 0x83, 0x77, 0x00,
  0x01,
]);

describe('gt06 crc', () => {
  it('builds an ACK that passes its own CRC check', () => {
    const ack = buildAck(Gt06Protocol.LOGIN, 1);

    assert.equal(toHex(ack), '787805010001D9DC0D0A');
    assert.ok(verifyFrameCrc(ack, ack[2]));
  });

  it('verifies a real CY03A login frame', () => {
    const frame = Buffer.from('78780D0108687200657983770001F9790D0A', 'hex');
    assert.ok(verifyFrameCrc(frame, frame[2]));
  });

  it('rejects a frame with a corrupted payload', () => {
    const frame = Buffer.from('78780D0108687200657983770001F9790D0A', 'hex');
    frame[5] = 0x00;

    assert.equal(verifyFrameCrc(frame, frame[2]), false);
  });
});

describe('gt06 imei decoding', () => {
  it('drops the leading pad digit', () => {
    const bytes = Buffer.from([0x08, 0x68, 0x72, 0x00, 0x65, 0x79, 0x83, 0x77]);
    assert.equal(decodeImei(bytes), DEVICE_IMEI);
  });
});

describe('gt06 framing', () => {
  it('extracts a login frame and reports no leftover bytes', () => {
    const { frame, remaining } = findFrame(buildStandardFrame(LOGIN_PAYLOAD));

    assert.ok(frame);
    assert.equal(remaining.length, 0);

    const parsed = parseFrame(frame as Buffer);
    assert.equal(parsed.protocol, Gt06Protocol.LOGIN);
    assert.equal(parsed.serial, 1);
    assert.equal(parseLogin(parsed.body).imei, DEVICE_IMEI);
  });

  it('skips leading garbage before the start bytes', () => {
    const stream = Buffer.concat([
      Buffer.from([0x00, 0xff, 0xab]),
      buildStandardFrame(LOGIN_PAYLOAD),
    ]);

    const { frame, remaining } = findFrame(stream);

    assert.ok(frame);
    assert.equal(remaining.length, 0);
  });

  it('waits for the rest of a partial frame without consuming it', () => {
    const full = buildStandardFrame(LOGIN_PAYLOAD);
    const partial = full.subarray(0, full.length - 3);

    const { frame, remaining } = findFrame(partial);

    assert.equal(frame, null);
    assert.equal(remaining.length, partial.length);
  });

  it('returns both frames when two arrive in one chunk', () => {
    const stream = Buffer.concat([
      buildStandardFrame(LOGIN_PAYLOAD),
      buildStandardFrame(Buffer.from([Gt06Protocol.HEARTBEAT, 0x00, 0x06, 0x04, 0x00, 0x01])),
    ]);

    const first = findFrame(stream);
    assert.ok(first.frame);

    const second = findFrame(first.remaining);
    assert.ok(second.frame);
    assert.equal(second.remaining.length, 0);
    assert.equal(parseFrame(second.frame as Buffer).protocol, Gt06Protocol.HEARTBEAT);
  });

  it('resynchronises past a frame that fails CRC', () => {
    const corrupted = buildStandardFrame(LOGIN_PAYLOAD);
    corrupted[corrupted.length - 3] ^= 0xff;

    const { frame, remaining } = findFrame(corrupted);

    assert.equal(frame, null);
    assert.ok(remaining.length < corrupted.length);
  });
});

describe('gt06 payload parsing', () => {
  it('parses Dhaka coordinates from a position report', () => {
    const payload = buildPositionPayload(23.8103, 90.4125);
    const { frame } = findFrame(buildStandardFrame(payload));
    const parsed = parseFrame(frame as Buffer);

    assert.equal(parsed.protocol, Gt06Protocol.GPS);
    assert.ok(hasPosition(parsed.body));

    const position = parsePosition(parsed.body);
    assert.ok(Math.abs(position.latitude - 23.8103) < 0.001);
    assert.ok(Math.abs(position.longitude - 90.4125) < 0.001);
    assert.equal(position.speed, 0);
    assert.equal(position.gpsTime, '2024-08-30 10:00:00');
  });

  it('treats a cleared east bit as a western longitude', () => {
    const payload = buildPositionPayload(23.8103, 90.4125, 0x0000);
    const { frame } = findFrame(buildStandardFrame(payload));
    const position = parsePosition(parseFrame(frame as Buffer).body);

    assert.ok(position.longitude < 0);
  });

  it('reads modem status from a heartbeat body', () => {
    const body = Buffer.from([Gt06Protocol.HEARTBEAT, 0x00, 0x06, 0x04]);
    const status = parseStatus(body);

    assert.equal(status.voltageLevel, 6);
    assert.equal(status.gsmSignal, 4);
  });

  it('reports no position for a short body', () => {
    assert.equal(hasPosition(Buffer.alloc(8)), false);
  });

  it('never accepts a body too short to hold the course word', () => {
    // parsePosition reads a 16-bit word at offset 17, so 18 bytes is not enough
    assert.equal(hasPosition(Buffer.alloc(18)), false);
    assert.equal(hasPosition(Buffer.alloc(19)), true);
  });

  it('parses a position from the smallest accepted body', () => {
    assert.doesNotThrow(() => parsePosition(Buffer.alloc(19)));
  });

  it('rejects a truncated login body', () => {
    assert.equal(hasLogin(Buffer.alloc(8)), false);
    assert.equal(hasLogin(Buffer.alloc(9)), true);
  });
});
