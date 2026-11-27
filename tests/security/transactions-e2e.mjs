// End-to-end tests for the Transactions service, run against the app deployed on Floci (report §13).
// Owner: Salma. Test IDs: IT-04, IT-08, IT-09 (reserved for Transactions in the team plan) and
// IT-13 ... IT-16 (final-phase enhancements). Normal and invalid cases, across Transactions, Buckets,
// Insights, the exchange-rate API, S3 and Neon.
// IT-11 (exchange-rate API down) cannot be forced on a live deploy; it is covered by unit test TX-06.
// Each test prints expected vs actual and PASS/FAIL. Results are also written to evidence/integration-salma.md.
// No token, password, key or MFA secret is ever printed or saved: test passwords are random and kept in memory.
//
// Run (Floci running, app deployed):
//   node tests/security/transactions-e2e.mjs
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const AWS_ENV = { ...process.env, AWS_PROFILE: process.env.AWS_PROFILE || 'floci', AWS_PAGER: '', MSYS_NO_PATHCONV: '1' };
const sh = (cmd, env = AWS_ENV) => execSync(cmd, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const API = process.env.API || `http://${sh("aws apigatewayv2 get-apis --query \"Items[?Name=='pb-http-api'].ApiId | [0]\" --output text")}.execute-api.localhost.floci.io:4566`;
const totp = require('../../services/auth-service/lib/totp');
const results = [];

async function call(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(90000) });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const code = (r) => (r.data && r.data.error ? `${r.status} ${r.data.error.code}` : `${r.status}`);
function record(id, category, scenario, expected, actual, pass) {
  results.push({ id, category, scenario, expected, actual, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${scenario}\n      expected: ${expected}\n      actual:   ${actual}\n`);
}
const newPassword = () => `TestPass${crypto.randomBytes(5).toString('hex')}9`;
const today = new Date().toISOString().slice(0, 10);
const thisMonth = today.slice(0, 7);
const bucketIdOf = (r) => r.data && (r.data.id || (r.data.bucket && r.data.bucket.id));
const txnOf = (r) => r.data && r.data.transaction;

console.log(`Transactions end-to-end tests against ${API}\n`);

// ---------- set-up: one user with two buckets ----------
const email = `it-salma-${Date.now()}@example.com`;
const reg = await call('POST', '/api/auth/register', { body: { name: 'Salma End To End', email, password: newPassword() } });
const token = reg.data && reg.data.token;
if (!token) throw new Error(`set-up failed: could not register (${reg.status})`);
const fun = bucketIdOf(await call('POST', '/api/buckets', { token, body: { name: 'Fun', monthlyLimit: 5000 } }));
const food = bucketIdOf(await call('POST', '/api/buckets', { token, body: { name: 'Food', monthlyLimit: 8000 } }));
if (!fun || !food) throw new Error('set-up failed: could not create buckets');
console.log('Set-up: one user, buckets Fun (5,000 EGP) and Food (8,000 EGP)\n');

// ---------- IT-04 foreign-currency expense through the external API ----------
let usdTxn;
{
  const ok = await call('POST', '/api/transactions', { token, body: { type: 'expense', amount: 10, currency: 'USD', date: today, bucketId: fun, paymentMethod: 'cash', note: 'cinema IT-04' } });
  const bad = await call('POST', '/api/transactions', { token, body: { type: 'expense', amount: 10, currency: 'XYZ', date: today, bucketId: fun, paymentMethod: 'cash' } });
  usdTxn = txnOf(ok);
  const actual = `${ok.status} ${usdTxn && `${usdTxn.amount} ${usdTxn.currency} -> ${usdTxn.amountBase} ${usdTxn.baseCurrency} at ${usdTxn.rate} (${usdTxn.rateSource})`}; XYZ ${code(bad)}`;
  const pass = ok.status === 201 && usdTxn.currency === 'USD' && usdTxn.baseCurrency === 'EGP' && usdTxn.amountBase > 10 && Boolean(usdTxn.rateSource) && bad.status === 400;
  record('IT-04', 'Transactions + external API', 'Log 10 USD in Fun; then currency "XYZ"', '201 with amountBase = 10 x live rate; XYZ 400', actual, pass);
}

// ---------- IT-08 edit re-checks the budget with Buckets; date change refused ----------
{
  const edit = await call('PATCH', `/api/transactions/${usdTxn.id}`, { token, body: { amount: 200 } });
  const date = await call('PATCH', `/api/transactions/${usdTxn.id}`, { token, body: { date: '2026-01-01' } });
  const t = txnOf(edit);
  const state = edit.data && edit.data.budget && edit.data.budget.state;
  const actual = `edit ${edit.status} amount=${t && t.amount} USD (${t && t.amountBase} EGP), Fun state=${state}; date change ${code(date)}`;
  const pass = edit.status === 200 && t.amount === 200 && t.amountBase > 5000 && state === 'OVER_LIMIT' && date.status === 400;
  record('IT-08', 'Transactions -> Buckets', 'Change the expense from 10 to 200 USD (over the 5,000 EGP Fun limit); try to change the date',
    '200 and Fun OVER_LIMIT (soft limit warns, does not block); date change 400', actual, pass);
}

// ---------- IT-09 filters, list totals and the Insights dashboard agree ----------
{
  await call('POST', '/api/transactions', { token, body: { type: 'income', amount: 15000, date: today, paymentMethod: 'bank_transfer', note: 'salary IT-09' } });
  await call('POST', '/api/transactions', { token, body: { type: 'expense', amount: 300, date: today, bucketId: food, paymentMethod: 'card', note: 'groceries IT-09' } });
  const card = await call('GET', '/api/transactions?paymentMethod=card', { token });
  const list = await call('GET', '/api/transactions', { token });
  const dash = await call('GET', '/api/insights/dashboard', { token });
  const badMonth = await call('GET', '/api/transactions/summary?month=2026-13', { token });
  const onlyCard = card.status === 200 && card.data.items.length === 1 && card.data.items.every((t) => t.paymentMethod === 'card');
  const actual = `card filter ${card.status} items=${card.data.items && card.data.items.length} only card=${onlyCard}; ` +
    `list income=${list.data.totals && list.data.totals.income} expense=${list.data.totals && list.data.totals.expense}; ` +
    `dashboard ${dash.status} income=${dash.data.income} expense=${dash.data.expense}; month 2026-13 ${code(badMonth)}`;
  const pass = onlyCard && list.status === 200 && dash.status === 200 && list.data.totals.income === dash.data.income &&
    list.data.totals.expense === dash.data.expense && badMonth.status === 400;
  record('IT-09', 'Transactions + Insights', 'Add income 15,000 and a card expense 300; filter by card; compare the list totals with the dashboard; invalid month',
    'only card items; list totals equal the dashboard; 400', actual, pass);
}

// ---------- IT-13 double submit (enhancement C) ----------
{
  const body = { type: 'expense', amount: 45, date: today, bucketId: food, paymentMethod: 'cash', note: 'double click IT-13', clientRequestId: crypto.randomUUID() };
  const [a, b] = await Promise.all([call('POST', '/api/transactions', { token, body }), call('POST', '/api/transactions', { token, body })]);
  const unsafe = await call('POST', '/api/transactions', { token, body: { ...body, clientRequestId: '../../etc' } });
  const found = await call('GET', '/api/transactions?q=double%20click', { token });
  const statuses = [a.status, b.status].sort().join(' + ');
  const dup = [a, b].some((r) => r.data && r.data.duplicate === true);
  const actual = `${statuses}, duplicate flag=${dup}; saved ${found.data.total}; unsafe ticket ${code(unsafe)}`;
  const pass = statuses === '200 + 201' && dup && found.data.total === 1 && unsafe.status === 400;
  record('IT-13', 'Transactions (double submit)', 'The same expense sent twice at the same moment (double click); an unsafe ticket',
    '201 + 200 duplicate, 1 saved; unsafe ticket 400', actual, pass);
}

// ---------- IT-14 receipt end to end (enhancement 5e) ----------
{
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(200)]);
  const form = await call('POST', `/api/transactions/${usdTxn.id}/receipt`, { token, body: { contentType: 'image/png' } });
  let s3 = { status: 'not sent' };
  if (form.status === 201) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(form.data.fields)) fd.append(k, v);
    fd.append('file', new Blob([png]), 'receipt.png');
    s3 = await fetch(form.data.uploadUrl, { method: 'POST', body: fd });
  }
  const confirm = await call('POST', `/api/transactions/${usdTxn.id}/receipt/confirm`, { token });
  const link = await call('GET', `/api/transactions/${usdTxn.id}/receipt`, { token });
  let download = 'not tried';
  let same = false;
  if (link.status === 200) {
    const file = await fetch(link.data.downloadUrl);
    const bytes = Buffer.from(await file.arrayBuffer());
    download = file.status;
    same = bytes.equals(png);
  }
  const actual = `form ${form.status} (max ${form.data.maxBytes} bytes); S3 ${s3.status}; confirm ${confirm.status} hasReceipt=${confirm.data && confirm.data.hasReceipt}; ` +
    `link ${link.status} expires in ${link.data && link.data.expiresIn}s; download ${download}, same file=${same}`;
  const pass = form.status === 201 && s3.status >= 200 && s3.status < 300 && confirm.status === 200 && confirm.data.hasReceipt === true && link.status === 200 && download === 200 && same;
  record('IT-14', 'Transactions + S3 (receipts)', 'Ask for an upload form, upload a real PNG to S3, confirm it, open it through the short-lived link',
    '201; S3 2xx; 200 hasReceipt; 200 link; download 200 with the same file', actual, pass);
}

// ---------- IT-15 Neon audit trail and admin analytics (enhancement 1b) ----------
{
  const asUser = await call('GET', '/api/transactions/admin/audit-stats?days=1', { token });
  const admin = { email: `it-salma-admin-${Date.now()}@example.com`, password: newPassword() };
  sh('node services/auth-service/scripts/seed-admin.js', {
    ...AWS_ENV, USERS_TABLE: 'PBUsers', AWS_REGION: 'us-east-1', AWS_ENDPOINT_URL: 'http://localhost:4566',
    ADMIN_EMAIL: admin.email, ADMIN_PASSWORD: admin.password
  });
  // Admins must set up two-step login (5a) before they get a token.
  const first = await call('POST', '/api/auth/login', { body: admin });
  const setup = await call('POST', '/api/auth/mfa/setup', { token: first.data.mfaToken });
  const enable = await call('POST', '/api/auth/mfa/enable', { token: first.data.mfaToken, body: { code: totp.codeAt(setup.data.secret) } });
  const stats = await call('GET', '/api/transactions/admin/audit-stats?days=1', { token: enable.data.token });
  const badDays = await call('GET', '/api/transactions/admin/audit-stats?days=500', { token: enable.data.token });
  const s = stats.data || {};
  const actions = [...new Set((s.byDay || []).map((r) => r.action))].sort().join(',');
  const leaks = /user_?id|amount|note/i.test(JSON.stringify(s));
  const actual = `normal user ${code(asUser)}; admin ${stats.status} source=${s.source} events=${s.events} activeUsers=${s.activeUsers} actions=${actions}; ` +
    `user ids/amounts/notes in the answer=${leaks}; days=500 ${code(badDays)}`;
  const pass = asUser.status === 403 && stats.status === 200 && s.source === 'neon' && s.events > 0 && actions.includes('CREATE') && actions.includes('UPDATE') &&
    !leaks && badDays.status === 400;
  record('IT-15', 'Transactions + Neon (audit)', 'Normal user and admin ask for the audit analytics; admin asks for 500 days',
    "403; 200 from Neon with counts per action (CREATE, UPDATE...), no user ids, amounts or notes; 400", actual, pass);
}

// ---------- IT-16 download my data / delete my data (enhancement 5f) ----------
{
  const exp = await call('GET', '/api/transactions/me/export', { token });
  const internal = JSON.stringify(exp.data.transactions || []).match(/"(pk|sk|receiptKey)"/);
  const noConfirm = await call('DELETE', '/api/transactions/me', { token, body: {} });
  const del = await call('DELETE', '/api/transactions/me', { token, body: { confirm: true } });
  const after = await call('GET', '/api/transactions', { token });
  const d = del.data || {};
  const actual = `export ${exp.status} count=${exp.data.count}, internal fields=${internal ? internal[1] : 'none'}; no confirm ${code(noConfirm)}; ` +
    `delete ${del.status}: transactions ${d.deletedTransactions}, receipts ${d.deletedReceipts}, audit rows ${d.deletedAuditRows}; list afterwards total=${after.data.total}`;
  // 4 transactions were saved above: the USD expense, the income, the card expense and the double-click expense
  const pass = exp.status === 200 && exp.data.count === 4 && !internal && noConfirm.status === 400 && del.status === 200 &&
    d.deletedTransactions === 4 && d.deletedReceipts === 1 && d.deletedAuditRows > 0 && after.data.total === 0;
  record('IT-16', 'Transactions + S3 + Neon (privacy)', 'Export my data; delete without confirm; delete with confirm; list again',
    '200 with 4 transactions and no internal fields; 400; 200 deletes 4 transactions, 1 receipt and the audit rows; 0 left', actual, pass);
}

// ---------- summary + evidence file ----------
const passed = results.filter((r) => r.pass).length;
console.log(`${passed} of ${results.length} tests passed`);
mkdirSync('evidence', { recursive: true });
const md = [
  '# End-to-end tests: Transactions service (Salma), run on Floci',
  '',
  `Run: ${new Date().toISOString()} against ${API}. Script: tests/security/transactions-e2e.mjs (month ${thisMonth})`,
  '',
  '| Test ID | Category | Scenario | Expected | Actual | Pass/Fail |',
  '|---|---|---|---|---|---|',
  ...results.map((r) => `| ${r.id} | ${r.category} | ${r.scenario} | ${r.expected} | ${r.actual} | ${r.pass ? 'Pass' : 'Fail'} |`),
  '',
  `${passed} of ${results.length} passed. IT-11 (exchange-rate API down) is covered by unit test TX-06.`
].join('\n');
writeFileSync('evidence/integration-salma.md', `${md}\n`);
console.log('Results saved to evidence/integration-salma.md');
process.exit(passed === results.length ? 0 : 1);
