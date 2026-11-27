// Security tests for the Transactions service, run against the app deployed on Floci.
// Owner: Salma. Tests: ST-01, ST-02, ST-06, ST-11, ST-14 (report §12) plus ST-16, ST-17 (receipt uploads).
// Each test prints expected vs actual and PASS/FAIL. Results are also written to evidence/security-salma.md.
// No token, password or key is ever printed or saved.
//
// Run (Floci running, app deployed):
//   node tests/security/transactions-security.mjs
//   API=http://<api-id>.execute-api.localhost.floci.io:4566 node tests/security/transactions-security.mjs
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';

const API = process.env.API || 'http://5b5e788b2e.execute-api.localhost.floci.io:4566';
const AWS_ENV = { ...process.env, AWS_PROFILE: process.env.AWS_PROFILE || 'floci', AWS_PAGER: '', MSYS_NO_PATHCONV: '1' };
const results = [];

async function call(method, path, { token, body, raw, type = 'application/json' } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined || raw !== undefined) headers['Content-Type'] = type;
  const res = await fetch(API + path, { method, headers, body: raw !== undefined ? raw : (body !== undefined ? JSON.stringify(body) : undefined) });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

function record(id, category, scenario, expected, actual, pass) {
  results.push({ id, category, scenario, expected, actual, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${scenario}\n      expected: ${expected}\n      actual:   ${actual}\n`);
}

async function testUser(label) {
  const email = `st-${label}-${Date.now()}@example.com`;
  const password = `TestPass${crypto.randomBytes(4).toString('hex')}9`; // random test password, never printed
  await call('POST', '/api/auth/register', { body: { name: `Security Test ${label.toUpperCase()}`, email, password } });
  const login = await call('POST', '/api/auth/login', { body: { email, password } });
  if (!login.data || !login.data.token) throw new Error(`could not log in test user ${label} (${login.status})`);
  return login.data.token;
}

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

console.log(`Transactions security tests against ${API}\n`);

// ---------- set-up: two users, A owns a bucket and an expense ----------
const tokenA = await testUser('a');
const tokenB = await testUser('b');
const bucket = await call('POST', '/api/buckets', { token: tokenA, body: { name: 'Security test', monthlyLimit: 5000 } });
const bucketId = bucket.data && (bucket.data.id || (bucket.data.bucket && bucket.data.bucket.id));
const today = new Date().toISOString().slice(0, 10);
const created = await call('POST', '/api/transactions', {
  token: tokenA, body: { type: 'expense', amount: 75, date: today, bucketId, paymentMethod: 'cash', note: 'owned by A' }
});
const txnA = created.data && created.data.transaction && created.data.transaction.id;
if (!txnA) throw new Error(`set-up failed: could not create A's transaction (${created.status})`);
console.log(`Set-up: users A and B created; A owns transaction ${txnA}\n`);

// ---------- ST-01 unauthenticated access ----------
{
  const r = await Promise.all([
    call('GET', '/api/transactions'),
    call('POST', '/api/transactions', { body: { type: 'income', amount: 1, date: today, paymentMethod: 'cash' } }),
    call('GET', `/api/transactions/${txnA}`),
    call('GET', '/api/transactions/me/export')
  ]);
  const actual = r.map((x) => x.status).join(', ');
  record('ST-01', 'Unauthenticated access', 'No token: list, create, read one, export my data', '401, 401, 401, 401', actual, r.every((x) => x.status === 401));
}

// ---------- ST-02 tampered / forged tokens ----------
{
  const [h, p, s] = tokenA.split('.');
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  const changedSig = `${h}.${p}.${s.slice(0, -4)}${s.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA'}`;
  const roleAdmin = `${h}.${b64url({ ...claims, role: 'admin' })}.${s}`;
  const algNone = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ ...claims, role: 'admin' })}.`;
  const r = await Promise.all([
    call('GET', '/api/transactions', { token: changedSig }),
    call('GET', '/api/transactions/admin/stats', { token: roleAdmin }),
    call('GET', '/api/transactions/admin/stats', { token: algNone }),
    call('GET', '/api/transactions', { token: 'not-a-real-token' })
  ]);
  const actual = r.map((x) => x.status).join(', ');
  record('ST-02', 'Authentication', 'Changed signature; role changed to admin; alg "none"; garbage token', '401, 401, 401, 401', actual, r.every((x) => x.status === 401));
}

// ---------- ST-06 ownership (IDOR) ----------
{
  const r = await Promise.all([
    call('GET', `/api/transactions/${txnA}`, { token: tokenB }),
    call('PATCH', `/api/transactions/${txnA}`, { token: tokenB, body: { note: 'changed by B' } }),
    call('DELETE', `/api/transactions/${txnA}`, { token: tokenB }),
    call('GET', `/api/transactions/${txnA}/receipt`, { token: tokenB })
  ]);
  const still = await call('GET', `/api/transactions/${txnA}`, { token: tokenA });
  const unchanged = still.status === 200 && still.data.note === 'owned by A';
  const actual = `${r.map((x) => x.status).join(', ')}; A's transaction afterwards: ${still.status}, ${unchanged ? 'unchanged' : 'CHANGED'}`;
  record('ST-06', 'Ownership (IDOR)', "User B reads, edits, deletes and opens the receipt of A's transaction", "404, 404, 404, 404; A's transaction unchanged", actual,
    r.every((x) => x.status === 404) && unchanged);
}

