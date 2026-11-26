// Unit tests for "download my data" and "delete my data" (enhancement 5f) in the Transactions
// service (services/transactions-service/lib/privacy.js). Owner: Salma. Test IDs: TX-13 ... TX-15.
// Run: node --test tests/transactions-privacy.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const privacy = require('../services/transactions-service/lib/privacy');
const receipts = require('../services/transactions-service/lib/receipts');

const items = [
  { pk: 'USER#u1', sk: 'TXN#20261120-b', id: '20261120-b', date: '2026-11-20', createdAt: '2026-11-20T10:00:00Z',
    amount: 50, note: 'lunch', receiptKey: null },
  { pk: 'USER#u1', sk: 'TXN#20261101-a', id: '20261101-a', date: '2026-11-01', createdAt: '2026-11-01T09:00:00Z',
    amount: 900, note: 'rent', receiptKey: 'receipts/u1/20261101-a' },
  { pk: 'USER#u1', sk: 'TXN#20261125-c', id: '20261125-c', date: '2026-11-25', createdAt: '2026-11-25T08:00:00Z',
    amount: 20, note: 'coffee', receiptKey: null, receiptPendingType: 'image/png' }
];

test('TX-13 the export holds every transaction, oldest first', () => {
  const out = privacy.exportView(items);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((t) => t.note), ['rent', 'lunch', 'coffee']);
  assert.equal(out[0].hasReceipt, true);
  assert.equal(out[1].hasReceipt, false);
});

test('TX-14 the export never shows internal storage fields (keys, file locations)', () => {
  for (const t of privacy.exportView(items)) {
    for (const f of ['pk', 'sk', 'receiptKey', 'receiptPendingType']) assert.equal(f in t, false, `${f} leaked`);
  }
  assert.equal('receiptKey' in items[1], true, 'the stored item itself is not changed');
});

test('TX-15 "delete my data" finds every receipt file, including uploads still waiting for their check', () => {
  assert.deepEqual(privacy.receiptKeysToDelete(items, 'u1', receipts),
    ['receipts/u1/20261101-a', 'receipts/u1/20261125-c.pending']);
  assert.deepEqual(privacy.receiptKeysToDelete([], 'u1', receipts), []);
});
