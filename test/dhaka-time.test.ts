import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dhakaDate, dhakaMinutes, dhakaMonth } from '../src/common/dhaka-time';

test('business dates and billing months cross midnight together in Dhaka', () => {
  const before = '2026-01-31T17:59:59.000Z';
  const after = '2026-01-31T18:00:00.000Z';
  assert.equal(dhakaDate(before), '2026-01-31');
  assert.equal(dhakaMonth(before), '2026-01');
  assert.equal(dhakaMinutes(before), 1439);
  assert.equal(dhakaDate(after), '2026-02-01');
  assert.equal(dhakaMonth(after), '2026-02');
  assert.equal(dhakaMinutes(after), 0);
});

test('Dhaka calendar handles leap days and explicitly zoned inputs', () => {
  assert.equal(dhakaDate('2024-02-28T18:00:00Z'), '2024-02-29');
  assert.equal(dhakaDate(new Date('2024-02-29T18:00:00Z')), '2024-03-01');
  assert.equal(dhakaMonth(Date.parse('2025-12-31T18:00:00Z')), '2026-01');
  assert.equal(dhakaMinutes('2026-09-22T07:30:00+06:00'), 450);
});
