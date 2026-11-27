// Audit trail and admin analytics in Neon Postgres (enhancement 1b, Salma).
//
// Every create, edit, delete, receipt attach and "delete my data" writes one row to the Neon table
// transaction_audit: who, what, when, which transaction. Amounts and notes are never stored, so a
// leak of this database shows no money details.
//
// Security:
//   - The connection string is in Secrets Manager (secret name in NEON_SECRET_ID), never in code or Git.
//   - The Lambda connects as pb_transactions_app, a Postgres role that may only SELECT, INSERT and
//     DELETE on this one table (no UPDATE, so audit rows cannot be rewritten; no DROP).
//   - Every query is parameterised ($1, $2, ...): input is never pasted into SQL (no SQL injection).
//   - TLS is required (sslmode=require; the driver talks HTTPS to Neon).
//   - If Neon is slow or down, saving a transaction still works: the audit write gives up after
//     WRITE_TIMEOUT_MS and only logs AUDIT_WRITE_FAILED.
//
// Table (created once in the Neon SQL Editor, see services/transactions-service/infra/neon-schema.sql).
const ACTIONS = ['CREATE', 'UPDATE', 'DELETE', 'RECEIPT_ATTACH', 'DELETE_ALL'];
const WRITE_TIMEOUT_MS = 3000;
const SECRET_CACHE_MS = 10 * 60 * 1000;
const ERASED_USER = 'erased-user';

let override = null; // tests inject a fake query function here
let sql = null;
let loadedAt = 0;

function enabled() {
  return Boolean(override || process.env.NEON_SECRET_ID);
}

async function loadUrl() {
  const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
  const out = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: process.env.NEON_SECRET_ID }));
  return out.SecretString;
}

async function query(text, params) {
  if (override) return override(text, params);
  if (!sql || Date.now() - loadedAt > SECRET_CACHE_MS) {
    const { neon } = require('@neondatabase/serverless');
    sql = neon(await loadUrl());
    loadedAt = Date.now();
  }
  return sql.query(text, params);
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`audit timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// The row written for one event. Only these columns exist; amount and note are left out on purpose.
function auditRow(userId, action, txn = {}) {
  if (!ACTIONS.includes(action)) throw new Error(`unknown audit action ${action}`);
  return [userId, action, txn.id || null, txn.type || null, txn.bucketId || null, txn.currency || null];
}

// Never throws: a failed audit write must not fail the user's request.
async function record(logger, requestId, userId, action, txn) {
  if (!enabled()) return false;
  try {
    await withTimeout(query(
      'INSERT INTO transaction_audit (user_id, action, transaction_id, txn_type, bucket_id, currency) VALUES ($1, $2, $3, $4, $5, $6)',
      auditRow(userId, action, txn)
    ), WRITE_TIMEOUT_MS);
    return true;
  } catch (error) {
    logger.warn('AUDIT_WRITE_FAILED', { requestId, action, reason: error.message.slice(0, 120) });
    return false;
  }
}

// "Delete my data" (PDPL): remove the user's audit rows, then keep one anonymous DELETE_ALL row
// so the admin can still see that an erasure happened, without knowing who.
async function eraseUser(logger, requestId, userId) {
  if (!enabled()) return 0;
  try {
    const rows = await withTimeout(query('DELETE FROM transaction_audit WHERE user_id = $1 RETURNING id', [userId]), WRITE_TIMEOUT_MS);
    await record(logger, requestId, ERASED_USER, 'DELETE_ALL');
    return rows.length;
  } catch (error) {
    logger.warn('AUDIT_ERASE_FAILED', { requestId, reason: error.message.slice(0, 120) });
    return -1;
  }
}

// Admin analytics with SQL: events per day and action, and totals, for the last `days` days.
// Counts only: no user ids, amounts or notes leave the database.
async function stats(days) {
  const [byDay, totals] = await Promise.all([
    query(
      `SELECT to_char(date_trunc('day', event_time), 'YYYY-MM-DD') AS day, action, count(*)::int AS events
         FROM transaction_audit
        WHERE event_time >= now() - make_interval(days => $1)
        GROUP BY 1, 2
        ORDER BY 1, 2`, [days]),
    query(
      `SELECT count(*)::int AS events,
              count(DISTINCT user_id) FILTER (WHERE user_id <> $2)::int AS active_users,
              count(*) FILTER (WHERE action = 'DELETE')::int AS deletes,
              count(*) FILTER (WHERE currency IS NOT NULL AND currency <> 'EGP')::int AS foreign_currency
         FROM transaction_audit
        WHERE event_time >= now() - make_interval(days => $1)`, [days, ERASED_USER])
  ]);
  const t = totals[0] || {};
  return {
    days,
    events: t.events || 0,
    activeUsers: t.active_users || 0,
    deletes: t.deletes || 0,
    foreignCurrencyEvents: t.foreign_currency || 0,
    byDay: byDay.map((r) => ({ day: r.day, action: r.action, events: r.events }))
  };
}

function useQuery(fn) {
  override = fn;
  sql = null;
}

module.exports = { enabled, record, eraseUser, stats, auditRow, useQuery, ACTIONS, ERASED_USER, WRITE_TIMEOUT_MS };
