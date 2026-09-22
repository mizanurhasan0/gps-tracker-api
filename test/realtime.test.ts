import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { AuthService } from '../src/auth/auth.service';
import { AccessService } from '../src/auth/access.service';
import type { User } from '../src/auth/auth.types';
import type { DeviceLocation } from '../src/locations/location.types';
import { RealtimeGateway } from '../src/realtime/realtime.gateway';

const guardian: User = {
  id: 'guardian',
  name: 'Guardian',
  phone: '01700000001',
  role: 'GUARDIAN',
  verified: 1,
  createdAt: '',
};
const location = { imei: '868720065798377' } as DeviceLocation;
const token = 'a'.repeat(64);

function socket(sessionToken: unknown = token) {
  return {
    connected: true,
    handshake: { auth: { token: sessionToken } },
    deliveries: 0,
    emit() {
      this.deliveries++;
    },
    disconnect() {
      this.connected = false;
    },
  };
}

function attach(gateway: RealtimeGateway, clients: ReturnType<typeof socket>[]) {
  Object.assign(gateway, {
    server: {
      sockets: { sockets: new Map(clients.map((client, index) => [String(index), client])) },
    },
  });
}

test('batch session lookup deduplicates tokens, rejects malformed input and strips token hashes', async () => {
  const calls: unknown[][] = [];
  const hash = createHash('sha256').update(token).digest('hex');
  const auth = new AuthService({
    all: async (_sql: string, ...params: unknown[]) => {
      calls.push(params);
      return [{ ...guardian, tokenHash: hash }];
    },
  } as never);
  const users = await auth.authenticateMany([token, token, null, {}, 'invalid']);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][0], [hash]);
  assert.deepEqual([...users], [[token, guardian]]);
  assert.deepEqual([...(await auth.authenticateMany([undefined, 'invalid']))], []);
  assert.equal(calls.length, 1, 'invalid-only input must not query the database');
});

test('list permissions use one lookup, retain ordering and avoid queries for admins or empty lists', async () => {
  let queries = 0;
  const access = new AccessService({
    all: async () => {
      queries++;
      return [{ imei: '2' }];
    },
  } as never);
  const records = [{ imei: '3' }, { imei: '2' }, { imei: '1' }];
  assert.deepEqual(await access.filterTrackable(guardian, records), [records[1]]);
  assert.equal(queries, 1);
  assert.deepEqual(await access.filterTrackable(guardian, []), []);
  assert.equal(await access.filterTrackable({ ...guardian, role: 'ADMIN' }, records), records);
  assert.equal(queries, 1);
});

test('live broadcasts authorize bounded batches instead of querying each viewer', async () => {
  const batchSizes: number[] = [];
  let permissionQueries = 0;
  const gateway = new RealtimeGateway(
    {
      authenticateMany: async (tokens: unknown[]) => {
        batchSizes.push(tokens.length);
        return new Map([[token, guardian]]);
      },
    } as never,
    {
      trackingUserIds: async () => {
        permissionQueries++;
        return new Set([guardian.id]);
      },
    } as never,
  );
  const clients = Array.from({ length: 501 }, () => socket());
  attach(gateway, clients);
  await gateway.publishLocation(location);
  assert.deepEqual(batchSizes, [250, 250, 1]);
  assert.equal(permissionQueries, 3);
  assert.ok(clients.every((client) => client.deliveries === 1));
});

test('existing live sockets lose access after assignment revocation and disconnect after logout', async () => {
  let signedIn = true;
  let assigned = true;
  const gateway = new RealtimeGateway(
    {
      authenticateMany: async () => (signedIn ? new Map([[token, guardian]]) : new Map()),
    } as never,
    {
      trackingUserIds: async () => new Set(assigned ? [guardian.id] : []),
    } as never,
  );
  const client = socket();
  const malformed = socket({ token });
  attach(gateway, [client, malformed]);
  await gateway.publishLocation(location);
  assert.equal(client.deliveries, 1);
  assert.equal(malformed.connected, false);
  assigned = false;
  await gateway.publishLocation(location);
  assert.equal(client.deliveries, 1);
  assert.equal(client.connected, true);
  signedIn = false;
  await gateway.publishLocation(location);
  assert.equal(client.connected, false);
});

test('a database failure sends no update and permits recovery on the next broadcast', async () => {
  let unavailable = true;
  const gateway = new RealtimeGateway(
    {
      authenticateMany: async () => {
        if (unavailable) throw new Error('database unavailable');
        return new Map([[token, guardian]]);
      },
    } as never,
    {
      trackingUserIds: async () => new Set([guardian.id]),
    } as never,
  );
  const client = socket();
  attach(gateway, [client]);
  await assert.rejects(gateway.publishLocation(location), /database unavailable/);
  assert.equal(client.deliveries, 0);
  assert.equal(client.connected, true);
  unavailable = false;
  await gateway.publishLocation(location);
  assert.equal(client.deliveries, 1);
});

test('empty gateways perform no authorization queries', async () => {
  const gateway = new RealtimeGateway({} as never, {} as never);
  await gateway.publishLocation(location);
});
