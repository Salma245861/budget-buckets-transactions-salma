-- Neon Postgres schema for the Transactions audit trail (enhancement 1b, Salma).
-- Run once in the Neon SQL Editor as the project owner (project personal-budget-buckets, region
-- AWS Europe Central 1, Frankfurt, database neondb).

-- 1. The audit table: who, what, when, which transaction. No amounts and no notes.
CREATE TABLE transaction_audit (
  id             BIGSERIAL PRIMARY KEY,
  event_time     TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id        TEXT NOT NULL,
  action         TEXT NOT NULL CHECK (action IN ('CREATE', 'UPDATE', 'DELETE', 'RECEIPT_ATTACH', 'DELETE_ALL')),
  transaction_id TEXT,
  txn_type       TEXT CHECK (txn_type IN ('income', 'expense')),
  bucket_id      TEXT,
  currency       CHAR(3)
);

CREATE INDEX transaction_audit_time ON transaction_audit (event_time);
CREATE INDEX transaction_audit_user ON transaction_audit (user_id, event_time);

-- 2. Least-privilege login for the Lambda. Created with SQL on purpose: roles made in the Neon
--    console become members of neon_superuser. The password is generated with
--    "openssl rand -hex 24", pasted here, and the query is then deleted from the editor's History.
--    It is never written to a file. To rotate it: ALTER ROLE pb_transactions_app WITH PASSWORD '...';
--    then update the secret pb/neon-url (see setup-neon.sh).
CREATE ROLE pb_transactions_app WITH LOGIN PASSWORD 'PASTE_PASSWORD_HERE';

GRANT CONNECT ON DATABASE neondb TO pb_transactions_app;
GRANT USAGE ON SCHEMA public TO pb_transactions_app;
-- No UPDATE: audit rows cannot be rewritten. DELETE is only used for "delete my data" (PDPL).
GRANT SELECT, INSERT, DELETE ON transaction_audit TO pb_transactions_app;
GRANT USAGE ON SEQUENCE transaction_audit_id_seq TO pb_transactions_app;
