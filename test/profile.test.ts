import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ValidationPipe } from '@nestjs/common';
import type { AuthRequest } from '../src/auth/auth.types';
const { UpdateProfileDto } = require('../dist/auth/auth.dto');
const { AuthService } = require('../dist/auth/auth.service');
const { AuthController } = require('../dist/auth/auth.controller');

const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
const validate = (value: unknown) => pipe.transform(value, { type: 'body', metatype: UpdateProfileDto });

test('profile input trims names and rejects empty, oversized, and privileged fields', async () => {
  assert.equal((await validate({ name: '  New name  ' })).name, 'New name');
  for (const input of [{ name: ' ' }, { name: 'a' }, { name: 'a'.repeat(81) }, { name: 'New name', role: 'ADMIN' }, { name: 'New name', phone: '01700000000' }, { name: 'New name', id: 'another-user' }]) {
    await assert.rejects(() => validate(input));
  }
});

test('profile updates use the authenticated identity and return public user fields', async () => {
  const user = { id: 'guardian-id', name: 'New name', phone: '01700000001', role: 'GUARDIAN', verified: 1 };
  const calls: unknown[][] = [];
  const service = new AuthService({ get: async (...args: unknown[]) => { calls.push(args); return user; } });
  const controller = new AuthController(service);
  const result = await controller.updateProfile({ name: 'New name' }, { user } as AuthRequest);
  assert.equal(result, user);
  assert.deepEqual(calls[0].slice(1), ['New name', 'guardian-id']);
  assert.match(String(calls[0][0]), /UPDATE users SET name = \$1 WHERE id = \$2 RETURNING/);
  assert.doesNotMatch(String(calls[0][0]), /passwordHash/);
});

test('profile update fails for a deleted account', async () => {
  const service = new AuthService({ get: async () => undefined });
  await assert.rejects(() => service.updateProfile('missing', { name: 'New name' }), { status: 401 });
});
