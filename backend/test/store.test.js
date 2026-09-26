import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSeed } from '../src/seed.js';

test('seed has the hero patient with a link code', () => {
  const seed = buildSeed();
  const garcia = seed.patients.find((p) => p.linkCode === 'GARCIA1');
  assert.ok(garcia);
  assert.equal(garcia.language, 'es');
  assert.ok(garcia.weights.length >= 2);
});

test('every patient has a unique link code', () => {
  const codes = buildSeed().patients.map((p) => p.linkCode);
  assert.equal(new Set(codes).size, codes.length);
});
