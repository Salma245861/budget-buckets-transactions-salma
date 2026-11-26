# Personal Budget Buckets: Transactions service (Salma Amir)

Individual work repository for the Cloud Computing & Cloud Security coursework (26CSCN29H, BUE), Group 4.

- **Team repository (full app):** https://github.com/SagedEhab/personal-budget-buckets
- **My branch in the team repository:** `salma`
- **My component:** the Transactions service, plus the external currency API

## What my service does

Users log income and expenses (amount, bucket, payment method, date). Amounts in a foreign currency are converted to EGP with an external API (open.er-api.com). Before an expense is saved, my service asks the Buckets service whether it fits the bucket's budget.

| # | Function | Endpoint |
|---|---|---|
| 1 | Log an income or expense | `POST /api/transactions` |
| 2 | Find transactions with filters (date, type, bucket, payment method, text) | `GET /api/transactions` |
| 3 | Edit a transaction (re-checks the budget) | `PATCH /api/transactions/:id` |
| 4 | Delete a transaction (and its receipt) | `DELETE /api/transactions/:id` |
| 5 | Upload and download receipts with short-lived private S3 links | `POST`/`GET /api/transactions/:id/receipt` |
| 6 | Preview an exchange rate (external API) | `GET /api/transactions/fx-rate` |

**AWS services used (on Floci):** Lambda, DynamoDB (`PBTransactions`), S3 (private receipts bucket), Secrets Manager, CloudWatch Logs, IAM.

## Where this code came from

The first commit in this repository is my service as it stood in the team's **AI-assisted draft**, which Saged committed to the team repository on 22 Nov 2026 (declared in the report, Appendix A).
**Every later commit here is my own work** on this service: fixes, tests, security features and evidence. The same changes are made on my `salma` branch in the team repository.

## My work log

| Date | What I did | Commit |
|---|---|---|
| 24 Nov 2026 | Set up Docker, Floci and the AWS CLI, deployed the whole app on Floci (8/8 steps), smoke test 11/11 passed | |
| 24 Nov 2026 | Found and fixed a bug: the deploy script's Floci health check failed on Windows Git Bash | `salma` branch, team repo |
| 26 Nov 2026 | Added my service and the page layout to my `salma` branch, and opened [pull request #1](https://github.com/SagedEhab/personal-budget-buckets/pull/1) | `e6596bf` (team repo) |
| 26 Nov 2026 | Re-applied the Windows health-check fix after the team repo was reorganised | `c60bba2` (team repo) |
| 26 Nov 2026 | Wrote 7 unit tests for the currency converter (`tests/transactions-fx.test.js`): same currency, USD to EGP, rounding, caching, unsupported currency, API down, bad API answer. 7/7 pass | `646efb8` (team repo) |
| 26 Nov 2026 | **Enhancement 5e, safe receipt uploads (backend):** pre-signed POST form so S3 itself refuses files over 5 MB or of another type; after upload the service reads the file's first bytes and deletes anything that is not a real JPEG, PNG or PDF (422 `RECEIPT_TYPE_MISMATCH`, logged as `RECEIPT_REJECTED`). Tests TX-08 to TX-11 | `2b75fb1`, `70ed47d` (team repo) |
| 26 Nov 2026 | **Enhancement 5e (page):** Receipt column with Attach, Replace and View on the Transactions page | `6ee2bfc` (team repo) |
| 26 Nov 2026 | Deployed my updated Lambda and page to Floci and tested: real PNG attached and viewable; fake PNG (a text file) refused and deleted; 6 MB file refused by S3 (400); `text/html` refused (400) | Screenshots in `evidence/` |
| 26 Nov 2026 | Found and fixed a problem in my own feature: replacing a good receipt with a rejected file also lost the old receipt. New uploads now go to a waiting spot (`<key>.pending`) and only replace the old receipt after passing the check. Test TX-12; re-tested on Floci (old receipt still opens after a rejected replacement). 12/12 tests pass | `14d6192` (team repo) |
| 26 Nov 2026 | **Enhancement 5f, privacy rights (Egypt PDPL 151/2020):** `GET /api/transactions/me/export` returns all of a user's transactions without internal storage fields; `DELETE /api/transactions/me` with `{"confirm": true}` erases all their transactions and receipt files. Tests TX-13 to TX-15 (15/15 pass). Tested on Floci: export 200 with no internal fields, another user sees 0, no login 401, delete without confirm 400, delete with confirm removed 2 transactions and 1 receipt | `f57e4df` (team repo) |
| 26 Nov 2026 | **Enhancement A, customer-managed KMS key** (`services/transactions-service/infra/setup-kms.sh`): my own key `alias/pb-transactions` with yearly rotation encrypts the PBTransactions table and the receipts bucket; only the Transactions Lambda role may use it. Found that Floci stores the bucket's default key but does not apply it, so my code now asks for the key explicitly on every receipt upload and copy (works on Floci and real AWS). Test TX-16 (16/16 pass); re-tested receipts on Floci, new files show `aws:kms` with my key | `b72ae97` (team repo), `evidence/A-kms-proof.png` |
| 26 Nov 2026 | **Enhancement C, double-submit protection (idempotency):** the page sends a per-form ticket (`clientRequestId`); the transaction id is derived from user + ticket, and the item is written with a "save only if new" condition, so a double click or network retry saves the expense once and the copy gets `200 duplicate`. Save button disabled while saving; unsafe tickets refused (400). Tests TX-17 to TX-19 (19/19 pass). Floci: two copies at once gave 201 + 200 duplicate and 1 saved transaction, 3 runs out of 3. Observed one 500 when two cold Lambda copies started at once right after a code update (Floci cold start, not the code) | `a6bdc3e` (team repo) |
| 26 Nov 2026 | **Enhancement 4c, load test with k6** (`tests/load/transactions-load.k6.js`, mix: 70% list, 20% create, 10% FX rate). **Normal** (2 to 5 to 10 users, 2 min 20 s): 507 requests, 3.3 req/s, 0.78% failed, p95 431 ms (target 1,500 ms, passed), median 73 ms; list p95 117 ms; create median 327 ms but p95 12.6 s. **Stress** (fast ramp to 30 users): 124 requests, 34% failed, 60 s timeouts; Floci started 12 Lambda containers. Conclusion: the slow and failed requests are Lambda cold starts on a laptop (a create wakes 3 services); on AWS, provisioned concurrency would remove them. Found and removed a login token that k6 writes into the summary file before committing | `evidence/4c-load-*.png`, `evidence/load-*-summary.json` |
| 26 Nov 2026 | **Enhancement B, shared exchange-rate cache** (instead of Redis, which our Floci does not provide): rates are cached in two levels, the Lambda copy's memory and one shared DynamoDB row per currency (`FXCACHE#shared / RATES#<currency>`, 1 hour), so new Lambda copies reuse the rate instead of calling the external API. If the shared cache fails, conversion still works through the API. DynamoDB TTL deletes old rows (`setup-fx-cache.sh`). Tests TX-20 to TX-22 (22/22 pass). Floci: 1 request then 6 at once gave 1 API call and 5 shared-cache hits; 6 at once on an empty cache gave 5 API calls (cache stampede, noted as a limitation) | `daa501e` (team repo), `evidence/B-shared-fx-cache-proof.png` |
