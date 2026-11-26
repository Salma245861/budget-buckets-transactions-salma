// Double-submit protection for logging a transaction (enhancement C, Salma).
//
// Problem: a double click, or a network retry, sends the same "log expense" request twice and the
// expense is counted twice in the budget.
// Fix (idempotency): the page sends a random clientRequestId with each new form. The transaction id is
// derived from (user, clientRequestId), so the same request always maps to the same DynamoDB item.
// The second copy finds the first one and gets it back instead of creating a duplicate.
const crypto = require('crypto');

const CLIENT_ID = /^[A-Za-z0-9-]{8,64}$/;

// <YYYYMMDD>-<12 hex>: the date first keeps the sort key ordered by date (as before)
function transactionId(date, userId, clientRequestId) {
  const day = date.replace(/-/g, '');
  const tail = clientRequestId
    ? crypto.createHash('sha256').update(`${userId}|${clientRequestId}`).digest('hex').slice(0, 12)
    : crypto.randomBytes(6).toString('hex');
  return `${day}-${tail}`;
}

module.exports = { transactionId, CLIENT_ID };
