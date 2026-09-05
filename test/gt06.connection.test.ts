import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
const { Gt06Connection } = require('../dist/gt06/gt06.connection');
const { crc16X25 } = require('../dist/gt06/gt06.crc');

function frame(bodyHex: string, serial: number): Buffer {
  const body = Buffer.from(bodyHex, 'hex');
  const serialBytes = Buffer.alloc(2);
  serialBytes.writeUInt16BE(serial);
  const checksummed = Buffer.concat([
    Buffer.from([body.length + 4]),
    body,
    serialBytes,
  ]);
  const crc = Buffer.alloc(2);
  crc.writeUInt16BE(crc16X25(checksummed));
  return Buffer.concat([
    Buffer.from([0x78, 0x78]),
    checksummed,
    crc,
    Buffer.from([13, 10]),
  ]);
}
const login = frame('010868720065798377', 1);
const position = (serial = 2) =>
  frame('120B081D112E10CC027AC7EB0C46584900148F', serial);
function deferred() {
  let resolve!: (value?: any) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<any>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(
  overrides: Record<string, unknown> = {},
  publishLocation = async (_location: unknown) => {}
) {
  const writes: Buffer[] = [];
  const socket = {
    remoteAddress: '127.0.0.1',
    remotePort: 1234,
    destroyed: false,
    paused: false,
    write: (buffer: Buffer) => {
      writes.push(buffer);
      return true;
    },
    pause() {
      this.paused = true;
    },
    resume() {
      this.paused = false;
    },
    destroy() {
      this.destroyed = true;
    },
  };
  const locations = {
    touch: async () => ({}),
    savePosition: async () => ({ hasFix: false }),
    ...overrides,
  };
  return {
    socket,
    writes,
    connection: new Gt06Connection(socket, locations, { publishLocation }),
  };
}

test('GT06 waits for login persistence and position commit before ACK or broadcast', async () => {
  const contact = deferred(),
    commit = deferred();
  const published: unknown[] = [];
  const f = fixture(
    { touch: () => contact.promise, savePosition: () => commit.promise },
    async (value) => {
      published.push(value);
    }
  );
  f.connection.handleData(Buffer.concat([login, position()]));
  assert.equal(f.writes.length, 0);
  assert.equal(f.socket.paused, true);
  contact.resolve({});
  await setImmediate();
  assert.equal(f.writes.length, 1);
  assert.equal(published.length, 0);
  commit.resolve({ hasFix: false });
  await setImmediate();
  assert.equal(f.writes.length, 2);
  assert.equal(published.length, 1);
  assert.equal(f.socket.paused, false);
});

test('GT06 closes without position ACK or broadcast when PostgreSQL commit fails', async () => {
  const commit = deferred();
  let published = 0;
  const f = fixture({ savePosition: () => commit.promise }, async () => {
    published++;
  });
  f.connection.handleData(login);
  await setImmediate();
  f.connection.handleData(position());
  commit.reject(new Error('database unavailable'));
  await setImmediate();
  assert.equal(f.writes.length, 1);
  assert.equal(published, 0);
  assert.equal(f.socket.destroyed, true);
  f.connection.handleData(position(3));
  await setImmediate();
  assert.equal(f.writes.length, 1);
});

test('GT06 processes queued and fragmented frames in order with one write in flight', async () => {
  const gates = [deferred(), deferred(), deferred()];
  let calls = 0;
  const f = fixture({ savePosition: () => gates[calls++].promise });
  f.connection.handleData(login);
  await setImmediate();
  f.connection.handleData(Buffer.concat([position(2), position(3)]));
  const last = position(4);
  f.connection.handleData(last.subarray(0, 10));
  f.connection.handleData(last.subarray(10));
  assert.equal(calls, 1);
  for (let i = 0; i < gates.length; i++) {
    assert.equal(calls, i + 1);
    assert.equal(f.writes.length, i + 1);
    gates[i].resolve({ hasFix: false });
    await setImmediate();
  }
  assert.equal(calls, 3);
  assert.deepEqual(
    f.writes.map((buffer) => buffer.readUInt16BE(4)),
    [1, 2, 3, 4]
  );
  assert.equal(f.socket.paused, false);
});

test('GT06 bounds queued bytes while a database write is pending', async () => {
  const commit = deferred();
  const f = fixture({ savePosition: () => commit.promise });
  f.connection.handleData(login);
  await setImmediate();
  f.connection.handleData(position());
  f.connection.handleData(Buffer.alloc(128 * 1024 + 1));
  assert.equal(f.socket.destroyed, true);
  commit.resolve({ hasFix: false });
  await setImmediate();
  assert.equal(f.writes.length, 1);
});

test('GT06 acknowledges committed position even when realtime publishing fails', async () => {
  const f = fixture({}, async () => {
    throw new Error('socket.io unavailable');
  });
  f.connection.handleData(Buffer.concat([login, position()]));
  await setImmediate();
  assert.equal(f.writes.length, 2);
  assert.equal(f.socket.destroyed, false);
});

test('slow realtime viewers do not delay ACKs and updates coalesce to the latest position', async () => {
  const broadcast = deferred();
  const published: unknown[] = [];
  let sequence = 0;
  const f = fixture(
    { savePosition: async () => ({ hasFix: false, sequence: ++sequence }) },
    async (value) => {
      published.push(value);
      if (published.length === 1) await broadcast.promise;
    }
  );
  f.connection.handleData(
    Buffer.concat([login, position(2), position(3), position(4)])
  );
  await setImmediate();
  assert.equal(
    f.writes.length,
    4,
    'all committed packets are acknowledged while broadcast is pending'
  );
  assert.equal(f.socket.paused, false);
  assert.equal(published.length, 1, 'only one broadcast is in flight');
  broadcast.resolve();
  await setImmediate();
  assert.deepEqual(published, [
    { hasFix: false, sequence: 1 },
    { hasFix: false, sequence: 3 },
  ]);
});
