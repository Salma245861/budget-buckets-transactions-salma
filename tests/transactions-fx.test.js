// Unit tests for the Transactions service's currency converter (services/transactions-service/lib/fx.js).
// Owner: Salma. Test IDs: TX-01 ... TX-07, and TX-20 ... TX-22 for the shared cache (enhancement B).
// The real exchange-rate website is replaced by a fake one, so these tests need no internet
// and always give the same result.
// Run: node --test tests/transactions-fx.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fx = require('../services/transactions-service/lib/fx');

// A logger that prints nothing (the converter writes log lines, the tests don't need them)
const logger = { info() {}, warn() {}, error() {} };

const realFetch = globalThis.fetch;
let calls = 0;

// Replace the exchange-rate website with a fake that answers with the rates we choose
function fakeApi(answer) {
  calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (answer instanceof Error) throw answer;
    return { ok: true, json: async () => answer };
  };
}

test.beforeEach(() => fx.clearFxCache());
test.after(() => { globalThis.fetch = realFetch; });

test('TX-01 same currency: no conversion and no call to the API', async () => {
  fakeApi(new Error('the API must not be called'));
  const r = await fx.convert(250, 'EGP', 'EGP', logger, 'req-1');
  assert.equal(r.amountBase, 250);
  assert.equal(r.rate, 1);
  assert.equal(calls, 0);
});

test('TX-02 USD to EGP uses the rate from the API', async () => {
  fakeApi({ result: 'success', rates: { EGP: 48.5 }, time_last_update_utc: 'Wed, 25 Nov 2026 00:00:01 +0000' });
  const r = await fx.convert(10, 'USD', 'EGP', logger, 'req-2');
  assert.equal(r.amountBase, 485);
  assert.equal(r.rate, 48.5);
  assert.equal(r.rateSource, 'open.er-api.com');
});

test('TX-03 the converted amount is rounded to 2 decimals', async () => {
  fakeApi({ result: 'success', rates: { EGP: 48.333 } });
  const r = await fx.convert(1.11, 'USD', 'EGP', logger, 'req-3');
  assert.equal(r.amountBase, 53.65); // 1.11 x 48.333 = 53.64963
});

test('TX-04 rates are cached: two conversions, only one API call', async () => {
  fakeApi({ result: 'success', rates: { EGP: 50 } });
  await fx.convert(1, 'USD', 'EGP', logger, 'req-4a');
  await fx.convert(2, 'USD', 'EGP', logger, 'req-4b');
  assert.equal(calls, 1);
});

test('TX-05 a currency the API has no rate for is refused with 422', async () => {
  fakeApi({ result: 'success', rates: { USD: 1 } });
  await assert.rejects(fx.convert(5, 'USD', 'EGP', logger, 'req-5'),
    { status: 422, code: 'CURRENCY_NOT_SUPPORTED' });
});

test('TX-06 API down: a clear 503 error, nothing converted', async () => {
  fakeApi(new Error('network unreachable'));
  await assert.rejects(fx.convert(3, 'KWD', 'EGP', logger, 'req-6'),
    { status: 503, code: 'FX_UNAVAILABLE' });
});

// ----- Shared cache (enhancement B): a fake DynamoDB table shared by "two Lambda copies" -----
function fakeTable({ broken = false } = {}) {
  const rows = new Map();
  return {
    rows,
    async get(pk, sk) { if (broken) throw new Error('DynamoDB down'); return rows.get(`${pk}|${sk}`) || null; },
    async put(item) { if (broken) throw new Error('DynamoDB down'); rows.set(`${item.pk}|${item.sk}`, { ...item }); return true; }
  };
}

test('TX-20 a second Lambda copy gets the rate from the shared cache, with no API call', async () => {
  const table = fakeTable();
  fx.useSharedCache(table);
  try {
    fakeApi({ result: 'success', rates: { EGP: 49 } });
    await fx.convert(1, 'USD', 'EGP', logger, 'copy-1');  // copy 1: asks the API, fills the shared cache
    assert.equal(calls, 1);
    assert.ok(table.rows.has('FXCACHE#shared|RATES#USD'));
    fx.clearFxCache();                                     // copy 2 starts with an empty memory
    const r = await fx.convert(2, 'USD', 'EGP', logger, 'copy-2');
    assert.equal(r.amountBase, 98);
    assert.equal(calls, 1, 'the API was not called again');
  } finally { fx.useSharedCache(null); }
});

test('TX-21 a shared rate older than 1 hour is not used: the API is asked again', async () => {
  const table = fakeTable();
  table.rows.set('FXCACHE#shared|RATES#USD', {
    pk: 'FXCACHE#shared', sk: 'RATES#USD', at: Date.now() - 2 * 60 * 60 * 1000, rates: { EGP: 30 }, provider: 'open.er-api.com'
  });
  fx.useSharedCache(table);
  try {
    fakeApi({ result: 'success', rates: { EGP: 50 } });
    const r = await fx.convert(1, 'USD', 'EGP', logger, 'req-21');
    assert.equal(r.rate, 50);
    assert.equal(calls, 1);
    assert.equal(table.rows.get('FXCACHE#shared|RATES#USD').rates.EGP, 50, 'the shared cache was refreshed');
  } finally { fx.useSharedCache(null); }
});

test('TX-22 if the shared cache is down, conversion still works through the API', async () => {
  fx.useSharedCache(fakeTable({ broken: true }));
  try {
    fakeApi({ result: 'success', rates: { EGP: 48 } });
    const r = await fx.convert(10, 'USD', 'EGP', logger, 'req-22');
    assert.equal(r.amountBase, 480);
  } finally { fx.useSharedCache(null); }
});

test('TX-07 a strange answer from the API is refused with 503', async () => {
  fakeApi({ result: 'error', 'error-type': 'unsupported-code' });
  await assert.rejects(fx.convert(3, 'USD', 'EGP', logger, 'req-7'),
    { status: 503, code: 'FX_UNAVAILABLE' });
});