// ---------- ST-11 oversized body and wrong content type ----------
{
  const big = await call('POST', '/api/transactions', {
    token: tokenA, raw: JSON.stringify({ type: 'income', amount: 1, date: today, paymentMethod: 'cash', note: 'x'.repeat(50000) })
  });
  const text = await call('POST', '/api/transactions', { token: tokenA, raw: 'type=income&amount=1', type: 'text/plain' });
  record('ST-11', 'Invalid input', '50 KB JSON body; text/plain body', '413; 415', `${big.status}; ${text.status}`, big.status === 413 && text.status === 415);
}

// ---------- ST-16 / ST-17 receipt uploads ----------
async function upload(bytes) {
  const form = await call('POST', `/api/transactions/${txnA}/receipt`, { token: tokenA, body: { contentType: 'image/png' } });
  if (form.status !== 201) return `form ${form.status}`;
  const fd = new FormData();
  for (const [k, v] of Object.entries(form.data.fields)) fd.append(k, v);
  fd.append('file', new Blob([bytes]), 'receipt.png');
  const s3 = await fetch(form.data.uploadUrl, { method: 'POST', body: fd });
  if (!s3.ok) return `storage ${s3.status}`;
  const confirm = await call('POST', `/api/transactions/${txnA}/receipt/confirm`, { token: tokenA });
  return `confirm ${confirm.status}${confirm.data && confirm.data.error ? ` ${confirm.data.error.code}` : ''}`;
}
{
  const fake = await upload(new TextEncoder().encode('I am not really a picture'));
  record('ST-16', 'Invalid input (upload)', 'Text file sent as a PNG receipt', 'confirm 422 RECEIPT_TYPE_MISMATCH (file deleted)', fake, fake === 'confirm 422 RECEIPT_TYPE_MISMATCH');
  const huge = await upload(new Uint8Array(6 * 1024 * 1024));
  record('ST-17', 'Invalid input (upload)', '6 MB receipt', 'storage 400 (refused by S3 before it is saved)', huge, huge === 'storage 400');
}

// ---------- ST-14 secret exposure review ----------
{
  const problems = [];
  const sh = (cmd) => { try { return execSync(cmd, { encoding: 'utf8', env: AWS_ENV, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return e.stdout || ''; } };
  // 1. no .env file is tracked by Git (only .env.example is allowed)
  const envFiles = sh('git ls-files').split('\n').filter((f) => /(^|\/)\.env($|\.)/.test(f) && !f.endsWith('.env.example'));
  if (envFiles.length) problems.push(`tracked env files: ${envFiles.join(', ')}`);
  // 2. .gitignore excludes .env
  if (!/^\.env$/m.test(sh('git show HEAD:.gitignore'))) problems.push('.gitignore does not list .env');
  // 3. no AWS keys, private keys or login tokens anywhere in the history of this branch
  const pattern = 'AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY|eyJ[A-Za-z0-9_-]{15,}\\.eyJ';
  const commits = sh('git rev-list HEAD').trim().split('\n').filter(Boolean);
  const hits = commits.length ? sh(`git grep -I -l -E "${pattern}" ${commits.join(' ')}`).trim() : '';
  if (hits) problems.push(`possible secrets in history: ${hits.split('\n').slice(0, 3).join('; ')}`);
  // 4. the Transactions Lambda logs contain no token or password (checked after all the tests above)
  const logs = sh('aws logs tail /aws/lambda/pb-transactions-api --since 30m');
  const leak = [tokenA, tokenB].some((t) => logs.includes(t.split('.')[2])) || /Bearer\s+eyJ|"password"\s*:/i.test(logs);
  if (leak) problems.push('a token or password appears in the CloudWatch logs');
  const checked = `${commits.length} commits, ${logs.split('\n').length} log lines`;
  record('ST-14', 'Secret exposure review', 'Tracked .env files; .gitignore; keys and tokens in the whole Git history; tokens or passwords in CloudWatch logs',
    'nothing found', problems.length ? problems.join(' | ') : `nothing found (${checked})`, problems.length === 0);
}

// ---------- summary + evidence file ----------
const passed = results.filter((r) => r.pass).length;
console.log(`${passed} of ${results.length} tests passed`);
mkdirSync('evidence', { recursive: true });
const md = [
  '# Security tests: Transactions service (Salma), run on Floci',
  '',
  `Run: ${new Date().toISOString()} against ${API}. Script: tests/security/transactions-security.mjs`,
  '',
  '| Test ID | Category | Scenario | Expected | Actual | Pass/Fail |',
  '|---|---|---|---|---|---|',
  ...results.map((r) => `| ${r.id} | ${r.category} | ${r.scenario} | ${r.expected} | ${r.actual} | ${r.pass ? 'Pass' : 'Fail'} |`),
  '',
  `${passed} of ${results.length} passed.`
].join('\n');
writeFileSync('evidence/security-salma.md', `${md}\n`);
console.log('Results saved to evidence/security-salma.md');
process.exit(passed === results.length ? 0 : 1);
