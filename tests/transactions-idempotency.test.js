// Unit tests for double-submit protection (enhancement C) in the Transactions service
// (services/transactions-service/lib/idempotency.js). Owner: Salma. Test IDs: TX-17 ... TX-19.
// Run: node --test tests/transactions-idempotency.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { transactionId, CLIENT_ID } = require('../services/transactions-service/lib/idempotency');

const ID = /^[A-Za-z0-9_-]{6,64}$/; // the id format the Transactions routes accept

test('TX-17 the same request sent twice gets the same transaction id (so it is saved once)', () => {
  const a = transactionId('2026-11-26', 'user-a', '3f1c2d4e-1111-4222-8333-944455556666');
  const b = transactionId('2026-11-26', 'user-a', '3f1c2d4e-1111-4222-8333-944455556666');
  assert.equal(a, b);
  assert.match(a, /^20261126-[0-9a-f]{12}$/);
  assert.match(a, ID);
});

test('TX-18 different users or different forms never share an id', () => {
  const key = '3f1c2d4e-1111-4222-8333-944455556666';
  assert.notEqual(transactionId('2026-11-26', 'user-a', key), transactionId('2026-11-26', 'user-b', key));
  assert.notEqual(transactionId('2026-11-26', 'user-a', key), transactionId('2026-11-26', 'user-a', `${key.slice(0, -1)}7`));
  assert.notEqual(transactionId('2026-11-26', 'user-a'), transactionId('2026-11-26', 'user-a')); // no ticket: random
});

test('TX-19 only safe ticket values are accepted', () => {
  assert.match('3f1c2d4e-1111-4222-8333-944455556666', CLIENT_ID);
  for (const bad of ['short', 'has space inside it', '<script>alert(1)</script>', 'x'.repeat(65), '../../etc/passwd']) {
    assert.doesNotMatch(bad, CLIENT_ID, bad);
  }
});
