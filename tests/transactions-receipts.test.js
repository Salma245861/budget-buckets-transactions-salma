// Unit tests for safe receipt uploads (enhancement 5e) in the Transactions service
// (services/transactions-service/lib/receipts.js). Owner: Salma. Test IDs: TX-08 ... TX-11.
// No AWS or internet needed: the upload form is only built and read, never sent.
// Run: node --test tests/transactions-receipts.test.js
const test = require('node:test');
const assert = require('node:assert/strict');

// Dummy settings so the S3 library can build a form (Floci-style test keys, not secrets).
// AWS_PROFILE is removed so the library does not warn about two kinds of credentials.
delete process.env.AWS_PROFILE;
process.env.RECEIPTS_BUCKET = 'pb-receipts-test';
process.env.S3_PUBLIC_ENDPOINT = 'http://localhost:4566';
process.env.AWS_REGION = 'us-east-1';
process.env.AWS_ACCESS_KEY_ID = 'test';
process.env.AWS_SECRET_ACCESS_KEY = 'test';

const receipts = require('../services/transactions-service/lib/receipts');

const JPEG = [0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46];
const PNG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
const PDF = [...Buffer.from('%PDF-1.7')];
const EXE = [...Buffer.from('MZ')].concat([0x90, 0x00, 0x03, 0x00, 0x00, 0x00]); // a Windows program
const HTML = [...Buffer.from('<script>')];

test('TX-08 real JPEG, PNG and PDF files are recognised from their first bytes', () => {
  assert.equal(receipts.sniffType(JPEG), 'image/jpeg');
  assert.equal(receipts.sniffType(PNG), 'image/png');
  assert.equal(receipts.sniffType(PDF), 'application/pdf');
});

test('TX-09 a program or web page renamed to .jpg is NOT recognised as a receipt', () => {
  assert.equal(receipts.sniffType(EXE), null);
  assert.equal(receipts.sniffType(HTML), null);
  assert.equal(receipts.sniffType([]), null);
  assert.equal(receipts.sniffType(undefined), null);
});

test('TX-10 the upload form tells S3 to refuse files over 5 MB or of another type', async () => {
  const form = await receipts.uploadForm('receipts/u1/t1', 'image/png');
  const policy = JSON.parse(Buffer.from(form.fields.Policy, 'base64').toString());
  assert.deepEqual(
    policy.conditions.find((c) => Array.isArray(c) && c[0] === 'content-length-range'),
    ['content-length-range', 1, 5 * 1024 * 1024]);
  assert.deepEqual(
    policy.conditions.find((c) => Array.isArray(c) && c[1] === '$Content-Type'),
    ['eq', '$Content-Type', 'image/png']);
  assert.equal(form.fields.key, 'receipts/u1/t1');
});

test('TX-11 each user\'s receipts live under their own folder in S3', () => {
  assert.equal(receipts.keyFor('user-a', 'txn-1'), 'receipts/user-a/txn-1');
  assert.notEqual(receipts.keyFor('user-a', 'txn-1'), receipts.keyFor('user-b', 'txn-1'));
});
