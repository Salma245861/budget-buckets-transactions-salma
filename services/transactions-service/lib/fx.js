// External integration: currency conversion with ExchangeRate-API's open endpoint
// (https://open.er-api.com, free, no API key, supports EGP).
// Workflow: a user logs an expense paid abroad (e.g. 25 USD); the service converts it into the
// user's base currency so the bucket budgets and charts stay in one currency.
// The rate and its source are stored with the transaction (audit trail; history does not change).
// Rates are cached in memory for 1 hour per currency to limit external calls (cost/latency).
// If an API key is ever needed (paid tier), it would be read from Secrets Manager, never the code.
const { errors, round2 } = require('pb-common');

const CACHE_MS = 60 * 60 * 1000;
const cache = new Map();

async function getRates(currency, logger, requestId) {
  const hit = cache.get(currency);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit;
  const base = (process.env.FX_API_URL || 'https://open.er-api.com/v6/latest').replace(/\/$/, '');
  let body;
  try {
    const res = await fetch(`${base}/${encodeURIComponent(currency)}`, {
      signal: AbortSignal.timeout(Number(process.env.FX_TIMEOUT_MS) || 4000)
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    body = await res.json();
  } catch (error) {
    logger.error('FX_API_FAILED', { requestId, currency, message: error.message });
    throw errors.unavailable('FX_UNAVAILABLE', 'Currency conversion is not available right now. Try again or use your base currency.');
  }
  if (!body || body.result !== 'success' || typeof body.rates !== 'object') {
    logger.error('FX_API_BAD_RESPONSE', { requestId, currency });
    throw errors.unavailable('FX_UNAVAILABLE', 'Currency conversion returned an unexpected answer.');
  }
  const entry = { at: Date.now(), rates: body.rates, updated: body.time_last_update_utc, provider: 'open.er-api.com' };
  cache.set(currency, entry);
  logger.info('FX_RATES_FETCHED', { requestId, currency });
  return entry;
}

async function convert(amount, from, to, logger, requestId) {
  if (from === to) return { amountBase: round2(amount), rate: 1, rateSource: 'same-currency', rateDate: null };
  const entry = await getRates(from, logger, requestId);
  const rate = entry.rates[to];
  if (typeof rate !== 'number' || !(rate > 0)) {
    throw errors.unprocessable('CURRENCY_NOT_SUPPORTED', `No exchange rate from ${from} to ${to}.`);
  }
  return { amountBase: round2(amount * rate), rate, rateSource: entry.provider, rateDate: entry.updated };
}

function clearFxCache() { cache.clear(); }

module.exports = { convert, getRates, clearFxCache };
