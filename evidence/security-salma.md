# Security tests: Transactions service (Salma), run on Floci

Run: 2026-11-27T18:34:17.709Z against http://5b5e788b2e.execute-api.localhost.floci.io:4566. Script: tests/security/transactions-security.mjs

| Test ID | Category | Scenario | Expected | Actual | Pass/Fail |
|---|---|---|---|---|---|
| ST-01 | Unauthenticated access | No token: list, create, read one, export my data | 401, 401, 401, 401 | 401, 401, 401, 401 | Pass |
| ST-02 | Authentication | Changed signature; role changed to admin; alg "none"; garbage token | 401, 401, 401, 401 | 401, 401, 401, 401 | Pass |
| ST-06 | Ownership (IDOR) | User B reads, edits, deletes and opens the receipt of A's transaction | 404, 404, 404, 404; A's transaction unchanged | 404, 404, 404, 404; A's transaction afterwards: 200, unchanged | Pass |
| ST-11 | Invalid input | 50 KB JSON body; text/plain body | 413; 415 | 413; 415 | Pass |
| ST-16 | Invalid input (upload) | Text file sent as a PNG receipt | confirm 422 RECEIPT_TYPE_MISMATCH (file deleted) | confirm 422 RECEIPT_TYPE_MISMATCH | Pass |
| ST-17 | Invalid input (upload) | 6 MB receipt | storage 400 (refused by S3 before it is saved) | storage 400 | Pass |
| ST-14 | Secret exposure review | Tracked .env files; .gitignore; keys and tokens in the whole Git history; tokens or passwords in CloudWatch logs | nothing found | nothing found (28 commits, 38 log lines) | Pass |

7 of 7 passed.
