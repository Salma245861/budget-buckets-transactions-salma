// Transactions service (owner: [TEAMMATE 1]).
// Business capability: record income and expenses quickly and find them again.
//
// Table PBTransactions (env TRANSACTIONS_TABLE):
//   pk USER#<uid>   sk TXN#<id>     id = <YYYYMMDD>-<random>, so the sort key is ordered by date
//   -> a date-range filter is ONE DynamoDB Query with "sk BETWEEN TXN#20261101 AND TXN#20261130~"
//
// Works with the Buckets service: every expense is checked (POST /api/buckets/:id/check-spend)
// before it is saved and evaluated (POST /api/buckets/:id/evaluate) after it is saved.
const crypto = require('crypto');
const express = require('express');
const {
  createStore, createAuth, validate, wrap, errors, checkId, callService, queryInt, queryEnum,
  parseDay, parseMonth, today, currentMonth, monthRange, daysBetween, monthsBetween, addMonths, round2
} = require('pb-common');
const fx = require('../lib/fx');
const receipts = require('../lib/receipts');
const privacy = require('../lib/privacy');
const idempotency = require('../lib/idempotency');

const CURRENCIES = ['EGP', 'USD', 'EUR', 'GBP', 'SAR', 'AED', 'KWD'];
const PAYMENT_METHODS = ['cash', 'card', 'bank_transfer', 'mobile_wallet'];
const TYPES = ['income', 'expense'];
const RECEIPT_TYPES = ['image/jpeg', 'image/png', 'application/pdf'];
const ID = /^[A-Za-z0-9_-]{6,64}$/;

const createSchema = {
  type: { type: 'string', required: true, enum: TYPES },
  amount: { type: 'number', required: true, min: 0.01, max: 10000000, decimals: 2 },
  currency: { type: 'string', enum: CURRENCIES, upper: true },
  date: { type: 'string', required: true },
  bucketId: { type: 'string', pattern: ID, patternMessage: 'bucketId is not valid.' },
  paymentMethod: { type: 'string', required: true, enum: PAYMENT_METHODS },
  note: { type: 'string', maxLength: 200 },
  clientRequestId: { type: 'string', pattern: idempotency.CLIENT_ID, patternMessage: 'clientRequestId is not valid.' }
};
const updateSchema = {
  amount: createSchema.amount,
  currency: createSchema.currency,
  bucketId: createSchema.bucketId,
  paymentMethod: { type: 'string', enum: PAYMENT_METHODS },
  note: createSchema.note
};

function publicTxn(t) {
  const { pk, sk, receiptKey, receiptPendingType, ...rest } = t;
  return { ...rest, hasReceipt: Boolean(receiptKey) };
}

const tomorrow = () => new Date(Date.now() + 86400000).toISOString().slice(0, 10);
const skRange = (from, to) => [`TXN#${from.replace(/-/g, '')}`, `TXN#${to.replace(/-/g, '')}~`];

