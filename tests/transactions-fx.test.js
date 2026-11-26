// Unit tests for the Transactions service's currency converter (services/transactions-service/lib/fx.js).
// Owner: Salma. Test IDs: TX-01 ... TX-07.
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

test('TX-07 a strange answer from the API is refused with 503', async () => {
  fakeApi({ result: 'error', 'error-type': 'unsupported-code' });
  await assert.rejects(fx.convert(3, 'USD', 'EGP', logger, 'req-7'),
    { status: 503, code: 'FX_UNAVAILABLE' });
});
