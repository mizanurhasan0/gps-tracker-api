import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidCoordinates,
  normalizeCoordinates,
} from '../src/locations/coordinates';

describe('isValidCoordinates', () => {
  it('accepts a real Dhaka fix', () => {
    assert.ok(isValidCoordinates(23.8103, 90.4125));
  });

  it('rejects the null island placeholder', () => {
    assert.equal(isValidCoordinates(0, 0), false);
  });

  it('rejects out-of-range values', () => {
    assert.equal(isValidCoordinates(91, 90), false);
    assert.equal(isValidCoordinates(23, 181), false);
  });

  it('rejects non-finite values', () => {
    assert.equal(isValidCoordinates(Number.NaN, 90), false);
  });
});

describe('normalizeCoordinates', () => {
  it('flips a mirrored Bangladesh longitude to the east', () => {
    const result = normalizeCoordinates(23.824333, -90.36912);
    assert.equal(result.longitude, 90.36912);
    assert.equal(result.latitude, 23.824333);
  });

  it('leaves a correct eastern longitude untouched', () => {
    const result = normalizeCoordinates(23.824333, 90.36912);
    assert.equal(result.longitude, 90.36912);
  });

  it('leaves genuine western coordinates untouched', () => {
    const result = normalizeCoordinates(40.7128, -74.006);
    assert.equal(result.longitude, -74.006);
  });
});