function createTransactionRoutes(logger) {
  const store = createStore('TRANSACTIONS_TABLE');
  fx.useSharedCache(store); // enhancement B: one shared exchange-rate cache for all Lambda copies
  const { requireAuth, requireRole } = createAuth(logger);
  const router = express.Router();
  router.use(requireAuth);

  const userPk = (req) => `USER#${req.user.id}`;

  async function loadTxn(req, id) {
    checkId(id, 'transaction id');
    const txn = await store.get(userPk(req), `TXN#${id}`);
    if (!txn) {
      logger.warn('TXN_NOT_FOUND_OR_NOT_OWNED', { requestId: req.requestId, userId: req.user.id, transactionId: id });
      throw errors.notFound('Transaction');
    }
    return txn;
  }

  // Ask the Buckets service whether the expense fits the bucket budget
  async function checkSpend(req, bucketId, amountBase, date, replacingAmount = 0) {
    const r = await callService('buckets', {
      method: 'POST',
      path: `/api/buckets/${bucketId}/check-spend`,
      body: { amount: amountBase, date, replacingAmount },
      authHeader: req.authHeader,
      requestId: req.requestId
    });
    if (r.status === 404) throw errors.badRequest('bucketId does not refer to one of your buckets.');
    if (r.status === 409) throw errors.conflict('BUCKET_ARCHIVED', 'This bucket is archived and cannot receive new expenses.');
    if (r.status !== 200) {
      logger.error('DEPENDENCY_ERROR', { requestId: req.requestId, target: 'buckets', status: r.status });
      throw errors.unavailable('DEPENDENCY_ERROR', 'The budget check is not available right now.');
    }
    if (!r.body.allowed) {
      throw errors.unprocessable('BUDGET_HARD_LIMIT',
        `This expense would exceed the hard limit of "${r.body.bucket.name}" (${r.body.effectiveLimit}).`,
        { remaining: r.body.spentBefore <= r.body.effectiveLimit ? round2(r.body.effectiveLimit - r.body.spentBefore) : 0 });
    }
    return r.body;
  }

  // After saving: let the Buckets service raise alerts (failure here must not lose the transaction)
  async function evaluate(req, bucketId, date) {
    try {
      const r = await callService('buckets', {
        method: 'POST', path: `/api/buckets/${bucketId}/evaluate`, body: { month: date.slice(0, 7) },
        authHeader: req.authHeader, requestId: req.requestId
      });
      return r.status === 200 ? r.body : null;
    } catch (error) {
      logger.warn('BUDGET_EVALUATE_FAILED', { requestId: req.requestId, bucketId });
      return null;
    }
  }

  // ----- admin statistics (aggregated counts only) -----
  router.get('/admin/stats', requireRole('admin'), wrap(async (req, res) => {
    const all = await store.scan({ prefix: 'TXN#' });
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const byPaymentMethod = Object.fromEntries(PAYMENT_METHODS.map((m) => [m, 0]));
    const byType = { income: 0, expense: 0 };
    for (const t of all) {
      byPaymentMethod[t.paymentMethod] = (byPaymentMethod[t.paymentMethod] || 0) + 1;
      byType[t.type] += 1;
    }
    res.status(200).json({
      transactions: all.length,
      last30Days: all.filter((t) => t.createdAt >= since).length,
      activeUsers30Days: new Set(all.filter((t) => t.createdAt >= since).map((t) => t.userId)).size,
      foreignCurrency: all.filter((t) => t.currency !== t.baseCurrency).length,
      byPaymentMethod,
      byType
    });
  }));

  // ----- external API preview -----
  router.get('/fx-rate', wrap(async (req, res) => {
    const from = queryEnum(String(req.query.from || '').toUpperCase(), 'from', CURRENCIES);
    if (!from) throw errors.badRequest('from is required.');
    const to = req.user.baseCurrency;
    const result = await fx.convert(1, from, to, logger, req.requestId);
    res.status(200).json({ from, to, rate: result.rate, source: result.rateSource, updated: result.rateDate });
  }));

  // ----- summary used by Buckets and Insights -----
  router.get('/summary', wrap(async (req, res) => {
    let fromMonth;
    let toMonth;
    if (req.query.month) {
      fromMonth = parseMonth(req.query.month);
      toMonth = fromMonth;
    } else {
      toMonth = parseMonth(req.query.toMonth, 'toMonth', { def: currentMonth() });
      fromMonth = parseMonth(req.query.fromMonth, 'fromMonth', { def: toMonth });
    }
    const span = monthsBetween(fromMonth, toMonth);
    if (span < 0) throw errors.badRequest('fromMonth must not be after toMonth.');
    if (span > 11) throw errors.badRequest('A summary can cover at most 12 months.');

    const items = await store.query(userPk(req), { between: skRange(monthRange(fromMonth).from, monthRange(toMonth).to) });
    const months = {};
    for (let m = fromMonth; m <= toMonth; m = addMonths(m, 1)) {
      months[m] = { income: 0, expense: 0, net: 0, count: 0, byBucket: {}, byPaymentMethod: {}, byDay: {} };
    }
    for (const t of items) {
      const m = months[t.date.slice(0, 7)];
      if (!m) continue;
      m.count += 1;
      m[t.type] = round2(m[t.type] + t.amountBase);
      if (t.type === 'expense') {
        if (t.bucketId) m.byBucket[t.bucketId] = round2((m.byBucket[t.bucketId] || 0) + t.amountBase);
        m.byPaymentMethod[t.paymentMethod] = round2((m.byPaymentMethod[t.paymentMethod] || 0) + t.amountBase);
        m.byDay[t.date] = round2((m.byDay[t.date] || 0) + t.amountBase);
      }
    }
    for (const m of Object.values(months)) m.net = round2(m.income - m.expense);
    res.status(200).json({ fromMonth, toMonth, baseCurrency: req.user.baseCurrency, months });
  }));

  // ----- count of transactions in a bucket (used before a bucket is deleted) -----
  router.get('/by-bucket/:bucketId/count', wrap(async (req, res) => {
    const bucketId = checkId(req.params.bucketId, 'bucket id');
    const items = await store.query(userPk(req), { prefix: 'TXN#' });
    res.status(200).json({ bucketId, count: items.filter((t) => t.bucketId === bucketId).length });
  }));

  // 1. Log an income or expense
  router.post('/', wrap(async (req, res) => {
    const input = validate(req.body, createSchema);
    const date = parseDay(input.date);
    if (date > tomorrow()) throw errors.badRequest('date cannot be in the future.');
    if (input.type === 'expense' && !input.bucketId) throw errors.badRequest('bucketId is required for an expense.');
    if (input.type === 'income' && input.bucketId) throw errors.badRequest('Income is not linked to a spending bucket.');

    // Double-submit protection (enhancement C): the same clientRequestId always gives the same id
    const id = idempotency.transactionId(date, req.user.id, input.clientRequestId);
    const duplicateOf = async () => {
      const first = await store.get(userPk(req), `TXN#${id}`);
      if (!first) return false;
      logger.info('TRANSACTION_DUPLICATE_IGNORED', { requestId: req.requestId, userId: req.user.id, transactionId: id });
      res.status(200).json({ transaction: publicTxn(first), budget: null, alertRaised: false, duplicate: true });
      return true;
    };
    if (input.clientRequestId && await duplicateOf()) return;

    const currency = input.currency || req.user.baseCurrency;
    const conversion = await fx.convert(input.amount, currency, req.user.baseCurrency, logger, req.requestId);

    let check = null;
    if (input.type === 'expense') check = await checkSpend(req, input.bucketId, conversion.amountBase, date);

    const now = new Date().toISOString();
    const txn = {
      pk: userPk(req), sk: `TXN#${id}`, id, userId: req.user.id, type: input.type,
      amount: round2(input.amount), currency, baseCurrency: req.user.baseCurrency,
      amountBase: conversion.amountBase, rate: conversion.rate, rateSource: conversion.rateSource, rateDate: conversion.rateDate,
      date, bucketId: input.bucketId || null, bucketName: check ? check.bucket.name : null,
      paymentMethod: input.paymentMethod, note: input.note || '', receiptKey: null, createdAt: now, updatedAt: now
    };
    // ifNotExists: if two copies arrive at the same moment, only the first one is saved
    if (!(await store.put(txn, { ifNotExists: true }))) {
      if (await duplicateOf()) return;
      throw errors.conflict('TRANSACTION_EXISTS', 'This transaction was already saved.');
    }
    logger.info('TRANSACTION_CREATED', { requestId: req.requestId, userId: req.user.id, transactionId: id, type: txn.type, foreign: currency !== txn.baseCurrency });

    const budget = txn.bucketId ? await evaluate(req, txn.bucketId, date) : null;
    res.status(201).json({ transaction: publicTxn(txn), budget: budget ? budget.budget : null, alertRaised: budget ? budget.alertRaised : false });
  }));

  // 2. Find transactions with filters
  router.get('/', wrap(async (req, res) => {
    const range = monthRange(currentMonth());
    const from = parseDay(req.query.from, 'from', { def: range.from });
    const to = parseDay(req.query.to, 'to', { def: today() > range.to ? range.to : today() });
    if (from > to) throw errors.badRequest('from must not be after to.');
    if (daysBetween(from, to) > 366) throw errors.badRequest('The date range can be at most 366 days.');
    const type = queryEnum(req.query.type, 'type', TYPES);
    const paymentMethod = queryEnum(req.query.paymentMethod, 'paymentMethod', PAYMENT_METHODS);
    const bucketId = req.query.bucketId ? checkId(req.query.bucketId, 'bucketId') : undefined;
    const q = req.query.q ? String(req.query.q).trim().toLowerCase().slice(0, 50) : '';
    const limit = queryInt(req.query.limit, 'limit', { min: 1, max: 500, def: 100 });

    let items = await store.query(userPk(req), { between: skRange(from, to), desc: true });
    items = items.filter((t) => (!type || t.type === type)
      && (!paymentMethod || t.paymentMethod === paymentMethod)
      && (!bucketId || t.bucketId === bucketId)
      && (!q || t.note.toLowerCase().includes(q)));
    const totals = items.reduce((acc, t) => { acc[t.type] = round2(acc[t.type] + t.amountBase); return acc; }, { income: 0, expense: 0 });
    totals.net = round2(totals.income - totals.expense);
    const page = items.slice(0, limit).map(publicTxn);
    res.status(200).json({ from, to, items: page, count: page.length, total: items.length, totals, baseCurrency: req.user.baseCurrency });
  }));

  // ----- Privacy rights (enhancement 5f, Salma): download my data / delete my data -----
  // Placed before "/:id" so "me" is not read as a transaction id.
  router.get('/me/export', wrap(async (req, res) => {
    const items = await store.query(userPk(req), { prefix: 'TXN#' });
    logger.info('PRIVACY_EXPORT', { requestId: req.requestId, userId: req.user.id, count: items.length });
    res.set('Content-Disposition', 'attachment; filename="my-transactions.json"');
    res.status(200).json({
      service: 'transactions', exportedAt: new Date().toISOString(), userId: req.user.id,
      baseCurrency: req.user.baseCurrency, count: items.length, transactions: privacy.exportView(items)
    });
  }));

  router.delete('/me', wrap(async (req, res) => {
    // Must be asked for explicitly, so a stray request cannot wipe someone's history
    const { confirm } = validate(req.body || {}, { confirm: { type: 'boolean', required: true } });
    if (confirm !== true) throw errors.badRequest('Send {"confirm": true} to delete all your transactions.');
    const items = await store.query(userPk(req), { prefix: 'TXN#' });
    let receiptsDeleted = 0;
    let receiptsFailed = 0;
    if (receipts.enabled()) {
      for (const key of privacy.receiptKeysToDelete(items, req.user.id, receipts)) {
        try { await receipts.removeObject(key); receiptsDeleted += 1; } catch (error) { receiptsFailed += 1; }
      }
    }
    for (const t of items) await store.remove(t.pk, t.sk);
    logger.info('PRIVACY_DELETE', {
      requestId: req.requestId, userId: req.user.id, transactions: items.length, receiptsDeleted, receiptsFailed
    });
    res.status(200).json({ service: 'transactions', deletedTransactions: items.length, deletedReceipts: receiptsDeleted, receiptErrors: receiptsFailed });
  }));

  router.get('/:id', wrap(async (req, res) => {
    res.status(200).json(publicTxn(await loadTxn(req, req.params.id)));
  }));

  // 3. Edit a transaction (date and type are fixed: delete and log again to change them)
  router.patch('/:id', wrap(async (req, res) => {
    if (req.body && (req.body.date !== undefined || req.body.type !== undefined)) {
      throw errors.badRequest('date and type cannot be changed. Delete the transaction and log it again.');
    }
    const txn = await loadTxn(req, req.params.id);
    const changes = validate(req.body, updateSchema, { partial: true });
    if (txn.type === 'income' && changes.bucketId) throw errors.badRequest('Income is not linked to a spending bucket.');

    const amount = changes.amount !== undefined ? changes.amount : txn.amount;
    const currency = changes.currency || txn.currency;
    let conversion = { amountBase: txn.amountBase, rate: txn.rate, rateSource: txn.rateSource, rateDate: txn.rateDate };
    if (changes.currency && changes.currency !== txn.currency) {
      conversion = await fx.convert(amount, currency, txn.baseCurrency, logger, req.requestId);
    } else if (changes.amount !== undefined) {
      conversion = { ...conversion, amountBase: round2(amount * txn.rate) };
    }

    const bucketId = changes.bucketId || txn.bucketId;
    let bucketName = txn.bucketName;
    if (txn.type === 'expense' && (conversion.amountBase !== txn.amountBase || bucketId !== txn.bucketId)) {
      const replacing = bucketId === txn.bucketId ? txn.amountBase : 0;
      const check = await checkSpend(req, bucketId, conversion.amountBase, txn.date, replacing);
      bucketName = check.bucket.name;
    }
    const updated = await store.update(txn.pk, txn.sk, {
      amount: round2(amount), currency, ...conversion, bucketId, bucketName,
      paymentMethod: changes.paymentMethod || txn.paymentMethod,
      note: changes.note !== undefined ? changes.note : txn.note,
      updatedAt: new Date().toISOString()
    });
    logger.info('TRANSACTION_UPDATED', { requestId: req.requestId, userId: req.user.id, transactionId: txn.id, fields: Object.keys(changes) });
    const budget = updated.bucketId ? await evaluate(req, updated.bucketId, updated.date) : null;
    res.status(200).json({ transaction: publicTxn(updated), budget: budget ? budget.budget : null });
  }));

  // 4. Delete (also removes the receipt file)
  router.delete('/:id', wrap(async (req, res) => {
    const txn = await loadTxn(req, req.params.id);
    if (txn.receiptKey && receipts.enabled()) {
      try { await receipts.removeObject(txn.receiptKey); } catch (error) {
        logger.warn('RECEIPT_DELETE_FAILED', { requestId: req.requestId, transactionId: txn.id });
      }
    }
    await store.remove(txn.pk, txn.sk);
    logger.info('TRANSACTION_DELETED', { requestId: req.requestId, userId: req.user.id, transactionId: txn.id });
    res.status(204).end();
  }));

  // 5. Receipts: safe uploads (enhancement 5e, Salma)
  //    Step 1: the browser asks for an upload form. S3 itself will refuse files over 5 MB
  //            or with a different Content-Type than the one declared here.
  router.post('/:id/receipt', wrap(async (req, res) => {
    const txn = await loadTxn(req, req.params.id);
    const { contentType } = validate(req.body, { contentType: { type: 'string', required: true, enum: RECEIPT_TYPES } });
    if (!receipts.enabled()) {
      const e = errors.unavailable('RECEIPTS_NOT_CONFIGURED', 'Receipt storage (S3) is not configured in this environment.');
      e.status = 501;
      throw e;
    }
    // The file goes to a waiting spot; an existing receipt stays until the new one passes (step 2)
    const form = await receipts.uploadForm(receipts.pendingKeyFor(req.user.id, txn.id), contentType);
    await store.update(txn.pk, txn.sk, { receiptPendingType: contentType, updatedAt: new Date().toISOString() });
    logger.info('RECEIPT_UPLOAD_FORM_ISSUED', { requestId: req.requestId, userId: req.user.id, transactionId: txn.id });
    res.status(201).json({
      uploadUrl: form.url, method: 'POST', fields: form.fields, contentType,
      maxBytes: receipts.MAX_BYTES, expiresIn: receipts.URL_TTL_SEC
    });
  }));

  //    Step 2: after uploading, the browser asks the service to check the file.
  //            The first bytes must really be the declared type, otherwise the file is deleted.
  router.post('/:id/receipt/confirm', wrap(async (req, res) => {
    const txn = await loadTxn(req, req.params.id);
    if (!txn.receiptPendingType) throw errors.conflict('NO_RECEIPT_UPLOAD', 'Ask for an upload form before confirming a receipt.');
    if (!receipts.enabled()) throw errors.unavailable('RECEIPTS_NOT_CONFIGURED', 'Receipt storage (S3) is not configured.');
    const key = receipts.keyFor(req.user.id, txn.id);
    const pendingKey = receipts.pendingKeyFor(req.user.id, txn.id);
    let bytes;
    try {
      bytes = await receipts.readStart(pendingKey);
    } catch (error) {
      if (error.name === 'NoSuchKey' || (error.$metadata && error.$metadata.httpStatusCode === 404)) {
        throw errors.badRequest('The receipt file was not uploaded.');
      }
      throw error;
    }
    const realType = receipts.sniffType(bytes);
    if (realType !== txn.receiptPendingType) {
      try { await receipts.removeObject(pendingKey); } catch (error) {
        logger.warn('RECEIPT_DELETE_FAILED', { requestId: req.requestId, transactionId: txn.id });
      }
      // Only the rejected upload is removed; an earlier, checked receipt is kept
      await store.update(txn.pk, txn.sk, { receiptPendingType: null, updatedAt: new Date().toISOString() });
      logger.warn('RECEIPT_REJECTED', {
        requestId: req.requestId, userId: req.user.id, transactionId: txn.id,
        declared: txn.receiptPendingType, detected: realType || 'unknown'
      });
      throw errors.unprocessable('RECEIPT_TYPE_MISMATCH', 'This file is not a real JPEG, PNG or PDF, so it was deleted.');
    }
    await receipts.promote(pendingKey, key);
    const updated = await store.update(txn.pk, txn.sk, {
      receiptKey: key, receiptContentType: realType, receiptPendingType: null, updatedAt: new Date().toISOString()
    });
    logger.info('RECEIPT_ATTACHED', { requestId: req.requestId, userId: req.user.id, transactionId: txn.id, type: realType });
    res.status(200).json(publicTxn(updated));
  }));

  router.get('/:id/receipt', wrap(async (req, res) => {
    const txn = await loadTxn(req, req.params.id);
    if (!txn.receiptKey) throw errors.notFound('Receipt');
    if (!receipts.enabled()) throw errors.unavailable('RECEIPTS_NOT_CONFIGURED', 'Receipt storage (S3) is not configured.');
    res.status(200).json({ downloadUrl: await receipts.downloadUrl(txn.receiptKey), expiresIn: receipts.URL_TTL_SEC });
  }));

  return router;
}

module.exports = { createTransactionRoutes, CURRENCIES, PAYMENT_METHODS };
