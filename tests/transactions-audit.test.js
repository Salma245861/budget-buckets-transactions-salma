// Unit tests for the Neon audit trail (enhancement 1b) in the Transactions service
// (services/transactions-service/lib/audit.js). Owner: Salma. Test IDs: TX-23 ... TX-27.
// A fake query function stands in for Neon, so these tests need no internet and no password.
// Run: node --test tests/transactions-audit.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const audit = require('../services/transactions-service/lib/audit');

const logs = [];
const logger = { warn: (event, data) => logs.push({ event, ...data }), info() {}, error() {} };
const txn = {
  id: '20261127-abc123', type: 'expense', bucketId: 'bkt-1', currency: 'USD',
  amount: 75, amountBase: 3712.5, note: 'dinner with friends'
};

test.afterEach(() => { audit.useQuery(null); logs.length = 0; });

test('TX-23 an audit row holds who, what and which transaction, never the amount or the note', async () => {
  const calls = [];
  audit.useQuery(async (text, params) => { calls.push({ text, params }); return []; });
  assert.equal(await audit.record(logger, 'r1', 'u1', 'CREATE', txn), true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, ['u1', 'CREATE', '20261127-abc123', 'expense', 'bkt-1', 'USD']);
  const sent = JSON.stringify(calls[0]);
  for (const secret of ['75', '3712.5', 'dinner']) assert.equal(sent.includes(secret), false, `${secret} was sent to Neon`);
});

test('TX-24 every query is parameterised: input never becomes part of the SQL text', async () => {
  const calls = [];
  audit.useQuery(async (text, params) => { calls.push({ text, params }); return []; });
  const evil = "u1'); DROP TABLE transaction_audit; --";
  await audit.record(logger, 'r2', evil, 'DELETE', { id: "x' OR '1'='1" });
  await audit.eraseUser(logger, 'r3', evil);
  await audit.stats(7);
  for (const c of calls) {
    assert.equal(c.text.includes('DROP'), false);
    assert.equal(c.text.includes("'1'='1"), false);
    assert.match(c.text, /\$1/);
  }
  assert.equal(calls[0].params[0], evil, 'the value travels as a parameter instead');
  assert.throws(() => audit.auditRow('u1', 'DROP_TABLE'), /unknown audit action/);
});

test('TX-25 if Neon is down or slow, the request still succeeds and only a warning is logged', async () => {
  audit.useQuery(async () => { throw new Error('connect ECONNREFUSED'); });
  assert.equal(await audit.record(logger, 'r4', 'u1', 'CREATE', txn), false);
  assert.equal(logs[0].event, 'AUDIT_WRITE_FAILED');

  audit.useQuery(() => new Promise(() => {})); // never answers
  const started = Date.now();
  assert.equal(await audit.record(logger, 'r5', 'u1', 'UPDATE', txn), false);
  assert.ok(Date.now() - started < audit.WRITE_TIMEOUT_MS + 1000, 'gave up after the timeout');
  assert.equal(JSON.stringify(logs).includes('dinner'), false, 'the warning holds no transaction details');
});

test('TX-26 "delete my data" removes the user\'s audit rows and leaves one anonymous DELETE_ALL row', async () => {
  const calls = [];
  audit.useQuery(async (text, params) => { calls.push({ text, params }); return text.startsWith('DELETE') ? [{ id: 1 }, { id: 2 }] : []; });
  assert.equal(await audit.eraseUser(logger, 'r6', 'u1'), 2);
  assert.match(calls[0].text, /^DELETE FROM transaction_audit WHERE user_id = \$1/);
  assert.deepEqual(calls[0].params, ['u1']);
  assert.deepEqual(calls[1].params.slice(0, 2), [audit.ERASED_USER, 'DELETE_ALL']);
  assert.equal(JSON.stringify(calls[1]).includes('u1'), false, 'the remaining row does not name the user');
});

test('TX-27 admin analytics return counts per day and action, with no user ids', async () => {
  audit.useQuery(async (text) => (text.includes('GROUP BY')
    ? [{ day: '2026-11-27', action: 'CREATE', events: 3 }, { day: '2026-11-27', action: 'DELETE', events: 1 }]
    : [{ events: 4, active_users: 2, deletes: 1, foreign_currency: 1 }]));
  const out = await audit.stats(7);
  assert.deepEqual(out, {
    days: 7, events: 4, activeUsers: 2, deletes: 1, foreignCurrencyEvents: 1,
    byDay: [{ day: '2026-11-27', action: 'CREATE', events: 3 }, { day: '2026-11-27', action: 'DELETE', events: 1 }]
  });
  assert.equal(JSON.stringify(out).includes('user_id'), false);
});
