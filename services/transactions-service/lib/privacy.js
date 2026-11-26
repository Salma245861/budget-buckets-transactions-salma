// Privacy rights for the Transactions service (enhancement 5f, Salma).
// Egypt's Personal Data Protection Law (151/2020) gives users the right to get a copy of their data
// and to have it erased. This file holds the pure logic, so it can be unit-tested without AWS:
//   exportView      -> what a user receives in "Download my data" (no internal storage fields)
//   receiptKeysToDelete -> every receipt file in S3 that "Delete my data" must remove
const INTERNAL_FIELDS = ['pk', 'sk', 'receiptKey', 'receiptPendingType'];

function exportView(items) {
  return [...items]
    .sort((a, b) => (a.date === b.date ? String(a.createdAt).localeCompare(String(b.createdAt)) : a.date.localeCompare(b.date)))
    .map((t) => {
      const copy = { ...t, hasReceipt: Boolean(t.receiptKey) };
      for (const f of INTERNAL_FIELDS) delete copy[f];
      return copy;
    });
}

// Checked receipts, plus uploads still waiting for their check
function receiptKeysToDelete(items, userId, receipts) {
  const keys = [];
  for (const t of items) {
    if (t.receiptKey) keys.push(t.receiptKey);
    if (t.receiptPendingType) keys.push(receipts.pendingKeyFor(userId, t.id));
  }
  return keys;
}

module.exports = { exportView, receiptKeysToDelete, INTERNAL_FIELDS };
