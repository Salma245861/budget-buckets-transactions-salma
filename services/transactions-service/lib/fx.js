// External integration: currency conversion with ExchangeRate-API's open endpoint
// (https://open.er-api.com, free, no API key, supports EGP).
// Workflow: a user logs an expense paid abroad (e.g. 25 USD); the service converts it into the
// user's base currency so the bucket budgets and charts stay in one currency.
// The rate and its source are stored with the transaction (audit trail; history does not change).
// If an API key is ever needed (paid tier), it would be read from Secrets Manager, never the code.
//
// Caching, two levels (enhancement B, Salma: shared cache for scale):
//   1. memory of this Lambda copy, 1 hour        -> fastest, but every new copy starts empty
//   2. shared item in DynamoDB, 1 hour           -> all Lambda copies share one rate per currency,
//      (pk FXCACHE#shared, sk RATES#<currency>)     so 1,000 copies make 1 API call instead of 1,000
//   3. the external API                          -> only when both are empty or older than 1 hour
// If the shared cache fails, the service simply calls the API: the cache can never break a conversion.
const { errors, round2 } = require('pb-common');

const CACHE_MS = 60 * 60 * 1000;
const SHARED_PK = 'FXCACHE#shared';
const cache = new Map();
let shared = null; // the Transactions store (DynamoDB on Floci/AWS), set by the routes

function useSharedCache(store) { shared = store; }

async function readShared(currency, logger, requestId) {
  if (!shared) return null;
  try {
    const item = await shared.get(SHARED_PK, `RATES#${currency}`);
    if (item && Date.now() - item.at < CACHE_MS && item.rates && typeof item.rates === 'object') {
      logger.info('FX_SHARED_CACHE_HIT', { requestId, currency });
      return { at: item.at, rates: item.rates, updated: item.updated, provider: item.provider };
    }
  } catch (error) {
    logger.warn('FX_SHARED_CACHE_READ_FAILED', { requestId, currency });
  }
  return null;
}

async function writeShared(currency, entry, logger, requestId) {
  if (!shared) return;
  try {
    await shared.put({
      pk: SHARED_PK, sk: `RATES#${currency}`, ...entry,
      expiresAt: Math.floor((entry.at + CACHE_MS) / 1000) + 3600 // DynamoDB TTL can clean it up later
    });
  } catch (error) {
    logger.warn('FX_SHARED_CACHE_WRITE_FAILED', { requestId, currency });
  }
}

async function getRates(currency, logger, requestId) {
  const hit = cache.get(currency);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit;

  const sharedHit = await readShared(currency, logger, requestId);
  if (sharedHit) { cache.set(currency, sharedHit); return sharedHit; }

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
  await writeShared(currency, entry, logger, requestId);
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

module.exports = { convert, getRates, clearFxCache, useSharedCache, SHARED_PK };
