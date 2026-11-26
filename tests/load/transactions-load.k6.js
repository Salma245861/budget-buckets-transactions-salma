// Load test for the Transactions service on Floci (enhancement 4c, Salma). Tool: Grafana k6 (as in Lab 8).
//
// What it does: one test user, then virtual users (VUs) ramp up and back down (see PROFILES), each one
// looping through a realistic mix: 70% list my transactions, 20% log an expense, 10% check a USD rate.
// What it measures: response time (p95), failure rate, requests per second, and how many requests the
// API Gateway traffic limit answered with 429 (too many requests).
//
// Run (Floci must be running and the app deployed):
//   k6 run --summary-export evidence/load-normal-summary.json tests/load/transactions-load.k6.js
//   PROFILE=stress k6 run --summary-export evidence/load-stress-summary.json tests/load/transactions-load.k6.js
// Optional: API=http://<api-id>.execute-api.localhost.floci.io:4566 k6 run ...
// IMPORTANT: k6 writes the setup data (the test user's login token) into the summary file.
// Remove it before committing (no tokens in the repo, test ST-14):
//   node -e "const fs=require('fs');const f=process.argv[1];const d=JSON.parse(fs.readFileSync(f));delete d.setup_data;fs.writeFileSync(f,JSON.stringify(d,null,2))" evidence/load-normal-summary.json
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const API = __ENV.API || 'http://5b5e788b2e.execute-api.localhost.floci.io:4566';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

const throttled = new Counter('throttled_429');
const serverErrors = new Counter('server_errors_5xx');
const listTime = new Trend('time_list_ms', true);
const createTime = new Trend('time_create_ms', true);
const fxTime = new Trend('time_fx_rate_ms', true);

// Two profiles:
//   PROFILE=stress  1 -> 10 -> 30 users quickly: finds the breaking point (cold starts pile up on a laptop)
//   PROFILE=normal  (default) a gentle warm-up, then 5 and 10 users: behaviour at a sensible load
const PROFILES = {
  stress: [
    { duration: '20s', target: 10 },
    { duration: '40s', target: 30 },
    { duration: '30s', target: 30 },
    { duration: '20s', target: 0 }
  ],
  normal: [
    { duration: '30s', target: 2 },  // warm-up: lets Floci start the Lambda copies
    { duration: '30s', target: 5 },
    { duration: '60s', target: 10 },
    { duration: '20s', target: 0 }
  ]
};
const PROFILE = __ENV.PROFILE || 'normal';

export const options = {
  stages: PROFILES[PROFILE],
  thresholds: {
    http_req_failed: ['rate<0.05'],     // fewer than 5% failures
    http_req_duration: ['p(95)<1500']   // 95% of answers within 1.5 s (laptop + Docker)
  }
};

// Runs once: a test user with one big bucket, so the budget never blocks the test
export function setup() {
  const email = `load${Date.now()}@example.com`;
  const password = 'LoadTest2026x';
  http.post(`${API}/api/auth/register`, JSON.stringify({ name: 'Load Tester', email, password }), { headers: JSON_HEADERS });
  const login = http.post(`${API}/api/auth/login`, JSON.stringify({ email, password }), { headers: JSON_HEADERS });
  const token = login.json('token');
  if (!token) throw new Error(`login failed: ${login.status} ${login.body}`);
  const auth = { ...JSON_HEADERS, Authorization: `Bearer ${token}` };
  const bucket = http.post(`${API}/api/buckets`, JSON.stringify({ name: 'Load test', monthlyLimit: 10000000 }), { headers: auth });
  const bucketId = bucket.json('id') || bucket.json('bucket.id');
  if (!bucketId) throw new Error(`bucket failed: ${bucket.status} ${bucket.body}`);
  return { auth, bucketId };
}

function record(res) {
  if (res.status === 429) throttled.add(1);
  if (res.status >= 500) serverErrors.add(1);
}

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export default function (data) {
  const pick = Math.random();
  if (pick < 0.7) {
    const res = http.get(`${API}/api/transactions`, { headers: data.auth, tags: { name: 'list' } });
    record(res); listTime.add(res.timings.duration);
    check(res, { 'list: 200': (r) => r.status === 200 });
  } else if (pick < 0.9) {
    const body = {
      type: 'expense', amount: 10 + Math.round(Math.random() * 9000) / 100, date: new Date().toISOString().slice(0, 10),
      bucketId: data.bucketId, paymentMethod: 'card', note: 'load test', clientRequestId: uuid()
    };
    const res = http.post(`${API}/api/transactions`, JSON.stringify(body), { headers: data.auth, tags: { name: 'create' } });
    record(res); createTime.add(res.timings.duration);
    check(res, { 'create: 201': (r) => r.status === 201 });
  } else {
    const res = http.get(`${API}/api/transactions/fx-rate?from=USD`, { headers: data.auth, tags: { name: 'fx-rate' } });
    record(res); fxTime.add(res.timings.duration);
    check(res, { 'fx-rate: 200': (r) => r.status === 200 });
  }
  sleep(0.5 + Math.random()); // a real user pauses between clicks
}
