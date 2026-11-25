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
